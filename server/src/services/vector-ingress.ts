import { localBoardUserId } from "../local-board-identity.js";
import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  assets,
  heartbeatRunEvents,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issues,
  vectorIngressConversations,
  vectorIngressBranchHeads,
  vectorIngressBranchTurns,
  vectorIngressTurns,
  type Db,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { deliverConversationComments } from "./agent-conversations.js";
import { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";
import type { VectorToolPendingDescriptor } from "./vector-tool-authority.js";
import type { VectorProviderPendingDescriptor } from "./vector-provider-authority.js";
import type { StorageService } from "../storage/index.js";
import {
  isVectorIngressImageAsset,
  validateVectorIngressImages,
  type VectorIngressImageInput,
} from "./vector-ingress-images.js";
import {
  VECTOR_LEGACY_PI_CONTEXT_ORIGIN,
  type VectorLegacyPiContextImporter,
  type VectorLegacyPiContextImportResult,
} from "./vector-legacy-pi-context.js";
import { vectorIngressOwnerSha256 } from "./vector-ingress-owner.js";
import {
  vectorSessionBranchService,
  type VectorSessionBranchService,
} from "./vector-session-branches.js";

export { vectorIngressOwnerSha256 } from "./vector-ingress-owner.js";

const VECTOR_INGRESS_ACTOR_ID = "vector-ingress";
const ACTIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;

export interface VectorIngressScope {
  companyId: string;
  agentId: string;
  externalSessionId: string;
  ownerId?: string;
  installationId?: string;
  profileId?: string;
}

export interface VectorIngressOwnerScope {
  companyId: string;
  agentId: string;
  ownerId: string;
  installationId: string;
  profileId: string;
}

export interface VectorIngressTurnInput extends VectorIngressScope {
  voiceActive?: boolean;
  clientRequestId: string;
  body: string;
  attachmentIds?: string[];
  images?: VectorIngressImageInput[];
  authorityHandle?: string;
  authorityTools?: string[];
  providerAuthorityHandle?: string;
  launchContext?: VectorWorkloadLaunchContext;
  roleContext?: VectorRoleTurnContext;
  personaContext?: VectorPersonaTurnContext;
  repositoryContext?: VectorRepositoryContext;
  baseCursor?: number;
  runtimeSelection?: VectorRuntimeSelection;
}

export interface VectorRepositoryContext {
  schemaVersion: 1;
  repository: string;
}

export interface VectorRuntimeSelection {
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface VectorWorkloadLaunchContext {
  schemaVersion: 1;
  workloadKey: string;
  queue: "research" | "tasks";
  taskId: string;
  attempt: number;
  leaseTokenSha256: string;
  role: string;
  model: string;
  tools: string[];
  noBuiltinTools: boolean;
  systemPrompt: string;
  metadata: Record<string, string>;
}

export interface VectorRoleTurnContext {
  schemaVersion: 1;
  role: string;
  model: string;
  noBuiltinTools: boolean;
  systemPrompt: string;
  metadata: Record<string, string>;
}

export interface VectorPersonaTurnContext {
  schemaVersion: 1;
  personaId: string;
  personaName: string;
  personaVersion: string;
  model: string;
  noBuiltinTools: true;
  systemPrompt: string;
}

export interface VectorIngressCancelInput extends VectorIngressScope {
  runId?: string;
}

export interface VectorIngressEventsInput extends VectorIngressScope {
  afterSeq?: number;
  limit?: number;
  turnId?: number;
}

export interface VectorIngressCursorPosition {
  at: string;
  rank: 0 | 1 | 2;
  id: string;
}

export interface VectorIngressInventoryInput extends VectorIngressOwnerScope {
  after?: VectorIngressCursorPosition;
  limit?: number;
}

export interface VectorIngressTranscriptInput extends VectorIngressOwnerScope {
  externalSessionId: string;
  after?: VectorIngressCursorPosition;
  limit?: number;
}

export interface VectorIngressLegacyPiContextInput extends VectorIngressOwnerScope {
  externalSessionId: string;
  legacyService: "nexuslink-chat" | "funky";
  legacyPiSessionId: string;
}

export interface VectorIngressHeartbeat {
  wakeup: ReturnType<typeof heartbeatService>["wakeup"];
  cancelRun: ReturnType<typeof heartbeatService>["cancelRun"];
}

const VECTOR_PRESENTATION_EVENT_TYPES = [
  "assistant_delta",
  "tool_call",
  "tool_update",
  "tool_result",
  "assistant_final",
  "usage",
  "error",
  "agent_settled",
] as const;

const VECTOR_TRANSCRIPT_EVENT_TYPES = [
  "assistant_delta",
  "tool_call",
  "tool_result",
  "usage",
  "error",
] as const;

const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
] as const;

function eventPayloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

const VECTOR_TOOL_VALUE_BUDGET = 32 * 1024;
const VECTOR_TOOL_MAX_DEPTH = 8;
const VECTOR_TOOL_MAX_ENTRIES = 50;
const VECTOR_TOOL_MAX_STRING = 4 * 1024;
const sensitiveToolKey = /(?:^|[_-])(?:api[_-]?key|token|password|secret|credential|authorization|cookie|private[_-]?key|database[_-]?url)(?:$|[_-])/i;
const sensitiveToolValue = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:postgres(?:ql)?|https?):\/\/[^/\s:@]+:[^@\s/]+@)/gi;

function sanitizeVectorToolValue(value: unknown): unknown {
  const budget = { remaining: VECTOR_TOOL_VALUE_BUDGET };
  const visit = (current: unknown, depth: number): unknown => {
    if (budget.remaining <= 0 || depth > VECTOR_TOOL_MAX_DEPTH) return "[truncated]";
    if (typeof current === "string") {
      const redacted = current.replace(sensitiveToolValue, "[redacted]");
      const bounded = redacted.slice(0, Math.min(VECTOR_TOOL_MAX_STRING, budget.remaining));
      budget.remaining -= bounded.length;
      return bounded.length < redacted.length ? `${bounded}[truncated]` : bounded;
    }
    if (current === null || typeof current === "number" || typeof current === "boolean") {
      budget.remaining -= 16;
      return current;
    }
    if (Array.isArray(current)) {
      return current.slice(0, VECTOR_TOOL_MAX_ENTRIES).map((entry) => visit(entry, depth + 1));
    }
    if (!current || typeof current !== "object") return null;
    const entries = Object.entries(current as Record<string, unknown>)
      .slice(0, VECTOR_TOOL_MAX_ENTRIES);
    return Object.fromEntries(entries.map(([key, entry]) => {
      budget.remaining -= key.length;
      const normalizedKey = key
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/-/g, "_");
      return [key, sensitiveToolKey.test(normalizedKey) ? "[redacted]" : visit(entry, depth + 1)];
    }));
  };
  return visit(value, 0);
}

export function projectVectorEventPayload(eventType: string, payload: unknown) {
  const source = eventPayloadRecord(payload);
  const pick = (...keys: string[]) =>
    Object.fromEntries(
      keys
        .filter((key) => key in source)
        .map((key) => [key, source[key]]),
    );
  switch (eventType) {
    case "assistant_delta":
      return pick("text", "delta");
    case "tool_call":
      return {
        ...pick("toolCallId", "toolName"),
        ...(source.args === undefined ? {} : { args: sanitizeVectorToolValue(source.args) }),
      };
    case "tool_update":
      return {
        ...pick("toolCallId", "toolName"),
        ...(source.args === undefined ? {} : { args: sanitizeVectorToolValue(source.args) }),
        ...(source.partialResult === undefined ? {} : {
          partialResult: sanitizeVectorToolValue(source.partialResult),
        }),
      };
    case "tool_result":
      return {
        ...pick("toolCallId", "toolName", "isError"),
        ...(source.result === undefined ? {} : { result: sanitizeVectorToolValue(source.result) }),
      };
    case "assistant_final":
      return pick("text", "stopReason");
    case "usage":
      return pick("inputTokens", "outputTokens", "cachedInputTokens", "costUsd");
    case "error":
      return pick("source", "requestId");
    case "agent_settled":
      return pick("settled");
    default:
      return {};
  }
}

function projectVectorTranscriptMessage(
  eventType: string,
  _message: string | null,
): string | null {
  return eventType === "error" ? "Agent run failed" : null;
}

export interface VectorIngressToolAuthority {
  registerPending(input: VectorIngressScope & {
    issueId: string;
    commentId: string;
    authorityHandle: string;
    allowedTools: readonly string[];
  }): VectorToolPendingDescriptor;
  bindRun(input: VectorIngressScope & {
    issueId: string;
    runId: string;
    authorityHandle: string;
  }): Promise<void>;
}

export interface VectorIngressProviderAuthority {
  registerPending(input: VectorIngressScope & {
    issueId: string;
    commentId: string;
    authorityHandle: string;
  }): VectorProviderPendingDescriptor;
  bindRun(input: VectorIngressScope & {
    issueId: string;
    runId: string;
    authorityHandle: string;
  }): Promise<void>;
}

export interface VectorIngressTurnResult {
  companyId: string;
  agentId: string;
  issueId: string;
  issueIdentifier: string | null;
  commentId: string;
  runId: string | null;
  wakeupRequestId: string | null;
  wakeupStatus: string | null;
  sessionGeneration: number;
  replayed: boolean;
  turnId: number;
  baseCursor: number;
}

/**
 * Paperclip conversation ownership is text-valued. Store only a stable digest
 * of Vector's opaque session identifier so the external identifier never
 * appears in Paperclip issues, comments, activity, or logs.
 */
export function vectorConversationOwnerId(input: VectorIngressScope): string {
  const digest = createHash("sha256")
    .update("paperclip-vector-ingress/v1\0")
    .update(input.companyId)
    .update("\0")
    .update(input.agentId)
    .update("\0");
  if (input.ownerId?.trim()) {
    digest
      .update(input.installationId?.trim() ?? "")
      .update("\0")
      .update(input.profileId?.trim() ?? "")
      .update("\0")
      .update(input.ownerId.trim())
      .update("\0");
  }
  digest.update(input.externalSessionId);
  return `vector:${digest.digest("base64url")}`;
}

function sorted(values: readonly string[]) {
  return [...values].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function hasCompleteOwnerScope(
  scope: VectorIngressScope,
): scope is VectorIngressScope & VectorIngressOwnerScope {
  const fields = [scope.ownerId, scope.installationId, scope.profileId];
  const complete = fields.every((value) => Boolean(value?.trim()));
  if (!complete && fields.some((value) => Boolean(value?.trim()))) {
    throw conflict("Vector owner scope is incomplete", {
      code: "vector_ingress_owner_scope_incomplete",
    });
  }
  return complete;
}

export function vectorIngressService(
  db: Db,
  options: {
    heartbeat?: VectorIngressHeartbeat;
    responsibleUserId?: string;
    toolAuthority?: VectorIngressToolAuthority;
    providerAuthority?: VectorIngressProviderAuthority;
    legacyContextImporter?: VectorLegacyPiContextImporter;
    storage?: StorageService;
    sessionBranches?: VectorSessionBranchService;
  } = {},
) {
  const issuesSvc = issueService(db);
  const heartbeat = options.heartbeat ?? heartbeatService(db);
  const responsibleUserId = options.responsibleUserId?.trim() || localBoardUserId();
  const sessionBranches = options.sessionBranches ?? vectorSessionBranchService(db);

  async function assertTargetAgent(scope: VectorIngressScope) {
    const agent = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        status: agents.status,
        adapterConfig: agents.adapterConfig,
        metadata: agents.metadata,
      })
      .from(agents)
      .where(and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Vector conversation target not found");
    if (agent.status === "terminated" || agent.status === "pending_approval") {
      throw conflict("Vector conversation target is not available", {
        code: "vector_ingress_agent_unavailable",
      });
    }
    return agent;
  }

  async function assertWorkloadLaunch(input: VectorIngressTurnInput) {
    if (!input.launchContext) return;
    if (!hasCompleteOwnerScope(input)) {
      throw conflict("Vector workload launch requires complete owner scope", {
        code: "vector_workload_owner_scope_required",
      });
    }
    const agent = await assertTargetAgent(input);
    const metadata = eventPayloadRecord(agent.metadata);
    const provisioning = eventPayloadRecord(metadata.vectorProvisioning);
    const workloads = eventPayloadRecord(metadata.vectorWorkloads);
    if (
      provisioning.schemaVersion !== 1 ||
      provisioning.installationId !== input.installationId ||
      provisioning.profile !== input.profileId
    ) {
      throw conflict("Vector workload launch does not match provisioned installation", {
        code: "vector_workload_installation_mismatch",
      });
    }
    const contracts = Array.isArray(workloads.contracts)
      ? workloads.contracts.map(eventPayloadRecord)
      : [];
    const contract = contracts.find((candidate) => candidate.key === input.launchContext?.workloadKey);
    if (!contract || contract.runtimeAuthority !== "vector_lease_triple") {
      throw conflict("Vector workload is not assigned to this agent", {
        code: "vector_workload_agent_mismatch",
      });
    }
    const expectedQueue = contract.kind === "research_task" ? "research" : "tasks";
    const expectedTools = Array.isArray(contract.toolSurface)
      ? contract.toolSurface.filter((value): value is string => typeof value === "string").sort()
      : [];
    const actualTools = [...new Set(input.launchContext.tools)].sort();
    const policyModel = typeof contract.modelPolicy === "string" ? contract.modelPolicy : "";
    if (
      agent.role !== input.launchContext.role ||
      contract.role !== input.launchContext.role ||
      input.launchContext.queue !== expectedQueue ||
      !sameStrings(expectedTools, actualTools) ||
      input.launchContext.tools.length !== actualTools.length ||
      input.launchContext.model !== policyModel ||
      input.launchContext.metadata.task_id !== input.launchContext.taskId ||
      input.launchContext.metadata.attempt !== String(input.launchContext.attempt)
    ) {
      throw conflict("Vector workload launch differs from the provisioned contract", {
        code: "vector_workload_contract_mismatch",
      });
    }
  }

  async function assertRoleTurn(input: VectorIngressTurnInput) {
    if (!input.roleContext) return;
    if (!hasCompleteOwnerScope(input)) {
      throw conflict("Vector role turn requires complete owner scope", {
        code: "vector_role_owner_scope_required",
      });
    }
    const agent = await assertTargetAgent(input);
    const metadata = eventPayloadRecord(agent.metadata);
    const provisioning = eventPayloadRecord(metadata.vectorProvisioning);
    const adapterConfig = eventPayloadRecord(agent.adapterConfig);
    const configuredModel = typeof adapterConfig.model === "string" ? adapterConfig.model : "";
    // Role turns are a staging-only surface: the turn must name the target
    // agent's own provisioned role and carry no builtin tools. Engineering
    // (FunkyDev, alias `pi`) and standard (standard-chat) never accept one.
    if (
      provisioning.schemaVersion !== 1 ||
      provisioning.installationId !== input.installationId ||
      provisioning.profile !== input.profileId ||
      input.profileId !== "staging" ||
      input.roleContext.noBuiltinTools !== true ||
      agent.role !== input.roleContext.role ||
      (input.roleContext.model !== "" && input.roleContext.model !== configuredModel)
    ) {
      throw conflict("Vector role turn differs from the provisioned agent contract", {
        code: "vector_role_contract_mismatch",
      });
    }
  }

  async function assertRepositoryContext(input: VectorIngressTurnInput) {
    if (!input.repositoryContext) return;
    if (!hasCompleteOwnerScope(input) || input.profileId !== "engineering") {
      throw conflict("Vector repository context requires engineering owner scope", {
        code: "vector_repository_scope_mismatch",
      });
    }
    const agent = await assertTargetAgent(input);
    const metadata = eventPayloadRecord(agent.metadata);
    const provisioning = eventPayloadRecord(metadata.vectorProvisioning);
    const repository = input.repositoryContext.repository;
    if (
      input.repositoryContext.schemaVersion !== 1 ||
      repository.trim() !== repository ||
      repository.length > 201 ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      repository.split("/").some((part) => part === "." || part === "..") ||
      agent.role !== "engineer" ||
      provisioning.schemaVersion !== 1 ||
      provisioning.installationId !== input.installationId ||
      provisioning.profile !== input.profileId ||
      input.roleContext !== undefined
    ) {
      throw conflict("Vector repository context differs from the provisioned engineering contract", {
        code: "vector_repository_contract_mismatch",
      });
    }
  }

  async function assertPersonaTurn(
    input: VectorIngressTurnInput,
    personaContext: VectorPersonaTurnContext,
  ) {
    if (!hasCompleteOwnerScope(input)) {
      throw conflict("Vector persona turn requires complete owner scope", {
        code: "vector_persona_owner_scope_required",
      });
    }
    const agent = await assertTargetAgent(input);
    const metadata = eventPayloadRecord(agent.metadata);
    const provisioning = eventPayloadRecord(metadata.vectorProvisioning);
    const adapterConfig = eventPayloadRecord(agent.adapterConfig);
    const configuredModel = typeof adapterConfig.model === "string" ? adapterConfig.model : "";
    if (
      provisioning.schemaVersion !== 1 ||
      provisioning.installationId !== input.installationId ||
      provisioning.profile !== input.profileId ||
      input.profileId !== "standard" ||
      agent.role !== "standard-chat" ||
      !configuredModel.startsWith("router/") ||
      !/^router\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(personaContext.model) ||
      personaContext.noBuiltinTools !== true
    ) {
      throw conflict("Vector persona turn differs from the provisioned agent contract", {
        code: "vector_persona_contract_mismatch",
      });
    }
  }

  async function assertRuntimeSelection(
    input: VectorIngressScope,
    selection: VectorRuntimeSelection,
  ) {
    if (!hasCompleteOwnerScope(input) || (input.profileId !== "standard" && input.profileId !== "engineering")) {
      throw conflict("Vector runtime selection requires an admitted owner scope", {
        code: "vector_runtime_selection_scope_mismatch",
      });
    }
    const agent = await assertTargetAgent(input);
    const configured = eventPayloadRecord(agent.adapterConfig);
    if (
      (input.profileId === "standard"
        ? agent.role !== "standard-chat"
        : agent.role !== "engineer") ||
      typeof configured.model !== "string" ||
      !configured.model.startsWith("router/") ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(selection.model)
    ) {
      throw conflict("Vector runtime selection differs from the provisioned contract", {
        code: "vector_runtime_selection_contract_mismatch",
      });
    }
  }

  function persistedPersonaContext(raw: unknown): VectorPersonaTurnContext | null {
    const value = eventPayloadRecord(raw);
    const keys = Object.keys(value).sort();
    const expected = ["model", "noBuiltinTools", "personaId", "personaName", "personaVersion", "schemaVersion", "systemPrompt"];
    if (
      !sameStrings(keys, expected) || value.schemaVersion !== 1 ||
      typeof value.personaId !== "string" || typeof value.personaName !== "string" ||
      typeof value.personaVersion !== "string" || typeof value.model !== "string" ||
      value.noBuiltinTools !== true || typeof value.systemPrompt !== "string"
    ) return null;
    return value as unknown as VectorPersonaTurnContext;
  }

  async function resolvePersonaTurn(
    input: VectorIngressTurnInput,
    issue: { id: string },
  ): Promise<VectorPersonaTurnContext | null> {
    const priorRun = await latestConversationRun(input, issue);
    const prior = persistedPersonaContext(priorRun?.contextSnapshot?.vectorPersonaTurn);
    const requested = input.personaContext ?? null;
    if (
      requested && prior &&
      (requested.schemaVersion !== prior.schemaVersion ||
        requested.personaId !== prior.personaId ||
        requested.personaName !== prior.personaName ||
        requested.personaVersion !== prior.personaVersion ||
        requested.model !== prior.model ||
        requested.noBuiltinTools !== prior.noBuiltinTools ||
        requested.systemPrompt !== prior.systemPrompt)
    ) {
      throw conflict("Vector persona cannot change within an existing conversation", {
        code: "vector_persona_continuity_mismatch",
      });
    }
    const effective = requested ?? prior;
    if (!effective && input.profileId === "standard") {
      throw conflict("Vector standard-chat requires an admitted persona", {
        code: "vector_persona_required",
      });
    }
    if (effective) await assertPersonaTurn(input, effective);
    return effective;
  }

  async function getConversation(scope: VectorIngressScope) {
    const ownerId = vectorConversationOwnerId(scope);
    const issue = await issuesSvc.getConversation(
      scope.companyId,
      scope.agentId,
      ownerId,
    );
    return { issue, ownerId };
  }

  async function bindConversationOwner(
    scope: VectorIngressScope & VectorIngressOwnerScope,
    issueId: string,
  ) {
    const ownerSha256 = vectorIngressOwnerSha256(scope);
    const turn = scope as Partial<VectorIngressTurnInput>;
    // FunkyDev has exactly one session alias. A NexusLink todo launch is an
    // ordinary `pi` turn whose opening message is the todo brief.
    const insertedRole = scope.profileId === "engineering" ? "pi" : null;
    const requestedRepository = turn.repositoryContext?.repository ?? null;
    const inserted = await db
      .insert(vectorIngressConversations)
      .values({
        companyId: scope.companyId,
        agentId: scope.agentId,
        issueId,
        installationId: scope.installationId,
        profileId: scope.profileId,
        ownerSha256,
        externalSessionId: scope.externalSessionId,
        sessionRole: insertedRole,
        repository: requestedRepository,
      })
      .onConflictDoNothing()
      .returning({ id: vectorIngressConversations.id });
    const mapping = await db
      .select()
      .from(vectorIngressConversations)
      .where(eq(vectorIngressConversations.issueId, issueId))
      .then((rows) => rows[0] ?? null);
    if (
      !mapping ||
      mapping.companyId !== scope.companyId ||
      mapping.agentId !== scope.agentId ||
      mapping.installationId !== scope.installationId ||
      mapping.profileId !== scope.profileId ||
      mapping.ownerSha256 !== ownerSha256 ||
      mapping.externalSessionId !== scope.externalSessionId
    ) {
      throw conflict("Vector conversation owner binding does not match", {
        code: "vector_ingress_owner_scope_mismatch",
      });
    }
    if (
      (scope.profileId === "engineering" && mapping.sessionRole !== null && mapping.sessionRole !== "pi") ||
      (inserted.length === 0 && requestedRepository !== null && mapping.repository !== requestedRepository)
    ) {
      throw conflict("Vector conversation role or repository binding does not match", {
        code: "vector_ingress_session_binding_mismatch",
      });
    }
    return mapping;
  }

  async function requireConversation(scope: VectorIngressScope) {
    await assertTargetAgent(scope);
    const resolved = await getConversation(scope);
    if (!resolved.issue) throw notFound("Vector conversation not found");
    return { issue: resolved.issue, ownerId: resolved.ownerId };
  }

  async function requireOwnedConversation(
    scope: VectorIngressScope & VectorIngressOwnerScope,
  ) {
    const resolved = await requireConversation(scope);
    const mapping = await bindConversationOwner(scope, resolved.issue.id);
    return { ...resolved, mapping };
  }

  async function resolveConversation(scope: VectorIngressScope) {
    hasCompleteOwnerScope(scope);
    const agent = await assertTargetAgent(scope);
    const existing = await getConversation(scope);
    if (existing.issue) {
      if (hasCompleteOwnerScope(scope)) {
        await bindConversationOwner(scope, existing.issue.id);
      }
      return { issue: existing.issue, ownerId: existing.ownerId, created: false };
    }

    const issue = await issuesSvc.create(scope.companyId, {
      title: `Vector conversation with ${agent.name}`,
      assigneeAgentId: scope.agentId,
      conversationAgentId: scope.agentId,
      conversationUserId: existing.ownerId,
      conversationState: "waiting",
      status: "in_review",
      createdByUserId: responsibleUserId,
      responsibleUserId,
      trustExplicitResponsibleUserId: true,
      originKind: "vector_ingress",
      originFingerprint: "vector-ingress/v1",
    });
    await logActivity(db, {
      companyId: scope.companyId,
      actorType: "system",
      actorId: VECTOR_INGRESS_ACTOR_ID,
      action: "issue.conversation_opened",
      entityType: "issue",
      entityId: issue.id,
      issueId: issue.id,
      details: { agentId: scope.agentId, source: "vector_ingress" },
    });
    if (hasCompleteOwnerScope(scope)) {
      await bindConversationOwner(scope, issue.id);
    }
    return { issue, ownerId: existing.ownerId, created: true };
  }

  async function importLegacyPiContext(
    input: VectorIngressLegacyPiContextInput,
  ): Promise<VectorLegacyPiContextImportResult> {
    const expectedService =
      input.profileId === "engineering" || input.profileId === "standard"
        ? "nexuslink-chat"
        : input.profileId === "staging"
          ? "funky"
          : null;
    if (!expectedService || input.legacyService !== expectedService) {
      throw conflict("Vector legacy context profile is not eligible for import", {
        code: "vector_legacy_context_profile_mismatch",
      });
    }
    if (!options.legacyContextImporter) {
      throw conflict("Vector legacy context import is unavailable", {
        code: "vector_legacy_context_unavailable",
      });
    }
    const { issue } = await resolveConversation(input);
    return options.legacyContextImporter.importContext({ ...input, issueId: issue.id });
  }

  async function configureRuntime(
    input: VectorIngressScope & VectorRuntimeSelection,
  ) {
    await assertRuntimeSelection(input, input);
    if (!hasCompleteOwnerScope(input)) {
      throw conflict("Vector runtime selection requires owner scope", { code: "vector_runtime_selection_scope_mismatch" });
    }
    const { issue } = await resolveConversation(input);
    const mapping = await bindConversationOwner(input, issue.id);
    const [updated] = await db.update(vectorIngressConversations).set({
      model: input.model,
      thinking: input.thinking,
    }).where(and(
      eq(vectorIngressConversations.id, mapping.id),
      eq(vectorIngressConversations.issueId, issue.id),
    )).returning({
      model: vectorIngressConversations.model,
      thinking: vectorIngressConversations.thinking,
    });
    if (!updated) throw notFound("Vector conversation not found");
    return { companyId: input.companyId, agentId: input.agentId, issueId: issue.id, ...updated };
  }

  async function latestConversationRun(
    scope: VectorIngressScope,
    issue: { id: string },
  ) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, scope.companyId),
          eq(heartbeatRuns.agentId, scope.agentId),
          or(
            eq(heartbeatRuns.nativeIssueId, issue.id),
            sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
          ),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function status(input: VectorIngressScope) {
    const owned = hasCompleteOwnerScope(input);
    const resolved = owned ? await requireOwnedConversation(input) : await requireConversation(input);
    const { issue } = resolved;
    const mapping = owned ? (resolved as Awaited<ReturnType<typeof requireOwnedConversation>>).mapping : null;
    const run = await latestConversationRun(input, issue);
    const legacyContextImported = issue.originFingerprint === VECTOR_LEGACY_PI_CONTEXT_ORIGIN &&
      await db.select({ taskKey: agentTaskSessions.taskKey }).from(agentTaskSessions).where(and(
        eq(agentTaskSessions.companyId, input.companyId),
        eq(agentTaskSessions.agentId, input.agentId),
        eq(agentTaskSessions.adapterType, "pi_local"),
        eq(agentTaskSessions.taskKey, issue.id),
      )).limit(1).then((rows) => rows.length === 1);
    return {
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      sessionGeneration: issue.conversationSessionGeneration,
      legacyContextImported,
      model: mapping?.model ?? null,
      thinking: mapping?.thinking ?? null,
      sessionRole: mapping?.sessionRole ?? (owned && input.profileId === "engineering" ? "pi" : null),
      repository: mapping?.repository ?? null,
      run: run
        ? {
            id: run.id,
            status: run.status,
            error: run.error,
            errorCode: run.errorCode,
            usage: run.usageJson,
            eventCursor: Math.max(0, run.nextEventSeq - 1),
            createdAt: run.createdAt,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            ...(await db.select({ turnId: vectorIngressTurns.turnId, baseCursor: vectorIngressTurns.baseCursor })
              .from(vectorIngressTurns)
              .where(eq(vectorIngressTurns.runId, run.id))
              .limit(1)
              .then((rows) => rows[0] ?? {})),
          }
        : null,
    };
  }

  async function events(input: VectorIngressEventsInput) {
    let snapshot = await status(input);
    let target: { turnId: number; runId: string | null; baseCursor: number } | null = null;
    if (input.turnId !== undefined) {
      if (!hasCompleteOwnerScope(input)) {
        throw conflict("Targeted Vector events require owner scope", { code: "vector_turn_owner_scope_required" });
      }
      const ownedInput = input as VectorIngressEventsInput & VectorIngressOwnerScope;
      const { issue, mapping } = await requireOwnedConversation(ownedInput);
      target = await db.select({ turnId: vectorIngressTurns.turnId, runId: vectorIngressTurns.runId, baseCursor: vectorIngressTurns.baseCursor })
        .from(vectorIngressTurns)
        .where(and(eq(vectorIngressTurns.conversationId, mapping.id), eq(vectorIngressTurns.turnId, ownedInput.turnId!)))
        .limit(1).then((rows) => rows[0] ?? null);
      if (!target) throw notFound("Vector turn not found");
      const exactRun = target.runId
        ? await db.select().from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, target.runId), eq(heartbeatRuns.companyId, input.companyId),
            eq(heartbeatRuns.agentId, input.agentId),
          )).limit(1).then((rows) => rows[0] ?? null)
        : null;
      if (target.runId && !exactRun) {
        throw conflict("Vector turn run binding is invalid", { code: "vector_turn_run_scope_mismatch" });
      }
      snapshot = {
        ...snapshot,
        issueId: issue.id,
        run: exactRun ? {
          id: exactRun.id, status: exactRun.status, error: exactRun.error,
          errorCode: exactRun.errorCode, usage: exactRun.usageJson,
          eventCursor: Math.max(0, exactRun.nextEventSeq - 1), createdAt: exactRun.createdAt,
          startedAt: exactRun.startedAt, finishedAt: exactRun.finishedAt,
          turnId: target.turnId, baseCursor: target.baseCursor,
        } : null,
      };
    }
    const afterSeq = input.afterSeq ?? 0;
    const runAfterSeq = target ? Math.max(0, afterSeq - target.baseCursor + 1) : afterSeq;
    const runEvents = snapshot.run
      ? await db
          .select({
            seq: heartbeatRunEvents.seq,
            eventType: heartbeatRunEvents.eventType,
            stream: heartbeatRunEvents.stream,
            level: heartbeatRunEvents.level,
            color: heartbeatRunEvents.color,
            message: heartbeatRunEvents.message,
            payload: heartbeatRunEvents.payload,
            createdAt: heartbeatRunEvents.createdAt,
          })
          .from(heartbeatRunEvents)
          .where(
            and(
              eq(heartbeatRunEvents.companyId, input.companyId),
              eq(heartbeatRunEvents.agentId, input.agentId),
              eq(heartbeatRunEvents.runId, snapshot.run.id),
              gt(heartbeatRunEvents.seq, runAfterSeq),
              inArray(heartbeatRunEvents.eventType, [
                ...VECTOR_PRESENTATION_EVENT_TYPES,
              ]),
            ),
          )
          .orderBy(asc(heartbeatRunEvents.seq))
          .limit(Math.max(1, Math.min(input.limit ?? 200, 1000)))
      : [];
    return {
      ...snapshot,
      afterSeq,
      nextSeq: runEvents.at(-1)?.seq ?? runAfterSeq,
      events: runEvents.map((event) => ({
        seq: event.seq,
        eventType: event.eventType,
        stream: event.stream,
        level: event.level,
        color: event.color,
        message: event.message,
        payload: projectVectorEventPayload(event.eventType, event.payload),
        createdAt: event.createdAt,
      })),
      turnId: target?.turnId ?? null,
      baseCursor: target?.baseCursor ?? null,
      pendingTurn: Boolean(target && !target.runId),
    };
  }

  async function inventory(input: VectorIngressInventoryInput) {
    await assertTargetAgent({ ...input, externalSessionId: "inventory" });
    const ownerSha256 = vectorIngressOwnerSha256(input);
    const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
    const afterAt = input.after ? new Date(input.after.at) : null;
    if (afterAt && Number.isNaN(afterAt.getTime())) {
      throw new Error("vector_ingress_invalid_cursor");
    }
    const rows = await db
      .select({
        externalSessionId: vectorIngressConversations.externalSessionId,
        mappingCreatedAt: vectorIngressConversations.createdAt,
        issueId: issues.id,
        issueIdentifier: issues.identifier,
        sessionGeneration: issues.conversationSessionGeneration,
        conversationState: issues.conversationState,
        issueCreatedAt: issues.createdAt,
        issueUpdatedAt: issues.updatedAt,
      })
      .from(vectorIngressConversations)
      .innerJoin(
        issues,
        and(
          eq(issues.id, vectorIngressConversations.issueId),
          eq(issues.companyId, vectorIngressConversations.companyId),
          eq(issues.conversationAgentId, vectorIngressConversations.agentId),
        ),
      )
      .where(
        and(
          eq(vectorIngressConversations.companyId, input.companyId),
          eq(vectorIngressConversations.agentId, input.agentId),
          eq(vectorIngressConversations.installationId, input.installationId),
          eq(vectorIngressConversations.profileId, input.profileId),
          eq(vectorIngressConversations.ownerSha256, ownerSha256),
          isNull(issues.hiddenAt),
          afterAt
            ? or(
                gt(vectorIngressConversations.createdAt, afterAt),
                and(
                  eq(vectorIngressConversations.createdAt, afterAt),
                  gt(
                    vectorIngressConversations.externalSessionId,
                    input.after!.id,
                  ),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        asc(vectorIngressConversations.createdAt),
        asc(vectorIngressConversations.externalSessionId),
      )
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const sessions = await Promise.all(
      page.map(async (row) => {
        const run = await latestConversationRun(
          { ...input, externalSessionId: row.externalSessionId },
          { id: row.issueId },
        );
        const live = Boolean(
          run &&
            ACTIVE_RUN_STATUSES.includes(
              run.status as (typeof ACTIVE_RUN_STATUSES)[number],
            ),
        );
        return {
          externalSessionId: row.externalSessionId,
          createdAt: row.issueCreatedAt,
          updatedAt: row.issueUpdatedAt,
          sessionGeneration: row.sessionGeneration,
          live,
          busy: live,
          done: !live,
          runStatus: run?.status ?? null,
        };
      }),
    );
    const last = page.at(-1);
    const hasMore = rows.length > limit;
    return {
      companyId: input.companyId,
      agentId: input.agentId,
      sessions,
      hasMore,
      nextPosition: hasMore && last
        ? ({
            at: last.mappingCreatedAt.toISOString(),
            rank: 0,
            id: last.externalSessionId,
          } satisfies VectorIngressCursorPosition)
        : null,
    };
  }

  type TranscriptCandidate = {
    at: Date;
    rank: 0 | 1 | 2;
    id: string;
    eventType: string;
    message: string | null;
    payload: Record<string, unknown>;
  };

  function compareTranscriptCandidate(
    left: TranscriptCandidate,
    right: TranscriptCandidate,
  ) {
    const time = left.at.getTime() - right.at.getTime();
    if (time !== 0) return time;
    if (left.rank !== right.rank) return left.rank - right.rank;
    if (left.rank === 1) return Number(left.id) - Number(right.id);
    return left.id.localeCompare(right.id);
  }

  async function transcript(input: VectorIngressTranscriptInput) {
    const { issue, mapping } = await requireOwnedConversation(input);
    const limit = Math.max(1, Math.min(input.limit ?? 200, 500));
    const afterAt = input.after ? new Date(input.after.at) : null;
    if (afterAt && Number.isNaN(afterAt.getTime())) {
      throw new Error("vector_ingress_invalid_cursor");
    }
    const after = input.after;
    const commentAfter = !afterAt
      ? undefined
      : after!.rank > 0
        ? gt(issueComments.createdAt, afterAt)
        : or(
            gt(issueComments.createdAt, afterAt),
            and(
              eq(issueComments.createdAt, afterAt),
              gt(issueComments.id, after!.id),
            ),
          );
    const eventAfter = !afterAt
      ? undefined
      : after!.rank > 1
        ? gt(heartbeatRunEvents.createdAt, afterAt)
        : after!.rank < 1
          ? gte(heartbeatRunEvents.createdAt, afterAt)
          : or(
              gt(heartbeatRunEvents.createdAt, afterAt),
              and(
                eq(heartbeatRunEvents.createdAt, afterAt),
                gt(heartbeatRunEvents.id, Number(after!.id)),
              ),
            );
    const terminalAfter = !afterAt
      ? undefined
      : after!.rank < 2
        ? gte(heartbeatRuns.finishedAt, afterAt)
        : or(
            gt(heartbeatRuns.finishedAt, afterAt),
            and(
              eq(heartbeatRuns.finishedAt, afterAt),
              gt(heartbeatRuns.id, after!.id),
            ),
          );
    const activeBranchId = await db.select({ id: vectorIngressBranchHeads.activeBranchId })
      .from(vectorIngressBranchHeads)
      .where(and(
        eq(vectorIngressBranchHeads.companyId, input.companyId),
        eq(vectorIngressBranchHeads.conversationId, mapping.id),
        eq(vectorIngressBranchHeads.sessionGeneration, issue.conversationSessionGeneration),
      )).limit(1).then((rows) => rows[0]?.id ?? null);
    const activeCommentIds = activeBranchId
      ? await db.select({ id: vectorIngressBranchTurns.commentId })
          .from(vectorIngressBranchTurns)
          .where(and(
            eq(vectorIngressBranchTurns.companyId, input.companyId),
            eq(vectorIngressBranchTurns.conversationId, mapping.id),
            eq(vectorIngressBranchTurns.sessionGeneration, issue.conversationSessionGeneration),
            eq(vectorIngressBranchTurns.branchId, activeBranchId),
          )).then((rows) => rows.map((row) => row.id))
      : null;
    const projectedTurns = activeCommentIds
      ? await db.select({
          commentId: vectorIngressTurns.commentId,
          runId: vectorIngressTurns.runId,
        }).from(vectorIngressTurns)
          .innerJoin(issueComments, eq(issueComments.id, vectorIngressTurns.commentId))
          .where(and(
            eq(vectorIngressTurns.conversationId, mapping.id),
            or(
              sql`${issueComments.conversationSessionGeneration} IS DISTINCT FROM ${issue.conversationSessionGeneration}`,
              activeCommentIds.length > 0
                ? inArray(vectorIngressTurns.commentId, activeCommentIds)
                : sql`false`,
            ),
          ))
      : null;
    const projectedCommentIds = projectedTurns?.map((turn) => turn.commentId) ?? null;
    const projectedRunIds = projectedTurns?.flatMap((turn) => turn.runId ? [turn.runId] : []) ?? null;
    const runScope = and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      or(
        eq(heartbeatRuns.nativeIssueId, issue.id),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
      ),
      projectedRunIds
        ? projectedRunIds.length > 0
          ? inArray(heartbeatRuns.id, projectedRunIds)
          : sql`false`
        : undefined,
    );
    const [comments, runEvents, terminalRuns] = await Promise.all([
      db
        .select({
          id: issueComments.id,
          body: issueComments.body,
          createdAt: vectorIngressTurns.createdAt,
        })
        .from(vectorIngressTurns)
        .innerJoin(
          issueComments,
          eq(issueComments.id, vectorIngressTurns.commentId),
        )
        .where(
          and(
            eq(vectorIngressTurns.conversationId, mapping.id),
            eq(issueComments.issueId, issue.id),
            projectedCommentIds
              ? projectedCommentIds.length > 0
                ? inArray(vectorIngressTurns.commentId, projectedCommentIds)
                : sql`false`
              : undefined,
            isNull(issueComments.deletedAt),
            commentAfter,
          ),
        )
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id))
        .limit(limit + 1),
      db
        .select({
          id: heartbeatRunEvents.id,
          eventType: heartbeatRunEvents.eventType,
          message: heartbeatRunEvents.message,
          payload: heartbeatRunEvents.payload,
          createdAt: heartbeatRunEvents.createdAt,
        })
        .from(heartbeatRunEvents)
        .innerJoin(
          heartbeatRuns,
          and(
            eq(heartbeatRuns.id, heartbeatRunEvents.runId),
            eq(heartbeatRuns.companyId, heartbeatRunEvents.companyId),
            eq(heartbeatRuns.agentId, heartbeatRunEvents.agentId),
          ),
        )
        .where(
          and(
            runScope,
            inArray(heartbeatRunEvents.eventType, [
              ...VECTOR_TRANSCRIPT_EVENT_TYPES,
            ]),
            eventAfter,
          ),
        )
        .orderBy(asc(heartbeatRunEvents.createdAt), asc(heartbeatRunEvents.id))
        .limit(limit + 1),
      db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          finishedAt: heartbeatRuns.finishedAt,
        })
        .from(heartbeatRuns)
        .where(
          and(
            runScope,
            inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
            isNotNull(heartbeatRuns.finishedAt),
            terminalAfter,
          ),
        )
        .orderBy(asc(heartbeatRuns.finishedAt), asc(heartbeatRuns.id))
        .limit(limit + 1),
    ]);
    const commentImageRows = comments.length === 0
      ? []
      : await db
          .select({
            commentId: issueAttachments.issueCommentId,
            attachmentId: issueAttachments.id,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            sha256: assets.sha256,
            originalFilename: assets.originalFilename,
            objectKey: assets.objectKey,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
          .where(and(
            eq(issueAttachments.companyId, input.companyId),
            eq(issueAttachments.issueId, issue.id),
            eq(assets.companyId, input.companyId),
            inArray(issueAttachments.issueCommentId, comments.map((comment) => comment.id)),
          ))
          .orderBy(asc(assets.originalFilename), asc(issueAttachments.id));
    const imagesByComment = new Map<string, Array<Record<string, unknown>>>();
    for (const row of commentImageRows) {
      if (!row.commentId || !isVectorIngressImageAsset({ ...row, companyId: input.companyId, issueId: issue.id })) continue;
      const current = imagesByComment.get(row.commentId) ?? [];
      current.push({ attachmentId: row.attachmentId, mimeType: row.contentType, byteSize: row.byteSize, sha256: row.sha256 });
      imagesByComment.set(row.commentId, current);
    }
    const candidates: TranscriptCandidate[] = [
      ...comments.map((comment) => ({
        at: comment.createdAt,
        rank: 0 as const,
        id: comment.id,
        eventType: "user_turn",
        message: null,
        payload: {
          text: comment.body,
          ...(imagesByComment.get(comment.id)?.length
            ? { images: imagesByComment.get(comment.id) }
            : {}),
        },
      })),
      ...runEvents.map((event) => ({
        at: event.createdAt,
        rank: 1 as const,
        id: String(event.id),
        eventType: event.eventType,
        message: projectVectorTranscriptMessage(event.eventType, event.message),
        payload: projectVectorEventPayload(event.eventType, event.payload),
      })),
      ...terminalRuns.map((run) => ({
        at: run.finishedAt!,
        rank: 2 as const,
        id: run.id,
        eventType: "run_terminal",
        message: null,
        payload: {
          status: run.status,
          failed: run.status === "failed" || run.status === "timed_out",
        },
      })),
    ].sort(compareTranscriptCandidate);
    const page = candidates.slice(0, limit);
    const last = page.at(-1);
    const hasMore = candidates.length > limit;
    return {
      companyId: input.companyId,
      agentId: input.agentId,
      externalSessionId: input.externalSessionId,
      events: page.map((event) => ({
        eventType: event.eventType,
        message: event.message,
        payload: event.payload,
        createdAt: event.at,
      })),
      hasMore,
      nextPosition: hasMore && last
        ? ({
            at: last.at.toISOString(),
            rank: last.rank,
            id: last.id,
          } satisfies VectorIngressCursorPosition)
        : null,
    };
  }

  async function addTurn(input: VectorIngressTurnInput) {
    if (input.authorityHandle && !options.toolAuthority) {
      throw conflict("Vector tool authority is disabled", {
        code: "vector_tool_authority_disabled",
      });
    }
    if (input.providerAuthorityHandle && !options.providerAuthority) {
      throw conflict("Vector provider authority is disabled", {
        code: "vector_provider_authority_disabled",
      });
    }
    await assertWorkloadLaunch(input);
    await assertRoleTurn(input);
    await assertRepositoryContext(input);
    const { issue, ownerId } = await resolveConversation(input);
    const mapping = hasCompleteOwnerScope(input)
      ? await bindConversationOwner(input, issue.id)
      : null;
    const personaContext = await resolvePersonaTurn(input, issue);
    const runtimeSelection = input.runtimeSelection ?? (mapping?.model && mapping.thinking
      ? { model: mapping.model, thinking: mapping.thinking as VectorRuntimeSelection["thinking"] }
      : input.profileId === "standard" && personaContext
        ? { model: personaContext.model.replace(/^router\//, ""), thinking: "medium" as const }
        : null);
    if (runtimeSelection && input.profileId !== "standard" && input.profileId !== "engineering") {
      throw conflict("Vector runtime selection requires an admitted owner scope", {
        code: "vector_runtime_selection_scope_mismatch",
      });
    }
    if (input.profileId === "standard" || runtimeSelection) {
      if (input.profileId === "standard" && !runtimeSelection) {
        throw conflict("Vector standard-chat requires a runtime selection", {
          code: "vector_runtime_selection_required",
        });
      }
      if (runtimeSelection) await assertRuntimeSelection(input, runtimeSelection);
      if (input.profileId === "standard" && runtimeSelection &&
        input.personaContext &&
        input.personaContext.model !== `router/${runtimeSelection.model}`
      ) {
        throw conflict("Vector persona model differs from the runtime selection", {
          code: "vector_runtime_selection_contract_mismatch",
        });
      }
      if (runtimeSelection && mapping && (!mapping.model || !mapping.thinking)) {
        await db.update(vectorIngressConversations).set(runtimeSelection).where(eq(vectorIngressConversations.id, mapping.id));
      }
    }
    const baseCursor = input.baseCursor ?? 0;
    if (!Number.isSafeInteger(baseCursor) || baseCursor < 0) {
      throw conflict("Vector turn cursor base is invalid", { code: "vector_turn_cursor_invalid" });
    }
    const requestedAttachmentIds = [...new Set(input.attachmentIds ?? [])];
    const validatedImages = validateVectorIngressImages(input.images);
    if (validatedImages.length > 0 && !options.storage) {
      throw conflict("Vector image storage is disabled", { code: "vector_ingress_image_storage_disabled" });
    }
    const effectiveBody = input.launchContext
      ? `[VECTOR_WORKLOAD_LAUNCH_V1]\n${JSON.stringify(input.launchContext)}\n\n${input.body}`
      : input.roleContext
        ? `[VECTOR_ROLE_TURN_V1]\n${JSON.stringify(input.roleContext)}\n\n${input.body}`
      : input.body;
    let replayed = false;

    let vectorImageAttachmentIds: string[] = [];
    const comment = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ id: issues.id, generation: issues.conversationSessionGeneration })
        .from(issues)
        .where(
          and(
            eq(issues.id, issue.id),
            eq(issues.companyId, input.companyId),
            eq(issues.conversationAgentId, input.agentId),
            eq(issues.conversationUserId, ownerId),
          ),
        )
        .for("update");
      if (!locked) throw notFound("Vector conversation not found");

      const branchHead = mapping
        ? await tx.select().from(vectorIngressBranchHeads).where(and(
            eq(vectorIngressBranchHeads.companyId, input.companyId),
            eq(vectorIngressBranchHeads.conversationId, mapping.id),
            eq(vectorIngressBranchHeads.sessionGeneration, locked.generation),
          )).for("update").then((rows) => rows[0] ?? null)
        : null;
      if (branchHead?.controlOperationId) {
        if (branchHead.controlExpiresAt && branchHead.controlExpiresAt > new Date()) {
          throw conflict("Vector branch control is busy", { code: "vector_branch_control_busy" });
        }
        await tx.update(vectorIngressBranchHeads).set({
          controlOperationId: null,
          controlKind: null,
          controlExpiresAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(vectorIngressBranchHeads.companyId, input.companyId),
          eq(vectorIngressBranchHeads.conversationId, mapping!.id),
          eq(vectorIngressBranchHeads.sessionGeneration, locked.generation),
          eq(vectorIngressBranchHeads.controlOperationId, branchHead.controlOperationId),
        ));
      }
      const bindActiveBranchTurn = async (commentId: string, isReplay: boolean) => {
        if (!mapping || !branchHead?.activeBranchId) return;
        const existingMembership = await tx.select({ commentId: vectorIngressBranchTurns.commentId })
          .from(vectorIngressBranchTurns)
          .where(and(
            eq(vectorIngressBranchTurns.branchId, branchHead.activeBranchId),
            eq(vectorIngressBranchTurns.commentId, commentId),
          )).limit(1).then((rows) => rows[0] ?? null);
        if (existingMembership) return;
        if (isReplay) {
          throw conflict("Vector turn retry belongs to a different retained branch", {
            code: "vector_branch_replay_mismatch",
          });
        }
        const last = await tx.select({ ordinal: vectorIngressBranchTurns.ordinal })
          .from(vectorIngressBranchTurns)
          .where(and(
            eq(vectorIngressBranchTurns.companyId, input.companyId),
            eq(vectorIngressBranchTurns.conversationId, mapping.id),
            eq(vectorIngressBranchTurns.sessionGeneration, locked.generation),
            eq(vectorIngressBranchTurns.branchId, branchHead.activeBranchId),
          )).orderBy(desc(vectorIngressBranchTurns.ordinal)).limit(1)
          .then((rows) => rows[0]?.ordinal ?? -1);
        await tx.insert(vectorIngressBranchTurns).values({
          companyId: input.companyId,
          conversationId: mapping.id,
          sessionGeneration: locked.generation,
          branchId: branchHead.activeBranchId,
          commentId,
          ordinal: last + 1,
        });
      };

      const existing = await tx
        .select()
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, issue.id),
            eq(issueComments.authorUserId, responsibleUserId),
            eq(issueComments.clientRequestId, input.clientRequestId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existing) {
        const existingAttachments = await tx
          .select({
            id: issueAttachments.id,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            sha256: assets.sha256,
            originalFilename: assets.originalFilename,
            objectKey: assets.objectKey,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
          .where(
            and(
              eq(issueAttachments.companyId, input.companyId),
              eq(issueAttachments.issueId, issue.id),
              eq(issueAttachments.issueCommentId, existing.id),
            ),
          )
          .orderBy(asc(assets.originalFilename), asc(issueAttachments.id));
        const existingVectorImages = existingAttachments.filter((row) =>
          isVectorIngressImageAsset({ ...row, companyId: input.companyId, issueId: issue.id }));
        const existingAttachmentIds = existingAttachments
          .filter((row) => !isVectorIngressImageAsset({ ...row, companyId: input.companyId, issueId: issue.id }))
          .map((row) => row.id);
        if (
          existing.body !== effectiveBody ||
          !sameStrings(existingAttachmentIds, requestedAttachmentIds) ||
          existingVectorImages.length !== validatedImages.length ||
          existingVectorImages.some((row, index) => {
            const expected = validatedImages[index];
            return !expected || row.contentType !== expected.mimeType || row.byteSize !== expected.byteSize || row.sha256 !== expected.sha256 || row.originalFilename !== expected.filename;
          })
        ) {
          throw conflict(
            "Vector clientRequestId was already used for a different turn",
            { code: "vector_ingress_idempotency_conflict" },
          );
        }
        vectorImageAttachmentIds = existingVectorImages.map((row) => row.id);
        replayed = true;
        if (mapping) {
          await tx
            .insert(vectorIngressTurns)
            .values({
              conversationId: mapping.id,
              commentId: existing.id,
              baseCursor,
              model: runtimeSelection?.model ?? null,
              thinking: runtimeSelection?.thinking ?? null,
              createdAt: existing.createdAt,
            })
            .onConflictDoNothing();
          const accepted = await tx.select({ turnId: vectorIngressTurns.turnId })
            .from(vectorIngressTurns).where(and(eq(vectorIngressTurns.conversationId, mapping.id), eq(vectorIngressTurns.commentId, existing.id)))
            .then((rows) => rows[0] ?? null);
          if (!accepted) {
            throw conflict("Vector clientRequestId is missing its durable turn binding", { code: "vector_ingress_idempotency_conflict" });
          }
          await bindActiveBranchTurn(existing.id, true);
        }
        return existing;
      }

      const inserted = await issuesSvc.addComment(
        issue.id,
        effectiveBody,
        { userId: responsibleUserId },
        {
          clientRequestId: input.clientRequestId,
          authorType: "user",
          attachmentIds: requestedAttachmentIds,
        },
        tx,
      );
      for (const image of validatedImages) {
        const stored = await options.storage!.putFile({
          companyId: input.companyId,
          namespace: `vector-ingress/${issue.id}`,
          originalFilename: image.filename,
          contentType: image.mimeType,
          body: image.bytes,
        });
        const [asset] = await tx.insert(assets).values({
          companyId: input.companyId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByUserId: responsibleUserId,
        }).returning({ id: assets.id });
        const [attachment] = await tx.insert(issueAttachments).values({
          companyId: input.companyId,
          issueId: issue.id,
          issueCommentId: inserted.id,
          assetId: asset!.id,
        }).returning({ id: issueAttachments.id });
        vectorImageAttachmentIds.push(attachment!.id);
      }
      if (mapping) {
        await tx.insert(vectorIngressTurns).values({
          conversationId: mapping.id,
          commentId: inserted.id,
          baseCursor,
          model: runtimeSelection?.model ?? null,
          thinking: runtimeSelection?.thinking ?? null,
          createdAt: inserted.createdAt,
        });
        await bindActiveBranchTurn(inserted.id, false);
      }
      return inserted;
    });

    if (!replayed) {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: VECTOR_INGRESS_ACTOR_ID,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        issueId: issue.id,
        details: {
          commentId: comment.id,
          identifier: issue.identifier,
          source: "vector_ingress",
        },
      });
    }

    const pendingAuthority = input.authorityHandle
      ? options.toolAuthority!.registerPending({
          companyId: input.companyId,
          agentId: input.agentId,
          externalSessionId: input.externalSessionId,
          issueId: issue.id,
          commentId: comment.id,
          authorityHandle: input.authorityHandle,
          allowedTools: input.authorityTools!,
        })
      : null;
    const pendingProviderAuthority = input.providerAuthorityHandle
      ? options.providerAuthority!.registerPending({
          companyId: input.companyId,
          agentId: input.agentId,
          externalSessionId: input.externalSessionId,
          issueId: issue.id,
          commentId: comment.id,
          authorityHandle: input.providerAuthorityHandle,
        })
      : null;
    let deliveredRunId: string | null = null;
    await deliverConversationComments(db, issue, async (agentId, wakeup) => {
      const targetWake = wakeup.idempotencyKey === `conversation-comment:${comment.id}`
        ? {
            ...wakeup,
            contextSnapshot: {
              ...wakeup.contextSnapshot,
              // Per-turn presentation hint, never stored in user comments or
              // inherited by subsequent turns. It grants no tool authority.
              vectorVoiceActive: input.voiceActive === true,
              ...(runtimeSelection ? { vectorRuntimeSelection: runtimeSelection } : {}),
              ...(mapping
                ? {
                    vectorLegacyPiContextBinding: {
                      ownerSha256: mapping.ownerSha256,
                      externalSessionId: mapping.externalSessionId,
                    },
                  }
                : {}),
              ...(vectorImageAttachmentIds.length > 0
                ? { vectorIngressImageAttachmentIds: vectorImageAttachmentIds }
                : {}),
              ...(pendingAuthority ? { vectorToolAuthorityPending: pendingAuthority } : {}),
              ...(pendingProviderAuthority
                ? { vectorProviderAuthorityPending: pendingProviderAuthority }
                : {}),
            },
          }
        : wakeup;
      const run = await heartbeat.wakeup(agentId, targetWake);
      if (
        wakeup.idempotencyKey === `conversation-comment:${comment.id}` &&
        run &&
        typeof run === "object" &&
        "id" in run &&
        typeof run.id === "string"
      ) {
        deliveredRunId = run.id;
      }
      return run;
    }, input.launchContext
      ? { vectorWorkloadLaunch: input.launchContext }
      : input.roleContext
        ? { vectorRoleTurn: input.roleContext }
        : personaContext
          ? { vectorPersonaTurn: personaContext }
          : {});

    const receipt = await db
      .select({
        id: agentWakeupRequests.id,
        runId: agentWakeupRequests.runId,
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, input.companyId),
          eq(agentWakeupRequests.agentId, input.agentId),
          eq(
            agentWakeupRequests.idempotencyKey,
            `conversation-comment:${comment.id}`,
          ),
        ),
      )
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const current = await db
      .select({ generation: issues.conversationSessionGeneration })
      .from(issues)
      .where(
        and(eq(issues.id, issue.id), eq(issues.companyId, input.companyId)),
      )
      .then((rows) => rows[0] ?? null);

    const runId = deliveredRunId ?? receipt?.runId ?? null;
    const acceptedTurn = mapping
      ? await db.select({ turnId: vectorIngressTurns.turnId, runId: vectorIngressTurns.runId, baseCursor: vectorIngressTurns.baseCursor })
          .from(vectorIngressTurns).where(and(eq(vectorIngressTurns.conversationId, mapping.id), eq(vectorIngressTurns.commentId, comment.id)))
          .limit(1).then((rows) => rows[0] ?? null)
      : null;
    if (acceptedTurn && runId) {
      const [bound] = await db.update(vectorIngressTurns).set({ runId }).where(and(
        eq(vectorIngressTurns.turnId, acceptedTurn.turnId),
        or(isNull(vectorIngressTurns.runId), eq(vectorIngressTurns.runId, runId)),
      )).returning({ runId: vectorIngressTurns.runId });
      if (!bound || bound.runId !== runId) {
        throw conflict("Vector turn was already bound to another run", { code: "vector_turn_run_conflict" });
      }
    }
    if (input.authorityHandle) {
      if (!runId) {
        throw conflict("Vector tool authority requires a created run", {
          code: "vector_tool_authority_run_missing",
        });
      }
      await options.toolAuthority!.bindRun({
        companyId: input.companyId,
        agentId: input.agentId,
        externalSessionId: input.externalSessionId,
        issueId: issue.id,
        runId,
        authorityHandle: input.authorityHandle,
      });
    }
    if (input.providerAuthorityHandle) {
      if (!runId) {
        throw conflict("Vector provider authority requires a created run", {
          code: "vector_provider_authority_run_missing",
        });
      }
      await options.providerAuthority!.bindRun({
        companyId: input.companyId,
        agentId: input.agentId,
        externalSessionId: input.externalSessionId,
        issueId: issue.id,
        runId,
        authorityHandle: input.providerAuthorityHandle,
      });
    }

    return {
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      commentId: comment.id,
      runId,
      wakeupRequestId: receipt?.id ?? null,
      wakeupStatus: receipt?.status ?? null,
      sessionGeneration: current?.generation ?? issue.conversationSessionGeneration,
      replayed,
      turnId: acceptedTurn?.turnId ?? 0,
      baseCursor: acceptedTurn?.baseCursor ?? baseCursor,
    } satisfies VectorIngressTurnResult;
  }

  async function cancel(input: VectorIngressCancelInput) {
    const { issue } = await requireConversation(input);
    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
          inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
          or(
            eq(heartbeatRuns.nativeIssueId, issue.id),
            sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
          ),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));
    const selected = input.runId
      ? activeRuns.find((run) => run.id === input.runId) ?? null
      : activeRuns.find((run) => run.id === issue.executionRunId) ??
        activeRuns[0] ??
        null;
    if (input.runId && !selected) {
      throw conflict("Run does not belong to this active Vector conversation", {
        code: "vector_ingress_run_scope_mismatch",
      });
    }
    if (!selected) {
      return {
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: issue.id,
        runId: null,
        cancelled: false,
        status: null,
      };
    }

    const cancelled = await heartbeat.cancelRun(
      selected.id,
      "Cancelled by Vector OS",
      {
        errorCode: "operator_interrupted",
        resultJson: {
          cancellationKind: "operator_interrupted",
          source: "vector_ingress",
          issueId: issue.id,
        },
      },
    );
    if (cancelled) {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: VECTOR_INGRESS_ACTOR_ID,
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: selected.id,
        issueId: issue.id,
        details: {
          agentId: input.agentId,
          issueId: issue.id,
          source: "vector_ingress",
          cancellationKind: "operator_interrupted",
        },
      });
    }
    return {
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: issue.id,
      runId: selected.id,
      cancelled: cancelled?.status === "cancelled",
      status: cancelled?.status ?? selected.status,
    };
  }

  return {
    addTurn,
    reset: (input: Omit<VectorIngressTurnInput, "body">) =>
      addTurn({ ...input, body: "/new" }),
    cancel,
    status,
    events,
    inventory,
    transcript,
    importLegacyPiContext,
    configureRuntime,
    listBranches: sessionBranches.list,
    forkBranch: sessionBranches.fork,
    switchBranch: sessionBranches.switchBranch,
  };
}

export type VectorIngressService = ReturnType<typeof vectorIngressService>;
