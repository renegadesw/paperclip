import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signVectorBoardRunAuthorityRequest } from "../services/vector-board-run-authority.js";
import {
  prepareActiveVectorProviderRuntimeAccess,
  setActiveVectorProviderAuthorityBridge,
  VectorProviderAuthorityBridge,
  type VectorProviderAuthorityConfig,
} from "../services/vector-provider-authority.js";
import {
  prepareActiveVectorRoutineRunAuthority,
  resolveVectorRoutineRunAuthorityConfig,
  setActiveVectorRoutineRunAuthority,
  signVectorRoutineRunAuthorityRequest,
  VECTOR_ROUTINE_EXTERNAL_SESSION_PREFIX,
  VectorRoutineRunAuthority,
  vectorResearchWorkloadToolSurface,
} from "../services/vector-routine-run-authority.js";
import type { VectorToolAuthorityConfig } from "../services/vector-tool-authority.js";

const secret = "vector-routine-run-authority-test-secret-32-plus";
const endpoint = "http://127.0.0.1:8431/inbound/paperclip/v1/routine-runs/authority";
const scoutTools = ["research_ready_slices", "research_record_finding", "research_slice_payload"];
const providerConfig: VectorProviderAuthorityConfig = {
  endpoint: new URL("http://127.0.0.1:8431/inbound/paperclip/v1/providers/redeem"),
  installationId: "prod1-production",
  profile: "production",
  secret,
  ttlSeconds: 7200,
};
const toolConfig: VectorToolAuthorityConfig = {
  endpoint: new URL("http://127.0.0.1:8431/inbound/paperclip/v1/tools/call"),
  callbackUrl: new URL("http://127.0.0.1:3100/api/internal/vector/v1/tools/callback"),
  installationId: "prod1-production",
  profile: "production",
  secret,
  allowedTools: [...scoutTools, "pull_check_evidence", "query_data"],
  ttlSeconds: 7200,
};

function scope(workloadKey = "current_scout") {
  return { runId: randomUUID(), companyId: randomUUID(), agentId: randomUUID(), issueId: randomUUID(), workloadKey };
}

function grantResponse(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    version: 1,
    providerAuthorityHandle: "p".repeat(64),
    authorityHandle: "t".repeat(64),
    authorityTools: scoutTools,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function provisionedMetadata(overrides: { installationId?: string; profile?: string; contracts?: unknown[] } = {}) {
  return {
    vectorProvisioning: {
      schemaVersion: 1,
      installationId: overrides.installationId ?? "prod1-production",
      profile: overrides.profile ?? "production",
      manifestRevision: 3,
    },
    vectorWorkloads: {
      schemaVersion: 1,
      keys: ["current_scout"],
      contracts: overrides.contracts ?? [{
        key: "current_scout",
        kind: "research_task",
        executionShape: "single_shot",
        role: "funky-scout",
        toolSurface: scoutTools,
        modelPolicy: null,
        runtimeAuthority: "paperclip",
      }],
    },
  };
}

afterEach(() => {
  setActiveVectorRoutineRunAuthority(null);
  setActiveVectorProviderAuthorityBridge(null);
});

describe("Vector routine run authority configuration", () => {
  it("is off unless the supervisor configured it, and only on Funky server profiles with both bridges", () => {
    expect(resolveVectorRoutineRunAuthorityConfig({}, providerConfig, toolConfig)).toBeNull();
    const env = { PAPERCLIP_VECTOR_ROUTINE_AUTHORITY_URL: endpoint };
    expect(() => resolveVectorRoutineRunAuthorityConfig(env, null, toolConfig)).toThrow(/provider and tool bridges/);
    expect(() => resolveVectorRoutineRunAuthorityConfig(env, providerConfig, null)).toThrow(/provider and tool bridges/);
    for (const profile of ["engineering", "standard"]) {
      expect(() => resolveVectorRoutineRunAuthorityConfig(env, { ...providerConfig, profile }, toolConfig))
        .toThrow(/Funky server/);
    }
    for (const url of [
      "http://localhost:8431/inbound/paperclip/v1/routine-runs/authority",
      "https://127.0.0.1:8431/inbound/paperclip/v1/routine-runs/authority",
      "http://127.0.0.1:8431/inbound/paperclip/v1/board-runs/authority",
      "http://user:pw@127.0.0.1:8431/inbound/paperclip/v1/routine-runs/authority",
      "http://127.0.0.1:8431/inbound/paperclip/v1/routine-runs/authority?x=1",
    ]) {
      expect(() => resolveVectorRoutineRunAuthorityConfig({ PAPERCLIP_VECTOR_ROUTINE_AUTHORITY_URL: url }, providerConfig, toolConfig))
        .toThrow(/literal loopback/);
    }
    for (const profile of ["staging", "production"]) {
      expect(resolveVectorRoutineRunAuthorityConfig(env, { ...providerConfig, profile }, toolConfig))
        .toMatchObject({ installationId: "prod1-production", profile, secret });
    }
  });

  it("signs under its own domain, distinct from board-run authority", () => {
    const rawBody = Buffer.from('{"version":1}');
    const signature = signVectorRoutineRunAuthorityRequest({ secret, timestamp: "1790395200", rawBody });
    const canonical = [
      "vector-paperclip-routine-run-authority/v1",
      "1790395200",
      "POST",
      "/inbound/paperclip/v1/routine-runs/authority",
      createHash("sha256").update(rawBody).digest("hex"),
    ].join("\n");
    expect(signature).toBe(`v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`);
    expect(signature).not.toBe(signVectorBoardRunAuthorityRequest({ secret, timestamp: "1790395200", rawBody }));
  });
});

describe("Vector research workload tool surface", () => {
  const target = { installationId: "prod1-production", profile: "production", workloadKey: "current_scout" };

  it("reads the sealed Paperclip-owned contract of this installation", () => {
    expect(vectorResearchWorkloadToolSurface(provisionedMetadata(), target)).toEqual(scoutTools);
  });

  it("fails closed for another installation, an unknown workload, the lease path, or no tools", () => {
    for (const metadata of [
      null,
      provisionedMetadata({ installationId: "stg1-staging" }),
      provisionedMetadata({ profile: "staging" }),
      provisionedMetadata({ contracts: [] }),
      provisionedMetadata({ contracts: [{ key: "current_scout", toolSurface: scoutTools, runtimeAuthority: "vector_lease_triple" }] }),
      provisionedMetadata({ contracts: [{ key: "current_scout", toolSurface: [], runtimeAuthority: "paperclip" }] }),
      provisionedMetadata({ contracts: [{ key: "current_scout", toolSurface: [42], runtimeAuthority: "paperclip" }] }),
    ]) {
      expect(() => vectorResearchWorkloadToolSurface(metadata, target)).toThrow(
        expect.objectContaining({ status: 409, details: { code: "vector_provider_authority_unavailable" } }),
      );
    }
  });
});

describe("Vector routine run authority request", () => {
  const config = resolveVectorRoutineRunAuthorityConfig(
    { PAPERCLIP_VECTOR_ROUTINE_AUTHORITY_URL: endpoint },
    providerConfig,
    toolConfig,
  )!;

  it("requests a grant for an active research routine run and binds provider and tool authority to it", async () => {
    const run = scope();
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = Buffer.from(init!.body as Buffer);
      const headers = init!.headers as Record<string, string>;
      expect(headers["x-paperclip-signature"]).toBe(signVectorRoutineRunAuthorityRequest({
        secret,
        timestamp: headers["x-paperclip-timestamp"]!,
        rawBody: body,
      }));
      expect(JSON.parse(body.toString("utf8"))).toEqual({
        version: 1,
        installationId: "prod1-production",
        profile: "production",
        companyId: run.companyId,
        agentId: run.agentId,
        issueId: run.issueId,
        runId: run.runId,
        workloadKey: "current_scout",
        externalSessionId: `paperclip-routine:${run.issueId}`,
      });
      expect(init!.redirect).toBe("error");
      return grantResponse({ authorityTools: ["research_slice_payload", "research_ready_slices", "research_record_finding"] });
    });
    const provider = { hasRunGrant: vi.fn(() => false), bindRun: vi.fn(async () => {}) };
    const tool = { bindRun: vi.fn(async () => {}) };
    const activeRun = vi.fn(async (input: ReturnType<typeof scope>) => input.runId === run.runId && input.workloadKey === "current_scout");
    const authority = new VectorRoutineRunAuthority(config, {
      activeRun,
      provider,
      tool,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await authority.bind({ ...run, toolSurface: scoutTools });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const bound = { runId: run.runId, companyId: run.companyId, agentId: run.agentId, issueId: run.issueId };
    expect(provider.bindRun).toHaveBeenCalledWith({
      ...bound,
      externalSessionId: `${VECTOR_ROUTINE_EXTERNAL_SESSION_PREFIX}${run.issueId}`,
      authorityHandle: "p".repeat(64),
    });
    expect(tool.bindRun).toHaveBeenCalledWith({
      ...bound,
      externalSessionId: `${VECTOR_ROUTINE_EXTERNAL_SESSION_PREFIX}${run.issueId}`,
      authorityHandle: "t".repeat(64),
      allowedTools: scoutTools,
    });

    provider.hasRunGrant.mockReturnValue(true);
    await authority.bind({ ...run, toolSurface: scoutTools });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts a narrower grant but refuses any tool outside the declared surface, binding nothing", async () => {
    const provider = { hasRunGrant: () => false, bindRun: vi.fn(async () => {}) };
    const tool = { bindRun: vi.fn(async () => {}) };
    const narrow = new VectorRoutineRunAuthority(config, {
      activeRun: async () => true,
      provider,
      tool,
      fetchImpl: (async () => grantResponse({ authorityTools: ["research_ready_slices"] })) as unknown as typeof fetch,
    });
    await narrow.bind({ ...scope(), toolSurface: scoutTools });
    expect(tool.bindRun).toHaveBeenCalledWith(expect.objectContaining({ allowedTools: ["research_ready_slices"] }));

    provider.bindRun.mockClear();
    tool.bindRun.mockClear();
    const wide = new VectorRoutineRunAuthority(config, {
      activeRun: async () => true,
      provider,
      tool,
      fetchImpl: (async () => grantResponse({ authorityTools: [...scoutTools, "query_data"] })) as unknown as typeof fetch,
    });
    await expect(wide.bind({ ...scope(), toolSurface: scoutTools })).rejects.toMatchObject({
      status: 409,
      details: { code: "vector_provider_authority_unavailable" },
      message: expect.stringContaining("outside the current_scout tool surface"),
    });
    expect(provider.bindRun).not.toHaveBeenCalled();
    expect(tool.bindRun).not.toHaveBeenCalled();
  });

  it("stays fail-closed when Vector OS refuses, the response is malformed, or the run is not an active research run", async () => {
    const provider = { hasRunGrant: () => false, bindRun: vi.fn(async () => {}) };
    const tool = { bindRun: vi.fn(async () => {}) };
    for (const status of [401, 403, 409, 400, 500]) {
      const authority = new VectorRoutineRunAuthority(config, {
        activeRun: async () => true,
        provider,
        tool,
        fetchImpl: (async () => new Response(JSON.stringify({ error: "authority_denied" }), { status })) as unknown as typeof fetch,
      });
      await expect(authority.bind({ ...scope(), toolSurface: scoutTools })).rejects.toMatchObject({
        status: 409,
        details: { code: "vector_provider_authority_unavailable" },
      });
    }
    for (const bad of [
      { version: 2 },
      { providerAuthorityHandle: "" },
      { authorityHandle: 42 },
      { authorityTools: [] },
      { authorityTools: [""] },
    ]) {
      const malformed = new VectorRoutineRunAuthority(config, {
        activeRun: async () => true,
        provider,
        tool,
        fetchImpl: (async () => grantResponse(bad)) as unknown as typeof fetch,
      });
      await expect(malformed.bind({ ...scope(), toolSurface: scoutTools }))
        .rejects.toMatchObject({ details: { code: "vector_provider_authority_unavailable" } });
    }
    const fetchImpl = vi.fn(async () => grantResponse());
    const inactive = new VectorRoutineRunAuthority(config, {
      activeRun: async () => false,
      provider,
      tool,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(inactive.bind({ ...scope(), toolSurface: scoutTools }))
      .rejects.toMatchObject({ details: { code: "vector_provider_authority_unavailable" } });
    for (const invalid of [
      { ...scope(), runId: "not-a-uuid", toolSurface: scoutTools },
      { ...scope("Not A Key"), toolSurface: scoutTools },
      { ...scope(), toolSurface: [] },
    ]) {
      const active = new VectorRoutineRunAuthority(config, {
        activeRun: async () => true,
        provider,
        tool,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await expect(active.bind(invalid)).rejects.toMatchObject({ details: { code: "vector_provider_authority_unavailable" } });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(provider.bindRun).not.toHaveBeenCalled();
    expect(tool.bindRun).not.toHaveBeenCalled();
  });
});

describe("Vector routine run authority heartbeat seam", () => {
  function seamInput(overrides: Record<string, unknown> = {}) {
    const run = scope();
    return {
      runId: run.runId,
      companyId: run.companyId,
      agentId: run.agentId,
      agentMetadata: provisionedMetadata(),
      issueId: run.issueId,
      workload: { routineId: randomUUID(), workloadKey: "current_scout", assigneeAgentId: run.agentId },
      toolPending: null,
      providerPending: null,
      providerBound: null,
      ...overrides,
    };
  }

  function activeAuthority(bind = vi.fn(async () => {})) {
    const config = resolveVectorRoutineRunAuthorityConfig(
      { PAPERCLIP_VECTOR_ROUTINE_AUTHORITY_URL: endpoint },
      providerConfig,
      toolConfig,
    )!;
    setActiveVectorRoutineRunAuthority({ config, bind } as unknown as VectorRoutineRunAuthority);
    return bind;
  }

  it("leaves every run that is not a research routine issue untouched", async () => {
    const bind = activeAuthority();
    await expect(prepareActiveVectorRoutineRunAuthority(seamInput({ workload: null }))).resolves.toBe(false);
    setActiveVectorRoutineRunAuthority(null);
    await expect(prepareActiveVectorRoutineRunAuthority(seamInput({ workload: null }))).resolves.toBe(false);
    expect(bind).not.toHaveBeenCalled();
  });

  it("binds a research routine run to its declared tool surface", async () => {
    const bind = activeAuthority();
    const input = seamInput();
    await expect(prepareActiveVectorRoutineRunAuthority(input)).resolves.toBe(true);
    expect(bind).toHaveBeenCalledWith({
      runId: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issueId,
      workloadKey: "current_scout",
      toolSurface: scoutTools,
    });
  });

  it("fails closed without authority, with foreign handles, for another agent, or without a Paperclip contract", async () => {
    await expect(prepareActiveVectorRoutineRunAuthority(seamInput()))
      .rejects.toMatchObject({ details: { code: "vector_provider_authority_unavailable" } });
    const bind = activeAuthority();
    type SeamInput = ReturnType<typeof seamInput>;
    for (const mutate of [
      (input: SeamInput) => { input.issueId = null as never; },
      (input: SeamInput) => { input.toolPending = { version: 1 } as never; },
      (input: SeamInput) => { input.providerPending = { version: 1 } as never; },
      (input: SeamInput) => { input.providerBound = { version: 1 } as never; },
      (input: SeamInput) => { input.workload.assigneeAgentId = randomUUID(); },
      (input: SeamInput) => { input.workload.assigneeAgentId = null as never; },
      (input: SeamInput) => { input.agentMetadata = provisionedMetadata({ installationId: "stg1-staging" }); },
      // A workload this agent's sealed contracts do not declare.
      (input: SeamInput) => { input.workload.workloadKey = "macro_scout"; },
    ]) {
      const input = seamInput();
      mutate(input);
      await expect(prepareActiveVectorRoutineRunAuthority(input))
        .rejects.toMatchObject({ details: { code: "vector_provider_authority_unavailable" } });
    }
    expect(bind).not.toHaveBeenCalled();
  });

  it("binds a routine grant that the unchanged no-pending provider path then redeems", async () => {
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
    // The run row update in bindRun is covered by the embedded-Postgres
    // suites; here it is stubbed to "one active run matched".
    const db = {
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: run.runId }] }) }) }),
    } as never;
    const providerBridge = new VectorProviderAuthorityBridge(db, providerConfig, fetchImpl as unknown as typeof fetch);
    setActiveVectorProviderAuthorityBridge(providerBridge);
    const tool = { bindRun: vi.fn(async () => {}) };
    const config = resolveVectorRoutineRunAuthorityConfig(
      { PAPERCLIP_VECTOR_ROUTINE_AUTHORITY_URL: endpoint },
      providerConfig,
      toolConfig,
    )!;
    setActiveVectorRoutineRunAuthority(new VectorRoutineRunAuthority(config, {
      activeRun: async () => true,
      provider: providerBridge,
      tool,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }));

    await expect(prepareActiveVectorRoutineRunAuthority({
      runId: run.runId,
      companyId: run.companyId,
      agentId: run.agentId,
      agentMetadata: provisionedMetadata(),
      issueId: run.issueId,
      workload: { routineId: randomUUID(), workloadKey: "current_scout", assigneeAgentId: run.agentId },
      toolPending: null,
      providerPending: null,
      providerBound: null,
    })).resolves.toBe(true);
    expect(tool.bindRun).toHaveBeenCalledWith(expect.objectContaining({ allowedTools: scoutTools }));
    const access = await prepareActiveVectorProviderRuntimeAccess({
      runId: run.runId, companyId: run.companyId, agentId: run.agentId, issueId: run.issueId,
      pending: null, bound: null, required: true,
    });
    expect(access).toMatchObject({
      providerId: "router",
      apiKey: "vpr.opaque-parent-proxy-capability.cap",
    });
    expect(redeemed).toHaveLength(1);
    expect(redeemed[0]).toMatchObject({
      providerAuthorityHandle: "p".repeat(64),
      conversationId: run.issueId,
      runId: run.runId,
      sessionScope: createHash("sha256")
        .update("paperclip-vector-provider-session/v1\0")
        .update(run.companyId).update("\0")
        .update(run.agentId).update("\0")
        .update(`paperclip-routine:${run.issueId}`)
        .digest("base64url"),
    });
  });
});
