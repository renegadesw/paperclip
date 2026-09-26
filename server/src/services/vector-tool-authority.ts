import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { conflict, unauthorized, unprocessable } from "../errors.js";

const CALLBACK_PATH = "/api/internal/vector/v1/tools/callback";
const VECTOR_TOOL_PATH = "/internal/paperclip/v1/tools/call";
const ACTIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;
const MAX_RESPONSE_BYTES = 1_000_000;

export type VectorToolAuthorityScope = {
  companyId: string;
  agentId: string;
  externalSessionId: string;
  issueId: string;
  runId: string;
};

export type VectorToolRuntimeAccess = {
  callbackUrl: string;
  bearerToken: string;
  tools: readonly string[];
};

type Grant = VectorToolAuthorityScope & {
  authorityHandle: string;
  sessionScope: string;
  bearerToken: string;
  expiresAt: number;
  requestIds: Set<string>;
};

export type VectorToolAuthorityConfig = {
  endpoint: URL;
  callbackUrl: URL;
  installationId: string;
  profile: string;
  secret: string;
  allowedTools: readonly string[];
  ttlSeconds: number;
};

type FetchLike = typeof fetch;

function isLiteralLoopback(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) === 6) return host === "::1";
  return isIP(host) === 4 && host.startsWith("127.");
}

function requireLoopbackHttpUrl(raw: string, expectedPath: string, envName: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${envName} must be an absolute URL`);
  }
  if (url.protocol !== "http:" || !isLiteralLoopback(url) || url.username || url.password) {
    throw new Error(`${envName} must use an unauthenticated literal loopback HTTP URL`);
  }
  if (url.pathname !== expectedPath || url.search || url.hash) {
    throw new Error(`${envName} must use the exact path ${expectedPath}`);
  }
  return url;
}

function packagedToolNames(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS must be valid JSON");
  }
  if (!Array.isArray(value)) {
    throw new Error("PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS must be a JSON array");
  }
  const names = value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Packaged Pi extension entry ${index} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter((key) => !["path", "sha256", "tools"].includes(key));
    if (unknownKeys.length > 0) {
      throw new Error(`Packaged Pi extension entry ${index} contains unknown fields`);
    }
    if (typeof record.path !== "string" || !path.isAbsolute(record.path)) {
      throw new Error(`Packaged Pi extension entry ${index} requires an absolute path`);
    }
    if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
      throw new Error(`Packaged Pi extension entry ${index} requires a lowercase SHA-256 digest`);
    }
    if (!Array.isArray(record.tools) || record.tools.length === 0) {
      throw new Error(`Packaged Pi extension entry ${index} requires a non-empty tool list`);
    }
    const tools = record.tools;
    if (tools.some((tool) =>
      typeof tool !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(tool)
    )) {
      throw new Error(`Packaged Pi extension entry ${index} contains an invalid tool name`);
    }
    return tools as string[];
  });
  return [...new Set(names)].sort();
}

export function resolveVectorToolAuthorityConfig(
  env: NodeJS.ProcessEnv = process.env,
): VectorToolAuthorityConfig | null {
  const endpoint = env.PAPERCLIP_VECTOR_TOOL_BRIDGE_URL?.trim();
  const callbackUrl = env.PAPERCLIP_VECTOR_TOOL_CALLBACK_URL?.trim();
  const installationId = env.PAPERCLIP_VECTOR_INSTALLATION_ID?.trim();
  const profile = env.PAPERCLIP_VECTOR_PROFILE?.trim().toLowerCase();
  const secret = env.PAPERCLIP_VECTOR_TOOL_BRIDGE_SECRET?.trim();
  const configured = [endpoint, callbackUrl, installationId, secret, profile].filter(Boolean).length;
  if (configured === 0) return null;
  if (configured !== 5) {
    throw new Error(
      "Vector tool authority requires bridge URL, callback URL, installation ID, profile, and bridge secret",
    );
  }
  if (secret!.length < 32) {
    throw new Error("PAPERCLIP_VECTOR_TOOL_BRIDGE_SECRET must be at least 32 characters");
  }
  const allowedTools = packagedToolNames(env.PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS);
  if (allowedTools.length === 0) {
    throw new Error("Vector tool authority requires at least one packaged extension tool");
  }
  const rawTtl = env.PAPERCLIP_VECTOR_TOOL_AUTHORITY_TTL_SECONDS?.trim() || "7200";
  if (!/^\d+$/.test(rawTtl)) throw new Error("Vector tool authority TTL must be an integer");
  const ttlSeconds = Number(rawTtl);
  if (ttlSeconds < 60 || ttlSeconds > 86400) {
    throw new Error("Vector tool authority TTL must be between 60 and 86400 seconds");
  }
  return {
    endpoint: requireLoopbackHttpUrl(endpoint!, VECTOR_TOOL_PATH, "PAPERCLIP_VECTOR_TOOL_BRIDGE_URL"),
    callbackUrl: requireLoopbackHttpUrl(callbackUrl!, CALLBACK_PATH, "PAPERCLIP_VECTOR_TOOL_CALLBACK_URL"),
    installationId: installationId!,
    profile: profile!,
    secret: secret!,
    allowedTools,
    ttlSeconds,
  };
}

export function vectorToolSessionScope(input: Pick<VectorToolAuthorityScope, "companyId" | "agentId" | "externalSessionId">): string {
  return createHash("sha256")
    .update("paperclip-vector-tool-session/v1\0")
    .update(input.companyId)
    .update("\0")
    .update(input.agentId)
    .update("\0")
    .update(input.externalSessionId)
    .digest("base64url");
}

export function signVectorToolRequest(input: {
  secret: string;
  timestamp: string;
  rawBody: Buffer;
}): string {
  const bodySha256 = createHash("sha256").update(input.rawBody).digest("hex");
  const canonical = [
    "vector-paperclip-tool-bridge/v1",
    input.timestamp,
    "POST",
    VECTOR_TOOL_PATH,
    bodySha256,
  ].join("\n");
  return `v1=${createHmac("sha256", input.secret).update(canonical).digest("hex")}`;
}

function tokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class VectorToolAuthorityBridge {
  private readonly byRun = new Map<string, Grant>();

  constructor(
    private readonly db: Db,
    private readonly config: VectorToolAuthorityConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async bindRun(input: VectorToolAuthorityScope & { authorityHandle: string }): Promise<void> {
    const authorityHandle = input.authorityHandle.trim();
    if (!authorityHandle || authorityHandle.length > 1024) {
      throw unprocessable("Vector tool authority handle is invalid", {
        code: "vector_tool_authority_invalid",
      });
    }
    const handleSha256 = createHash("sha256").update(authorityHandle).digest("hex");
    const sessionScope = vectorToolSessionScope(input);
    const [bound] = await this.db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: sql`jsonb_set(
          coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb),
          '{vectorToolAuthority}',
          jsonb_build_object(
            'version', 1,
            'installationId', ${this.config.installationId}::text,
            'profile', ${this.config.profile}::text,
            'handleSha256', ${handleSha256}::text,
            'sessionScope', ${sessionScope}::text
          ),
          true
        )`,
      })
      .where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
        sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.nativeIssueId}::text) = ${input.issueId}`,
        sql`(${heartbeatRuns.contextSnapshot}->'vectorToolAuthority' is null or (
          ${heartbeatRuns.contextSnapshot}->'vectorToolAuthority'->>'installationId' = ${this.config.installationId}
          and ${heartbeatRuns.contextSnapshot}->'vectorToolAuthority'->>'profile' = ${this.config.profile}
          and ${heartbeatRuns.contextSnapshot}->'vectorToolAuthority'->>'handleSha256' = ${handleSha256}
          and ${heartbeatRuns.contextSnapshot}->'vectorToolAuthority'->>'sessionScope' = ${sessionScope}
        ))`,
      ))
      .returning({ id: heartbeatRuns.id });
    if (!bound) {
      throw conflict("Vector tool authority does not match the active run", {
        code: "vector_tool_authority_scope_conflict",
      });
    }

    const existing = this.byRun.get(input.runId);
    if (existing && (
      existing.companyId !== input.companyId ||
      existing.agentId !== input.agentId ||
      existing.issueId !== input.issueId ||
      existing.sessionScope !== sessionScope ||
      existing.authorityHandle !== authorityHandle
    )) {
      throw conflict("Vector tool authority is already bound to different scope", {
        code: "vector_tool_authority_scope_conflict",
      });
    }
    if (existing) return;
    this.byRun.set(input.runId, {
      ...input,
      authorityHandle,
      sessionScope,
      bearerToken: randomBytes(32).toString("base64url"),
      expiresAt: this.now() + this.config.ttlSeconds * 1000,
      requestIds: new Set(),
    });
  }

  runtimeAccess(input: { runId: string; companyId: string; agentId: string; issueId: string | null }): VectorToolRuntimeAccess | null {
    const grant = this.byRun.get(input.runId);
    if (!grant || grant.expiresAt <= this.now()) return null;
    if (
      grant.companyId !== input.companyId ||
      grant.agentId !== input.agentId ||
      !input.issueId ||
      grant.issueId !== input.issueId
    ) return null;
    return {
      callbackUrl: this.config.callbackUrl.toString(),
      bearerToken: grant.bearerToken,
      tools: this.config.allowedTools,
    };
  }

  async call(input: {
    bearerToken: string;
    requestId: string;
    tool: string;
    arguments: unknown;
  }): Promise<{ status: number; body: Buffer; contentType: string }> {
    const grant = [...this.byRun.values()].find((candidate) =>
      tokenEqual(candidate.bearerToken, input.bearerToken)
    );
    if (!grant || grant.expiresAt <= this.now()) {
      throw unauthorized("Vector tool callback token is invalid or expired");
    }
    if (!this.config.allowedTools.includes(input.tool)) {
      throw unprocessable("Vector tool is not approved for this installation profile", {
        code: "vector_tool_not_approved",
      });
    }
    if (grant.requestIds.has(input.requestId)) {
      throw conflict("Vector tool callback request was already used", {
        code: "vector_tool_replay",
      });
    }
    const [run] = await this.db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, grant.runId),
        eq(heartbeatRuns.companyId, grant.companyId),
        eq(heartbeatRuns.agentId, grant.agentId),
        inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
        sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.nativeIssueId}::text) = ${grant.issueId}`,
        sql`${heartbeatRuns.contextSnapshot}->'vectorToolAuthority'->>'installationId' = ${this.config.installationId}`,
        sql`${heartbeatRuns.contextSnapshot}->'vectorToolAuthority'->>'profile' = ${this.config.profile}`,
        sql`${heartbeatRuns.contextSnapshot}->'vectorToolAuthority'->>'sessionScope' = ${grant.sessionScope}`,
      ))
      .limit(1);
    if (!run) {
      throw conflict("Vector tool authority run is no longer active", {
        code: "vector_tool_run_inactive",
      });
    }
    grant.requestIds.add(input.requestId);
    const rawBody = Buffer.from(JSON.stringify({
      version: 1,
      installationId: this.config.installationId,
      profile: this.config.profile,
      authorityHandle: grant.authorityHandle,
      companyId: grant.companyId,
      agentId: grant.agentId,
      sessionScope: grant.sessionScope,
      conversationId: grant.issueId,
      runId: grant.runId,
      requestId: input.requestId,
      tool: input.tool,
      arguments: input.arguments,
    }));
    const timestamp = String(Math.floor(this.now() / 1000));
    const response = await this.fetchImpl(this.config.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-paperclip-timestamp": timestamp,
        "x-paperclip-signature": signVectorToolRequest({
          secret: this.config.secret,
          timestamp,
          rawBody,
        }),
      },
      body: rawBody,
      signal: AbortSignal.timeout(30_000),
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_RESPONSE_BYTES) {
      throw conflict("Vector tool response exceeded the size limit", {
        code: "vector_tool_response_too_large",
      });
    }
    return {
      status: response.status,
      body,
      contentType: response.headers.get("content-type") || "application/json",
    };
  }
}

let activeBridge: VectorToolAuthorityBridge | null = null;

export function setActiveVectorToolAuthorityBridge(bridge: VectorToolAuthorityBridge | null): void {
  activeBridge = bridge;
}

export function activeVectorToolRuntimeAccess(input: {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
}): VectorToolRuntimeAccess | null {
  return activeBridge?.runtimeAccess(input) ?? null;
}
