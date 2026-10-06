import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  controlVectorPiSession,
  removeVectorPiForkFile,
  VectorPiSessionControlError,
  type VectorPiSessionControlInput,
  type VectorPiSessionControlResult,
} from "@paperclipai/adapter-pi-local/server";
import {
  agentTaskSessions,
  agents,
  heartbeatRuns,
  issueComments,
  issues,
  vectorIngressBranches,
  vectorIngressBranchHeads,
  vectorIngressBranchTurns,
  vectorIngressConversations,
  vectorIngressTurns,
  type Db,
} from "@paperclipai/db";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { conflict, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import type { VectorIngressOwnerScope } from "./vector-ingress.js";
import { vectorIngressOwnerSha256, type VectorIngressOwnerBinding } from "./vector-ingress-owner.js";

const ACTIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;
// A fork performs a read/list control call and then the mutating fork call.
// Each controller call is bounded to 30 seconds, so the durable fence needs
// explicit commit margin beyond their combined worst case.
const CONTROL_LEASE_MS = 2 * 60_000;
const ACTOR_ID = "vector-ingress";

export interface VectorSessionBranchScope extends VectorIngressOwnerScope {
  externalSessionId: string;
}

export interface VectorSessionForkInput extends VectorSessionBranchScope {
  entryId: string;
}

export interface VectorSessionSwitchInput extends VectorSessionBranchScope {
  branchId: string;
}

export type VectorPiSessionController = (
  input: VectorPiSessionControlInput,
) => Promise<VectorPiSessionControlResult>;

type OwnedConversation = {
  conversationId: string;
  issueId: string;
  generation: number;
  ownerBinding: VectorIngressOwnerBinding;
};

type ClaimedControl = OwnedConversation & {
  companyId: string;
  agentId: string;
  operationId: string;
  taskSession: typeof agentTaskSessions.$inferSelect;
  cwd: string;
  sessionFile: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedString(value: unknown, max = 4096): string | null {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max
    ? value
    : null;
}

function sameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function retainedParams(value: unknown): { raw: Record<string, unknown>; sessionFile: string; cwd: string } {
  const raw = record(value);
  const sessionFile = boundedString(raw.sessionId);
  const cwd = boundedString(raw.cwd);
  if (!sessionFile || !path.isAbsolute(sessionFile) || !cwd || !path.isAbsolute(cwd)) {
    throw conflict("Vector conversation has no local retained Pi context", {
      code: "vector_branch_context_unavailable",
    });
  }
  if (raw.remoteExecution !== undefined) {
    throw conflict("Remote Pi branches are not supported by this installation", {
      code: "vector_branch_remote_context_unsupported",
    });
  }
  return { raw, sessionFile, cwd };
}

function piTurnState(value: unknown): { promptEntryId: string; sessionFile: string; sessionId: string } | null {
  const state = record(record(value).vectorPiSession);
  const promptEntryId = boundedString(state.promptEntryId, 256);
  const sessionFile = boundedString(state.sessionFile);
  const sessionId = boundedString(state.sessionId, 256);
  return promptEntryId && sessionFile && path.isAbsolute(sessionFile) && sessionId
    ? { promptEntryId, sessionFile, sessionId }
    : null;
}

export function vectorSessionBranchService(
  db: Db,
  options: {
    controller?: VectorPiSessionController;
    removeForkFile?: typeof removeVectorPiForkFile;
    sessionsRoot?: string;
    now?: () => Date;
  } = {},
) {
  const controller = options.controller ?? controlVectorPiSession;
  const removeForkFile = options.removeForkFile ?? removeVectorPiForkFile;
  const now = options.now ?? (() => new Date());

  async function resolveOwnedConversation(input: VectorSessionBranchScope): Promise<OwnedConversation> {
    const ownerSha256 = vectorIngressOwnerSha256(input);
    const row = await db
      .select({
        conversationId: vectorIngressConversations.id,
        issueId: issues.id,
        generation: issues.conversationSessionGeneration,
        ownerSha256: vectorIngressConversations.ownerSha256,
        externalSessionId: vectorIngressConversations.externalSessionId,
      })
      .from(vectorIngressConversations)
      .innerJoin(issues, and(
        eq(issues.id, vectorIngressConversations.issueId),
        eq(issues.companyId, vectorIngressConversations.companyId),
      ))
      .innerJoin(agents, and(
        eq(agents.id, vectorIngressConversations.agentId),
        eq(agents.companyId, vectorIngressConversations.companyId),
      ))
      .where(and(
        eq(vectorIngressConversations.companyId, input.companyId),
        eq(vectorIngressConversations.agentId, input.agentId),
        eq(vectorIngressConversations.installationId, input.installationId),
        eq(vectorIngressConversations.profileId, input.profileId),
        eq(vectorIngressConversations.ownerSha256, ownerSha256),
        eq(vectorIngressConversations.externalSessionId, input.externalSessionId),
        eq(agents.adapterType, "pi_local"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Vector conversation branch context not found");
    return {
      conversationId: row.conversationId,
      issueId: row.issueId,
      generation: row.generation,
      // Echo the stored binding, not the request, so Vector can refuse a
      // reply that resolved some other owner's conversation.
      ownerBinding: { ownerSha256: row.ownerSha256, externalSessionId: row.externalSessionId },
    };
  }

  async function claim(input: VectorSessionBranchScope, kind: "list" | "fork" | "switch"): Promise<ClaimedControl> {
    const owned = await resolveOwnedConversation(input);
    const operationId = randomUUID();
    return db.transaction(async (tx) => {
      const lockedIssue = await tx.select({ generation: issues.conversationSessionGeneration })
        .from(issues)
        .where(and(eq(issues.id, owned.issueId), eq(issues.companyId, input.companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!lockedIssue || lockedIssue.generation !== owned.generation) {
        throw conflict("Vector conversation generation changed", { code: "vector_branch_generation_changed" });
      }
      const activeRun = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
        or(
          eq(heartbeatRuns.nativeIssueId, owned.issueId),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${owned.issueId}`,
        ),
      )).limit(1).then((rows) => rows[0] ?? null);
      const pendingTurn = await tx.select({ id: vectorIngressTurns.commentId })
        .from(vectorIngressTurns)
        .innerJoin(issueComments, eq(issueComments.id, vectorIngressTurns.commentId))
        .where(and(
          eq(vectorIngressTurns.conversationId, owned.conversationId),
          eq(issueComments.conversationSessionGeneration, owned.generation),
          isNull(vectorIngressTurns.runId),
        )).limit(1).then((rows) => rows[0] ?? null);
      if (activeRun || pendingTurn) {
        throw conflict("Vector conversation has an active or pending turn", { code: "vector_branch_turn_active" });
      }

      await tx.insert(vectorIngressBranchHeads).values({
        companyId: input.companyId,
        conversationId: owned.conversationId,
        sessionGeneration: owned.generation,
      }).onConflictDoNothing();
      const head = await tx.select().from(vectorIngressBranchHeads).where(and(
        eq(vectorIngressBranchHeads.companyId, input.companyId),
        eq(vectorIngressBranchHeads.conversationId, owned.conversationId),
        eq(vectorIngressBranchHeads.sessionGeneration, owned.generation),
      )).for("update").then((rows) => rows[0] ?? null);
      if (!head) throw new Error("vector_branch_head_missing");
      const currentTime = now();
      if (head.controlOperationId && head.controlExpiresAt && head.controlExpiresAt > currentTime) {
        throw conflict("Vector branch control is busy", { code: "vector_branch_control_busy" });
      }

      const taskSession = await tx.select().from(agentTaskSessions).where(and(
        eq(agentTaskSessions.companyId, input.companyId),
        eq(agentTaskSessions.agentId, input.agentId),
        eq(agentTaskSessions.adapterType, "pi_local"),
        eq(agentTaskSessions.taskKey, owned.issueId),
      )).limit(1).then((rows) => rows[0] ?? null);
      if (!taskSession) {
        throw conflict("Vector conversation has no retained Pi session", { code: "vector_branch_context_unavailable" });
      }
      const retained = retainedParams(taskSession.sessionParamsJson);
      await tx.update(vectorIngressBranchHeads).set({
        controlOperationId: operationId,
        controlKind: kind,
        controlExpiresAt: new Date(currentTime.getTime() + CONTROL_LEASE_MS),
        updatedAt: currentTime,
      }).where(and(
        eq(vectorIngressBranchHeads.companyId, input.companyId),
        eq(vectorIngressBranchHeads.conversationId, owned.conversationId),
        eq(vectorIngressBranchHeads.sessionGeneration, owned.generation),
      ));
      return {
        ...owned,
        companyId: input.companyId,
        agentId: input.agentId,
        operationId,
        taskSession,
        cwd: retained.cwd,
        sessionFile: retained.sessionFile,
      };
    });
  }

  async function release(input: VectorSessionBranchScope, claim: ClaimedControl): Promise<void> {
    await db.update(vectorIngressBranchHeads).set({
      controlOperationId: null,
      controlKind: null,
      controlExpiresAt: null,
      updatedAt: now(),
    }).where(and(
      eq(vectorIngressBranchHeads.companyId, input.companyId),
      eq(vectorIngressBranchHeads.conversationId, claim.conversationId),
      eq(vectorIngressBranchHeads.sessionGeneration, claim.generation),
      eq(vectorIngressBranchHeads.controlOperationId, claim.operationId),
    ));
  }

  async function initializeActiveBranch(
    input: VectorSessionBranchScope,
    claim: ClaimedControl,
    controlled: VectorPiSessionControlResult,
  ) {
    return db.transaction(async (tx) => {
      const lockedIssue = await tx.select({ generation: issues.conversationSessionGeneration })
        .from(issues).where(and(eq(issues.id, claim.issueId), eq(issues.companyId, input.companyId)))
        .for("update").then((rows) => rows[0] ?? null);
      const head = await tx.select().from(vectorIngressBranchHeads).where(and(
        eq(vectorIngressBranchHeads.companyId, input.companyId),
        eq(vectorIngressBranchHeads.conversationId, claim.conversationId),
        eq(vectorIngressBranchHeads.sessionGeneration, claim.generation),
      )).for("update").then((rows) => rows[0] ?? null);
      if (!lockedIssue || lockedIssue.generation !== claim.generation || head?.controlOperationId !== claim.operationId) {
        throw conflict("Vector branch control lease was lost", { code: "vector_branch_control_lost" });
      }
      const task = await tx.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, claim.taskSession.id))
        .for("update").then((rows) => rows[0] ?? null);
      if (!task || !sameInstant(task.updatedAt, claim.taskSession.updatedAt) || retainedParams(task.sessionParamsJson).sessionFile !== claim.sessionFile) {
        throw conflict("Vector retained Pi context changed", { code: "vector_branch_context_changed" });
      }
      if (head.activeBranchId) {
        const existing = await tx.select().from(vectorIngressBranches).where(and(
          eq(vectorIngressBranches.id, head.activeBranchId),
          eq(vectorIngressBranches.companyId, input.companyId),
          eq(vectorIngressBranches.conversationId, claim.conversationId),
          eq(vectorIngressBranches.sessionGeneration, claim.generation),
        )).limit(1).then((rows) => rows[0] ?? null);
        if (!existing || retainedParams(existing.sessionParamsJson).sessionFile !== claim.sessionFile || existing.piSessionId !== controlled.state.sessionId) {
          throw conflict("Vector active branch differs from retained Pi context", { code: "vector_branch_context_changed" });
        }
        return existing;
      }

      const [branch] = await tx.insert(vectorIngressBranches).values({
        companyId: input.companyId,
        conversationId: claim.conversationId,
        sessionGeneration: claim.generation,
        sessionParamsJson: claim.taskSession.sessionParamsJson ?? {},
        sessionDisplayId: claim.taskSession.sessionDisplayId,
        piSessionId: controlled.state.sessionId,
      }).returning();
      if (!branch) throw new Error("vector_branch_insert_failed");
      const turns = await tx.select({ commentId: vectorIngressTurns.commentId })
        .from(vectorIngressTurns)
        .innerJoin(issueComments, eq(issueComments.id, vectorIngressTurns.commentId))
        .where(and(
          eq(vectorIngressTurns.conversationId, claim.conversationId),
          eq(issueComments.issueId, claim.issueId),
          eq(issueComments.conversationSessionGeneration, claim.generation),
        ))
        .orderBy(asc(vectorIngressTurns.createdAt), asc(vectorIngressTurns.commentId));
      if (turns.length > 0) {
        await tx.insert(vectorIngressBranchTurns).values(turns.map((turn, ordinal) => ({
          companyId: input.companyId,
          conversationId: claim.conversationId,
          sessionGeneration: claim.generation,
          branchId: branch.id,
          commentId: turn.commentId,
          ordinal,
        })));
      }
      await tx.update(vectorIngressBranchHeads).set({ activeBranchId: branch.id, updatedAt: now() }).where(and(
        eq(vectorIngressBranchHeads.companyId, input.companyId),
        eq(vectorIngressBranchHeads.conversationId, claim.conversationId),
        eq(vectorIngressBranchHeads.sessionGeneration, claim.generation),
        eq(vectorIngressBranchHeads.controlOperationId, claim.operationId),
      ));
      return branch;
    });
  }

  async function mappedForkPoints(claim: ClaimedControl, branch: typeof vectorIngressBranches.$inferSelect) {
    const rows = await db.select({
      commentId: vectorIngressBranchTurns.commentId,
      ordinal: vectorIngressBranchTurns.ordinal,
      runId: vectorIngressTurns.runId,
      resultJson: heartbeatRuns.resultJson,
    }).from(vectorIngressBranchTurns)
      .innerJoin(vectorIngressTurns, eq(vectorIngressTurns.commentId, vectorIngressBranchTurns.commentId))
      .leftJoin(heartbeatRuns, and(
        eq(heartbeatRuns.id, vectorIngressTurns.runId),
        eq(heartbeatRuns.companyId, claim.companyId),
        eq(heartbeatRuns.agentId, claim.agentId),
      ))
      .where(and(
        eq(vectorIngressBranchTurns.companyId, claim.companyId),
        eq(vectorIngressBranchTurns.conversationId, claim.conversationId),
        eq(vectorIngressBranchTurns.sessionGeneration, claim.generation),
        eq(vectorIngressBranchTurns.branchId, branch.id),
      )).orderBy(asc(vectorIngressBranchTurns.ordinal));
    return rows.flatMap((row) => {
      const state = piTurnState(row.resultJson);
      return state && state.sessionFile === claim.sessionFile && state.sessionId === branch.piSessionId
        ? [{ ...row, entryId: state.promptEntryId }]
        : [];
    });
  }

  async function list(input: VectorSessionBranchScope) {
    const claimed = await claim(input, "list");
    try {
      const controlled = await controller({
        cwd: claimed.cwd,
        sessionFile: claimed.sessionFile,
        sessionsRoot: options.sessionsRoot,
        action: { type: "list" },
      });
      const active = await initializeActiveBranch(input, claimed, controlled);
      const mapped = await mappedForkPoints(claimed, active);
      const pointText = new Map(controlled.points.map((point) => [point.entryId, point.text]));
      const branches = await db.select().from(vectorIngressBranches).where(and(
        eq(vectorIngressBranches.companyId, input.companyId),
        eq(vectorIngressBranches.conversationId, claimed.conversationId),
        eq(vectorIngressBranches.sessionGeneration, claimed.generation),
      )).orderBy(asc(vectorIngressBranches.createdAt), asc(vectorIngressBranches.id));
      return {
        ownerBinding: claimed.ownerBinding,
        sessionGeneration: claimed.generation,
        activeBranchId: active.id,
        points: mapped.flatMap((point) => pointText.has(point.entryId)
          ? [{ entryId: point.entryId, text: pointText.get(point.entryId)! }]
          : []),
        branches: branches.map((branch) => ({
          branchId: branch.id,
          parentBranchId: branch.parentBranchId,
          forkEntryId: branch.forkEntryId,
          forkText: branch.forkText,
          createdAt: branch.createdAt,
          active: branch.id === active.id,
        })),
      };
    } finally {
      await release(input, claimed);
    }
  }

  async function fork(input: VectorSessionForkInput) {
    const claimed = await claim(input, "fork");
    let forkedState: VectorPiSessionControlResult | null = null;
    try {
      const listed = await controller({
        cwd: claimed.cwd,
        sessionFile: claimed.sessionFile,
        sessionsRoot: options.sessionsRoot,
        action: { type: "list" },
      });
      const parent = await initializeActiveBranch(input, claimed, listed);
      const mapped = await mappedForkPoints(claimed, parent);
      const target = mapped.find((point) => point.entryId === input.entryId) ?? null;
      if (!target || !listed.points.some((point) => point.entryId === input.entryId)) {
        throw notFound("Vector fork point not found on the active branch");
      }
      try {
        forkedState = await controller({
          cwd: claimed.cwd,
          sessionFile: claimed.sessionFile,
          sessionsRoot: options.sessionsRoot,
          action: { type: "fork", entryId: input.entryId },
        });
      } catch (error) {
        if (error instanceof VectorPiSessionControlError && error.code === "fork_not_persisted") {
          throw conflict("Pi retains no history before this fork point; start a new conversation instead", {
            code: "vector_branch_fork_point_empty",
          });
        }
        throw error;
      }
      if (forkedState.forked?.cancelled || !forkedState.forked) {
        throw conflict("Pi cancelled the branch fork", { code: "vector_branch_fork_cancelled" });
      }
      const nextParams = { sessionId: forkedState.state.sessionFile, cwd: claimed.cwd };
      let created: typeof vectorIngressBranches.$inferSelect;
      try {
        created = await db.transaction(async (tx) => {
          const issue = await tx.select({ generation: issues.conversationSessionGeneration })
            .from(issues).where(and(eq(issues.id, claimed.issueId), eq(issues.companyId, input.companyId)))
            .for("update").then((rows) => rows[0] ?? null);
          const head = await tx.select().from(vectorIngressBranchHeads).where(and(
            eq(vectorIngressBranchHeads.companyId, input.companyId),
            eq(vectorIngressBranchHeads.conversationId, claimed.conversationId),
            eq(vectorIngressBranchHeads.sessionGeneration, claimed.generation),
          )).for("update").then((rows) => rows[0] ?? null);
          const task = await tx.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, claimed.taskSession.id))
            .for("update").then((rows) => rows[0] ?? null);
          if (!issue || issue.generation !== claimed.generation || head?.controlOperationId !== claimed.operationId || head.activeBranchId !== parent.id ||
              !task || !sameInstant(task.updatedAt, claimed.taskSession.updatedAt) || retainedParams(task.sessionParamsJson).sessionFile !== claimed.sessionFile) {
            throw conflict("Vector branch control state changed", { code: "vector_branch_control_lost" });
          }
          const [branch] = await tx.insert(vectorIngressBranches).values({
            companyId: input.companyId,
            conversationId: claimed.conversationId,
            sessionGeneration: claimed.generation,
            parentBranchId: parent.id,
            sessionParamsJson: nextParams,
            sessionDisplayId: forkedState!.state.sessionFile,
            piSessionId: forkedState!.state.sessionId,
            forkEntryId: input.entryId,
            forkText: forkedState!.forked!.text,
          }).returning();
          if (!branch) throw new Error("vector_branch_insert_failed");
          const priorTurns = await tx.select({ commentId: vectorIngressBranchTurns.commentId, ordinal: vectorIngressBranchTurns.ordinal })
            .from(vectorIngressBranchTurns).where(and(
              eq(vectorIngressBranchTurns.branchId, parent.id),
              lt(vectorIngressBranchTurns.ordinal, target.ordinal),
            )).orderBy(asc(vectorIngressBranchTurns.ordinal));
          if (priorTurns.length > 0) {
            await tx.insert(vectorIngressBranchTurns).values(priorTurns.map((turn) => ({
              companyId: input.companyId,
              conversationId: claimed.conversationId,
              sessionGeneration: claimed.generation,
              branchId: branch.id,
              commentId: turn.commentId,
              ordinal: turn.ordinal,
            })));
          }
          const updatedTask = await tx.update(agentTaskSessions).set({
            sessionParamsJson: nextParams,
            sessionDisplayId: forkedState!.state.sessionFile,
            updatedAt: now(),
          }).where(eq(agentTaskSessions.id, task.id))
            .returning({ id: agentTaskSessions.id });
          if (updatedTask.length !== 1) throw conflict("Vector retained Pi context changed", { code: "vector_branch_context_changed" });
          const updatedHead = await tx.update(vectorIngressBranchHeads).set({
            activeBranchId: branch.id,
            controlOperationId: null,
            controlKind: null,
            controlExpiresAt: null,
            updatedAt: now(),
          }).where(and(
            eq(vectorIngressBranchHeads.companyId, input.companyId),
            eq(vectorIngressBranchHeads.conversationId, claimed.conversationId),
            eq(vectorIngressBranchHeads.sessionGeneration, claimed.generation),
            eq(vectorIngressBranchHeads.controlOperationId, claimed.operationId),
          )).returning({ id: vectorIngressBranchHeads.activeBranchId });
          if (updatedHead.length !== 1) throw conflict("Vector branch control lease was lost", { code: "vector_branch_control_lost" });
          return branch;
        });
      } catch (error) {
        try {
          await removeForkFile({
            sessionFile: forkedState.state.sessionFile,
            sessionsRoot: options.sessionsRoot,
            cwd: claimed.cwd,
            sessionId: forkedState.state.sessionId,
            parentSessionFile: claimed.sessionFile,
          });
        } catch {
          throw conflict("Vector fork failed and retained-file rollback also failed", {
            code: "vector_branch_fork_rollback_failed",
          });
        }
        throw error;
      }
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: ACTOR_ID,
        action: "vector.branch_forked",
        entityType: "issue",
        entityId: claimed.issueId,
        issueId: claimed.issueId,
        details: { branchId: created.id, parentBranchId: parent.id, sessionGeneration: claimed.generation },
      });
      return { ownerBinding: claimed.ownerBinding, branchId: created.id, parentBranchId: parent.id, forked: true, text: forkedState.forked.text };
    } finally {
      await release(input, claimed);
    }
  }

  async function switchBranch(input: VectorSessionSwitchInput) {
    const claimed = await claim(input, "switch");
    try {
      const target = await db.select().from(vectorIngressBranches).where(and(
        eq(vectorIngressBranches.id, input.branchId),
        eq(vectorIngressBranches.companyId, input.companyId),
        eq(vectorIngressBranches.conversationId, claimed.conversationId),
        eq(vectorIngressBranches.sessionGeneration, claimed.generation),
      )).limit(1).then((rows) => rows[0] ?? null);
      if (!target) throw notFound("Vector branch not found");
      const retained = retainedParams(target.sessionParamsJson);
      const controlled = await controller({
        cwd: retained.cwd,
        sessionFile: retained.sessionFile,
        sessionsRoot: options.sessionsRoot,
        action: { type: "list" },
      });
      if (controlled.state.sessionId !== target.piSessionId) {
        throw conflict("Vector branch Pi identity does not match", { code: "vector_branch_context_changed" });
      }
      await db.transaction(async (tx) => {
        const issue = await tx.select({ generation: issues.conversationSessionGeneration })
          .from(issues).where(and(eq(issues.id, claimed.issueId), eq(issues.companyId, input.companyId)))
          .for("update").then((rows) => rows[0] ?? null);
        const head = await tx.select().from(vectorIngressBranchHeads).where(and(
          eq(vectorIngressBranchHeads.companyId, input.companyId),
          eq(vectorIngressBranchHeads.conversationId, claimed.conversationId),
          eq(vectorIngressBranchHeads.sessionGeneration, claimed.generation),
        )).for("update").then((rows) => rows[0] ?? null);
        const task = await tx.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, claimed.taskSession.id))
          .for("update").then((rows) => rows[0] ?? null);
        if (!issue || issue.generation !== claimed.generation || head?.controlOperationId !== claimed.operationId ||
            !task || !sameInstant(task.updatedAt, claimed.taskSession.updatedAt) || retainedParams(task.sessionParamsJson).sessionFile !== claimed.sessionFile) {
          throw conflict("Vector branch control state changed", { code: "vector_branch_control_lost" });
        }
        if (head.activeBranchId) {
          await tx.update(vectorIngressBranches).set({
            sessionParamsJson: task.sessionParamsJson ?? {},
            sessionDisplayId: task.sessionDisplayId,
            updatedAt: now(),
          }).where(and(
            eq(vectorIngressBranches.id, head.activeBranchId),
            eq(vectorIngressBranches.companyId, input.companyId),
            eq(vectorIngressBranches.conversationId, claimed.conversationId),
            eq(vectorIngressBranches.sessionGeneration, claimed.generation),
          ));
        }
        await tx.update(agentTaskSessions).set({
          sessionParamsJson: target.sessionParamsJson,
          sessionDisplayId: target.sessionDisplayId,
          updatedAt: now(),
        }).where(eq(agentTaskSessions.id, task.id));
        const updated = await tx.update(vectorIngressBranchHeads).set({
          activeBranchId: target.id,
          controlOperationId: null,
          controlKind: null,
          controlExpiresAt: null,
          updatedAt: now(),
        }).where(and(
          eq(vectorIngressBranchHeads.companyId, input.companyId),
          eq(vectorIngressBranchHeads.conversationId, claimed.conversationId),
          eq(vectorIngressBranchHeads.sessionGeneration, claimed.generation),
          eq(vectorIngressBranchHeads.controlOperationId, claimed.operationId),
        )).returning({ id: vectorIngressBranchHeads.activeBranchId });
        if (updated.length !== 1) throw conflict("Vector branch control lease was lost", { code: "vector_branch_control_lost" });
      });
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: ACTOR_ID,
        action: "vector.branch_switched",
        entityType: "issue",
        entityId: claimed.issueId,
        issueId: claimed.issueId,
        details: { branchId: target.id, sessionGeneration: claimed.generation },
      });
      return { ownerBinding: claimed.ownerBinding, branchId: target.id, switched: true };
    } finally {
      await release(input, claimed);
    }
  }

  return { list, fork, switchBranch };
}

export type VectorSessionBranchService = ReturnType<typeof vectorSessionBranchService>;
