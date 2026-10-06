import fs from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isVectorFunkyServerProfile } from "@paperclipai/adapter-utils/vector-profiles";

const VERSION = 1 as const;
const MARKER_KEY = "vectorLegacyPiContext";
const DOMAIN = "paperclip-vector-legacy-pi-context/v1";
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
export type VectorLegacyService = "nexuslink-chat" | "funky";

export interface VectorLegacyPiContextScope {
  installationId: string;
  profileId: string;
  companyId: string;
  agentId: string;
  ownerSha256: string;
  externalSessionId: string;
  legacyService: VectorLegacyService;
  legacyPiSessionId: string;
}

export interface VectorLegacyPiContextMarker extends VectorLegacyPiContextScope {
  version: typeof VERSION;
  sourceSha256: string;
  sessionPath: string;
  headerCwd: string;
  receipt: string;
}

export interface VectorLegacyPiContextSessionParams extends Record<string, unknown> {
  sessionId: string;
  cwd: string;
  vectorLegacyPiContext: VectorLegacyPiContextMarker;
}

export interface StageVectorLegacyPiContextResult {
  sessionParams: VectorLegacyPiContextSessionParams;
  sourceSha256: string;
  replayed: boolean;
}

function invalid(message: string) {
  return new Error(`vector_legacy_context_invalid: ${message}`);
}

function conflict(message: string) {
  return new Error(`vector_legacy_context_conflict: ${message}`);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function absolute(value: string) {
  return value.length > 0 && value.length <= 4096 && path.isAbsolute(value) && !value.includes("\0");
}

function serviceForProfile(profileId: string): VectorLegacyService | null {
  if (profileId === "engineering" || profileId === "standard") return "nexuslink-chat";
  if (isVectorFunkyServerProfile(profileId)) return "funky";
  return null;
}

function validScope(scope: VectorLegacyPiContextScope) {
  return SAFE_ID.test(scope.installationId) &&
    SAFE_ID.test(scope.profileId) &&
    /^[0-9a-f-]{36}$/i.test(scope.companyId) &&
    /^[0-9a-f-]{36}$/i.test(scope.agentId) &&
    /^[0-9a-f]{64}$/.test(scope.ownerSha256) &&
    scope.externalSessionId.trim() === scope.externalSessionId &&
    scope.externalSessionId.length > 0 && scope.externalSessionId.length <= 512 &&
    !scope.externalSessionId.includes("\0") &&
    serviceForProfile(scope.profileId) === scope.legacyService &&
    SAFE_ID.test(scope.legacyPiSessionId);
}

function canonical(marker: Omit<VectorLegacyPiContextMarker, "receipt">) {
  return [DOMAIN, String(marker.version), marker.installationId, marker.profileId,
    marker.companyId, marker.agentId, marker.ownerSha256, marker.externalSessionId,
    marker.legacyService, marker.legacyPiSessionId, marker.sourceSha256,
    marker.sessionPath, marker.headerCwd].join("\n");
}

function sign(marker: Omit<VectorLegacyPiContextMarker, "receipt">, secret: string) {
  return `v1=${createHmac("sha256", secret).update(canonical(marker)).digest("hex")}`;
}

function parseMarker(raw: unknown): VectorLegacyPiContextMarker | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const keys = ["version", "installationId", "profileId", "companyId", "agentId",
    "ownerSha256", "externalSessionId", "legacyService", "legacyPiSessionId",
    "sourceSha256", "sessionPath", "headerCwd", "receipt"];
  if (!exactKeys(value, keys) || value.version !== VERSION) return null;
  for (const key of keys.slice(1)) if (typeof value[key] !== "string") return null;
  const marker = value as unknown as VectorLegacyPiContextMarker;
  return validScope(marker) && /^[0-9a-f]{64}$/.test(marker.sourceSha256) &&
    absolute(marker.sessionPath) && absolute(marker.headerCwd) &&
    /^v1=[0-9a-f]{64}$/.test(marker.receipt) ? marker : null;
}

export function readVectorLegacyPiContextMarker(params: Record<string, unknown> | null | undefined) {
  return parseMarker(params?.[MARKER_KEY]);
}

export function verifyVectorLegacyPiContextMarker(input: {
  marker: unknown;
  ingressSecret: string;
  expected: Pick<VectorLegacyPiContextScope, "installationId" | "profileId" | "companyId" | "agentId" | "ownerSha256" | "externalSessionId">;
  sessionPath: string;
}) {
  const marker = parseMarker(input.marker);
  if (!marker || input.ingressSecret.length < 32 || marker.sessionPath !== input.sessionPath) return false;
  for (const key of ["installationId", "profileId", "companyId", "agentId", "ownerSha256", "externalSessionId"] as const) {
    if (marker[key] !== input.expected[key]) return false;
  }
  const { receipt: _receipt, ...unsigned } = marker;
  const expected = Buffer.from(sign(unsigned, input.ingressSecret));
  const actual = Buffer.from(marker.receipt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function secureDirectory(dir: string, label: string) {
  if (!absolute(dir)) throw invalid(`${label} must be an absolute path`);
  const stat = await fs.lstat(dir).catch(() => null);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw invalid(`${label} is not a direct directory`);
  if (uid !== null && stat.uid !== uid) throw invalid(`${label} is not owned by the runtime user`);
  if ((stat.mode & 0o022) !== 0) throw invalid(`${label} is group/world writable`);
}

async function secureFileStat(stat: Stats, label: string) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw invalid(`${label} is not a direct regular file`);
  if (stat.nlink !== 1) throw invalid(`${label} has multiple hard links`);
  if (uid !== null && stat.uid !== uid) throw invalid(`${label} is not owned by the runtime user`);
  if ((stat.mode & 0o022) !== 0) throw invalid(`${label} is group/world writable`);
  if (stat.size <= 0 || stat.size > MAX_BYTES) throw invalid(`${label} has an unsupported size`);
}

function parseHeader(raw: Buffer, expectedId: string) {
  const newline = raw.indexOf(0x0a);
  if (newline < 0 || newline > MAX_HEADER_BYTES) throw invalid("legacy Pi JSONL has no bounded session header");
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw.subarray(0, newline).toString("utf8")); }
  catch { throw invalid("legacy Pi JSONL session header is invalid JSON"); }
  const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
  const cwd = typeof parsed.cwd === "string" ? parsed.cwd.trim() : "";
  if (parsed.type !== "session" || id !== expectedId || !absolute(cwd)) {
    throw invalid("legacy Pi JSONL header does not match the retained Pi session");
  }
  return cwd;
}

async function inspect(filePath: string, label: string, expectedId?: string) {
  const before = await fs.lstat(filePath).catch(() => null);
  if (!before) return null;
  await secureFileStat(before, label);
  const fd = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await fd.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw invalid(`${label} changed during secure open`);
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let header = Buffer.alloc(0);
    let count = 0;
    for (;;) {
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > MAX_BYTES) throw invalid(`${label} exceeds the import limit`);
      const bytes = chunk.subarray(0, bytesRead);
      digest.update(bytes);
      if (header.indexOf(0x0a) < 0) header = Buffer.concat([header, bytes.subarray(0, Math.max(0, MAX_HEADER_BYTES + 1 - header.length))]);
    }
    const after = await fd.stat();
    if (count !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw conflict(`${label} changed while reading`);
    return { digest: digest.digest("hex"), cwd: expectedId ? parseHeader(header, expectedId) : null };
  } finally { await fd.close(); }
}

export async function verifyVectorLegacyPiContextFile(input: {
  marker: unknown;
  ingressSecret: string;
  expected: Pick<VectorLegacyPiContextScope, "installationId" | "profileId" | "companyId" | "agentId" | "ownerSha256" | "externalSessionId">;
  sessionsRoot?: string;
}) {
  const marker = parseMarker(input.marker);
  if (!marker) return false;
  const root = path.resolve(input.sessionsRoot ?? path.join(os.homedir(), ".pi", "paperclips"));
  if (path.dirname(marker.sessionPath) !== root || !path.basename(marker.sessionPath).startsWith("vector-import-") ||
    !verifyVectorLegacyPiContextMarker({ marker, ingressSecret: input.ingressSecret, expected: input.expected, sessionPath: marker.sessionPath })) return false;
  try {
    await secureDirectory(root, "managed Pi session directory");
    const checked = await inspect(marker.sessionPath, "managed imported session", marker.legacyPiSessionId);
    return checked?.digest === marker.sourceSha256 && checked.cwd === marker.headerCwd;
  } catch { return false; }
}

export async function verifyVectorLegacyPiContextSource(input: {
  marker: unknown;
  sourceRoot: string;
}) {
  const marker = parseMarker(input.marker);
  if (!marker || !absolute(input.sourceRoot)) return false;
  try {
    const sourceRoot = path.resolve(input.sourceRoot);
    await secureDirectory(sourceRoot, "legacy session root");
    const sourceDir = path.join(sourceRoot, marker.legacyService);
    await secureDirectory(sourceDir, "legacy service session directory");
    const suffix = `_${marker.legacyPiSessionId}.jsonl`;
    const matches = (await fs.readdir(sourceDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix));
    if (matches.length !== 1) return false;
    const checked = await inspect(path.join(sourceDir, matches[0]!.name), "legacy Pi session", marker.legacyPiSessionId);
    return checked?.digest === marker.sourceSha256 && checked.cwd === marker.headerCwd;
  } catch {
    return false;
  }
}

async function copySession(sourcePath: string, sessionsRoot: string, key: string, expectedId: string) {
  const before = await fs.lstat(sourcePath);
  await secureFileStat(before, "legacy Pi session");
  const source = await fs.open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const tempPath = path.join(sessionsRoot, `.vector-import-${randomUUID()}.tmp`);
  const temp = await fs.open(tempPath, "wx", 0o600);
  let header = Buffer.alloc(0);
  let count = 0;
  const digest = createHash("sha256");
  try {
    const opened = await source.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw invalid("legacy Pi session changed during secure open");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await source.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > MAX_BYTES) throw invalid("legacy Pi session exceeds the import limit");
      const bytes = chunk.subarray(0, bytesRead);
      digest.update(bytes);
      if (header.indexOf(0x0a) < 0) header = Buffer.concat([header, bytes.subarray(0, Math.max(0, MAX_HEADER_BYTES + 1 - header.length))]);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await temp.write(bytes, offset, bytes.length - offset, null);
        if (bytesWritten <= 0) throw invalid("managed Pi session copy made no progress");
        offset += bytesWritten;
      }
    }
    const after = await source.stat();
    if (count !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw conflict("legacy Pi session changed while importing");
    }
    const cwd = parseHeader(header, expectedId);
    const sourceSha256 = digest.digest("hex");
    await temp.chmod(0o600); await temp.sync(); await temp.close();
    const destination = path.join(sessionsRoot, `${key}-${sourceSha256}.jsonl`);
    let replayed = false;
    try { await fs.link(tempPath, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await inspect(destination, "managed imported session");
      if (existing?.digest !== sourceSha256) throw conflict("managed imported session does not match the retained source digest");
      replayed = true;
    }
    return { destination, cwd, sourceSha256, replayed };
  } finally { await Promise.allSettled([source.close(), temp.close(), fs.unlink(tempPath)]); }
}

export async function stageVectorLegacyPiContext(input: VectorLegacyPiContextScope & {
  sourceRoot: string;
  ingressSecret: string;
  sessionsRoot?: string;
}): Promise<StageVectorLegacyPiContextResult> {
  if (!validScope(input)) throw invalid("owner or installation scope is malformed");
  if (input.ingressSecret.trim().length < 32) throw invalid("ingress authority is unavailable");
  if (!absolute(input.sourceRoot)) throw invalid("legacy session root must be an absolute path");
  const configuredRoot = input.sessionsRoot ?? path.join(os.homedir(), ".pi", "paperclips");
  if (!absolute(configuredRoot)) throw invalid("managed Pi session directory must be an absolute path");
  const sourceRoot = path.resolve(input.sourceRoot);
  const sessionsRoot = path.resolve(configuredRoot);
  await secureDirectory(sourceRoot, "legacy session root");
  const sourceDir = path.join(sourceRoot, input.legacyService);
  await secureDirectory(sourceDir, "legacy service session directory");
  await fs.mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  await secureDirectory(sessionsRoot, "managed Pi session directory");
  if (sourceDir === sessionsRoot) throw invalid("legacy and managed session roots must differ");
  const suffix = `_${input.legacyPiSessionId}.jsonl`;
  const matches = (await fs.readdir(sourceDir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(suffix));
  if (matches.length !== 1) throw invalid(matches.length ? "retained Pi session mapping is ambiguous" : "retained Pi session file was not found");
  const key = createHash("sha256").update([DOMAIN, input.installationId, input.profileId,
    input.companyId, input.agentId, input.ownerSha256, input.externalSessionId].join("\0")).digest("hex");
  const copied = await copySession(path.join(sourceDir, matches[0]!.name), sessionsRoot, `vector-import-${key}`, input.legacyPiSessionId);
  const unsigned: Omit<VectorLegacyPiContextMarker, "receipt"> = {
    version: VERSION, installationId: input.installationId, profileId: input.profileId,
    companyId: input.companyId, agentId: input.agentId, ownerSha256: input.ownerSha256,
    externalSessionId: input.externalSessionId, legacyService: input.legacyService,
    legacyPiSessionId: input.legacyPiSessionId, sourceSha256: copied.sourceSha256,
    sessionPath: copied.destination, headerCwd: copied.cwd,
  };
  const marker = { ...unsigned, receipt: sign(unsigned, input.ingressSecret) };
  return { sessionParams: { sessionId: copied.destination, cwd: copied.cwd, vectorLegacyPiContext: marker }, sourceSha256: copied.sourceSha256, replayed: copied.replayed };
}
