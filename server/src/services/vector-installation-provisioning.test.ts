import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agents as agentsTable, createDb, routineTriggers, routines, vectorInstallationOwnerships } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  provisionVectorInstallation,
  reconcileVectorInstallation,
  vectorScheduleRoutineSeeds,
  vectorWorkloadRoutineSeeds,
  vectorInstallationManifestSchema,
  type VectorProvisioningPort,
} from "./vector-installation-provisioning.js";

const roots: string[] = [];
const embeddedPostgres = await getEmbeddedPostgresTestSupport();

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
    }, {
      name: "vector.tool-bridge",
      tools: ["ask_user", "github_api", "github_manage", "github_read", "github_repo", "memory_forget", "memory_save", "memory_search", "todo_add", "todo_list", "todo_mark_done", "todo_update"],
      permissions: { filesystem: false, shell: false },
    }, {
      name: "vector.speak",
      tools: ["speak"],
      permissions: { filesystem: false, shell: false },
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

function memoryPort(): VectorProvisioningPort & { companies: any[]; ownerships: any[]; agents: any[]; terminated: string[] } {
  const companies: any[] = [];
  const ownerships: any[] = [];
  const agents: any[] = [];
  const terminated: string[] = [];
  return {
    companies,
    ownerships,
    agents,
    terminated,
    listCompanies: async () => companies,
    getCompany: async (id) => companies.find((row) => row.id === id) ?? null,
    createCompany: async (input) => { companies.push({ ...input }); return companies.at(-1); },
    getOwnershipByInstallationId: async (installationId) => ownerships.find((row) => row.installationId === installationId) ?? null,
    getOwnershipByCompanyId: async (companyId) => ownerships.find((row) => row.companyId === companyId) ?? null,
    createOwnership: async (input) => { ownerships.push({ ...input }); return ownerships.at(-1); },
    listAgents: async (companyId) => agents.filter((row) => row.companyId === companyId),
    getAgent: async (id) => agents.find((row) => row.id === id) ?? null,
    createAgent: async (companyId, input) => { agents.push({ ...input, companyId }); return agents.at(-1); },
    updateAgent: async (id, patch) => {
      const index = agents.findIndex((row) => row.id === id);
      if (index < 0) return null;
      agents[index] = { ...agents[index], ...structuredClone(patch) };
      return agents[index];
    },
    terminateAgent: async (id) => {
      const index = agents.findIndex((row) => row.id === id);
      if (index < 0) return null;
      terminated.push(id);
      agents[index] = { ...agents[index], status: "terminated" };
      return agents[index];
    },
  };
}

type FunkyServerProfile = "staging" | "production";

interface FunkyServerIdentity {
  installationId?: string;
  companyId?: string;
  companyName?: string;
  analystId?: string;
  scoutId?: string;
  advisorId?: string;
}

/**
 * A complete Funky server manifest (analyst, Scout, Advisor, the sealed
 * workload catalog and its schedules). Staging and production are the same
 * product; only the profile and installation identity differ.
 */
async function funkyServerFixture(profile: FunkyServerProfile = "staging", identity: FunkyServerIdentity = {}) {
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
  const scoutId = identity.scoutId ?? "f2d77ca4-2178-5d10-a780-f785bd9cb3f8";
  const advisorId = identity.advisorId ?? "b2d1bb52-cb7e-57ea-99d2-a595fc25e362";
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
  const restrictedPolicy = { profile, builtinTools: [], extensions: [{
    name: "vector.tool-bridge",
    tools: [
      "apply_audience_plan", "apply_campaign_plan", "apply_charter_plan", "apply_setting_plan",
      "consult_advisors", "describe_relation", "dmv.get_pipeline_health", "dmv.list_audit_back",
      "dmv.list_recent_pipeline_failures", "draft_action", "get_business_context", "inspect_audiences",
      "inspect_campaigns", "inspect_client_charter", "inspect_settings", "inspect_voice", "list_capabilities",
      "plan_audience_change", "plan_campaign_change", "plan_charter_change", "plan_setting_change",
      "present_strategy_plan", "pull_check_evidence", "query_data", "run_report", "verify_audience_plan",
      "verify_campaign_plan", "verify_charter_plan", "verify_setting_plan",
    ],
    permissions: { filesystem: false, shell: false },
  }] };
  const manifest = {
    ...f.manifest,
    installationId: identity.installationId ?? f.manifest.installationId,
    profile,
    company: {
      ...f.manifest.company,
      id: identity.companyId ?? f.manifest.company.id,
      name: identity.companyName ?? f.manifest.company.name,
    },
    agent: {
      ...f.manifest.agent,
      id: identity.analystId ?? f.manifest.agent.id,
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
  return { f, manifest, restrictedPolicy, scoutId, advisorId };
}

describe("Vector installation provisioning", () => {
  it("accepts exactly the Standard Chat roster with the chat bridge and speak, and rejects any second agent or changed tools", async () => {
    const f = await fixture();
    const workerBody = "# Implementation Worker\n";
    const workerPath = "paperclip/profile-assets/standard/implementation-worker/AGENTS.md";
    await fs.mkdir(path.dirname(path.join(f.stagedReleaseRoot, workerPath)), { recursive: true });
    await fs.writeFile(path.join(f.stagedReleaseRoot, workerPath), workerBody);
    const retiredWorker = {
      ...f.manifest.agent,
      id: "6e0d30cf-6f32-5f8c-bb1d-3117ce4b27d5",
      name: "Implementation Worker",
      role: "implementation-worker",
      title: "Restricted todo worker",
      instructions: { path: workerPath, sha256: createHash("sha256").update(workerBody).digest("hex") },
    };
    const speakOnly = f.toolPolicy.extensions[2];
    const chatBridge = {
      ...f.toolPolicy.extensions[1],
      tools: f.toolPolicy.extensions[1].tools.filter((tool) => !tool.startsWith("github_")),
    };
    expect(chatBridge.tools).toEqual([
      "ask_user", "memory_forget", "memory_save", "memory_search",
      "todo_add", "todo_list", "todo_mark_done", "todo_update",
    ]);
    const standard = {
      ...f.manifest, profile: "standard",
      agent: { ...f.manifest.agent, name: "Standard Chat", role: "standard-chat" },
      additionalAgents: [],
      toolPolicy: { profile: "standard", builtinTools: [], extensions: [chatBridge, speakOnly] },
    };
    expect(vectorInstallationManifestSchema.safeParse(standard).success).toBe(true);
    // The retired implementation-worker (or any second agent) is never admitted.
    expect(vectorInstallationManifestSchema.safeParse({ ...standard, additionalAgents: [retiredWorker] }).success).toBe(false);
    expect(vectorInstallationManifestSchema.safeParse({
      ...standard,
      additionalAgents: [{ ...retiredWorker, role: "standard-chat", name: "Second Chat" }],
    }).success).toBe(false);
    expect(vectorInstallationManifestSchema.safeParse({
      ...standard,
      agent: { ...standard.agent, role: "implementation-worker" },
    }).success).toBe(false);
    for (const extensions of [[], [speakOnly], [chatBridge], [f.toolPolicy.extensions[0]],
      [f.toolPolicy.extensions[1], speakOnly], [speakOnly, chatBridge],
      [chatBridge, { ...speakOnly, permissions: { filesystem: true, shell: false } }],
      [{ ...chatBridge, permissions: { filesystem: false, shell: true } }, speakOnly],
      [{ ...chatBridge, tools: [...chatBridge.tools, "github_read"] }, speakOnly],
      [chatBridge, { ...speakOnly, tools: ["speak", "bash"] }]]) {
      expect(vectorInstallationManifestSchema.safeParse({ ...standard, toolPolicy: { ...standard.toolPolicy, extensions } }).success).toBe(false);
    }
    expect(vectorInstallationManifestSchema.safeParse({ ...standard, toolPolicy: { ...standard.toolPolicy, builtinTools: ["read"] } }).success).toBe(false);
    expect(vectorInstallationManifestSchema.safeParse({ ...f.manifest, toolPolicy: { ...f.toolPolicy, extensions: [f.toolPolicy.extensions[0]] } }).success).toBe(false);
    expect(vectorInstallationManifestSchema.safeParse({ ...standard, toolPolicy: { ...standard.toolPolicy, profile: "engineering" } }).success).toBe(false);
  });

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

  it.each(["staging", "production"] as const)("provisions a stable %s multi-agent roster and records the default-off Vector workload bridge", async (profile) => {
    const { f, manifest, restrictedPolicy, scoutId, advisorId } = await funkyServerFixture(profile);
    const port = memoryPort();
    const routineSeeds = vectorWorkloadRoutineSeeds(vectorInstallationManifestSchema.parse(manifest));
    expect(routineSeeds).toMatchObject([
      { queue: "research", assigneeAgentId: scoutId, cronExpression: "* * * * *", timezone: "UTC" },
      { queue: "tasks", assigneeAgentId: advisorId, cronExpression: "* * * * *", timezone: "UTC" },
    ]);
    expect(new Set(routineSeeds.flatMap((seed) => [seed.routineId, seed.triggerId])).size).toBe(4);
    const scheduleSeeds = vectorScheduleRoutineSeeds(vectorInstallationManifestSchema.parse(manifest));
    expect(scheduleSeeds.map((seed) => seed.scheduleKey)).toEqual([
      "fa_dmv_audit_back_triage_daily",
      "fa_dmv_review_daily",
      "fa_research_daily",
      "fa_research_lease_sweep",
      "fa_rollup_query_themes",
      "fa_task_lease_sweep",
    ]);
    expect(scheduleSeeds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scheduleKey: "fa_research_daily",
        cronExpression: "* * * * *",
        timezone: "UTC",
        sourceCronExpression: "20 8 * * *",
        sourceTimezone: "America/New_York",
        description: expect.stringContaining("20 8 * * * (America/New_York)"),
      }),
    ]));
    expect(new Set(scheduleSeeds.flatMap((seed) => [seed.routineId, seed.triggerId])).size).toBe(12);
    expect(vectorWorkloadRoutineSeeds(vectorInstallationManifestSchema.parse(f.manifest))).toEqual([]);
    expect(vectorScheduleRoutineSeeds(vectorInstallationManifestSchema.parse(f.manifest))).toEqual([]);
    manifest.workloads[0].schedule.cronExpression = "21 8 * * *";
    await expect(reconcileVectorInstallation(port, {
      ...f,
      manifest,
      selectedProfile: profile,
      effectiveToolPolicy: restrictedPolicy,
    })).rejects.toThrow(`${profile} workload current_scout does not match the Vector contract`);
    manifest.workloads[0].schedule.cronExpression = "20 8 * * *";

    const first = await reconcileVectorInstallation(port, {
      ...f,
      manifest,
      selectedProfile: profile,
      effectiveToolPolicy: restrictedPolicy,
    });
    const retry = await reconcileVectorInstallation(port, {
      ...f,
      manifest,
      selectedProfile: profile,
      effectiveToolPolicy: restrictedPolicy,
    });

    expect(first.agentIds).toEqual([manifest.agent.id, scoutId, advisorId]);
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
      selectedProfile: profile,
      effectiveToolPolicy: restrictedPolicy,
    })).rejects.toThrow("immutable field agent.metadata differs");
  });

  it("requires production to carry exactly the staging Funky roster and workload catalog", async () => {
    const { manifest } = await funkyServerFixture("production");
    expect(vectorInstallationManifestSchema.safeParse(manifest).success).toBe(true);
    const withoutAdvisor = vectorInstallationManifestSchema.safeParse({
      ...manifest,
      additionalAgents: manifest.additionalAgents.slice(0, 1),
      workloads: manifest.workloads.filter((workload) => workload.key !== "dmv_audit_back_triage"),
    });
    expect(withoutAdvisor.success).toBe(false);
    expect(JSON.stringify(withoutAdvisor.error?.issues)).toContain(
      "production installs require exactly Funky analyst, Scout, and Advisor agents",
    );
    const withoutCuration = vectorInstallationManifestSchema.safeParse({
      ...manifest,
      workloads: manifest.workloads.filter((workload) => workload.key !== "curation"),
    });
    expect(withoutCuration.success).toBe(false);
    expect(JSON.stringify(withoutCuration.error?.issues)).toContain(
      "production installs require the complete Vector workload catalog",
    );
    // The tool policy must name the installation profile: a staging policy
    // cannot be reused under a production manifest.
    expect(vectorInstallationManifestSchema.safeParse({
      ...manifest,
      toolPolicy: { ...manifest.toolPolicy, profile: "staging" },
    }).success).toBe(false);
    // Standard and engineering still never own Funky schedules.
    expect(vectorWorkloadRoutineSeeds(vectorInstallationManifestSchema.parse({
      ...manifest,
      profile: "standard",
      additionalAgents: [],
      workloads: [],
      agent: { ...manifest.agent, name: "Standard Chat", role: "standard-chat" },
      toolPolicy: {
        profile: "standard",
        builtinTools: [],
        extensions: [{
          name: "vector.tool-bridge",
          tools: ["ask_user", "memory_forget", "memory_save", "memory_search", "todo_add", "todo_list", "todo_mark_done", "todo_update"],
          permissions: { filesystem: false, shell: false },
        }, { name: "vector.speak", tools: ["speak"], permissions: { filesystem: false, shell: false } }],
      },
    }))).toEqual([]);
  });

  it("provisions staging and production side by side on one database port without collision", async () => {
    const staging = await funkyServerFixture("staging", {
      installationId: "vector-os-staging",
      companyId: "5f1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e01",
      companyName: "Vector OS Staging",
      analystId: "5f1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e11",
      scoutId: "5f1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e12",
      advisorId: "5f1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e13",
    });
    const production = await funkyServerFixture("production", {
      installationId: "vector-os-production",
      companyId: "5f1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e02",
      companyName: "Vector OS Production",
      analystId: "5f1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e21",
      scoutId: "5f1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e22",
      advisorId: "5f1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e23",
    });
    const port = memoryPort();
    const stagingReceipt = await reconcileVectorInstallation(port, {
      ...staging.f, manifest: staging.manifest, selectedProfile: "staging", effectiveToolPolicy: staging.restrictedPolicy,
    });
    const productionReceipt = await reconcileVectorInstallation(port, {
      ...production.f, manifest: production.manifest, selectedProfile: "production", effectiveToolPolicy: production.restrictedPolicy,
    });
    expect(stagingReceipt).toMatchObject({ installationId: "vector-os-staging", profile: "staging", agentsCreated: 3 });
    expect(productionReceipt).toMatchObject({ installationId: "vector-os-production", profile: "production", agentsCreated: 3 });
    expect(port.ownerships).toEqual([
      { installationId: "vector-os-staging", profile: "staging", companyId: staging.manifest.company.id },
      { installationId: "vector-os-production", profile: "production", companyId: production.manifest.company.id },
    ]);
    expect(port.agents).toHaveLength(6);
    expect(new Set(port.agents.map((agent) => agent.companyId))).toEqual(
      new Set([staging.manifest.company.id, production.manifest.company.id]),
    );
    // The two installations' sealed catalogs hash under their own identity.
    expect(productionReceipt.workloadCatalogSha256).not.toBe(stagingReceipt.workloadCatalogSha256);
    expect(productionReceipt.rosterCatalogSha256).not.toBe(stagingReceipt.rosterCatalogSha256);

    const seedIds = (manifest: unknown) => {
      const parsed = vectorInstallationManifestSchema.parse(manifest);
      return [...vectorWorkloadRoutineSeeds(parsed), ...vectorScheduleRoutineSeeds(parsed)]
        .flatMap((seed) => [seed.routineId, seed.triggerId]);
    };
    const stagingSeedIds = seedIds(staging.manifest);
    const productionSeedIds = seedIds(production.manifest);
    expect(stagingSeedIds).toHaveLength(16);
    expect(productionSeedIds).toHaveLength(16);
    expect(new Set([...stagingSeedIds, ...productionSeedIds]).size).toBe(32);

    // Reruns stay idempotent and a production manifest can never claim the
    // staging installation (or vice versa).
    await expect(reconcileVectorInstallation(port, {
      ...production.f, manifest: production.manifest, selectedProfile: "production", effectiveToolPolicy: production.restrictedPolicy,
    })).resolves.toMatchObject({ agentsCreated: 0 });
    await expect(reconcileVectorInstallation(port, {
      ...production.f,
      manifest: { ...production.manifest, installationId: "vector-os-staging" },
      selectedProfile: "production",
      effectiveToolPolicy: production.restrictedPolicy,
    })).rejects.toThrow(/ownership/);
    await expect(reconcileVectorInstallation(port, {
      ...staging.f,
      manifest: { ...staging.manifest, profile: "production", toolPolicy: { ...staging.restrictedPolicy, profile: "production" } },
      selectedProfile: "production",
      effectiveToolPolicy: { ...staging.restrictedPolicy, profile: "production" },
    })).rejects.toThrow(/ownership|installationOwnership/);
    expect(port.agents).toHaveLength(6);
  });

  (embeddedPostgres.supported ? describe : describe.skip)("Funky server profiles through the production agent service", () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;

    beforeAll(async () => {
      database = await startEmbeddedPostgresTestDatabase("paperclip-vector-provision-funky-");
      db = createDb(database.connectionString);
    }, 90_000);

    afterAll(async () => {
      await db?.$client.end({ timeout: 0 });
      await database?.cleanup();
    });

    async function provisionedRoutines(companyId: string) {
      const routineRows = await db.select().from(routines).where(eq(routines.companyId, companyId));
      const triggerRows = await db.select().from(routineTriggers).where(eq(routineTriggers.companyId, companyId));
      return { routineRows, triggerRows };
    }

    it("provisions a production install in Postgres with the staging roster and initially disabled routines", async () => {
      const production = await funkyServerFixture("production", {
        installationId: "pg-vector-os-production",
        companyId: "6a1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e02",
        companyName: "PG Vector OS Production",
        analystId: "6a1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e21",
        scoutId: "6a1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e22",
        advisorId: "6a1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e23",
      });
      const input = {
        ...production.f, manifest: production.manifest, selectedProfile: "production", effectiveToolPolicy: production.restrictedPolicy,
      };
      const receipt = await provisionVectorInstallation(db, input);
      expect(receipt).toMatchObject({ profile: "production", agentsCreated: 3 });
      const roles = await db.select({ role: agentsTable.role }).from(agentsTable)
        .where(eq(agentsTable.companyId, production.manifest.company.id))
        .then((rows) => rows.map((row) => row.role).sort());
      expect(roles).toEqual(["funky-advisor", "funky-analyst", "funky-scout"]);
      const { routineRows, triggerRows } = await provisionedRoutines(production.manifest.company.id);
      expect(routineRows.map((row) => `${row.originKind}:${row.originId}`).sort()).toEqual([
        "vector_schedule_dispatch:fa_dmv_audit_back_triage_daily",
        "vector_schedule_dispatch:fa_dmv_review_daily",
        "vector_schedule_dispatch:fa_research_daily",
        "vector_schedule_dispatch:fa_research_lease_sweep",
        "vector_schedule_dispatch:fa_rollup_query_themes",
        "vector_schedule_dispatch:fa_task_lease_sweep",
        "vector_workload_dispatch:research",
        "vector_workload_dispatch:tasks",
      ]);
      expect(triggerRows).toHaveLength(8);
      expect(triggerRows.every((row) => row.enabled === false && row.nextRunAt === null)).toBe(true);

      const rerun = await provisionVectorInstallation(db, input);
      expect(rerun).toEqual({ ...receipt, created: { company: false, ownership: false, agent: false }, agentsCreated: 0 });
      expect((await provisionedRoutines(production.manifest.company.id)).triggerRows).toHaveLength(8);
    });

    it("keeps staging and production installations isolated side by side in Postgres", async () => {
      const staging = await funkyServerFixture("staging", {
        installationId: "pg-side-staging",
        companyId: "7b1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e01",
        companyName: "PG Side Staging",
        analystId: "7b1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e11",
        scoutId: "7b1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e12",
        advisorId: "7b1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e13",
      });
      const production = await funkyServerFixture("production", {
        installationId: "pg-side-production",
        companyId: "7b1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e02",
        companyName: "PG Side Production",
        analystId: "7b1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e21",
        scoutId: "7b1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e22",
        advisorId: "7b1b1c7e-2d7a-5c1e-8f0b-1a2b3c4d5e23",
      });
      await provisionVectorInstallation(db, {
        ...staging.f, manifest: staging.manifest, selectedProfile: "staging", effectiveToolPolicy: staging.restrictedPolicy,
      });
      await provisionVectorInstallation(db, {
        ...production.f, manifest: production.manifest, selectedProfile: "production", effectiveToolPolicy: production.restrictedPolicy,
      });
      const ownerships = await db.select().from(vectorInstallationOwnerships);
      expect(ownerships.filter((row) => row.installationId.startsWith("pg-side-")).map((row) => ({
        installationId: row.installationId, profile: row.profile, companyId: row.companyId,
      })).sort((a, b) => a.installationId.localeCompare(b.installationId))).toEqual([
        { installationId: "pg-side-production", profile: "production", companyId: production.manifest.company.id },
        { installationId: "pg-side-staging", profile: "staging", companyId: staging.manifest.company.id },
      ]);
      const stagingRoutines = await provisionedRoutines(staging.manifest.company.id);
      const productionRoutines = await provisionedRoutines(production.manifest.company.id);
      expect(stagingRoutines.routineRows).toHaveLength(8);
      expect(productionRoutines.routineRows).toHaveLength(8);
      const stagingAgentIds = new Set([staging.manifest.agent.id, staging.scoutId, staging.advisorId]);
      const productionAgentIds = new Set([production.manifest.agent.id, production.scoutId, production.advisorId]);
      expect(stagingRoutines.routineRows.every((row) => stagingAgentIds.has(row.assigneeAgentId!))).toBe(true);
      expect(productionRoutines.routineRows.every((row) => productionAgentIds.has(row.assigneeAgentId!))).toBe(true);
      await expect(provisionVectorInstallation(db, {
        ...production.f,
        manifest: { ...production.manifest, installationId: "pg-side-staging" },
        selectedProfile: "production",
        effectiveToolPolicy: production.restrictedPolicy,
      })).rejects.toThrow(/ownership/);
    });
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

  describe("manifest revision upgrades", () => {
    const workerId = "6e0d30cf-6f32-5f8c-bb1d-3117ce4b27d5";
    const chatPath = "paperclip/profile-assets/standard/standard-chat/AGENTS.md";

    async function standardRevision(f: Awaited<ReturnType<typeof fixture>>, revision: number, chatBody: string) {
      const stage = async (relative: string, body: string) => {
        await fs.mkdir(path.dirname(path.join(f.stagedReleaseRoot, relative)), { recursive: true });
        await fs.writeFile(path.join(f.stagedReleaseRoot, relative), body);
        return { path: relative, sha256: createHash("sha256").update(body).digest("hex") };
      };
      const toolPolicy = {
        profile: "standard",
        builtinTools: [],
        extensions: [{
          ...f.toolPolicy.extensions[1],
          tools: f.toolPolicy.extensions[1].tools.filter((tool) => !tool.startsWith("github_")),
        }, f.toolPolicy.extensions[2]],
      };
      const manifest = {
        ...f.manifest,
        manifestRevision: revision,
        installationId: "standard-stecke1",
        profile: "standard",
        agent: {
          ...f.manifest.agent,
          name: "Standard Chat",
          role: "standard-chat",
          instructions: await stage(chatPath, chatBody),
        },
        additionalAgents: [],
        toolPolicy,
      };
      return { ...f, manifest, selectedProfile: "standard", effectiveToolPolicy: toolPolicy };
    }

    /** A roster member provisioned by an older revision (the retired implementation-worker). */
    function legacyWorker(chat: any, revision = 1) {
      const worker = structuredClone(chat);
      worker.id = workerId;
      worker.name = "Implementation Worker";
      worker.role = "implementation-worker";
      worker.status = "idle";
      worker.metadata.vectorProvisioning.manifestRevision = revision;
      return worker;
    }

    /** Revision 1 as observed on a live Standard install: Standard Chat plus the legacy worker. */
    async function revisionOneInstall() {
      const f = await fixture();
      const port = memoryPort();
      await reconcileVectorInstallation(port, await standardRevision(f, 1, "# Standard Chat v1\n"));
      port.agents.push(legacyWorker(port.agents[0]));
      return { f, port };
    }

    it("upgrades the kept agent, retires the dropped agent, and reruns as a no-op", async () => {
      const { f, port } = await revisionOneInstall();
      const foreign = {
        ...structuredClone(port.agents[0]),
        id: "0f5b7f4e-3a55-4d0b-9a0e-5b7c1d2e3f40",
        name: "Other Install Agent",
      };
      foreign.metadata.vectorProvisioning.installationId = "other-install";
      const unmarked = { ...structuredClone(port.agents[0]), id: "0f5b7f4e-3a55-4d0b-9a0e-5b7c1d2e3f42", name: "Operator Agent", metadata: {} };
      port.agents.push(foreign, unmarked);
      const before = structuredClone(port.agents[0]);
      const input = await standardRevision(f, 2, "# Standard Chat v2\n");

      const upgraded = await reconcileVectorInstallation(port, input);
      expect(Object.keys(upgraded).sort()).toEqual([
        "agentId", "agentIds", "agentsCreated", "companyId", "created", "installationId",
        "manifestRevision", "profile", "rosterCatalogSha256", "schemaVersion", "workloadCatalogSha256",
      ]);
      expect(upgraded).toMatchObject({
        manifestRevision: 2,
        agentId: f.manifest.agent.id,
        agentIds: [f.manifest.agent.id],
        created: { company: false, ownership: false, agent: false },
        agentsCreated: 0,
      });
      const chat = port.agents.find((agent) => agent.id === f.manifest.agent.id);
      expect(chat.metadata.vectorProvisioning).toMatchObject({ manifestRevision: 2, rosterCatalogSha256: upgraded.rosterCatalogSha256 });
      expect(chat.metadata.vectorProvisioning.rosterCatalogSha256).not.toBe(before.metadata.vectorProvisioning.rosterCatalogSha256);
      expect(port.agents.find((agent) => agent.id === workerId).status).toBe("terminated");
      expect(port.terminated).toEqual([workerId]);
      // Agents without this installation's marker are never touched.
      expect(port.agents.find((agent) => agent.id === foreign.id)).toEqual(foreign);
      expect(port.agents.find((agent) => agent.id === unmarked.id)).toEqual(unmarked);

      const rerun = await reconcileVectorInstallation(port, input);
      expect(rerun).toEqual(upgraded);
      expect(port.terminated).toEqual([workerId]);
      expect(port.agents).toHaveLength(4);
    });

    it("fails closed without mutation when an active agent at the current revision is missing from the roster", async () => {
      const { f, port } = await revisionOneInstall();
      const before = structuredClone(port.agents);
      await expect(reconcileVectorInstallation(port, await standardRevision(f, 1, "# Standard Chat v1\n")))
        .rejects.toThrow("missing from the roster");
      expect(port.agents).toEqual(before);
      expect(port.terminated).toEqual([]);
    });

    it("refuses to retire an agent from a newer revision", async () => {
      const f = await fixture();
      const port = memoryPort();
      await reconcileVectorInstallation(port, await standardRevision(f, 1, "# Standard Chat v1\n"));
      port.agents.push(legacyWorker(port.agents[0], 3));
      const before = structuredClone(port.agents);
      await expect(reconcileVectorInstallation(port, await standardRevision(f, 2, "# Standard Chat v2\n")))
        .rejects.toThrow("downgrade refused");
      expect(port.agents).toEqual(before);
      expect(port.terminated).toEqual([]);
    });

    it("still fails closed on drift at the same revision", async () => {
      const f = await fixture();
      const port = memoryPort();
      await reconcileVectorInstallation(port, await standardRevision(f, 1, "# Standard Chat v1\n"));
      await expect(reconcileVectorInstallation(port, await standardRevision(f, 1, "# Standard Chat changed\n")))
        .rejects.toThrow("immutable field agent.metadata differs");
    });

    it("refuses a downgrade and never rewrites the agent", async () => {
      const { f, port } = await revisionOneInstall();
      port.agents[0].metadata.vectorProvisioning.manifestRevision = 3;
      const before = structuredClone(port.agents);
      await expect(reconcileVectorInstallation(port, await standardRevision(f, 2, "# Standard Chat v2\n")))
        .rejects.toThrow("downgrade refused");
      expect(port.agents).toEqual(before);
    });

    it.each([
      ["no provisioning marker", (metadata: any) => { delete metadata.vectorProvisioning; }, "no provisioning marker"],
      ["another installation", (metadata: any) => { metadata.vectorProvisioning.installationId = "other-install"; }, "another installation"],
      ["another profile", (metadata: any) => { metadata.vectorProvisioning.profile = "engineering"; }, "another installation"],
      ["an invalid revision", (metadata: any) => { metadata.vectorProvisioning.manifestRevision = "1"; }, "invalid manifest revision"],
    ])("refuses to upgrade an agent with %s", async (_label, mutate, message) => {
      const { f, port } = await revisionOneInstall();
      mutate(port.agents[0].metadata);
      await expect(reconcileVectorInstallation(port, await standardRevision(f, 2, "# Standard Chat v2\n")))
        .rejects.toThrow(message);
    });

    (embeddedPostgres.supported ? describe : describe.skip)("through the production agent service", () => {
      let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
      let db: ReturnType<typeof createDb>;

      beforeAll(async () => {
        database = await startEmbeddedPostgresTestDatabase("paperclip-vector-provision-upgrade-");
        db = createDb(database.connectionString);
      }, 90_000);

      afterAll(async () => {
        await db?.$client.end({ timeout: 0 });
        await database?.cleanup();
      });

      it("upgrades revision 1 to 2 in Postgres, terminates the dropped agent, and reruns idempotently", async () => {
        const f = await fixture();
        await provisionVectorInstallation(db, await standardRevision(f, 1, "# Standard Chat v1\n"));
        const chatRow = await db.select().from(agentsTable).where(eq(agentsTable.id, f.manifest.agent.id)).then((rows) => rows[0]!);
        const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...chatColumns } = chatRow;
        const workerMetadata = structuredClone(chatRow.metadata as any);
        workerMetadata.vectorProvisioning.manifestRevision = 1;
        await db.insert(agentsTable).values({
          ...chatColumns,
          id: workerId,
          name: "Implementation Worker",
          role: "implementation-worker",
          status: "idle",
          metadata: workerMetadata,
        });
        const input = await standardRevision(f, 2, "# Standard Chat v2\n");

        const upgraded = await provisionVectorInstallation(db, input);
        expect(upgraded).toMatchObject({ manifestRevision: 2, agentIds: [f.manifest.agent.id], agentsCreated: 0 });
        const chat = await db.select().from(agentsTable).where(eq(agentsTable.id, f.manifest.agent.id)).then((rows) => rows[0]!);
        expect((chat.metadata as any).vectorProvisioning.manifestRevision).toBe(2);
        expect(chat.status).not.toBe("terminated");
        const worker = await db.select().from(agentsTable).where(eq(agentsTable.id, workerId)).then((rows) => rows[0]!);
        expect(worker.status).toBe("terminated");

        const rerun = await provisionVectorInstallation(db, input);
        expect(rerun).toEqual(upgraded);
        const workerAfterRerun = await db.select().from(agentsTable).where(eq(agentsTable.id, workerId)).then((rows) => rows[0]!);
        expect(workerAfterRerun.status).toBe("terminated");
        expect(workerAfterRerun.updatedAt).toEqual(worker.updatedAt);
        await expect(provisionVectorInstallation(db, await standardRevision(f, 1, "# Standard Chat v1\n")))
          .rejects.toThrow("downgrade refused");
      });
    });

    it("keeps the name-collision check on upgrade", async () => {
      const f = await fixture();
      const port = memoryPort();
      await reconcileVectorInstallation(port, await standardRevision(f, 1, "# Standard Chat v1\n"));
      port.agents.push({ ...structuredClone(port.agents[0]), id: "0f5b7f4e-3a55-4d0b-9a0e-5b7c1d2e3f41", metadata: {} });
      const input = await standardRevision(f, 2, "# Standard Chat v2\n");
      await expect(reconcileVectorInstallation(port, input)).rejects.toThrow("agent identity collision");
    });
  });
});
