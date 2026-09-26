import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { type Db, routineTriggers, routines, vectorInstallationOwnerships } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { isVectorFunkyServerProfile } from "@paperclipai/adapter-utils/vector-profiles";
import { agentService } from "./agents.js";
import { companyService } from "./companies.js";
import { VECTOR_SCHEDULE_KEYS } from "./vector-schedule-routine-dispatch.js";

const UUID = z.string().uuid();
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const vectorProfileSchema = z.enum(["engineering", "standard", "staging", "production"]);

const companyMutableField = z.enum(["name", "description", "budgetMonthlyCents"]);
const agentMutableField = z.enum([
  "name",
  "role",
  "title",
  "capabilities",
  "adapterConfig",
  "runtimeConfig",
  "budgetMonthlyCents",
  "permissions",
  "metadata",
]);

const toolPolicySchema = z.object({
  profile: vectorProfileSchema,
  builtinTools: z.array(z.enum(["bash", "edit", "find", "grep", "ls", "read", "write"])),
  extensions: z.array(z.object({
    name: z.string().min(1),
    tools: z.array(z.string().min(1)),
    permissions: z.object({ filesystem: z.boolean(), shell: z.boolean() }).strict(),
  }).strict()),
}).strict().superRefine((policy, ctx) => {
  const restrictedExtensions = policy.profile === "standard"
    ? [chatCallbackExtension, speakExtension] : [stagingCallbackExtension];
  if (policy.profile !== "engineering" && (policy.builtinTools.length > 0
      || stableJson(policy.extensions) !== stableJson(restrictedExtensions))) {
    ctx.addIssue({
      code: "custom",
      message: `${policy.profile} Vector profiles must not provision ambient Pi tools or unapproved extensions`,
    });
  }
});

const heartbeatRuntimeConfigSchema = z.object({
  heartbeat: z.object({
    enabled: z.literal(false),
    wakeOnDemand: z.literal(true),
    maxConcurrentRuns: z.number().int().positive().max(1),
  }).strict(),
}).strict();

const agentPermissionsSchema = z.object({
  canCreateAgents: z.literal(false),
  canCreateSkills: z.literal(false),
}).strict();

const forbiddenManifestKey = /(?:^|_)(?:api_?key|token|password|secret|credential|database_?url|private_?key|env|environment)(?:$|_)/i;
const forbiddenManifestValue = /(?:\$\{[^}]+\}|\$[A-Z][A-Z0-9_]*|^(?:env|secret|credential):|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

function assertNoEmbeddedAuthority(value: unknown, location = "manifest"): void {
  if (typeof value === "string") {
    if (forbiddenManifestValue.test(value)) {
      throw new Error(`Vector provisioning manifest must not contain credential or environment references at ${location}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoEmbeddedAuthority(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
    const boundedTokenBudget = normalizedKey === "token_budget" || normalizedKey === "default_token_budget";
    if (!boundedTokenBudget && forbiddenManifestKey.test(normalizedKey)) {
      throw new Error(`Vector provisioning manifest must not contain secret-bearing key ${location}.${key}`);
    }
    assertNoEmbeddedAuthority(entry, `${location}.${key}`);
  }
}

const vectorAgentManifestSchema = z.object({
  id: UUID,
  name: z.string().min(1),
  role: z.string().min(1),
  title: z.string().nullable(),
  capabilities: z.string().nullable(),
  adapterType: z.literal("pi_local"),
  adapterConfig: z.object({
    model: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
    executionMode: z.literal("rpc"),
    cwd: z.string().refine(path.isAbsolute, "cwd must be absolute"),
  }).strict(),
  instructions: z.object({
    path: z.string().min(1),
    sha256: SHA256,
  }).strict(),
  runtimeConfig: heartbeatRuntimeConfigSchema,
  budgetMonthlyCents: z.number().int().nonnegative(),
  permissions: agentPermissionsSchema,
  mutableFields: z.array(agentMutableField),
}).strict();

const vectorScheduleContractSchema = z.object({
  owner: z.literal("vector_jobs"),
  scheduleKey: z.string().min(1),
  targetSchema: z.string().min(1),
  targetFunction: z.string().min(1),
  targetParameters: z.record(z.string(), z.unknown()),
  cronExpression: z.string().min(1),
  timezone: z.string().min(1),
  enabled: z.literal(false),
}).strict();

const vectorWorkloadPolicySchema = z.object({
  leaseSeconds: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  tokenBudget: z.number().int().positive(),
  mayDetach: z.boolean(),
  mayWrite: z.literal(false),
  requiresEvidence: z.literal(true),
  modelPolicy: z.string().min(1).nullable(),
  gatingFlag: z.string().min(1),
  payloadFunction: z.string().min(1),
  promptFunction: z.string().min(1),
  settlementFunction: z.string().min(1).nullable(),
  escalationRole: z.string().min(1).nullable(),
  lineage: z.object({
    maxSpawnDepth: z.number().int().nonnegative(),
    allowInTurnChildren: z.boolean(),
    allowedChildTypes: z.array(z.string().min(1)),
    maxParallelChildren: z.number().int().positive(),
  }).strict(),
}).strict();

const vectorWorkloadContractSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.-]{1,95}$/),
  title: z.string().min(1),
  kind: z.enum(["interactive", "research_task", "generic_task"]),
  agentId: UUID,
  executionShape: z.enum(["interactive", "single_shot", "session"]),
  promptSource: z.enum(["paperclip_issue", "vector_role_turn", "vector_claim_envelope"]),
  toolSurface: z.array(z.string().min(1)),
  policy: vectorWorkloadPolicySchema,
  runtimeAuthority: z.enum(["paperclip", "vector_lease_triple"]),
  schedule: vectorScheduleContractSchema.nullable(),
  dependencies: z.array(z.object({
    kind: z.enum(["workload", "schedule"]),
    key: z.string().min(1),
    description: z.string().min(1),
    schedule: vectorScheduleContractSchema.nullable(),
  }).strict()).default([]),
  recoverySchedule: vectorScheduleContractSchema.nullable().default(null),
  bridge: z.object({
    required: z.literal(true),
    defaultEnabled: z.literal(false),
    claimPath: z.string().startsWith("/"),
    heartbeatPath: z.string().startsWith("/"),
    completePath: z.string().startsWith("/"),
    failPath: z.string().startsWith("/"),
    detachPath: z.string().startsWith("/").nullable(),
  }).strict().nullable(),
}).strict().superRefine((workload, ctx) => {
  if (workload.runtimeAuthority === "vector_lease_triple") {
    if (!workload.bridge) {
      ctx.addIssue({ code: "custom", path: ["bridge"], message: "Vector lease workloads require a default-off bridge" });
    }
  } else if (workload.bridge) {
    ctx.addIssue({ code: "custom", path: ["bridge"], message: "Paperclip-owned workloads must not declare the Vector lease bridge" });
  }
  if (workload.kind === "interactive" && workload.executionShape !== "interactive") {
    ctx.addIssue({ code: "custom", path: ["executionShape"], message: "interactive workloads require the interactive execution shape" });
  }
});

const speakExtension = {
  name: "vector.speak",
  tools: ["speak"],
  permissions: { filesystem: false, shell: false },
};

const chatCallbackExtension = {
  name: "vector.tool-bridge",
  tools: ["ask_user", "memory_forget", "memory_save", "memory_search", "todo_add", "todo_list", "todo_mark_done", "todo_update"],
  permissions: { filesystem: false, shell: false },
};

const engineeringCallbackExtension = {
  ...chatCallbackExtension,
  tools: [
    "ask_user", "github_api", "github_manage", "github_read", "github_repo",
    "memory_forget", "memory_save", "memory_search", "todo_add", "todo_list",
    "todo_mark_done", "todo_update",
  ],
};

const stagingCallbackExtension = {
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
};

const engineeringToolPolicy = {
  builtinTools: ["bash", "edit", "find", "grep", "ls", "read", "write"],
  extensions: [{
    name: "funkydev.vault-reference",
    tools: ["vault_read", "vault_search"],
    permissions: { filesystem: true, shell: false },
  }, engineeringCallbackExtension, speakExtension],
};

const researchPolicy = {
  leaseSeconds: 300,
  maxAttempts: 3,
  tokenBudget: 12000,
  mayDetach: true,
  mayWrite: false,
  requiresEvidence: true,
  modelPolicy: null,
  gatingFlag: "product.os.research",
  payloadFunction: "os.research_task_payload",
  promptFunction: "os.research_task_prompt",
  settlementFunction: null,
  escalationRole: null,
  lineage: { maxSpawnDepth: 0, allowInTurnChildren: false, allowedChildTypes: [], maxParallelChildren: 1 },
};

const stagingWorkloadSpecs = {
  current_scout: { kind: "research_task", executionShape: "single_shot", role: "funky-scout", tools: [], policy: researchPolicy },
  macro_scout: { kind: "research_task", executionShape: "single_shot", role: "funky-scout", tools: [], policy: researchPolicy },
  demand_scout: { kind: "research_task", executionShape: "single_shot", role: "funky-scout", tools: [], policy: researchPolicy },
  synthesis: { kind: "research_task", executionShape: "single_shot", role: "funky-scout", tools: [], policy: researchPolicy },
  curation: { kind: "research_task", executionShape: "single_shot", role: "funky-scout", tools: [], policy: researchPolicy },
  dmv_review: {
    kind: "generic_task",
    executionShape: "single_shot",
    role: "funky-scout",
    tools: [],
    policy: {
      leaseSeconds: 900, maxAttempts: 2, tokenBudget: 8000,
      mayDetach: false, mayWrite: false, requiresEvidence: true,
      modelPolicy: null,
      gatingFlag: "product.dmv.review",
      payloadFunction: "dmv.review_payload",
      promptFunction: "dmv.review_prompt",
      settlementFunction: "dmv.review_settle",
      escalationRole: "compliance-advisor",
      lineage: { maxSpawnDepth: 0, allowInTurnChildren: false, allowedChildTypes: [], maxParallelChildren: 1 },
    },
  },
  dmv_audit_back_triage: {
    kind: "generic_task",
    executionShape: "session",
    role: "funky-advisor",
    tools: ["dmv.get_pipeline_health", "dmv.list_audit_back", "dmv.list_recent_pipeline_failures"],
    policy: {
      leaseSeconds: 1200, maxAttempts: 2, tokenBudget: 24000,
      mayDetach: true, mayWrite: false, requiresEvidence: true,
      modelPolicy: null,
      gatingFlag: "product.dmv.triage",
      payloadFunction: "dmv.triage_payload",
      promptFunction: "dmv.triage_prompt",
      settlementFunction: "dmv.review_settle",
      escalationRole: "compliance-advisor",
      lineage: {
        maxSpawnDepth: 1,
        allowInTurnChildren: true,
        allowedChildTypes: ["dmv-client-reader", "reader"],
        maxParallelChildren: 2,
      },
    },
  },
} as const;

const stagingScheduleSpecs = {
  research: {
    owner: "vector_jobs", scheduleKey: "fa_research_daily",
    targetSchema: "os", targetFunction: "enqueue_research_cycle", targetParameters: { cadence: "daily" },
    cronExpression: "20 8 * * *", timezone: "America/New_York", enabled: false,
  },
  researchRecovery: {
    owner: "vector_jobs", scheduleKey: "fa_research_lease_sweep",
    targetSchema: "os", targetFunction: "recover_research_leases", targetParameters: {},
    cronExpression: "*/5 * * * *", timezone: "America/New_York", enabled: false,
  },
  taskRecovery: {
    owner: "vector_jobs", scheduleKey: "fa_task_lease_sweep",
    targetSchema: "os", targetFunction: "recover_task_leases", targetParameters: {},
    cronExpression: "*/5 * * * *", timezone: "America/New_York", enabled: false,
  },
  dmvReview: {
    owner: "vector_jobs", scheduleKey: "fa_dmv_review_daily",
    targetSchema: "os", targetFunction: "enqueue_task",
    targetParameters: { task_type: "dmv_review", run: { trigger: "cadence", cadence: "daily", token_budget: 16000, deadline_minutes: 180 } },
    cronExpression: "30 7 * * *", timezone: "America/New_York", enabled: false,
  },
  dmvTriage: {
    owner: "vector_jobs", scheduleKey: "fa_dmv_audit_back_triage_daily",
    targetSchema: "os", targetFunction: "enqueue_task",
    targetParameters: { task_type: "dmv_audit_back_triage", run: { trigger: "cadence", cadence: "daily", token_budget: 48000, deadline_minutes: 240 } },
    cronExpression: "0 8 * * *", timezone: "America/New_York", enabled: false,
  },
  queryThemes: {
    owner: "vector_jobs", scheduleKey: "fa_rollup_query_themes",
    targetSchema: "os", targetFunction: "rollup_query_themes", targetParameters: {},
    cronExpression: "40 2 * * *", timezone: "America/New_York", enabled: false,
  },
} as const;

export const vectorInstallationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  manifestRevision: z.number().int().positive(),
  installationId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  profile: vectorProfileSchema,
  company: z.object({
    id: UUID,
    name: z.string().min(1),
    description: z.string().nullable(),
    budgetMonthlyCents: z.number().int().nonnegative(),
    mutableFields: z.array(companyMutableField),
  }).strict(),
  agent: vectorAgentManifestSchema,
  additionalAgents: z.array(vectorAgentManifestSchema).default([]),
  workloads: z.array(vectorWorkloadContractSchema).default([]),
  toolPolicy: toolPolicySchema,
}).strict().superRefine((manifest, ctx) => {
  if (manifest.toolPolicy.profile !== manifest.profile) {
    ctx.addIssue({ code: "custom", path: ["toolPolicy", "profile"], message: "tool policy must match the installation profile" });
  }
  for (const [label, values] of [
    ["company.mutableFields", manifest.company.mutableFields],
    ["agent.mutableFields", manifest.agent.mutableFields],
  ] as const) {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: "custom", path: label.split("."), message: `${label} must be unique` });
    }
  }
  if (!path.posix.isAbsolute(manifest.agent.instructions.path)
      && (manifest.agent.instructions.path !== path.posix.normalize(manifest.agent.instructions.path)
        || manifest.agent.instructions.path.startsWith("../"))) {
    ctx.addIssue({
      code: "custom",
      path: ["agent", "instructions", "path"],
      message: "instructions path must be a clean release-relative path",
    });
  }
  if (path.posix.isAbsolute(manifest.agent.instructions.path)) {
    ctx.addIssue({
      code: "custom",
      path: ["agent", "instructions", "path"],
      message: "instructions path must be release-relative",
    });
  }
  const allAgents = [manifest.agent, ...manifest.additionalAgents];
  const agentIds = new Set<string>();
  const agentNames = new Set<string>();
  for (const [index, agent] of allAgents.entries()) {
    const prefix = index === 0 ? ["agent"] : ["additionalAgents", index - 1];
    if (agentIds.has(agent.id)) {
      ctx.addIssue({ code: "custom", path: [...prefix, "id"], message: "agent ids must be unique" });
    }
    if (agentNames.has(agent.name)) {
      ctx.addIssue({ code: "custom", path: [...prefix, "name"], message: "agent names must be unique" });
    }
    agentIds.add(agent.id);
    agentNames.add(agent.name);
    if (new Set(agent.mutableFields).size !== agent.mutableFields.length) {
      ctx.addIssue({ code: "custom", path: [...prefix, "mutableFields"], message: "agent.mutableFields must be unique" });
    }
    if (path.posix.isAbsolute(agent.instructions.path)
        || agent.instructions.path !== path.posix.normalize(agent.instructions.path)
        || agent.instructions.path.startsWith("../")) {
      ctx.addIssue({ code: "custom", path: [...prefix, "instructions", "path"], message: "instructions path must be release-relative" });
    }
  }
  const workloadKeys = new Set<string>();
  for (const [index, workload] of manifest.workloads.entries()) {
    if (workloadKeys.has(workload.key)) {
      ctx.addIssue({ code: "custom", path: ["workloads", index, "key"], message: "workload keys must be unique" });
    }
    workloadKeys.add(workload.key);
    if (!agentIds.has(workload.agentId)) {
      ctx.addIssue({ code: "custom", path: ["workloads", index, "agentId"], message: "workload agentId must name a provisioned agent" });
    }
  }
  const roles = allAgents.map((agent) => agent.role).sort();
  if (manifest.profile === "engineering") {
    if (allAgents.length !== 1 || manifest.agent.name !== "FunkyDev" || manifest.agent.role !== "engineer") {
      ctx.addIssue({ code: "custom", path: ["agent"], message: "engineering installs provision exactly the FunkyDev engineer" });
    }
    if (manifest.workloads.length !== 0) {
      ctx.addIssue({ code: "custom", path: ["workloads"], message: "engineering installs do not own Funky workload schedules" });
    }
    if (stableJson(manifest.toolPolicy.builtinTools) !== stableJson(engineeringToolPolicy.builtinTools)
        || stableJson(manifest.toolPolicy.extensions) !== stableJson(engineeringToolPolicy.extensions)) {
      ctx.addIssue({ code: "custom", path: ["toolPolicy"], message: "engineering installs require the exact FunkyDev tool policy" });
    }
  }
  if (manifest.profile === "standard") {
    if (
      allAgents.length !== 1 || manifest.agent.name !== "Standard Chat" || manifest.agent.role !== "standard-chat" ||
      stableJson(roles) !== stableJson(["standard-chat"])
    ) {
      ctx.addIssue({ code: "custom", path: ["agent"], message: "standard installs provision exactly the Standard Chat agent" });
    }
    if (manifest.workloads.length !== 0) {
      ctx.addIssue({ code: "custom", path: ["workloads"], message: "standard installs do not own Funky workload schedules" });
    }
  }
  if (isVectorFunkyServerProfile(manifest.profile)) {
    const expectedRoles = ["funky-advisor", "funky-analyst", "funky-scout"];
    if (stableJson(roles) !== stableJson(expectedRoles)) {
      ctx.addIssue({ code: "custom", path: ["additionalAgents"], message: `${manifest.profile} installs require exactly Funky analyst, Scout, and Advisor agents` });
    }
    const expectedWorkloads = [
      "curation", "current_scout", "demand_scout", "dmv_audit_back_triage",
      "dmv_review", "macro_scout", "synthesis",
    ];
    if (stableJson([...workloadKeys].sort()) !== stableJson(expectedWorkloads)) {
      ctx.addIssue({ code: "custom", path: ["workloads"], message: `${manifest.profile} installs require the complete Vector workload catalog` });
    }
    const roleByAgentId = new Map(allAgents.map((agent) => [agent.id, agent.role]));
    for (const [index, workload] of manifest.workloads.entries()) {
      const expected = stagingWorkloadSpecs[workload.key as keyof typeof stagingWorkloadSpecs];
      if (!expected) continue;
      const actual = {
        kind: workload.kind,
        executionShape: workload.executionShape,
        role: roleByAgentId.get(workload.agentId),
        tools: [...workload.toolSurface].sort(),
        policy: {
          ...workload.policy,
          lineage: {
            ...workload.policy.lineage,
            allowedChildTypes: [...workload.policy.lineage.allowedChildTypes].sort(),
          },
        },
        schedule: workload.schedule,
        recoverySchedule: workload.recoverySchedule,
        promptSource: workload.promptSource,
        runtimeAuthority: workload.runtimeAuthority,
      };
      const schedule = workload.kind === "research_task"
        ? stagingScheduleSpecs.research
        : workload.key === "dmv_review"
          ? stagingScheduleSpecs.dmvReview
          : stagingScheduleSpecs.dmvTriage;
      const recoverySchedule = workload.kind === "research_task"
        ? stagingScheduleSpecs.researchRecovery
        : stagingScheduleSpecs.taskRecovery;
      const required = {
        kind: expected.kind,
        executionShape: expected.executionShape,
        role: expected.role,
        tools: [...expected.tools].sort(),
        policy: expected.policy,
        schedule,
        recoverySchedule,
        promptSource: "vector_claim_envelope",
        runtimeAuthority: "vector_lease_triple",
      };
      if (stableJson(actual) !== stableJson(required)) {
        ctx.addIssue({ code: "custom", path: ["workloads", index], message: `${manifest.profile} workload ${workload.key} does not match the Vector contract` });
      }
    }
    const dependenciesByWorkload = new Map(manifest.workloads.map((workload) => [
      workload.key,
      workload.dependencies.map((dependency) => `${dependency.kind}:${dependency.key}`).sort(),
    ]));
    const expectedDependencies = new Map<string, string[]>([
      ["current_scout", []],
      ["macro_scout", []],
      ["demand_scout", ["schedule:fa_rollup_query_themes"]],
      ["synthesis", ["workload:current_scout", "workload:demand_scout", "workload:macro_scout"]],
      ["curation", ["workload:synthesis"]],
      ["dmv_review", []],
      ["dmv_audit_back_triage", []],
    ]);
    for (const [workloadKey, expected] of expectedDependencies) {
      if (stableJson(dependenciesByWorkload.get(workloadKey)) !== stableJson(expected)) {
        ctx.addIssue({ code: "custom", path: ["workloads"], message: `${manifest.profile} workload ${workloadKey} dependencies do not match the Vector contract` });
      }
    }
    const demandDependency = manifest.workloads
      .find((workload) => workload.key === "demand_scout")
      ?.dependencies.find((dependency) => dependency.key === "fa_rollup_query_themes");
    if (stableJson(demandDependency?.schedule) !== stableJson(stagingScheduleSpecs.queryThemes)) {
      ctx.addIssue({ code: "custom", path: ["workloads"], message: "demand_scout must preserve the disabled query-theme dependency schedule" });
    }
  }
});

export type VectorInstallationManifest = z.infer<typeof vectorInstallationManifestSchema>;
export type VectorToolPolicy = z.infer<typeof toolPolicySchema>;

function deterministicUuid(identity: string) {
  const hex = createHash("sha256").update(identity).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function vectorWorkloadRoutineSeeds(manifest: VectorInstallationManifest) {
  if (!isVectorFunkyServerProfile(manifest.profile)) return [];
  const agentsByRole = new Map([manifest.agent, ...manifest.additionalAgents].map((agent) => [agent.role, agent.id]));
  return ([
    { queue: "research", role: "funky-scout", title: "Vector research queue pump" },
    { queue: "tasks", role: "funky-advisor", title: "Vector agentic task queue pump" },
  ] as const).map((seed) => ({
    routineId: deterministicUuid(`${manifest.installationId}:paperclip-workload-routine:${seed.queue}`),
    triggerId: deterministicUuid(`${manifest.installationId}:paperclip-workload-trigger:${seed.queue}`),
    companyId: manifest.company.id,
    assigneeAgentId: agentsByRole.get(seed.role)!,
    queue: seed.queue,
    title: seed.title,
    description: `Claims one bounded ${seed.queue} batch from Vector OS and executes it through the trusted Paperclip runtime bridge.`,
    cronExpression: "* * * * *",
    timezone: "UTC",
  }));
}

export function vectorScheduleRoutineSeeds(manifest: VectorInstallationManifest) {
  if (!isVectorFunkyServerProfile(manifest.profile)) return [];
  type Schedule = NonNullable<VectorInstallationManifest["workloads"][number]["schedule"]>;
  const schedules = new Map<string, Schedule>();
  const add = (schedule: Schedule | null | undefined) => {
    if (!schedule) return;
    const prior = schedules.get(schedule.scheduleKey);
    if (prior && stableJson(prior) !== stableJson(schedule)) {
      throw new Error(`Vector schedule ${schedule.scheduleKey} has conflicting sealed declarations`);
    }
    schedules.set(schedule.scheduleKey, schedule);
  };
  for (const workload of manifest.workloads) {
    add(workload.schedule);
    add(workload.recoverySchedule);
    for (const dependency of workload.dependencies) add(dependency.schedule);
  }
  const keys = [...schedules.keys()].sort();
  const expected = [...VECTOR_SCHEDULE_KEYS].sort();
  if (stableJson(keys) !== stableJson(expected)) {
    throw new Error(`${manifest.profile} Vector schedule routine catalog does not match the exact migrated schedule set`);
  }
  return keys.map((scheduleKey) => {
    const schedule = schedules.get(scheduleKey)!;
    return {
      routineId: deterministicUuid(`${manifest.installationId}:paperclip-schedule-routine:${scheduleKey}`),
      triggerId: deterministicUuid(`${manifest.installationId}:paperclip-schedule-trigger:${scheduleKey}`),
      companyId: manifest.company.id,
      assigneeAgentId: manifest.agent.id,
      scheduleKey,
      title: `Vector schedule: ${scheduleKey}`,
      description: `Checks the authoritative jobs.schedules row for ${scheduleKey} and fires its sealed Vector target only when due and owned by Paperclip. Declared source cadence: ${schedule.cronExpression} (${schedule.timezone}); the live Vector row remains authoritative.`,
      // The minute trigger is only Paperclip's wakeup. Vector's live row stays
      // authoritative for cron, timezone, enablement and next-fire state.
      cronExpression: "* * * * *",
      timezone: "UTC",
      sourceCronExpression: schedule.cronExpression,
      sourceTimezone: schedule.timezone,
    };
  });
}

type CompanyRecord = {
  id: string;
  name: string;
  description: string | null;
  budgetMonthlyCents: number;
};

type AgentRecord = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title: string | null;
  capabilities: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  budgetMonthlyCents: number;
  permissions: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  status?: string;
};

type InstallationOwnershipRecord = {
  installationId: string;
  profile: string;
  companyId: string;
};

export interface VectorProvisioningPort {
  listCompanies(): Promise<CompanyRecord[]>;
  getCompany(id: string): Promise<CompanyRecord | null>;
  createCompany(input: CompanyRecord): Promise<CompanyRecord>;
  getOwnershipByInstallationId(installationId: string): Promise<InstallationOwnershipRecord | null>;
  getOwnershipByCompanyId(companyId: string): Promise<InstallationOwnershipRecord | null>;
  createOwnership(input: InstallationOwnershipRecord): Promise<InstallationOwnershipRecord>;
  listAgents(companyId: string): Promise<AgentRecord[]>;
  getAgent(id: string): Promise<AgentRecord | null>;
  createAgent(companyId: string, input: Omit<AgentRecord, "companyId">): Promise<AgentRecord>;
  updateAgent(id: string, patch: Partial<Omit<AgentRecord, "id" | "companyId">>): Promise<AgentRecord | null>;
  terminateAgent(id: string): Promise<AgentRecord | null>;
}

export interface VectorProvisioningInput {
  manifest: unknown;
  selectedProfile: string;
  stagedReleaseRoot: string;
  activeReleaseRoot: string;
  effectiveToolPolicy: unknown;
}

export interface VectorProvisioningReceipt {
  schemaVersion: 1;
  installationId: string;
  profile: z.infer<typeof vectorProfileSchema>;
  manifestRevision: number;
  companyId: string;
  agentId: string;
  agentIds: string[];
  workloadCatalogSha256: string;
  rosterCatalogSha256: string;
  created: { company: boolean; ownership: boolean; agent: boolean };
  agentsCreated: number;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`Vector provisioning drift: immutable field ${label} differs`);
  }
}

function assertImmutableFields(
  kind: "company" | "agent",
  actual: object,
  expected: object,
  mutableFields: readonly string[],
): void {
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const mutable = new Set(mutableFields);
  for (const key of Object.keys(expectedRecord)) {
    if (!mutable.has(key)) assertEqual(`${kind}.${key}`, actualRecord[key], expectedRecord[key]);
  }
}

/**
 * The manifest revision this installation last provisioned onto an agent.
 * An agent without a matching provisioning marker was not created by this
 * installation and is never adopted or rewritten.
 */
function storedManifestRevision(
  agent: AgentRecord,
  manifest: { installationId: string; profile: string },
): number {
  const metadata = agent.metadata;
  const marker = metadata && typeof metadata === "object" ? metadata.vectorProvisioning : undefined;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    throw new Error("Vector provisioning agent has no provisioning marker");
  }
  const record = marker as Record<string, unknown>;
  if (record.installationId !== manifest.installationId || record.profile !== manifest.profile) {
    throw new Error("Vector provisioning agent belongs to another installation");
  }
  const revision = record.manifestRevision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Vector provisioning agent has an invalid manifest revision");
  }
  return revision;
}

/**
 * The revision recorded by this installation's provisioning marker, or null
 * when the agent does not carry this installation's marker. Unlike
 * storedManifestRevision this never throws: it is used to find roster members
 * that a newer manifest dropped, among agents the installation may not own.
 */
function ownedManifestRevision(
  agent: AgentRecord,
  manifest: { installationId: string; profile: string },
): number | null {
  const metadata = agent.metadata;
  const marker = metadata && typeof metadata === "object" ? metadata.vectorProvisioning : undefined;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  const record = marker as Record<string, unknown>;
  if (record.installationId !== manifest.installationId || record.profile !== manifest.profile) return null;
  const revision = record.manifestRevision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}

function containedReleasePath(root: string, relative: string): string {
  if (!path.isAbsolute(root)) throw new Error("Vector provisioning release roots must be absolute");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Vector provisioning instructions path escapes release root");
  }
  return resolved;
}

async function resolveManifest(input: VectorProvisioningInput) {
  assertNoEmbeddedAuthority(input.manifest);
  const manifest = vectorInstallationManifestSchema.parse(input.manifest);
  if (input.selectedProfile !== manifest.profile) {
    throw new Error(`Vector provisioning profile mismatch: selected ${input.selectedProfile}, manifest ${manifest.profile}`);
  }
  const effectiveToolPolicy = toolPolicySchema.parse(input.effectiveToolPolicy);
  assertEqual("toolPolicy", effectiveToolPolicy, manifest.toolPolicy);

  for (const agent of [manifest.agent, ...manifest.additionalAgents]) {
    const stagedInstructionsPath = containedReleasePath(input.stagedReleaseRoot, agent.instructions.path);
    const stat = await fs.stat(stagedInstructionsPath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Vector provisioning instructions asset is missing for ${agent.name}`);
    const digest = createHash("sha256").update(await fs.readFile(stagedInstructionsPath)).digest("hex");
    if (digest !== agent.instructions.sha256) {
      throw new Error(`Vector provisioning instructions asset digest mismatch for ${agent.name}`);
    }
  }

  const rosterAgents = [manifest.agent, ...manifest.additionalAgents].map(({ mutableFields: _mutableFields, ...agent }) => agent);
  return {
    manifest,
    workloadCatalogSha256: createHash("sha256").update(stableJson({
      installationId: manifest.installationId,
      profile: manifest.profile,
      workloads: manifest.workloads,
    })).digest("hex"),
    rosterCatalogSha256: createHash("sha256").update(stableJson({
      installationId: manifest.installationId,
      profile: manifest.profile,
      companyId: manifest.company.id,
      agents: rosterAgents,
      toolPolicy: manifest.toolPolicy,
    })).digest("hex"),
  };
}

export async function reconcileVectorInstallation(
  port: VectorProvisioningPort,
  input: VectorProvisioningInput,
): Promise<VectorProvisioningReceipt> {
  const { manifest, workloadCatalogSha256, rosterCatalogSha256 } = await resolveManifest(input);
  const companyExpected = {
    id: manifest.company.id,
    name: manifest.company.name,
    description: manifest.company.description,
    budgetMonthlyCents: manifest.company.budgetMonthlyCents,
  };

  let company = await port.getCompany(manifest.company.id);
  let companyCreated = false;
  if (company) {
    assertImmutableFields("company", company, companyExpected, manifest.company.mutableFields);
  } else {
    const collision = (await port.listCompanies()).find((candidate) => candidate.name === manifest.company.name);
    if (collision) throw new Error("Vector provisioning company identity collision");
    company = await port.createCompany(companyExpected);
    assertImmutableFields("company", company, companyExpected, []);
    companyCreated = true;
  }

  const ownershipExpected = {
    installationId: manifest.installationId,
    profile: manifest.profile,
    companyId: company.id,
  };
  const installationOwnership = await port.getOwnershipByInstallationId(manifest.installationId);
  const companyOwnership = await port.getOwnershipByCompanyId(company.id);
  if (installationOwnership && companyOwnership
      && stableJson(installationOwnership) !== stableJson(companyOwnership)) {
    throw new Error("Vector provisioning installation ownership collision");
  }
  const ownership = installationOwnership ?? companyOwnership;
  let ownershipCreated = false;
  if (ownership) {
    assertEqual("installationOwnership", ownership, ownershipExpected);
  } else {
    const created = await port.createOwnership(ownershipExpected);
    assertEqual("installationOwnership", created, ownershipExpected);
    ownershipCreated = true;
  }

  const existingAgents = await port.listAgents(company.id);
  // Agents this installation provisioned under an older revision that the
  // current manifest no longer declares are retired (terminated), never left
  // active. Validate before any agent mutation so a refused manifest changes
  // nothing.
  const declaredAgentIds = new Set([manifest.agent, ...manifest.additionalAgents].map((agent) => agent.id));
  const droppedAgents: AgentRecord[] = [];
  for (const candidate of existingAgents) {
    if (declaredAgentIds.has(candidate.id) || candidate.companyId !== company.id) continue;
    const revision = ownedManifestRevision(candidate, manifest);
    if (revision === null || candidate.status === "terminated") continue;
    if (revision > manifest.manifestRevision) {
      throw new Error(
        `Vector provisioning downgrade refused: agent is at manifest revision ${revision}, manifest is ${manifest.manifestRevision}`,
      );
    }
    if (revision === manifest.manifestRevision) {
      throw new Error("Vector provisioning drift: an active agent at the current manifest revision is missing from the roster");
    }
    droppedAgents.push(candidate);
  }
  const resolvedAgentIds: string[] = [];
  let agentsCreated = 0;
  for (const desired of [manifest.agent, ...manifest.additionalAgents]) {
    const workloadKeys = manifest.workloads.filter((workload) => workload.agentId === desired.id).map((workload) => workload.key).sort();
    const agentExpected = {
      id: desired.id,
      name: desired.name,
      role: desired.role,
      title: desired.title,
      capabilities: desired.capabilities,
      adapterType: desired.adapterType,
      adapterConfig: {
        ...desired.adapterConfig,
        instructionsFilePath: containedReleasePath(input.activeReleaseRoot, desired.instructions.path),
      },
      runtimeConfig: desired.runtimeConfig,
      budgetMonthlyCents: desired.budgetMonthlyCents,
      permissions: desired.permissions,
      metadata: {
        vectorProvisioning: {
          schemaVersion: 1,
          installationId: manifest.installationId,
          profile: manifest.profile,
          manifestRevision: manifest.manifestRevision,
          rosterCatalogSha256,
        },
         vectorWorkloads: {
           schemaVersion: 1,
           catalogSha256: workloadCatalogSha256,
           keys: workloadKeys,
           contracts: manifest.workloads
             .filter((workload) => workload.agentId === desired.id)
             .map((workload) => ({
               key: workload.key,
               kind: workload.kind,
               executionShape: workload.executionShape,
               role: desired.role,
               toolSurface: [...workload.toolSurface].sort(),
               modelPolicy: workload.policy.modelPolicy,
               runtimeAuthority: workload.runtimeAuthority,
             }))
             .sort((left, right) => left.key.localeCompare(right.key)),
         },
      },
    };
    let agent = await port.getAgent(desired.id);
    if (agent) {
      if (agent.companyId !== company.id) throw new Error("Vector provisioning agent belongs to another company");
      const storedRevision = storedManifestRevision(agent, manifest);
      if (storedRevision > manifest.manifestRevision) {
        throw new Error(
          `Vector provisioning downgrade refused: agent is at manifest revision ${storedRevision}, manifest is ${manifest.manifestRevision}`,
        );
      }
      if (storedRevision < manifest.manifestRevision) {
        // A newer revision owns every declared field except operator-mutable ones.
        const collision = existingAgents.find((candidate) => candidate.id !== agent!.id && candidate.name === desired.name);
        if (collision) throw new Error("Vector provisioning agent identity collision");
        const mutable = new Set<string>(desired.mutableFields);
        const { id: _id, ...declared } = agentExpected;
        const patch = Object.fromEntries(Object.entries(declared).filter(([key]) => !mutable.has(key)));
        agent = await port.updateAgent(agent.id, patch);
        if (!agent || agent.companyId !== company.id) throw new Error("Vector provisioning agent upgrade failed");
      }
      assertImmutableFields("agent", agent, agentExpected, desired.mutableFields);
    } else {
      const collision = existingAgents.find((candidate) => candidate.name === desired.name);
      if (collision) throw new Error("Vector provisioning agent identity collision");
      agent = await port.createAgent(company.id, agentExpected);
      assertImmutableFields("agent", agent, { ...agentExpected, companyId: company.id }, []);
      existingAgents.push(agent);
      agentsCreated++;
    }
    resolvedAgentIds.push(agent.id);
  }

  for (const dropped of droppedAgents) {
    const retired = await port.terminateAgent(dropped.id);
    if (!retired || retired.status !== "terminated") {
      throw new Error("Vector provisioning failed to retire an agent dropped from the manifest");
    }
  }

  return {
    schemaVersion: 1,
    installationId: manifest.installationId,
    profile: manifest.profile,
    manifestRevision: manifest.manifestRevision,
    companyId: company.id,
    agentId: resolvedAgentIds[0],
    agentIds: resolvedAgentIds,
    workloadCatalogSha256,
    rosterCatalogSha256,
    created: {
      company: companyCreated,
      ownership: ownershipCreated,
      agent: agentsCreated > 0,
    },
    agentsCreated,
  };
}

function productionPort(db: Db): VectorProvisioningPort {
  const companies = companyService(db);
  const agents = agentService(db);
  return {
    listCompanies: () => companies.list() as Promise<CompanyRecord[]>,
    getCompany: (id) => companies.getById(id) as Promise<CompanyRecord | null>,
    createCompany: (input) => companies.create(input) as Promise<CompanyRecord>,
    getOwnershipByInstallationId: (installationId) =>
      db
        .select({
          installationId: vectorInstallationOwnerships.installationId,
          profile: vectorInstallationOwnerships.profile,
          companyId: vectorInstallationOwnerships.companyId,
        })
        .from(vectorInstallationOwnerships)
        .where(eq(vectorInstallationOwnerships.installationId, installationId))
        .then((rows) => rows[0] ?? null),
    getOwnershipByCompanyId: (companyId) =>
      db
        .select({
          installationId: vectorInstallationOwnerships.installationId,
          profile: vectorInstallationOwnerships.profile,
          companyId: vectorInstallationOwnerships.companyId,
        })
        .from(vectorInstallationOwnerships)
        .where(eq(vectorInstallationOwnerships.companyId, companyId))
        .then((rows) => rows[0] ?? null),
    createOwnership: (input) =>
      db.insert(vectorInstallationOwnerships).values(input).returning({
        installationId: vectorInstallationOwnerships.installationId,
        profile: vectorInstallationOwnerships.profile,
        companyId: vectorInstallationOwnerships.companyId,
      }).then((rows) => rows[0]!),
    listAgents: (companyId) => agents.list(companyId, { includeTerminated: true }) as Promise<AgentRecord[]>,
    getAgent: (id) => agents.getById(id) as Promise<AgentRecord | null>,
    createAgent: (companyId, input) => agents.create(companyId, input) as Promise<AgentRecord>,
    updateAgent: (id, patch) =>
      agents.update(id, patch, { recordRevision: { source: "vector_provisioning" } }) as Promise<AgentRecord | null>,
    terminateAgent: (id) => agents.terminate(id) as Promise<AgentRecord | null>,
  };
}

async function reconcileVectorWorkloadRoutines(db: Db, manifest: VectorInstallationManifest) {
  for (const seed of vectorWorkloadRoutineSeeds(manifest)) {
    const routineExpected = {
      id: seed.routineId,
      companyId: seed.companyId,
      title: seed.title,
      description: seed.description,
      assigneeAgentId: seed.assigneeAgentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      activityGatePolicy: "always",
      activityGateScope: "company",
      originKind: "vector_workload_dispatch",
      originId: seed.queue,
    };
    let routine = await db.select().from(routines).where(and(
      eq(routines.companyId, seed.companyId),
      eq(routines.id, seed.routineId),
    )).then((rows) => rows[0] ?? null);
    if (!routine) {
      [routine] = await db.insert(routines).values(routineExpected).returning();
    }
    assertEqual("workloadRoutine", {
      id: routine.id,
      companyId: routine.companyId,
      title: routine.title,
      description: routine.description,
      assigneeAgentId: routine.assigneeAgentId,
      priority: routine.priority,
      status: routine.status,
      concurrencyPolicy: routine.concurrencyPolicy,
      catchUpPolicy: routine.catchUpPolicy,
      activityGatePolicy: routine.activityGatePolicy,
      activityGateScope: routine.activityGateScope,
      originKind: routine.originKind,
      originId: routine.originId,
    }, routineExpected);

    const triggerExpected = {
      id: seed.triggerId,
      companyId: seed.companyId,
      routineId: seed.routineId,
      kind: "schedule",
      label: `${seed.queue} queue pump`,
      cronExpression: seed.cronExpression,
      timezone: seed.timezone,
    };
    let trigger = await db.select().from(routineTriggers).where(and(
      eq(routineTriggers.companyId, seed.companyId),
      eq(routineTriggers.id, seed.triggerId),
    )).then((rows) => rows[0] ?? null);
    if (!trigger) {
      [trigger] = await db.insert(routineTriggers).values({
        ...triggerExpected,
        enabled: false,
        nextRunAt: null,
      }).returning();
    }
    // Enablement and scheduler timestamps are operator/runtime state. Every
    // other field is sealed so a reinstall cannot silently retarget a pump.
    assertEqual("workloadRoutineTrigger", {
      id: trigger.id,
      companyId: trigger.companyId,
      routineId: trigger.routineId,
      kind: trigger.kind,
      label: trigger.label,
      cronExpression: trigger.cronExpression,
      timezone: trigger.timezone,
    }, triggerExpected);
  }

  for (const seed of vectorScheduleRoutineSeeds(manifest)) {
    const routineExpected = {
      id: seed.routineId,
      companyId: seed.companyId,
      title: seed.title,
      description: seed.description,
      assigneeAgentId: seed.assigneeAgentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      activityGatePolicy: "always",
      activityGateScope: "company",
      originKind: "vector_schedule_dispatch",
      originId: seed.scheduleKey,
    };
    let routine = await db.select().from(routines).where(and(
      eq(routines.companyId, seed.companyId),
      eq(routines.id, seed.routineId),
    )).then((rows) => rows[0] ?? null);
    if (!routine) {
      [routine] = await db.insert(routines).values(routineExpected).returning();
    }
    assertEqual("vectorScheduleRoutine", {
      id: routine.id,
      companyId: routine.companyId,
      title: routine.title,
      description: routine.description,
      assigneeAgentId: routine.assigneeAgentId,
      priority: routine.priority,
      status: routine.status,
      concurrencyPolicy: routine.concurrencyPolicy,
      catchUpPolicy: routine.catchUpPolicy,
      activityGatePolicy: routine.activityGatePolicy,
      activityGateScope: routine.activityGateScope,
      originKind: routine.originKind,
      originId: routine.originId,
    }, routineExpected);

    const triggerExpected = {
      id: seed.triggerId,
      companyId: seed.companyId,
      routineId: seed.routineId,
      kind: "schedule",
      label: `${seed.scheduleKey} due check`,
      cronExpression: seed.cronExpression,
      timezone: seed.timezone,
    };
    let trigger = await db.select().from(routineTriggers).where(and(
      eq(routineTriggers.companyId, seed.companyId),
      eq(routineTriggers.id, seed.triggerId),
    )).then((rows) => rows[0] ?? null);
    if (!trigger) {
      [trigger] = await db.insert(routineTriggers).values({
        ...triggerExpected,
        enabled: false,
        nextRunAt: null,
      }).returning();
    }
    assertEqual("vectorScheduleRoutineTrigger", {
      id: trigger.id,
      companyId: trigger.companyId,
      routineId: trigger.routineId,
      kind: trigger.kind,
      label: trigger.label,
      cronExpression: trigger.cronExpression,
      timezone: trigger.timezone,
    }, triggerExpected);
  }
}

export async function provisionVectorInstallation(
  db: Db,
  input: VectorProvisioningInput,
): Promise<VectorProvisioningReceipt> {
  return db.transaction(async (tx) => {
    const transactionDb = tx as unknown as Db;
    const receipt = await reconcileVectorInstallation(productionPort(transactionDb), input);
    const manifest = vectorInstallationManifestSchema.parse(input.manifest);
    await reconcileVectorWorkloadRoutines(transactionDb, manifest);
    return receipt;
  });
}
