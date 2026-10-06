import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareActiveVectorBoardRunAuthority,
  resolveVectorBoardRunAuthorityConfig,
  setActiveVectorBoardRunAuthority,
  signVectorBoardRunAuthorityRequest,
  VECTOR_BOARD_EXTERNAL_SESSION_PREFIX,
  VectorBoardRunAuthority,
} from "../services/vector-board-run-authority.js";
import {
  prepareActiveVectorProviderRuntimeAccess,
  setActiveVectorProviderAuthorityBridge,
  signVectorProviderRedeem,
  VectorProviderAuthorityBridge,
  type VectorProviderAuthorityConfig,
} from "../services/vector-provider-authority.js";

const secret = "vector-board-run-authority-test-secret-32-plus";
const endpoint = "http://127.0.0.1:8431/inbound/paperclip/v1/board-runs/authority";
const providerConfig: VectorProviderAuthorityConfig = {
  endpoint: new URL("http://127.0.0.1:8431/inbound/paperclip/v1/providers/redeem"),
  installationId: "t480-engineering",
  profile: "engineering",
  secret,
  ttlSeconds: 7200,
};

function scope() {
  return { runId: randomUUID(), companyId: randomUUID(), agentId: randomUUID(), issueId: randomUUID() };
}

function grantResponse(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    version: 1,
    providerAuthorityHandle: "p".repeat(64),
    authorityHandle: "t".repeat(64),
    authorityTools: ["ask_user", "memory_recall", "todo_add"],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  setActiveVectorBoardRunAuthority(null);
  setActiveVectorProviderAuthorityBridge(null);
});

describe("Vector board run authority configuration", () => {
  it("is off unless the supervisor configured the engineering endpoint", () => {
    expect(resolveVectorBoardRunAuthorityConfig({}, providerConfig)).toBeNull();
    expect(() => resolveVectorBoardRunAuthorityConfig({ PAPERCLIP_VECTOR_BOARD_AUTHORITY_URL: endpoint }, null))
      .toThrow(/provider bridge/);
    for (const profile of ["standard", "staging", "production"]) {
      expect(() => resolveVectorBoardRunAuthorityConfig(
        { PAPERCLIP_VECTOR_BOARD_AUTHORITY_URL: endpoint },
        { ...providerConfig, profile },
      )).toThrow(/engineering/);
    }
    for (const url of [
      "http://localhost:8431/inbound/paperclip/v1/board-runs/authority",
      "https://127.0.0.1:8431/inbound/paperclip/v1/board-runs/authority",
      "http://127.0.0.1:8431/inbound/paperclip/v1/providers/redeem",
      "http://user:pw@127.0.0.1:8431/inbound/paperclip/v1/board-runs/authority",
    ]) {
      expect(() => resolveVectorBoardRunAuthorityConfig({ PAPERCLIP_VECTOR_BOARD_AUTHORITY_URL: url }, providerConfig))
        .toThrow(/literal loopback/);
    }
    expect(resolveVectorBoardRunAuthorityConfig({ PAPERCLIP_VECTOR_BOARD_AUTHORITY_URL: endpoint }, providerConfig))
      .toMatchObject({ installationId: "t480-engineering", profile: "engineering", secret });
  });

  it("signs under its own domain, distinct from provider redemption", () => {
    const rawBody = Buffer.from('{"version":1}');
    const signature = signVectorBoardRunAuthorityRequest({ secret, timestamp: "1790395200", rawBody });
    const canonical = [
      "vector-paperclip-board-run-authority/v1",
      "1790395200",
      "POST",
      "/inbound/paperclip/v1/board-runs/authority",
      createHash("sha256").update(rawBody).digest("hex"),
    ].join("\n");
    expect(signature).toBe(`v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`);
    expect(signature).not.toBe(signVectorProviderRedeem({ secret, timestamp: "1790395200", rawBody }));
  });
});

describe("Vector board run authority request", () => {
  const config = resolveVectorBoardRunAuthorityConfig({ PAPERCLIP_VECTOR_BOARD_AUTHORITY_URL: endpoint }, providerConfig)!;

  it("requests a grant for an active board run and binds provider and tool authority to it", async () => {
    const run = scope();
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = Buffer.from(init!.body as Buffer);
      const headers = init!.headers as Record<string, string>;
      expect(headers["x-paperclip-signature"]).toBe(signVectorBoardRunAuthorityRequest({
        secret,
        timestamp: headers["x-paperclip-timestamp"]!,
        rawBody: body,
      }));
      expect(JSON.parse(body.toString("utf8"))).toEqual({
        version: 1,
        installationId: "t480-engineering",
        profile: "engineering",
        companyId: run.companyId,
        agentId: run.agentId,
        issueId: run.issueId,
        runId: run.runId,
        externalSessionId: `${VECTOR_BOARD_EXTERNAL_SESSION_PREFIX}${run.issueId}`,
      });
      expect(init!.redirect).toBe("error");
      return grantResponse();
    });
    const provider = { hasRunGrant: vi.fn(() => false), bindRun: vi.fn(async () => {}) };
    const tool = { bindRun: vi.fn(async () => {}) };
    const authority = new VectorBoardRunAuthority(config, {
      activeRun: async (input) => input.runId === run.runId,
      provider,
      tool,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await authority.bind(run);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(provider.bindRun).toHaveBeenCalledWith({
      ...run,
      externalSessionId: `${VECTOR_BOARD_EXTERNAL_SESSION_PREFIX}${run.issueId}`,
      authorityHandle: "p".repeat(64),
    });
    expect(tool.bindRun).toHaveBeenCalledWith({
      ...run,
      externalSessionId: `${VECTOR_BOARD_EXTERNAL_SESSION_PREFIX}${run.issueId}`,
      authorityHandle: "t".repeat(64),
      allowedTools: ["ask_user", "memory_recall", "todo_add"],
    });

    provider.hasRunGrant.mockReturnValue(true);
    await authority.bind(run);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stays fail-closed when Vector OS refuses or the run is not an active board run", async () => {
    const provider = { hasRunGrant: () => false, bindRun: vi.fn(async () => {}) };
    const tool = { bindRun: vi.fn(async () => {}) };
    for (const status of [401, 403, 409, 400]) {
      const authority = new VectorBoardRunAuthority(config, {
        activeRun: async () => true,
        provider,
        tool,
        fetchImpl: (async () => new Response(JSON.stringify({ error: "authority_denied" }), { status })) as unknown as typeof fetch,
      });
      await expect(authority.bind(scope())).rejects.toMatchObject({
        status: 409,
        details: { code: "vector_provider_authority_unavailable" },
      });
    }
    const fetchImpl = vi.fn(async () => grantResponse());
    const inactive = new VectorBoardRunAuthority(config, {
      activeRun: async () => false,
      provider,
      tool,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(inactive.bind(scope())).rejects.toMatchObject({ details: { code: "vector_provider_authority_unavailable" } });
    expect(fetchImpl).not.toHaveBeenCalled();
    for (const bad of [
      { version: 2 },
      { providerAuthorityHandle: "" },
      { authorityHandle: 42 },
      { authorityTools: [] },
    ]) {
      const malformed = new VectorBoardRunAuthority(config, {
        activeRun: async () => true,
        provider,
        tool,
        fetchImpl: (async () => grantResponse(bad)) as unknown as typeof fetch,
      });
      await expect(malformed.bind(scope())).rejects.toMatchObject({ details: { code: "vector_provider_authority_unavailable" } });
    }
    expect(provider.bindRun).not.toHaveBeenCalled();
    expect(tool.bindRun).not.toHaveBeenCalled();
  });

  it("leaves Vector ingress runs and non-router runs untouched", async () => {
    const bind = vi.fn(async () => {});
    setActiveVectorBoardRunAuthority({ bind } as unknown as VectorBoardRunAuthority);
    const base = { ...scope(), toolPending: null, providerPending: null, providerBound: null, required: true };
    for (const input of [
      { ...base, providerPending: { version: 1 } },
      { ...base, toolPending: { version: 1 } },
      { ...base, providerBound: { version: 1 } },
      { ...base, required: false },
      { ...base, issueId: null },
    ]) {
      await expect(prepareActiveVectorBoardRunAuthority(input)).resolves.toBe(false);
    }
    expect(bind).not.toHaveBeenCalled();
    await expect(prepareActiveVectorBoardRunAuthority(base)).resolves.toBe(true);
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it("binds a board grant that the unchanged no-pending provider path then redeems", async () => {
    const run = scope();
    const redeemed: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const target = String(url);
      if (target === endpoint) return grantResponse();
      if (target.endsWith("/inbound/paperclip/v1/providers/redeem")) {
        redeemed.push(JSON.parse(Buffer.from(init!.body as Buffer).toString("utf8")));
        return new Response(JSON.stringify({
          version: 1,
          router_url: "http://127.0.0.1:8431/inbound/paperclip/v1/router",
          router_token: "vpr.opaque-parent-proxy-capability.cap",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }), { status: 200 });
      }
      if (target.endsWith("/api/router/runtime-catalog")) {
        return new Response(JSON.stringify({
          provider: "router",
          api: "anthropic-messages",
          models: [{ id: "Qwen3.8-Flash", context_window: 131072, max_tokens: 8192 }],
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${target}`);
    });
    // The DB write in bindRun is covered by the embedded-Postgres suite; here
    // the run row update is stubbed to "one active run matched".
    const db = {
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: run.runId }] }) }) }),
    } as never;
    const providerBridge = new VectorProviderAuthorityBridge(db, providerConfig, fetchImpl as unknown as typeof fetch);
    setActiveVectorProviderAuthorityBridge(providerBridge);
    setActiveVectorBoardRunAuthority(new VectorBoardRunAuthority(config, {
      activeRun: async () => true,
      provider: providerBridge,
      tool: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }));

    await expect(prepareActiveVectorBoardRunAuthority({
      ...run, toolPending: null, providerPending: null, providerBound: null, required: true,
    })).resolves.toBe(true);
    const access = await prepareActiveVectorProviderRuntimeAccess({
      ...run, pending: null, bound: null, required: true,
    });
    expect(access).toMatchObject({
      providerId: "router",
      baseUrl: "http://127.0.0.1:8431/inbound/paperclip/v1/router",
      apiKey: "vpr.opaque-parent-proxy-capability.cap",
    });
    expect(redeemed).toHaveLength(1);
    expect(redeemed[0]).toMatchObject({
      providerAuthorityHandle: "p".repeat(64),
      companyId: run.companyId,
      agentId: run.agentId,
      conversationId: run.issueId,
      runId: run.runId,
      // Pinned by vector-os ProviderSessionScope's golden test.
      sessionScope: createHash("sha256")
        .update("paperclip-vector-provider-session/v1\0")
        .update(run.companyId).update("\0")
        .update(run.agentId).update("\0")
        .update(`${VECTOR_BOARD_EXTERNAL_SESSION_PREFIX}${run.issueId}`)
        .digest("base64url"),
    });
  });

  it("keeps the no-pending path fail-closed when Vector OS refuses a board grant", async () => {
    const run = scope();
    const db = {
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: run.runId }] }) }) }),
    } as never;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "authority_denied" }), { status: 403 }));
    const providerBridge = new VectorProviderAuthorityBridge(db, providerConfig, fetchImpl as unknown as typeof fetch);
    setActiveVectorProviderAuthorityBridge(providerBridge);
    setActiveVectorBoardRunAuthority(new VectorBoardRunAuthority(config, {
      activeRun: async () => true,
      provider: providerBridge,
      tool: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }));
    await expect(prepareActiveVectorBoardRunAuthority({
      ...run, toolPending: null, providerPending: null, providerBound: null, required: true,
    })).rejects.toMatchObject({ status: 409, details: { code: "vector_provider_authority_unavailable" } });
    await expect(prepareActiveVectorProviderRuntimeAccess({
      ...run, pending: null, bound: null, required: true,
    })).rejects.toMatchObject({ status: 409, details: { code: "vector_provider_authority_unavailable" } });
  });
});
