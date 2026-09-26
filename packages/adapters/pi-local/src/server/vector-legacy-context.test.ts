import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionCodec } from "./index.js";
import { canResumePiSession } from "./execute.js";
import {
  readVectorLegacyPiContextMarker,
  stageVectorLegacyPiContext,
  verifyVectorLegacyPiContextFile,
  verifyVectorLegacyPiContextMarker,
  type VectorLegacyPiContextScope,
} from "./vector-legacy-context.js";

const secret = "vector-ingress-test-secret-with-at-least-32-characters";
const scope = {
  installationId: "t480-engineering",
  profileId: "engineering",
  companyId: "12d42db4-38df-5ae1-9b10-204b6f2e5d0c",
  agentId: "e5b45684-168d-51af-9bb4-e9a5d96f6329",
  ownerSha256: "a".repeat(64),
  externalSessionId: "legacy-conversation-1",
  legacyService: "nexuslink-chat" as const,
  legacyPiSessionId: "legacy-pi-session-1",
};

const roots: string[] = [];

async function fixture(input: VectorLegacyPiContextScope = scope) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-legacy-context-"));
  roots.push(root);
  const sourceRoot = path.join(root, "legacy");
  const serviceRoot = path.join(sourceRoot, input.legacyService);
  const sessionsRoot = path.join(root, "managed");
  await fs.mkdir(serviceRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(sourceRoot, 0o700);
  await fs.chmod(serviceRoot, 0o700);
  const source = path.join(serviceRoot, `2026-09-25_${input.legacyPiSessionId}.jsonl`);
  const raw = [
    JSON.stringify({ type: "session", version: 3, id: input.legacyPiSessionId, cwd: "/legacy/workspace" }),
    JSON.stringify({ type: "message", role: "user", content: "private retained context" }),
    JSON.stringify({ type: "message", role: "assistant", content: "retained answer" }),
    "",
  ].join("\n");
  await fs.writeFile(source, raw, { mode: 0o600 });
  return { root, sourceRoot, sessionsRoot, source, raw };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Vector legacy Pi context staging", () => {
  it("copies exact bytes, preserves only a valid marker in the codec, and replays by digest", async () => {
    const f = await fixture();
    const first = await stageVectorLegacyPiContext({ ...scope, sourceRoot: f.sourceRoot, sessionsRoot: f.sessionsRoot, ingressSecret: secret });
    expect(first.replayed).toBe(false);
    expect(await fs.readFile(first.sessionParams.sessionId, "utf8")).toBe(f.raw);
    expect((await fs.stat(first.sessionParams.sessionId)).mode & 0o777).toBe(0o600);
    const marker = readVectorLegacyPiContextMarker(first.sessionParams)!;
    expect(marker).toMatchObject({ ...scope, sessionPath: first.sessionParams.sessionId, headerCwd: "/legacy/workspace" });
    expect(verifyVectorLegacyPiContextMarker({ marker, ingressSecret: secret, expected: scope, sessionPath: first.sessionParams.sessionId })).toBe(true);
    await expect(verifyVectorLegacyPiContextFile({ marker, ingressSecret: secret, expected: scope, sessionsRoot: f.sessionsRoot })).resolves.toBe(true);
    expect(canResumePiSession({ sessionId: first.sessionParams.sessionId, targetMatches: true, sessionParamsCwdMatches: false, sessionHeaderCwdMatches: false, legacyContextAuthorized: true })).toBe(true);
    expect(canResumePiSession({ sessionId: first.sessionParams.sessionId, targetMatches: true, sessionParamsCwdMatches: false, sessionHeaderCwdMatches: false, legacyContextAuthorized: false })).toBe(false);
    expect(sessionCodec.deserialize(first.sessionParams)).toEqual(first.sessionParams);
    expect(sessionCodec.serialize(first.sessionParams)).toEqual(first.sessionParams);
    expect(sessionCodec.deserialize({ ...first.sessionParams, vectorLegacyPiContext: { ...marker, receipt: "v1=00" } })).toEqual({ sessionId: first.sessionParams.sessionId, cwd: first.sessionParams.cwd });

    const second = await stageVectorLegacyPiContext({ ...scope, sourceRoot: f.sourceRoot, sessionsRoot: f.sessionsRoot, ingressSecret: secret });
    expect(second.replayed).toBe(true);
    expect(second.sessionParams).toEqual(first.sessionParams);
  });

  it("accepts only the immutable profile-to-service mapping", async () => {
    const staging = { ...scope, installationId: "stg1", profileId: "staging", legacyService: "funky" as const };
    const f = await fixture(staging);
    await expect(stageVectorLegacyPiContext({ ...staging, sourceRoot: f.sourceRoot, sessionsRoot: f.sessionsRoot, ingressSecret: secret })).resolves.toMatchObject({ replayed: false });
    await expect(stageVectorLegacyPiContext({ ...scope, legacyService: "funky", sourceRoot: f.sourceRoot, sessionsRoot: f.sessionsRoot, ingressSecret: secret })).rejects.toThrow(/scope is malformed/);
    await expect(stageVectorLegacyPiContext({ ...scope, profileId: "production", sourceRoot: f.sourceRoot, sessionsRoot: f.sessionsRoot, ingressSecret: secret })).rejects.toThrow(/scope is malformed/);
  });

  it("rejects traversal and a mismatched session header", async () => {
    const f = await fixture();
    await expect(stageVectorLegacyPiContext({ ...scope, legacyPiSessionId: "../other", sourceRoot: f.sourceRoot, sessionsRoot: f.sessionsRoot, ingressSecret: secret })).rejects.toThrow(/scope is malformed/);
    await fs.writeFile(f.source, `${JSON.stringify({ type: "session", version: 3, id: "different", cwd: "/legacy/workspace" })}\n`, { mode: 0o600 });
    await expect(stageVectorLegacyPiContext({ ...scope, sourceRoot: f.sourceRoot, sessionsRoot: f.sessionsRoot, ingressSecret: secret })).rejects.toThrow(/header does not match/);
  });

  it("rejects symlink, hardlink, writable, wrong-owner, and corrupt files", async () => {
    const symlink = await fixture();
    const real = path.join(symlink.root, "real.jsonl");
    await fs.rename(symlink.source, real);
    await fs.symlink(real, symlink.source);
    await expect(stageVectorLegacyPiContext({ ...scope, sourceRoot: symlink.sourceRoot, sessionsRoot: symlink.sessionsRoot, ingressSecret: secret })).rejects.toThrow(/not found/);

    const hardlink = await fixture();
    await fs.link(hardlink.source, path.join(hardlink.root, "second-link.jsonl"));
    await expect(stageVectorLegacyPiContext({ ...scope, sourceRoot: hardlink.sourceRoot, sessionsRoot: hardlink.sessionsRoot, ingressSecret: secret })).rejects.toThrow(/multiple hard links/);

    const writable = await fixture();
    await fs.chmod(writable.source, 0o620);
    await expect(stageVectorLegacyPiContext({ ...scope, sourceRoot: writable.sourceRoot, sessionsRoot: writable.sessionsRoot, ingressSecret: secret })).rejects.toThrow(/group\/world writable/);

    const wrongOwner = await fixture();
    vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
    await expect(stageVectorLegacyPiContext({ ...scope, sourceRoot: wrongOwner.sourceRoot, sessionsRoot: wrongOwner.sessionsRoot, ingressSecret: secret })).rejects.toThrow(/not owned by the runtime user/);
    vi.restoreAllMocks();

    const corrupt = await fixture();
    const imported = await stageVectorLegacyPiContext({ ...scope, sourceRoot: corrupt.sourceRoot, sessionsRoot: corrupt.sessionsRoot, ingressSecret: secret });
    await fs.writeFile(imported.sessionParams.sessionId, "corrupt", { mode: 0o600 });
    await expect(stageVectorLegacyPiContext({ ...scope, sourceRoot: corrupt.sourceRoot, sessionsRoot: corrupt.sessionsRoot, ingressSecret: secret })).rejects.toThrow(/retained source digest/);
    await expect(verifyVectorLegacyPiContextFile({ marker: imported.sessionParams.vectorLegacyPiContext, ingressSecret: secret, expected: scope, sessionsRoot: corrupt.sessionsRoot })).resolves.toBe(false);
  });

  it("rejects a valid receipt rebound to another owner or installation", async () => {
    const f = await fixture();
    const imported = await stageVectorLegacyPiContext({ ...scope, sourceRoot: f.sourceRoot, sessionsRoot: f.sessionsRoot, ingressSecret: secret });
    const marker = imported.sessionParams.vectorLegacyPiContext;
    expect(verifyVectorLegacyPiContextMarker({ marker: { ...marker, ownerSha256: "b".repeat(64) }, ingressSecret: secret, expected: scope, sessionPath: imported.sessionParams.sessionId })).toBe(false);
    expect(verifyVectorLegacyPiContextMarker({ marker, ingressSecret: secret, expected: { ...scope, installationId: "stecke1-standard" }, sessionPath: imported.sessionParams.sessionId })).toBe(false);
    expect(verifyVectorLegacyPiContextMarker({ marker, ingressSecret: secret, expected: { ...scope, externalSessionId: "another-conversation" }, sessionPath: imported.sessionParams.sessionId })).toBe(false);
  });
});
