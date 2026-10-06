import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { controlVectorPiSession, removeVectorPiForkFile } from "./vector-session-control.js";

const roots: string[] = [];
const originalPiCommand = process.env.PAPERCLIP_VECTOR_PI_COMMAND;

afterEach(async () => {
  if (originalPiCommand === undefined) delete process.env.PAPERCLIP_VECTOR_PI_COMMAND;
  else process.env.PAPERCLIP_VECTOR_PI_COMMAND = originalPiCommand;
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(options: { mutateSource?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-control-"));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const cwd = path.join(root, "workspace");
  const sessionsRoot = path.join(root, "sessions");
  await fs.mkdir(cwd, { mode: 0o700 });
  await fs.mkdir(sessionsRoot, { mode: 0o700 });
  const sessionFile = path.join(sessionsRoot, "source.jsonl");
  await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "source-id", cwd })}\n`, { mode: 0o600 });
  const fakePi = path.join(root, "fake-pi.mjs");
  const source = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const args = process.argv.slice(2);
for (const required of ["--mode", "rpc", "--no-builtin-tools", "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--session"]) {
  if (!args.includes(required)) process.exit(42);
}
const sourceFile = args[args.indexOf("--session") + 1];
const sourceHeader = JSON.parse(fs.readFileSync(sourceFile, "utf8").split("\\n")[0]);
let sessionFile = sourceFile;
let sessionId = sourceHeader.id;
let points = [{ entryId: "entry-1", text: "first" }, { entryId: "entry-2", text: "second" }];
const send = (id, command, data, success = true) => process.stdout.write(JSON.stringify({ type: "response", id, command, success, data }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "get_fork_messages") {
    ${options.mutateSource ? "fs.appendFileSync(sourceFile, JSON.stringify({ type: 'custom_message', id: 'changed' }) + '\\n');" : ""}
    send(request.id, request.type, { messages: points });
  } else if (request.type === "fork") {
    if (!points.some((point) => point.entryId === request.entryId)) return send(request.id, request.type, null, false);
    sessionId = "fork-id";
    sessionFile = path.join(path.dirname(sourceFile), "fork.jsonl");
    fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId, cwd: sourceHeader.cwd, parentSession: sourceFile }) + "\\n", { mode: 0o600, flag: "wx" });
    points = points.slice(0, points.findIndex((point) => point.entryId === request.entryId));
    send(request.id, request.type, { text: "second", cancelled: false });
  } else if (request.type === "get_state") {
    send(request.id, request.type, { sessionFile, sessionId });
  }
});
`;
  await fs.writeFile(fakePi, source, { mode: 0o700 });
  return { root, cwd, sessionsRoot, sessionFile, fakePi };
}

describe("Vector Pi retained-session control", () => {
  const actualPiCommand = process.env.PAPERCLIP_TEST_PI_COMMAND?.trim();

  it("lists and forks the exact retained Pi branch, then supports verified rollback cleanup", async () => {
    const f = await fixture();
    process.env.PAPERCLIP_VECTOR_PI_COMMAND = f.fakePi;
    const listed = await controlVectorPiSession({
      cwd: f.cwd,
      sessionFile: f.sessionFile,
      sessionsRoot: f.sessionsRoot,
      action: { type: "list" },
    });
    expect(listed.state).toEqual({ sessionFile: f.sessionFile, sessionId: "source-id" });
    expect(listed.points.map((point) => point.entryId)).toEqual(["entry-1", "entry-2"]);

    const forked = await controlVectorPiSession({
      cwd: f.cwd,
      sessionFile: f.sessionFile,
      sessionsRoot: f.sessionsRoot,
      action: { type: "fork", entryId: "entry-2" },
    });
    expect(forked.forked).toEqual({ cancelled: false, text: "second" });
    expect(forked.state.sessionId).toBe("fork-id");
    expect(forked.state.sessionFile).toBe(path.join(f.sessionsRoot, "fork.jsonl"));
    await expect(fs.readFile(f.sessionFile, "utf8")).resolves.toContain('"id":"source-id"');

    await removeVectorPiForkFile({
      sessionFile: forked.state.sessionFile,
      sessionsRoot: f.sessionsRoot,
      cwd: f.cwd,
      sessionId: forked.state.sessionId,
      parentSessionFile: f.sessionFile,
    });
    await expect(fs.lstat(forked.state.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects stale fork points before Pi mutates the retained tree", async () => {
    const f = await fixture();
    process.env.PAPERCLIP_VECTOR_PI_COMMAND = f.fakePi;
    await expect(controlVectorPiSession({
      cwd: f.cwd,
      sessionFile: f.sessionFile,
      sessionsRoot: f.sessionsRoot,
      action: { type: "fork", entryId: "missing" },
    })).rejects.toThrow("no longer on the active Pi branch");
    await expect(fs.lstat(path.join(f.sessionsRoot, "fork.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["symlink", async (f: Awaited<ReturnType<typeof fixture>>) => {
      const target = path.join(f.sessionsRoot, "target.jsonl");
      await fs.rename(f.sessionFile, target);
      await fs.symlink(target, f.sessionFile);
    }],
    ["hardlink", async (f: Awaited<ReturnType<typeof fixture>>) => {
      await fs.link(f.sessionFile, path.join(f.sessionsRoot, "other.jsonl"));
    }],
    ["writable mode", async (f: Awaited<ReturnType<typeof fixture>>) => {
      await fs.chmod(f.sessionFile, 0o620);
    }],
  ])("rejects a %s session-file attack", async (_label, attack) => {
    const f = await fixture();
    process.env.PAPERCLIP_VECTOR_PI_COMMAND = f.fakePi;
    await attack(f);
    await expect(controlVectorPiSession({
      cwd: f.cwd,
      sessionFile: f.sessionFile,
      sessionsRoot: f.sessionsRoot,
      action: { type: "list" },
    })).rejects.toThrow("Vector Pi session control rejected");
  });

  it("rejects traversal and an insecure managed root", async () => {
    const f = await fixture();
    process.env.PAPERCLIP_VECTOR_PI_COMMAND = f.fakePi;
    const outside = path.join(f.root, "outside.jsonl");
    await fs.copyFile(f.sessionFile, outside);
    await expect(controlVectorPiSession({
      cwd: f.cwd,
      sessionFile: outside,
      sessionsRoot: f.sessionsRoot,
      action: { type: "list" },
    })).rejects.toThrow("outside the managed session root");
    await fs.chmod(f.sessionsRoot, 0o722);
    await expect(controlVectorPiSession({
      cwd: f.cwd,
      sessionFile: f.sessionFile,
      sessionsRoot: f.sessionsRoot,
      action: { type: "list" },
    })).rejects.toThrow("group/world writable");
  });

  it("detects source replacement or mutation during a control operation", async () => {
    const f = await fixture({ mutateSource: true });
    process.env.PAPERCLIP_VECTOR_PI_COMMAND = f.fakePi;
    await expect(controlVectorPiSession({
      cwd: f.cwd,
      sessionFile: f.sessionFile,
      sessionsRoot: f.sessionsRoot,
      action: { type: "list" },
    })).rejects.toThrow("retained source session changed");
  });

  (actualPiCommand ? it : it.skip)("uses Pi RPC's authentic current-leaf fork semantics", async () => {
    process.env.PAPERCLIP_VECTOR_PI_COMMAND = actualPiCommand!;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-real-control-"));
    roots.push(root);
    await fs.chmod(root, 0o700);
    const cwd = path.join(root, "workspace");
    const sessionsRoot = path.join(root, "sessions");
    await fs.mkdir(cwd, { mode: 0o700 });
    await fs.mkdir(sessionsRoot, { mode: 0o700 });
    const sessionFile = path.join(sessionsRoot, "authentic-source.jsonl");
    const timestamp = new Date().toISOString();
    const entries = [
      { type: "session", version: 3, id: "authentic-source-id", timestamp, cwd },
      { type: "message", id: "user-1", parentId: null, timestamp, message: { role: "user", content: "first prompt", timestamp: Date.now() } },
      { type: "message", id: "assistant-1", parentId: "user-1", timestamp, message: {
        role: "assistant", content: [{ type: "text", text: "first answer" }], api: "anthropic-messages",
        provider: "test", model: "test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      } },
      { type: "message", id: "user-2", parentId: "assistant-1", timestamp, message: { role: "user", content: "second prompt", timestamp: Date.now() } },
      { type: "thinking_level_change", id: "thinking-1", parentId: "user-2", timestamp, thinkingLevel: "low" },
    ];
    await fs.writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });

    const listed = await controlVectorPiSession({
      cwd, sessionFile, sessionsRoot, action: { type: "list" },
    });
    expect(listed.points).toEqual([
      { entryId: "user-1", text: "first prompt" },
      { entryId: "user-2", text: "second prompt" },
    ]);
    await expect(controlVectorPiSession({
      cwd, sessionFile, sessionsRoot, action: { type: "fork", entryId: "user-1" },
    })).rejects.toMatchObject({
      message: expect.stringContaining("Pi did not persist the forked session context"),
      code: "fork_not_persisted",
    });
    const forked = await controlVectorPiSession({
      cwd, sessionFile, sessionsRoot, action: { type: "fork", entryId: "user-2" },
    });
    expect(forked.forked).toEqual({ cancelled: false, text: "second prompt" });
    expect(forked.points).toEqual([{ entryId: "user-1", text: "first prompt" }]);
    const forkBytes = await fs.readFile(forked.state.sessionFile, "utf8");
    expect(forkBytes).toContain('"id":"user-1"');
    expect(forkBytes).not.toContain('"id":"user-2"');
    expect(await fs.readFile(sessionFile, "utf8")).toContain('"id":"user-2"');
  }, 30_000);
});
