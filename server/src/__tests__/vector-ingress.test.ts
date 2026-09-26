import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  assets,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issues,
  vectorIngressConversations,
  vectorIngressTurns,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { isSecretSensitiveHttpRequest } from "../middleware/http-log-policy.js";
import {
  createVectorIngressCursorCodec,
  isLoopbackRemoteAddress,
  resolveVectorIngressAuthConfig,
  signVectorIngressRequest,
  vectorIngressRoutes,
} from "../routes/vector-ingress.js";
import {
  vectorConversationOwnerId,
  vectorIngressService,
  type VectorIngressHeartbeat,
  type VectorIngressProviderAuthority,
  type VectorIngressToolAuthority,
} from "../services/vector-ingress.js";
import type { VectorRuntimeScope } from "../services/vector-runtime-scope.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { VectorToolAuthorityBridge } from "../services/vector-tool-authority.js";
import type { StorageService } from "../storage/index.js";
import { hydrateVectorIngressImages } from "../services/vector-ingress-image-hydration.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const secret = "vector-ingress-test-secret-with-at-least-32-characters";
const path = "/api/internal/vector/v1/turns";
const runtimeScope = {
  installationId: "t480-engineering",
  profile: "engineering",
  companyId: "12d42db4-38df-5ae1-9b10-204b6f2e5d0c",
  allowedAgentIds: ["e5b45684-168d-51af-9bb4-e9a5d96f6329"],
} as const;

function signedPost(
  app: express.Express,
  requestPath: string,
  body: Record<string, unknown>,
  timestamp = "1700000000",
  signingScope: VectorRuntimeScope = runtimeScope,
) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return request(app)
    .post(requestPath)
    .set("content-type", "application/json")
    .set("x-vector-timestamp", timestamp)
    .set(
      "x-vector-signature",
      signVectorIngressRequest({
        secret,
        scope: signingScope,
        timestamp,
        method: "POST",
        path: requestPath,
        rawBody,
      }),
    )
    .send(rawBody.toString("utf8"));
}

describe("Vector ingress service authentication", () => {
  it("is disabled when no independent secret is configured and fails fast on weak config", () => {
    expect(resolveVectorIngressAuthConfig({})).toBeNull();
    expect(() =>
      resolveVectorIngressAuthConfig({
        PAPERCLIP_VECTOR_INGRESS_SECRET: "too-short",
      }),
    ).toThrow(/at least 32/);
    expect(() => resolveVectorIngressAuthConfig({
      PAPERCLIP_VECTOR_INGRESS_SECRET: secret,
    })).toThrow(/immutable Vector runtime scope/);
    expect(resolveVectorIngressAuthConfig({
      PAPERCLIP_VECTOR_INGRESS_SECRET: secret,
    }, runtimeScope)).toMatchObject({ scope: runtimeScope });
  });

  it("recognizes only direct loopback peers", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("127.20.30.40")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("10.0.0.2")).toBe(false);
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);
    expect(isSecretSensitiveHttpRequest("POST", path)).toBe(true);
  });

  it("accepts an exact-body signature and rejects missing, stale, or changed signatures", async () => {
    const addTurn = vi.fn().mockResolvedValue({ replayed: false, ok: true });
    const inventory = vi.fn().mockResolvedValue({
      companyId: randomUUID(),
      agentId: randomUUID(),
      sessions: [],
      hasMore: true,
      nextPosition: {
        at: "2026-09-25T18:00:00.000Z",
        rank: 0,
        id: "client-session",
      },
    });
    const transcript = vi.fn().mockResolvedValue({
      companyId: randomUUID(),
      agentId: randomUUID(),
      externalSessionId: "client-session",
      events: [],
      hasMore: false,
      nextPosition: null,
    });
    const listBranches = vi.fn().mockResolvedValue({ points: [], branches: [] });
    const forkBranch = vi.fn().mockResolvedValue({ forked: true, text: "prompt" });
    const switchBranch = vi.fn().mockResolvedValue({ switched: true });
    const app = express();
    app.use(
      express.json({
        verify(req, _res, buffer) {
          (req as express.Request & { rawBody?: Buffer }).rawBody = buffer;
        },
      }),
    );
    app.use(
      "/api/internal/vector/v1",
      vectorIngressRoutes({} as never, {
        auth: {
          secret,
          maxClockSkewSeconds: 60,
          responsibleUserId: "local-board",
          scope: runtimeScope,
        },
        service: {
          addTurn,
          reset: vi.fn(),
          cancel: vi.fn(),
          status: vi.fn(),
          events: vi.fn(),
          inventory,
          transcript,
          listBranches,
          forkBranch,
          switchBranch,
        } as never,
        now: () => 1_700_000_000_000,
      }),
    );
    app.use(errorHandler);
    const body = {
      companyId: runtimeScope.companyId,
      agentId: runtimeScope.allowedAgentIds[0],
      externalSessionId: "opaque-thread",
      clientRequestId: "request-1",
      body: "Hello",
    };

    await signedPost(app, path, body).expect(201);
    expect(addTurn).toHaveBeenCalledExactlyOnceWith(body);
    const imageBody = {
      ...body,
      clientRequestId: "request-image",
      images: [{ type: "image", data: "/9j/AA==", mimeType: "image/jpeg" }],
    };
    await signedPost(app, path, imageBody).expect(201);
    expect(addTurn).toHaveBeenLastCalledWith(imageBody);
    await signedPost(app, path, {
      ...imageBody,
      clientRequestId: "request-image-invalid",
      images: [{ type: "image", data: "%%%", mimeType: "image/jpeg" }],
    }).expect(400);
    await signedPost(app, path, {
      ...body,
      clientRequestId: "request-repository-invalid",
      repositoryContext: { schemaVersion: 1, repository: "../escape" },
    }).expect(400);
    await signedPost(app, path, { ...body, externalSessionId: " padded" }).expect(
      400,
    );
    await signedPost(app, path, { ...body, ownerId: "owner-only" }).expect(400);
    expect(addTurn).toHaveBeenCalledTimes(2);
    await request(app).post(path).send(body).expect(401);
    await signedPost(app, path, body, "1699999000").expect(401);
    await request(app)
      .post(path)
      .set("x-vector-timestamp", "1700000000")
      .set("x-vector-signature", "v1=00")
      .send(body)
      .expect(401);

    const inventoryPath = "/api/internal/vector/v1/sessions/list";
    const inventoryBody = {
      companyId: runtimeScope.companyId,
      agentId: runtimeScope.allowedAgentIds[0],
      ownerId: "authenticated-owner",
      installationId: runtimeScope.installationId,
      profileId: runtimeScope.profile,
      limit: 25,
    };
    const inventoryResponse = await signedPost(
      app,
      inventoryPath,
      inventoryBody,
    ).expect(200);
    expect(inventory).toHaveBeenCalledExactlyOnceWith(inventoryBody);
    expect(inventoryResponse.body.nextCursor).toEqual(expect.any(String));
    expect(inventoryResponse.body).not.toHaveProperty("nextPosition");
    await request(app).post(inventoryPath).send(inventoryBody).expect(401);

    const transcriptPath = "/api/internal/vector/v1/sessions/transcript";
    const transcriptBody = {
      ...inventoryBody,
      externalSessionId: "client-session",
    };
    await signedPost(app, transcriptPath, transcriptBody).expect(200);
    expect(transcript).toHaveBeenCalledExactlyOnceWith(transcriptBody);

    const branchBody = {
      companyId: runtimeScope.companyId,
      agentId: runtimeScope.allowedAgentIds[0],
      ownerId: "authenticated-owner",
      installationId: runtimeScope.installationId,
      profileId: runtimeScope.profile,
      externalSessionId: "client-session",
    };
    await signedPost(app, "/api/internal/vector/v1/sessions/branches/list", branchBody).expect(200);
    await signedPost(app, "/api/internal/vector/v1/sessions/branches/fork", {
      ...branchBody, entryId: "prompt-entry",
    }).expect(201);
    const branchId = randomUUID();
    await signedPost(app, "/api/internal/vector/v1/sessions/branches/switch", {
      ...branchBody, branchId,
    }).expect(200);
    expect(listBranches).toHaveBeenCalledExactlyOnceWith(branchBody);
    expect(forkBranch).toHaveBeenCalledExactlyOnceWith({ ...branchBody, entryId: "prompt-entry" });
    expect(switchBranch).toHaveBeenCalledExactlyOnceWith({ ...branchBody, branchId });
    await signedPost(app, "/api/internal/vector/v1/sessions/branches/fork", {
      ...branchBody, entryId: " prompt-entry",
    }).expect(400);
    await signedPost(app, "/api/internal/vector/v1/sessions/branches/switch", {
      ...branchBody, branchId: "/managed/pi/source.jsonl",
    }).expect(400);

    await signedPost(app, path, { ...body, companyId: randomUUID() }).expect(401);
    await signedPost(app, path, { ...body, agentId: randomUUID() }).expect(401);
    await signedPost(app, inventoryPath, {
      ...inventoryBody,
      installationId: "stecke1-standard",
    }).expect(401);
    await signedPost(app, path, body, "1700000000", {
      ...runtimeScope,
      installationId: "stecke1-standard",
    }).expect(401);
    expect(addTurn).toHaveBeenCalledTimes(2);
    expect(inventory).toHaveBeenCalledTimes(1);
  });

  it("keeps opaque cursors restart-stable and rejects tampering or cross-scope reuse", () => {
    const scope = `${randomUUID()}\0${randomUUID()}\0owner-a`;
    const position = {
      at: "2026-09-25T18:00:00.000Z",
      rank: 1 as const,
      id: "42",
    };
    const firstProcess = createVectorIngressCursorCodec(secret);
    const cursor = firstProcess.seal("transcript", scope, position);
    const restartedProcess = createVectorIngressCursorCodec(secret);

    expect(restartedProcess.open("transcript", scope, cursor)).toEqual(position);
    expect(() => restartedProcess.open("inventory", scope, cursor)).toThrow(
      /cursor is invalid/,
    );
    expect(() =>
      restartedProcess.open("transcript", `${scope}\0other-session`, cursor),
    ).toThrow(/cursor is invalid/);
    expect(() =>
      createVectorIngressCursorCodec(`${secret}-rotated`).open(
        "transcript",
        scope,
        cursor,
      ),
    ).toThrow(/cursor is invalid/);
    expect(() =>
      restartedProcess.open(
        "transcript",
        scope,
        cursor.replace(/^v1\./, "v0."),
      ),
    ).toThrow(/cursor is invalid/);

    const issuedAt = 1_700_000_000_000;
    const expired = createVectorIngressCursorCodec(secret, {
      now: () => issuedAt,
      maxAgeSeconds: 60,
    }).seal("inventory", scope, position);
    expect(() =>
      createVectorIngressCursorCodec(secret, {
        now: () => issuedAt + 61_000,
        maxAgeSeconds: 60,
      }).open("inventory", scope, expired),
    ).toThrow(/cursor is invalid/);
    const tamperedParts = cursor.split(".");
    tamperedParts[2] = `${tamperedParts[2]!.startsWith("a") ? "b" : "a"}${tamperedParts[2]!.slice(1)}`;
    expect(() =>
      restartedProcess.open("transcript", scope, tamperedParts.join(".")),
    ).toThrow(/cursor is invalid/);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "Vector ingress conversation mapping",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    let companyId: string;
    let otherCompanyId: string;
    let agentId: string;
    let otherAgentId: string;
    let standardAgentId: string;
    let retiredWorkerAgentId: string;
    let engineeringAgentId: string;
    let heartbeat: VectorIngressHeartbeat;

    beforeAll(async () => {
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-vector-ingress-",
      );
      db = createDb(database.connectionString);
      companyId = randomUUID();
      otherCompanyId = randomUUID();
      agentId = randomUUID();
      otherAgentId = randomUUID();
      standardAgentId = randomUUID();
      retiredWorkerAgentId = randomUUID();
      engineeringAgentId = randomUUID();
      await db.insert(companies).values([
        {
          id: companyId,
          name: "Vector",
          issuePrefix: "VEC",
          requireBoardApprovalForNewAgents: false,
        },
        {
          id: otherCompanyId,
          name: "Other",
          issuePrefix: "OTH",
          requireBoardApprovalForNewAgents: false,
        },
      ]);
      await db.insert(agents).values([
        {
          id: agentId,
          companyId,
          name: "Funky",
          role: "funky-scout",
          status: "idle",
          adapterType: "process",
          metadata: {
            vectorProvisioning: {
              schemaVersion: 1,
              installationId: "stg1-staging",
              profile: "staging",
            },
            vectorWorkloads: {
              schemaVersion: 1,
              keys: ["current_scout"],
              contracts: [{
                key: "current_scout",
                kind: "research_task",
                executionShape: "single_shot",
                role: "funky-scout",
                toolSurface: [],
                modelPolicy: null,
                runtimeAuthority: "vector_lease_triple",
              }],
            },
          },
        },
        {
          id: otherAgentId,
          companyId,
          name: "Scout",
          role: "assistant",
          status: "idle",
          adapterType: "process",
        },
        {
          id: standardAgentId,
          companyId,
          name: "Standard Chat",
          role: "standard-chat",
          status: "idle",
          adapterType: "pi_local",
          adapterConfig: { model: "router/Qwen3.8-Flash" },
          metadata: {
            vectorProvisioning: {
              schemaVersion: 1,
              installationId: "stecke1-standard",
              profile: "standard",
            },
          },
        },
        {
          // A roster member dropped by a newer Standard manifest revision is
          // retired (terminated) by provisioning and must never be selected.
          id: retiredWorkerAgentId,
          companyId,
          name: "Implementation Worker",
          role: "implementation-worker",
          status: "terminated",
          adapterType: "pi_local",
          adapterConfig: { model: "router/Qwen3.8-Flash" },
          metadata: {
            vectorProvisioning: {
              schemaVersion: 1,
              installationId: "stecke1-standard",
              profile: "standard",
            },
          },
        },
        {
          id: engineeringAgentId,
          companyId,
          name: "FunkyDev",
          role: "engineer",
          status: "idle",
          adapterType: "pi_local",
          adapterConfig: { model: "router/Qwen3.8-Flash" },
          metadata: {
            vectorProvisioning: {
              schemaVersion: 1,
              installationId: "t480-engineering",
              profile: "engineering",
            },
          },
        },
      ]);
      await instanceSettingsService(db).updateExperimental({
        enableAgentChat: true,
      });

      heartbeat = {
        wakeup: async (targetAgentId, options) => {
          const existing = await db
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, companyId),
                eq(
                  agentWakeupRequests.idempotencyKey,
                  options.idempotencyKey ?? "",
                ),
              ),
            )
            .then((rows) => rows[0] ?? null);
          if (existing?.runId) {
            return db
              .select()
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, existing.runId))
              .then((rows) => rows[0] ?? null);
          }
          const [wake] = await db
            .insert(agentWakeupRequests)
            .values({
              companyId,
              agentId: targetAgentId,
              source: options.source ?? "on_demand",
              triggerDetail: options.triggerDetail ?? null,
              reason: options.reason ?? null,
              payload: options.payload ?? null,
              status: "queued",
              requestedByActorType: options.requestedByActorType ?? null,
              requestedByActorId: options.requestedByActorId ?? null,
              idempotencyKey: options.idempotencyKey ?? null,
            })
            .returning();
          const [run] = await db
            .insert(heartbeatRuns)
            .values({
              companyId,
              agentId: targetAgentId,
              status: "queued",
              wakeupRequestId: wake.id,
              contextSnapshot: options.contextSnapshot ?? null,
            })
            .returning();
          await db
            .update(agentWakeupRequests)
            .set({ runId: run.id })
            .where(eq(agentWakeupRequests.id, wake.id));
          return run;
        },
        cancelRun: async (runId, reason, options) => {
          return db
            .update(heartbeatRuns)
            .set({
              status: "cancelled",
              error: reason,
              errorCode: options?.errorCode ?? null,
              resultJson: options?.resultJson ?? null,
              finishedAt: new Date(),
            })
            .where(eq(heartbeatRuns.id, runId))
            .returning()
            .then((rows) => rows[0] ?? null);
        },
      } as VectorIngressHeartbeat;
    }, 90_000);

    afterAll(async () => {
      await db?.$client.end({ timeout: 0 });
      await database?.cleanup();
    });

    it("maps independent Vector threads and agents to independent Paperclip conversations", async () => {
      const service = vectorIngressService(db, { heartbeat });
      const base = { companyId, agentId };
      const first = await service.addTurn({
        ...base,
        externalSessionId: "thread-a",
        clientRequestId: "thread-a-1",
        body: "First thread",
      });
      const second = await service.addTurn({
        ...base,
        externalSessionId: "thread-b",
        clientRequestId: "thread-b-1",
        body: "Second thread",
      });
      const otherAgent = await service.addTurn({
        companyId,
        agentId: otherAgentId,
        externalSessionId: "thread-a",
        clientRequestId: "other-agent-1",
        body: "Same opaque identity, different agent",
      });
      expect(new Set([first.issueId, second.issueId, otherAgent.issueId]).size).toBe(3);
      const rows = await db
        .select({
          id: issues.id,
          conversationUserId: issues.conversationUserId,
        })
        .from(issues)
        .where(eq(issues.companyId, companyId));
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.conversationUserId).join(" ")).not.toContain(
        "thread-a",
      );
      expect(
        rows.find((row) => row.id === first.issueId)?.conversationUserId,
      ).toBe(
        vectorConversationOwnerId({
          companyId,
          agentId,
          externalSessionId: "thread-a",
        }),
      );
    });

    it("replays an identical client request and conflicts on changed content or attachments", async () => {
      const service = vectorIngressService(db, { heartbeat });
      const input = {
        companyId,
        agentId,
        externalSessionId: "idempotent-thread",
        clientRequestId: "same-request",
        body: "Do this once",
      };
      const first = await service.addTurn(input);
      const replay = await service.addTurn(input);
      expect(replay).toMatchObject({
        issueId: first.issueId,
        commentId: first.commentId,
        runId: first.runId,
        replayed: true,
      });
      await expect(
        service.addTurn({ ...input, body: "Different content" }),
      ).rejects.toMatchObject({
        status: 409,
        details: { code: "vector_ingress_idempotency_conflict" },
      });

      const [asset] = await db
        .insert(assets)
        .values({
          companyId,
          provider: "local_disk",
          objectKey: `test/${randomUUID()}`,
          contentType: "text/plain",
          byteSize: 4,
          sha256: "a".repeat(64),
        })
        .returning();
      const [attachment] = await db
        .insert(issueAttachments)
        .values({
          companyId,
          issueId: first.issueId,
          assetId: asset.id,
        })
        .returning();
      await expect(
        service.addTurn({ ...input, attachmentIds: [attachment.id] }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("stores image turns once, binds ownership, and projects metadata without bytes", async () => {
      const objects = new Map<string, Buffer>();
      let puts = 0;
      const storage = {
        provider: "local_disk",
        async putFile(input: { companyId: string; namespace: string; originalFilename: string | null; contentType: string; body: Buffer }) {
          puts += 1;
          const objectKey = `${input.companyId}/${input.namespace}/${puts}`;
          objects.set(objectKey, input.body);
          return {
            provider: "local_disk", objectKey, contentType: input.contentType,
            byteSize: input.body.length,
            sha256: (await import("node:crypto")).createHash("sha256").update(input.body).digest("hex"),
            originalFilename: input.originalFilename,
          };
        },
        async getObject(readCompanyId: string, objectKey: string) {
          if (!objectKey.startsWith(`${readCompanyId}/`)) throw new Error("foreign company");
          return { stream: Readable.from([objects.get(objectKey)!]) };
        },
        async headObject() { return { exists: true }; },
        async deleteObject() {},
      } as StorageService;
      const service = vectorIngressService(db, { heartbeat, storage });
      const input = {
        companyId,
        agentId,
        ownerId: "image-owner",
        installationId: "stg1-staging",
        profileId: "staging",
        externalSessionId: "image-thread",
        clientRequestId: "image-turn-1",
        body: "Describe this image",
        images: [{ type: "image" as const, data: "/9j/AA==", mimeType: "image/jpeg" as const }],
      };
      const first = await service.addTurn(input);
      const replay = await service.addTurn(input);
      expect(replay).toMatchObject({ commentId: first.commentId, replayed: true });
      expect(puts).toBe(1);
      const attachments = await db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          commentId: issueAttachments.issueCommentId,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
        .where(eq(issueAttachments.issueCommentId, first.commentId));
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toMatchObject({ companyId, issueId: first.issueId, commentId: first.commentId, contentType: "image/jpeg", byteSize: 4 });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.runId!));
      expect(run?.contextSnapshot).toMatchObject({ vectorIngressImageAttachmentIds: [attachments[0]!.id] });
      expect(JSON.stringify(run?.contextSnapshot)).not.toContain("/9j/AA==");
      await expect(hydrateVectorIngressImages({
        db, storage, companyId, issueId: first.issueId, commentId: first.commentId,
        attachmentIds: [attachments[0]!.id],
      })).resolves.toEqual(input.images);
      await expect(hydrateVectorIngressImages({
        db, storage, companyId, issueId: first.issueId, commentId: randomUUID(),
        attachmentIds: [attachments[0]!.id],
      })).rejects.toThrow(/ownership mismatch/);

      const transcript = await service.transcript({
        companyId, agentId, ownerId: input.ownerId, installationId: input.installationId,
        profileId: input.profileId, externalSessionId: input.externalSessionId,
      });
      const userTurn = transcript.events.find((event) => event.eventType === "user_turn");
      expect(userTurn?.payload).toMatchObject({
        text: input.body,
        images: [{ attachmentId: attachments[0]!.id, mimeType: "image/jpeg", byteSize: 4 }],
      });
      expect(JSON.stringify(userTurn)).not.toContain("/9j/AA==");

      await expect(service.addTurn({ ...input, images: [{ ...input.images[0], data: "/9j/AQ==" }] }))
        .rejects.toMatchObject({ status: 409, details: { code: "vector_ingress_idempotency_conflict" } });
    });

    it("persists only pending authority scope before wakeup and confirms the created run", async () => {
      const commentMarker = {
        version: 1 as const,
        handleSha256: "a".repeat(64),
        sessionScope: "session-scope",
        commentId: "filled-by-register",
      };
      const registerPending = vi.fn((input: { commentId: string }) => ({
        ...commentMarker,
        commentId: input.commentId,
      }));
      const bindRun = vi.fn().mockResolvedValue(undefined);
      const toolAuthority = { registerPending, bindRun } as unknown as VectorIngressToolAuthority;
      const service = vectorIngressService(db, { heartbeat, toolAuthority });
      const result = await service.addTurn({
        companyId,
        agentId,
        externalSessionId: "authority-thread",
        clientRequestId: "authority-turn",
        body: "Use my memory",
        authorityHandle: "opaque-vector-handle",
        authorityTools: ["memory_search"],
      });
      expect(registerPending).toHaveBeenCalledWith(expect.objectContaining({
        companyId,
        agentId,
        issueId: result.issueId,
        commentId: result.commentId,
        authorityHandle: "opaque-vector-handle",
        allowedTools: ["memory_search"],
      }));
      expect(bindRun).toHaveBeenCalledWith(expect.objectContaining({
        companyId,
        agentId,
        issueId: result.issueId,
        runId: result.runId,
        authorityHandle: "opaque-vector-handle",
      }));
      const context = await db.select({ value: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, result.runId!))
        .then((rows) => rows[0]?.value);
      expect(context?.vectorToolAuthorityPending).toEqual({
        ...commentMarker,
        commentId: result.commentId,
      });
      expect(JSON.stringify(context)).not.toContain("opaque-vector-handle");
    });

    it("persists only a provider marker and never the opaque provider handle", async () => {
      const commentMarker = {
        version: 1 as const,
        handleSha256: "b".repeat(64),
        sessionScope: "provider-session-scope",
        commentId: "filled-by-register",
      };
      const registerPending = vi.fn((input: { commentId: string }) => ({
        ...commentMarker,
        commentId: input.commentId,
      }));
      const bindRun = vi.fn().mockResolvedValue(undefined);
      const providerAuthority = { registerPending, bindRun } as unknown as VectorIngressProviderAuthority;
      const service = vectorIngressService(db, { heartbeat, providerAuthority });
      const result = await service.addTurn({
        companyId,
        agentId,
        externalSessionId: "provider-authority-thread",
        clientRequestId: "provider-authority-turn",
        body: "Use the delegated model route",
        providerAuthorityHandle: "opaque-provider-authority-handle",
      });
      expect(registerPending).toHaveBeenCalledWith(expect.objectContaining({
        companyId,
        agentId,
        issueId: result.issueId,
        commentId: result.commentId,
        authorityHandle: "opaque-provider-authority-handle",
      }));
      expect(bindRun).toHaveBeenCalledWith(expect.objectContaining({
        companyId,
        agentId,
        issueId: result.issueId,
        runId: result.runId,
        authorityHandle: "opaque-provider-authority-handle",
      }));
      const context = await db.select({ value: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, result.runId!))
        .then((rows) => rows[0]?.value);
      expect(context?.vectorProviderAuthorityPending).toEqual({
        ...commentMarker,
        commentId: result.commentId,
      });
      expect(JSON.stringify(context)).not.toContain("opaque-provider-authority-handle");
    });

    it("replays one client request only with the same authority handle", async () => {
      const toolAuthority = new VectorToolAuthorityBridge(db, {
        endpoint: new URL("http://127.0.0.1:32160/inbound/paperclip/v1/tools/call"),
        callbackUrl: new URL("http://127.0.0.1:3100/api/internal/vector/v1/tools/callback"),
        installationId: "test-installation",
        profile: "standard",
        secret: "vector-tool-authority-test-secret-32-plus",
        allowedTools: ["memory_search"],
        ttlSeconds: 3600,
      }, vi.fn());
      const service = vectorIngressService(db, { heartbeat, toolAuthority });
      const input = {
        companyId,
        agentId,
        externalSessionId: "authority-replay-thread",
        clientRequestId: "authority-replay-turn",
        body: "Search memory once",
        authorityHandle: "opaque-authority-replay-handle",
        authorityTools: ["memory_search"],
      };
      const first = await service.addTurn(input);
      await expect(service.addTurn(input)).resolves.toMatchObject({
        issueId: first.issueId,
        commentId: first.commentId,
        runId: first.runId,
        replayed: true,
      });
      await expect(service.addTurn({
        ...input,
        authorityHandle: "different-authority-handle",
      })).rejects.toMatchObject({
        status: 409,
        details: { code: "vector_tool_authority_scope_conflict" },
      });
    });

    it("admits exact provisioned workload context and binds it to the queued run", async () => {
      const service = vectorIngressService(db, { heartbeat });
      const launchContext = {
        schemaVersion: 1 as const,
        workloadKey: "current_scout",
        queue: "research" as const,
        taskId: "research-task-1",
        attempt: 2,
        leaseTokenSha256: "a".repeat(64),
        role: "funky-scout",
        model: "",
        tools: [] as string[],
        noBuiltinTools: true,
        systemPrompt: "Use the current Vector charter and cite every claim.",
        metadata: { task_id: "research-task-1", attempt: "2", run_kind: "current_scout" },
      };
      const input = {
        companyId,
        agentId,
        externalSessionId: "workload-current-1",
        ownerId: "vector-workload:research-task-1",
        installationId: "stg1-staging",
        profileId: "staging",
        clientRequestId: "research-task-1-attempt-2",
        body: "Analyze the database-provided evidence envelope.",
        launchContext,
      };
      const turn = await service.addTurn(input);
      const commentBody = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.id, turn.commentId))
        .then((rows) => rows[0]?.body);
      expect(commentBody).toContain("[VECTOR_WORKLOAD_LAUNCH_V1]");
      expect(commentBody).toContain(launchContext.systemPrompt);
      const runContext = await db
        .select({ context: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, turn.runId!))
        .then((rows) => rows[0]?.context as Record<string, unknown>);
      expect(runContext.vectorWorkloadLaunch).toEqual(launchContext);

      await expect(service.addTurn({
        ...input,
        externalSessionId: "workload-current-escalated",
        clientRequestId: "research-task-1-escalated",
        launchContext: { ...launchContext, tools: ["bash"] },
      })).rejects.toMatchObject({
        status: 409,
        details: { code: "vector_workload_contract_mismatch" },
      });
    });

    it("admits a trusted staging role turn and rejects role escalation", async () => {
      const service = vectorIngressService(db, { heartbeat });
      const roleContext = {
        schemaVersion: 1 as const,
        role: "funky-scout",
        model: "",
        noBuiltinTools: true as const,
        systemPrompt: "Use the current Vector analyst charter.",
        metadata: { persona_version: "persona-v1", run_kind: "title" },
      };
      const input = {
        companyId,
        agentId,
        externalSessionId: "trusted-role-session",
        ownerId: "vector-user:user-1",
        installationId: "stg1-staging",
        profileId: "staging",
        clientRequestId: "trusted-role-turn-1",
        body: "Name this conversation.",
        roleContext,
      };
      const turn = await service.addTurn(input);
      const runContext = await db
        .select({ context: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, turn.runId!))
        .then((rows) => rows[0]?.context as Record<string, unknown>);
      expect(runContext.vectorRoleTurn).toEqual(roleContext);

      await expect(service.addTurn({
        ...input,
        externalSessionId: "trusted-role-escalated",
        clientRequestId: "trusted-role-turn-escalated",
        roleContext: { ...roleContext, role: "funky-advisor" },
      })).rejects.toMatchObject({
        status: 409,
        details: { code: "vector_role_contract_mismatch" },
      });
      await expect(service.addTurn({
        ...input,
        externalSessionId: "trusted-role-tool-widening",
        clientRequestId: "trusted-role-turn-tool-widening",
        roleContext: { ...roleContext, noBuiltinTools: false },
      })).rejects.toMatchObject({
        status: 409,
        details: { code: "vector_role_contract_mismatch" },
      });
    });

    it("persists an admitted standard persona without copying its prompt into comments", async () => {
      const service = vectorIngressService(db, { heartbeat });
      const personaContext = {
        schemaVersion: 1 as const,
        personaId: "00000000-0000-0000-0000-000000000023",
        personaName: "Sage",
        personaVersion: "abcdef012345",
        model: "router/Qwen3.8-Flash",
        noBuiltinTools: true as const,
        systemPrompt: "Be a calm, precise collaborator.",
      };
      const base = {
        companyId,
        agentId: standardAgentId,
        externalSessionId: "standard-persona-session",
        ownerId: "vector-user:user-1",
        installationId: "stecke1-standard",
        profileId: "standard",
      };
      const first = await service.addTurn({
        ...base,
        clientRequestId: "standard-persona-turn-1",
        body: "Hello there.",
        voiceActive: true,
        personaContext,
      });
      expect(first.turnId).toBeGreaterThan(0);
      expect(first.baseCursor).toBe(0);
      const replay = await service.addTurn({
        ...base,
        clientRequestId: "standard-persona-turn-1",
        body: "Hello there.",
        voiceActive: true,
        personaContext,
        baseCursor: 99,
      });
      expect(replay.replayed).toBe(true);
      expect(replay.turnId).toBe(first.turnId);
      expect(replay.baseCursor).toBe(first.baseCursor);
      const targeted = await service.events({ ...base, turnId: first.turnId, afterSeq: first.baseCursor });
      expect(targeted.turnId).toBe(first.turnId);
      expect(targeted.run?.id).toBe(first.runId);
      await expect(service.events({ ...base, ownerId: "vector-user:user-2", turnId: first.turnId }))
        .rejects.toMatchObject({ status: 404 });
      const firstRun = await db
        .select({ context: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, first.runId!))
        .then((rows) => rows[0]?.context as Record<string, unknown>);
      expect(firstRun.vectorPersonaTurn).toEqual(personaContext);
      expect(firstRun.vectorRuntimeSelection).toEqual({ model: "Qwen3.8-Flash", thinking: "medium" });
      expect(firstRun.vectorVoiceActive).toBe(true);
      const firstComment = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.id, first.commentId))
        .then((rows) => rows[0]?.body);
      expect(firstComment).toBe("Hello there.");
      expect(firstComment).not.toContain(personaContext.systemPrompt);

      const second = await service.addTurn({
        ...base,
        clientRequestId: "standard-persona-turn-2",
        body: "Continue.",
      });
      const secondRun = await db
        .select({ context: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, second.runId!))
        .then((rows) => rows[0]?.context as Record<string, unknown>);
      expect(secondRun.vectorPersonaTurn).toEqual(personaContext);
      expect(secondRun.vectorVoiceActive).toBe(false);

      const configured = await service.configureRuntime({
        ...base, model: "Other-Model", thinking: "high",
      });
      expect(configured).toMatchObject({ model: "Other-Model", thinking: "high" });
      const third = await service.addTurn({
        ...base, clientRequestId: "standard-persona-turn-runtime", body: "Use it.",
      });
      const thirdRun = await db.select({ context: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, third.runId!))
        .then((rows) => rows[0]?.context as Record<string, unknown>);
      expect(thirdRun.vectorRuntimeSelection).toEqual({ model: "Other-Model", thinking: "high" });

      await expect(service.addTurn({
        ...base,
        clientRequestId: "standard-persona-turn-3",
        body: "Switch persona.",
        personaContext: { ...personaContext, personaName: "Different" },
      })).rejects.toMatchObject({
        status: 409,
        details: { code: "vector_persona_continuity_mismatch" },
      });
    });

    it("runs a standard todo launch as an ordinary standard-chat turn bound to that todo", async () => {
      const todoTools = ["todo_add", "todo_list", "todo_mark_done", "todo_update"];
      const toolAuthority = new VectorToolAuthorityBridge(db, {
        endpoint: new URL("http://127.0.0.1:32160/inbound/paperclip/v1/tools/call"),
        callbackUrl: new URL("http://127.0.0.1:3100/api/internal/vector/v1/tools/callback"),
        installationId: "stecke1-standard",
        profile: "standard",
        secret: "vector-tool-authority-test-secret-32-plus",
        allowedTools: ["ask_user", "memory_forget", "memory_save", "memory_search", ...todoTools, "speak"],
        ttlSeconds: 3600,
      }, vi.fn());
      const service = vectorIngressService(db, { heartbeat, toolAuthority });
      const personaContext = {
        schemaVersion: 1 as const,
        personaId: "00000000-0000-0000-0000-000000000024",
        personaName: "Sage",
        personaVersion: "abcdef012346",
        model: "router/Qwen3.8-Flash",
        noBuiltinTools: true as const,
        systemPrompt: "Be a calm, precise collaborator.",
      };
      const launch = {
        companyId,
        agentId: standardAgentId,
        externalSessionId: "todo-d757f88d-7062-4e72-939e-f6230cfcad7a-7d19e3e8f8b157f7fbc63f7dc789832a",
        ownerId: "vector-user:user-3",
        installationId: "stecke1-standard",
        profileId: "standard",
        clientRequestId: "todo-launch-d757f88d-7062-4e72-939e-f6230cfcad7a",
        body: "Todo brief: draft the requested answer.",
        personaContext,
        authorityHandle: "opaque-todo-d757f88d-authority",
        authorityTools: todoTools,
      };
      const turn = await service.addTurn(launch);
      expect(turn.runId).toBeTruthy();
      const runContext = await db.select({ context: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, turn.runId!))
        .then((rows) => rows[0]?.context as Record<string, unknown>);
      expect(runContext.vectorRoleTurn).toBeUndefined();
      expect(runContext.vectorPersonaTurn).toEqual(personaContext);
      expect(JSON.stringify(runContext)).not.toContain(launch.authorityHandle);
      const commentBody = await db.select({ body: issueComments.body })
        .from(issueComments).where(eq(issueComments.id, turn.commentId))
        .then((rows) => rows[0]?.body);
      expect(commentBody).toBe(launch.body);

      // Idempotent: the same launch replays; a different todo authority on it is refused.
      await expect(service.addTurn(launch)).resolves.toMatchObject({
        issueId: turn.issueId, commentId: turn.commentId, runId: turn.runId, replayed: true,
      });
      await expect(service.addTurn({ ...launch, authorityHandle: "opaque-other-todo-authority" }))
        .rejects.toMatchObject({ status: 409, details: { code: "vector_tool_authority_scope_conflict" } });

      // Durable binding: the todo session keeps one conversation and its persona.
      const mappings = await db.select().from(vectorIngressConversations)
        .where(eq(vectorIngressConversations.externalSessionId, launch.externalSessionId));
      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toMatchObject({
        issueId: turn.issueId, agentId: standardAgentId, profileId: "standard", sessionRole: null,
      });
      const { personaContext: _persona, authorityHandle: _handle, authorityTools: _tools, ...scope } = launch;
      await expect(service.status(scope)).resolves.toMatchObject({ issueId: turn.issueId, sessionRole: null });
    });

    it("rejects every todo role turn on standard and never selects a retired agent", async () => {
      const service = vectorIngressService(db, { heartbeat });
      const retiredRoleContext = {
        schemaVersion: 1 as const,
        role: "implementation-worker",
        model: "router/Qwen3.8-Flash",
        noBuiltinTools: true as const,
        systemPrompt: "You are executing one authenticated NexusLink todo brief.",
        metadata: {
          todo_id: "b757f88d-7062-4e72-939e-f6230cfcad7a",
          launch_mode: "scoped",
          launch_digest: "8d19e3e8f8b157f7fbc63f7dc789832a",
        },
      };
      const base = {
        companyId,
        agentId: standardAgentId,
        externalSessionId: "todo-b757f88d-7062-4e72-939e-f6230cfcad7a-8d19e3e8f8b157f7fbc63f7dc789832a",
        ownerId: "vector-user:user-1",
        installationId: "stecke1-standard",
        profileId: "standard",
        clientRequestId: "todo-launch-b757f88d-7062-4e72-939e-f6230cfcad7a",
        body: "Prepare the requested answer.",
        runtimeSelection: { model: "Qwen3.8-Flash", thinking: "medium" as const },
      };
      // A role other than the agent's own role is rejected.
      await expect(service.addTurn({ ...base, roleContext: retiredRoleContext }))
        .rejects.toMatchObject({ status: 409, details: { code: "vector_role_contract_mismatch" } });
      // Even the agent's own role: standard has no role-turn (todo) surface.
      await expect(service.addTurn({
        ...base,
        clientRequestId: "todo-launch-own-role",
        roleContext: { ...retiredRoleContext, role: "standard-chat" },
      })).rejects.toMatchObject({ status: 409, details: { code: "vector_role_contract_mismatch" } });
      // Without a persona the standard turn is refused rather than run as a worker.
      await expect(service.addTurn({ ...base, clientRequestId: "todo-launch-no-persona" }))
        .rejects.toMatchObject({ status: 409, details: { code: "vector_persona_required" } });

      const retired = {
        ...base,
        agentId: retiredWorkerAgentId,
        externalSessionId: "retired-worker-session",
        clientRequestId: "retired-worker-turn",
      };
      await expect(service.addTurn(retired))
        .rejects.toMatchObject({ status: 409, details: { code: "vector_ingress_agent_unavailable" } });
      await expect(service.addTurn({ ...retired, roleContext: retiredRoleContext }))
        .rejects.toMatchObject({ status: 409, details: { code: "vector_ingress_agent_unavailable" } });
      await expect(service.configureRuntime({
        companyId,
        agentId: retiredWorkerAgentId,
        externalSessionId: retired.externalSessionId,
        ownerId: retired.ownerId,
        installationId: retired.installationId,
        profileId: retired.profileId,
        model: "Other-Model",
        thinking: "medium",
      })).rejects.toMatchObject({ status: 409 });
    });

    it("runs an engineering todo launch as an ordinary FunkyDev pi turn", async () => {
      const service = vectorIngressService(db, { heartbeat });
      const plain = {
        companyId,
        agentId: engineeringAgentId,
        externalSessionId: "engineering-browser-chat",
        ownerId: "vector-user:engineer-1",
        installationId: "t480-engineering",
        profileId: "engineering",
        clientRequestId: "engineering-browser-chat-1",
        body: "Keep the configured FunkyDev runtime.",
      };
      await expect(service.addTurn(plain)).resolves.toMatchObject({ replayed: false });
      await expect(service.status(plain)).resolves.toMatchObject({ sessionRole: "pi", repository: null });
      const base = {
        companyId,
        agentId: engineeringAgentId,
        externalSessionId: "todo-c757f88d-7062-4e72-939e-f6230cfcad7a-9d19e3e8f8b157f7fbc63f7dc789832a",
        ownerId: "vector-user:engineer-1",
        installationId: "t480-engineering",
        profileId: "engineering",
        clientRequestId: "engineering-todo-launch",
        body: "Todo brief: implement the bounded change.",
        repositoryContext: { schemaVersion: 1 as const, repository: "renegadesw/vector" },
        runtimeSelection: { model: "Qwen3.8-Flash", thinking: "high" as const },
      };
      const turn = await service.addTurn(base);
      const runContext = await db.select({ context: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, turn.runId!))
        .then((rows) => rows[0]?.context as Record<string, unknown>);
      expect(runContext.vectorRoleTurn).toBeUndefined();
      expect(runContext.vectorRuntimeSelection).toEqual(base.runtimeSelection);
      const commentBody = await db.select({ body: issueComments.body })
        .from(issueComments).where(eq(issueComments.id, turn.commentId))
        .then((rows) => rows[0]?.body);
      expect(commentBody).toBe(base.body);
      await expect(service.status(base)).resolves.toMatchObject({
        sessionRole: "pi",
        repository: "renegadesw/vector",
      });
      await expect(service.addTurn({
        ...base,
        clientRequestId: "engineering-todo-repository-drift",
        repositoryContext: { schemaVersion: 1, repository: "renegadesw/other" },
      })).rejects.toMatchObject({
        status: 409,
        details: { code: "vector_ingress_session_binding_mismatch" },
      });

      const retiredAlias = {
        schemaVersion: 1 as const,
        role: "implementation-worker",
        model: "router/Qwen3.8-Flash",
        noBuiltinTools: false,
        systemPrompt: "You are executing one authenticated NexusLink todo brief.",
        metadata: {
          todo_id: "c757f88d-7062-4e72-939e-f6230cfcad7a",
          launch_mode: "scoped",
          launch_digest: "9d19e3e8f8b157f7fbc63f7dc789832a",
        },
      };
      await expect(service.addTurn({
        ...base,
        externalSessionId: "engineering-retired-alias",
        clientRequestId: "engineering-retired-alias",
        roleContext: retiredAlias,
      })).rejects.toMatchObject({ status: 409, details: { code: "vector_role_contract_mismatch" } });
      await expect(service.addTurn({
        ...base,
        externalSessionId: "engineering-own-role-context",
        clientRequestId: "engineering-own-role-context",
        roleContext: { ...retiredAlias, role: "engineer", noBuiltinTools: true },
      })).rejects.toMatchObject({ status: 409, details: { code: "vector_role_contract_mismatch" } });

      // A conversation bound to the retired alias before this change is never resumed.
      await db.update(vectorIngressConversations)
        .set({ sessionRole: "implementation-worker" })
        .where(eq(vectorIngressConversations.externalSessionId, base.externalSessionId));
      await expect(service.addTurn({ ...base, clientRequestId: "engineering-legacy-alias-resume" }))
        .rejects.toMatchObject({ status: 409, details: { code: "vector_ingress_session_binding_mismatch" } });
      await db.update(vectorIngressConversations)
        .set({ sessionRole: "pi" })
        .where(eq(vectorIngressConversations.externalSessionId, base.externalSessionId));

      await expect(service.configureRuntime({
        companyId,
        agentId: engineeringAgentId,
        externalSessionId: base.externalSessionId,
        ownerId: base.ownerId,
        installationId: base.installationId,
        profileId: base.profileId,
        model: "Other-Model",
        thinking: "medium",
      })).resolves.toMatchObject({ model: "Other-Model", thinking: "medium" });
    });

    it("fails standard persona turns closed on omission and provider widening", async () => {
      const service = vectorIngressService(db, { heartbeat });
      const base = {
        companyId,
        agentId: standardAgentId,
        ownerId: "vector-user:user-2",
        installationId: "stecke1-standard",
        profileId: "standard",
        body: "Hello.",
      };
      await expect(service.addTurn({
        ...base,
        externalSessionId: "standard-persona-missing",
        clientRequestId: "standard-persona-missing-1",
      })).rejects.toMatchObject({
        status: 409,
        details: { code: "vector_persona_required" },
      });
      await expect(service.addTurn({
        ...base,
        externalSessionId: "standard-persona-model-drift",
        clientRequestId: "standard-persona-model-drift-1",
        personaContext: {
          schemaVersion: 1,
          personaId: "00000000-0000-0000-0000-000000000023",
          personaName: "Sage",
          personaVersion: "abcdef012345",
          model: "other/unapproved-model",
          noBuiltinTools: true,
          systemPrompt: "Be a calm, precise collaborator.",
        },
      })).rejects.toMatchObject({
        status: 409,
        details: { code: "vector_persona_contract_mismatch" },
      });
    });

    it("binds existing same-issue attachments and rejects foreign issue attachments", async () => {
      const service = vectorIngressService(db, { heartbeat });
      const seed = await service.addTurn({
        companyId,
        agentId,
        externalSessionId: "attachment-thread",
        clientRequestId: "attachment-seed",
        body: "Seed",
      });
      const foreign = await service.addTurn({
        companyId,
        agentId,
        externalSessionId: "attachment-foreign",
        clientRequestId: "attachment-foreign-seed",
        body: "Foreign seed",
      });
      const [asset] = await db
        .insert(assets)
        .values({
          companyId,
          provider: "local_disk",
          objectKey: `test/${randomUUID()}`,
          contentType: "text/plain",
          byteSize: 4,
          sha256: "b".repeat(64),
        })
        .returning();
      const [attachment] = await db
        .insert(issueAttachments)
        .values({
          companyId,
          issueId: seed.issueId,
          assetId: asset.id,
        })
        .returning();
      const bound = await service.addTurn({
        companyId,
        agentId,
        externalSessionId: "attachment-thread",
        clientRequestId: "attachment-turn",
        body: "Use the attachment",
        attachmentIds: [attachment.id],
      });
      expect(
        await db
          .select({ commentId: issueAttachments.issueCommentId })
          .from(issueAttachments)
          .where(eq(issueAttachments.id, attachment.id))
          .then((rows) => rows[0]?.commentId),
      ).toBe(bound.commentId);
      await expect(
        service.addTurn({
          companyId,
          agentId,
          externalSessionId: "attachment-foreign",
          clientRequestId: "foreign-attachment-turn",
          body: "Try foreign attachment",
          attachmentIds: [attachment.id],
        }),
      ).rejects.toMatchObject({ status: 422 });
      expect(foreign.issueId).not.toBe(seed.issueId);
    });

    it("scopes cancellation and reset to the exact conversation owner", async () => {
      const service = vectorIngressService(db, { heartbeat });
      const a = {
        companyId,
        agentId,
        externalSessionId: "control-a",
      };
      const b = {
        companyId,
        agentId,
        externalSessionId: "control-b",
      };
      const turnA = await service.addTurn({
        ...a,
        clientRequestId: "control-a-1",
        body: "Run A",
      });
      const turnB = await service.addTurn({
        ...b,
        clientRequestId: "control-b-1",
        body: "Run B",
      });
      await expect(service.cancel({ ...a, runId: turnB.runId! })).rejects.toMatchObject({
        status: 409,
        details: { code: "vector_ingress_run_scope_mismatch" },
      });
      expect(
        await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, turnB.runId!))
          .then((rows) => rows[0]?.status),
      ).toBe("queued");
      await expect(service.cancel({ ...a, runId: turnA.runId! })).resolves.toMatchObject({
        issueId: turnA.issueId,
        runId: turnA.runId,
        cancelled: true,
      });
      const reset = await service.reset({
        ...a,
        clientRequestId: "control-a-reset",
      });
      expect(reset.issueId).toBe(turnA.issueId);
      expect(
        await db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(eq(issueComments.id, reset.commentId))
          .then((rows) => rows[0]?.body),
      ).toBe("/new");
      expect(
        await db
          .select({ count: issueComments.id })
          .from(issueComments)
          .where(eq(issueComments.issueId, turnB.issueId)),
      ).toHaveLength(1);
      await expect(
        service.cancel({
          companyId: otherCompanyId,
          agentId,
          externalSessionId: "control-a",
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("reads only the scoped conversation's latest run and durable events", async () => {
      const service = vectorIngressService(db, { heartbeat });
      const scope = {
        companyId,
        agentId,
        externalSessionId: "read-thread",
      };
      const turn = await service.addTurn({
        ...scope,
        clientRequestId: "read-thread-1",
        body: "Read this run",
      });
      const other = await service.addTurn({
        companyId,
        agentId,
        externalSessionId: "read-other-thread",
        clientRequestId: "read-other-thread-1",
        body: "Do not leak this run",
      });
      await db.insert(heartbeatRunEvents).values([
        {
          companyId,
          agentId,
          runId: turn.runId!,
          seq: 1,
          eventType: "assistant_delta",
          message: "hello",
          payload: {
            text: "hello",
            delta: "hello",
            internalSecret: "must-not-cross-ingress",
          },
        },
        {
          companyId,
          agentId,
          runId: turn.runId!,
          seq: 2,
          eventType: "agent_settled",
          message: "settled",
          payload: { settled: true },
        },
        {
          companyId,
          agentId,
          runId: turn.runId!,
          seq: 3,
          eventType: "lifecycle",
          message: "internal lifecycle canary",
          payload: { secret: "must-not-cross-ingress" },
        },
        {
          companyId,
          agentId,
          runId: turn.runId!,
          seq: 4,
          eventType: "adapter_internal",
          message: "internal adapter canary",
          payload: { secret: "must-not-cross-ingress" },
        },
        {
          companyId,
          agentId,
          runId: turn.runId!,
          seq: 5,
          eventType: "tool_call",
          message: "Using read",
          payload: {
            toolCallId: "call-1",
            toolName: "read",
            args: { path: "README.md" },
            providerInternal: "must-not-cross-ingress",
          },
        },
        {
          companyId,
          agentId,
          runId: other.runId!,
          seq: 1,
          eventType: "assistant_delta",
          message: "secret other thread",
          payload: { text: "secret other thread" },
        },
      ]);
      await db
        .update(heartbeatRuns)
        .set({ nextEventSeq: 6 })
        .where(eq(heartbeatRuns.id, turn.runId!));

      await expect(service.status(scope)).resolves.toMatchObject({
        issueId: turn.issueId,
        run: { id: turn.runId, status: "queued", eventCursor: 5 },
      });
      const afterFirst = await service.events({ ...scope, afterSeq: 1 });
      expect(afterFirst).toMatchObject({
        issueId: turn.issueId,
        nextSeq: 5,
      });
      expect(afterFirst.events.map((event) => event.eventType)).toEqual([
        "agent_settled",
        "tool_call",
      ]);
      expect(afterFirst.events[1]?.payload).toEqual({
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "README.md" },
      });
      const scoped = await service.events(scope);
      expect(scoped.events.map((event) => event.message)).not.toContain(
        "secret other thread",
      );
      expect(JSON.stringify(scoped)).not.toContain("must-not-cross-ingress");
      expect(scoped.events.map((event) => event.eventType)).not.toContain(
        "lifecycle",
      );
      await expect(
        service.status({ ...scope, agentId: otherAgentId }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("inventories only one owner and paginates without exposing internal IDs", async () => {
      const service = vectorIngressService(db, { heartbeat });
      const agentId = standardAgentId;
      const personaContext = {
        schemaVersion: 1 as const, personaId: "00000000-0000-0000-0000-000000000023",
        personaName: "Sage", personaVersion: "abcdef012345", model: "router/Qwen3.8-Flash",
        noBuiltinTools: true as const, systemPrompt: "Be a calm, precise collaborator.",
      };
      const ownerA = "authenticated-owner-a";
      const ownerB = "authenticated-owner-b";
      const ownerScope = {
        installationId: "stecke1-standard",
        profileId: "standard",
      };
      const baseTime = new Date("2026-09-25T19:00:00.000Z");
      const ownerASessions = [];
      for (const [index, externalSessionId] of [
        "client-a",
        "client-b",
        "client-c",
      ].entries()) {
        const turn = await service.addTurn({
          companyId,
          agentId,
          ownerId: ownerA,
          ...ownerScope,
          externalSessionId,
          clientRequestId: `inventory-a-${index}`,
          body: `Owner A ${index}`,
          personaContext,
        });
        await db
          .update(vectorIngressConversations)
          .set({ createdAt: new Date(baseTime.getTime() + index * 1_000) })
          .where(eq(vectorIngressConversations.issueId, turn.issueId));
        ownerASessions.push(turn);
      }
      const ownerBTurn = await service.addTurn({
        companyId,
        agentId,
        ownerId: ownerB,
        ...ownerScope,
        externalSessionId: "client-a",
        clientRequestId: "inventory-b-0",
        body: "Owner B",
        personaContext,
      });
      expect(ownerBTurn.issueId).not.toBe(ownerASessions[0]?.issueId);

      const firstPage = await service.inventory({
        companyId,
        agentId,
        ownerId: ownerA,
        ...ownerScope,
        limit: 2,
      });
      expect(
        firstPage.sessions.map((session) => session.externalSessionId),
      ).toEqual(["client-a", "client-b"]);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.nextPosition).not.toBeNull();
      expect(JSON.stringify(firstPage)).not.toContain(ownerASessions[0]!.issueId);
      expect(JSON.stringify(firstPage)).not.toContain(ownerBTurn.issueId);

      const secondPage = await service.inventory({
        companyId,
        agentId,
        ownerId: ownerA,
        ...ownerScope,
        limit: 2,
        after: firstPage.nextPosition!,
      });
      expect(
        secondPage.sessions.map((session) => session.externalSessionId),
      ).toEqual(["client-c"]);
      expect(secondPage.hasMore).toBe(false);
      expect(
        (
          await service.inventory({
            companyId,
            agentId,
            ownerId: ownerB,
            ...ownerScope,
          })
        ).sessions.map(
          (session) => session.externalSessionId,
        ),
      ).toEqual(["client-a"]);
      expect(
        (
          await service.inventory({
            companyId,
            agentId,
            ownerId: ownerA,
            installationId: "vector-installation",
            profileId: "funkydev",
          })
        ).sessions,
      ).toEqual([]);

      await db
        .update(issues)
        .set({ hiddenAt: new Date() })
        .where(eq(issues.id, ownerASessions[2]!.issueId));
      expect(
        (
          await service.inventory({
            companyId,
            agentId,
            ownerId: ownerA,
            ...ownerScope,
          })
        ).sessions.map(
          (session) => session.externalSessionId,
        ),
      ).toEqual(["client-a", "client-b"]);
    });

    it("replays ordered multi-turn and multi-run history without leaking internal events", async () => {
      const service = vectorIngressService(db, { heartbeat });
      const agentId = standardAgentId;
      const scope = {
        companyId,
        agentId,
        ownerId: "transcript-owner",
        installationId: "stecke1-standard",
        profileId: "standard",
        externalSessionId: "transcript-thread",
      };
      const first = await service.addTurn({
        ...scope,
        clientRequestId: "transcript-1",
        body: "First question",
        personaContext: {
          schemaVersion: 1, personaId: "00000000-0000-0000-0000-000000000023",
          personaName: "Sage", personaVersion: "abcdef012345", model: "router/Qwen3.8-Flash",
          noBuiltinTools: true, systemPrompt: "Be a calm, precise collaborator.",
        },
      });
      const second = await service.addTurn({
        ...scope,
        clientRequestId: "transcript-2",
        body: "Second question",
      });
      const times = {
        firstTurn: new Date("2026-09-25T20:00:00.000Z"),
        firstText: new Date("2026-09-25T20:00:01.000Z"),
        firstTool: new Date("2026-09-25T20:00:02.000Z"),
        firstResult: new Date("2026-09-25T20:00:03.000Z"),
        firstDone: new Date("2026-09-25T20:00:04.000Z"),
        secondTurn: new Date("2026-09-25T20:00:05.000Z"),
        secondText: new Date("2026-09-25T20:00:06.000Z"),
        secondFailed: new Date("2026-09-25T20:00:07.000Z"),
      };
      await db
        .update(issueComments)
        .set({ createdAt: times.firstTurn })
        .where(eq(issueComments.id, first.commentId));
      await db
        .update(vectorIngressTurns)
        .set({ createdAt: times.firstTurn })
        .where(eq(vectorIngressTurns.commentId, first.commentId));
      await db
        .update(issueComments)
        .set({ createdAt: times.secondTurn })
        .where(eq(issueComments.id, second.commentId));
      await db
        .update(vectorIngressTurns)
        .set({ createdAt: times.secondTurn })
        .where(eq(vectorIngressTurns.commentId, second.commentId));
      await db.insert(issueComments).values({
        companyId,
        issueId: first.issueId,
        authorType: "user",
        authorUserId: "local-board",
        body: "Operator note that is not a NexusLink user turn",
        createdAt: new Date("2026-09-25T20:00:00.500Z"),
      });
      await db.insert(heartbeatRunEvents).values([
        {
          companyId,
          agentId,
          runId: first.runId!,
          seq: 1,
          eventType: "assistant_delta",
          message: "First answer",
          payload: { delta: "First answer", providerInternal: "do-not-leak" },
          createdAt: times.firstText,
        },
        {
          companyId,
          agentId,
          runId: first.runId!,
          seq: 2,
          eventType: "tool_call",
          message: "Read a todo",
          payload: {
            toolCallId: "tool-1",
            toolName: "todo_get",
            args: {
              id: "todo-1",
              nested: { apiKey: "do-not-leak-api-key" },
              oversized: "x".repeat(40_000),
            },
            internalTrace: "do-not-leak",
          },
          createdAt: times.firstTool,
        },
        {
          companyId,
          agentId,
          runId: first.runId!,
          seq: 3,
          eventType: "tool_result",
          message: "Todo read",
          payload: {
            toolCallId: "tool-1",
            toolName: "todo_get",
            result: {
              title: "Ship",
              nested: { password: "do-not-leak-password" },
              auth: "Bearer do-not-leak-bearer",
            },
            internalTrace: "do-not-leak",
          },
          createdAt: times.firstResult,
        },
        {
          companyId,
          agentId,
          runId: first.runId!,
          seq: 4,
          eventType: "lifecycle",
          message: "secret lifecycle",
          payload: { secret: "do-not-leak" },
          createdAt: times.firstResult,
        },
        {
          companyId,
          agentId,
          runId: second.runId!,
          seq: 1,
          eventType: "assistant_delta",
          message: "Partial second answer",
          payload: { delta: "Partial second answer" },
          createdAt: times.secondText,
        },
        {
          companyId,
          agentId,
          runId: second.runId!,
          seq: 2,
          eventType: "error",
          message: "private event failure detail",
          payload: {
            source: "provider",
            command: "curl -H 'Authorization: do-not-leak-command'",
            internalTrace: "do-not-leak",
          },
          createdAt: new Date("2026-09-25T20:00:06.500Z"),
        },
      ]);
      await db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          finishedAt: times.firstDone,
          error: "must not appear",
          nextEventSeq: 5,
        })
        .where(eq(heartbeatRuns.id, first.runId!));
      await db
        .update(heartbeatRuns)
        .set({
          status: "failed",
          finishedAt: times.secondFailed,
          error: "private provider failure",
          nextEventSeq: 3,
        })
        .where(eq(heartbeatRuns.id, second.runId!));

      const replayed: Awaited<
        ReturnType<typeof service.transcript>
      >["events"] = [];
      let after: Awaited<
        ReturnType<typeof service.transcript>
      >["nextPosition"] = null;
      do {
        const page = await service.transcript({
          ...scope,
          limit: 2,
          after: after ?? undefined,
        });
        replayed.push(...page.events);
        after = page.hasMore ? page.nextPosition : null;
      } while (after);

      expect(replayed.map((event) => event.eventType)).toEqual([
        "user_turn",
        "assistant_delta",
        "tool_call",
        "tool_result",
        "run_terminal",
        "user_turn",
        "assistant_delta",
        "error",
        "run_terminal",
      ]);
      expect(replayed[2]?.payload).toEqual({
        toolCallId: "tool-1",
        toolName: "todo_get",
        args: {
          id: "todo-1",
          nested: { apiKey: "[redacted]" },
          oversized: `${"x".repeat(4_096)}[truncated]`,
        },
      });
      expect(replayed[3]?.payload).toEqual({
        toolCallId: "tool-1",
        toolName: "todo_get",
        result: {
          title: "Ship",
          nested: { password: "[redacted]" },
          auth: "[redacted]",
        },
      });
      expect(replayed.at(-1)?.payload).toEqual({ status: "failed", failed: true });
      const wire = JSON.stringify(replayed);
      expect(wire).not.toContain("secret lifecycle");
      expect(wire).not.toContain("Operator note");
      expect(wire).not.toContain("do-not-leak");
      expect(wire).not.toContain("private provider failure");
      expect(wire).not.toContain("private event failure detail");
      expect(wire).not.toContain("do-not-leak-api-key");
      expect(wire).not.toContain("do-not-leak-password");
      expect(wire).not.toContain("do-not-leak-bearer");
      expect(wire).not.toContain("do-not-leak-command");
      expect(JSON.stringify(replayed[2]?.payload).length).toBeLessThan(5_000);
      expect(replayed.at(-2)?.message).toBe("Agent run failed");
      expect(wire).not.toContain(first.issueId);
      expect(wire).not.toContain(first.runId!);
      expect(wire).not.toContain(second.runId!);

      await expect(
        service.transcript({ ...scope, ownerId: "different-owner" }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("does not synthesize a terminal event for an incomplete run", async () => {
      const service = vectorIngressService(db, { heartbeat });
      const agentId = standardAgentId;
      const scope = {
        companyId,
        agentId,
        ownerId: "incomplete-owner",
        installationId: "stecke1-standard",
        profileId: "standard",
        externalSessionId: "incomplete-thread",
      };
      await service.addTurn({
        ...scope,
        clientRequestId: "incomplete-1",
        body: "Still running",
        personaContext: {
          schemaVersion: 1, personaId: "00000000-0000-0000-0000-000000000023",
          personaName: "Sage", personaVersion: "abcdef012345", model: "router/Qwen3.8-Flash",
          noBuiltinTools: true, systemPrompt: "Be a calm, precise collaborator.",
        },
      });
      const result = await service.transcript(scope);
      expect(result.events.map((event) => event.eventType)).toEqual(["user_turn"]);
      expect(result.hasMore).toBe(false);
    });
  },
);
