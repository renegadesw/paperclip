import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issues,
  vectorIngressConversations,
  vectorIngressTurns,
  type Db,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { deliverConversationComments } from "./agent-conversations.js";
import { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";
import type { VectorToolPendingDescriptor } from "./vector-tool-authority.js";
import type { VectorProviderPendingDescriptor } from "./vector-provider-authority.js";

const VECTOR_INGRESS_ACTOR_ID = "vector-ingress";
const ACTIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;

export interface VectorIngressScope {
  companyId: string;
  agentId: string;
  externalSessionId: string;
  ownerId?: string;
  installationId?: string;
  profileId?: string;
}

export interface VectorIngressOwnerScope {
  companyId: string;
  agentId: string;
  ownerId: string;
  installationId: string;
  profileId: string;
}

export interface VectorIngressTurnInput extends VectorIngressScope {
  clientRequestId: string;
  body: string;
  attachmentIds?: string[];
  authorityHandle?: string;
  authorityTools?: string[];
  providerAuthorityHandle?: string;
  launchContext?: VectorWorkloadLaunchContext;
  roleContext?: VectorRoleTurnContext;
  personaContext?: VectorPersonaTurnContext;
}

export interface VectorWorkloadLaunchContext {
  schemaVersion: 1;
  workloadKey: string;
  queue: "research" | "tasks";
  taskId: string;
  attempt: number;
  leaseTokenSha256: string;
  role: string;
  model: string;
  tools: string[];
  noBuiltinTools: boolean;
  systemPrompt: string;
  metadata: Record<string, string>;
}

export interface VectorRoleTurnContext {
  schemaVersion: 1;
  role: string;
  model: string;
  noBuiltinTools: true;
  systemPrompt: string;
  metadata: Record<string, string>;
}

export interface VectorPersonaTurnContext {
  schemaVersion: 1;
  personaId: string;
  personaName: string;
  personaVersion: string;
  model: string;
  noBuiltinTools: true;
  systemPrompt: string;
}

export interface VectorIngressCancelInput extends VectorIngressScope {
  runId?: string;
}

export interface VectorIngressEventsInput extends VectorIngressScope {
  afterSeq?: number;
  limit?: number;
}

export interface VectorIngressCursorPosition {
  at: string;
  rank: 0 | 1 | 2;
  id: string;
}

export interface VectorIngressInventoryInput extends VectorIngressOwnerScope {
  after?: VectorIngressCursorPosition;
  limit?: number;
}

export interface VectorIngressTranscriptInput extends VectorIngressOwnerScope {
  externalSessionId: string;
  after?: VectorIngressCursorPosition;
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

const VECTOR_TRANSCRIPT_EVENT_TYPES = [
  "assistant_delta",
  "tool_call",
  "tool_result",
  "usage",
  "error",
] as const;

const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
] as const;

function eventPayloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

const VECTOR_TOOL_VALUE_BUDGET = 32 * 1024;
const VECTOR_TOOL_MAX_DEPTH = 8;
const VECTOR_TOOL_MAX_ENTRIES = 50;
const VECTOR_TOOL_MAX_STRING = 4 * 1024;
const sensitiveToolKey = /(?:^|[_-])(?:api[_-]?key|token|password|secret|credential|authorization|cookie|private[_-]?key|database[_-]?url)(?:$|[_-])/i;
const sensitiveToolValue = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:postgres(?:ql)?|https?):\/\/[^/\s:@]+:[^@\s/]+@)/gi;

function sanitizeVectorToolValue(value: unknown): unknown {
  const budget = { remaining: VECTOR_TOOL_VALUE_BUDGET };
  const visit = (current: unknown, depth: number): unknown => {
    if (budget.remaining <= 0 || depth > VECTOR_TOOL_MAX_DEPTH) return "[truncated]";
    if (typeof current === "string") {
      const redacted = current.replace(sensitiveToolValue, "[redacted]");
      const bounded = redacted.slice(0, Math.min(VECTOR_TOOL_MAX_STRING, budget.remaining));
      budget.remaining -= bounded.length;
      return bounded.length < redacted.length ? `${bounded}[truncated]` : bounded;
    }
    if (current === null || typeof current === "number" || typeof current === "boolean") {
      budget.remaining -= 16;
      return current;
    }
    if (Array.isArray(current)) {
      return current.slice(0, VECTOR_TOOL_MAX_ENTRIES).map((entry) => visit(entry, depth + 1));
    }
    if (!current || typeof current !== "object") return null;
    const entries = Object.entries(current as Record<string, unknown>)
      .slice(0, VECTOR_TOOL_MAX_ENTRIES);
    return Object.fromEntries(entries.map(([key, entry]) => {
      budget.remaining -= key.length;
      const normalizedKey = key
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/-/g, "_");
      return [key, sensitiveToolKey.test(normalizedKey) ? "[redacted]" : visit(entry, depth + 1)];
    }));
  };
  return visit(value, 0);
}

export function projectVectorEventPayload(eventType: string, payload: unknown) {
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
      return {
        ...pick("toolCallId", "toolName"),
        ...(source.args === undefined ? {} : { args: sanitizeVectorToolValue(source.args) }),
      };
    case "tool_update":
      return {
        ...pick("toolCallId", "toolName"),
        ...(source.args === undefined ? {} : { args: sanitizeVectorToolValue(source.args) }),
        ...(source.partialResult === undefined ? {} : {
          partialResult: sanitizeVectorToolValue(source.partialResult),
        }),
      };
    case "tool_result":
      return {
        ...pick("toolCallId", "toolName", "isError"),
        ...(source.result === undefined ? {} : { result: sanitizeVectorToolValue(source.result) }),
      };
    case "assistant_final":
      return pick("text", "stopReason");
    case "usage":
      return pick("inputTokens", "outputTokens", "cachedInputTokens", "costUsd");
    case "error":
      return pick("source", "requestId");
    case "agent_settled":
      return pick("settled");
    default:
      return {};
  }
}

function projectVectorTranscriptMessage(
  eventType: string,
  _message: string | null,
): string | null {
  return eventType === "error" ? "Agent run failed" : null;
}

export interface VectorIngressToolAuthority {
  registerPending(input: VectorIngressScope & {
    issueId: string;
    commentId: string;
    authorityHandle: string;
    allowedTools: readonly string[];
  }): VectorToolPendingDescriptor;
  bindRun(input: VectorIngressScope & {
    issueId: string;
    runId: string;
    authorityHandle: string;
  }): Promise<void>;
}

export interface VectorIngressProviderAuthority {
  registerPending(input: VectorIngressScope & {
    issueId: string;
    commentId: string;
    authorityHandle: string;
  }): VectorProviderPendingDescriptor;
  bindRun(input: VectorIngressScope & {
    issueId: string;
    runId: string;
    authorityHandle: string;
  }): Promise<void>;
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
    .update("\0");
  if (input.ownerId?.trim()) {
    digest
      .update(input.installationId?.trim() ?? "")
      .update("\0")
      .update(input.profileId?.trim() ?? "")
      .update("\0")
      .update(input.ownerId.trim())
      .update("\0");
  }
  digest.update(input.externalSessionId);
  return `vector:${digest.digest("base64url")}`;
}

export function vectorIngressOwnerSha256(input: VectorIngressOwnerScope): string {
  return createHash("sha256")
    .update("paperclip-vector-ingress-owner/v1\0")
    .update(input.companyId)
    .update("\0")
    .update(input.agentId)
    .update("\0")
    .update(input.installationId.trim())
    .update("\0")
    .update(input.profileId.trim())
    .update("\0")
    .update(input.ownerId.trim())
    .digest("hex");
}

function sorted(values: readonly string[]) {
  return [...values].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function hasCompleteOwnerScope(
  scope: VectorIngressScope,
): scope is VectorIngressScope & VectorIngressOwnerScope {
  const fields = [scope.ownerId, scope.installationId, scope.profileId];
  const complete = fields.every((value) => Boolean(value?.trim()));
  if (!complete && fields.some((value) => Boolean(value?.trim()))) {
    throw conflict("Vector owner scope is incomplete", {
      code: "vector_ingress_owner_scope_incomplete",
    });
  }
  return complete;
}

export function vectorIngressService(
  db: Db,
  options: {
    heartbeat?: VectorIngressHeartbeat;
    responsibleUserId?: string;
    toolAuthority?: VectorIngressToolAuthority;
    providerAuthority?: VectorIngressProviderAuthority;
  } = {},
) {
  const issuesSvc = issueService(db);
  const heartbeat = options.heartbeat ?? heartbeatService(db);
  const responsibleUserId = options.responsibleUserId?.trim() || "local-board";

  async function assertTargetAgent(scope: VectorIngressScope) {
    const agent = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        status: agents.status,
        adapterConfig: agents.adapterConfig,
        metadata: agents.metadata,
      })
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

  async function assertWorkloadLaunch(input: VectorIngressTurnInput) {
    if (!input.launchContext) return;
    if (!hasCompleteOwnerScope(input)) {
      throw conflict("Vector workload launch requires complete owner scope", {
        code: "vector_workload_owner_scope_required",
      });
    }
    const agent = await assertTargetAgent(input);
    const metadata = eventPayloadRecord(agent.metadata);
    const provisioning = eventPayloadRecord(metadata.vectorProvisioning);
    const workloads = eventPayloadRecord(metadata.vectorWorkloads);
    if (
      provisioning.schemaVersion !== 1 ||
      provisioning.installationId !== input.installationId ||
      provisioning.profile !== input.profileId
    ) {
      throw conflict("Vector workload launch does not match provisioned installation", {
        code: "vector_workload_installation_mismatch",
      });
    }
    const contracts = Array.isArray(workloads.contracts)
      ? workloads.contracts.map(eventPayloadRecord)
      : [];
    const contract = contracts.find((candidate) => candidate.key === input.launchContext?.workloadKey);
    if (!contract || contract.runtimeAuthority !== "vector_lease_triple") {
      throw conflict("Vector workload is not assigned to this agent", {
        code: "vector_workload_agent_mismatch",
      });
    }
    const expectedQueue = contract.kind === "research_task" ? "research" : "tasks";
    const expectedTools = Array.isArray(contract.toolSurface)
      ? contract.toolSurface.filter((value): value is string => typeof value === "string").sort()
      : [];
    const actualTools = [...new Set(input.launchContext.tools)].sort();
    const policyModel = typeof contract.modelPolicy === "string" ? contract.modelPolicy : "";
    if (
      agent.role !== input.launchContext.role ||
      contract.role !== input.launchContext.role ||
      input.launchContext.queue !== expectedQueue ||
      !sameStrings(expectedTools, actualTools) ||
      input.launchContext.tools.length !== actualTools.length ||
      input.launchContext.model !== policyModel ||
      input.launchContext.metadata.task_id !== input.launchContext.taskId ||
      input.launchContext.metadata.attempt !== String(input.launchContext.attempt)
    ) {
      throw conflict("Vector workload launch differs from the provisioned contract", {
        code: "vector_workload_contract_mismatch",
      });
    }
  }

  async function assertRoleTurn(input: VectorIngressTurnInput) {
    if (!input.roleContext) return;
    if (!hasCompleteOwnerScope(input)) {
      throw conflict("Vector role turn requires complete owner scope", {
        code: "vector_role_owner_scope_required",
      });
    }
    const agent = await assertTargetAgent(input);
    const metadata = eventPayloadRecord(agent.metadata);
    const provisioning = eventPayloadRecord(metadata.vectorProvisioning);
    const adapterConfig = eventPayloadRecord(agent.adapterConfig);
    const configuredModel = typeof adapterConfig.model === "string" ? adapterConfig.model : "";
    if (
      provisioning.schemaVersion !== 1 ||
      provisioning.installationId !== input.installationId ||
      provisioning.profile !== input.profileId ||
      input.profileId !== "staging" ||
      agent.role !== input.roleContext.role ||
      (input.roleContext.model !== "" && input.roleContext.model !== configuredModel)
    ) {
      throw conflict("Vector role turn differs from the provisioned agent contract", {
        code: "vector_role_contract_mismatch",
      });
    }
  }

  async function assertPersonaTurn(
    input: VectorIngressTurnInput,
    personaContext: VectorPersonaTurnContext,
  ) {
    if (!hasCompleteOwnerScope(input)) {
      throw conflict("Vector persona turn requires complete owner scope", {
        code: "vector_persona_owner_scope_required",
      });
    }
    const agent = await assertTargetAgent(input);
    const metadata = eventPayloadRecord(agent.metadata);
    const provisioning = eventPayloadRecord(metadata.vectorProvisioning);
    const adapterConfig = eventPayloadRecord(agent.adapterConfig);
    const configuredModel = typeof adapterConfig.model === "string" ? adapterConfig.model : "";
    if (
      provisioning.schemaVersion !== 1 ||
      provisioning.installationId !== input.installationId ||
      provisioning.profile !== input.profileId ||
      input.profileId !== "standard" ||
      agent.role !== "standard-chat" ||
      personaContext.model !== configuredModel ||
      personaContext.noBuiltinTools !== true
    ) {
      throw conflict("Vector persona turn differs from the provisioned agent contract", {
        code: "vector_persona_contract_mismatch",
      });
    }
  }

  function persistedPersonaContext(raw: unknown): VectorPersonaTurnContext | null {
    const value = eventPayloadRecord(raw);
    const keys = Object.keys(value).sort();
    const expected = ["model", "noBuiltinTools", "personaId", "personaName", "personaVersion", "schemaVersion", "systemPrompt"];
    if (
      !sameStrings(keys, expected) || value.schemaVersion !== 1 ||
      typeof value.personaId !== "string" || typeof value.personaName !== "string" ||
      typeof value.personaVersion !== "string" || typeof value.model !== "string" ||
      value.noBuiltinTools !== true || typeof value.systemPrompt !== "string"
    ) return null;
    return value as unknown as VectorPersonaTurnContext;
  }

  async function resolvePersonaTurn(
    input: VectorIngressTurnInput,
    issue: { id: string },
  ): Promise<VectorPersonaTurnContext | null> {
    const priorRun = await latestConversationRun(input, issue);
    const prior = persistedPersonaContext(priorRun?.contextSnapshot?.vectorPersonaTurn);
    const requested = input.personaContext ?? null;
    if (
      requested && prior &&
      (requested.schemaVersion !== prior.schemaVersion ||
        requested.personaId !== prior.personaId ||
        requested.personaName !== prior.personaName ||
        requested.personaVersion !== prior.personaVersion ||
        requested.model !== prior.model ||
        requested.noBuiltinTools !== prior.noBuiltinTools ||
        requested.systemPrompt !== prior.systemPrompt)
    ) {
      throw conflict("Vector persona cannot change within an existing conversation", {
        code: "vector_persona_continuity_mismatch",
      });
    }
    const effective = requested ?? prior;
    if (!effective && input.profileId === "standard") {
      throw conflict("Vector standard-chat requires an admitted persona", {
        code: "vector_persona_required",
      });
    }
    if (effective) await assertPersonaTurn(input, effective);
    return effective;
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

  async function bindConversationOwner(
    scope: VectorIngressScope & VectorIngressOwnerScope,
    issueId: string,
  ) {
    const ownerSha256 = vectorIngressOwnerSha256(scope);
    await db
      .insert(vectorIngressConversations)
      .values({
        companyId: scope.companyId,
        agentId: scope.agentId,
        issueId,
        installationId: scope.installationId,
        profileId: scope.profileId,
        ownerSha256,
        externalSessionId: scope.externalSessionId,
      })
      .onConflictDoNothing();
    const mapping = await db
      .select()
      .from(vectorIngressConversations)
      .where(eq(vectorIngressConversations.issueId, issueId))
      .then((rows) => rows[0] ?? null);
    if (
      !mapping ||
      mapping.companyId !== scope.companyId ||
      mapping.agentId !== scope.agentId ||
      mapping.installationId !== scope.installationId ||
      mapping.profileId !== scope.profileId ||
      mapping.ownerSha256 !== ownerSha256 ||
      mapping.externalSessionId !== scope.externalSessionId
    ) {
      throw conflict("Vector conversation owner binding does not match", {
        code: "vector_ingress_owner_scope_mismatch",
      });
    }
    return mapping;
  }

  async function requireConversation(scope: VectorIngressScope) {
    await assertTargetAgent(scope);
    const resolved = await getConversation(scope);
    if (!resolved.issue) throw notFound("Vector conversation not found");
    return { issue: resolved.issue, ownerId: resolved.ownerId };
  }

  async function requireOwnedConversation(
    scope: VectorIngressScope & VectorIngressOwnerScope,
  ) {
    const resolved = await requireConversation(scope);
    const mapping = await bindConversationOwner(scope, resolved.issue.id);
    return { ...resolved, mapping };
  }

  async function resolveConversation(scope: VectorIngressScope) {
    hasCompleteOwnerScope(scope);
    const agent = await assertTargetAgent(scope);
    const existing = await getConversation(scope);
    if (existing.issue) {
      if (hasCompleteOwnerScope(scope)) {
        await bindConversationOwner(scope, existing.issue.id);
      }
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
    if (hasCompleteOwnerScope(scope)) {
      await bindConversationOwner(scope, issue.id);
    }
    return { issue, ownerId: existing.ownerId, created: true };
  }

  async function latestConversationRun(
    scope: VectorIngressScope,
    issue: { id: string },
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
    const { issue } = hasCompleteOwnerScope(input)
      ? await requireOwnedConversation(input)
      : await requireConversation(input);
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
            eventCursor: Math.max(0, run.nextEventSeq - 1),
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

  async function inventory(input: VectorIngressInventoryInput) {
    await assertTargetAgent({ ...input, externalSessionId: "inventory" });
    const ownerSha256 = vectorIngressOwnerSha256(input);
    const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
    const afterAt = input.after ? new Date(input.after.at) : null;
    if (afterAt && Number.isNaN(afterAt.getTime())) {
      throw new Error("vector_ingress_invalid_cursor");
    }
    const rows = await db
      .select({
        externalSessionId: vectorIngressConversations.externalSessionId,
        mappingCreatedAt: vectorIngressConversations.createdAt,
        issueId: issues.id,
        issueIdentifier: issues.identifier,
        sessionGeneration: issues.conversationSessionGeneration,
        conversationState: issues.conversationState,
        issueCreatedAt: issues.createdAt,
        issueUpdatedAt: issues.updatedAt,
      })
      .from(vectorIngressConversations)
      .innerJoin(
        issues,
        and(
          eq(issues.id, vectorIngressConversations.issueId),
          eq(issues.companyId, vectorIngressConversations.companyId),
          eq(issues.conversationAgentId, vectorIngressConversations.agentId),
        ),
      )
      .where(
        and(
          eq(vectorIngressConversations.companyId, input.companyId),
          eq(vectorIngressConversations.agentId, input.agentId),
          eq(vectorIngressConversations.installationId, input.installationId),
          eq(vectorIngressConversations.profileId, input.profileId),
          eq(vectorIngressConversations.ownerSha256, ownerSha256),
          isNull(issues.hiddenAt),
          afterAt
            ? or(
                gt(vectorIngressConversations.createdAt, afterAt),
                and(
                  eq(vectorIngressConversations.createdAt, afterAt),
                  gt(
                    vectorIngressConversations.externalSessionId,
                    input.after!.id,
                  ),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        asc(vectorIngressConversations.createdAt),
        asc(vectorIngressConversations.externalSessionId),
      )
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const sessions = await Promise.all(
      page.map(async (row) => {
        const run = await latestConversationRun(
          { ...input, externalSessionId: row.externalSessionId },
          { id: row.issueId },
        );
        const live = Boolean(
          run &&
            ACTIVE_RUN_STATUSES.includes(
              run.status as (typeof ACTIVE_RUN_STATUSES)[number],
            ),
        );
        return {
          externalSessionId: row.externalSessionId,
          createdAt: row.issueCreatedAt,
          updatedAt: row.issueUpdatedAt,
          sessionGeneration: row.sessionGeneration,
          live,
          busy: live,
          done: !live,
          runStatus: run?.status ?? null,
        };
      }),
    );
    const last = page.at(-1);
    const hasMore = rows.length > limit;
    return {
      companyId: input.companyId,
      agentId: input.agentId,
      sessions,
      hasMore,
      nextPosition: hasMore && last
        ? ({
            at: last.mappingCreatedAt.toISOString(),
            rank: 0,
            id: last.externalSessionId,
          } satisfies VectorIngressCursorPosition)
        : null,
    };
  }

  type TranscriptCandidate = {
    at: Date;
    rank: 0 | 1 | 2;
    id: string;
    eventType: string;
    message: string | null;
    payload: Record<string, unknown>;
  };

  function compareTranscriptCandidate(
    left: TranscriptCandidate,
    right: TranscriptCandidate,
  ) {
    const time = left.at.getTime() - right.at.getTime();
    if (time !== 0) return time;
    if (left.rank !== right.rank) return left.rank - right.rank;
    if (left.rank === 1) return Number(left.id) - Number(right.id);
    return left.id.localeCompare(right.id);
  }

  async function transcript(input: VectorIngressTranscriptInput) {
    const { issue, mapping } = await requireOwnedConversation(input);
    const limit = Math.max(1, Math.min(input.limit ?? 200, 500));
    const afterAt = input.after ? new Date(input.after.at) : null;
    if (afterAt && Number.isNaN(afterAt.getTime())) {
      throw new Error("vector_ingress_invalid_cursor");
    }
    const after = input.after;
    const commentAfter = !afterAt
      ? undefined
      : after!.rank > 0
        ? gt(issueComments.createdAt, afterAt)
        : or(
            gt(issueComments.createdAt, afterAt),
            and(
              eq(issueComments.createdAt, afterAt),
              gt(issueComments.id, after!.id),
            ),
          );
    const eventAfter = !afterAt
      ? undefined
      : after!.rank > 1
        ? gt(heartbeatRunEvents.createdAt, afterAt)
        : after!.rank < 1
          ? gte(heartbeatRunEvents.createdAt, afterAt)
          : or(
              gt(heartbeatRunEvents.createdAt, afterAt),
              and(
                eq(heartbeatRunEvents.createdAt, afterAt),
                gt(heartbeatRunEvents.id, Number(after!.id)),
              ),
            );
    const terminalAfter = !afterAt
      ? undefined
      : after!.rank < 2
        ? gte(heartbeatRuns.finishedAt, afterAt)
        : or(
            gt(heartbeatRuns.finishedAt, afterAt),
            and(
              eq(heartbeatRuns.finishedAt, afterAt),
              gt(heartbeatRuns.id, after!.id),
            ),
          );
    const runScope = and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      or(
        eq(heartbeatRuns.nativeIssueId, issue.id),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
      ),
    );
    const [comments, runEvents, terminalRuns] = await Promise.all([
      db
        .select({
          id: issueComments.id,
          body: issueComments.body,
          createdAt: vectorIngressTurns.createdAt,
        })
        .from(vectorIngressTurns)
        .innerJoin(
          issueComments,
          eq(issueComments.id, vectorIngressTurns.commentId),
        )
        .where(
          and(
            eq(vectorIngressTurns.conversationId, mapping.id),
            eq(issueComments.issueId, issue.id),
            isNull(issueComments.deletedAt),
            commentAfter,
          ),
        )
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id))
        .limit(limit + 1),
      db
        .select({
          id: heartbeatRunEvents.id,
          eventType: heartbeatRunEvents.eventType,
          message: heartbeatRunEvents.message,
          payload: heartbeatRunEvents.payload,
          createdAt: heartbeatRunEvents.createdAt,
        })
        .from(heartbeatRunEvents)
        .innerJoin(
          heartbeatRuns,
          and(
            eq(heartbeatRuns.id, heartbeatRunEvents.runId),
            eq(heartbeatRuns.companyId, heartbeatRunEvents.companyId),
            eq(heartbeatRuns.agentId, heartbeatRunEvents.agentId),
          ),
        )
        .where(
          and(
            runScope,
            inArray(heartbeatRunEvents.eventType, [
              ...VECTOR_TRANSCRIPT_EVENT_TYPES,
            ]),
            eventAfter,
          ),
        )
        .orderBy(asc(heartbeatRunEvents.createdAt), asc(heartbeatRunEvents.id))
        .limit(limit + 1),
      db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          finishedAt: heartbeatRuns.finishedAt,
        })
        .from(heartbeatRuns)
        .where(
          and(
            runScope,
            inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
            isNotNull(heartbeatRuns.finishedAt),
            terminalAfter,
          ),
        )
        .orderBy(asc(heartbeatRuns.finishedAt), asc(heartbeatRuns.id))
        .limit(limit + 1),
    ]);
    const candidates: TranscriptCandidate[] = [
      ...comments.map((comment) => ({
        at: comment.createdAt,
        rank: 0 as const,
        id: comment.id,
        eventType: "user_turn",
        message: null,
        payload: { text: comment.body },
      })),
      ...runEvents.map((event) => ({
        at: event.createdAt,
        rank: 1 as const,
        id: String(event.id),
        eventType: event.eventType,
        message: projectVectorTranscriptMessage(event.eventType, event.message),
        payload: projectVectorEventPayload(event.eventType, event.payload),
      })),
      ...terminalRuns.map((run) => ({
        at: run.finishedAt!,
        rank: 2 as const,
        id: run.id,
        eventType: "run_terminal",
        message: null,
        payload: {
          status: run.status,
          failed: run.status === "failed" || run.status === "timed_out",
        },
      })),
    ].sort(compareTranscriptCandidate);
    const page = candidates.slice(0, limit);
    const last = page.at(-1);
    const hasMore = candidates.length > limit;
    return {
      companyId: input.companyId,
      agentId: input.agentId,
      externalSessionId: input.externalSessionId,
      events: page.map((event) => ({
        eventType: event.eventType,
        message: event.message,
        payload: event.payload,
        createdAt: event.at,
      })),
      hasMore,
      nextPosition: hasMore && last
        ? ({
            at: last.at.toISOString(),
            rank: last.rank,
            id: last.id,
          } satisfies VectorIngressCursorPosition)
        : null,
    };
  }

  async function addTurn(input: VectorIngressTurnInput) {
    if (input.authorityHandle && !options.toolAuthority) {
      throw conflict("Vector tool authority is disabled", {
        code: "vector_tool_authority_disabled",
      });
    }
    if (input.providerAuthorityHandle && !options.providerAuthority) {
      throw conflict("Vector provider authority is disabled", {
        code: "vector_provider_authority_disabled",
      });
    }
    await assertWorkloadLaunch(input);
    await assertRoleTurn(input);
    const { issue, ownerId } = await resolveConversation(input);
    const mapping = hasCompleteOwnerScope(input)
      ? await bindConversationOwner(input, issue.id)
      : null;
    const personaContext = await resolvePersonaTurn(input, issue);
    const requestedAttachmentIds = [...new Set(input.attachmentIds ?? [])];
    const effectiveBody = input.launchContext
      ? `[VECTOR_WORKLOAD_LAUNCH_V1]\n${JSON.stringify(input.launchContext)}\n\n${input.body}`
      : input.roleContext
        ? `[VECTOR_ROLE_TURN_V1]\n${JSON.stringify(input.roleContext)}\n\n${input.body}`
      : input.body;
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
          existing.body !== effectiveBody ||
          !sameStrings(existingAttachmentIds, requestedAttachmentIds)
        ) {
          throw conflict(
            "Vector clientRequestId was already used for a different turn",
            { code: "vector_ingress_idempotency_conflict" },
          );
        }
        replayed = true;
        if (mapping) {
          await tx
            .insert(vectorIngressTurns)
            .values({
              conversationId: mapping.id,
              commentId: existing.id,
              createdAt: existing.createdAt,
            })
            .onConflictDoNothing();
        }
        return existing;
      }

      const inserted = await issuesSvc.addComment(
        issue.id,
        effectiveBody,
        { userId: responsibleUserId },
        {
          clientRequestId: input.clientRequestId,
          authorType: "user",
          attachmentIds: requestedAttachmentIds,
        },
        tx,
      );
      if (mapping) {
        await tx.insert(vectorIngressTurns).values({
          conversationId: mapping.id,
          commentId: inserted.id,
          createdAt: inserted.createdAt,
        });
      }
      return inserted;
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

    const pendingAuthority = input.authorityHandle
      ? options.toolAuthority!.registerPending({
          companyId: input.companyId,
          agentId: input.agentId,
          externalSessionId: input.externalSessionId,
          issueId: issue.id,
          commentId: comment.id,
          authorityHandle: input.authorityHandle,
          allowedTools: input.authorityTools!,
        })
      : null;
    const pendingProviderAuthority = input.providerAuthorityHandle
      ? options.providerAuthority!.registerPending({
          companyId: input.companyId,
          agentId: input.agentId,
          externalSessionId: input.externalSessionId,
          issueId: issue.id,
          commentId: comment.id,
          authorityHandle: input.providerAuthorityHandle,
        })
      : null;
    let deliveredRunId: string | null = null;
    await deliverConversationComments(db, issue, async (agentId, wakeup) => {
      const targetWake = wakeup.idempotencyKey === `conversation-comment:${comment.id}` && (pendingAuthority || pendingProviderAuthority)
        ? {
            ...wakeup,
            contextSnapshot: {
              ...wakeup.contextSnapshot,
              ...(pendingAuthority ? { vectorToolAuthorityPending: pendingAuthority } : {}),
              ...(pendingProviderAuthority
                ? { vectorProviderAuthorityPending: pendingProviderAuthority }
                : {}),
            },
          }
        : wakeup;
      const run = await heartbeat.wakeup(agentId, targetWake);
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
    }, input.launchContext
      ? { vectorWorkloadLaunch: input.launchContext }
      : input.roleContext
        ? { vectorRoleTurn: input.roleContext }
        : personaContext
          ? { vectorPersonaTurn: personaContext }
          : {});

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

    const runId = deliveredRunId ?? receipt?.runId ?? null;
    if (input.authorityHandle) {
      if (!runId) {
        throw conflict("Vector tool authority requires a created run", {
          code: "vector_tool_authority_run_missing",
        });
      }
      await options.toolAuthority!.bindRun({
        companyId: input.companyId,
        agentId: input.agentId,
        externalSessionId: input.externalSessionId,
        issueId: issue.id,
        runId,
        authorityHandle: input.authorityHandle,
      });
    }
    if (input.providerAuthorityHandle) {
      if (!runId) {
        throw conflict("Vector provider authority requires a created run", {
          code: "vector_provider_authority_run_missing",
        });
      }
      await options.providerAuthority!.bindRun({
        companyId: input.companyId,
        agentId: input.agentId,
        externalSessionId: input.externalSessionId,
        issueId: issue.id,
        runId,
        authorityHandle: input.providerAuthorityHandle,
      });
    }

    return {
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      commentId: comment.id,
      runId,
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
    inventory,
    transcript,
  };
}

export type VectorIngressService = ReturnType<typeof vectorIngressService>;
