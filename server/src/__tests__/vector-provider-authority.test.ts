import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  prepareActiveVectorProviderRuntimeAccess,
  resolveVectorProviderAuthorityConfig,
  setActiveVectorProviderAuthorityBridge,
  signVectorProviderRedeem,
  validateVectorProviderRedemption,
  VectorProviderAuthorityBridge,
} from "../services/vector-provider-authority.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const secret = "vector-provider-authority-test-secret-32-plus";
const routerToken = "header.payload.signature-with-32-bytes";

describe("Vector provider authority configuration", () => {
  it("is disabled by default and accepts only a complete loopback contract", () => {
    expect(resolveVectorProviderAuthorityConfig({})).toBeNull();
    expect(() => resolveVectorProviderAuthorityConfig({
      PAPERCLIP_VECTOR_PROVIDER_BRIDGE_URL: "http://localhost:8431/inbound/paperclip/v1/providers/redeem",
      PAPERCLIP_VECTOR_PROVIDER_BRIDGE_SECRET: secret,
      PAPERCLIP_VECTOR_INSTALLATION_ID: "t480-funkydev",
      PAPERCLIP_VECTOR_PROFILE: "engineering",
    })).toThrow(/literal loopback/);
    expect(resolveVectorProviderAuthorityConfig({
      PAPERCLIP_VECTOR_PROVIDER_BRIDGE_URL: "http://127.0.0.1:8431/inbound/paperclip/v1/providers/redeem",
      PAPERCLIP_VECTOR_PROVIDER_BRIDGE_SECRET: secret,
      PAPERCLIP_VECTOR_INSTALLATION_ID: "t480-funkydev",
      PAPERCLIP_VECTOR_PROFILE: "engineering",
    })).toMatchObject({ installationId: "t480-funkydev", profile: "engineering" });
  });

  it("signs the exact redeem body under a provider-specific HMAC domain", () => {
    const signature = signVectorProviderRedeem({
      secret,
      timestamp: "1790395200",
      rawBody: Buffer.from('{"version":1}'),
    });
    expect(signature).toMatch(/^v1=[a-f0-9]{64}$/);
    expect(signature).not.toBe(signVectorProviderRedeem({
      secret,
      timestamp: "1790395201",
      rawBody: Buffer.from('{"version":1}'),
    }));
  });

  it("fails closed when a persisted run marker survives its in-memory grant", async () => {
    setActiveVectorProviderAuthorityBridge(null);
    await expect(prepareActiveVectorProviderRuntimeAccess({
      runId: randomUUID(),
      companyId: randomUUID(),
      agentId: randomUUID(),
      issueId: randomUUID(),
      pending: null,
      bound: {
        version: 1,
        installationId: "t480-funkydev",
        profile: "engineering",
        handleSha256: "a".repeat(64),
        sessionScope: "scope",
      },
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "vector_provider_authority_unavailable" },
    });
  });

  it("fails closed when a Vector router run omits its provider grant", async () => {
    setActiveVectorProviderAuthorityBridge(null);
    await expect(prepareActiveVectorProviderRuntimeAccess({
      runId: randomUUID(),
      companyId: randomUUID(),
      agentId: randomUUID(),
      issueId: randomUUID(),
      pending: null,
      bound: null,
      required: true,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "vector_provider_authority_unavailable" },
    });
  });

  it("allows extended grants only through the exact literal-loopback parent proxy", () => {
    const now = Date.parse("2026-09-26T04:00:00Z");
    const expiresAt = new Date(now + 90 * 60_000).toISOString();
    expect(validateVectorProviderRedemption({
      version: 1,
      router_url: "http://127.0.0.1:8431/inbound/paperclip/v1/router",
      router_token: "opaque-parent-proxy-capability-32-bytes",
      expires_at: expiresAt,
    }, now)).toMatchObject({
      baseUrl: "http://127.0.0.1:8431/inbound/paperclip/v1/router",
    });
    for (const routerUrl of [
      "https://router.example.invalid",
      "http://127.0.0.1:8431/internal/paperclip/v1/not-router",
      "http://localhost:8431/inbound/paperclip/v1/router",
    ]) {
      expect(() => validateVectorProviderRedemption({
        version: 1,
        router_url: routerUrl,
        router_token: "opaque-parent-proxy-capability-32-bytes",
        expires_at: expiresAt,
      }, now)).toThrow(/invalid expiry/);
    }
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Vector provider run authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let issueId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-vector-provider-");
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

  it("redeems one run-bound handle and keeps credentials out of persisted context", async () => {
    const now = Date.parse("2026-09-26T04:00:00Z");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/inbound/paperclip/v1/providers/redeem")) {
        const rawBody = Buffer.from(String(init?.body));
        expect(init?.headers).toMatchObject({
          "x-paperclip-signature": signVectorProviderRedeem({
            secret,
            timestamp: String(Math.floor(now / 1000)),
            rawBody,
          }),
        });
        expect(JSON.parse(rawBody.toString("utf8"))).toMatchObject({
          installationId: "t480-funkydev",
          profile: "engineering",
          providerAuthorityHandle: "opaque-provider-handle",
          companyId,
          agentId,
        });
        return new Response(JSON.stringify({
          version: 1,
          router_url: "http://127.0.0.1:1250",
          router_token: routerToken,
          expires_at: new Date(now + 5 * 60_000).toISOString(),
        }), { status: 200 });
      }
      expect(String(input)).toBe("http://127.0.0.1:1250/api/router/runtime-catalog");
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${routerToken}` });
      return new Response(JSON.stringify({
        provider: "router",
        api: "anthropic-messages",
        models: [{
          id: "Qwen3.8-Flash",
          context_window: 131072,
          max_tokens: 32768,
          reasoning: true,
          input: ["text"],
        }],
      }), { status: 200 });
    });
    const bridge = new VectorProviderAuthorityBridge(db, {
      endpoint: new URL("http://127.0.0.1:8431/inbound/paperclip/v1/providers/redeem"),
      installationId: "t480-funkydev",
      profile: "engineering",
      secret,
      ttlSeconds: 3600,
    }, fetchMock as typeof fetch, () => now);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "queued",
      contextSnapshot: { issueId },
    }).returning();
    const pending = bridge.registerPending({
      companyId,
      agentId,
      externalSessionId: "tailchat-session",
      issueId,
      commentId: randomUUID(),
      authorityHandle: "opaque-provider-handle",
    });
    await bridge.bindPendingRun({ companyId, agentId, issueId, runId: run.id, pending });
    const access = await bridge.runtimeAccess({ runId: run.id, companyId, agentId, issueId });
    expect(access).toMatchObject({
      providerId: "router",
      baseUrl: "http://127.0.0.1:1250",
      apiKey: routerToken,
      models: [{ id: "Qwen3.8-Flash", contextWindow: 131072, maxTokens: 32768 }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await bridge.runtimeAccess({ runId: run.id, companyId, agentId, issueId });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const persisted = await db.select({ context: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((rows) => rows[0]?.context);
    expect(JSON.stringify(persisted)).not.toContain("opaque-provider-handle");
    expect(JSON.stringify(persisted)).not.toContain(routerToken);
  });

  it("re-asserts the persisted provider binding when a stale dispatch erased it", async () => {
    const bridge = new VectorProviderAuthorityBridge(db, {
      endpoint: new URL("http://127.0.0.1:8431/inbound/paperclip/v1/providers/redeem"),
      installationId: "t480-funkydev",
      profile: "engineering",
      secret,
      ttlSeconds: 3600,
    }, vi.fn() as unknown as typeof fetch);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "queued", contextSnapshot: { issueId },
    }).returning();
    const scope = { companyId, agentId, externalSessionId: "raced-provider-session", issueId };
    const pending = bridge.registerPending({ ...scope, commentId: randomUUID(), authorityHandle: "opaque-raced-provider" });
    await bridge.bindRun({ ...scope, runId: run.id, authorityHandle: "opaque-raced-provider" });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, vectorProviderAuthorityPending: pending } })
      .where(eq(heartbeatRuns.id, run.id));
    await bridge.bindPendingRun({ companyId, agentId, issueId, runId: run.id, pending });
    const persisted = await db.select({ context: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((rows) => rows[0]?.context as Record<string, unknown>);
    expect(persisted.vectorProviderAuthority).toMatchObject({ version: 1, handleSha256: pending.handleSha256 });
  });

  it("accepts a longer parent-proxy capability only on the exact loopback proxy path", async () => {
    const now = Date.parse("2026-09-26T04:00:00Z");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/inbound/paperclip/v1/providers/redeem")) {
        return new Response(JSON.stringify({
          version: 1,
          router_url: "http://127.0.0.1:8431/inbound/paperclip/v1/router",
          router_token: "opaque-parent-proxy-capability-32-bytes",
          expires_at: new Date(now + 90 * 60_000).toISOString(),
        }), { status: 200 });
      }
      expect(String(input)).toBe(
        "http://127.0.0.1:8431/inbound/paperclip/v1/router/api/router/runtime-catalog",
      );
      return new Response(JSON.stringify({
        provider: "router",
        api: "anthropic-messages",
        models: [{ id: "Qwen3.8-Flash", context_window: 131072, max_tokens: 32768 }],
      }), { status: 200 });
    });
    const bridge = new VectorProviderAuthorityBridge(db, {
      endpoint: new URL("http://127.0.0.1:8431/inbound/paperclip/v1/providers/redeem"),
      installationId: "t480-funkydev",
      profile: "engineering",
      secret,
      ttlSeconds: 7200,
    }, fetchMock as typeof fetch, () => now);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "queued",
      contextSnapshot: { issueId },
    }).returning();
    await bridge.bindRun({
      companyId,
      agentId,
      externalSessionId: "parent-proxy-session",
      issueId,
      runId: run.id,
      authorityHandle: "opaque-parent-proxy-handle",
    });
    await expect(bridge.runtimeAccess({ runId: run.id, companyId, agentId, issueId }))
      .resolves.toMatchObject({
        baseUrl: "http://127.0.0.1:8431/inbound/paperclip/v1/router",
        apiKey: "opaque-parent-proxy-capability-32-bytes",
      });
  });
});
