import { createHash, createHmac } from "node:crypto";
import { isVectorFunkyServerProfile } from "@paperclipai/adapter-utils/vector-profiles";

const DISPATCH_PATH = "/inbound/paperclip/schedules/dispatch";
const MIN_SECRET_LENGTH = 32;
const DEFAULT_TIMEOUT_MS = 30_000;

export const VECTOR_SCHEDULE_KEYS = [
  "fa_research_daily",
  "fa_research_lease_sweep",
  "fa_task_lease_sweep",
  "fa_dmv_review_daily",
  "fa_dmv_audit_back_triage_daily",
  "fa_rollup_query_themes",
] as const;
export type VectorScheduleKey = (typeof VECTOR_SCHEDULE_KEYS)[number];
const VECTOR_SCHEDULE_KEY_SET = new Set<string>(VECTOR_SCHEDULE_KEYS);

export interface VectorScheduleRoutineDispatchInput {
  routineRunId: string;
  routineId: string;
  triggerId?: string | null;
  companyId: string;
  scheduleKey: VectorScheduleKey;
}

export interface VectorScheduleRoutineDispatchResult {
  accepted: boolean;
  skipped: boolean;
  duplicate: boolean;
  state: string;
  reason: string;
}

export interface VectorScheduleRoutineDispatcher {
  dispatch(input: VectorScheduleRoutineDispatchInput): Promise<VectorScheduleRoutineDispatchResult>;
}

export interface VectorScheduleRoutineDispatchConfig {
  url: string;
  secret: string;
  installationId: string;
  profile: string;
  companyId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function requireLoopbackDispatchUrl(raw: string) {
  const url = new URL(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(hostname) ||
      url.pathname !== DISPATCH_PATH || url.username || url.password || url.search || url.hash) {
    throw new Error("Vector schedule dispatch URL must be the exact loopback endpoint");
  }
  return url.toString();
}

function signature(secret: string, timestamp: string, body: string) {
  const digest = createHash("sha256").update(body).digest("hex");
  const canonical = `POST\n${DISPATCH_PATH}\n${timestamp}\n${digest}`;
  return `v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
}

export function createVectorScheduleRoutineDispatcher(
  config: VectorScheduleRoutineDispatchConfig,
): VectorScheduleRoutineDispatcher {
  const url = requireLoopbackDispatchUrl(config.url.trim());
  const secret = config.secret.trim();
  if (secret.length < MIN_SECRET_LENGTH) throw new Error("Vector schedule dispatch secret is missing or invalid");
  if (!config.installationId.trim() || !isVectorFunkyServerProfile(config.profile) || !config.companyId.trim()) {
    throw new Error("Vector schedule dispatch requires complete Funky server (staging or production) installation scope");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async dispatch(input) {
      if (input.companyId !== config.companyId) throw new Error("Vector schedule routine company scope mismatch");
      if (!VECTOR_SCHEDULE_KEY_SET.has(input.scheduleKey)) throw new Error("Unsupported Vector schedule key");
      const body = JSON.stringify({
        schemaVersion: 1,
        routineRunId: input.routineRunId,
        routineId: input.routineId,
        ...(input.triggerId ? { triggerId: input.triggerId } : {}),
        installationId: config.installationId,
        profile: config.profile,
        companyId: config.companyId,
        scheduleKey: input.scheduleKey,
      });
      const timestamp = String(Math.floor(now() / 1000));
      const response = await fetchImpl(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          "x-paperclip-timestamp": timestamp,
          "x-paperclip-signature": signature(secret, timestamp, body),
        },
        body,
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`Vector schedule dispatch returned HTTP ${response.status}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("Vector schedule dispatch returned invalid JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Vector schedule dispatch returned invalid response");
      }
      const record = parsed as Record<string, unknown>;
      if (typeof record.accepted !== "boolean" || typeof record.skipped !== "boolean" ||
          typeof record.duplicate !== "boolean" || typeof record.state !== "string" ||
          record.state.trim() === "" || typeof record.reason !== "string" ||
          record.reason.trim() === "" || record.accepted === record.skipped) {
        throw new Error("Vector schedule dispatch returned invalid response");
      }
      return {
        accepted: record.accepted,
        skipped: record.skipped,
        duplicate: record.duplicate,
        state: record.state,
        reason: record.reason,
      };
    },
  };
}

export function vectorScheduleRoutineDispatcherFromEnv(
  env: Record<string, string | undefined> = process.env,
): VectorScheduleRoutineDispatcher | null {
  const url = env.PAPERCLIP_VECTOR_SCHEDULE_DISPATCH_URL?.trim() ?? "";
  const secret = env.PAPERCLIP_VECTOR_SCHEDULE_DISPATCH_SECRET?.trim() ?? "";
  if (!url && !secret) return null;
  if (!url || !secret) throw new Error("Vector schedule dispatch URL and secret must be configured together");
  return createVectorScheduleRoutineDispatcher({
    url,
    secret,
    installationId: env.PAPERCLIP_VECTOR_INSTALLATION_ID?.trim() ?? "",
    profile: env.PAPERCLIP_VECTOR_PROFILE?.trim() ?? "",
    companyId: env.PAPERCLIP_VECTOR_COMPANY_ID?.trim() ?? "",
  });
}

export const VECTOR_SCHEDULE_ROUTINE_ORIGIN_KIND = "vector_schedule_dispatch";
