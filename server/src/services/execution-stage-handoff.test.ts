import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, environmentLeases, heartbeatRuns, issues,
  issueTreeHolds, issueTreeHoldMembers } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "./heartbeat.js";
import { getExecutionBlocker } from "./execution-blocker.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("typed execution handoff during legacy cleanup", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("stage-handoff-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed(reason = "execution_review_requested") {
    const companyId = randomUUID(), outgoingId = randomUUID(), nextId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID(), leaseId = randomUUID(), stageId = randomUUID();
    const changes = reason === "execution_changes_requested";
    const stageType = reason === "execution_approval_requested" ? "approval" : "review";
    const state = { status: changes ? "changes_requested" : "pending", currentStageId: stageId,
      currentStageIndex: 0, currentStageType: stageType, currentParticipant: { type: "agent", agentId: changes ? outgoingId : nextId },
      returnAssignee: { type: "agent", agentId: changes ? nextId : outgoingId }, completedStageIds: [],
      lastDecisionId: null, lastDecisionOutcome: changes ? "changes_requested" : null };
    await db.insert(companies).values({ id: companyId, name: "Handoff", issuePrefix: `H${companyId.slice(0, 6)}`, defaultResponsibleUserId: "board" });
    await db.insert(agents).values([outgoingId, nextId].map(id => ({ id, companyId, name: id, role: "engineer", adapterType: "pi_local",
      status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })));
    await db.insert(issues).values({ id: issueId, companyId, title: "Review fixture", status: changes ? "in_progress" : "in_review",
      assigneeAgentId: nextId, executionState: state,
      executionPolicy: { mode: "normal", commentRequired: true, maxReviewRounds: 3,
        stages: [{ id: stageId, type: stageType, participants: [{ type: "agent", agentId: changes ? outgoingId : nextId }] }] } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: outgoingId, runtimeMode: "legacy",
      status: "cancelled", errorCode: "issue_reassigned", finishedAt: new Date(), contextSnapshot: { issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "pi_local" } } });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: runId, issueId,
      provider: "local", leasePolicy: "ephemeral", status: "active" });
    // Occupy the next agent's slot: real admission queues without launching a provider.
    await db.insert(heartbeatRuns).values({ companyId, agentId: nextId, status: "running" });
    const options = { executionStageHandoff: true, source: "assignment" as const, triggerDetail: "system" as const, reason,
      requestedByActorType: "agent" as const, requestedByActorId: outgoingId,
      payload: { issueId, interruptedRunId: runId }, contextSnapshot: { issueId, source: "issue.execution_stage",
        interruptedRunId: runId, executionStage: { stageId, stageType } } };
    return { companyId, outgoingId, nextId, issueId, runId, leaseId, options };
  }

  it.each(["execution_review_requested", "execution_approval_requested", "execution_changes_requested"])(
    "saves %s until cleanup and resumes exactly once with its actual actor", async reason => {
      const f = await seed(reason), heartbeat = heartbeatService(db);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
      expect(await heartbeat.wakeup(f.nextId, f.options)).toBeNull();
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      expect(receipt).toMatchObject({ status: "deferred_issue_execution", reason, requestedByActorType: "agent",
        requestedByActorId: f.outgoingId, payload: { executionStageHandoff: true } });
      await heartbeat.resumeExecutionStageHandoffs({ companyId: f.companyId, issueId: f.issueId });
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() }).where(eq(environmentLeases.id, f.leaseId));
      // Periodic retry also recovers the cleanup-before-receipt-commit/restart race.
      await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 31_000) }).where(eq(agentWakeupRequests.id, receipt.id));
      await heartbeat.resumeExecutionStageHandoffs();
      await Promise.all([heartbeat.resumeExecutionStageHandoffs({ companyId: f.companyId, issueId: f.issueId }),
        heartbeat.resumeExecutionStageHandoffs({ companyId: f.companyId, issueId: f.issueId })]);
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({ agentId: f.nextId, contextSnapshot: { source: "issue.execution_stage", wakeReason: reason } });
      const [consumed] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
      expect(consumed).toMatchObject({ status: "coalesced", runId: successors[0].id, requestedByActorId: f.outgoingId });
    });

  it.each(["pause", "changed_stage", "changed_round", "changed_owner", "cleanup_failed", "foreign_company", "caller_marker"])(
    "keeps admission gates intact: %s", async gate => {
      const f = await seed(), heartbeat = heartbeatService(db);
      await heartbeat.wakeup(f.nextId, gate === "caller_marker" ? { ...f.options, executionStageHandoff: undefined,
        payload: { ...f.options.payload, executionStageHandoff: true } } : f.options);
      if (gate === "caller_marker") {
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
        expect(wake.status).toBe("skipped");
        expect(wake.payload?.executionStageHandoff).toBeUndefined();
        return;
      }
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(),
        cleanupStatus: gate === "cleanup_failed" ? "failed" : null }).where(eq(environmentLeases.id, f.leaseId));
      if (gate === "changed_stage") await db.update(issues).set({ executionState: null }).where(eq(issues.id, f.issueId));
      if (gate === "changed_round") {
        const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
        await db.update(issues).set({ executionState: { ...issue.executionState, lastDecisionId: randomUUID() } }).where(eq(issues.id, f.issueId));
      }
      if (gate === "changed_owner") await db.update(issues).set({ assigneeAgentId: f.outgoingId }).where(eq(issues.id, f.issueId));
      if (gate === "pause") {
        const holdId = randomUUID();
        await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause", status: "active" });
        await db.insert(issueTreeHoldMembers).values({ companyId: f.companyId, holdId, issueId: f.issueId, depth: 0, issueTitle: "Review fixture", issueStatus: "in_review" });
      }
      await heartbeat.resumeExecutionStageHandoffs({ companyId: gate === "foreign_company" ? randomUUID() : f.companyId, issueId: f.issueId });
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
    });
});
