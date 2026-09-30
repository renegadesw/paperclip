import { createHash, createHmac } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issues, routines, type Db } from "@paperclipai/db";
import { isVectorFunkyServerProfile } from "@paperclipai/adapter-utils/vector-profiles";
import {
  isLiteralLoopbackHostname,
  readVectorRunAuthorityGrant,
  vectorRunAuthorityUnavailable as unavailable,
} from "./vector-board-run-authority.js";
import type { VectorProviderAuthorityConfig } from "./vector-provider-authority.js";
import type { VectorToolAuthorityConfig } from "./vector-tool-authority.js";

// A Funky research workload runs as ordinary Paperclip work: its routine
// creates an issue for Funky Scout or Funky Advisor and a normal heartbeat run
// does it. That run carries no Vector ingress handle, so before it starts
// Paperclip asks Vector OS for run-scoped provider and tool authority. Vector
// OS decides whether the run gets it and on whose behalf; Paperclip never
// names an identity, and caps the tools to the workload's declared surface.
export const VECTOR_RESEARCH_ROUTINE_ORIGIN_KIND = "vector_research_workload";
const ROUTINE_AUTHORITY_PATH = "/inbound/paperclip/v1/routine-runs/authority";
const SIGNATURE_VERSION = "vector-paperclip-routine-run-authority/v1";
export const VECTOR_ROUTINE_EXTERNAL_SESSION_PREFIX = "paperclip-routine:";
const ACTIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;
const ROUTINE_EXECUTION_ORIGIN_KIND = "routine_execution";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKLOAD_KEY = /^[a-z][a-z0-9_.-]{1,95}$/;

export type VectorRoutineRunAuthorityConfig = {
  endpoint: URL;
  installationId: string;
  profile: string;
  secret: string;
};

export type VectorRoutineRunScope = {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string;
  workloadKey: string;
};

/** The research routine behind a routine_execution issue, as heartbeat resolved it. */
export type VectorResearchWorkloadIssue = {
  routineId: string;
  workloadKey: string;
  assigneeAgentId: string | null;
};

type RunBindScope = Omit<VectorRoutineRunScope, "workloadKey">;

type ProviderBinder = {
  hasRunGrant(runId: string): boolean;
  bindRun(input: RunBindScope & { externalSessionId: string; authorityHandle: string }): Promise<void>;
};

type ToolBinder = {
  bindRun(input: RunBindScope & {
    externalSessionId: string;
    authorityHandle: string;
    allowedTools?: readonly string[];
  }): Promise<void>;
};

type FetchLike = typeof fetch;

export function resolveVectorRoutineRunAuthorityConfig(
  env: NodeJS.ProcessEnv,
  provider: VectorProviderAuthorityConfig | null,
  tool: VectorToolAuthorityConfig | null,
): VectorRoutineRunAuthorityConfig | null {
  const raw = env.PAPERCLIP_VECTOR_ROUTINE_AUTHORITY_URL?.trim();
  if (!raw) return null;
  if (!provider || !tool) {
    throw new Error("PAPERCLIP_VECTOR_ROUTINE_AUTHORITY_URL requires the Vector provider and tool bridges");
  }
  if (!isVectorFunkyServerProfile(provider.profile)) {
    throw new Error("Vector routine run authority is limited to the Funky server (staging or production) profiles");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PAPERCLIP_VECTOR_ROUTINE_AUTHORITY_URL must be an absolute URL");
  }
  if (
    url.protocol !== "http:" || !isLiteralLoopbackHostname(url.hostname) ||
    url.username || url.password || url.pathname !== ROUTINE_AUTHORITY_PATH || url.search || url.hash
  ) {
    throw new Error(
      `PAPERCLIP_VECTOR_ROUTINE_AUTHORITY_URL must use unauthenticated literal loopback HTTP and ${ROUTINE_AUTHORITY_PATH}`,
    );
  }
  return {
    endpoint: url,
    installationId: provider.installationId,
    profile: provider.profile,
    secret: provider.secret,
  };
}

export function signVectorRoutineRunAuthorityRequest(input: {
  secret: string;
  timestamp: string;
  rawBody: Buffer;
}): string {
  const bodySha256 = createHash("sha256").update(input.rawBody).digest("hex");
  const canonical = [SIGNATURE_VERSION, input.timestamp, "POST", ROUTINE_AUTHORITY_PATH, bodySha256].join("\n");
  return `v1=${createHmac("sha256", input.secret).update(canonical).digest("hex")}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * The workload's declared tool surface, read from the sealed vectorWorkloads
 * contract provisioning wrote onto the assignee agent. The contract must be
 * this installation's, name the workload, and be Paperclip-owned.
 */
export function vectorResearchWorkloadToolSurface(
  agentMetadata: unknown,
  scope: { installationId: string; profile: string; workloadKey: string },
): string[] {
  const metadata = record(agentMetadata);
  const provisioning = record(metadata.vectorProvisioning);
  if (
    provisioning.schemaVersion !== 1 ||
    provisioning.installationId !== scope.installationId ||
    provisioning.profile !== scope.profile
  ) {
    throw unavailable("Vector research workload agent was not provisioned by this installation");
  }
  const workloads = record(metadata.vectorWorkloads);
  const contracts = Array.isArray(workloads.contracts) ? workloads.contracts.map(record) : [];
  const contract = contracts.find((candidate) => candidate.key === scope.workloadKey);
  if (!contract || contract.runtimeAuthority !== "paperclip") {
    throw unavailable(`Vector research workload ${scope.workloadKey} is not a Paperclip-owned contract of this agent`);
  }
  const tools = contract.toolSurface;
  if (!Array.isArray(tools) || tools.length === 0 || !tools.every((tool) => typeof tool === "string" && tool)) {
    throw unavailable(`Vector research workload ${scope.workloadKey} declares no tool surface`);
  }
  return [...new Set(tools as string[])].sort();
}

/**
 * An active run of this agent on a routine_execution issue whose routine is
 * this research workload, assigned to this agent, in the same company.
 */
export function dbActiveResearchRoutineRun(db: Db) {
  return async (scope: VectorRoutineRunScope): Promise<boolean> => {
    const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .innerJoin(issues, and(eq(issues.id, scope.issueId), eq(issues.companyId, heartbeatRuns.companyId)))
      .innerJoin(routines, and(
        eq(routines.companyId, issues.companyId),
        sql`${routines.id}::text = ${issues.originId}`,
      ))
      .where(and(
        eq(heartbeatRuns.id, scope.runId),
        eq(heartbeatRuns.companyId, scope.companyId),
        eq(heartbeatRuns.agentId, scope.agentId),
        inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
        sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.nativeIssueId}::text) = ${scope.issueId}`,
        eq(issues.originKind, ROUTINE_EXECUTION_ORIGIN_KIND),
        eq(routines.originKind, VECTOR_RESEARCH_ROUTINE_ORIGIN_KIND),
        eq(routines.originId, scope.workloadKey),
        eq(routines.assigneeAgentId, scope.agentId),
      )).limit(1);
    return Boolean(run);
  };
}

export class VectorRoutineRunAuthority {
  constructor(
    readonly config: VectorRoutineRunAuthorityConfig,
    private readonly deps: {
      activeRun: (scope: VectorRoutineRunScope) => Promise<boolean>;
      provider: ProviderBinder;
      tool: ToolBinder;
      fetchImpl?: FetchLike;
      now?: () => number;
    },
  ) {}

  /**
   * Requests run-scoped provider and tool authority for one research routine
   * run and binds both to it, the tools capped to the declared surface. Any
   * refusal throws; the run fails instead of running without its boundary.
   */
  async bind(scope: VectorRoutineRunScope & { toolSurface: readonly string[] }): Promise<void> {
    if (this.deps.provider.hasRunGrant(scope.runId)) return;
    if (![scope.runId, scope.companyId, scope.agentId, scope.issueId].every((id) => UUID.test(id)) ||
        !WORKLOAD_KEY.test(scope.workloadKey)) {
      throw unavailable("Vector routine run authority requires a canonical run scope");
    }
    if (scope.toolSurface.length === 0) {
      throw unavailable("Vector routine run authority requires a declared tool surface");
    }
    const run = { runId: scope.runId, companyId: scope.companyId, agentId: scope.agentId, issueId: scope.issueId };
    if (!(await this.deps.activeRun({ ...run, workloadKey: scope.workloadKey }))) {
      throw unavailable("Vector routine run authority requires an active research routine run");
    }
    const externalSessionId = `${VECTOR_ROUTINE_EXTERNAL_SESSION_PREFIX}${scope.issueId}`;
    const rawBody = Buffer.from(JSON.stringify({
      version: 1,
      installationId: this.config.installationId,
      profile: this.config.profile,
      companyId: scope.companyId,
      agentId: scope.agentId,
      issueId: scope.issueId,
      runId: scope.runId,
      workloadKey: scope.workloadKey,
      externalSessionId,
    }));
    const now = this.deps.now ?? Date.now;
    const timestamp = String(Math.floor(now() / 1000));
    const response = await (this.deps.fetchImpl ?? fetch)(this.config.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-paperclip-timestamp": timestamp,
        "x-paperclip-signature": signVectorRoutineRunAuthorityRequest({
          secret: this.config.secret,
          timestamp,
          rawBody,
        }),
      },
      body: rawBody,
      signal: AbortSignal.timeout(30_000),
    });
    const grant = await readVectorRunAuthorityGrant(response, "Vector routine run authority");
    // Vector OS mints the workload's sealed surface. A grant naming any tool
    // the workload does not declare is refused whole, never trimmed.
    const declared = new Set(scope.toolSurface);
    if (grant.authorityTools.some((tool) => !declared.has(tool))) {
      throw unavailable(`Vector routine run authority granted tools outside the ${scope.workloadKey} tool surface`);
    }
    await this.deps.provider.bindRun({ ...run, externalSessionId, authorityHandle: grant.providerAuthorityHandle });
    await this.deps.tool.bindRun({
      ...run,
      externalSessionId,
      authorityHandle: grant.authorityHandle,
      allowedTools: [...new Set(grant.authorityTools)].sort(),
    });
  }
}

let activeRoutineAuthority: VectorRoutineRunAuthority | null = null;

export function setActiveVectorRoutineRunAuthority(authority: VectorRoutineRunAuthority | null): void {
  activeRoutineAuthority = authority;
}

/**
 * Routine-run seam for heartbeat. A run on a research routine issue always
 * binds authority before it starts, whether or not its model needs provider
 * authority, and fails closed when that is not possible. Every other run is
 * left untouched (returns false).
 */
export async function prepareActiveVectorRoutineRunAuthority(input: {
  runId: string;
  companyId: string;
  agentId: string;
  agentMetadata: unknown;
  issueId: string | null;
  workload: VectorResearchWorkloadIssue | null;
  toolPending: unknown;
  providerPending: unknown;
  providerBound: unknown;
}): Promise<boolean> {
  if (!input.workload) return false;
  if (!input.issueId) {
    throw unavailable("Vector research workload run has no issue");
  }
  if (!activeRoutineAuthority) {
    throw unavailable("Vector routine run authority is not configured for a research workload run");
  }
  // A research routine issue is never a Vector ingress conversation, so it
  // can never legitimately carry an ingress handle.
  if (input.toolPending != null || input.providerPending != null || input.providerBound != null) {
    throw unavailable("Vector research workload run carries foreign Vector authority");
  }
  if (input.workload.assigneeAgentId !== input.agentId) {
    throw unavailable("Vector research workload run is not the routine assignee's run");
  }
  const toolSurface = vectorResearchWorkloadToolSurface(input.agentMetadata, {
    installationId: activeRoutineAuthority.config.installationId,
    profile: activeRoutineAuthority.config.profile,
    workloadKey: input.workload.workloadKey,
  });
  await activeRoutineAuthority.bind({
    runId: input.runId,
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    workloadKey: input.workload.workloadKey,
    toolSurface,
  });
  return true;
}
