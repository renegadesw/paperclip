import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { resolveVectorIngressAuthConfig, vectorIngressRoutes } from "../routes/vector-ingress.js";
import type { VectorIngressService } from "../services/vector-ingress.js";
import {
  dbActiveBoardRun,
  prepareActiveVectorBoardRunAuthority,
  setActiveVectorBoardRunAuthority,
  VectorBoardRunAuthority,
} from "../services/vector-board-run-authority.js";
import { VectorProviderAuthorityBridge } from "../services/vector-provider-authority.js";
import {
  prepareActiveVectorToolRuntimeAccess,
  setActiveVectorToolAuthorityBridge,
  VECTOR_TOOL_CALLBACK_PATH,
  VectorToolAuthorityBridge,
} from "../services/vector-tool-authority.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Regression for the live t480 failure (2026-09-28): every Pi tool callback
// returned 401 "Agent token did not verify" because the global actor
// middleware treated the run-scoped capability bearer as an agent JWT and
// rejected it before the callback route ran. The app here is assembled in the
// same order as createApp: raw-body JSON for the Vector prefix, then the actor
// middleware, then the Vector ingress router.

const ingressSecret = "vector-tool-callback-ingress-secret-32-plus";
const bridgeSecret = "vector-tool-callback-bridge-secret-32-plus";
const ttlSeconds = 3600;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Vector tool callback through the app auth stack", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let conversationIssueId: string;
  let boardIssueId: string;
  let clock = Date.now();
  const now = () => clock;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-vector-tool-callback-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    conversationIssueId = randomUUID();
    boardIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Vector", issuePrefix: "VECT", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "FunkyDev", role: "engineer", status: "idle", adapterType: "pi_local" });
    await db.insert(issues).values([
      { id: conversationIssueId, companyId, title: "NexusLink conversation", status: "in_progress", priority: "medium", assigneeAgentId: agentId, originKind: "vector_ingress" },
      { id: boardIssueId, companyId, title: "Board chat", status: "todo", priority: "medium", assigneeAgentId: agentId },
    ]);
  }, 90_000);

  afterEach(() => {
    setActiveVectorToolAuthorityBridge(null);
    setActiveVectorBoardRunAuthority(null);
    clock = Date.now();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  function vectorOs() {
    return vi.fn(async (url: URL | string, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/inbound/paperclip/v1/board-runs/authority")) {
        return new Response(JSON.stringify({
          version: 1,
          providerAuthorityHandle: "board-provider-handle",
          authorityHandle: "board-tool-handle",
          authorityTools: ["memory_search"],
        }), { status: 200 });
      }
      if (target.endsWith("/inbound/paperclip/v1/tools/call")) {
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ result: { memories: [], runId: body.runId } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  }

  function stack(fetchImpl: typeof fetch) {
    const tool = new VectorToolAuthorityBridge(db, {
      endpoint: new URL("http://127.0.0.1:32160/inbound/paperclip/v1/tools/call"),
      callbackUrl: new URL(`http://127.0.0.1:3100${VECTOR_TOOL_CALLBACK_PATH}`),
      installationId: "t480-engineering",
      profile: "engineering",
      secret: bridgeSecret,
      allowedTools: ["memory_save", "memory_search"],
      ttlSeconds,
    }, fetchImpl, now);
    const provider = new VectorProviderAuthorityBridge(db, {
      endpoint: new URL("http://127.0.0.1:32160/inbound/paperclip/v1/providers/redeem"),
      installationId: "t480-engineering",
      profile: "engineering",
      secret: bridgeSecret,
      ttlSeconds,
    }, fetchImpl);
    const board = new VectorBoardRunAuthority({
      endpoint: new URL("http://127.0.0.1:32160/inbound/paperclip/v1/board-runs/authority"),
      installationId: "t480-engineering",
      profile: "engineering",
      secret: bridgeSecret,
    }, { activeRun: dbActiveBoardRun(db), provider, tool, fetchImpl });
    setActiveVectorToolAuthorityBridge(tool);
    setActiveVectorBoardRunAuthority(board);

    const auth = resolveVectorIngressAuthConfig({ PAPERCLIP_VECTOR_INGRESS_SECRET: ingressSecret }, {
      installationId: "t480-engineering",
      profile: "engineering",
      companyId,
      allowedAgentIds: [agentId],
    })!;
    const app = express();
    app.use("/api/internal/vector/v1", express.json({
      verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; },
    }));
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.use("/api/internal/vector/v1", vectorIngressRoutes(db, {
      auth,
      service: {} as VectorIngressService,
      toolAuthority: tool,
    }));
    app.use(errorHandler);
    return { app, tool };
  }

  const callback = (app: express.Express, bearerToken: string) =>
    request(app)
      .post(VECTOR_TOOL_CALLBACK_PATH)
      .set("authorization", `Bearer ${bearerToken}`)
      .send({ requestId: randomUUID(), tool: "memory_search", arguments: { query: "priorities" } });

  it("serves a NexusLink conversation run's tool call with the token its capability carries", async () => {
    const fetchImpl = vectorOs();
    const { app, tool } = stack(fetchImpl);
    const commentId = randomUUID();
    const pending = tool.registerPending({
      companyId,
      agentId,
      externalSessionId: "nexuslink-thread",
      issueId: conversationIssueId,
      commentId,
      authorityHandle: "conversation-tool-handle",
      allowedTools: ["memory_save", "memory_search"],
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: conversationIssueId, vectorToolAuthorityPending: pending },
    }).returning();

    // Exactly what heartbeat does before adapter.execute; the result becomes
    // Pi's authority.json capability.
    const access = await prepareActiveVectorToolRuntimeAccess({
      runId: run.id,
      companyId,
      agentId,
      issueId: conversationIssueId,
      pending,
    });
    expect(access).not.toBeNull();

    const res = await callback(app, access!.bearerToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ result: { memories: [], runId: run.id } });
    const sent = JSON.parse(String(fetchImpl.mock.calls.at(-1)![1].body));
    expect(sent).toMatchObject({ runId: run.id, conversationId: conversationIssueId, tool: "memory_search" });
    expect(sent.authorityHandle).toBe("conversation-tool-handle");
  });

  it("serves a board-chat run's tool call under board run authority", async () => {
    const fetchImpl = vectorOs();
    const { app } = stack(fetchImpl);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: boardIssueId },
    }).returning();

    const scope = { runId: run.id, companyId, agentId, issueId: boardIssueId };
    await expect(prepareActiveVectorBoardRunAuthority({
      ...scope,
      toolPending: undefined,
      providerPending: undefined,
      providerBound: undefined,
      required: true,
    })).resolves.toBe(true);
    const access = await prepareActiveVectorToolRuntimeAccess({ ...scope, pending: undefined });
    expect(access).not.toBeNull();

    const res = await callback(app, access!.bearerToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const sent = JSON.parse(String(fetchImpl.mock.calls.at(-1)![1].body));
    expect(sent).toMatchObject({ runId: run.id, conversationId: boardIssueId, authorityHandle: "board-tool-handle" });
  });

  it("still refuses a token no grant minted, and a grant past its TTL, from the bridge itself", async () => {
    const fetchImpl = vectorOs();
    const { app } = stack(fetchImpl);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: boardIssueId },
    }).returning();
    const scope = { runId: run.id, companyId, agentId, issueId: boardIssueId };
    await prepareActiveVectorBoardRunAuthority({ ...scope, toolPending: undefined, providerPending: undefined, providerBound: undefined, required: true });
    const access = (await prepareActiveVectorToolRuntimeAccess({ ...scope, pending: undefined }))!;
    const toolCallsBefore = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/tools/call")).length;

    const foreign = await callback(app, randomBytes(32).toString("base64url"));
    expect(foreign.status).toBe(401);
    expect(foreign.body.error).toBe("Vector tool callback token matches no live run grant");

    clock += (ttlSeconds + 1) * 1000;
    const expired = await callback(app, access.bearerToken);
    expect(expired.status).toBe(401);
    expect(expired.body.error).toBe(`Vector tool callback grant for run ${run.id} expired`);

    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/tools/call"))).toHaveLength(toolCallsBefore);
  });

  it("exempts only the exact callback path from actor authentication", async () => {
    const { app } = stack(vectorOs());
    const lookalike = await request(app)
      .post(`${VECTOR_TOOL_CALLBACK_PATH}/extra`)
      .set("authorization", `Bearer ${randomBytes(32).toString("base64url")}`)
      .send({});
    expect(lookalike.status).toBe(401);
    expect(lookalike.body.error).toContain("Agent token did not verify");
  });
});
