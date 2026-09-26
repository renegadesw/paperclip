import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  reconcileVectorInstallation,
  type VectorProvisioningPort,
} from "./vector-installation-provisioning.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-vector-provision-"));
  roots.push(root);
  const stagedReleaseRoot = path.join(root, "stage");
  const activeReleaseRoot = path.join(root, "releases", "current");
  const relative = "paperclip/profile-assets/engineering/funkydev/AGENTS.md";
  const body = "# FunkyDev\n";
  await fs.mkdir(path.dirname(path.join(stagedReleaseRoot, relative)), { recursive: true });
  await fs.writeFile(path.join(stagedReleaseRoot, relative), body);
  const toolPolicy = {
    profile: "engineering",
    builtinTools: ["bash", "edit", "find", "grep", "ls", "read", "write"],
    extensions: [{
      name: "funkydev.vault-reference",
      tools: ["vault_read", "vault_search"],
      permissions: { filesystem: true, shell: false },
    }],
  };
  const manifest = {
    schemaVersion: 1,
    manifestRevision: 1,
    installationId: "t480-engineering",
    profile: "engineering",
    company: {
      id: "12d42db4-38df-5ae1-9b10-204b6f2e5d0c",
      name: "Vector Engineering",
      description: "Vector engineering control plane",
      budgetMonthlyCents: 0,
      mutableFields: [],
    },
    agent: {
      id: "e5b45684-168d-51af-9bb4-e9a5d96f6329",
      name: "FunkyDev",
      role: "engineer",
      title: "Standing Vector engineer",
      capabilities: "Repository engineering and operator collaboration.",
      adapterType: "pi_local",
      adapterConfig: {
        model: "router/Qwen3.8-Flash",
        thinking: "high",
        executionMode: "rpc",
        cwd: "/home/funkydev",
      },
      instructions: { path: relative, sha256: createHash("sha256").update(body).digest("hex") },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      budgetMonthlyCents: 0,
      permissions: { canCreateAgents: false, canCreateSkills: false },
      mutableFields: [],
    },
    toolPolicy,
  };
  return { manifest, toolPolicy, stagedReleaseRoot, activeReleaseRoot };
}

function memoryPort(): VectorProvisioningPort & { companies: any[]; ownerships: any[]; agents: any[] } {
  const companies: any[] = [];
  const ownerships: any[] = [];
  const agents: any[] = [];
  return {
    companies,
    ownerships,
    agents,
    listCompanies: async () => companies,
    getCompany: async (id) => companies.find((row) => row.id === id) ?? null,
    createCompany: async (input) => { companies.push({ ...input }); return companies.at(-1); },
    getOwnershipByInstallationId: async (installationId) => ownerships.find((row) => row.installationId === installationId) ?? null,
    getOwnershipByCompanyId: async (companyId) => ownerships.find((row) => row.companyId === companyId) ?? null,
    createOwnership: async (input) => { ownerships.push({ ...input }); return ownerships.at(-1); },
    listAgents: async (companyId) => agents.filter((row) => row.companyId === companyId),
    getAgent: async (id) => agents.find((row) => row.id === id) ?? null,
    createAgent: async (companyId, input) => { agents.push({ ...input, companyId }); return agents.at(-1); },
  };
}

describe("Vector installation provisioning", () => {
  it("creates once and retries with identical stable ids", async () => {
    const f = await fixture();
    const port = memoryPort();
    const first = await reconcileVectorInstallation(port, { ...f, selectedProfile: "engineering", effectiveToolPolicy: f.toolPolicy });
    const retry = await reconcileVectorInstallation(port, { ...f, selectedProfile: "engineering", effectiveToolPolicy: f.toolPolicy });
    expect(first).toMatchObject({
      companyId: f.manifest.company.id,
      agentId: f.manifest.agent.id,
      created: { company: true, ownership: true, agent: true },
    });
    expect(retry).toMatchObject({
      companyId: first.companyId,
      agentId: first.agentId,
      created: { company: false, ownership: false, agent: false },
    });
    expect(port.companies).toHaveLength(1);
    expect(port.ownerships).toEqual([{
      installationId: f.manifest.installationId,
      profile: f.manifest.profile,
      companyId: f.manifest.company.id,
    }]);
    expect(port.agents).toHaveLength(1);
    expect(port.agents[0].adapterConfig).toMatchObject({
      executionMode: "rpc",
      model: "router/Qwen3.8-Flash",
      cwd: "/home/funkydev",
      instructionsFilePath: path.join(f.activeReleaseRoot, f.manifest.agent.instructions.path),
    });
    expect(port.agents[0].adapterConfig).not.toHaveProperty("env");
  });

  it("provisions a stable multi-agent roster and records the default-off Vector workload bridge", async () => {
    const f = await fixture();
    const stagedAsset = async (name: string, body: string) => {
      const relative = `paperclip/profile-assets/shared/${name}/AGENTS.md`;
      await fs.mkdir(path.dirname(path.join(f.stagedReleaseRoot, relative)), { recursive: true });
      await fs.writeFile(path.join(f.stagedReleaseRoot, relative), body);
      return { path: relative, sha256: createHash("sha256").update(body).digest("hex") };
    };
    const analystInstructions = await stagedAsset("funky-analyst", "# Funky\n\nRequire a signed Vector turn.\n");
    const scoutInstructions = await stagedAsset("funky-scout", "# Funky Scout\n\nRequire a Vector claim envelope.\n");
    const advisorInstructions = await stagedAsset("funky-advisor", "# Funky Advisor\n\nRequire a signed role turn or Vector claim.\n");
    const scoutId = "f2d77ca4-2178-5d10-a780-f785bd9cb3f8";
    const advisorId = "b2d1bb52-cb7e-57ea-99d2-a595fc25e362";
    const researchBridge = {
      required: true as const,
      defaultEnabled: false as const,
      claimPath: "/inbound/vector-agents/research/claim",
      heartbeatPath: "/inbound/vector-agents/research/heartbeat",
      completePath: "/inbound/vector-agents/research/complete",
      failPath: "/inbound/vector-agents/research/fail",
      detachPath: "/inbound/vector-agents/research/detach",
    };
    const taskBridge = {
      required: true as const,
      defaultEnabled: false as const,
      claimPath: "/inbound/vector-agents/tasks/claim",
      heartbeatPath: "/inbound/vector-agents/tasks/heartbeat",
      completePath: "/inbound/vector-agents/tasks/complete",
      failPath: "/inbound/vector-agents/tasks/fail",
      detachPath: "/inbound/vector-agents/tasks/detach",
    };
    const disabledSchedule = (scheduleKey: string, cronExpression: string) => {
      const targets: Record<string, { targetFunction: string; targetParameters: Record<string, unknown> }> = {
        fa_research_daily: { targetFunction: "enqueue_research_cycle", targetParameters: { cadence: "daily" } },
        fa_research_lease_sweep: { targetFunction: "recover_research_leases", targetParameters: {} },
        fa_task_lease_sweep: { targetFunction: "recover_task_leases", targetParameters: {} },
        fa_dmv_review_daily: {
          targetFunction: "enqueue_task",
          targetParameters: { task_type: "dmv_review", run: { trigger: "cadence", cadence: "daily", token_budget: 16000, deadline_minutes: 180 } },
        },
        fa_dmv_audit_back_triage_daily: {
          targetFunction: "enqueue_task",
          targetParameters: { task_type: "dmv_audit_back_triage", run: { trigger: "cadence", cadence: "daily", token_budget: 48000, deadline_minutes: 240 } },
        },
        fa_rollup_query_themes: { targetFunction: "rollup_query_themes", targetParameters: {} },
      };
      return {
        owner: "vector_jobs" as const,
        scheduleKey,
        targetSchema: "os",
        ...targets[scheduleKey],
        cronExpression,
        timezone: "America/New_York",
        enabled: false as const,
      };
    };
    const researchRecovery = disabledSchedule("fa_research_lease_sweep", "*/5 * * * *");
    const taskRecovery = disabledSchedule("fa_task_lease_sweep", "*/5 * * * *");
    const researchWorkload = (key: string, dependencies: any[] = []) => ({
      key,
      title: `Research ${key}`,
      kind: "research_task",
      agentId: scoutId,
      executionShape: "single_shot",
      promptSource: "vector_claim_envelope",
      toolSurface: [] as string[],
      policy: {
        leaseSeconds: 300, maxAttempts: 3, tokenBudget: 12000,
        mayDetach: true, mayWrite: false as const, requiresEvidence: true as const,
        modelPolicy: null,
        gatingFlag: "product.os.research",
        payloadFunction: "os.research_task_payload",
        promptFunction: "os.research_task_prompt",
        settlementFunction: null,
        escalationRole: null,
        lineage: { maxSpawnDepth: 0, allowInTurnChildren: false, allowedChildTypes: [] as string[], maxParallelChildren: 1 },
      },
      runtimeAuthority: "vector_lease_triple",
      schedule: disabledSchedule("fa_research_daily", "20 8 * * *"),
      dependencies,
      recoverySchedule: researchRecovery,
      bridge: researchBridge,
    });
    const restrictedPolicy = { profile: "staging", builtinTools: [], extensions: [] };
    const manifest = {
      ...f.manifest,
      profile: "staging",
      agent: {
        ...f.manifest.agent,
        name: "Funky",
        role: "funky-analyst",
        title: "Funky Analyst",
        instructions: analystInstructions,
      },
      additionalAgents: [
        {
          ...f.manifest.agent,
          id: scoutId,
          name: "Funky Scout",
          role: "funky-scout",
          title: "Research Scout",
          capabilities: "Runs only database-authorized Vector research claims.",
          instructions: scoutInstructions,
        },
        {
          ...f.manifest.agent,
          id: advisorId,
          name: "Funky Advisor",
          role: "funky-advisor",
          title: "Office Advisor",
          capabilities: "Runs signed role turns and database-authorized session tasks.",
          instructions: advisorInstructions,
        },
      ],
      workloads: [
        researchWorkload("current_scout"),
        researchWorkload("macro_scout"),
        researchWorkload("demand_scout", [{
          kind: "schedule", key: "fa_rollup_query_themes",
          description: "Builds the query themes read by demand scout.",
          schedule: disabledSchedule("fa_rollup_query_themes", "40 2 * * *"),
        }]),
        researchWorkload("synthesis", [
          { kind: "workload", key: "current_scout", description: "Current lens input.", schedule: null },
          { kind: "workload", key: "macro_scout", description: "Macro lens input.", schedule: null },
          { kind: "workload", key: "demand_scout", description: "Demand lens input.", schedule: null },
        ]),
        researchWorkload("curation", [
          { kind: "workload", key: "synthesis", description: "Curation waits for synthesis.", schedule: null },
        ]),
        {
          key: "dmv_review", title: "DMV daily intake review", kind: "generic_task",
          agentId: scoutId, executionShape: "single_shot", promptSource: "vector_claim_envelope",
          toolSurface: [] as string[],
          policy: {
            leaseSeconds: 900, maxAttempts: 2, tokenBudget: 8000,
            mayDetach: false, mayWrite: false, requiresEvidence: true,
            modelPolicy: null,
            gatingFlag: "product.dmv.review",
            payloadFunction: "dmv.review_payload", promptFunction: "dmv.review_prompt",
            settlementFunction: "dmv.review_settle", escalationRole: "compliance-advisor",
            lineage: { maxSpawnDepth: 0, allowInTurnChildren: false, allowedChildTypes: [], maxParallelChildren: 1 },
          },
          runtimeAuthority: "vector_lease_triple",
          schedule: disabledSchedule("fa_dmv_review_daily", "30 7 * * *"),
          dependencies: [], recoverySchedule: taskRecovery, bridge: taskBridge,
        },
        {
          key: "dmv_audit_back_triage", title: "DMV audit-back triage", kind: "generic_task",
          agentId: advisorId, executionShape: "session", promptSource: "vector_claim_envelope",
          toolSurface: ["dmv.list_audit_back", "dmv.get_pipeline_health", "dmv.list_recent_pipeline_failures"],
          policy: {
            leaseSeconds: 1200, maxAttempts: 2, tokenBudget: 24000,
            mayDetach: true, mayWrite: false, requiresEvidence: true,
            modelPolicy: null,
            gatingFlag: "product.dmv.triage",
            payloadFunction: "dmv.triage_payload", promptFunction: "dmv.triage_prompt",
            settlementFunction: "dmv.review_settle", escalationRole: "compliance-advisor",
            lineage: {
              maxSpawnDepth: 1, allowInTurnChildren: true,
              allowedChildTypes: ["dmv-client-reader", "reader"], maxParallelChildren: 2,
            },
          },
          runtimeAuthority: "vector_lease_triple",
          schedule: disabledSchedule("fa_dmv_audit_back_triage_daily", "0 8 * * *"),
          dependencies: [], recoverySchedule: taskRecovery, bridge: taskBridge,
        },
      ],
      toolPolicy: restrictedPolicy,
    };
    const port = memoryPort();
    manifest.workloads[0].schedule.cronExpression = "21 8 * * *";
    await expect(reconcileVectorInstallation(port, {
      ...f,
      manifest,
      selectedProfile: "staging",
      effectiveToolPolicy: restrictedPolicy,
    })).rejects.toThrow("staging workload current_scout does not match the Vector contract");
    manifest.workloads[0].schedule.cronExpression = "20 8 * * *";

    const first = await reconcileVectorInstallation(port, {
      ...f,
      manifest,
      selectedProfile: "staging",
      effectiveToolPolicy: restrictedPolicy,
    });
    const retry = await reconcileVectorInstallation(port, {
      ...f,
      manifest,
      selectedProfile: "staging",
      effectiveToolPolicy: restrictedPolicy,
    });

    expect(first.agentIds).toEqual([f.manifest.agent.id, scoutId, advisorId]);
    expect(first.agentsCreated).toBe(3);
    expect(retry.agentsCreated).toBe(0);
    expect(port.agents).toHaveLength(3);
    expect(port.agents[1].metadata).toMatchObject({
      vectorWorkloads: {
        catalogSha256: first.workloadCatalogSha256,
        keys: ["curation", "current_scout", "demand_scout", "dmv_review", "macro_scout", "synthesis"],
      },
    });

    manifest.workloads[0].title = "Operator-edited workload title";
    await expect(reconcileVectorInstallation(port, {
      ...f,
      manifest,
      selectedProfile: "staging",
      effectiveToolPolicy: restrictedPolicy,
    })).rejects.toThrow("immutable field agent.metadata differs");
  });

  it("rejects workload mappings that widen lease or server-profile authority", async () => {
    const f = await fixture();
    const badWorkload = {
      key: "current_scout",
      title: "Research current scout",
      kind: "research_task",
      agentId: f.manifest.agent.id,
      executionShape: "single_shot",
      promptSource: "vector_claim_envelope",
      toolSurface: [],
      policy: {
        leaseSeconds: 300, maxAttempts: 3, tokenBudget: 12000,
        mayDetach: true, mayWrite: false, requiresEvidence: true,
        modelPolicy: null,
        gatingFlag: "product.os.research",
        payloadFunction: "os.research_task_payload", promptFunction: "os.research_task_prompt",
        settlementFunction: null, escalationRole: null,
        lineage: { maxSpawnDepth: 0, allowInTurnChildren: false, allowedChildTypes: [], maxParallelChildren: 1 },
      },
      runtimeAuthority: "vector_lease_triple",
      schedule: {
        owner: "paperclip",
        scheduleKey: "fa_research_daily",
        targetSchema: "os",
        targetFunction: "enqueue_research_cycle",
        targetParameters: { cadence: "daily" },
        cronExpression: "20 8 * * *",
        timezone: "America/New_York",
        enabled: false,
      },
      bridge: null,
    };
    await expect(reconcileVectorInstallation(memoryPort(), {
      ...f,
      manifest: { ...f.manifest, workloads: [badWorkload] },
      selectedProfile: "engineering",
      effectiveToolPolicy: f.toolPolicy,
    })).rejects.toThrow();

    const restrictedPolicy = { profile: "standard", builtinTools: ["bash"], extensions: [] };
    await expect(reconcileVectorInstallation(memoryPort(), {
      ...f,
      manifest: { ...f.manifest, profile: "standard", toolPolicy: restrictedPolicy },
      selectedProfile: "standard",
      effectiveToolPolicy: restrictedPolicy,
    })).rejects.toThrow("must not provision ambient Pi tools");

    const incompleteEngineeringPolicy = {
      ...f.toolPolicy,
      builtinTools: f.toolPolicy.builtinTools.filter((tool) => tool !== "write"),
    };
    await expect(reconcileVectorInstallation(memoryPort(), {
      ...f,
      manifest: { ...f.manifest, toolPolicy: incompleteEngineeringPolicy },
      selectedProfile: "engineering",
      effectiveToolPolicy: incompleteEngineeringPolicy,
    })).rejects.toThrow("engineering installs require the exact FunkyDev tool policy");
  });

  it("fails closed on immutable drift but preserves explicitly mutable fields", async () => {
    const f = await fixture();
    const port = memoryPort();
    await reconcileVectorInstallation(port, { ...f, selectedProfile: "engineering", effectiveToolPolicy: f.toolPolicy });
    port.agents[0].title = "operator title";
    await expect(reconcileVectorInstallation(port, {
      ...f,
      selectedProfile: "engineering",
      effectiveToolPolicy: f.toolPolicy,
    })).rejects.toThrow("immutable field agent.title");
    (f.manifest.agent.mutableFields as string[]).push("title");
    const receipt = await reconcileVectorInstallation(port, {
      ...f,
      selectedProfile: "engineering",
      effectiveToolPolicy: f.toolPolicy,
    });
    expect(receipt.created.agent).toBe(false);
    expect(port.agents[0].title).toBe("operator title");
  });

  it("rejects profile, tool policy, digest, and identity mismatches before mutation", async () => {
    const f = await fixture();
    for (const change of [
      { selectedProfile: "standard" },
      { effectiveToolPolicy: { ...f.toolPolicy, builtinTools: [] } },
      { manifest: { ...f.manifest, agent: { ...f.manifest.agent, instructions: { ...f.manifest.agent.instructions, sha256: "0".repeat(64) } } } },
    ]) {
      const port = memoryPort();
      await expect(reconcileVectorInstallation(port, {
        ...f,
        selectedProfile: "engineering",
        effectiveToolPolicy: f.toolPolicy,
        ...change,
      })).rejects.toThrow();
      expect(port.companies).toHaveLength(0);
      expect(port.ownerships).toHaveLength(0);
      expect(port.agents).toHaveLength(0);
    }

    const port = memoryPort();
    port.companies.push({ ...f.manifest.company, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    await expect(reconcileVectorInstallation(port, {
      ...f,
      selectedProfile: "engineering",
      effectiveToolPolicy: f.toolPolicy,
    })).rejects.toThrow("company identity collision");
  });

  it("fails on installation, company, or profile ownership drift", async () => {
    const f = await fixture();
    const cases = [
      { installationId: f.manifest.installationId, profile: "standard", companyId: f.manifest.company.id },
      { installationId: "another-installation", profile: f.manifest.profile, companyId: f.manifest.company.id },
      { installationId: f.manifest.installationId, profile: f.manifest.profile, companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    ];
    for (const ownership of cases) {
      const port = memoryPort();
      port.companies.push({ ...f.manifest.company });
      port.ownerships.push(ownership);
      await expect(reconcileVectorInstallation(port, {
        ...f,
        selectedProfile: "engineering",
        effectiveToolPolicy: f.toolPolicy,
      })).rejects.toThrow(/ownership|installationOwnership/);
      expect(port.agents).toHaveLength(0);
    }
  });

  it("keeps two installation ownerships distinct on a shared database port", async () => {
    const first = await fixture();
    const second = await fixture();
    second.manifest.installationId = "stecke1-engineering";
    second.manifest.company = {
      ...second.manifest.company,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Vector Engineering Two",
    };
    second.manifest.agent = {
      ...second.manifest.agent,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "FunkyDev",
    };
    const port = memoryPort();
    await reconcileVectorInstallation(port, {
      ...first,
      selectedProfile: "engineering",
      effectiveToolPolicy: first.toolPolicy,
    });
    await reconcileVectorInstallation(port, {
      ...second,
      selectedProfile: "engineering",
      effectiveToolPolicy: second.toolPolicy,
    });
    expect(port.ownerships).toEqual([
      {
        installationId: first.manifest.installationId,
        profile: "engineering",
        companyId: first.manifest.company.id,
      },
      {
        installationId: second.manifest.installationId,
        profile: "engineering",
        companyId: second.manifest.company.id,
      },
    ]);
    const crossed = {
      ...second,
      manifest: {
        ...second.manifest,
        installationId: first.manifest.installationId,
      },
    };
    await expect(reconcileVectorInstallation(port, {
      ...crossed,
      selectedProfile: "engineering",
      effectiveToolPolicy: second.toolPolicy,
    })).rejects.toThrow(/ownership/);
  });

  it.each([
    ["token", { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 }, nested: { token: "abc" } } }],
    ["password", { permissions: { canCreateAgents: false, canCreateSkills: false, password: "abc" } }],
    ["apiKey", { adapterConfig: { model: "router/Qwen3.8-Flash", thinking: "high", executionMode: "rpc", cwd: "/home/funkydev", apiKey: "abc" } }],
    ["databaseUrl", { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 }, databaseUrl: "postgres://example" } }],
    ["privateKey", { permissions: { canCreateAgents: false, canCreateSkills: false, nested: { privateKey: "abc" } } }],
    ["environment expansion", { capabilities: "Use ${PROVIDER_API_KEY}" }],
  ])("rejects embedded %s authority before mutation", async (_label, agentPatch) => {
    const f = await fixture();
    const port = memoryPort();
    await expect(reconcileVectorInstallation(port, {
      ...f,
      manifest: {
        ...f.manifest,
        agent: { ...f.manifest.agent, ...agentPatch },
      },
      selectedProfile: "engineering",
      effectiveToolPolicy: f.toolPolicy,
    })).rejects.toThrow(/must not contain/);
    expect(port.companies).toHaveLength(0);
    expect(port.agents).toHaveLength(0);
  });
});
