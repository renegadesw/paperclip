import { randomUUID } from "node:crypto";
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
} from "../services/vector-ingress.js";
import type { VectorRuntimeScope } from "../services/vector-runtime-scope.js";
import { instanceSettingsService } from "../services/instance-settings.js";
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
    await signedPost(app, path, { ...body, externalSessionId: " padded" }).expect(
      400,
    );
    await signedPost(app, path, { ...body, ownerId: "owner-only" }).expect(400);
    expect(addTurn).toHaveBeenCalledTimes(1);
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
    expect(addTurn).toHaveBeenCalledTimes(1);
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
      const ownerA = "authenticated-owner-a";
      const ownerB = "authenticated-owner-b";
      const ownerScope = {
        installationId: "vector-installation",
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
      const scope = {
        companyId,
        agentId,
        ownerId: "transcript-owner",
        installationId: "vector-installation",
        profileId: "standard",
        externalSessionId: "transcript-thread",
      };
      const first = await service.addTurn({
        ...scope,
        clientRequestId: "transcript-1",
        body: "First question",
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
      const scope = {
        companyId,
        agentId,
        ownerId: "incomplete-owner",
        installationId: "vector-installation",
        profileId: "standard",
        externalSessionId: "incomplete-thread",
      };
      await service.addTurn({
        ...scope,
        clientRequestId: "incomplete-1",
        body: "Still running",
      });
      const result = await service.transcript(scope);
      expect(result.events.map((event) => event.eventType)).toEqual(["user_turn"]);
      expect(result.hasMore).toBe(false);
    });
  },
);
