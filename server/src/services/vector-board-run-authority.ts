import { createHash, createHmac } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import type { VectorProviderAuthorityConfig } from "./vector-provider-authority.js";

// Runs started on the operator board (tasks, Assign Task, Run now, board Agent
// Chat) carry no Vector ingress handle. On the engineering operator host the
// supervisor configures this loopback endpoint; Vector OS decides whether the
// run gets authority and on whose behalf. Paperclip never names an identity.
const BOARD_AUTHORITY_PATH = "/inbound/paperclip/v1/board-runs/authority";
const SIGNATURE_VERSION = "vector-paperclip-board-run-authority/v1";
export const VECTOR_BOARD_EXTERNAL_SESSION_PREFIX = "paperclip-board:";
const ACTIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;
const MAX_RESPONSE_BYTES = 16 * 1024;
const VECTOR_INGRESS_ORIGIN_KIND = "vector_ingress";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type VectorBoardRunAuthorityConfig = {
  endpoint: URL;
  installationId: string;
  profile: string;
  secret: string;
};

export type VectorBoardRunScope = {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string;
};

type ProviderBinder = {
  hasRunGrant(runId: string): boolean;
  bindRun(input: VectorBoardRunScope & { externalSessionId: string; authorityHandle: string }): Promise<void>;
};

type ToolBinder = {
  bindRun(input: VectorBoardRunScope & {
    externalSessionId: string;
    authorityHandle: string;
    allowedTools?: readonly string[];
  }): Promise<void>;
};

type FetchLike = typeof fetch;

function isLiteralLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((part) =>
    /^\d{1,3}$/.test(part) && Number(part) <= 255 && String(Number(part)) === part
  );
}

export function resolveVectorBoardRunAuthorityConfig(
  env: NodeJS.ProcessEnv,
  provider: VectorProviderAuthorityConfig | null,
): VectorBoardRunAuthorityConfig | null {
  const raw = env.PAPERCLIP_VECTOR_BOARD_AUTHORITY_URL?.trim();
  if (!raw) return null;
  if (!provider) {
    throw new Error("PAPERCLIP_VECTOR_BOARD_AUTHORITY_URL requires the Vector provider bridge");
  }
  if (provider.profile !== "engineering") {
    throw new Error("Vector board run authority is limited to the engineering profile");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PAPERCLIP_VECTOR_BOARD_AUTHORITY_URL must be an absolute URL");
  }
  if (
    url.protocol !== "http:" || !isLiteralLoopbackHostname(url.hostname) ||
    url.username || url.password || url.pathname !== BOARD_AUTHORITY_PATH || url.search || url.hash
  ) {
    throw new Error(
      `PAPERCLIP_VECTOR_BOARD_AUTHORITY_URL must use unauthenticated literal loopback HTTP and ${BOARD_AUTHORITY_PATH}`,
    );
  }
  return {
    endpoint: url,
    installationId: provider.installationId,
    profile: provider.profile,
    secret: provider.secret,
  };
}

export function signVectorBoardRunAuthorityRequest(input: {
  secret: string;
  timestamp: string;
  rawBody: Buffer;
}): string {
  const bodySha256 = createHash("sha256").update(input.rawBody).digest("hex");
  const canonical = [SIGNATURE_VERSION, input.timestamp, "POST", BOARD_AUTHORITY_PATH, bodySha256].join("\n");
  return `v1=${createHmac("sha256", input.secret).update(canonical).digest("hex")}`;
}

function unavailable(message: string) {
  return conflict(message, { code: "vector_provider_authority_unavailable" });
}

function boundedHandle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) {
    throw unavailable("Vector board run authority returned an invalid handle");
  }
  return value.trim();
}

/**
 * A board run is an active run of this agent on a board issue of the same
 * company. A Vector ingress conversation (NexusLink) is never a board issue:
 * its runs must carry their own user's handle and never fall back to the
 * board operator.
 */
export function dbActiveBoardRun(db: Db) {
  return async (scope: VectorBoardRunScope): Promise<boolean> => {
    const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .innerJoin(issues, and(eq(issues.id, scope.issueId), eq(issues.companyId, heartbeatRuns.companyId)))
      .where(and(
        eq(heartbeatRuns.id, scope.runId),
        eq(heartbeatRuns.companyId, scope.companyId),
        eq(heartbeatRuns.agentId, scope.agentId),
        inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
        sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.nativeIssueId}::text) = ${scope.issueId}`,
        ne(issues.originKind, VECTOR_INGRESS_ORIGIN_KIND),
      )).limit(1);
    return Boolean(run);
  };
}

export class VectorBoardRunAuthority {
  constructor(
    private readonly config: VectorBoardRunAuthorityConfig,
    private readonly deps: {
      activeRun: (scope: VectorBoardRunScope) => Promise<boolean>;
      provider: ProviderBinder;
      tool: ToolBinder | null;
      fetchImpl?: FetchLike;
      now?: () => number;
    },
  ) {}

  /**
   * Requests run-scoped provider and tool authority for one board-started run
   * and binds both to that run. Any refusal throws; the caller's run fails
   * exactly as it does today without authority.
   */
  async bind(scope: VectorBoardRunScope): Promise<void> {
    if (this.deps.provider.hasRunGrant(scope.runId)) return;
    if (![scope.runId, scope.companyId, scope.agentId, scope.issueId].every((id) => UUID.test(id))) {
      throw unavailable("Vector board run authority requires a canonical run scope");
    }
    if (!(await this.deps.activeRun(scope))) {
      throw unavailable("Vector board run authority requires an active run");
    }
    const externalSessionId = `${VECTOR_BOARD_EXTERNAL_SESSION_PREFIX}${scope.issueId}`;
    const rawBody = Buffer.from(JSON.stringify({
      version: 1,
      installationId: this.config.installationId,
      profile: this.config.profile,
      companyId: scope.companyId,
      agentId: scope.agentId,
      issueId: scope.issueId,
      runId: scope.runId,
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
        "x-paperclip-signature": signVectorBoardRunAuthorityRequest({
          secret: this.config.secret,
          timestamp,
          rawBody,
        }),
      },
      body: rawBody,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw unavailable(`Vector board run authority was refused with status ${response.status}`);
    }
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > MAX_RESPONSE_BYTES) throw unavailable("Vector board run authority response exceeded the size limit");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw unavailable("Vector board run authority response was not valid JSON");
    }
    if (!body || typeof body !== "object" || body.version !== 1) {
      throw unavailable("Vector board run authority returned an unsupported version");
    }
    const providerHandle = boundedHandle(body.providerAuthorityHandle);
    const toolHandle = boundedHandle(body.authorityHandle);
    const tools = body.authorityTools;
    if (!Array.isArray(tools) || tools.length === 0 || !tools.every((tool) => typeof tool === "string" && tool)) {
      throw unavailable("Vector board run authority returned an invalid tool surface");
    }
    await this.deps.provider.bindRun({ ...scope, externalSessionId, authorityHandle: providerHandle });
    if (this.deps.tool) {
      await this.deps.tool.bindRun({
        ...scope,
        externalSessionId,
        authorityHandle: toolHandle,
        allowedTools: tools as string[],
      });
    }
  }
}

let activeBoardAuthority: VectorBoardRunAuthority | null = null;

export function setActiveVectorBoardRunAuthority(authority: VectorBoardRunAuthority | null): void {
  activeBoardAuthority = authority;
}

/**
 * Board-run seam for heartbeat. It acts only for a run that would otherwise
 * fail for missing provider authority: required, issue-bound, and carrying no
 * Vector ingress marker. Vector ingress runs keep their own handles untouched.
 */
export async function prepareActiveVectorBoardRunAuthority(input: {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  toolPending: unknown;
  providerPending: unknown;
  providerBound: unknown;
  required: boolean;
}): Promise<boolean> {
  if (
    !activeBoardAuthority || !input.required || !input.issueId ||
    input.toolPending != null || input.providerPending != null || input.providerBound != null
  ) return false;
  await activeBoardAuthority.bind({
    runId: input.runId,
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
  });
  return true;
}
