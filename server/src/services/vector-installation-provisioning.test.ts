import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agents as agentsTable,
  createDb,
  routineTriggers,
  routines,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  vectorInstallationOwnerships,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  provisionVectorInstallation,
  reconcileVectorInstallation,
  reconcileVectorRoutines,
  retiredVectorControlRoutines,
  vectorResearchRoutineSeeds,
  vectorScheduleRoutineSeeds,
  vectorInstallationManifestSchema,
  type VectorProvisioningPort,
  type VectorRoutineProvisioningPort,
} from "./vector-installation-provisioning.js";
import { syncInstructionsBundleConfigFromFilePath } from "./agent-instructions.js";
import { agentService } from "./agents.js";
import { instanceSettingsService } from "./instance-settings.js";

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
      tools: ["ask_user", "memory_forget", "memory_save", "memory_search", "todo_add", "todo_list", "todo_mark_done", "todo_update"],
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
  const researchPolicy = {
    leaseSeconds: 300, maxAttempts: 3, tokenBudget: 12000,
    mayDetach: true, mayWrite: false as const, requiresEvidence: true as const,
    modelPolicy: null,
    gatingFlag: "product.os.research",
    payloadFunction: "os.research_task_payload",
    promptFunction: "os.research_task_prompt",
    settlementFunction: null,
    escalationRole: null,
    lineage: { maxSpawnDepth: 0, allowInTurnChildren: false, allowedChildTypes: [] as string[], maxParallelChildren: 1 },
  };
  // Every Funky workload is a Paperclip routine issue: no Vector schedule,
  // lease recovery sweep, claim envelope or bridge.
  const nativeWorkload = (key: string, agentId: string, toolSurface: string[], dependencies: any[] = []) => ({
    key,
    title: `Research ${key}`,
    kind: "research_task",
    agentId,
    executionShape: "single_shot",
    promptSource: "paperclip_issue",
    toolSurface,
    policy: researchPolicy,
    runtimeAuthority: "paperclip",
    schedule: null,
    dependencies,
    recoverySchedule: null,
    bridge: null,
  });
  const scoutTools = ["research_ready_slices", "research_slice_payload", "research_record_finding"];
  const dmvTools = ["dmv.list_audit_back", "dmv.get_pipeline_health", "dmv.list_recent_pipeline_failures"];
  const restrictedPolicy = { profile, builtinTools: [], extensions: [{
    name: "vector.tool-bridge",
    tools: [
      "apply_audience_plan", "apply_campaign_plan", "apply_charter_plan", "apply_setting_plan",
      "consult_advisors", "describe_relation", "dmv.get_pipeline_health", "dmv.list_audit_back",
      "dmv.list_recent_pipeline_failures", "draft_action", "get_business_context", "inspect_audiences",
      "inspect_campaigns", "inspect_client_charter", "inspect_settings", "inspect_voice", "list_capabilities",
      "plan_audience_change", "plan_campaign_change", "plan_charter_change", "plan_setting_change",
      "present_strategy_plan", "pull_check_evidence", "query_data", "research_findings_today",
      "research_ready_slices", "research_record_curation", "research_record_finding", "research_slice_payload",
      "run_report", "verify_audience_plan", "verify_campaign_plan", "verify_charter_plan", "verify_setting_plan",
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
      nativeWorkload("current_scout", scoutId, scoutTools),
      nativeWorkload("macro_scout", scoutId, scoutTools),
      nativeWorkload("demand_scout", scoutId, scoutTools, [{
        kind: "schedule", key: "fa_rollup_query_themes",
        description: "Builds the query themes read by demand scout.",
        schedule: {
          owner: "vector_jobs" as const,
          scheduleKey: "fa_rollup_query_themes",
          targetSchema: "os",
          targetFunction: "rollup_query_themes",
          targetParameters: {},
          cronExpression: "40 2 * * *",
          timezone: "America/New_York",
          enabled: false as const,
        },
      }]),
      nativeWorkload("advisor", advisorId, ["research_record_finding", "pull_check_evidence"]),
      nativeWorkload("synthesis", scoutId, ["research_findings_today", "research_record_finding"], [
        { kind: "workload", key: "current_scout", description: "Current lens input.", schedule: null },
        { kind: "workload", key: "macro_scout", description: "Macro lens input.", schedule: null },
        { kind: "workload", key: "demand_scout", description: "Demand lens input.", schedule: null },
      ]),
      nativeWorkload("curation", scoutId, ["research_findings_today", "research_record_curation"], [
        { kind: "workload", key: "synthesis", description: "Curation waits for synthesis.", schedule: null },
      ]),
      {
        ...nativeWorkload("dmv_review", advisorId, dmvTools),
        title: "DMV daily intake review",
        kind: "generic_task",
        policy: {
          leaseSeconds: 900, maxAttempts: 2, tokenBudget: 8000,
          mayDetach: false, mayWrite: false as const, requiresEvidence: true as const,
          modelPolicy: null,
          gatingFlag: "product.dmv.review",
          payloadFunction: "dmv.review_payload", promptFunction: "dmv.review_prompt",
          settlementFunction: "dmv.review_settle", escalationRole: "compliance-advisor",
          lineage: { maxSpawnDepth: 0, allowInTurnChildren: false, allowedChildTypes: [] as string[], maxParallelChildren: 1 },
        },
      },
      {
        ...nativeWorkload("dmv_audit_back_triage", advisorId, dmvTools),
        title: "DMV audit-back triage",
        kind: "generic_task",
        executionShape: "session",
        policy: {
          leaseSeconds: 1200, maxAttempts: 2, tokenBudget: 24000,
          mayDetach: true, mayWrite: false as const, requiresEvidence: true as const,
          modelPolicy: null,
          gatingFlag: "product.dmv.triage",
          payloadFunction: "dmv.triage_payload", promptFunction: "dmv.triage_prompt",
          settlementFunction: "dmv.review_settle", escalationRole: "compliance-advisor",
          lineage: {
            maxSpawnDepth: 1, allowInTurnChildren: true,
            allowedChildTypes: ["dmv-client-reader", "reader"], maxParallelChildren: 2,
          },
        },
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
      [speakOnly, chatBridge],
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

  it.each(["staging", "production"] as const)("provisions a stable %s multi-agent roster with native research routines and no queue pumps", async (profile) => {
    const { f, manifest, restrictedPolicy, scoutId, advisorId } = await funkyServerFixture(profile);
    const port = memoryPort();
    const parsed = vectorInstallationManifestSchema.parse(manifest);
    const researchSeeds = vectorResearchRoutineSeeds(parsed);
    expect(researchSeeds.map((seed) => [seed.workloadKey, seed.assigneeAgentId, seed.cronExpression, seed.timezone, seed.enabledAtSeed]))
      .toEqual([
        ["advisor", advisorId, "40 8 * * *", "America/New_York", true],
        ["curation", scoutId, "50 9 * * *", "America/New_York", true],
        ["current_scout", scoutId, "20 8 * * *", "America/New_York", true],
        ["demand_scout", scoutId, "20 8 * * *", "America/New_York", true],
        ["dmv_audit_back_triage", advisorId, "0 8 * * *", "America/New_York", false],
        ["dmv_review", advisorId, "30 7 * * *", "America/New_York", false],
        ["macro_scout", scoutId, "20 8 * * *", "America/New_York", true],
        ["synthesis", scoutId, "20 9 * * *", "America/New_York", true],
      ]);
    expect(new Set(researchSeeds.flatMap((seed) => [seed.routineId, seed.triggerId])).size).toBe(16);
    // Only the query-theme rollup is still a Vector jobs schedule.
    const scheduleSeeds = vectorScheduleRoutineSeeds(parsed);
    expect(scheduleSeeds.map((seed) => seed.scheduleKey)).toEqual(["fa_rollup_query_themes"]);
    expect(scheduleSeeds[0]).toMatchObject({
      cronExpression: "* * * * *",
      timezone: "UTC",
      sourceCronExpression: "40 2 * * *",
      sourceTimezone: "America/New_York",
    });
    expect(retiredVectorControlRoutines(parsed).map((routine) => `${routine.originKind}:${routine.originId}`)).toEqual([
      "vector_workload_dispatch:research",
      "vector_workload_dispatch:tasks",
      "vector_schedule_dispatch:fa_research_daily",
      "vector_schedule_dispatch:fa_research_lease_sweep",
      "vector_schedule_dispatch:fa_task_lease_sweep",
      "vector_schedule_dispatch:fa_dmv_review_daily",
      "vector_schedule_dispatch:fa_dmv_audit_back_triage_daily",
    ]);
    const engineering = vectorInstallationManifestSchema.parse(f.manifest);
    expect(vectorResearchRoutineSeeds(engineering)).toEqual([]);
    expect(vectorScheduleRoutineSeeds(engineering)).toEqual([]);
    expect(retiredVectorControlRoutines(engineering)).toEqual([]);

    manifest.workloads[0].toolSurface = [...manifest.workloads[0].toolSurface, "query_data"];
    await expect(reconcileVectorInstallation(port, {
      ...f,
      manifest,
      selectedProfile: profile,
      effectiveToolPolicy: restrictedPolicy,
    })).rejects.toThrow(`${profile} workload current_scout does not match the Vector contract`);
    manifest.workloads[0].toolSurface = manifest.workloads[0].toolSurface.filter((tool) => tool !== "query_data");

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
        keys: ["curation", "current_scout", "demand_scout", "macro_scout", "synthesis"],
      },
    });
    // The declared tool surface the routine-run authority caps a run to.
    expect(port.agents[2].metadata.vectorWorkloads).toMatchObject({
      keys: ["advisor", "dmv_audit_back_triage", "dmv_review"],
      contracts: [
        { key: "advisor", role: "funky-advisor", runtimeAuthority: "paperclip", toolSurface: ["pull_check_evidence", "research_record_finding"] },
        {
          key: "dmv_audit_back_triage",
          runtimeAuthority: "paperclip",
          toolSurface: ["dmv.get_pipeline_health", "dmv.list_audit_back", "dmv.list_recent_pipeline_failures"],
        },
        { key: "dmv_review", runtimeAuthority: "paperclip" },
      ],
    });

    manifest.workloads[0].title = "Operator-edited workload title";
    await expect(reconcileVectorInstallation(port, {
      ...f,
      manifest,
      selectedProfile: profile,
      effectiveToolPolicy: restrictedPolicy,
    })).rejects.toThrow("immutable field agent.metadata differs");
  });

  it("refuses the retired Vector lease workload path on Funky profiles and names it", async () => {
    const { manifest } = await funkyServerFixture("production");
    const legacy = {
      ...manifest,
      workloads: manifest.workloads.map((workload) => workload.key === "current_scout"
        ? {
          ...workload,
          promptSource: "vector_claim_envelope",
          runtimeAuthority: "vector_lease_triple",
          bridge: {
            required: true, defaultEnabled: false,
            claimPath: "/inbound/vector-agents/research/claim",
            heartbeatPath: "/inbound/vector-agents/research/heartbeat",
            completePath: "/inbound/vector-agents/research/complete",
            failPath: "/inbound/vector-agents/research/fail",
            detachPath: "/inbound/vector-agents/research/detach",
          },
        }
        : workload),
    };
    const result = vectorInstallationManifestSchema.safeParse(legacy);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "production workload current_scout declares vector_claim_envelope/vector_lease_triple; Funky workloads run as Paperclip routine issues",
    );
    // A native workload may not keep a Vector jobs schedule or lease sweep.
    for (const patch of [
      { schedule: { ...manifest.workloads[2].dependencies[0].schedule, scheduleKey: "fa_research_daily" } },
      { recoverySchedule: { ...manifest.workloads[2].dependencies[0].schedule, scheduleKey: "fa_research_lease_sweep" } },
    ]) {
      const scheduled = vectorInstallationManifestSchema.safeParse({
        ...manifest,
        workloads: manifest.workloads.map((workload) => workload.key === "macro_scout" ? { ...workload, ...patch } : workload),
      });
      expect(scheduled.success).toBe(false);
      expect(JSON.stringify(scheduled.error?.issues)).toContain("production workload macro_scout does not match the Vector contract");
    }
    // The advisor is part of the catalog and belongs to Funky Advisor.
    const withoutAdvisorWorkload = vectorInstallationManifestSchema.safeParse({
      ...manifest,
      workloads: manifest.workloads.filter((workload) => workload.key !== "advisor"),
    });
    expect(JSON.stringify(withoutAdvisorWorkload.error?.issues)).toContain("production installs require the complete Vector workload catalog");
    const advisorOnScout = vectorInstallationManifestSchema.safeParse({
      ...manifest,
      workloads: manifest.workloads.map((workload) => workload.key === "advisor"
        ? { ...workload, agentId: manifest.additionalAgents[0].id }
        : workload),
    });
    expect(JSON.stringify(advisorOnScout.error?.issues)).toContain("production workload advisor does not match the Vector contract");
  });

  it("gives every research routine instructions that name only its own declared tools", async () => {
    const { manifest } = await funkyServerFixture("staging");
    const seeds = vectorResearchRoutineSeeds(vectorInstallationManifestSchema.parse(manifest));
    const knownTools = new Set(manifest.toolPolicy.extensions[0].tools);
    for (const seed of seeds) {
      const named = [...seed.description.matchAll(/`([a-z][a-z_.]+)`/g)].map((match) => match[1]).filter((name) => knownTools.has(name));
      expect(named.length, seed.workloadKey).toBeGreaterThan(0);
      expect(named.filter((tool) => !seed.toolSurface.includes(tool)), seed.workloadKey).toEqual([]);
      expect(seed.toolSurface.filter((tool) => !named.includes(tool)), seed.workloadKey).toEqual([]);
      expect(seed.description).toContain("Skipped: source not ready");
      expect(seed.description).toContain(`\`${seed.workloadKey}\``);
    }
  });

  describe("Funky routine reconciliation", () => {
    function memoryRoutinePort(): VectorRoutineProvisioningPort & { routines: any[]; triggers: any[] } {
      const routineRows: any[] = [];
      const triggerRows: any[] = [];
      return {
        routines: routineRows,
        triggers: triggerRows,
        getRoutine: async (companyId, id) => routineRows.find((row) => row.companyId === companyId && row.id === id) ?? null,
        createRoutine: async (input) => { routineRows.push({ ...input }); return routineRows.at(-1); },
        archiveRoutine: async (companyId, id) => {
          for (const row of routineRows) if (row.companyId === companyId && row.id === id) row.status = "archived";
        },
        getTrigger: async (companyId, id) => triggerRows.find((row) => row.companyId === companyId && row.id === id) ?? null,
        createTrigger: async (input) => { triggerRows.push({ ...input }); return triggerRows.at(-1); },
        disableRoutineTriggers: async (companyId, routineId) => {
          for (const row of triggerRows) {
            if (row.companyId === companyId && row.routineId === routineId) Object.assign(row, { enabled: false, nextRunAt: null });
          }
        },
      };
    }

    const now = new Date("2026-09-30T16:00:00.000Z"); // 12:00 America/New_York

    it("seeds one issue-creating routine per workload, the rollup schedule, and nothing else", async () => {
      const { manifest, scoutId, advisorId } = await funkyServerFixture("production");
      const parsed = vectorInstallationManifestSchema.parse(manifest);
      const port = memoryRoutinePort();
      await reconcileVectorRoutines(port, parsed, now);
      const research = port.routines.filter((row) => row.originKind === "vector_research_workload");
      expect(research.map((row) => row.originId).sort()).toEqual([
        "advisor", "curation", "current_scout", "demand_scout",
        "dmv_audit_back_triage", "dmv_review", "macro_scout", "synthesis",
      ]);
      for (const row of research) {
        expect(row).toMatchObject({
          companyId: manifest.company.id,
          status: "active",
          concurrencyPolicy: "skip_if_active",
          catchUpPolicy: "skip_missed",
        });
        expect(row.assigneeAgentId).toBe(["advisor", "dmv_review", "dmv_audit_back_triage"].includes(row.originId) ? advisorId : scoutId);
      }
      expect(port.routines.filter((row) => row.originKind !== "vector_research_workload").map((row) => `${row.originKind}:${row.originId}`))
        .toEqual(["vector_schedule_dispatch:fa_rollup_query_themes"]);
      const triggerFor = (key: string) => {
        const routine = port.routines.find((row) => row.originId === key)!;
        return port.triggers.find((row) => row.routineId === routine.id)!;
      };
      // 08:20 America/New_York on 2026-10-01 is 12:20 UTC (EDT).
      expect(triggerFor("current_scout")).toMatchObject({
        kind: "schedule", cronExpression: "20 8 * * *", timezone: "America/New_York", enabled: true,
        nextRunAt: new Date("2026-10-01T12:20:00.000Z"),
      });
      expect(triggerFor("advisor")).toMatchObject({ enabled: true, nextRunAt: new Date("2026-10-01T12:40:00.000Z") });
      expect(triggerFor("synthesis")).toMatchObject({ enabled: true, nextRunAt: new Date("2026-10-01T13:20:00.000Z") });
      expect(triggerFor("curation")).toMatchObject({ enabled: true, nextRunAt: new Date("2026-10-01T13:50:00.000Z") });
      for (const key of ["dmv_review", "dmv_audit_back_triage", "fa_rollup_query_themes"]) {
        expect(triggerFor(key)).toMatchObject({ enabled: false, nextRunAt: null });
      }

      const before = structuredClone({ routines: port.routines, triggers: port.triggers });
      await reconcileVectorRoutines(port, parsed, new Date("2026-10-02T00:00:00.000Z"));
      expect({ routines: port.routines, triggers: port.triggers }).toEqual(before);
    });

    it("archives the queue pumps and replaced Vector schedules with their triggers disabled, keeping the rows", async () => {
      const { manifest, scoutId, advisorId } = await funkyServerFixture("production");
      const parsed = vectorInstallationManifestSchema.parse(manifest);
      const port = memoryRoutinePort();
      // What an earlier release left behind, enabled by the operator.
      for (const retired of retiredVectorControlRoutines(parsed)) {
        port.routines.push({
          id: retired.routineId, companyId: retired.companyId, title: "legacy", description: "legacy",
          assigneeAgentId: retired.originId === "tasks" ? advisorId : scoutId, priority: "medium", status: "active",
          concurrencyPolicy: "coalesce_if_active", catchUpPolicy: "skip_missed",
          activityGatePolicy: "always", activityGateScope: "company",
          originKind: retired.originKind, originId: retired.originId,
        });
        port.triggers.push({
          id: `${retired.routineId}-trigger`, companyId: retired.companyId, routineId: retired.routineId,
          kind: "schedule", label: "legacy", enabled: true, cronExpression: "* * * * *", timezone: "UTC",
          nextRunAt: new Date("2026-09-30T16:01:00.000Z"),
        });
      }
      await reconcileVectorRoutines(port, parsed, now);
      const retiredIds = new Set(retiredVectorControlRoutines(parsed).map((routine) => routine.routineId));
      const retiredRows = port.routines.filter((row) => retiredIds.has(row.id));
      expect(retiredRows).toHaveLength(7);
      expect(retiredRows.every((row) => row.status === "archived")).toBe(true);
      const retiredTriggers = port.triggers.filter((row) => retiredIds.has(row.routineId));
      expect(retiredTriggers).toHaveLength(7);
      expect(retiredTriggers.every((row) => row.enabled === false && row.nextRunAt === null)).toBe(true);
      expect(port.routines.filter((row) => row.status === "active")).toHaveLength(9);
      await expect(reconcileVectorRoutines(port, parsed, now)).resolves.toBeUndefined();
    });

    it("keeps operator enablement and pause, but fails closed on sealed drift", async () => {
      const { manifest } = await funkyServerFixture("staging");
      const parsed = vectorInstallationManifestSchema.parse(manifest);
      const port = memoryRoutinePort();
      await reconcileVectorRoutines(port, parsed, now);
      const macro = port.routines.find((row) => row.originId === "macro_scout")!;
      const macroTrigger = port.triggers.find((row) => row.routineId === macro.id)!;
      const dmv = port.routines.find((row) => row.originId === "dmv_review")!;
      const dmvTrigger = port.triggers.find((row) => row.routineId === dmv.id)!;
      macro.status = "paused";
      Object.assign(macroTrigger, { enabled: false, nextRunAt: null });
      Object.assign(dmvTrigger, { enabled: true, nextRunAt: new Date("2026-10-01T11:30:00.000Z") });
      await reconcileVectorRoutines(port, parsed, now);
      expect(macro.status).toBe("paused");
      expect(macroTrigger).toMatchObject({ enabled: false, nextRunAt: null });
      expect(dmvTrigger).toMatchObject({ enabled: true });

      const description = macro.description;
      macro.description = "board edit";
      await expect(reconcileVectorRoutines(port, parsed, now)).rejects.toThrow("immutable field vectorResearchRoutine differs");
      macro.description = description;
      macro.concurrencyPolicy = "always_enqueue";
      await expect(reconcileVectorRoutines(port, parsed, now)).rejects.toThrow("immutable field vectorResearchRoutine differs");
      macro.concurrencyPolicy = "skip_if_active";
      macroTrigger.cronExpression = "0 6 * * *";
      await expect(reconcileVectorRoutines(port, parsed, now)).rejects.toThrow("immutable field vectorResearchRoutineTrigger differs");
      macroTrigger.cronExpression = "20 8 * * *";
      await expect(reconcileVectorRoutines(port, parsed, now)).resolves.toBeUndefined();
    });

    it("refuses to archive a row at a retired id that is not the retired routine", async () => {
      const { manifest } = await funkyServerFixture("staging");
      const parsed = vectorInstallationManifestSchema.parse(manifest);
      const port = memoryRoutinePort();
      const [pump] = retiredVectorControlRoutines(parsed);
      port.routines.push({
        id: pump!.routineId, companyId: pump!.companyId, title: "someone else's", description: null,
        assigneeAgentId: null, priority: "medium", status: "active",
        concurrencyPolicy: "coalesce_if_active", catchUpPolicy: "skip_missed",
        activityGatePolicy: "always", activityGateScope: "company",
        originKind: "manual", originId: null,
      });
      await expect(reconcileVectorRoutines(port, parsed, now)).rejects.toThrow("immutable field retiredVectorControlRoutine differs");
      expect(port.routines[0].status).toBe("active");
    });
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
    expect(vectorResearchRoutineSeeds(vectorInstallationManifestSchema.parse({
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
      return [
        ...vectorResearchRoutineSeeds(parsed).flatMap((seed) => [seed.routineId, seed.triggerId]),
        ...vectorScheduleRoutineSeeds(parsed).flatMap((seed) => [seed.routineId, seed.triggerId]),
        ...retiredVectorControlRoutines(parsed).map((routine) => routine.routineId),
      ];
    };
    const stagingSeedIds = seedIds(staging.manifest);
    const productionSeedIds = seedIds(production.manifest);
    expect(stagingSeedIds).toHaveLength(25);
    expect(productionSeedIds).toHaveLength(25);
    expect(new Set([...stagingSeedIds, ...productionSeedIds]).size).toBe(50);

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

    it("provisions a production install in Postgres with the staging roster and native research routines", async () => {
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
        "vector_research_workload:advisor",
        "vector_research_workload:curation",
        "vector_research_workload:current_scout",
        "vector_research_workload:demand_scout",
        "vector_research_workload:dmv_audit_back_triage",
        "vector_research_workload:dmv_review",
        "vector_research_workload:macro_scout",
        "vector_research_workload:synthesis",
        "vector_schedule_dispatch:fa_rollup_query_themes",
      ]);
      expect(triggerRows).toHaveLength(9);
      const enabledLabels = triggerRows.filter((row) => row.enabled).map((row) => row.label).sort();
      expect(enabledLabels).toEqual([
        "advisor schedule", "curation schedule", "current_scout schedule",
        "demand_scout schedule", "macro_scout schedule", "synthesis schedule",
      ]);
      expect(triggerRows.every((row) => row.enabled === (row.nextRunAt !== null))).toBe(true);

      expect((await instanceSettingsService(db).getExperimental()).enableAgentChat).toBe(true);
      // A board toggle-off is restored by the next install: ingress depends on it.
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: false });
      const rerun = await provisionVectorInstallation(db, input);
      expect(rerun).toEqual({ ...receipt, created: { company: false, ownership: false, agent: false }, agentsCreated: 0 });
      expect((await instanceSettingsService(db).getExperimental()).enableAgentChat).toBe(true);
      expect((await provisionedRoutines(production.manifest.company.id)).triggerRows).toHaveLength(9);
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
      expect(stagingRoutines.routineRows).toHaveLength(9);
      expect(productionRoutines.routineRows).toHaveLength(9);
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

  describe("operator-owned adapterConfig keys and board instructions metadata", () => {
    const body = "# FunkyDev\n";
    const sha = createHash("sha256").update(body).digest("hex");
    const relative = "paperclip/profile-assets/engineering/funkydev/AGENTS.md";

    /**
     * The active release as fdctl lays it out: `current` is a symlink to a
     * versioned release directory holding the sealed persona.
     */
    async function releaseFixture(options: { operatorOwned?: string[] } = {}) {
      const f = await fixture();
      const versioned = path.join(path.dirname(f.activeReleaseRoot), "0062b83");
      await fs.mkdir(path.dirname(path.join(versioned, relative)), { recursive: true });
      await fs.writeFile(path.join(versioned, relative), body);
      await fs.symlink(versioned, f.activeReleaseRoot);
      (f.manifest.agent as any).operatorOwnedAdapterConfigKeys = options.operatorOwned ?? ["model", "thinking"];
      const input = { ...f, selectedProfile: "engineering", effectiveToolPolicy: f.toolPolicy };
      return { f, input, versioned, canonical: path.join(f.activeReleaseRoot, relative) };
    }

    /** Exactly what a board save does to adapterConfig (routes/agents.ts). */
    function boardSave(agent: any, patch: Record<string, unknown>) {
      return syncInstructionsBundleConfigFromFilePath(agent, { ...agent.adapterConfig, ...patch });
    }

    function countingPort() {
      const port = memoryPort();
      const updates: unknown[] = [];
      const update = port.updateAgent;
      port.updateAgent = async (id, patch) => { updates.push(structuredClone(patch)); return update(id, patch); };
      return { port, updates };
    }

    it("rejects duplicate or redundant operator-owned keys and unknown keys", async () => {
      const { f } = await releaseFixture();
      for (const [keys, mutable] of [
        [["model", "model"], []],
        [["model"], ["adapterConfig"]],
        [["cwd"], []],
        [["instructionsFilePath"], []],
      ] as const) {
        const manifest = structuredClone(f.manifest) as any;
        manifest.agent.operatorOwnedAdapterConfigKeys = keys;
        manifest.agent.mutableFields = mutable;
        expect(vectorInstallationManifestSchema.safeParse(manifest).success).toBe(false);
      }
      const legacy = structuredClone(f.manifest) as any;
      delete legacy.agent.operatorOwnedAdapterConfigKeys;
      expect(vectorInstallationManifestSchema.parse(legacy).agent.operatorOwnedAdapterConfigKeys).toEqual([]);
    });

    it("creates with the seed value, then preserves board model and thinking across reinstalls and upgrades", async () => {
      const { f, input, canonical } = await releaseFixture();
      const { port, updates } = countingPort();
      await reconcileVectorInstallation(port, input);
      expect(port.agents[0].adapterConfig).toEqual({ ...f.manifest.agent.adapterConfig, instructionsFilePath: canonical });
      expect(port.agents[0].metadata.vectorProvisioning.instructionsSha256).toBe(sha);

      port.agents[0].adapterConfig = { ...port.agents[0].adapterConfig, model: "router/Other-Model", thinking: "medium" };
      await reconcileVectorInstallation(port, input);
      expect(updates).toEqual([]);
      expect(port.agents[0].adapterConfig).toMatchObject({ model: "router/Other-Model", thinking: "medium" });

      const next = structuredClone(input);
      next.manifest.manifestRevision = 2;
      next.manifest.agent.adapterConfig.thinking = "low";
      next.manifest.agent.adapterConfig.cwd = "/home/funkydev/work";
      await reconcileVectorInstallation(port, next);
      expect(port.agents[0].adapterConfig).toEqual({
        model: "router/Other-Model",
        thinking: "medium",
        executionMode: "rpc",
        cwd: "/home/funkydev/work",
        instructionsFilePath: canonical,
      });
      await reconcileVectorInstallation(port, next);
      expect(updates).toHaveLength(1);
    });

    it("keeps every other adapterConfig key sealed, and keys not declared operator-owned sealed too", async () => {
      const { input } = await releaseFixture({ operatorOwned: ["model"] });
      const port = memoryPort();
      await reconcileVectorInstallation(port, input);
      const created = structuredClone(port.agents[0]);
      for (const [key, value] of [["thinking", "medium"], ["cwd", "/tmp"], ["executionMode", "json"], ["extensions", ["x"]]] as const) {
        port.agents[0] = { ...structuredClone(created), adapterConfig: { ...created.adapterConfig, [key]: value } };
        const before = structuredClone(port.agents);
        await expect(reconcileVectorInstallation(port, input)).rejects.toThrow(`immutable field agent.adapterConfig.${key} differs`);
        expect(port.agents).toEqual(before);
      }
    });

    it("rejects an invalid operator-owned value instead of preserving it", async () => {
      const { input } = await releaseFixture();
      const port = memoryPort();
      await reconcileVectorInstallation(port, input);
      port.agents[0].adapterConfig.thinking = "extreme";
      await expect(reconcileVectorInstallation(port, input)).rejects.toThrow("operator-owned adapterConfig.thinking is invalid");
    });

    it("same content with board metadata: normalizes to the release's canonical instructions idempotently", async () => {
      const { f, input, versioned, canonical } = await releaseFixture();
      const { port, updates } = countingPort();
      await reconcileVectorInstallation(port, input);
      // The board saved a thinking change and rewrote the path to the real
      // (symlink-resolved) release directory, adding its bundle metadata.
      const edited = boardSave(port.agents[0], { thinking: "medium", instructionsFilePath: path.join(versioned, relative) });
      expect(edited).toMatchObject({ instructionsBundleMode: "external", instructionsEntryFile: "AGENTS.md" });
      expect(edited.instructionsFilePath).not.toBe(canonical);
      port.agents[0].adapterConfig = edited;

      const receipt = await reconcileVectorInstallation(port, input);
      expect(receipt.created.agent).toBe(false);
      expect(port.agents[0].adapterConfig).toEqual({
        ...f.manifest.agent.adapterConfig,
        thinking: "medium",
        instructionsFilePath: canonical,
      });
      expect(updates).toHaveLength(1);
      await reconcileVectorInstallation(port, input);
      expect(updates).toHaveLength(1);
    });

    it("same content with board metadata on a revision upgrade from a marker without a recorded digest", async () => {
      const { input, canonical } = await releaseFixture();
      const port = memoryPort();
      await reconcileVectorInstallation(port, input);
      delete port.agents[0].metadata.vectorProvisioning.instructionsSha256;
      port.agents[0].adapterConfig = boardSave(port.agents[0], { thinking: "medium" });
      const next = structuredClone(input);
      next.manifest.manifestRevision = 2;
      await reconcileVectorInstallation(port, next);
      expect(port.agents[0].adapterConfig).toMatchObject({ thinking: "medium", instructionsFilePath: canonical });
      expect(port.agents[0].adapterConfig).not.toHaveProperty("instructionsBundleMode");
      expect(port.agents[0].metadata.vectorProvisioning).toMatchObject({ manifestRevision: 2, instructionsSha256: input.manifest.agent.instructions.sha256 });
    });

    it("an upgrade that ships a new persona proves the live file against the digest last provisioned", async () => {
      const { f, input, canonical } = await releaseFixture();
      const port = memoryPort();
      await reconcileVectorInstallation(port, input);
      port.agents[0].adapterConfig = boardSave(port.agents[0], { thinking: "medium" });
      const v2 = "# FunkyDev v2\n";
      await fs.writeFile(path.join(f.stagedReleaseRoot, relative), v2);
      const next = structuredClone(input);
      next.manifest.manifestRevision = 2;
      next.manifest.agent.instructions.sha256 = createHash("sha256").update(v2).digest("hex");
      await reconcileVectorInstallation(port, next);
      expect(port.agents[0].adapterConfig).toMatchObject({ thinking: "medium", instructionsFilePath: canonical });
      expect(port.agents[0].metadata.vectorProvisioning.instructionsSha256).toBe(next.manifest.agent.instructions.sha256);
    });

    it("different content: fails closed naming the agent and both digests, without mutation", async () => {
      const { input, versioned } = await releaseFixture();
      const port = memoryPort();
      await reconcileVectorInstallation(port, input);
      // A board persona edit: the bundle is switched to a copy with new text.
      const managed = path.join(path.dirname(versioned), "board-copy");
      await fs.mkdir(managed, { recursive: true });
      await fs.writeFile(path.join(managed, "AGENTS.md"), "# FunkyDev, edited on the board\n");
      port.agents[0].adapterConfig = boardSave(port.agents[0], { instructionsFilePath: path.join(managed, "AGENTS.md") });
      const liveSha = createHash("sha256").update("# FunkyDev, edited on the board\n").digest("hex");
      const before = structuredClone(port.agents);
      for (const revision of [1, 2]) {
        const attempt = structuredClone(input);
        attempt.manifest.manifestRevision = revision;
        const error = await reconcileVectorInstallation(port, attempt).catch((err: Error) => err);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("FunkyDev instructions differ from the release");
        expect((error as Error).message).toContain(`live sha256 ${liveSha}`);
        expect((error as Error).message).toContain(`release sha256 ${sha}`);
        expect(port.agents).toEqual(before);
      }
    });

    it("different content: an in-place edit of the release file or a missing file also fails closed", async () => {
      const { input, versioned } = await releaseFixture();
      const port = memoryPort();
      await reconcileVectorInstallation(port, input);
      port.agents[0].adapterConfig = boardSave(port.agents[0], { thinking: "medium" });
      await fs.writeFile(path.join(versioned, relative), "# rewritten in place\n");
      await expect(reconcileVectorInstallation(port, input)).rejects.toThrow("FunkyDev instructions differ from the release");
      await fs.rm(path.join(versioned, relative));
      await expect(reconcileVectorInstallation(port, input)).rejects.toThrow("live sha256 unreadable");
      port.agents[0].adapterConfig = boardSave(port.agents[0], { instructionsFilePath: "" });
      await expect(reconcileVectorInstallation(port, input)).rejects.toThrow("FunkyDev instructions were removed on the board");
    });

    it("no board metadata: a reinstall is a no-op and never reads or rewrites instructions", async () => {
      const { input, versioned } = await releaseFixture();
      const { port, updates } = countingPort();
      await reconcileVectorInstallation(port, input);
      const before = structuredClone(port.agents);
      // Content is not consulted when the release's own canonical path is live.
      await fs.writeFile(path.join(versioned, relative), "# release file replaced by the next install\n");
      await reconcileVectorInstallation(port, input);
      expect(port.agents).toEqual(before);
      expect(updates).toEqual([]);
    });

    it("no board metadata: an equivalent path form with the same content is normalized, a different file is refused", async () => {
      const { input, versioned, canonical } = await releaseFixture();
      const port = memoryPort();
      await reconcileVectorInstallation(port, input);
      port.agents[0].adapterConfig.instructionsFilePath = path.join(versioned, relative);
      await reconcileVectorInstallation(port, input);
      expect(port.agents[0].adapterConfig.instructionsFilePath).toBe(canonical);
      port.agents[0].adapterConfig.instructionsFilePath = "/etc/hosts";
      await expect(reconcileVectorInstallation(port, input)).rejects.toThrow("FunkyDev instructions differ from the release");
    });

    (embeddedPostgres.supported ? describe : describe.skip)("through the production agent service", () => {
      let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
      let db: ReturnType<typeof createDb>;

      beforeAll(async () => {
        database = await startEmbeddedPostgresTestDatabase("paperclip-vector-provision-operator-");
        db = createDb(database.connectionString);
      }, 90_000);

      afterAll(async () => {
        await db?.$client.end({ timeout: 0 });
        await database?.cleanup();
      });

      it("installs over the live t480 FunkyDev board edit (thinking=medium, board bundle metadata, same persona)", async () => {
        const { f, input, versioned, canonical } = await releaseFixture();
        // The revision the live agent was provisioned at, before operator ownership existed.
        const legacy = structuredClone(input);
        delete (legacy.manifest.agent as any).operatorOwnedAdapterConfigKeys;
        await provisionVectorInstallation(db, legacy);
        const service = agentService(db);
        const row = await service.getById(f.manifest.agent.id);
        const legacyMetadata = structuredClone(row!.metadata as any);
        delete legacyMetadata.vectorProvisioning.instructionsSha256;
        await service.update(f.manifest.agent.id, {
          metadata: legacyMetadata,
          adapterConfig: boardSave(row, { thinking: "medium", instructionsFilePath: path.join(versioned, relative) }),
        });
        // Without operator ownership the old contract still refuses it.
        await expect(provisionVectorInstallation(db, legacy)).rejects.toThrow("drift");

        const next = structuredClone(input);
        next.manifest.manifestRevision = 2;
        const receipt = await provisionVectorInstallation(db, next);
        expect(receipt).toMatchObject({ manifestRevision: 2, agentsCreated: 0 });
        const upgraded = await db.select().from(agentsTable).where(eq(agentsTable.id, f.manifest.agent.id)).then((rows) => rows[0]!);
        expect(upgraded.adapterConfig).toEqual({ ...f.manifest.agent.adapterConfig, thinking: "medium", instructionsFilePath: canonical });
        expect(await provisionVectorInstallation(db, next)).toEqual(receipt);
        const rerun = await db.select().from(agentsTable).where(eq(agentsTable.id, f.manifest.agent.id)).then((rows) => rows[0]!);
        expect(rerun.updatedAt).toEqual(upgraded.updatedAt);

        // A second board edit at the new revision normalizes in place.
        await service.update(f.manifest.agent.id, { adapterConfig: boardSave(rerun, { model: "router/Other-Model" }) });
        await provisionVectorInstallation(db, next);
        const normalized = await db.select().from(agentsTable).where(eq(agentsTable.id, f.manifest.agent.id)).then((rows) => rows[0]!);
        expect(normalized.adapterConfig).toEqual({
          ...f.manifest.agent.adapterConfig, model: "router/Other-Model", thinking: "medium", instructionsFilePath: canonical,
        });
      });
    });
  });

  describe("engineering software org (FunkyDev roster with a reporting hierarchy)", () => {
    // vector-os b0c991e contracts/PAPERCLIP_ENGINEERING_SEED.json (revision 9)
    // and its parent's revision 8, copied verbatim.
    const fixtureDir = path.join(path.dirname(new URL(import.meta.url).pathname), "../__tests__/fixtures");
    const readSeed = async (name: string) => JSON.parse(await fs.readFile(path.join(fixtureDir, name), "utf8"));
    const funkyDevId = "e5b45684-168d-51af-9bb4-e9a5d96f6329";

    /** The provisioner's deterministic UUID recipe, restated as the contract Vector relies on. */
    function deterministicUuid(identity: string) {
      const hex = createHash("sha256").update(identity).digest("hex").slice(0, 32).split("");
      hex[12] = "5";
      hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
      const value = hex.join("");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    }

    /**
     * The real seed with each persona staged. The staged bodies stand in for
     * vector-os's AGENTS.md files, so only the instruction digests change.
     */
    async function seedInput(name = "vector-engineering-seed-r9.json") {
      const f = await fixture();
      const manifest = await readSeed(name);
      for (const agent of [manifest.agent, ...(manifest.additionalAgents ?? [])]) {
        const body = `# ${agent.name}\n`;
        const staged = path.join(f.stagedReleaseRoot, agent.instructions.path);
        await fs.mkdir(path.dirname(staged), { recursive: true });
        await fs.writeFile(staged, body);
        agent.instructions.sha256 = createHash("sha256").update(body).digest("hex");
      }
      return { ...f, manifest, toolPolicy: manifest.toolPolicy, selectedProfile: "engineering", effectiveToolPolicy: manifest.toolPolicy };
    }

    const seats = (manifest: any) => [manifest.agent, ...manifest.additionalAgents];
    const byRole = (manifest: any, role: string) => seats(manifest).find((agent: any) => agent.role === role);

    function countingPort() {
      const port = memoryPort();
      const updates: Array<{ id: string; patch: unknown }> = [];
      const update = port.updateAgent;
      port.updateAgent = async (id, patch) => { updates.push({ id, patch: structuredClone(patch) }); return update(id, patch); };
      return { port, updates };
    }

    it("accepts the vector-os revision 9 seed verbatim, with deterministic seat ids and managers declared first", async () => {
      const seed = await readSeed("vector-engineering-seed-r9.json");
      const parsed = vectorInstallationManifestSchema.parse(seed);
      expect(parsed.manifestRevision).toBe(9);
      expect(parsed.agent).toMatchObject({ id: funkyDevId, name: "FunkyDev", role: "engineer", reportsTo: null });
      expect(parsed.additionalAgents).toHaveLength(10);
      for (const agent of parsed.additionalAgents) {
        expect(agent.id).toBe(deterministicUuid(`t480-engineering:paperclip-agent:${agent.role}`));
      }
      const reportsTo = Object.fromEntries(seats(parsed).map((agent: any) => [
        agent.role, seats(parsed).find((manager: any) => manager.id === agent.reportsTo)?.role ?? null,
      ]));
      expect(reportsTo).toEqual({
        "engineer": null,
        "frontend-manager": "engineer",
        "backend-manager": "engineer",
        "database-manager": "engineer",
        "infrastructure-manager": "engineer",
        "frontend-engineer": "frontend-manager",
        "backend-engineer": "backend-manager",
        "database-engineer": "database-manager",
        "infrastructure-engineer": "infrastructure-manager",
        "product-qa": "engineer",
        "platform-qa": "engineer",
      });
      // The revision 8 seed (FunkyDev alone, no reportsTo field) stays valid.
      expect(vectorInstallationManifestSchema.parse(await readSeed("vector-engineering-seed-r8.json")).agent.reportsTo).toBeNull();
    });

    it("rejects forward, self, cyclic and unknown managers, a led-by-anyone-else org, and unmanaged seats", async () => {
      const seed = await readSeed("vector-engineering-seed-r9.json");
      const reject = (mutate: (manifest: any) => void, message: string) => {
        const manifest = structuredClone(seed);
        mutate(manifest);
        const result = vectorInstallationManifestSchema.safeParse(manifest);
        expect(result.success).toBe(false);
        expect(result.error!.issues.map((issue) => issue.message)).toContain(message);
      };
      const earlier = "agent reportsTo must name an agent declared earlier in the manifest";
      // An engineer declared before its manager.
      reject((manifest) => {
        const engineer = manifest.additionalAgents.splice(4, 1)[0];
        manifest.additionalAgents.unshift(engineer);
      }, earlier);
      // Self reference.
      reject((manifest) => { manifest.additionalAgents[0].reportsTo = manifest.additionalAgents[0].id; }, earlier);
      // A two-seat cycle is always a forward reference for one of them.
      reject((manifest) => { manifest.additionalAgents[0].reportsTo = manifest.additionalAgents[4].id; }, earlier);
      // An id that no seat declares.
      reject((manifest) => { manifest.additionalAgents[0].reportsTo = "0f5b7f4e-3a55-4d0b-9a0e-5b7c1d2e3f40"; }, earlier);
      // FunkyDev leads and reports to no agent.
      reject((manifest) => { manifest.agent.reportsTo = manifest.additionalAgents[0].id; }, earlier);
      reject((manifest) => { manifest.agent.reportsTo = funkyDevId; }, earlier);
      const led = "engineering installs are led by the FunkyDev engineer, reporting to no agent";
      // The primary must be FunkyDev: another seat in first position is refused.
      reject((manifest) => {
        const manager = manifest.additionalAgents.shift();
        manager.reportsTo = null;
        manifest.additionalAgents.unshift({ ...manifest.agent, reportsTo: manager.id });
        manifest.agent = manager;
      }, led);
      reject((manifest) => { manifest.agent.role = "frontend-manager"; manifest.additionalAgents[0].role = "engineer"; }, led);
      reject((manifest) => {
        manifest.additionalAgents[0].reportsTo = null;
      }, "every engineering seat other than FunkyDev must report to an agent declared before it");
      reject((manifest) => { manifest.additionalAgents[1].role = manifest.additionalAgents[0].role; }, "agent roles must be unique");
      reject((manifest) => { manifest.additionalAgents[1].id = manifest.additionalAgents[0].id; }, "agent ids must be unique");
      reject((manifest) => { manifest.additionalAgents[1].name = "FunkyDev"; }, "agent names must be unique");
      // Seats never own Funky workloads.
      const staging = await funkyServerFixture("staging");
      reject((manifest) => {
        manifest.workloads = [{ ...staging.manifest.workloads[0], agentId: manifest.additionalAgents[5].id }];
      }, "engineering installs do not own Funky workload schedules");
      reject((manifest) => { manifest.additionalAgents[0].reportsTo = "not-a-uuid"; }, "Invalid UUID");
    });

    it("applies the same earlier-declared rule to other profiles and leaves flat rosters untouched", async () => {
      const { manifest } = await funkyServerFixture("staging");
      const parsed = vectorInstallationManifestSchema.parse(manifest);
      expect(seats(parsed).map((agent: any) => agent.reportsTo)).toEqual([null, null, null]);
      const [scout, advisor] = manifest.additionalAgents as any[];
      expect(vectorInstallationManifestSchema.safeParse({
        ...manifest,
        additionalAgents: [{ ...scout, reportsTo: manifest.agent.id }, { ...advisor, reportsTo: manifest.agent.id }],
      }).success).toBe(true);
      expect(vectorInstallationManifestSchema.safeParse({
        ...manifest,
        additionalAgents: [{ ...scout, reportsTo: advisor.id }, advisor],
      }).success).toBe(false);
      expect(vectorInstallationManifestSchema.safeParse({
        ...manifest,
        agent: { ...manifest.agent, reportsTo: scout.id },
      }).success).toBe(false);
    });

    it("keeps the roster digest of flat standard and Funky server rosters exactly as before reportsTo existed", async () => {
      // Pinned from the provisioner at acff475, before the field existed. A
      // changed digest would fail every same-revision reinstall of a live
      // install as metadata drift.
      const f = await fixture();
      const standardPort = memoryPort();
      const standardPolicy = {
        profile: "standard",
        builtinTools: [],
        extensions: [f.toolPolicy.extensions[1], f.toolPolicy.extensions[2]],
      };
      const standard = await reconcileVectorInstallation(standardPort, {
        ...f,
        manifest: { ...f.manifest, profile: "standard", installationId: "standard-stecke1", agent: { ...f.manifest.agent, name: "Standard Chat", role: "standard-chat" }, toolPolicy: standardPolicy },
        selectedProfile: "standard",
        effectiveToolPolicy: standardPolicy,
      });
      expect(standard.rosterCatalogSha256).toBe("5501ec0ed99d2ac65f96f50d3f2dae17763bb7da71bb9ac6f4efae91a3f97e91");
      const funky = await funkyServerFixture("staging");
      const stagingPort = memoryPort();
      const staging = await reconcileVectorInstallation(stagingPort, {
        ...funky.f,
        manifest: funky.manifest,
        selectedProfile: "staging",
        effectiveToolPolicy: funky.restrictedPolicy,
      });
      // Re-pinned when the Funky tool policy gained the native research tools
      // (the roster digest covers the tool policy). That change ships with a
      // manifest revision bump, so no same-revision reinstall sees it.
      expect(staging.rosterCatalogSha256).toBe("5ca05a7e1624b433f6c12ed9d48712b658a34b2b28d51be75a24cae21588630f");
      // reportsTo is not a declared field of a flat roster: nothing is written,
      // and a board edit of it is neither asserted nor reverted.
      for (const agent of [...standardPort.agents, ...stagingPort.agents]) expect(agent).not.toHaveProperty("reportsTo");
      const scout = stagingPort.agents[1];
      scout.reportsTo = stagingPort.agents[0].id;
      await expect(reconcileVectorInstallation(stagingPort, {
        ...funky.f,
        manifest: funky.manifest,
        selectedProfile: "staging",
        effectiveToolPolicy: funky.restrictedPolicy,
      })).resolves.toEqual({ ...staging, created: { company: false, ownership: false, agent: false }, agentsCreated: 0 });
      expect(scout.reportsTo).toBe(stagingPort.agents[0].id);
    });

    it("creates the eleven-seat org in manifest order with its hierarchy, then reruns as a no-op", async () => {
      const input = await seedInput();
      const { port, updates } = countingPort();
      const created: string[] = [];
      const create = port.createAgent;
      port.createAgent = async (companyId, agent) => {
        // Every manager already exists when a report is created.
        if (agent.reportsTo) expect(port.agents.some((row) => row.id === agent.reportsTo)).toBe(true);
        created.push(agent.id);
        return create(companyId, agent);
      };
      const receipt = await reconcileVectorInstallation(port, input);
      const ids = seats(input.manifest).map((agent: any) => agent.id);
      expect(receipt).toMatchObject({
        manifestRevision: 9,
        agentId: funkyDevId,
        agentIds: ids,
        agentsCreated: 11,
        created: { company: true, ownership: true, agent: true },
      });
      expect(created).toEqual(ids);
      for (const desired of seats(input.manifest)) {
        const row = port.agents.find((agent) => agent.id === desired.id);
        expect(row).toMatchObject({ name: desired.name, role: desired.role, reportsTo: desired.reportsTo });
        expect(row.adapterConfig).toEqual({
          ...desired.adapterConfig,
          instructionsFilePath: path.join(input.activeReleaseRoot, desired.instructions.path),
        });
        expect(row.metadata.vectorProvisioning).toMatchObject({ manifestRevision: 9, rosterCatalogSha256: receipt.rosterCatalogSha256 });
        expect(row.metadata.vectorWorkloads.keys).toEqual([]);
      }
      const rerun = await reconcileVectorInstallation(port, input);
      expect(rerun).toEqual({ ...receipt, created: { company: false, ownership: false, agent: false }, agentsCreated: 0 });
      expect(updates).toEqual([]);
      expect(port.agents).toHaveLength(11);
    });

    it("fails closed when a seat is re-parented on the board at the same revision", async () => {
      const input = await seedInput();
      const port = memoryPort();
      await reconcileVectorInstallation(port, input);
      const engineer = port.agents.find((agent) => agent.id === byRole(input.manifest, "backend-engineer").id);
      engineer.reportsTo = byRole(input.manifest, "frontend-manager").id;
      await expect(reconcileVectorInstallation(port, input)).rejects.toThrow("immutable field agent.reportsTo differs");
    });

    it("upgrades a revision 8 FunkyDev install to the revision 9 org, keeping FunkyDev's identity and operator-owned model and thinking", async () => {
      const r8 = await seedInput("vector-engineering-seed-r8.json");
      const { port, updates } = countingPort();
      const installed = await reconcileVectorInstallation(port, r8);
      expect(installed).toMatchObject({ manifestRevision: 8, agentIds: [funkyDevId], agentsCreated: 1 });
      // Operator-owned board edits on the live FunkyDev.
      const funkyDev = port.agents[0];
      funkyDev.adapterConfig = { ...funkyDev.adapterConfig, model: "router/Other-Model", thinking: "medium" };

      const r9 = await seedInput();
      const upgraded = await reconcileVectorInstallation(port, r9);
      const ids = seats(r9.manifest).map((agent: any) => agent.id);
      expect(upgraded).toMatchObject({
        manifestRevision: 9,
        agentId: funkyDevId,
        agentIds: ids,
        agentsCreated: 10,
        created: { company: false, ownership: false, agent: true },
      });
      expect(upgraded.agentIds[0]).toBe(funkyDevId);
      const after = port.agents.find((agent) => agent.id === funkyDevId);
      expect(after).toMatchObject({ id: funkyDevId, name: "FunkyDev", role: "engineer", reportsTo: null });
      expect(after.adapterConfig).toMatchObject({ model: "router/Other-Model", thinking: "medium" });
      expect(after.metadata.vectorProvisioning.manifestRevision).toBe(9);
      expect(updates.map((update) => update.id)).toEqual([funkyDevId]);
      expect(updates[0]!.patch).toHaveProperty("reportsTo", null);
      for (const desired of r9.manifest.additionalAgents) {
        expect(port.agents.find((agent) => agent.id === desired.id)).toMatchObject({ reportsTo: desired.reportsTo });
      }

      updates.length = 0;
      const rerun = await reconcileVectorInstallation(port, r9);
      expect(rerun).toEqual({ ...upgraded, created: { company: false, ownership: false, agent: false }, agentsCreated: 0 });
      expect(updates).toEqual([]);
      expect(port.terminated).toEqual([]);
    });

    it("a later revision re-parents kept seats and retires dropped ones", async () => {
      const r9 = await seedInput();
      const port = memoryPort();
      await reconcileVectorInstallation(port, r9);
      const r10 = structuredClone(r9);
      r10.manifest.manifestRevision = 10;
      const platformQa = byRole(r10.manifest, "platform-qa");
      r10.manifest.additionalAgents = r10.manifest.additionalAgents.filter((agent: any) => agent.role !== "platform-qa");
      byRole(r10.manifest, "product-qa").reportsTo = byRole(r10.manifest, "backend-manager").id;
      const receipt = await reconcileVectorInstallation(port, r10);
      expect(receipt.agentIds).toHaveLength(10);
      expect(port.terminated).toEqual([platformQa.id]);
      expect(port.agents.find((agent) => agent.role === "product-qa").reportsTo).toBe(byRole(r10.manifest, "backend-manager").id);
      await expect(reconcileVectorInstallation(port, r10)).resolves.toEqual({ ...receipt, created: { company: false, ownership: false, agent: false } });
    });

    (embeddedPostgres.supported ? describe : describe.skip)("through the production agent service", () => {
      // Each case gets its own database: the seat ids are deterministic and
      // agent ids are global.
      let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
      let db: ReturnType<typeof createDb>;

      beforeEach(async () => {
        database = await startEmbeddedPostgresTestDatabase("paperclip-vector-provision-org-");
        db = createDb(database.connectionString);
      }, 90_000);

      afterEach(async () => {
        await db?.$client.end({ timeout: 0 });
        await database?.cleanup();
        database = undefined;
      });

      const rows = (companyId: string) => db.select().from(agentsTable).where(eq(agentsTable.companyId, companyId));

      it("creates the org in Postgres with deterministic ids and its hierarchy, and reruns idempotently", async () => {
        const input = await seedInput();
        const receipt = await provisionVectorInstallation(db, input);
        expect(receipt).toMatchObject({ agentIds: seats(input.manifest).map((agent: any) => agent.id), agentsCreated: 11 });
        const created = await rows(input.manifest.company.id);
        expect(created).toHaveLength(11);
        for (const desired of seats(input.manifest)) {
          expect(created.find((row) => row.id === desired.id)).toMatchObject({ role: desired.role, reportsTo: desired.reportsTo });
        }
        const rerun = await provisionVectorInstallation(db, input);
        expect(rerun).toEqual({ ...receipt, created: { company: false, ownership: false, agent: false }, agentsCreated: 0 });
        const after = await rows(input.manifest.company.id);
        for (const row of after) expect(row.updatedAt).toEqual(created.find((candidate) => candidate.id === row.id)!.updatedAt);
      });

      it("upgrades the live revision 8 FunkyDev to the revision 9 org, keeping its id, board model and thinking, and GitHub grant", async () => {
        const r8 = await seedInput("vector-engineering-seed-r8.json");
        await provisionVectorInstallation(db, r8);
        const service = agentService(db);
        await service.update(funkyDevId, {
          adapterConfig: { ...(await service.getById(funkyDevId))!.adapterConfig as Record<string, unknown>, model: "router/Other-Model", thinking: "medium" },
        });
        // FunkyDev's GitHub access: a github.code connection installed on the agent.
        const [application] = await db.insert(toolApplications).values({
          companyId: r8.manifest.company.id, name: "GitHub", type: "mcp_http",
        }).returning();
        const [connection] = await db.insert(toolConnections).values({
          companyId: r8.manifest.company.id, applicationId: application!.id, name: "github.code", uid: "github-code", transport: "mcp_remote",
        }).returning();
        const [grant] = await db.insert(toolConnectionInstalls).values({
          companyId: r8.manifest.company.id, connectionId: connection!.id, targetType: "agent", targetId: funkyDevId,
        }).returning();

        const r9 = await seedInput();
        const upgraded = await provisionVectorInstallation(db, r9);
        expect(upgraded).toMatchObject({ manifestRevision: 9, agentId: funkyDevId, agentIds: seats(r9.manifest).map((agent: any) => agent.id), agentsCreated: 10 });
        const org = await rows(r9.manifest.company.id);
        expect(org).toHaveLength(11);
        const funkyDev = org.find((row) => row.id === funkyDevId)!;
        expect(funkyDev).toMatchObject({ name: "FunkyDev", role: "engineer", reportsTo: null });
        expect(funkyDev.adapterConfig).toMatchObject({ model: "router/Other-Model", thinking: "medium" });
        for (const desired of r9.manifest.additionalAgents) {
          expect(org.find((row) => row.id === desired.id)).toMatchObject({ role: desired.role, reportsTo: desired.reportsTo, status: "idle" });
        }
        expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.id, grant!.id))).toEqual([grant]);

        const rerun = await provisionVectorInstallation(db, r9);
        expect(rerun).toEqual({ ...upgraded, created: { company: false, ownership: false, agent: false }, agentsCreated: 0 });
        const after = await rows(r9.manifest.company.id);
        for (const row of after) expect(row.updatedAt).toEqual(org.find((candidate) => candidate.id === row.id)!.updatedAt);
        await expect(provisionVectorInstallation(db, r8)).rejects.toThrow("downgrade refused");
      });
    });
  });
});
