import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  isVectorResearchRoutineIssue,
  settleVectorResearchRoutineIssue,
  vectorResearchIssueSettlement,
  vectorResearchRoutineIssueCondition,
  type VectorResearchIssueSettlementPort,
} from "./vector-research-issue-settlement.js";

function memoryPort(input: {
  run: Record<string, unknown> | null;
  issue?: { id: string; assigneeAgentId: string | null } | null;
  otherActiveRun?: boolean;
}) {
  const writes: Array<Record<string, unknown>> = [];
  const port: VectorResearchIssueSettlementPort = {
    getRun: async () => input.run as never,
    getOpenResearchIssue: async (_companyId, issueId) => (input.issue?.id === issueId ? input.issue : null),
    hasOtherActiveRun: async () => input.otherActiveRun ?? false,
    addComment: async (comment) => { writes.push({ kind: "comment", ...comment }); },
    setStatus: async (status) => { writes.push({ kind: "status", ...status }); },
  };
  return { port, writes };
}

function finishedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    agentId: randomUUID(),
    issueId: randomUUID(),
    status: "succeeded",
    error: null,
    errorCode: null,
    resultJson: { summary: "current_scout: 2 findings recorded; demand_daily: none." },
    ...overrides,
  };
}

describe("Vector research issue settlement outcome", () => {
  it("closes a succeeded run as done with its final summary, redacted and truncated", () => {
    const run = finishedRun();
    expect(vectorResearchIssueSettlement(run as never)).toEqual({
      status: "done",
      body: `Run ${run.id} finished.\n\ncurrent_scout: 2 findings recorded; demand_daily: none.`,
    });
    const leaky = vectorResearchIssueSettlement(finishedRun({
      resultJson: { summary: `Authorization: Bearer ${"s".repeat(40)}\n${"x".repeat(6000)}` },
    }) as never)!;
    expect(leaky.body).not.toContain("s".repeat(40));
    expect(leaky.body).toContain("[truncated]");
    expect(leaky.body.length).toBeLessThan(4200);
    expect(vectorResearchIssueSettlement(finishedRun({ resultJson: null }) as never)?.body)
      .toMatch(/finished without a final summary/);
    expect(vectorResearchIssueSettlement(finishedRun({ resultJson: { result: "Skipped: source not ready" } }) as never)?.body)
      .toContain("Skipped: source not ready");
  });

  it("blocks failed, cancelled, timed out and interrupted runs with the error code and message", () => {
    for (const status of ["failed", "cancelled", "timed_out", "interrupted"]) {
      const settlement = vectorResearchIssueSettlement(finishedRun({
        status,
        errorCode: "vector_provider_authority_unavailable",
        error: "Vector routine run authority was refused with status 403",
      }) as never)!;
      expect(settlement.status).toBe("blocked");
      expect(settlement.body).toContain("`vector_provider_authority_unavailable`");
      expect(settlement.body).toContain("refused with status 403");
    }
    expect(vectorResearchIssueSettlement(finishedRun({ status: "timed_out" }) as never)?.body).toContain("`timed_out`");
  });

  it("leaves runs that can still change the outcome alone", () => {
    for (const status of ["queued", "scheduled_retry", "running"]) {
      expect(vectorResearchIssueSettlement(finishedRun({ status }) as never)).toBeNull();
    }
  });
});

describe("Vector research issue settlement", () => {
  it("comments, then closes the research issue of the finished run", async () => {
    const run = finishedRun();
    const { port, writes } = memoryPort({ run, issue: { id: run.issueId, assigneeAgentId: run.agentId } });
    await expect(settleVectorResearchRoutineIssue(port, run.id)).resolves.toBe("done");
    expect(writes).toEqual([
      { kind: "comment", issueId: run.issueId, agentId: run.agentId, runId: run.id, body: expect.stringContaining("2 findings recorded") },
      { kind: "status", companyId: run.companyId, issueId: run.issueId, agentId: run.agentId, status: "done" },
    ]);
  });

  it("blocks the issue when the run failed", async () => {
    const run = finishedRun({ status: "failed", errorCode: "adapter_failed", error: "router unavailable" });
    const { port, writes } = memoryPort({ run, issue: { id: run.issueId as string, assigneeAgentId: run.agentId as string } });
    await expect(settleVectorResearchRoutineIssue(port, run.id as string)).resolves.toBe("blocked");
    expect(writes.at(-1)).toMatchObject({ kind: "status", status: "blocked" });
  });

  it("touches nothing for another issue, another agent, an open retry, an unfinished run, or a run without an issue", async () => {
    const run = finishedRun();
    for (const setup of [
      { run, issue: null },
      { run, issue: { id: run.issueId, assigneeAgentId: randomUUID() } },
      { run, issue: { id: run.issueId, assigneeAgentId: run.agentId }, otherActiveRun: true },
      { run: { ...run, status: "scheduled_retry" }, issue: { id: run.issueId, assigneeAgentId: run.agentId } },
      { run: { ...run, issueId: null }, issue: { id: run.issueId, assigneeAgentId: run.agentId } },
      { run: null },
    ]) {
      const { port, writes } = memoryPort(setup);
      await expect(settleVectorResearchRoutineIssue(port, run.id)).resolves.toBeNull();
      expect(writes).toEqual([]);
    }
  });
});

describe("Vector research routine issue predicate", () => {
  it("matches routine_execution issues of vector_research_workload routines in the issue's own company", () => {
    const query = new PgDialect().sqlToQuery(vectorResearchRoutineIssueCondition());
    expect(query.sql).toContain('"issues"."origin_kind" = $1');
    expect(query.sql).toContain('"routines"."company_id" = "issues"."company_id"');
    expect(query.sql).toContain('"routines"."id"::text = "issues"."origin_id"');
    expect(query.params).toEqual(["routine_execution", "vector_research_workload"]);
  });

  it("never queries for an issue that is not a routine execution", async () => {
    const db = { select: () => { throw new Error("must not query"); } } as never;
    await expect(isVectorResearchRoutineIssue(db, { id: randomUUID(), companyId: randomUUID(), originKind: "manual" }))
      .resolves.toBe(false);
  });
});
