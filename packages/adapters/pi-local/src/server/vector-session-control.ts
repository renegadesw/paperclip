import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface VectorPiForkPoint {
  entryId: string;
  text: string;
}

export interface VectorPiSessionState {
  sessionFile: string;
  sessionId: string;
}

export interface VectorPiSessionControlInput {
  cwd: string;
  sessionFile: string;
  sessionsRoot?: string;
  timeoutMs?: number;
  action: { type: "list" } | { type: "fork"; entryId: string };
}

export interface VectorPiSessionControlResult {
  state: VectorPiSessionState;
  points: VectorPiForkPoint[];
  forked?: { cancelled: boolean; text: string };
}

type FileIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
};

/** `code` is set only for outcomes a caller can map to a client-visible conflict. */
export class VectorPiSessionControlError extends Error {
  constructor(message: string, readonly code?: "fork_not_persisted") {
    super(`Vector Pi session control rejected: ${message}`);
    this.name = "VectorPiSessionControlError";
  }
}

function invalid(message: string, code?: "fork_not_persisted"): Error {
  return new VectorPiSessionControlError(message, code);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function assertSecureDirectory(directory: string, label: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid(`${label} is not a real directory`);
  if (typeof stat.uid === "number" && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw invalid(`${label} is not owned by the runtime user`);
  }
  if ((stat.mode & 0o022) !== 0) throw invalid(`${label} is group/world writable`);
}

async function readHeader(handle: fs.FileHandle): Promise<Record<string, unknown>> {
  const buffer = Buffer.alloc(MAX_HEADER_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
  if (newline < 0) throw invalid("session header is missing or exceeds the bounded scan");
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
  } catch {
    throw invalid("session header is malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid("session header is malformed");
  return parsed as Record<string, unknown>;
}

async function inspectSessionFile(input: {
  sessionFile: string;
  sessionsRoot: string;
  expectedCwd: string;
  expectedSessionId?: string;
  expectedParent?: string;
}): Promise<{ identity: FileIdentity; header: Record<string, unknown> }> {
  const root = path.resolve(input.sessionsRoot);
  const sessionFile = path.resolve(input.sessionFile);
  if (!path.isAbsolute(input.sessionFile) || path.dirname(sessionFile) !== root) {
    throw invalid("session file is outside the managed session root");
  }
  await assertSecureDirectory(root, "managed session root");
  const before = await fs.lstat(sessionFile);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw invalid("session file must be a regular single-link file");
  }
  if (typeof before.uid === "number" && typeof process.getuid === "function" && before.uid !== process.getuid()) {
    throw invalid("session file is not owned by the runtime user");
  }
  if ((before.mode & 0o022) !== 0) throw invalid("session file is group/world writable");

  const handle = await fs.open(sessionFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== BigInt(before.dev) || opened.ino !== BigInt(before.ino)) {
      throw invalid("session file changed while opening");
    }
    const header = await readHeader(handle);
    if (header.type !== "session") throw invalid("session header type is invalid");
    const headerCwd = nonEmptyString(header.cwd);
    if (!headerCwd || path.resolve(headerCwd) !== path.resolve(input.expectedCwd)) {
      throw invalid("session cwd does not match the retained runtime context");
    }
    if (input.expectedSessionId && nonEmptyString(header.id) !== input.expectedSessionId) {
      throw invalid("session id does not match Pi state");
    }
    if (input.expectedParent && path.resolve(nonEmptyString(header.parentSession) ?? "") !== path.resolve(input.expectedParent)) {
      throw invalid("forked session does not name the retained parent file");
    }
    return {
      identity: {
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
        mtimeNs: opened.mtimeNs,
      },
      header,
    };
  } finally {
    await handle.close();
  }
}

function controlEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
    "HOMEDRIVE", "HOMEPATH", "USER", "USERNAME", "LOGNAME", "SHELL", "LANG",
    "LANGUAGE", "LC_ALL", "TZ", "TMPDIR", "TEMP", "TMP", "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME", "XDG_DATA_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ];
  return Object.fromEntries(allowed.flatMap((key) => typeof process.env[key] === "string" ? [[key, process.env[key]!]] : []));
}

function parseForkPoints(value: unknown): VectorPiForkPoint[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Pi fork-point response is malformed");
  const messages = (value as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || messages.length > 10_000) throw invalid("Pi fork-point response is malformed");
  return messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw invalid("Pi fork point is malformed");
    const entryId = nonEmptyString((message as Record<string, unknown>).entryId);
    const text = nonEmptyString((message as Record<string, unknown>).text) ?? "";
    if (!entryId || entryId.length > 256 || text.length > 2_000_000) throw invalid("Pi fork point is malformed");
    return { entryId, text };
  });
}

function parseState(value: unknown): VectorPiSessionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Pi state response is malformed");
  const record = value as Record<string, unknown>;
  const sessionFile = nonEmptyString(record.sessionFile);
  const sessionId = nonEmptyString(record.sessionId);
  if (!sessionFile || !path.isAbsolute(sessionFile) || !sessionId || sessionId.length > 256) {
    throw invalid("Pi state response is malformed");
  }
  return { sessionFile, sessionId };
}

async function runRpc(input: VectorPiSessionControlInput): Promise<VectorPiSessionControlResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw invalid("timeout is invalid");
  const entryId = input.action.type === "fork" ? input.action.entryId.trim() : "";
  if (input.action.type === "fork" && (!entryId || entryId.length > 256)) throw invalid("fork entry id is invalid");
  const command = process.env.PAPERCLIP_VECTOR_PI_COMMAND?.trim() || "pi";
  if (!command || command.includes("\0")) throw invalid("Pi command is invalid");
  const args = [
    "--mode", "rpc",
    "--no-builtin-tools",
    "--no-context-files",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    "--session", input.sessionFile,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: controlEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let settled = false;
    let points: VectorPiForkPoint[] | null = null;
    let state: VectorPiSessionState | null = null;
    let forked: { cancelled: boolean; text: string } | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (error) {
        if (!child.killed) child.kill("SIGTERM");
        reject(error);
        return;
      }
      if (!points || !state) {
        if (!child.killed) child.kill("SIGTERM");
        reject(invalid("Pi did not return complete session control state"));
        return;
      }
      const result = { points, state, ...(forked ? { forked } : {}) };
      const shutdownTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
      }, 2_000);
      child.once("close", () => {
        clearTimeout(shutdownTimer);
        resolve(result);
      });
    };
    const send = (id: string, type: string, fields: Record<string, unknown> = {}) => {
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    };
    const inspectLine = (line: string) => {
      if (!line.trim()) return;
      let value: unknown;
      try { value = JSON.parse(line); } catch { return; }
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const response = value as Record<string, unknown>;
      if (response.type !== "response") return;
      const id = nonEmptyString(response.id);
      if (!id) return;
      if (response.success !== true) {
        finish(invalid(`Pi ${nonEmptyString(response.command) ?? "control"} command failed`));
        return;
      }
      if (id === "points-before") {
        points = parseForkPoints(response.data);
        if (input.action.type === "fork") {
          if (!points.some((point) => point.entryId === entryId)) {
            finish(invalid("fork point is no longer on the active Pi branch"));
            return;
          }
          send("fork", "fork", { entryId });
        } else {
          send("state", "get_state");
        }
      } else if (id === "fork") {
        const data = response.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          finish(invalid("Pi fork response is malformed"));
          return;
        }
        const record = data as Record<string, unknown>;
        if (
          typeof record.cancelled !== "boolean" ||
          typeof record.text !== "string" ||
          record.text.length > MAX_OUTPUT_BYTES
        ) {
          finish(invalid("Pi fork response is malformed"));
          return;
        }
        forked = { cancelled: record.cancelled, text: record.text };
        send("points-after", "get_fork_messages");
        send("state", "get_state");
      } else if (id === "points-after") {
        points = parseForkPoints(response.data);
      } else if (id === "state") {
        state = parseState(response.data);
      }
      if (state && points && (input.action.type === "list" || forked)) finish();
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) return finish(invalid("Pi control stdout exceeded the bound"));
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) inspectLine(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_OUTPUT_BYTES) finish(invalid("Pi control stderr exceeded the bound"));
    });
    child.once("error", () => finish(invalid("Pi control process could not start")));
    child.once("close", (code) => {
      if (!settled) finish(invalid(`Pi control process exited before completion (${code ?? -1})`));
    });
    const timer = setTimeout(() => finish(invalid("Pi control process timed out")), timeoutMs);
    send("points-before", "get_fork_messages");
  });
}

export async function controlVectorPiSession(input: VectorPiSessionControlInput): Promise<VectorPiSessionControlResult> {
  if (!path.isAbsolute(input.cwd)) throw invalid("runtime cwd must be absolute");
  const sessionsRoot = path.resolve(input.sessionsRoot ?? path.join(os.homedir(), ".pi", "paperclips"));
  const source = await inspectSessionFile({
    sessionFile: input.sessionFile,
    sessionsRoot,
    expectedCwd: input.cwd,
  });
  const result = await runRpc({ ...input, sessionsRoot });
  const sourceAfter = await inspectSessionFile({
    sessionFile: input.sessionFile,
    sessionsRoot,
    expectedCwd: input.cwd,
  });
  if (
    sourceAfter.identity.dev !== source.identity.dev ||
    sourceAfter.identity.ino !== source.identity.ino ||
    sourceAfter.identity.size !== source.identity.size ||
    sourceAfter.identity.mtimeNs !== source.identity.mtimeNs
  ) {
    throw invalid("retained source session changed during control operation");
  }
  if (input.action.type === "list" || result.forked?.cancelled) {
    if (path.resolve(result.state.sessionFile) !== path.resolve(input.sessionFile)) {
      throw invalid("Pi changed the active session during a read-only operation");
    }
    await inspectSessionFile({
      sessionFile: result.state.sessionFile,
      sessionsRoot,
      expectedCwd: input.cwd,
      expectedSessionId: result.state.sessionId,
    });
    return result;
  }
  if (path.resolve(result.state.sessionFile) === path.resolve(input.sessionFile)) {
    throw invalid("Pi reported a successful fork without a new retained session file");
  }
  try {
    await inspectSessionFile({
      sessionFile: result.state.sessionFile,
      sessionsRoot,
      expectedCwd: input.cwd,
      expectedSessionId: result.state.sessionId,
      expectedParent: input.sessionFile,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Pi does not write a fork that has no retained history (the first prompt).
      throw invalid("Pi did not persist the forked session context", "fork_not_persisted");
    }
    throw error;
  }
  return result;
}

export async function removeVectorPiForkFile(input: {
  sessionFile: string;
  sessionsRoot?: string;
  cwd: string;
  sessionId: string;
  parentSessionFile: string;
}): Promise<void> {
  const sessionsRoot = path.resolve(input.sessionsRoot ?? path.join(os.homedir(), ".pi", "paperclips"));
  const inspected = await inspectSessionFile({
    sessionFile: input.sessionFile,
    sessionsRoot,
    expectedCwd: input.cwd,
    expectedSessionId: input.sessionId,
    expectedParent: input.parentSessionFile,
  });
  const beforeUnlink = await fs.lstat(input.sessionFile, { bigint: true });
  if (
    !beforeUnlink.isFile() ||
    beforeUnlink.nlink !== 1n ||
    beforeUnlink.dev !== inspected.identity.dev ||
    beforeUnlink.ino !== inspected.identity.ino
  ) {
    throw invalid("fork rollback path changed before cleanup");
  }
  await fs.unlink(input.sessionFile);
  try {
    const now = await fs.lstat(input.sessionFile);
    if (BigInt(now.dev) === inspected.identity.dev && BigInt(now.ino) === inspected.identity.ino) {
      throw invalid("fork rollback did not remove the retained session file");
    }
    throw invalid("fork rollback path was replaced during cleanup");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
