import { localBoardUserId } from "../local-board-identity.js";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest, unauthorized } from "../errors.js";
import {
  vectorIngressService,
  type VectorIngressCursorPosition,
  type VectorIngressService,
} from "../services/vector-ingress.js";
import type { VectorRuntimeScope } from "../services/vector-runtime-scope.js";
import { VectorToolAuthorityBridge } from "../services/vector-tool-authority.js";

const VECTOR_INGRESS_SECRET_ENV = "PAPERCLIP_VECTOR_INGRESS_SECRET";
const VECTOR_INGRESS_MAX_SKEW_ENV =
  "PAPERCLIP_VECTOR_INGRESS_MAX_CLOCK_SKEW_SECONDS";
const VECTOR_INGRESS_RESPONSIBLE_USER_ENV =
  "PAPERCLIP_VECTOR_INGRESS_RESPONSIBLE_USER_ID";
const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 60;
const MIN_SECRET_LENGTH = 32;
const CURSOR_VERSION = "v1";
const CURSOR_DIRECTION = "forward";
const DEFAULT_CURSOR_MAX_AGE_SECONDS = 60 * 60;

export interface VectorIngressAuthConfig {
  secret: string;
  maxClockSkewSeconds: number;
  responsibleUserId: string;
  scope: VectorRuntimeScope;
}

const boundedOpaqueId = (label: string, max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value),
      `${label} must be a bounded opaque value without surrounding whitespace or control characters`,
    );

const scopeShape = {
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  externalSessionId: boundedOpaqueId("externalSessionId", 512),
  ownerId: boundedOpaqueId("ownerId", 512).optional(),
  installationId: boundedOpaqueId("installationId", 256).optional(),
  profileId: boundedOpaqueId("profileId", 256).optional(),
};

function requireCompleteOwnerScope(
  value: z.infer<z.ZodObject<typeof scopeShape>>,
  ctx: z.RefinementCtx,
) {
  const ownerFields = [value.ownerId, value.installationId, value.profileId];
  if (ownerFields.some(Boolean) && !ownerFields.every(Boolean)) {
    ctx.addIssue({
      code: "custom",
      message: "ownerId, installationId, and profileId must be supplied together",
    });
  }
}

const scopeSchema = z.object(scopeShape).superRefine(requireCompleteOwnerScope);

const vectorWorkloadLaunchSchema = z.object({
  schemaVersion: z.literal(1),
  workloadKey: boundedOpaqueId("workloadKey", 96),
  queue: z.enum(["research", "tasks"]),
  taskId: boundedOpaqueId("taskId", 256),
  attempt: z.number().int().positive(),
  leaseTokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  role: boundedOpaqueId("role", 128),
  model: z.string().trim().max(256),
  tools: z.array(boundedOpaqueId("tool", 128)).max(32),
  noBuiltinTools: z.boolean(),
  systemPrompt: z.string().min(1).max(750_000),
  metadata: z.record(
    z.string().trim().min(1).max(128),
    z.string().max(4096),
  ).refine((value) => Object.keys(value).length <= 64, "metadata has too many entries"),
}).strict();

const vectorRoleTurnSchema = z.object({
  schemaVersion: z.literal(1),
  role: boundedOpaqueId("role", 128),
  model: z.string().trim().max(256),
  noBuiltinTools: z.literal(true),
  systemPrompt: z.string().min(1).max(750_000),
  metadata: z.record(
    z.string().trim().min(1).max(128),
    z.string().max(4096),
  ).refine((value) => Object.keys(value).length <= 64, "metadata has too many entries"),
}).strict();

const vectorPersonaTurnSchema = z.object({
  schemaVersion: z.literal(1),
  personaId: z.string().uuid(),
  personaName: boundedOpaqueId("personaName", 128),
  personaVersion: z.string().regex(/^[a-f0-9]{12}$/),
  model: z.string().trim().min(1).max(256),
  noBuiltinTools: z.literal(true),
  systemPrompt: z.string().min(1).max(750_000),
}).strict();

const ownerScopeSchema = z.object({
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  ownerId: boundedOpaqueId("ownerId", 512),
  installationId: boundedOpaqueId("installationId", 256),
  profileId: boundedOpaqueId("profileId", 256),
});

const turnSchema = z.object({
  ...scopeShape,
  clientRequestId: z.string().trim().min(1).max(255),
  body: z.string().min(1).max(1_000_000),
  voiceActive: z.boolean().optional(),
  attachmentIds: z.array(z.string().uuid()).max(20).optional(),
  images: z.array(z.object({
    type: z.literal("image"),
    data: z.string().min(1).max(9_786_712).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  }).strict()).max(8).optional(),
  authorityHandle: z.string().trim().min(1).max(1024).optional(),
  authorityTools: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)).min(1).max(64).optional(),
  providerAuthorityHandle: z.string().trim().min(1).max(1024).optional(),
  launchContext: vectorWorkloadLaunchSchema.optional(),
  roleContext: vectorRoleTurnSchema.optional(),
  personaContext: vectorPersonaTurnSchema.optional(),
}).superRefine((value, ctx) => {
  requireCompleteOwnerScope(value, ctx);
  if ([value.launchContext, value.roleContext, value.personaContext].filter(Boolean).length > 1) {
    ctx.addIssue({ code: "custom", message: "launchContext, roleContext, and personaContext are mutually exclusive" });
  }
  if (Boolean(value.authorityHandle) !== Boolean(value.authorityTools)) {
    ctx.addIssue({ code: "custom", message: "authorityHandle and authorityTools must be supplied together" });
  }
  if (value.launchContext?.tools.length &&
      JSON.stringify([...new Set(value.launchContext.tools)].sort()) !==
        JSON.stringify([...(value.authorityTools ?? [])].sort())) {
    ctx.addIssue({ code: "custom", message: "workload authorityTools must exactly match launchContext.tools" });
  }
});

const toolCallbackSchema = z.object({
  requestId: z.string().uuid(),
  tool: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  arguments: z.unknown(),
}).strict();

const resetSchema = z.object({
  ...scopeShape,
  clientRequestId: z.string().trim().min(1).max(255),
}).superRefine(requireCompleteOwnerScope);

const cancelSchema = z.object({
  ...scopeShape,
  runId: z.string().uuid().optional(),
}).superRefine(requireCompleteOwnerScope);

const eventsSchema = z.object({
  ...scopeShape,
  afterSeq: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
}).superRefine(requireCompleteOwnerScope);

const inventorySchema = ownerScopeSchema.extend({
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const transcriptSchema = ownerScopeSchema.extend({
  externalSessionId: boundedOpaqueId("externalSessionId", 512),
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

const cursorPositionSchema = z.object({
  at: z.string().datetime({ offset: true }),
  rank: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  id: z.string().min(1).max(512),
});

const cursorPayloadSchema = z.object({
  issuedAt: z.number().int().nonnegative(),
  position: cursorPositionSchema,
});

export interface VectorIngressCursorCodec {
  seal(purpose: "inventory" | "transcript", scope: string, value: VectorIngressCursorPosition): string;
  open(purpose: "inventory" | "transcript", scope: string, token: string): VectorIngressCursorPosition;
}

export function createVectorIngressCursorCodec(
  secret: string,
  options: { now?: () => number; maxAgeSeconds?: number } = {},
): VectorIngressCursorCodec {
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from("paperclip-vector-ingress/v1", "utf8"),
      Buffer.from("cursor-aes-256-gcm/v1", "utf8"),
      32,
    ),
  );
  const now = options.now ?? (() => Date.now());
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_CURSOR_MAX_AGE_SECONDS;
  const aad = (purpose: string, scope: string) =>
    Buffer.from(
      `paperclip-vector-ingress-cursor/v1\0${purpose}\0${CURSOR_DIRECTION}\0${scope}`,
    );
  return {
    seal(purpose, scope, value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(purpose, scope));
      const encrypted = Buffer.concat([
        cipher.update(
          JSON.stringify({ issuedAt: Math.floor(now() / 1_000), position: value }),
          "utf8",
        ),
        cipher.final(),
      ]);
      return [
        CURSOR_VERSION,
        nonce.toString("base64url"),
        encrypted.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
      ].join(".");
    },
    open(purpose, scope, token) {
      const [version, rawNonce, rawEncrypted, rawTag, extra] = token.split(".");
      if (
        version !== CURSOR_VERSION ||
        !rawNonce ||
        !rawEncrypted ||
        !rawTag ||
        extra
      ) {
        throw badRequest("Vector ingress cursor is invalid");
      }
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(rawNonce, "base64url"),
        );
        decipher.setAAD(aad(purpose, scope));
        decipher.setAuthTag(Buffer.from(rawTag, "base64url"));
        const decoded = Buffer.concat([
          decipher.update(Buffer.from(rawEncrypted, "base64url")),
          decipher.final(),
        ]).toString("utf8");
        const payload = cursorPayloadSchema.parse(JSON.parse(decoded));
        const ageSeconds = Math.floor(now() / 1_000) - payload.issuedAt;
        if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) {
          throw new Error("expired cursor");
        }
        return payload.position;
      } catch {
        throw badRequest("Vector ingress cursor is invalid");
      }
    },
  };
}

function inventoryCursorScope(input: z.infer<typeof ownerScopeSchema>) {
  return [
    input.installationId,
    input.profileId,
    input.companyId,
    input.agentId,
    input.ownerId,
  ].join("\0");
}

function transcriptCursorScope(input: z.infer<typeof transcriptSchema>) {
  return `${inventoryCursorScope(input)}\0${input.externalSessionId}`;
}

export function resolveVectorIngressAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  scope: VectorRuntimeScope | null = null,
): VectorIngressAuthConfig | null {
  const secret = env[VECTOR_INGRESS_SECRET_ENV]?.trim();
  if (!secret) return null;
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${VECTOR_INGRESS_SECRET_ENV} must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  if (!scope) {
    throw new Error(
      `${VECTOR_INGRESS_SECRET_ENV} requires an immutable Vector runtime scope`,
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
      env[VECTOR_INGRESS_RESPONSIBLE_USER_ENV]?.trim() || localBoardUserId(env),
    scope,
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
  scope: VectorRuntimeScope;
  timestamp: string;
  method: string;
  path: string;
  rawBody: Buffer;
}) {
  const bodySha256 = createHash("sha256").update(input.rawBody).digest("hex");
  const canonical = [
    "paperclip-vector-ingress/v2",
    input.scope.installationId,
    input.scope.profile,
    input.scope.companyId,
    [...input.scope.allowedAgentIds].sort().join(","),
    input.timestamp,
    input.method.toUpperCase(),
    input.path,
    bodySha256,
  ].join("\n");
  return `v2=${createHmac("sha256", input.secret).update(canonical).digest("hex")}`;
}

function requestMatchesRuntimeScope(
  body: unknown,
  scope: VectorRuntimeScope,
): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const requestScope = body as Record<string, unknown>;
  if (requestScope.companyId !== scope.companyId) return false;
  if (typeof requestScope.agentId !== "string"
      || !scope.allowedAgentIds.includes(requestScope.agentId)) return false;
  if (requestScope.installationId !== undefined
      && requestScope.installationId !== scope.installationId) return false;
  if (requestScope.profileId !== undefined
      && requestScope.profileId !== scope.profile) return false;
  return true;
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
      scope: config.scope,
      timestamp,
      method: req.method,
      path: req.originalUrl,
      rawBody,
    });
    if (!signaturesEqual(expected, signature)) {
      next(unauthorized("Vector ingress signature did not verify"));
      return;
    }
    if (!requestMatchesRuntimeScope(req.body, config.scope)) {
      next(unauthorized("Vector ingress request is outside its configured runtime scope"));
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
    toolAuthority?: VectorToolAuthorityBridge;
    now?: () => number;
  },
) {
  const router = Router();
  const service = options.service ?? vectorIngressService(db);
  const cursors = createVectorIngressCursorCodec(options.auth.secret);
  if (options.toolAuthority) {
    router.post("/tools/callback", async (req, res) => {
      if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
        throw unauthorized("Vector tool callback requires a direct loopback peer");
      }
      const authorization = req.header("authorization") ?? "";
      const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
      if (!match) throw unauthorized("Vector tool callback token is required");
      const input = toolCallbackSchema.parse(req.body);
      const result = await options.toolAuthority!.call({
        bearerToken: match[1],
        requestId: input.requestId,
        tool: input.tool,
        arguments: input.arguments,
      });
      res.status(result.status).type(result.contentType).send(result.body);
    });
  }
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

  router.post("/sessions/list", async (req, res) => {
    const input = inventorySchema.parse(req.body);
    const result = await service.inventory({
      companyId: input.companyId,
      agentId: input.agentId,
      ownerId: input.ownerId,
      installationId: input.installationId,
      profileId: input.profileId,
      limit: input.limit,
      after: input.cursor
        ? cursors.open("inventory", inventoryCursorScope(input), input.cursor)
        : undefined,
    });
    const { nextPosition, ...response } = result;
    res.json({
      ...response,
      nextCursor: nextPosition
        ? cursors.seal("inventory", inventoryCursorScope(input), nextPosition)
        : null,
    });
  });

  router.post("/sessions/transcript", async (req, res) => {
    const input = transcriptSchema.parse(req.body);
    const result = await service.transcript({
      companyId: input.companyId,
      agentId: input.agentId,
      ownerId: input.ownerId,
      installationId: input.installationId,
      profileId: input.profileId,
      externalSessionId: input.externalSessionId,
      limit: input.limit,
      after: input.cursor
        ? cursors.open("transcript", transcriptCursorScope(input), input.cursor)
        : undefined,
    });
    const { nextPosition, ...response } = result;
    res.json({
      ...response,
      nextCursor: nextPosition
        ? cursors.seal("transcript", transcriptCursorScope(input), nextPosition)
        : null,
    });
  });

  return router;
}
