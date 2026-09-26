import { randomUUID } from "node:crypto";
import { removeVectorPiForkFile, VectorPiSessionControlError } from "@paperclipai/adapter-pi-local/server";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentTaskSessions,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  vectorIngressBranches,
  vectorIngressConversations,
  vectorIngressTurns,
} from "@paperclipai/db";
import { vectorIngressOwnerSha256 } from "./vector-ingress-owner.js";
import { vectorConversationOwnerId, vectorIngressService } from "./vector-ingress.js";
import {
  vectorSessionBranchService,
  type VectorPiSessionController,
  type VectorSessionBranchScope,
} from "./vector-session-branches.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("Vector retained Pi branches", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let scope: VectorSessionBranchScope;
  let issueId: string;
  let conversationId: string;
  let taskSessionId: string;
  let controller: ReturnType<typeof vi.fn<VectorPiSessionController>>;
  let removeForkFile: ReturnType<typeof vi.fn<typeof removeVectorPiForkFile>>;
  const sourceFile = "/managed/pi/source.jsonl";
  const forkFile = "/managed/pi/fork.jsonl";
  const cwd = "/managed/workspace";

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-vector-branches-");
    db = createDb(database.connectionString);
    const companyId = randomUUID();
    const agentId = randomUUID();
    issueId = randomUUID();
    conversationId = randomUUID();
    taskSessionId = randomUUID();
    scope = {
      companyId,
      agentId,
      ownerId: "canonical-owner",
      installationId: "stecke1-standard",
      profileId: "standard",
      externalSessionId: "conversation-one",
    };
    await db.insert(companies).values({
      id: companyId,
      name: "Vector",
      issuePrefix: "VEC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Standard",
      role: "standard-chat",
      status: "idle",
      adapterType: "pi_local",
      adapterConfig: { model: "router/test", executionMode: "rpc" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retained branch",
      status: "backlog",
      assigneeAgentId: agentId,
      conversationAgentId: agentId,
      conversationUserId: vectorConversationOwnerId(scope),
      conversationState: "waiting",
    });
    await db.insert(vectorIngressConversations).values({
      id: conversationId,
      companyId,
      agentId,
      issueId,
      installationId: scope.installationId,
      profileId: scope.profileId,
      ownerSha256: vectorIngressOwnerSha256(scope),
      externalSessionId: scope.externalSessionId,
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "succeeded",
      resultJson: {
        vectorPiSession: {
          promptEntryId: "prompt-1",
          sessionFile: sourceFile,
          sessionId: "source-session-id",
        },
      },
      finishedAt: new Date(),
    }).returning();
    const [comment] = await db.insert(issueComments).values({
      companyId,
      issueId,
      authorType: "user",
      authorUserId: "local-board",
      conversationSessionGeneration: 0,
      body: "first prompt",
    }).returning();
    await db.insert(vectorIngressTurns).values({
      conversationId,
      commentId: comment!.id,
      runId: run!.id,
      baseCursor: 0,
    });
    await db.insert(agentTaskSessions).values({
      id: taskSessionId,
      companyId,
      agentId,
      adapterType: "pi_local",
      taskKey: issueId,
      sessionParamsJson: { sessionId: sourceFile, cwd },
      sessionDisplayId: sourceFile,
    });
    controller = vi.fn(async (input) => {
      if (input.action.type === "fork") {
        return {
          state: { sessionFile: forkFile, sessionId: "fork-session-id" },
          points: [],
          forked: { cancelled: false, text: "first prompt" },
        };
      }
      const fork = input.sessionFile === forkFile;
      return {
        state: {
          sessionFile: input.sessionFile,
          sessionId: fork ? "fork-session-id" : "source-session-id",
        },
        points: fork ? [] : [{ entryId: "prompt-1", text: "first prompt" }],
      };
    });
    removeForkFile = vi.fn<typeof removeVectorPiForkFile>(async () => undefined);
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  it("persists authentic fork points, forks, switches, and hides raw Pi paths", async () => {
    const service = vectorSessionBranchService(db, { controller, removeForkFile });
    const initial = await service.list(scope);
    expect(initial.points).toEqual([{ entryId: "prompt-1", text: "first prompt" }]);
    expect(initial.branches).toHaveLength(1);
    expect(JSON.stringify(initial)).not.toContain("/managed/");

    const forked = await service.fork({ ...scope, entryId: "prompt-1" });
    expect(forked).toMatchObject({ forked: true, text: "first prompt", parentBranchId: initial.activeBranchId });
    const taskAfterFork = await db.select().from(agentTaskSessions)
      .where(eq(agentTaskSessions.id, taskSessionId)).then((rows) => rows[0]!);
    expect(taskAfterFork.sessionParamsJson).toEqual({ sessionId: forkFile, cwd });

    await service.switchBranch({ ...scope, branchId: initial.activeBranchId });
    const taskAfterSwitch = await db.select().from(agentTaskSessions)
      .where(eq(agentTaskSessions.id, taskSessionId)).then((rows) => rows[0]!);
    expect(taskAfterSwitch.sessionParamsJson).toEqual({ sessionId: sourceFile, cwd });
    await expect(service.switchBranch({ ...scope, branchId: randomUUID() }))
      .rejects.toMatchObject({ status: 404 });
    await expect(service.list({ ...scope, ownerId: "different-owner" }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("compensates the retained fork file when commit fencing detects a changed task session", async () => {
    const racingController = vi.fn<VectorPiSessionController>(async (input) => {
      if (input.action.type === "fork") {
        await db.update(agentTaskSessions).set({ updatedAt: new Date(Date.now() + 5_000) })
          .where(eq(agentTaskSessions.id, taskSessionId));
        return {
          state: { sessionFile: "/managed/pi/raced.jsonl", sessionId: "raced-session-id" },
          points: [],
          forked: { cancelled: false, text: "first prompt" },
        };
      }
      return {
        state: { sessionFile: sourceFile, sessionId: "source-session-id" },
        points: [{ entryId: "prompt-1", text: "first prompt" }],
      };
    });
    const cleanup = vi.fn(async () => undefined);
    const service = vectorSessionBranchService(db, { controller: racingController, removeForkFile: cleanup });
    await expect(service.fork({ ...scope, entryId: "prompt-1" }))
      .rejects.toMatchObject({ status: 409 });
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionFile: "/managed/pi/raced.jsonl",
      parentSessionFile: sourceFile,
    }));
    expect(await db.select().from(vectorIngressBranches).where(and(
      eq(vectorIngressBranches.conversationId, conversationId),
      eq(vectorIngressBranches.piSessionId, "raced-session-id"),
    ))).toHaveLength(0);
  });

  it("surfaces a distinct conflict when retained-file compensation fails", async () => {
    const racingController = vi.fn<VectorPiSessionController>(async (input) => {
      if (input.action.type === "fork") {
        await db.update(agentTaskSessions).set({ updatedAt: new Date(Date.now() + 10_000) })
          .where(eq(agentTaskSessions.id, taskSessionId));
        return {
          state: { sessionFile: "/managed/pi/orphan-risk.jsonl", sessionId: "orphan-risk-id" },
          points: [],
          forked: { cancelled: false, text: "first prompt" },
        };
      }
      return {
        state: { sessionFile: sourceFile, sessionId: "source-session-id" },
        points: [{ entryId: "prompt-1", text: "first prompt" }],
      };
    });
    const cleanup = vi.fn(async () => { throw new Error("cleanup failed"); });
    const service = vectorSessionBranchService(db, { controller: racingController, removeForkFile: cleanup });
    await expect(service.fork({ ...scope, entryId: "prompt-1" })).rejects.toMatchObject({
      status: 409,
      details: { code: "vector_branch_fork_rollback_failed" },
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("maps a fork Pi cannot persist to a client conflict and releases the fence", async () => {
    const emptyForkController = vi.fn<VectorPiSessionController>(async (input) => {
      if (input.action.type === "fork") {
        throw new VectorPiSessionControlError("Pi did not persist the forked session context", "fork_not_persisted");
      }
      return {
        state: { sessionFile: sourceFile, sessionId: "source-session-id" },
        points: [{ entryId: "prompt-1", text: "first prompt" }],
      };
    });
    const cleanup = vi.fn(async () => undefined);
    const service = vectorSessionBranchService(db, { controller: emptyForkController, removeForkFile: cleanup });
    await expect(service.fork({ ...scope, entryId: "prompt-1" })).rejects.toMatchObject({
      status: 409,
      details: { code: "vector_branch_fork_point_empty" },
    });
    expect(cleanup).not.toHaveBeenCalled();
    await expect(service.list(scope)).resolves.toMatchObject({ points: [{ entryId: "prompt-1" }] });
  });

  it("rejects branch control while the exact conversation has a running turn", async () => {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: scope.companyId,
      agentId: scope.agentId,
      status: "running",
      nativeIssueId: issueId,
    }).returning();
    const blockedController = vi.fn<VectorPiSessionController>();
    const service = vectorSessionBranchService(db, { controller: blockedController });
    await expect(service.list(scope)).rejects.toMatchObject({
      status: 409,
      details: { code: "vector_branch_turn_active" },
    });
    expect(blockedController).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, run!.id));
  });

  it("keeps prior generations while projecting the active branch from actual turn rows", async () => {
    await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, issueId));
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: scope.companyId,
      agentId: scope.agentId,
      status: "succeeded",
      resultJson: { vectorPiSession: { promptEntryId: "prompt-2", sessionFile: sourceFile, sessionId: "source-session-id" } },
      finishedAt: new Date(),
    }).returning();
    const [comment] = await db.insert(issueComments).values({
      companyId: scope.companyId,
      issueId,
      authorType: "user",
      authorUserId: "local-board",
      conversationSessionGeneration: 1,
      body: "second generation prompt",
    }).returning();
    await db.insert(vectorIngressTurns).values({
      conversationId,
      commentId: comment!.id,
      runId: run!.id,
      baseCursor: 0,
    });
    const generationController = vi.fn<VectorPiSessionController>(async (input) => input.action.type === "fork"
      ? {
          state: { sessionFile: "/managed/pi/generation-fork.jsonl", sessionId: "generation-fork-id" },
          points: [],
          forked: { cancelled: false, text: "second generation prompt" },
        }
      : {
          state: { sessionFile: input.sessionFile, sessionId: input.sessionFile === sourceFile ? "source-session-id" : "generation-fork-id" },
          points: input.sessionFile === sourceFile ? [{ entryId: "prompt-2", text: "second generation prompt" }] : [],
        });
    const branches = vectorSessionBranchService(db, { controller: generationController, removeForkFile });
    await branches.list(scope);
    await branches.fork({ ...scope, entryId: "prompt-2" });

    const transcript = await vectorIngressService(db, { sessionBranches: branches }).transcript(scope);
    expect(transcript.events.filter((event) => event.eventType === "user_turn").map((event) => event.payload.text))
      .toEqual(["first prompt"]);
  });
});
