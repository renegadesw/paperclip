import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  resolveVectorToolAuthorityConfig,
  signVectorToolRequest,
  vectorToolCallbackTimeoutMs,
  VectorToolAuthorityBridge,
} from "../services/vector-tool-authority.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const bridgeSecret = "paperclip-vector-tool-bridge-test-secret-32-plus";

function config() {
  return {
    endpoint: new URL("http://127.0.0.1:32160/inbound/paperclip/v1/tools/call"),
    callbackUrl: new URL("http://127.0.0.1:3100/api/internal/vector/v1/tools/callback"),
    installationId: "t480-funkydev",
    profile: "engineering",
    secret: bridgeSecret,
    allowedTools: ["fs.read", "fs.write"],
    ttlSeconds: 3600,
  } as const;
}

describe("Vector tool authority configuration", () => {
  it("allows the blocking ask_user continuation without widening ordinary tool timeouts", () => {
    expect(vectorToolCallbackTimeoutMs("ask_user")).toBe(15 * 60_000);
    expect(vectorToolCallbackTimeoutMs("todo_write")).toBe(30_000);
  });

  it("is disabled by default and requires a complete literal-loopback configuration", () => {
    expect(resolveVectorToolAuthorityConfig({})).toBeNull();
    expect(() => resolveVectorToolAuthorityConfig({
      PAPERCLIP_VECTOR_TOOL_BRIDGE_URL: "http://localhost:32160/inbound/paperclip/v1/tools/call",
      PAPERCLIP_VECTOR_TOOL_CALLBACK_URL: "http://127.0.0.1:3100/api/internal/vector/v1/tools/callback",
      PAPERCLIP_VECTOR_INSTALLATION_ID: "t480-funkydev",
      PAPERCLIP_VECTOR_PROFILE: "engineering",
      PAPERCLIP_VECTOR_TOOL_BRIDGE_SECRET: bridgeSecret,
      PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS: JSON.stringify([{
        profile: "engineering",
        path: "/opt/vector/extensions/fs.ts",
        sha256: "a".repeat(64),
        tools: ["fs.read"],
        permissions: { filesystem: false, shell: false },
        delivery: "callback",
      }]),
    })).toThrow(/literal loopback/);
    expect(() => resolveVectorToolAuthorityConfig({
      PAPERCLIP_VECTOR_TOOL_BRIDGE_URL: "http://127.0.0.1:32160/inbound/paperclip/v1/tools/call",
    })).toThrow(/requires bridge URL/);
  });

  it("derives the approved tool set only from packaged extension policy", () => {
    expect(resolveVectorToolAuthorityConfig({
      PAPERCLIP_VECTOR_TOOL_BRIDGE_URL: "http://127.0.0.1:32160/inbound/paperclip/v1/tools/call",
      PAPERCLIP_VECTOR_TOOL_CALLBACK_URL: "http://[::1]:3100/api/internal/vector/v1/tools/callback",
      PAPERCLIP_VECTOR_INSTALLATION_ID: "t480-funkydev",
      PAPERCLIP_VECTOR_PROFILE: "engineering",
      PAPERCLIP_VECTOR_TOOL_BRIDGE_SECRET: bridgeSecret,
      PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS: JSON.stringify([
        {
          profile: "engineering",
          path: "/opt/vector/extensions/vault.ts",
          sha256: "b".repeat(64),
          tools: ["vault_read"],
          permissions: { filesystem: true, shell: false },
          delivery: "local",
        },
        {
          profile: "engineering",
          path: "/opt/vector/extensions/vector-tool-bridge.ts",
          sha256: "a".repeat(64),
          tools: ["fs.write", "fs.read", "fs.read"],
          permissions: { filesystem: false, shell: false },
          delivery: "callback",
        },
      ]),
    })?.allowedTools).toEqual(["fs.read", "fs.write"]);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Vector run-scoped tool authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let issueId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-vector-tools-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Vector",
      issuePrefix: "VEC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "FunkyDev",
      role: "assistant",
      status: "idle",
      adapterType: "pi_local",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Conversation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function createRun() {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "queued",
      contextSnapshot: { issueId },
    }).returning();
    return run;
  }

  it("binds one opaque handle to one run and rejects cross-session rebinding", async () => {
    const run = await createRun();
    const bridge = new VectorToolAuthorityBridge(db, config(), vi.fn());
    await bridge.bindRun({
      companyId,
      agentId,
      externalSessionId: "browser-session-a",
      issueId,
      runId: run.id,
      authorityHandle: "opaque-authority-a",
    });
    const access = bridge.runtimeAccess({ runId: run.id, companyId, agentId, issueId });
    expect(access?.tools).toEqual(["fs.read", "fs.write"]);
    expect(access?.bearerToken).not.toContain("opaque-authority-a");
    expect(bridge.runtimeAccess({ runId: randomUUID(), companyId, agentId, issueId })).toBeNull();
    const persisted = await db.select({ context: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((rows) => rows[0]?.context);
    expect(persisted).toMatchObject({
      vectorToolAuthority: {
        version: 1,
        installationId: "t480-funkydev",
        profile: "engineering",
        sessionScope: expect.any(String),
        handleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const restartedBridge = new VectorToolAuthorityBridge(db, config(), vi.fn());
    expect(restartedBridge.runtimeAccess({ runId: run.id, companyId, agentId, issueId })).toBeNull();
    await expect(bridge.bindRun({
      companyId,
      agentId,
      externalSessionId: "browser-session-b",
      issueId,
      runId: run.id,
      authorityHandle: "opaque-authority-b",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "vector_tool_authority_scope_conflict" },
    });
  });

  it("exposes only the per-run subset admitted by the installed profile", async () => {
    const run = await createRun();
    const bridge = new VectorToolAuthorityBridge(db, config(), vi.fn());
    await bridge.bindRun({
      companyId,
      agentId,
      externalSessionId: "browser-session-narrow",
      issueId,
      runId: run.id,
      authorityHandle: "opaque-authority-narrow",
      allowedTools: ["fs.read"],
    });
    expect(bridge.runtimeAccess({ runId: run.id, companyId, agentId, issueId })?.tools)
      .toEqual(["fs.read"]);
    await expect(bridge.bindRun({
      companyId,
      agentId,
      externalSessionId: "browser-session-wide",
      issueId,
      runId: (await createRun()).id,
      authorityHandle: "opaque-authority-wide",
      allowedTools: ["fs.delete"],
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "vector_tool_not_approved" },
    });
  });

  it("consumes pending authority before adapter dispatch and fails closed after restart", async () => {
    const run = await createRun();
    const bridge = new VectorToolAuthorityBridge(db, config(), vi.fn());
    const descriptor = bridge.registerPending({
      companyId,
      agentId,
      externalSessionId: "browser-session-pending",
      issueId,
      commentId: randomUUID(),
      authorityHandle: "opaque-pending-handle",
    });
    expect(descriptor).toMatchObject({
      version: 1,
      handleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sessionScope: expect.any(String),
      commentId: expect.any(String),
    });
    expect(JSON.stringify(descriptor)).not.toContain("opaque-pending-handle");

    let releaseBind!: () => void;
    let bindEntered!: () => void;
    const entered = new Promise<void>((resolve) => { bindEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseBind = resolve; });
    const originalBind = bridge.bindRun.bind(bridge);
    vi.spyOn(bridge, "bindRun").mockImplementation(async (input) => {
      bindEntered();
      await release;
      return originalBind(input);
    });
    let adapterStarted = false;
    const dispatch = (async () => {
      const access = await bridge.bindPendingRun({ companyId, agentId, issueId, runId: run.id, pending: descriptor });
      adapterStarted = true;
      return access;
    })();
    await entered;
    expect(adapterStarted).toBe(false);
    releaseBind();
    const firstAccess = await dispatch;
    expect(firstAccess).toMatchObject({ tools: ["fs.read", "fs.write"] });
    expect(adapterStarted).toBe(true);

    // Heartbeat/provider retries retain the pending descriptor in the durable
    // run snapshot. In the same process they must reach the adapter with the
    // exact original runtime grant rather than attempting to consume it again.
    let retryAdapterAccess: typeof firstAccess | null = null;
    retryAdapterAccess = await bridge.bindPendingRun({
      companyId,
      agentId,
      issueId,
      runId: run.id,
      pending: descriptor,
    });
    expect(retryAdapterAccess).toEqual(firstAccess);

    const secondRun = await createRun();
    const pendingBeforeRestart = bridge.registerPending({
      companyId,
      agentId,
      externalSessionId: "browser-session-restart",
      issueId,
      commentId: randomUUID(),
      authorityHandle: "opaque-restart-handle",
    });
    const restarted = new VectorToolAuthorityBridge(db, config(), vi.fn());
    await expect(restarted.bindPendingRun({
      companyId,
      agentId,
      issueId,
      runId: secondRun.id,
      pending: pendingBeforeRestart,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "vector_tool_authority_pending_missing" },
    });
  });

  it("proxies exact signed scope, rejects unknown tools and rejects replay", async () => {
    const run = await createRun();
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const rawBody = Buffer.from(init?.body as Uint8Array);
      const timestamp = String((init?.headers as Record<string, string>)["x-paperclip-timestamp"]);
      expect((init?.headers as Record<string, string>)["x-paperclip-signature"]).toBe(
        signVectorToolRequest({ secret: bridgeSecret, timestamp, rawBody }),
      );
      const body = JSON.parse(rawBody.toString("utf8"));
      expect(body).toMatchObject({
        installationId: "t480-funkydev",
        profile: "engineering",
        companyId,
        agentId,
        conversationId: issueId,
        runId: run.id,
        authorityHandle: "opaque-handle",
        tool: "fs.read",
      });
      expect(body).not.toHaveProperty("bearerToken");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const bridge = new VectorToolAuthorityBridge(db, config(), fetchMock as typeof fetch, () => 1_700_000_000_000);
    await bridge.bindRun({
      companyId,
      agentId,
      externalSessionId: "browser-session",
      issueId,
      runId: run.id,
      authorityHandle: "opaque-handle",
    });
    const token = bridge.runtimeAccess({ runId: run.id, companyId, agentId, issueId })!.bearerToken;
    const requestId = randomUUID();
    await expect(bridge.call({
      bearerToken: token,
      requestId,
      tool: "fs.delete",
      arguments: {},
    })).rejects.toMatchObject({ status: 422, details: { code: "vector_tool_not_approved" } });
    await expect(bridge.call({
      bearerToken: token,
      requestId,
      tool: "fs.read",
      arguments: { path: "README.md" },
    })).resolves.toMatchObject({ status: 200 });
    await expect(bridge.call({
      bearerToken: token,
      requestId,
      tool: "fs.read",
      arguments: { path: "README.md" },
    })).rejects.toMatchObject({ status: 409, details: { code: "vector_tool_replay" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a callback after the bound run becomes terminal", async () => {
    const run = await createRun();
    const bridge = new VectorToolAuthorityBridge(db, config(), vi.fn());
    await bridge.bindRun({
      companyId,
      agentId,
      externalSessionId: "terminal-session",
      issueId,
      runId: run.id,
      authorityHandle: "terminal-handle",
    });
    const token = bridge.runtimeAccess({ runId: run.id, companyId, agentId, issueId })!.bearerToken;
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    await expect(bridge.call({
      bearerToken: token,
      requestId: randomUUID(),
      tool: "fs.read",
      arguments: {},
    })).rejects.toMatchObject({ status: 409, details: { code: "vector_tool_run_inactive" } });
  });

  it("treats an ambiguous transport failure as at-most-once", async () => {
    const run = await createRun();
    const fetchMock = vi.fn(async () => {
      throw new Error("connection reset after write");
    });
    const bridge = new VectorToolAuthorityBridge(db, config(), fetchMock as typeof fetch);
    await bridge.bindRun({
      companyId,
      agentId,
      externalSessionId: "ambiguous-session",
      issueId,
      runId: run.id,
      authorityHandle: "ambiguous-handle",
    });
    const token = bridge.runtimeAccess({ runId: run.id, companyId, agentId, issueId })!.bearerToken;
    const requestId = randomUUID();
    await expect(bridge.call({
      bearerToken: token,
      requestId,
      tool: "fs.write",
      arguments: { path: "README.md", content: "changed" },
    })).rejects.toThrow("connection reset after write");
    await expect(bridge.call({
      bearerToken: token,
      requestId,
      tool: "fs.write",
      arguments: { path: "README.md", content: "changed" },
    })).rejects.toMatchObject({ status: 409, details: { code: "vector_tool_replay" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
