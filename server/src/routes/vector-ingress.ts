import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { unauthorized } from "../errors.js";
import {
  vectorIngressService,
  type VectorIngressService,
} from "../services/vector-ingress.js";

const VECTOR_INGRESS_SECRET_ENV = "PAPERCLIP_VECTOR_INGRESS_SECRET";
const VECTOR_INGRESS_MAX_SKEW_ENV =
  "PAPERCLIP_VECTOR_INGRESS_MAX_CLOCK_SKEW_SECONDS";
const VECTOR_INGRESS_RESPONSIBLE_USER_ENV =
  "PAPERCLIP_VECTOR_INGRESS_RESPONSIBLE_USER_ID";
const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 60;
const MIN_SECRET_LENGTH = 32;

export interface VectorIngressAuthConfig {
  secret: string;
  maxClockSkewSeconds: number;
  responsibleUserId: string;
}

const scopeSchema = z.object({
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  externalSessionId: z.string().trim().min(1).max(512),
});

const turnSchema = scopeSchema.extend({
  clientRequestId: z.string().trim().min(1).max(255),
  body: z.string().min(1).max(1_000_000),
  attachmentIds: z.array(z.string().uuid()).max(20).optional(),
});

const resetSchema = scopeSchema.extend({
  clientRequestId: z.string().trim().min(1).max(255),
});

const cancelSchema = scopeSchema.extend({
  runId: z.string().uuid().optional(),
});

const eventsSchema = scopeSchema.extend({
  afterSeq: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export function resolveVectorIngressAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): VectorIngressAuthConfig | null {
  const secret = env[VECTOR_INGRESS_SECRET_ENV]?.trim();
  if (!secret) return null;
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${VECTOR_INGRESS_SECRET_ENV} must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  const rawSkew = env[VECTOR_INGRESS_MAX_SKEW_ENV]?.trim();
  if (rawSkew && !/^\d+$/.test(rawSkew)) {
    throw new Error(
      `${VECTOR_INGRESS_MAX_SKEW_ENV} must be an integer between 1 and 300`,
    );
  }
  const maxClockSkewSeconds = rawSkew
    ? Number.parseInt(rawSkew, 10)
    : DEFAULT_MAX_CLOCK_SKEW_SECONDS;
  if (
    !Number.isInteger(maxClockSkewSeconds) ||
    maxClockSkewSeconds < 1 ||
    maxClockSkewSeconds > 300
  ) {
    throw new Error(
      `${VECTOR_INGRESS_MAX_SKEW_ENV} must be an integer between 1 and 300`,
    );
  }
  return {
    secret,
    maxClockSkewSeconds,
    responsibleUserId:
      env[VECTOR_INGRESS_RESPONSIBLE_USER_ENV]?.trim() || "local-board",
  };
}

export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::1") return true;
  const ipv4 = normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
  return isIP(ipv4) === 4 && ipv4.startsWith("127.");
}

export function signVectorIngressRequest(input: {
  secret: string;
  timestamp: string;
  method: string;
  path: string;
  rawBody: Buffer;
}) {
  const bodySha256 = createHash("sha256").update(input.rawBody).digest("hex");
  const canonical = [
    "paperclip-vector-ingress/v1",
    input.timestamp,
    input.method.toUpperCase(),
    input.path,
    bodySha256,
  ].join("\n");
  return `v1=${createHmac("sha256", input.secret).update(canonical).digest("hex")}`;
}

function signaturesEqual(expected: string, actual: string) {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

export function vectorIngressAuth(
  config: VectorIngressAuthConfig,
  now: () => number = Date.now,
): RequestHandler {
  return (req, _res, next) => {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      next(unauthorized("Vector ingress requires a direct loopback peer"));
      return;
    }
    const timestamp = req.header("x-vector-timestamp")?.trim() ?? "";
    const timestampSeconds = Number(timestamp);
    if (
      !/^\d+$/.test(timestamp) ||
      !Number.isSafeInteger(timestampSeconds) ||
      Math.abs(Math.floor(now() / 1000) - timestampSeconds) >
        config.maxClockSkewSeconds
    ) {
      next(unauthorized("Vector ingress timestamp is invalid or expired"));
      return;
    }
    const signature = req.header("x-vector-signature")?.trim() ?? "";
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      next(unauthorized("Vector ingress requires an exact signed request body"));
      return;
    }
    const expected = signVectorIngressRequest({
      secret: config.secret,
      timestamp,
      method: req.method,
      path: req.originalUrl,
      rawBody,
    });
    if (!signaturesEqual(expected, signature)) {
      next(unauthorized("Vector ingress signature did not verify"));
      return;
    }
    next();
  };
}

export function vectorIngressRoutes(
  db: Db,
  options: {
    auth: VectorIngressAuthConfig;
    service?: VectorIngressService;
    now?: () => number;
  },
) {
  const router = Router();
  const service = options.service ?? vectorIngressService(db);
  router.use(vectorIngressAuth(options.auth, options.now));

  router.post("/turns", async (req, res) => {
    const input = turnSchema.parse(req.body);
    const result = await service.addTurn(input);
    res.status(result.replayed ? 200 : 201).json(result);
  });

  router.post("/sessions/reset", async (req, res) => {
    const input = resetSchema.parse(req.body);
    const result = await service.reset(input);
    res.status(result.replayed ? 200 : 202).json(result);
  });

  router.post("/sessions/cancel", async (req, res) => {
    const input = cancelSchema.parse(req.body);
    res.json(await service.cancel(input));
  });

  router.post("/sessions/status", async (req, res) => {
    const input = scopeSchema.parse(req.body);
    res.json(await service.status(input));
  });

  router.post("/sessions/events", async (req, res) => {
    const input = eventsSchema.parse(req.body);
    res.json(await service.events(input));
  });

  return router;
}
