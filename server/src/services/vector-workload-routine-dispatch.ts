import { createHash, createHmac } from "node:crypto";

const DISPATCH_PATH = "/internal/paperclip/workloads/dispatch";
const MIN_SECRET_LENGTH = 32;
const DEFAULT_TIMEOUT_MS = 30_000;

export type VectorWorkloadQueue = "research" | "tasks";

export interface VectorWorkloadRoutineDispatchInput {
  routineRunId: string;
  routineId: string;
  triggerId?: string | null;
  companyId: string;
  queue: VectorWorkloadQueue;
}

export interface VectorWorkloadRoutineDispatchResult {
  claimed: number;
  duplicate: boolean;
  state: string;
}

export interface VectorWorkloadRoutineDispatcher {
  dispatch(input: VectorWorkloadRoutineDispatchInput): Promise<VectorWorkloadRoutineDispatchResult>;
}

export interface VectorWorkloadRoutineDispatchConfig {
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
    throw new Error("Vector workload dispatch URL must be the exact loopback endpoint");
  }
  return url.toString();
}

function signature(secret: string, timestamp: string, body: string) {
  const digest = createHash("sha256").update(body).digest("hex");
  const canonical = `POST\n${DISPATCH_PATH}\n${timestamp}\n${digest}`;
  return `v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
}

export function createVectorWorkloadRoutineDispatcher(
  config: VectorWorkloadRoutineDispatchConfig,
): VectorWorkloadRoutineDispatcher {
  const url = requireLoopbackDispatchUrl(config.url.trim());
  const secret = config.secret.trim();
  if (secret.length < MIN_SECRET_LENGTH) throw new Error("Vector workload dispatch secret is missing or invalid");
  if (!config.installationId.trim() || !config.profile.trim() || !config.companyId.trim()) {
    throw new Error("Vector workload dispatch requires complete installation scope");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async dispatch(input) {
      if (input.companyId !== config.companyId) throw new Error("Vector workload routine company scope mismatch");
      if (input.queue !== "research" && input.queue !== "tasks") throw new Error("Unsupported Vector workload queue");
      const body = JSON.stringify({
        schemaVersion: 1,
        routineRunId: input.routineRunId,
        routineId: input.routineId,
        ...(input.triggerId ? { triggerId: input.triggerId } : {}),
        installationId: config.installationId,
        profile: config.profile,
        companyId: config.companyId,
        queue: input.queue,
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
      if (!response.ok) throw new Error(`Vector workload dispatch returned HTTP ${response.status}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("Vector workload dispatch returned invalid JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Vector workload dispatch returned invalid response");
      }
      const record = parsed as Record<string, unknown>;
      if (!Number.isInteger(record.claimed) || (record.claimed as number) < 0 ||
          typeof record.duplicate !== "boolean" || typeof record.state !== "string") {
        throw new Error("Vector workload dispatch returned invalid response");
      }
      return {
        claimed: record.claimed as number,
        duplicate: record.duplicate,
        state: record.state,
      };
    },
  };
}

export function vectorWorkloadRoutineDispatcherFromEnv(
  env: Record<string, string | undefined> = process.env,
): VectorWorkloadRoutineDispatcher | null {
  const url = env.PAPERCLIP_VECTOR_WORKLOAD_DISPATCH_URL?.trim() ?? "";
  const secret = env.PAPERCLIP_VECTOR_WORKLOAD_DISPATCH_SECRET?.trim() ?? "";
  if (!url && !secret) return null;
  if (!url || !secret) throw new Error("Vector workload dispatch URL and secret must be configured together");
  return createVectorWorkloadRoutineDispatcher({
    url,
    secret,
    installationId: env.PAPERCLIP_VECTOR_INSTALLATION_ID?.trim() ?? "",
    profile: env.PAPERCLIP_VECTOR_PROFILE?.trim() ?? "",
    companyId: env.PAPERCLIP_VECTOR_COMPANY_ID?.trim() ?? "",
  });
}

export const VECTOR_WORKLOAD_ROUTINE_ORIGIN_KIND = "vector_workload_dispatch";
