import { createHash, createHmac } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { conflict, unprocessable } from "../errors.js";

const PROVIDER_REDEEM_PATH = "/inbound/paperclip/v1/providers/redeem";
const ACTIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;
const MAX_REDEEM_BYTES = 64 * 1024;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

export type VectorProviderPendingDescriptor = {
  version: 1;
  handleSha256: string;
  sessionScope: string;
  commentId: string;
};

export type VectorProviderBoundDescriptor = {
  version: 1;
  installationId: string;
  profile: string;
  handleSha256: string;
  sessionScope: string;
};

export type VectorProviderRuntimeAccess = {
  providerId: "router";
  baseUrl: string;
  api: "anthropic-messages";
  apiKey: string;
  models: Array<Record<string, unknown>>;
};

type Scope = {
  companyId: string;
  agentId: string;
  externalSessionId: string;
  issueId: string;
};

type PendingGrant = Scope & {
  commentId: string;
  authorityHandle: string;
  handleSha256: string;
  sessionScope: string;
  expiresAt: number;
};

type RunGrant = Scope & {
  runId: string;
  authorityHandle: string;
  handleSha256: string;
  sessionScope: string;
  expiresAt: number;
  access?: VectorProviderRuntimeAccess;
};

export type VectorProviderAuthorityConfig = {
  endpoint: URL;
  installationId: string;
  profile: string;
  secret: string;
  ttlSeconds: number;
};

type FetchLike = typeof fetch;

function requireLoopbackRedeemUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PAPERCLIP_VECTOR_PROVIDER_BRIDGE_URL must be an absolute URL");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "http:" ||
    !(host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)) ||
    url.username ||
    url.password ||
    url.pathname !== PROVIDER_REDEEM_PATH ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `PAPERCLIP_VECTOR_PROVIDER_BRIDGE_URL must use unauthenticated literal loopback HTTP and ${PROVIDER_REDEEM_PATH}`,
    );
  }
  return url;
}

export function resolveVectorProviderAuthorityConfig(
  env: NodeJS.ProcessEnv = process.env,
): VectorProviderAuthorityConfig | null {
  const endpoint = env.PAPERCLIP_VECTOR_PROVIDER_BRIDGE_URL?.trim();
  const installationId = env.PAPERCLIP_VECTOR_INSTALLATION_ID?.trim();
  const profile = env.PAPERCLIP_VECTOR_PROFILE?.trim().toLowerCase();
  const secret = env.PAPERCLIP_VECTOR_PROVIDER_BRIDGE_SECRET?.trim();
  const configured = [endpoint, installationId, profile, secret].filter(Boolean).length;
  if (configured === 0) return null;
  if (configured !== 4) {
    throw new Error(
      "Vector provider authority requires bridge URL, installation ID, profile, and bridge secret",
    );
  }
  if (secret!.length < 32) {
    throw new Error("PAPERCLIP_VECTOR_PROVIDER_BRIDGE_SECRET must be at least 32 characters");
  }
  const rawTtl = env.PAPERCLIP_VECTOR_PROVIDER_AUTHORITY_TTL_SECONDS?.trim() || "7200";
  if (!/^\d+$/.test(rawTtl)) throw new Error("Vector provider authority TTL must be an integer");
  const ttlSeconds = Number(rawTtl);
  if (ttlSeconds < 60 || ttlSeconds > 86400) {
    throw new Error("Vector provider authority TTL must be between 60 and 86400 seconds");
  }
  return {
    endpoint: requireLoopbackRedeemUrl(endpoint!),
    installationId: installationId!,
    profile: profile!,
    secret: secret!,
    ttlSeconds,
  };
}

export function signVectorProviderRedeem(input: {
  secret: string;
  timestamp: string;
  rawBody: Buffer;
}): string {
  const bodySha256 = createHash("sha256").update(input.rawBody).digest("hex");
  const canonical = [
    "vector-paperclip-provider-bridge/v1",
    input.timestamp,
    "POST",
    PROVIDER_REDEEM_PATH,
    bodySha256,
  ].join("\n");
  return `v1=${createHmac("sha256", input.secret).update(canonical).digest("hex")}`;
}

function sessionScope(input: Pick<Scope, "companyId" | "agentId" | "externalSessionId">): string {
  return createHash("sha256")
    .update("paperclip-vector-provider-session/v1\0")
    .update(input.companyId)
    .update("\0")
    .update(input.agentId)
    .update("\0")
    .update(input.externalSessionId)
    .digest("base64url");
}

function boundedHandle(value: string): string {
  const handle = value.trim();
  if (!handle || handle.length > 1024) {
    throw unprocessable("Vector provider authority handle is invalid", {
      code: "vector_provider_authority_invalid",
    });
  }
  return handle;
}

function isLiteralLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255 && String(value) === part;
  });
}

function parseRouterUrl(raw: unknown): { baseUrl: string; parentProxy: boolean } {
  if (typeof raw !== "string") throw new Error("Vector provider redemption returned an invalid router URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Vector provider redemption returned an invalid router URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Vector provider redemption returned an invalid router URL");
  }
  const parentProxy = url.protocol === "http:" &&
    isLiteralLoopbackHostname(url.hostname) &&
    url.pathname === "/inbound/paperclip/v1/router";
  return { baseUrl: url.toString().replace(/\/$/, ""), parentProxy };
}

function parseRouterToken(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length < 32 || raw.length > 16_384 ||
    stringsWithWhitespace(raw) ||
    !/^[\x21-\x7e]+$/.test(raw)
  ) {
    throw new Error("Vector provider redemption returned an invalid router token");
  }
  return raw;
}

function stringsWithWhitespace(value: string): boolean {
  return /\s/.test(value);
}

export function validateVectorProviderRedemption(
  redeemed: Record<string, unknown>,
  now: number,
): { baseUrl: string; apiKey: string; expiry: number } {
  if (redeemed.version !== 1) {
    throw new Error("Vector provider redemption returned an unsupported version");
  }
  const { baseUrl, parentProxy } = parseRouterUrl(redeemed.router_url);
  const apiKey = parseRouterToken(redeemed.router_token);
  const expiry = typeof redeemed.expires_at === "string" ? Date.parse(redeemed.expires_at) : NaN;
  const maximumGrantLifetime = parentProxy ? 2 * 60 * 60_000 : 10 * 60_000 + 5_000;
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + maximumGrantLifetime) {
    throw new Error("Vector provider redemption returned an invalid expiry");
  }
  return { baseUrl, apiKey, expiry };
}

async function boundedJson(response: Response, maxBytes: number, label: string): Promise<unknown> {
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length > maxBytes) throw new Error(`${label} exceeded the size limit`);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(`${label} was not valid JSON`);
  }
}

export class VectorProviderAuthorityBridge {
  private readonly pending = new Map<string, PendingGrant>();
  private readonly byRun = new Map<string, RunGrant>();

  constructor(
    private readonly db: Db,
    private readonly config: VectorProviderAuthorityConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private pendingKey(input: Pick<PendingGrant, "companyId" | "agentId" | "issueId" | "commentId">) {
    return [input.companyId, input.agentId, input.issueId, input.commentId].join("\0");
  }

  registerPending(input: Scope & { commentId: string; authorityHandle: string }): VectorProviderPendingDescriptor {
    const authorityHandle = boundedHandle(input.authorityHandle);
    if (!input.commentId.trim()) throw unprocessable("Vector provider authority comment is invalid");
    const handleSha256 = createHash("sha256").update(authorityHandle).digest("hex");
    const scope = sessionScope(input);
    const key = this.pendingKey(input);
    const existing = this.pending.get(key);
    if (existing && existing.expiresAt > this.now() && (
      existing.handleSha256 !== handleSha256 || existing.sessionScope !== scope
    )) {
      throw conflict("Vector provider authority is already pending for different scope", {
        code: "vector_provider_authority_scope_conflict",
      });
    }
    this.pending.set(key, {
      ...input,
      authorityHandle,
      handleSha256,
      sessionScope: scope,
      expiresAt: this.now() + this.config.ttlSeconds * 1000,
    });
    return { version: 1, handleSha256, sessionScope: scope, commentId: input.commentId };
  }

  async bindRun(input: Scope & { runId: string; authorityHandle: string }): Promise<void> {
    const authorityHandle = boundedHandle(input.authorityHandle);
    const handleSha256 = createHash("sha256").update(authorityHandle).digest("hex");
    const scope = sessionScope(input);
    const [bound] = await this.db.update(heartbeatRuns).set({
      contextSnapshot: sql`jsonb_set(
        coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb),
        '{vectorProviderAuthority}',
        jsonb_build_object(
          'version', 1,
          'installationId', ${this.config.installationId}::text,
          'profile', ${this.config.profile}::text,
          'handleSha256', ${handleSha256}::text,
          'sessionScope', ${scope}::text
        ), true
      )`,
    }).where(and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
      sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.nativeIssueId}::text) = ${input.issueId}`,
    )).returning({ id: heartbeatRuns.id });
    if (!bound) {
      throw conflict("Vector provider authority does not match the active run", {
        code: "vector_provider_authority_scope_conflict",
      });
    }
    const existing = this.byRun.get(input.runId);
    if (existing && (
      existing.handleSha256 !== handleSha256 ||
      existing.sessionScope !== scope ||
      existing.issueId !== input.issueId
    )) {
      throw conflict("Vector provider authority is already bound to different scope", {
        code: "vector_provider_authority_scope_conflict",
      });
    }
    if (!existing) {
      this.byRun.set(input.runId, {
        ...input,
        authorityHandle,
        handleSha256,
        sessionScope: scope,
        expiresAt: this.now() + this.config.ttlSeconds * 1000,
      });
    }
  }

  async bindPendingRun(input: Omit<Scope, "externalSessionId"> & {
    runId: string;
    pending: VectorProviderPendingDescriptor;
  }): Promise<void> {
    const key = this.pendingKey({ ...input, commentId: input.pending.commentId });
    const existing = this.byRun.get(input.runId);
    if (
      existing && existing.expiresAt > this.now() &&
      existing.handleSha256 === input.pending.handleSha256 &&
      existing.sessionScope === input.pending.sessionScope
    ) {
      this.pending.delete(key);
      return;
    }
    const grant = this.pending.get(key);
    if (
      !grant || grant.expiresAt <= this.now() || input.pending.version !== 1 ||
      grant.handleSha256 !== input.pending.handleSha256 || grant.sessionScope !== input.pending.sessionScope
    ) {
      this.pending.delete(key);
      throw conflict("Vector provider authority pending grant is unavailable", {
        code: "vector_provider_authority_pending_missing",
      });
    }
    this.pending.delete(key);
    await this.bindRun({
      companyId: grant.companyId,
      agentId: grant.agentId,
      externalSessionId: grant.externalSessionId,
      issueId: grant.issueId,
      runId: input.runId,
      authorityHandle: grant.authorityHandle,
    });
  }

  async runtimeAccess(input: {
    runId: string;
    companyId: string;
    agentId: string;
    issueId: string | null;
  }): Promise<VectorProviderRuntimeAccess | null> {
    const grant = this.byRun.get(input.runId);
    if (!grant || grant.expiresAt <= this.now()) return null;
    if (
      grant.companyId !== input.companyId || grant.agentId !== input.agentId ||
      !input.issueId || grant.issueId !== input.issueId
    ) return null;
    if (grant.access) return grant.access;

    const rawBody = Buffer.from(JSON.stringify({
      version: 1,
      installationId: this.config.installationId,
      profile: this.config.profile,
      providerAuthorityHandle: grant.authorityHandle,
      companyId: grant.companyId,
      agentId: grant.agentId,
      sessionScope: grant.sessionScope,
      conversationId: grant.issueId,
      runId: grant.runId,
    }));
    const timestamp = String(Math.floor(this.now() / 1000));
    const response = await this.fetchImpl(this.config.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-paperclip-timestamp": timestamp,
        "x-paperclip-signature": signVectorProviderRedeem({
          secret: this.config.secret,
          timestamp,
          rawBody,
        }),
      },
      body: rawBody,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Vector provider redemption failed with status ${response.status}`);
    const redeemed = await boundedJson(response, MAX_REDEEM_BYTES, "Vector provider redemption") as Record<string, unknown>;
    const { baseUrl, apiKey, expiry } = validateVectorProviderRedemption(redeemed, this.now());
    const catalogResponse = await this.fetchImpl(`${baseUrl}/api/router/runtime-catalog`, {
      method: "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!catalogResponse.ok) throw new Error(`Vector router catalog failed with status ${catalogResponse.status}`);
    const catalog = await boundedJson(catalogResponse, MAX_CATALOG_BYTES, "Vector router catalog") as Record<string, unknown>;
    if (catalog.provider !== "router" || catalog.api !== "anthropic-messages" || !Array.isArray(catalog.models) || catalog.models.length === 0) {
      throw new Error("Vector router catalog has an unsupported provider contract");
    }
    const seen = new Set<string>();
    const models = catalog.models.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Vector router catalog contains an invalid model");
      }
      const model = entry as Record<string, unknown>;
      const id = typeof model.id === "string" ? model.id.trim() : "";
      const contextWindow = Number(model.context_window);
      const maxTokens = Number(model.max_tokens);
      const input = Array.isArray(model.input) && model.input.every((value) => value === "text" || value === "image")
        ? model.input
        : ["text"];
      if (!id || id.includes("/") || seen.has(id) || !Number.isInteger(contextWindow) || !Number.isInteger(maxTokens) || contextWindow <= 0 || maxTokens <= 0 || maxTokens > contextWindow) {
        throw new Error("Vector router catalog contains an invalid model");
      }
      seen.add(id);
      return {
        id,
        name: id,
        reasoning: model.reasoning === true,
        input,
        contextWindow,
        maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    });
    grant.expiresAt = Math.min(grant.expiresAt, expiry);
    grant.access = { providerId: "router", baseUrl, api: "anthropic-messages", apiKey, models };
    return grant.access;
  }
}

let activeBridge: VectorProviderAuthorityBridge | null = null;

export function setActiveVectorProviderAuthorityBridge(bridge: VectorProviderAuthorityBridge | null) {
  activeBridge = bridge;
}

export function hasActiveVectorProviderAuthorityBridge(): boolean {
  return activeBridge !== null;
}

export async function prepareActiveVectorProviderRuntimeAccess(input: {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  pending: unknown;
  bound: unknown;
  required?: boolean;
}): Promise<VectorProviderRuntimeAccess | null> {
  const expectsAuthority = input.required === true || input.pending != null || input.bound != null;
  if (input.pending == null) {
    const access = await activeBridge?.runtimeAccess(input) ?? null;
    if (expectsAuthority && !access) {
      throw conflict("Vector provider authority is unavailable for the bound run", {
        code: "vector_provider_authority_unavailable",
      });
    }
    return access;
  }
  const pending = input.pending as Partial<VectorProviderPendingDescriptor>;
  if (
    !activeBridge || !input.issueId || pending.version !== 1 ||
    typeof pending.handleSha256 !== "string" || !/^[a-f0-9]{64}$/.test(pending.handleSha256) ||
    typeof pending.sessionScope !== "string" || !pending.sessionScope ||
    typeof pending.commentId !== "string" || !pending.commentId
  ) {
    throw conflict("Vector provider authority pending grant is unavailable", {
      code: "vector_provider_authority_pending_missing",
    });
  }
  await activeBridge.bindPendingRun({
    runId: input.runId,
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    pending: pending as VectorProviderPendingDescriptor,
  });
  const access = await activeBridge.runtimeAccess(input);
  if (!access) {
    throw conflict("Vector provider authority is unavailable for the bound run", {
      code: "vector_provider_authority_unavailable",
    });
  }
  return access;
}
