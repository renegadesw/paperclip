import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentTaskSessions, agents, companies, createDb, issues, vectorIngressConversations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { VECTOR_LEGACY_PI_CONTEXT_ORIGIN, vectorLegacyOwnerSha256, vectorLegacyPiContextImporter } from "./vector-legacy-pi-context.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe.sequential : describe.skip;
const secret = "vector-ingress-test-secret-with-at-least-32-characters";

describeDb("Vector legacy Pi context importer", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let sourceRoot: string;
  let sessionsRoot: string;
  let source: string;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const ownerId = "canonical-user:org";
  const installationId = "t480-funkydev";
  const profileId = "engineering";
  const externalSessionId = "legacy/chat/thread 1";
  const legacyPiSessionId = "legacy-pi-session-1";

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-vector-legacy-context-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-vector-legacy-context-"));
    sourceRoot = path.join(root, "legacy");
    sessionsRoot = path.join(root, "managed");
    const serviceRoot = path.join(sourceRoot, "nexuslink-chat");
    await fs.mkdir(serviceRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(sourceRoot, 0o700);
    await fs.chmod(serviceRoot, 0o700);
    source = path.join(serviceRoot, `2026-09-25_${legacyPiSessionId}.jsonl`);
    await fs.writeFile(source, `${JSON.stringify({ type: "session", version: 3, id: legacyPiSessionId, cwd: "/legacy/workspace" })}\n${JSON.stringify({ type: "message", role: "user", content: "retained" })}\n`, { mode: 0o600 });
    await db.insert(companies).values({ id: companyId, name: "Vector", issuePrefix: "VEC", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "FunkyDev", role: "assistant", status: "idle", adapterType: "pi_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Imported conversation", status: "backlog", assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: "vector:owner", conversationState: "waiting" });
    await db.insert(vectorIngressConversations).values({
      companyId, agentId, issueId, installationId, profileId,
      ownerSha256: vectorLegacyOwnerSha256({ companyId, agentId, installationId, profileId, ownerId }),
      externalSessionId,
    });
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("binds one exact digest to its owner and rejects rebound or changed sources", async () => {
    const input = { companyId, agentId, issueId, ownerId, installationId, profileId, externalSessionId, legacyService: "nexuslink-chat" as const, legacyPiSessionId };
    const importer = vectorLegacyPiContextImporter(db, { sourceRoot, sessionsRoot, ingressSecret: secret });
    const first = await importer.importContext(input);
    expect(first).toMatchObject({ replayed: false, companyId, agentId, issueId, externalSessionId });
    expect(first.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(importer.importContext(input)).resolves.toEqual({ ...first, replayed: true });
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, issueId))).toHaveLength(1);
    await expect(db.select({ origin: issues.originFingerprint }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]?.origin)).resolves.toBe(VECTOR_LEGACY_PI_CONTEXT_ORIGIN);

    const stage = vi.fn();
    const guarded = vectorLegacyPiContextImporter(db, { sourceRoot, sessionsRoot, ingressSecret: secret, stage });
    await expect(guarded.importContext({ ...input, ownerId: "different-owner" })).rejects.toMatchObject({ status: 409, details: { code: "vector_legacy_context_owner_mismatch" } });
    await expect(guarded.importContext({ ...input, installationId: "stecke1-standard" })).rejects.toMatchObject({ status: 409, details: { code: "vector_legacy_context_owner_mismatch" } });
    expect(stage).not.toHaveBeenCalled();

    await fs.appendFile(source, `${JSON.stringify({ type: "message", role: "assistant", content: "changed" })}\n`);
    await expect(importer.importContext(input)).rejects.toMatchObject({ status: 409, details: { code: "vector_legacy_context_conflict" } });
  });
});
