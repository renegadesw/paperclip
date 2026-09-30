import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { heartbeatRuns, issues, routines, type Db } from "@paperclipai/db";
import { redactSensitiveText } from "../redaction.js";
import { VECTOR_RESEARCH_ROUTINE_ORIGIN_KIND } from "./vector-routine-run-authority.js";

// Funky Scout and Funky Advisor run without Paperclip issue tools, so they
// cannot close the routine issue they were woken for. Paperclip settles it
// from the run outcome instead, at run finalization: a research routine issue
// never stays open after its run, and generic stranded-issue recovery (which
// would re-wake or escalate an open assigned issue) never applies to it.

const ROUTINE_EXECUTION_ORIGIN_KIND = "routine_execution";
const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;
const FAILED_RUN_STATUSES = new Set(["failed", "cancelled", "timed_out", "interrupted"]);
const MAX_SUMMARY_CHARS = 4000;
const MAX_ERROR_CHARS = 1000;

/**
 * SQL predicate: the issue is a routine_execution issue of a Vector research
 * routine. Recovery excludes these explicitly; the routine lookup is by the
 * issue's own company, so a lookalike origin in another company never matches.
 */
export function vectorResearchRoutineIssueCondition(issueTable: typeof issues = issues) {
  return sql`(${issueTable.originKind} = ${ROUTINE_EXECUTION_ORIGIN_KIND} and exists (
    select 1 from ${routines}
    where ${routines.companyId} = ${issueTable.companyId}
      and ${routines.id}::text = ${issueTable.originId}
      and ${routines.originKind} = ${VECTOR_RESEARCH_ROUTINE_ORIGIN_KIND}
  ))`;
}

export async function isVectorResearchRoutineIssue(
  db: Db,
  issue: { id: string; companyId: string; originKind: string | null },
): Promise<boolean> {
  if (issue.originKind !== ROUTINE_EXECUTION_ORIGIN_KIND) return false;
  const [row] = await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId), vectorResearchRoutineIssueCondition()))
    .limit(1);
  return Boolean(row);
}

type SettlementRun = {
  id: string;
  status: string;
  error: string | null;
  errorCode: string | null;
  resultJson: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}\n\n[truncated]`;
}

/**
 * The issue outcome for a finished run, or null while the run (or a retry of
 * it) can still change the outcome. Text is redacted before truncation so a
 * secret split by the cut cannot survive.
 */
export function vectorResearchIssueSettlement(run: SettlementRun): { status: "done" | "blocked"; body: string } | null {
  if (run.status === "succeeded") {
    const result = record(run.resultJson);
    const summary = text(result.summary) ?? text(result.result) ?? text(result.message);
    return {
      status: "done",
      body: summary
        ? `Run ${run.id} finished.\n\n${truncate(redactSensitiveText(summary), MAX_SUMMARY_CHARS)}`
        : `Run ${run.id} finished without a final summary.`,
    };
  }
  if (!FAILED_RUN_STATUSES.has(run.status)) return null;
  const code = text(run.errorCode) ?? run.status;
  const message = text(run.error);
  return {
    status: "blocked",
    body: [
      `Run ${run.id} ${run.status.replace("_", " ")}: \`${code}\`.`,
      message ? truncate(redactSensitiveText(message), MAX_ERROR_CHARS) : null,
      "Unblock this issue or run the routine again from Paperclip to retry.",
    ].filter(Boolean).join("\n\n"),
  };
}

export interface VectorResearchIssueSettlementPort {
  getRun(runId: string): Promise<(SettlementRun & { companyId: string; agentId: string; issueId: string | null }) | null>;
  /** The open research routine issue the run was for, or null for any other issue. */
  getOpenResearchIssue(companyId: string, issueId: string): Promise<{ id: string; assigneeAgentId: string | null } | null>;
  hasOtherActiveRun(input: { companyId: string; issueId: string; runId: string }): Promise<boolean>;
  addComment(input: { issueId: string; agentId: string; runId: string; body: string }): Promise<void>;
  setStatus(input: { companyId: string; issueId: string; agentId: string; status: "done" | "blocked" }): Promise<void>;
}

export function dbVectorResearchIssueSettlementPort(
  db: Db,
  issueWrites: Pick<VectorResearchIssueSettlementPort, "addComment" | "setStatus">,
): VectorResearchIssueSettlementPort {
  return {
    getRun: (runId) => db.select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
      resultJson: heartbeatRuns.resultJson,
      issueId: sql<string | null>`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.nativeIssueId}::text)`,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null),
    getOpenResearchIssue: (companyId, issueId) => db.select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(
        eq(issues.id, issueId),
        eq(issues.companyId, companyId),
        inArray(issues.status, [...OPEN_ISSUE_STATUSES]),
        vectorResearchRoutineIssueCondition(),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    hasOtherActiveRun: ({ companyId, issueId, runId }) => db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        ne(heartbeatRuns.id, runId),
        inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
        sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.nativeIssueId}::text) = ${issueId}`,
      ))
      .limit(1)
      .then((rows) => rows.length > 0),
    ...issueWrites,
  };
}

/**
 * Settles the research routine issue of one finished run: succeeded -> done
 * with the run's final summary, failed/cancelled/timed out/interrupted ->
 * blocked with the error. Any other run or issue is left untouched. Returns
 * the status written, or null when nothing was settled.
 */
export async function settleVectorResearchRoutineIssue(
  port: VectorResearchIssueSettlementPort,
  runId: string,
): Promise<"done" | "blocked" | null> {
  const run = await port.getRun(runId);
  if (!run?.issueId) return null;
  const settlement = vectorResearchIssueSettlement(run);
  if (!settlement) return null;
  const issue = await port.getOpenResearchIssue(run.companyId, run.issueId);
  if (!issue || issue.assigneeAgentId !== run.agentId) return null;
  // A queued retry or a newer run still owns the outcome.
  if (await port.hasOtherActiveRun({ companyId: run.companyId, issueId: issue.id, runId: run.id })) return null;
  // Comment first: the status change is the last write, so a closed issue
  // always carries the reason it was closed.
  await port.addComment({ issueId: issue.id, agentId: run.agentId, runId: run.id, body: settlement.body });
  await port.setStatus({ companyId: run.companyId, issueId: issue.id, agentId: run.agentId, status: settlement.status });
  return settlement.status;
}
