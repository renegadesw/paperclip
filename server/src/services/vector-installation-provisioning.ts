import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { type Db, routineTriggers, routines, vectorInstallationOwnerships } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { isVectorFunkyServerProfile } from "@paperclipai/adapter-utils/vector-profiles";
import { resolveHomeAwarePath } from "../home-paths.js";
import { agentService } from "./agents.js";
import { companyService } from "./companies.js";
import { instanceSettingsService } from "./instance-settings.js";
import { nextCronTickInTimeZone } from "./routines.js";
import { VECTOR_RESEARCH_ROUTINE_ORIGIN_KIND } from "./vector-routine-run-authority.js";
import {
  RETIRED_VECTOR_SCHEDULE_KEYS,
  VECTOR_SCHEDULE_KEYS,
  VECTOR_SCHEDULE_ROUTINE_ORIGIN_KIND,
} from "./vector-schedule-routine-dispatch.js";
import { VECTOR_WORKLOAD_ROUTINE_ORIGIN_KIND } from "./vector-workload-routine-dispatch.js";

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

// adapterConfig keys an operator may change on the board (and Vector OS may
// change through its admin relay) without breaking the next release install.
// The seed value is used on create; afterwards the live value is preserved,
// excluded from the drift assertion, and never overwritten by an upgrade.
// Every other adapterConfig key stays sealed.
const operatorOwnedAdapterConfigKey = z.enum(["model", "thinking"]);

// The release owns instructionsFilePath. When the board saves an agent it
// derives these bundle keys from that path (syncInstructionsBundleConfigFromFilePath)
// and may rewrite the path into an equivalent form. They are normalized away,
// never treated as a persona change, as long as the file they name still holds
// the sealed release content.
const RELEASE_INSTRUCTIONS_KEY = "instructionsFilePath";
const BOARD_INSTRUCTIONS_METADATA_KEYS = ["instructionsBundleMode", "instructionsRootPath", "instructionsEntryFile"] as const;
const BOARD_INSTRUCTIONS_DEFAULT_ENTRY_FILE = "AGENTS.md";

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

const operatorAdapterConfigValueSchemas = {
  model: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
} as const satisfies Record<z.infer<typeof operatorOwnedAdapterConfigKey>, z.ZodTypeAny>;

const vectorAgentManifestSchema = z.object({
  id: UUID,
  name: z.string().min(1),
  role: z.string().min(1),
  title: z.string().nullable(),
  // The agent this one reports to. It must name an agent declared earlier in
  // the manifest, so the declaration order is a valid creation order (managers
  // before their reports) and the hierarchy is acyclic by construction.
  reportsTo: UUID.nullable().default(null),
  capabilities: z.string().nullable(),
  adapterType: z.literal("pi_local"),
  adapterConfig: z.object({
    model: operatorAdapterConfigValueSchemas.model,
    thinking: operatorAdapterConfigValueSchemas.thinking,
    executionMode: z.literal("rpc"),
    cwd: z.string().refine(path.isAbsolute, "cwd must be absolute"),
  }).strict(),
  operatorOwnedAdapterConfigKeys: z.array(operatorOwnedAdapterConfigKey).default([]),
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

// FunkyDev's GitHub access is Paperclip's `github.code` connector (hosted
// GitHub MCP plus the run-scoped git/gh launchers), granted to the agent on
// the board. Vector's callback bridge carries only the tools no connector
// provides, the same set as Standard Chat.
const engineeringCallbackExtension = chatCallbackExtension;

const stagingCallbackExtension = {
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

const dmvReviewPolicy = {
  leaseSeconds: 900, maxAttempts: 2, tokenBudget: 8000,
  mayDetach: false, mayWrite: false, requiresEvidence: true,
  modelPolicy: null,
  gatingFlag: "product.dmv.review",
  payloadFunction: "dmv.review_payload",
  promptFunction: "dmv.review_prompt",
  settlementFunction: "dmv.review_settle",
  escalationRole: "compliance-advisor",
  lineage: { maxSpawnDepth: 0, allowInTurnChildren: false, allowedChildTypes: [], maxParallelChildren: 1 },
};

const dmvTriagePolicy = {
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
};

const scoutTools = ["research_ready_slices", "research_record_finding", "research_slice_payload"];
const dmvReadTools = ["dmv.get_pipeline_health", "dmv.list_audit_back", "dmv.list_recent_pipeline_failures"];

// On the Funky server profiles every workload is ordinary Paperclip work: a
// routine creates an issue assigned to the workload's agent, a normal
// heartbeat run does it, and the run's Vector tools are exactly toolSurface.
// Scheduling is the routine's own trigger (routine.cron in routine.timezone);
// no Vector queue, lease or claim envelope is involved. The DMV triggers are
// seeded disabled because their Vector schedule rows are disabled.
const funkyWorkloadSpecs = {
  current_scout: {
    kind: "research_task", executionShape: "single_shot", role: "funky-scout", tools: scoutTools, policy: researchPolicy,
    routine: { cronExpression: "20 8 * * *", timezone: "America/New_York", enabled: true },
  },
  macro_scout: {
    kind: "research_task", executionShape: "single_shot", role: "funky-scout", tools: scoutTools, policy: researchPolicy,
    routine: { cronExpression: "20 8 * * *", timezone: "America/New_York", enabled: true },
  },
  demand_scout: {
    kind: "research_task", executionShape: "single_shot", role: "funky-scout", tools: scoutTools, policy: researchPolicy,
    routine: { cronExpression: "20 8 * * *", timezone: "America/New_York", enabled: true },
  },
  advisor: {
    kind: "research_task", executionShape: "single_shot", role: "funky-advisor",
    tools: ["pull_check_evidence", "research_record_finding"], policy: researchPolicy,
    routine: { cronExpression: "40 8 * * *", timezone: "America/New_York", enabled: true },
  },
  synthesis: {
    kind: "research_task", executionShape: "single_shot", role: "funky-scout",
    tools: ["research_findings_today", "research_record_finding"], policy: researchPolicy,
    routine: { cronExpression: "20 9 * * *", timezone: "America/New_York", enabled: true },
  },
  curation: {
    kind: "research_task", executionShape: "single_shot", role: "funky-scout",
    tools: ["research_findings_today", "research_record_curation"], policy: researchPolicy,
    routine: { cronExpression: "50 9 * * *", timezone: "America/New_York", enabled: true },
  },
  dmv_review: {
    kind: "generic_task", executionShape: "single_shot", role: "funky-advisor", tools: dmvReadTools, policy: dmvReviewPolicy,
    routine: { cronExpression: "30 7 * * *", timezone: "America/New_York", enabled: false },
  },
  dmv_audit_back_triage: {
    kind: "generic_task", executionShape: "session", role: "funky-advisor", tools: dmvReadTools, policy: dmvTriagePolicy,
    routine: { cronExpression: "0 8 * * *", timezone: "America/New_York", enabled: false },
  },
} as const;

export type VectorResearchWorkloadKey = keyof typeof funkyWorkloadSpecs;

const researchIssuePreamble = (key: string) =>
  `Scheduled Vector research workload \`${key}\`. This issue carries no data: every input comes from the Vector tools bound to this run and every result is written through them. Report only what the tools returned. If a write tool refuses something, name the refusal and its reason in your summary; never reword a finding to get it past the check. You do not update this issue yourself: Paperclip posts your final message on it and closes it when your run ends (done when the run succeeds, blocked when it fails).`;

const skippedRule =
  "If the source is not ready, end the run with a final message that starts with \"Skipped: source not ready\" and names each reason the tool gave. Do not retry in the same run.";

// The sealed issue title and description of each research routine. They are
// the agent's instructions for one run; Paperclip's routine owns scheduling.
const researchRoutineIssueTemplates: Record<VectorResearchWorkloadKey, { title: string; description: string }> = {
  current_scout: {
    title: "Current scout",
    description: [
      researchIssuePreamble("current_scout"),
      "1. Call `research_ready_slices` with `{\"horizon\": \"current\"}`. It returns the slice keys that are ready now and a not-ready reason for every other slice.",
      `2. ${skippedRule}`,
      "3. For each ready slice key call `research_slice_payload` with `{\"slice_key\": \"<key>\"}`. Today's row (days_ago = 0) is the only possible subject; prior rows are context.",
      "4. For each material finding call `research_record_finding` with the slice_key and the finding, horizon \"current\". An unremarkable slice records nothing.",
      "5. End with a final message of one line per slice (findings recorded, none, or refused).",
    ].join("\n\n"),
  },
  macro_scout: {
    title: "Macro scout",
    description: [
      researchIssuePreamble("macro_scout"),
      "1. Call `research_ready_slices` with `{\"horizon\": \"macro\"}`. It returns the slice keys that are ready now and a not-ready reason for every other slice.",
      `2. ${skippedRule}`,
      "3. For each ready slice key call `research_slice_payload` with `{\"slice_key\": \"<key>\"}` and review its historical windows: persistent direction, acceleration, reversals and regime changes. A window the payload marks as lacking coverage is not evidence.",
      "4. For each material finding call `research_record_finding` with the slice_key and the finding, horizon \"weekly\", \"monthly\" or \"quarterly\" for the window it is about.",
      "5. End with a final message of one line per slice (findings recorded, none, or refused).",
    ].join("\n\n"),
  },
  demand_scout: {
    title: "Demand scout",
    description: [
      researchIssuePreamble("demand_scout"),
      "1. Call `research_ready_slices` with `{\"horizon\": \"demand\"}`. It returns the slice keys that are ready now and a not-ready reason for every other slice.",
      `2. ${skippedRule}`,
      "3. For each ready slice key call `research_slice_payload` with `{\"slice_key\": \"<key>\"}` and review what users asked: repeated questions, unanswered questions, and questions that stopped.",
      "4. For each material finding call `research_record_finding` with the slice_key and the finding, horizon \"current\".",
      "5. End with a final message of one line per slice (findings recorded, none, or refused).",
    ].join("\n\n"),
  },
  advisor: {
    title: "Office Advisor checks",
    description: [
      researchIssuePreamble("advisor"),
      "1. Call `pull_check_evidence` for your authored checks.",
      `2. ${skippedRule} An advisor with no active checks is skipped the same way.`,
      "3. Call `research_record_finding` once with a concise Binder update in your remit: lead with the operational takeaway, name checks that were skipped or errored, separate what the checks show from what you infer, and say plainly when nothing needs attention. A proposed action is a recommendation for a human decision; never claim it was executed.",
      "4. End with a one-line final summary.",
    ].join("\n\n"),
  },
  synthesis: {
    title: "Research synthesis",
    description: [
      researchIssuePreamble("synthesis"),
      "1. Call `research_findings_today` with `{\"kinds\": [\"current_scout\", \"macro_scout\", \"demand_scout\"]}`. Those findings are your entire evidence; you cannot see the data behind them.",
      `2. ${skippedRule} No scout findings today counts as not ready.`,
      "3. Relate the findings to each other: reinforcement, contradiction, anomalies the longer history explains, deterioration not yet visible today. Copy subjects and identifiers verbatim and never introduce a magnitude that no input finding carries.",
      "4. Call `research_record_finding` for each synthesis finding, horizon \"cross\".",
      "5. End with a one-line final summary.",
    ].join("\n\n"),
  },
  curation: {
    title: "Research curation",
    description: [
      researchIssuePreamble("curation"),
      "1. Call `research_findings_today` with `{\"kinds\": [\"current_scout\", \"macro_scout\", \"demand_scout\", \"synthesis\"]}`.",
      `2. ${skippedRule} No findings today counts as not ready.`,
      "3. Score every finding on materiality, novelty, confidence, freshness and usefulness, judging it as written. Recommend nothing whose evidence receipt is missing or whose observation and inference are not separated.",
      "4. Call `research_record_curation` with a verdict (publish, hold or reject), a rank and a brief reason for each finding, copying each finding id exactly.",
      "5. End with a one-line final summary.",
    ].join("\n\n"),
  },
  dmv_review: {
    title: "DMV daily intake review",
    description: [
      researchIssuePreamble("dmv_review"),
      "1. Call `dmv.get_pipeline_health` and `dmv.list_recent_pipeline_failures` for today's intake, and `dmv.list_audit_back` for items sent back for review.",
      `2. ${skippedRule} A pipeline with no intake for the day is not ready.`,
      "3. End with a final message reviewing for a human: what the pipeline shows, each failure with its reason, and any recommended follow-up. You cannot change DMV state.",
    ].join("\n\n"),
  },
  dmv_audit_back_triage: {
    title: "DMV audit-back triage",
    description: [
      researchIssuePreamble("dmv_audit_back_triage"),
      "1. Call `dmv.list_audit_back`, then `dmv.get_pipeline_health` and `dmv.list_recent_pipeline_failures` for context.",
      `2. ${skippedRule} An empty audit-back list is not a skip: say so in your final message.`,
      "3. End with a final message triaging for a human: each audit-back item, the likely cause the evidence supports, and a recommended action. You cannot change DMV state and must not claim any action was taken.",
    ].join("\n\n"),
  },
};

// The one Vector jobs schedule Paperclip still dispatches on Funky profiles.
// Research fan-out, lease sweeps and the DMV enqueue schedules are replaced by
// the native research routines above and are retired (see
// RETIRED_VECTOR_SCHEDULE_KEYS).
const stagingScheduleSpecs = {
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
  const agentRoles = new Set<string>();
  for (const [index, agent] of allAgents.entries()) {
    const prefix = index === 0 ? ["agent"] : ["additionalAgents", index - 1];
    if (agentIds.has(agent.id)) {
      ctx.addIssue({ code: "custom", path: [...prefix, "id"], message: "agent ids must be unique" });
    }
    if (agentNames.has(agent.name)) {
      ctx.addIssue({ code: "custom", path: [...prefix, "name"], message: "agent names must be unique" });
    }
    if (agentRoles.has(agent.role)) {
      ctx.addIssue({ code: "custom", path: [...prefix, "role"], message: "agent roles must be unique" });
    }
    // Only agents already declared are admissible managers. This rejects a
    // self-reference, a forward reference, an unknown id, and therefore any
    // cycle, and makes manifest order a valid creation order.
    if (agent.reportsTo !== null && !agentIds.has(agent.reportsTo)) {
      ctx.addIssue({
        code: "custom",
        path: [...prefix, "reportsTo"],
        message: "agent reportsTo must name an agent declared earlier in the manifest",
      });
    }
    agentIds.add(agent.id);
    agentNames.add(agent.name);
    agentRoles.add(agent.role);
    if (new Set(agent.mutableFields).size !== agent.mutableFields.length) {
      ctx.addIssue({ code: "custom", path: [...prefix, "mutableFields"], message: "agent.mutableFields must be unique" });
    }
    if (new Set(agent.operatorOwnedAdapterConfigKeys).size !== agent.operatorOwnedAdapterConfigKeys.length) {
      ctx.addIssue({
        code: "custom",
        path: [...prefix, "operatorOwnedAdapterConfigKeys"],
        message: "agent.operatorOwnedAdapterConfigKeys must be unique",
      });
    }
    if (agent.operatorOwnedAdapterConfigKeys.length > 0 && agent.mutableFields.includes("adapterConfig")) {
      ctx.addIssue({
        code: "custom",
        path: [...prefix, "operatorOwnedAdapterConfigKeys"],
        message: "operator-owned adapterConfig keys are redundant when all of adapterConfig is mutable",
      });
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
    // The FunkyDev software org: FunkyDev is the primary agent and leads it,
    // reporting to no agent (the operator sits on the board); every other seat
    // reports to an agent declared before it.
    if (manifest.agent.name !== "FunkyDev" || manifest.agent.role !== "engineer" || manifest.agent.reportsTo !== null) {
      ctx.addIssue({ code: "custom", path: ["agent"], message: "engineering installs are led by the FunkyDev engineer, reporting to no agent" });
    }
    for (const [index, agent] of manifest.additionalAgents.entries()) {
      if (agent.reportsTo === null) {
        ctx.addIssue({
          code: "custom",
          path: ["additionalAgents", index, "reportsTo"],
          message: "every engineering seat other than FunkyDev must report to an agent declared before it",
        });
      }
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
    const expectedWorkloads = Object.keys(funkyWorkloadSpecs).sort();
    if (stableJson([...workloadKeys].sort()) !== stableJson(expectedWorkloads)) {
      ctx.addIssue({ code: "custom", path: ["workloads"], message: `${manifest.profile} installs require the complete Vector workload catalog` });
    }
    const roleByAgentId = new Map(allAgents.map((agent) => [agent.id, agent.role]));
    for (const [index, workload] of manifest.workloads.entries()) {
      const expected = funkyWorkloadSpecs[workload.key as VectorResearchWorkloadKey];
      if (!expected) continue;
      // The Vector lease path (queue pumps, claim envelopes, lease triples) is
      // retired on Funky profiles. Say so rather than reporting a bare mismatch.
      if (workload.runtimeAuthority !== "paperclip" || workload.promptSource !== "paperclip_issue") {
        ctx.addIssue({
          code: "custom",
          path: ["workloads", index],
          message: `${manifest.profile} workload ${workload.key} declares ${workload.promptSource}/${workload.runtimeAuthority}; `
            + "Funky workloads run as Paperclip routine issues (paperclip_issue/paperclip)",
        });
        continue;
      }
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
      };
      // The routine trigger is the schedule. A Vector jobs schedule or lease
      // recovery sweep on a native workload would fire the retired path too.
      const required = {
        kind: expected.kind,
        executionShape: expected.executionShape,
        role: expected.role,
        tools: [...expected.tools].sort(),
        policy: expected.policy,
        schedule: null,
        recoverySchedule: null,
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
      ["advisor", []],
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

/**
 * One ordinary issue-creating routine per Funky workload. Its issue is
 * assigned to the workload's agent and runs as a normal heartbeat run; the
 * routine-run authority binds that run's Vector tools to the workload's
 * declared tool surface (sealed on the agent's vectorWorkloads contract).
 */
export function vectorResearchRoutineSeeds(manifest: VectorInstallationManifest) {
  if (!isVectorFunkyServerProfile(manifest.profile)) return [];
  return manifest.workloads
    .filter((workload) => Object.hasOwn(funkyWorkloadSpecs, workload.key))
    .map((workload) => {
      const key = workload.key as VectorResearchWorkloadKey;
      const spec = funkyWorkloadSpecs[key];
      const template = researchRoutineIssueTemplates[key];
      return {
        routineId: deterministicUuid(`${manifest.installationId}:paperclip-research-routine:${key}`),
        triggerId: deterministicUuid(`${manifest.installationId}:paperclip-research-trigger:${key}`),
        companyId: manifest.company.id,
        assigneeAgentId: workload.agentId,
        workloadKey: key,
        title: template.title,
        description: template.description,
        toolSurface: [...workload.toolSurface].sort(),
        cronExpression: spec.routine.cronExpression,
        timezone: spec.routine.timezone,
        enabledAtSeed: spec.routine.enabled,
      };
    })
    .sort((left, right) => left.workloadKey.localeCompare(right.workloadKey));
}

/**
 * Control routines earlier releases seeded on Funky profiles that the native
 * research routines replace: the two Vector queue pumps and the Vector jobs
 * schedules for research fan-out, lease sweeps and DMV enqueues. They are
 * archived with their triggers disabled, never deleted, so run history stays.
 */
export function retiredVectorControlRoutines(manifest: VectorInstallationManifest) {
  if (!isVectorFunkyServerProfile(manifest.profile)) return [];
  return [
    ...(["research", "tasks"] as const).map((queue) => ({
      routineId: deterministicUuid(`${manifest.installationId}:paperclip-workload-routine:${queue}`),
      companyId: manifest.company.id,
      originKind: VECTOR_WORKLOAD_ROUTINE_ORIGIN_KIND,
      originId: queue as string,
    })),
    ...RETIRED_VECTOR_SCHEDULE_KEYS.map((scheduleKey) => ({
      routineId: deterministicUuid(`${manifest.installationId}:paperclip-schedule-routine:${scheduleKey}`),
      companyId: manifest.company.id,
      originKind: VECTOR_SCHEDULE_ROUTINE_ORIGIN_KIND,
      originId: scheduleKey as string,
    })),
  ];
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
  reportsTo?: string | null;
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
 * Whether the release owns the reporting hierarchy. The engineering org always
 * does; any other roster does once it declares a manager. A flat roster that
 * never declares one leaves reportsTo out of its declared fields, so a board
 * edit of it is neither asserted nor overwritten, exactly as before the field
 * existed.
 */
function manifestOwnsReportingHierarchy(manifest: VectorInstallationManifest): boolean {
  return manifest.profile === "engineering"
    || [manifest.agent, ...manifest.additionalAgents].some((agent) => agent.reportsTo !== null);
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

/**
 * The instructions digest this installation last provisioned onto an agent,
 * or null for a marker written before the digest was recorded.
 */
function provisionedInstructionsSha256(agent: AgentRecord): string | null {
  const marker = agent.metadata?.vectorProvisioning;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  const digest = (marker as Record<string, unknown>).instructionsSha256;
  return typeof digest === "string" && SHA256.safeParse(digest).success ? digest : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function sha256OfFile(filePath: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Every file the live adapterConfig names as the agent's instructions: the
 * path Pi appends (instructionsFilePath, resolved against cwd like pi_local
 * does) and the board's bundle root + entry file. They must all hold the same
 * release content, or the persona was edited.
 */
function liveInstructionsTargets(live: Record<string, unknown>, cwd: string): string[] {
  const targets = new Set<string>();
  const filePath = nonEmptyString(live[RELEASE_INSTRUCTIONS_KEY]);
  if (filePath) targets.add(path.resolve(cwd, filePath));
  const rootPath = nonEmptyString(live.instructionsRootPath);
  if (rootPath) {
    const entryFile = nonEmptyString(live.instructionsEntryFile) ?? BOARD_INSTRUCTIONS_DEFAULT_ENTRY_FILE;
    targets.add(path.resolve(resolveHomeAwarePath(rootPath), entryFile));
  }
  return [...targets];
}

/**
 * Reconciles a live agent's adapterConfig against the release.
 *
 * - Operator-owned keys keep their live value (seed value only when absent).
 * - The release re-asserts its canonical instructionsFilePath and drops the
 *   board's bundle metadata, but only after proving every file the live config
 *   names still holds the provisioned persona. A different persona fails closed.
 * - With `assertSealed`, every other key must equal the release exactly (same
 *   revision). Without it (a revision upgrade) the release overwrites them.
 *
 * Returns the adapterConfig the agent must carry after this install.
 */
async function reconcileAdapterConfig(input: {
  agentName: string;
  live: unknown;
  expected: Record<string, unknown>;
  operatorOwnedKeys: readonly z.infer<typeof operatorOwnedAdapterConfigKey>[];
  provisionedInstructionsSha256: string;
  assertSealed: boolean;
}): Promise<Record<string, unknown>> {
  const live = asRecord(input.live);
  const operatorOwned = new Set<string>(input.operatorOwnedKeys);
  const instructionKeys = new Set<string>([RELEASE_INSTRUCTIONS_KEY, ...BOARD_INSTRUCTIONS_METADATA_KEYS]);

  if (input.assertSealed) {
    for (const key of new Set([...Object.keys(live), ...Object.keys(input.expected)])) {
      if (operatorOwned.has(key) || instructionKeys.has(key)) continue;
      assertEqual(`agent.adapterConfig.${key}`, live[key], input.expected[key]);
    }
  }

  const canonicalInstructions = input.expected[RELEASE_INSTRUCTIONS_KEY];
  const boardMetadataPresent = BOARD_INSTRUCTIONS_METADATA_KEYS.some((key) => live[key] !== undefined);
  if (boardMetadataPresent || (input.assertSealed && live[RELEASE_INSTRUCTIONS_KEY] !== canonicalInstructions)) {
    const cwd = nonEmptyString(live.cwd) ?? String(input.expected.cwd);
    const targets = liveInstructionsTargets(live, path.isAbsolute(cwd) ? cwd : String(input.expected.cwd));
    if (targets.length === 0) {
      throw new Error(
        `Vector provisioning drift: ${input.agentName} instructions were removed on the board; `
          + `release sha256 ${input.provisionedInstructionsSha256}`,
      );
    }
    for (const target of targets) {
      const liveDigest = await sha256OfFile(target);
      if (liveDigest !== input.provisionedInstructionsSha256) {
        throw new Error(
          `Vector provisioning drift: ${input.agentName} instructions differ from the release `
            + `(live sha256 ${liveDigest ?? "unreadable"}, release sha256 ${input.provisionedInstructionsSha256}); `
            + "the persona is release-owned and cannot be edited on the board",
        );
      }
    }
  }

  const reconciled: Record<string, unknown> = { ...input.expected };
  for (const key of input.operatorOwnedKeys) {
    if (live[key] === undefined) continue;
    const parsed = operatorAdapterConfigValueSchemas[key].safeParse(live[key]);
    if (!parsed.success) {
      throw new Error(`Vector provisioning drift: ${input.agentName} operator-owned adapterConfig.${key} is invalid`);
    }
    reconciled[key] = parsed.data;
  }
  return reconciled;
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

  // A null reportsTo is left out so a flat roster that never declared the
  // field keeps the roster digest it was provisioned with.
  const rosterAgents = [manifest.agent, ...manifest.additionalAgents].map(({
    mutableFields: _mutableFields,
    operatorOwnedAdapterConfigKeys: _operatorOwnedAdapterConfigKeys,
    reportsTo,
    ...agent
  }) => (reportsTo === null ? agent : { ...agent, reportsTo }));
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
  const ownsReportingHierarchy = manifestOwnsReportingHierarchy(manifest);
  // Manifest order is creation order: the schema admits a manager only when it
  // is declared earlier, so every manager exists (and carries its own declared
  // reportsTo) before a report is created or re-pointed at it.
  for (const desired of [manifest.agent, ...manifest.additionalAgents]) {
    const workloadKeys = manifest.workloads.filter((workload) => workload.agentId === desired.id).map((workload) => workload.key).sort();
    const agentExpected = {
      id: desired.id,
      name: desired.name,
      role: desired.role,
      title: desired.title,
      ...(ownsReportingHierarchy ? { reportsTo: desired.reportsTo } : {}),
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
          instructionsSha256: desired.instructions.sha256,
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
      const mutable = new Set<string>(desired.mutableFields);
      const upgrading = storedRevision < manifest.manifestRevision;
      // Validated before any agent mutation so a refused install changes nothing.
      const adapterConfig = mutable.has("adapterConfig")
        ? agentExpected.adapterConfig
        : await reconcileAdapterConfig({
          agentName: desired.name,
          live: agent.adapterConfig,
          expected: agentExpected.adapterConfig,
          operatorOwnedKeys: desired.operatorOwnedAdapterConfigKeys,
          // An upgrade proves the live persona against the one this installation
          // last provisioned; markers from before the digest was recorded fall
          // back to the release's digest.
          provisionedInstructionsSha256: (upgrading ? provisionedInstructionsSha256(agent) : null)
            ?? desired.instructions.sha256,
          assertSealed: !upgrading,
        });
      const expectedAfter = { ...agentExpected, adapterConfig };
      if (upgrading) {
        // A newer revision owns every declared field except operator-mutable
        // fields and operator-owned adapterConfig keys.
        const collision = existingAgents.find((candidate) => candidate.id !== agent!.id && candidate.name === desired.name);
        if (collision) throw new Error("Vector provisioning agent identity collision");
        const { id: _id, ...declared } = expectedAfter;
        const patch = Object.fromEntries(Object.entries(declared).filter(([key]) => !mutable.has(key)));
        agent = await port.updateAgent(agent.id, patch);
        if (!agent || agent.companyId !== company.id) throw new Error("Vector provisioning agent upgrade failed");
      } else if (!mutable.has("adapterConfig") && stableJson(agent.adapterConfig) !== stableJson(adapterConfig)) {
        // Same revision: re-assert the release's canonical instructions over
        // board bundle metadata, keeping operator-owned values.
        agent = await port.updateAgent(agent.id, { adapterConfig });
        if (!agent || agent.companyId !== company.id) throw new Error("Vector provisioning agent normalization failed");
      }
      assertImmutableFields("agent", agent, expectedAfter, desired.mutableFields);
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

type ProvisionedRoutine = {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  assigneeAgentId: string | null;
  priority: string;
  status: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  activityGatePolicy: string;
  activityGateScope: string;
  originKind: string;
  originId: string | null;
};

type ProvisionedRoutineTrigger = {
  id: string;
  companyId: string;
  routineId: string;
  kind: string;
  label: string | null;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: Date | null;
};

/** The routine rows provisioning owns, behind a port so reconciliation is testable without a database. */
export interface VectorRoutineProvisioningPort {
  getRoutine(companyId: string, id: string): Promise<ProvisionedRoutine | null>;
  createRoutine(input: ProvisionedRoutine): Promise<ProvisionedRoutine>;
  archiveRoutine(companyId: string, id: string, at: Date): Promise<void>;
  getTrigger(companyId: string, id: string): Promise<ProvisionedRoutineTrigger | null>;
  createTrigger(input: ProvisionedRoutineTrigger): Promise<ProvisionedRoutineTrigger>;
  disableRoutineTriggers(companyId: string, routineId: string, at: Date): Promise<void>;
}

const routineColumns = {
  id: routines.id,
  companyId: routines.companyId,
  title: routines.title,
  description: routines.description,
  assigneeAgentId: routines.assigneeAgentId,
  priority: routines.priority,
  status: routines.status,
  concurrencyPolicy: routines.concurrencyPolicy,
  catchUpPolicy: routines.catchUpPolicy,
  activityGatePolicy: routines.activityGatePolicy,
  activityGateScope: routines.activityGateScope,
  originKind: routines.originKind,
  originId: routines.originId,
};

const triggerColumns = {
  id: routineTriggers.id,
  companyId: routineTriggers.companyId,
  routineId: routineTriggers.routineId,
  kind: routineTriggers.kind,
  label: routineTriggers.label,
  enabled: routineTriggers.enabled,
  cronExpression: routineTriggers.cronExpression,
  timezone: routineTriggers.timezone,
  nextRunAt: routineTriggers.nextRunAt,
};

function routineProvisioningPort(db: Db): VectorRoutineProvisioningPort {
  return {
    getRoutine: (companyId, id) => db.select(routineColumns).from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.id, id)))
      .then((rows) => rows[0] ?? null),
    createRoutine: (input) => db.insert(routines).values(input).returning(routineColumns).then((rows) => rows[0]!),
    archiveRoutine: async (companyId, id, at) => {
      await db.update(routines).set({ status: "archived", updatedAt: at })
        .where(and(eq(routines.companyId, companyId), eq(routines.id, id)));
    },
    getTrigger: (companyId, id) => db.select(triggerColumns).from(routineTriggers)
      .where(and(eq(routineTriggers.companyId, companyId), eq(routineTriggers.id, id)))
      .then((rows) => rows[0] ?? null),
    createTrigger: (input) => db.insert(routineTriggers).values(input).returning(triggerColumns).then((rows) => rows[0]!),
    disableRoutineTriggers: async (companyId, routineId, at) => {
      await db.update(routineTriggers).set({ enabled: false, nextRunAt: null, updatedAt: at })
        .where(and(eq(routineTriggers.companyId, companyId), eq(routineTriggers.routineId, routineId)));
    },
  };
}

function pickFields<T extends object>(record: T, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, (record as Record<string, unknown>)[key]]));
}

/**
 * Creates a provisioned routine once and asserts its sealed fields on every
 * later install. Keys in operatorOwned are the operator's to change on the
 * board and are only used on create.
 */
async function ensureSealedRoutine(
  port: VectorRoutineProvisioningPort,
  label: string,
  expected: ProvisionedRoutine,
  operatorOwned: readonly (keyof ProvisionedRoutine)[] = [],
): Promise<void> {
  const routine = await port.getRoutine(expected.companyId, expected.id) ?? await port.createRoutine(expected);
  const sealed = Object.keys(expected).filter((key) => !operatorOwned.includes(key as keyof ProvisionedRoutine));
  assertEqual(label, pickFields(routine, sealed), pickFields(expected, sealed));
}

/**
 * Same contract for a routine's schedule trigger. Enablement and scheduler
 * timestamps are operator/runtime state; every other field is sealed so a
 * reinstall cannot silently retarget a routine.
 */
async function ensureSealedTrigger(
  port: VectorRoutineProvisioningPort,
  label: string,
  expected: Omit<ProvisionedRoutineTrigger, "enabled" | "nextRunAt">,
  initial: { enabled: boolean; nextRunAt: Date | null },
): Promise<void> {
  const trigger = await port.getTrigger(expected.companyId, expected.id)
    ?? await port.createTrigger({ ...expected, ...initial });
  const sealed = Object.keys(expected);
  assertEqual(label, pickFields(trigger, sealed), pickFields(expected, sealed));
}

export async function reconcileVectorRoutines(
  port: VectorRoutineProvisioningPort,
  manifest: VectorInstallationManifest,
  now: Date = new Date(),
): Promise<void> {
  // Retire first: a pump or research fan-out left enabled next to the native
  // routines would run the same workload twice.
  for (const retired of retiredVectorControlRoutines(manifest)) {
    const routine = await port.getRoutine(retired.companyId, retired.routineId);
    if (!routine) continue;
    assertEqual("retiredVectorControlRoutine", {
      originKind: routine.originKind,
      originId: routine.originId,
    }, { originKind: retired.originKind, originId: retired.originId });
    if (routine.status !== "archived") await port.archiveRoutine(retired.companyId, retired.routineId, now);
    await port.disableRoutineTriggers(retired.companyId, retired.routineId, now);
  }

  for (const seed of vectorResearchRoutineSeeds(manifest)) {
    // Pausing or archiving a research routine is an operator decision made on
    // the board, so status is not sealed. Everything that decides what the
    // issue asks for, who does it and how it is scheduled is.
    await ensureSealedRoutine(port, "vectorResearchRoutine", {
      id: seed.routineId,
      companyId: seed.companyId,
      title: seed.title,
      description: seed.description,
      assigneeAgentId: seed.assigneeAgentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "skip_if_active",
      catchUpPolicy: "skip_missed",
      activityGatePolicy: "always",
      activityGateScope: "company",
      originKind: VECTOR_RESEARCH_ROUTINE_ORIGIN_KIND,
      originId: seed.workloadKey,
    }, ["status"]);
    await ensureSealedTrigger(port, "vectorResearchRoutineTrigger", {
      id: seed.triggerId,
      companyId: seed.companyId,
      routineId: seed.routineId,
      kind: "schedule",
      label: `${seed.workloadKey} schedule`,
      cronExpression: seed.cronExpression,
      timezone: seed.timezone,
    }, {
      enabled: seed.enabledAtSeed,
      nextRunAt: seed.enabledAtSeed ? nextCronTickInTimeZone(seed.cronExpression, seed.timezone, now) : null,
    });
  }

  for (const seed of vectorScheduleRoutineSeeds(manifest)) {
    // Pausing a schedule routine is an operator decision made on the board, as
    // it is for research routines: a paused routine stops waking its Vector
    // schedule. Sealing status refused every reinstall after an operator pause
    // (prod1, 2026-10-05). Everything else stays sealed.
    await ensureSealedRoutine(port, "vectorScheduleRoutine", {
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
      originKind: VECTOR_SCHEDULE_ROUTINE_ORIGIN_KIND,
      originId: seed.scheduleKey,
    }, ["status"]);
    await ensureSealedTrigger(port, "vectorScheduleRoutineTrigger", {
      id: seed.triggerId,
      companyId: seed.companyId,
      routineId: seed.routineId,
      kind: "schedule",
      label: `${seed.scheduleKey} due check`,
      cronExpression: seed.cronExpression,
      timezone: seed.timezone,
    }, { enabled: false, nextRunAt: null });
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
    await reconcileVectorRoutines(routineProvisioningPort(transactionDb), manifest);
    // Vector ingress turns are Agent Chat conversations; with the experimental
    // flag off every NexusLink turn is refused (422). The release owns it.
    const settings = instanceSettingsService(transactionDb);
    if (!(await settings.getExperimental()).enableAgentChat) {
      await settings.updateExperimental({ enableAgentChat: true });
    }
    return receipt;
  });
}
