import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issues,
  type Db,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { deliverConversationComments } from "./agent-conversations.js";
import { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";

const VECTOR_INGRESS_ACTOR_ID = "vector-ingress";
const ACTIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;

export interface VectorIngressScope {
  companyId: string;
  agentId: string;
  externalSessionId: string;
}

export interface VectorIngressTurnInput extends VectorIngressScope {
  clientRequestId: string;
  body: string;
  attachmentIds?: string[];
}

export interface VectorIngressCancelInput extends VectorIngressScope {
  runId?: string;
}

export interface VectorIngressEventsInput extends VectorIngressScope {
  afterSeq?: number;
  limit?: number;
}

export interface VectorIngressHeartbeat {
  wakeup: ReturnType<typeof heartbeatService>["wakeup"];
  cancelRun: ReturnType<typeof heartbeatService>["cancelRun"];
}

const VECTOR_PRESENTATION_EVENT_TYPES = [
  "assistant_delta",
  "tool_call",
  "tool_update",
  "tool_result",
  "assistant_final",
  "usage",
  "error",
  "agent_settled",
] as const;

function eventPayloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function projectVectorEventPayload(eventType: string, payload: unknown) {
  const source = eventPayloadRecord(payload);
  const pick = (...keys: string[]) =>
    Object.fromEntries(
      keys
        .filter((key) => key in source)
        .map((key) => [key, source[key]]),
    );
  switch (eventType) {
    case "assistant_delta":
      return pick("text", "delta");
    case "tool_call":
      return pick("toolCallId", "toolName", "args");
    case "tool_update":
      return pick("toolCallId", "toolName", "args", "partialResult");
    case "tool_result":
      return pick("toolCallId", "toolName", "result", "isError");
    case "assistant_final":
      return pick("text", "stopReason");
    case "usage":
      return pick("inputTokens", "outputTokens", "cachedInputTokens", "costUsd");
    case "error":
      return pick("source", "command", "requestId");
    case "agent_settled":
      return pick("settled");
    default:
      return {};
  }
}

export interface VectorIngressTurnResult {
  companyId: string;
  agentId: string;
  issueId: string;
  issueIdentifier: string | null;
  commentId: string;
  runId: string | null;
  wakeupRequestId: string | null;
  wakeupStatus: string | null;
  sessionGeneration: number;
  replayed: boolean;
}

/**
 * Paperclip conversation ownership is text-valued. Store only a stable digest
 * of Vector's opaque session identifier so the external identifier never
 * appears in Paperclip issues, comments, activity, or logs.
 */
export function vectorConversationOwnerId(input: VectorIngressScope): string {
  const digest = createHash("sha256")
    .update("paperclip-vector-ingress/v1\0")
    .update(input.companyId)
    .update("\0")
    .update(input.agentId)
    .update("\0")
    .update(input.externalSessionId)
    .digest("base64url");
  return `vector:${digest}`;
}

function sorted(values: readonly string[]) {
  return [...values].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function vectorIngressService(
  db: Db,
  options: {
    heartbeat?: VectorIngressHeartbeat;
    responsibleUserId?: string;
  } = {},
) {
  const issuesSvc = issueService(db);
  const heartbeat = options.heartbeat ?? heartbeatService(db);
  const responsibleUserId = options.responsibleUserId?.trim() || "local-board";

  async function assertTargetAgent(scope: VectorIngressScope) {
    const agent = await db
      .select({ id: agents.id, name: agents.name, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Vector conversation target not found");
    if (agent.status === "terminated" || agent.status === "pending_approval") {
      throw conflict("Vector conversation target is not available", {
        code: "vector_ingress_agent_unavailable",
      });
    }
    return agent;
  }

  async function getConversation(scope: VectorIngressScope) {
    const ownerId = vectorConversationOwnerId(scope);
    const issue = await issuesSvc.getConversation(
      scope.companyId,
      scope.agentId,
      ownerId,
    );
    return { issue, ownerId };
  }

  async function requireConversation(scope: VectorIngressScope) {
    await assertTargetAgent(scope);
    const resolved = await getConversation(scope);
    if (!resolved.issue) throw notFound("Vector conversation not found");
    return { issue: resolved.issue, ownerId: resolved.ownerId };
  }

  async function resolveConversation(scope: VectorIngressScope) {
    const agent = await assertTargetAgent(scope);
    const existing = await getConversation(scope);
    if (existing.issue) {
      return { issue: existing.issue, ownerId: existing.ownerId, created: false };
    }

    const issue = await issuesSvc.create(scope.companyId, {
      title: `Vector conversation with ${agent.name}`,
      assigneeAgentId: scope.agentId,
      conversationAgentId: scope.agentId,
      conversationUserId: existing.ownerId,
      conversationState: "waiting",
      status: "in_review",
      createdByUserId: responsibleUserId,
      responsibleUserId,
      trustExplicitResponsibleUserId: true,
      originKind: "vector_ingress",
      originFingerprint: "vector-ingress/v1",
    });
    await logActivity(db, {
      companyId: scope.companyId,
      actorType: "system",
      actorId: VECTOR_INGRESS_ACTOR_ID,
      action: "issue.conversation_opened",
      entityType: "issue",
      entityId: issue.id,
      issueId: issue.id,
      details: { agentId: scope.agentId, source: "vector_ingress" },
    });
    return { issue, ownerId: existing.ownerId, created: true };
  }

  async function latestConversationRun(
    scope: VectorIngressScope,
    issue: Awaited<ReturnType<typeof requireConversation>>["issue"],
  ) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, scope.companyId),
          eq(heartbeatRuns.agentId, scope.agentId),
          or(
            eq(heartbeatRuns.nativeIssueId, issue.id),
            sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
          ),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function status(input: VectorIngressScope) {
    const { issue } = await requireConversation(input);
    const run = await latestConversationRun(input, issue);
    return {
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      sessionGeneration: issue.conversationSessionGeneration,
      run: run
        ? {
            id: run.id,
            status: run.status,
            error: run.error,
            errorCode: run.errorCode,
            usage: run.usageJson,
            createdAt: run.createdAt,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          }
        : null,
    };
  }

  async function events(input: VectorIngressEventsInput) {
    const snapshot = await status(input);
    const afterSeq = input.afterSeq ?? 0;
    const runEvents = snapshot.run
      ? await db
          .select({
            seq: heartbeatRunEvents.seq,
            eventType: heartbeatRunEvents.eventType,
            stream: heartbeatRunEvents.stream,
            level: heartbeatRunEvents.level,
            color: heartbeatRunEvents.color,
            message: heartbeatRunEvents.message,
            payload: heartbeatRunEvents.payload,
            createdAt: heartbeatRunEvents.createdAt,
          })
          .from(heartbeatRunEvents)
          .where(
            and(
              eq(heartbeatRunEvents.companyId, input.companyId),
              eq(heartbeatRunEvents.agentId, input.agentId),
              eq(heartbeatRunEvents.runId, snapshot.run.id),
              gt(heartbeatRunEvents.seq, afterSeq),
              inArray(heartbeatRunEvents.eventType, [
                ...VECTOR_PRESENTATION_EVENT_TYPES,
              ]),
            ),
          )
          .orderBy(asc(heartbeatRunEvents.seq))
          .limit(Math.max(1, Math.min(input.limit ?? 200, 1000)))
      : [];
    return {
      ...snapshot,
      afterSeq,
      nextSeq: runEvents.at(-1)?.seq ?? afterSeq,
      events: runEvents.map((event) => ({
        seq: event.seq,
        eventType: event.eventType,
        stream: event.stream,
        level: event.level,
        color: event.color,
        message: event.message,
        payload: projectVectorEventPayload(event.eventType, event.payload),
        createdAt: event.createdAt,
      })),
    };
  }

  async function addTurn(input: VectorIngressTurnInput) {
    const { issue, ownerId } = await resolveConversation(input);
    const requestedAttachmentIds = [...new Set(input.attachmentIds ?? [])];
    let replayed = false;

    const comment = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.id, issue.id),
            eq(issues.companyId, input.companyId),
            eq(issues.conversationAgentId, input.agentId),
            eq(issues.conversationUserId, ownerId),
          ),
        )
        .for("update");
      if (!locked) throw notFound("Vector conversation not found");

      const existing = await tx
        .select()
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, issue.id),
            eq(issueComments.authorUserId, responsibleUserId),
            eq(issueComments.clientRequestId, input.clientRequestId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existing) {
        const existingAttachmentIds = await tx
          .select({ id: issueAttachments.id })
          .from(issueAttachments)
          .where(
            and(
              eq(issueAttachments.companyId, input.companyId),
              eq(issueAttachments.issueId, issue.id),
              eq(issueAttachments.issueCommentId, existing.id),
            ),
          )
          .then((rows) => rows.map((row) => row.id));
        if (
          existing.body !== input.body ||
          !sameStrings(existingAttachmentIds, requestedAttachmentIds)
        ) {
          throw conflict(
            "Vector clientRequestId was already used for a different turn",
            { code: "vector_ingress_idempotency_conflict" },
          );
        }
        replayed = true;
        return existing;
      }

      return issuesSvc.addComment(
        issue.id,
        input.body,
        { userId: responsibleUserId },
        {
          clientRequestId: input.clientRequestId,
          authorType: "user",
          attachmentIds: requestedAttachmentIds,
        },
        tx,
      );
    });

    if (!replayed) {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: VECTOR_INGRESS_ACTOR_ID,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        issueId: issue.id,
        details: {
          commentId: comment.id,
          identifier: issue.identifier,
          source: "vector_ingress",
        },
      });
    }

    let deliveredRunId: string | null = null;
    await deliverConversationComments(db, issue, async (agentId, wakeup) => {
      const run = await heartbeat.wakeup(agentId, wakeup);
      if (
        wakeup.idempotencyKey === `conversation-comment:${comment.id}` &&
        run &&
        typeof run === "object" &&
        "id" in run &&
        typeof run.id === "string"
      ) {
        deliveredRunId = run.id;
      }
      return run;
    });

    const receipt = await db
      .select({
        id: agentWakeupRequests.id,
        runId: agentWakeupRequests.runId,
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, input.companyId),
          eq(agentWakeupRequests.agentId, input.agentId),
          eq(
            agentWakeupRequests.idempotencyKey,
            `conversation-comment:${comment.id}`,
          ),
        ),
      )
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const current = await db
      .select({ generation: issues.conversationSessionGeneration })
      .from(issues)
      .where(
        and(eq(issues.id, issue.id), eq(issues.companyId, input.companyId)),
      )
      .then((rows) => rows[0] ?? null);

    return {
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      commentId: comment.id,
      runId: deliveredRunId ?? receipt?.runId ?? null,
      wakeupRequestId: receipt?.id ?? null,
      wakeupStatus: receipt?.status ?? null,
      sessionGeneration: current?.generation ?? issue.conversationSessionGeneration,
      replayed,
    } satisfies VectorIngressTurnResult;
  }

  async function cancel(input: VectorIngressCancelInput) {
    const { issue } = await requireConversation(input);
    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
          inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
          or(
            eq(heartbeatRuns.nativeIssueId, issue.id),
            sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
          ),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));
    const selected = input.runId
      ? activeRuns.find((run) => run.id === input.runId) ?? null
      : activeRuns.find((run) => run.id === issue.executionRunId) ??
        activeRuns[0] ??
        null;
    if (input.runId && !selected) {
      throw conflict("Run does not belong to this active Vector conversation", {
        code: "vector_ingress_run_scope_mismatch",
      });
    }
    if (!selected) {
      return {
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: issue.id,
        runId: null,
        cancelled: false,
        status: null,
      };
    }

    const cancelled = await heartbeat.cancelRun(
      selected.id,
      "Cancelled by Vector OS",
      {
        errorCode: "operator_interrupted",
        resultJson: {
          cancellationKind: "operator_interrupted",
          source: "vector_ingress",
          issueId: issue.id,
        },
      },
    );
    if (cancelled) {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: VECTOR_INGRESS_ACTOR_ID,
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: selected.id,
        issueId: issue.id,
        details: {
          agentId: input.agentId,
          issueId: issue.id,
          source: "vector_ingress",
          cancellationKind: "operator_interrupted",
        },
      });
    }
    return {
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: issue.id,
      runId: selected.id,
      cancelled: cancelled?.status === "cancelled",
      status: cancelled?.status ?? selected.status,
    };
  }

  return {
    addTurn,
    reset: (input: Omit<VectorIngressTurnInput, "body">) =>
      addTurn({ ...input, body: "/new" }),
    cancel,
    status,
    events,
  };
}

export type VectorIngressService = ReturnType<typeof vectorIngressService>;
