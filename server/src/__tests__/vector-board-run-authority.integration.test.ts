import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  dbActiveBoardRun,
  VECTOR_BOARD_EXTERNAL_SESSION_PREFIX,
  VectorBoardRunAuthority,
} from "../services/vector-board-run-authority.js";
import { VectorProviderAuthorityBridge } from "../services/vector-provider-authority.js";
import { VectorToolAuthorityBridge } from "../services/vector-tool-authority.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const secret = "vector-board-run-authority-test-secret-32-plus";
const boardEndpoint = new URL("http://127.0.0.1:8431/inbound/paperclip/v1/board-runs/authority");

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Vector board run authority (database)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let boardIssueId: string;
  let ingressIssueId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-vector-board-run-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    boardIssueId = randomUUID();
    ingressIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Vector", issuePrefix: "VECA", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "FunkyDev", role: "engineer", status: "idle", adapterType: "pi_local" });
    await db.insert(issues).values([
      { id: boardIssueId, companyId, title: "Board task", status: "todo", priority: "medium", assigneeAgentId: agentId },
      { id: ingressIssueId, companyId, title: "NexusLink conversation", status: "in_progress", priority: "medium", assigneeAgentId: agentId, originKind: "vector_ingress" },
    ]);
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  function authority(fetchImpl: typeof fetch) {
    const provider = new VectorProviderAuthorityBridge(db, {
      endpoint: new URL("http://127.0.0.1:8431/inbound/paperclip/v1/providers/redeem"),
      installationId: "t480-engineering",
      profile: "engineering",
      secret,
      ttlSeconds: 3600,
    }, fetchImpl);
    const tool = new VectorToolAuthorityBridge(db, {
      endpoint: new URL("http://127.0.0.1:8431/inbound/paperclip/v1/tools/call"),
      callbackUrl: new URL("http://127.0.0.1:3100/api/internal/vector/v1/tools/callback"),
      installationId: "t480-engineering",
      profile: "engineering",
      secret,
      allowedTools: ["ask_user", "memory_recall", "todo_add"],
      ttlSeconds: 3600,
    }, fetchImpl);
    const board = new VectorBoardRunAuthority({
      endpoint: boardEndpoint,
      installationId: "t480-engineering",
      profile: "engineering",
      secret,
    }, { activeRun: dbActiveBoardRun(db), provider, tool, fetchImpl });
    return { provider, tool, board };
  }

  const grant = () => new Response(JSON.stringify({
    version: 1,
    providerAuthorityHandle: "board-provider-handle",
    authorityHandle: "board-tool-handle",
    authorityTools: ["ask_user", "memory_recall", "todo_add"],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }), { status: 200 });

  it("binds a board task run to provider and tool authority without persisting handles", async () => {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", contextSnapshot: { issueId: boardIssueId } }).returning();
    const fetchImpl = vi.fn(async () => grant()) as unknown as typeof fetch;
    const { provider, tool, board } = authority(fetchImpl);
    await board.bind({ runId: run.id, companyId, agentId, issueId: boardIssueId });
    expect(provider.hasRunGrant(run.id)).toBe(true);
    expect(tool.runtimeAccess({ runId: run.id, companyId, agentId, issueId: boardIssueId })).toMatchObject({
      tools: ["ask_user", "memory_recall", "todo_add"],
    });
    const [persisted] = await db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const serialized = JSON.stringify(persisted.context);
    expect(serialized).not.toContain("board-provider-handle");
    expect(serialized).not.toContain("board-tool-handle");
    expect(persisted.context).toMatchObject({
      vectorProviderAuthority: { installationId: "t480-engineering", profile: "engineering" },
      vectorToolAuthority: { installationId: "t480-engineering", profile: "engineering" },
    });
    const body = JSON.parse(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body));
    expect(body.externalSessionId).toBe(`${VECTOR_BOARD_EXTERNAL_SESSION_PREFIX}${boardIssueId}`);
  });

  it("never asks Vector OS for a finished run, another agent's run, or a NexusLink conversation", async () => {
    const fetchImpl = vi.fn(async () => grant()) as unknown as typeof fetch;
    const { board } = authority(fetchImpl);
    const [finished] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId: boardIssueId } }).returning();
    const [ingress] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: ingressIssueId } }).returning();
    const [active] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: boardIssueId } }).returning();
    for (const scope of [
      { runId: finished.id, companyId, agentId, issueId: boardIssueId },
      { runId: ingress.id, companyId, agentId, issueId: ingressIssueId },
      { runId: active.id, companyId, agentId: randomUUID(), issueId: boardIssueId },
      { runId: active.id, companyId, agentId, issueId: ingressIssueId },
    ]) {
      await expect(board.bind(scope)).rejects.toMatchObject({ details: { code: "vector_provider_authority_unavailable" } });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
