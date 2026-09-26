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
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { isSecretSensitiveHttpRequest } from "../middleware/http-log-policy.js";
import {
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
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const secret = "vector-ingress-test-secret-with-at-least-32-characters";
const path = "/api/internal/vector/v1/turns";

function signedPost(
  app: express.Express,
  requestPath: string,
  body: Record<string, unknown>,
  timestamp = "1700000000",
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
        },
        service: {
          addTurn,
          reset: vi.fn(),
          cancel: vi.fn(),
          status: vi.fn(),
          events: vi.fn(),
        } as never,
        now: () => 1_700_000_000_000,
      }),
    );
    app.use(errorHandler);
    const body = {
      companyId: randomUUID(),
      agentId: randomUUID(),
      externalSessionId: "opaque-thread",
      clientRequestId: "request-1",
      body: "Hello",
    };

    await signedPost(app, path, body).expect(201);
    expect(addTurn).toHaveBeenCalledExactlyOnceWith(body);
    await request(app).post(path).send(body).expect(401);
    await signedPost(app, path, body, "1699999000").expect(401);
    await request(app)
      .post(path)
      .set("x-vector-timestamp", "1700000000")
      .set("x-vector-signature", "v1=00")
      .send(body)
      .expect(401);
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
          role: "assistant",
          status: "idle",
          adapterType: "process",
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
  },
);
