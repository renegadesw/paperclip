import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetFile,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolveLegacyPaperclipDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  renderTemplate,
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
  isPaperclipRecoveryWakePayload,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { extractPiRuntimeEvents, isPiUnknownSessionError, parsePiJsonl } from "./parse.js";
import { ensurePiModelConfiguredAndAvailable } from "./models.js";
import { preparePiRuntimeConfig } from "./runtime-config.js";
import { buildPiBuiltinToolArgs } from "./tools.js";
import {
  isPaperclipControllerShellEnvKey,
  isVectorPiInstallation,
  prepareVectorPiProfilePolicy,
  vectorPiPolicyToolNames,
  withPaperclipConnectorTools,
} from "./vector-profile-policy.js";
import { prepareVectorToolCapability } from "./vector-tool-capability.js";
import { PAPERCLIP_CONNECTOR_TOOLS_ENV, prepareConnectorTools } from "./paperclip-connectors.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { appendVectorVoiceContext } from "./vector-voice-context.js";
import { COMPACT_VECTOR_TASK_FALLBACK, useCompactVectorTaskPrompt } from "./vector-compact-prompt.js";
import {
  readPaperclipConnectorSkillInstructions,
  resolveVectorPlainConversationMessage,
} from "./vector-plain-conversation.js";
import {
  buildPiRpcPrompt,
  parseVectorIngressImages,
  redactVectorIngressImages,
  sanitizePiOutput,
  sanitizePiOutputLine,
} from "./vector-images.js";
import {
  readVectorLegacyPiContextMarker,
  verifyVectorLegacyPiContextFile,
} from "./vector-legacy-context.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// The connector extension ships inside this adapter package (dist/ in the
// runtime, src/ under test); agent config cannot choose it.
async function resolvePaperclipConnectorExtensionPath(): Promise<string> {
  for (const candidate of ["paperclip-connectors.js", "paperclip-connectors.ts"]) {
    const resolved = path.resolve(__moduleDir, "..", "vector-extensions", candidate);
    if (await fs.stat(resolved).then((stat) => stat.isFile(), () => false)) return resolved;
  }
  throw new Error("The Paperclip connector extension is missing from the Pi adapter package");
}

const PAPERCLIP_SESSIONS_DIR = path.join(os.homedir(), ".pi", "paperclips");
const PI_AGENT_SKILLS_DIR = path.join(os.homedir(), ".pi", "agent", "skills");

export function canResumePiSession(input: {
  sessionId: string;
  targetMatches: boolean;
  sessionParamsCwdMatches: boolean;
  sessionHeaderCwdMatches: boolean;
  legacyContextAuthorized: boolean;
}) {
  return input.sessionId.length > 0 && input.targetMatches &&
    (input.legacyContextAuthorized ||
      (input.sessionParamsCwdMatches && input.sessionHeaderCwdMatches));
}

const VECTOR_PI_INHERITED_ENV_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USER", "USERNAME",
  "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "TZ", "TMPDIR", "TEMP", "TMP",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE_URL",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY",
  "OLLAMA_HOST", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE", "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
]);

const VECTOR_PI_EXPLICIT_ENV_KEYS = new Set([
  ...VECTOR_PI_INHERITED_ENV_KEYS,
  "AGENT_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_BUILTIN_MODELS_PATH",
  "PI_VAULT_REFERENCE_ROOT",
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_ISSUE_WORK_MODE",
  "PAPERCLIP_WAKE_REASON",
  "PAPERCLIP_WAKE_COMMENT_ID",
  "PAPERCLIP_APPROVAL_ID",
  "PAPERCLIP_APPROVAL_STATUS",
  "PAPERCLIP_LINKED_ISSUE_IDS",
  "PAPERCLIP_WAKE_PAYLOAD_JSON",
  "PAPERCLIP_VECTOR_TOOL_AUTHORITY_FILE",
  PAPERCLIP_CONNECTOR_TOOLS_ENV,
]);

// Paperclip's managed GitHub identity reaches the shell through run-scoped
// git/gh launchers on PATH plus a broker URL/token and Git hardening
// (prepareGitHubOperationLaunchers). Only engineering holds Pi's bash, so only
// engineering forwards them; restricted profiles strip them (see below).

function vectorPiExplicitEnvKeyAllowed(key: string): boolean {
  return VECTOR_PI_EXPLICIT_ENV_KEYS.has(key)
    || key.startsWith("PAPERCLIP_RUNTIME_TOOLS_")
    || key.startsWith("PAPERCLIP_WORKSPACE_");
}

export function projectVectorEmbeddedPiEnvironment(
  inherited: NodeJS.ProcessEnv,
  explicit: Record<string, string>,
  options: { githubLaunchers?: boolean } = {},
): Record<string, string> {
  const projected: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (VECTOR_PI_INHERITED_ENV_KEYS.has(key) && typeof value === "string") {
      projected[key] = value;
    }
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (vectorPiExplicitEnvKeyAllowed(key) || (options.githubLaunchers && isPaperclipControllerShellEnvKey(key))) {
      projected[key] = value;
    }
  }
  return projected;
}

// Pi's RPC mode is intentionally driven through a tiny Node supervisor instead
// of piping a prompt directly into the CLI. Closing Pi's stdin immediately
// after the prompt races the asynchronous turn: Pi accepts the command and can
// then exit before the provider emits an assistant message. The supervisor
// keeps stdin open until Pi reports the authoritative `agent_settled` event,
// then closes it so the one-heartbeat process exits normally. Because the
// supervisor and Pi share a process group, Paperclip's existing run cancellation
// still terminates the complete tree.
const PI_RPC_TURN_SUPERVISOR = String.raw`
const { spawn } = require("node:child_process");

const piCommand = process.argv[1];
const piArgs = JSON.parse(process.argv[2]);
const captureNonce = process.argv[3];
const child = spawn(piCommand, piArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

let input = "";
let stdoutBuffer = "";
let stdinClosed = false;
let finalCaptureStarted = false;
let promptAccepted = false;
let afterMessages = null;
let finalState = null;
let captureTimer = null;

function closeChildStdin() {
  if (stdinClosed) return;
  stdinClosed = true;
  child.stdin.end();
}

function sendCommand(command) {
  if (stdinClosed || child.killed || child.stdin.destroyed) return;
  child.stdin.write(JSON.stringify(command) + "\n");
}

function beginFinalCapture() {
  if (finalCaptureStarted) return;
  finalCaptureStarted = true;
  sendCommand({ id: "paperclip-vector-after", type: "get_fork_messages" });
  sendCommand({ id: "paperclip-vector-state", type: "get_state" });
  captureTimer = setTimeout(closeChildStdin, 500);
}

function maybeFinishCapture() {
  if (!afterMessages || !finalState) return;
  const promptEntry = promptAccepted ? afterMessages[afterMessages.length - 1] : null;
  if (
    typeof promptEntry?.entryId === "string" &&
    typeof finalState.sessionFile === "string" &&
    typeof finalState.sessionId === "string"
  ) {
    process.stdout.write(JSON.stringify({
      type: "paperclip_vector_session_state",
      nonce: captureNonce,
      promptEntryId: promptEntry.entryId,
      sessionFile: finalState.sessionFile,
      sessionId: finalState.sessionId,
    }) + "\n");
  }
  closeChildStdin();
}

function inspectLine(line) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    if (event.type === "agent_settled") beginFinalCapture();
    if (
      event.type === "response" &&
      event.command === "prompt" &&
      event.success === false
    ) beginFinalCapture();
    if (event.type === "response" && event.command === "prompt" && event.success === true) {
      promptAccepted = true;
    }
    if (event.type === "response" && event.id === "paperclip-vector-after") {
      afterMessages = Array.isArray(event.data?.messages) ? event.data.messages : [];
      maybeFinishCapture();
    }
    if (event.type === "response" && event.id === "paperclip-vector-state") {
      finalState = event.data && typeof event.data === "object" ? event.data : {};
      maybeFinishCapture();
    }
  } catch {
    // Pi owns stdout. Forward malformed/non-JSON lines unchanged and let the
    // adapter parser decide whether they are meaningful.
  }
}

child.stdout.on("data", (chunk) => {
  const text = String(chunk);
  process.stdout.write(text);
  stdoutBuffer += text;
  const lines = stdoutBuffer.split("\n");
  stdoutBuffer = lines.pop() || "";
  for (const line of lines) inspectLine(line);
});
child.stdout.on("end", () => inspectLine(stdoutBuffer));
child.stderr.pipe(process.stderr);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (!child.killed && !child.stdin.destroyed) child.stdin.write(input);
});

child.on("error", (error) => {
  process.stderr.write("[paperclip] Failed to start Pi RPC child: " + error.message + "\n");
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  if (captureTimer) clearTimeout(captureTimer);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
`;

export interface VectorPiTurnSessionState {
  promptEntryId: string;
  sessionFile: string;
  sessionId: string;
}

export function extractVectorPiTurnSessionState(
  stdout: string,
  nonce: string,
): VectorPiTurnSessionState | null {
  let resolved: VectorPiTurnSessionState | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (record.type !== "paperclip_vector_session_state" || record.nonce !== nonce) continue;
    const promptEntryId = typeof record.promptEntryId === "string" ? record.promptEntryId.trim() : "";
    const sessionFile = typeof record.sessionFile === "string" ? record.sessionFile.trim() : "";
    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
    if (
      !promptEntryId || promptEntryId.length > 256 ||
      !path.isAbsolute(sessionFile) || sessionFile.length > 4096 ||
      !sessionId || sessionId.length > 256
    ) continue;
    resolved = { promptEntryId, sessionFile, sessionId };
  }
  return resolved;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function parseModelId(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return trimmed || null;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim() || null;
}

async function ensurePiSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
) {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;
  await fs.mkdir(PI_AGENT_SKILLS_DIR, { recursive: true });
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    PI_AGENT_SKILLS_DIR,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Pi skill "${skillName}" from ${PI_AGENT_SKILLS_DIR}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(PI_AGENT_SKILLS_DIR, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Pi skill "${entry.runtimeName}" into ${PI_AGENT_SKILLS_DIR}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Pi skill "${entry.runtimeName}" into ${PI_AGENT_SKILLS_DIR}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function buildPiSkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-skills-"));
  const target = path.join(tmp, "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(resolveLegacyPaperclipDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return target;
}

function resolvePiBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

async function ensureSessionsDir(): Promise<string> {
  await fs.mkdir(PAPERCLIP_SESSIONS_DIR, { recursive: true });
  return PAPERCLIP_SESSIONS_DIR;
}

function buildSessionPath(agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.join(PAPERCLIP_SESSIONS_DIR, `${safeTimestamp}-${agentId}.jsonl`);
}

function buildRemoteSessionPath(runtimeRootDir: string, agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.posix.join(runtimeRootDir, "sessions", `${safeTimestamp}-${agentId}.jsonl`);
}

export function appendVectorWorkloadSystemPrompt(
  base: string,
  rawLaunch: unknown,
): string {
  const vectorWorkloadLaunch = parseObject(rawLaunch);
  if (Object.keys(vectorWorkloadLaunch).length === 0) return base;
  const schemaVersion = vectorWorkloadLaunch.schemaVersion;
  const workloadKey = asString(vectorWorkloadLaunch.workloadKey, "").trim();
  const taskId = asString(vectorWorkloadLaunch.taskId, "").trim();
  const dynamicSystemPrompt = asString(vectorWorkloadLaunch.systemPrompt, "").trim();
  if (schemaVersion !== 1 || !workloadKey || !taskId || !dynamicSystemPrompt) {
    throw new Error("Signed Vector workload launch context is malformed.");
  }
  return joinPromptSections([
    base,
    "Vector OS admitted the following workload system instructions through the signed, installation-scoped ingress. They apply only to this run and remain subordinate to Paperclip's deployment and agent safety policy.",
    dynamicSystemPrompt,
  ]);
}

export function appendVectorRoleSystemPrompt(base: string, rawRole: unknown): string {
  const vectorRoleTurn = parseObject(rawRole);
  if (Object.keys(vectorRoleTurn).length === 0) return base;
  const schemaVersion = vectorRoleTurn.schemaVersion;
  const role = asString(vectorRoleTurn.role, "").trim();
  const dynamicSystemPrompt = asString(vectorRoleTurn.systemPrompt, "").trim();
  if (schemaVersion !== 1 || !role || !dynamicSystemPrompt || vectorRoleTurn.noBuiltinTools !== true) {
    throw new Error("Signed Vector role turn context is malformed.");
  }
  return joinPromptSections([
    base,
    "Vector OS admitted the following product role instructions through the signed, installation-scoped ingress. They apply only to this turn and remain subordinate to Paperclip's deployment and agent safety policy.",
    dynamicSystemPrompt,
  ]);
}

export function appendVectorPersonaSystemPrompt(base: string, rawPersona: unknown): string {
  const vectorPersonaTurn = parseObject(rawPersona);
  if (Object.keys(vectorPersonaTurn).length === 0) return base;
  const schemaVersion = vectorPersonaTurn.schemaVersion;
  const personaId = asString(vectorPersonaTurn.personaId, "").trim();
  const personaVersion = asString(vectorPersonaTurn.personaVersion, "").trim();
  const dynamicSystemPrompt = asString(vectorPersonaTurn.systemPrompt, "").trim();
  if (
    schemaVersion !== 1 || !personaId || !/^[a-f0-9]{12}$/.test(personaVersion) ||
    !dynamicSystemPrompt || vectorPersonaTurn.noBuiltinTools !== true
  ) {
    throw new Error("Signed Vector persona turn context is malformed.");
  }
  return joinPromptSections([
    base,
    "Vector OS admitted this selected standard-chat persona through the signed, installation-scoped ingress. It applies to this conversation and remains subordinate to Paperclip's deployment and agent safety policy.",
    dynamicSystemPrompt,
  ]);
}

export function resolveVectorRuntimeSelection(
  configuredModel: string,
  configuredThinking: string,
  rawSelection: unknown,
): { model: string; thinking: string } {
  const selection = parseObject(rawSelection);
  if (Object.keys(selection).length === 0) return { model: configuredModel, thinking: configuredThinking };
  const model = asString(selection.model, "").trim();
  const thinking = asString(selection.thinking, "").trim();
  const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
  if (!configuredModel.startsWith("router/") || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(model) || !levels.has(thinking)) {
    throw new Error("Signed Vector runtime selection is malformed or widens the configured provider.");
  }
  return { model: `router/${model}`, thinking };
}

function normalizeExecutionCwd(candidate: string, remote: boolean): string {
  return remote ? path.posix.normalize(candidate) : path.resolve(candidate);
}

function executionCwdsMatch(saved: string, current: string, remote: boolean): boolean {
  return normalizeExecutionCwd(saved, remote) === normalizeExecutionCwd(current, remote);
}

function readSessionHeaderCwd(raw: string): string | null {
  const headerLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!headerLine) return null;
  try {
    const parsed = JSON.parse(headerLine) as Record<string, unknown>;
    if (parsed.type !== "session") return null;
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd.trim() : "";
    return cwd.length > 0 ? cwd : null;
  } catch {
    return null;
  }
}

async function readSavedSessionCwd(input: {
  runId: string;
  sessionPath: string;
  executionTarget: ReturnType<typeof readAdapterExecutionTarget>;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<string | null> {
  if (!input.sessionPath.trim()) return null;

  if (!adapterExecutionTargetIsRemote(input.executionTarget)) {
    try {
      return readSessionHeaderCwd(await fs.readFile(input.sessionPath, "utf8"));
    } catch {
      return null;
    }
  }

  try {
    const sessionHeader = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.executionTarget,
      `if [ -f ${shellQuote(input.sessionPath)} ]; then head -n 1 ${shellQuote(input.sessionPath)}; fi`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec > 0 ? Math.min(input.timeoutSec, 15) : 15,
        graceSec: input.graceSec,
      },
    );
    if (sessionHeader.timedOut || (sessionHeader.exitCode ?? 0) !== 0) return null;
    return readSessionHeaderCwd(sessionHeader.stdout);
  } catch {
    return null;
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const vectorIngressImages = parseVectorIngressImages(context.vectorIngressImages);
  const sensitiveImageData = vectorIngressImages.map((image) => image.data);
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const compactTaskPrompt = useCompactVectorTaskPrompt(process.env.PAPERCLIP_VECTOR_PROFILE, config, context);
  const promptTemplate = asString(
    config.promptTemplate,
    compactTaskPrompt ? "" : context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const deploymentPiCommand = process.env.PAPERCLIP_VECTOR_PI_COMMAND?.trim() || undefined;
  const command = asString(config.command, deploymentPiCommand ?? "pi");
  const configuredModel = asString(config.model, "").trim();
  const configuredThinking = asString(config.thinking, "").trim();
  const { model, thinking } = resolveVectorRuntimeSelection(
    configuredModel, configuredThinking, context.vectorRuntimeSelection,
  );
  const executionMode = asString(
    config.executionMode,
    process.env.PAPERCLIP_PI_EXECUTION_MODE ?? "json",
  ).trim();
  if (executionMode !== "json" && executionMode !== "rpc") {
    throw new Error(
      `Unsupported Pi executionMode "${executionMode}". Expected "json" or "rpc".`,
    );
  }
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  let vectorProfilePolicy = await prepareVectorPiProfilePolicy({
    profile: process.env.PAPERCLIP_VECTOR_PROFILE,
    config,
    extraArgs,
    packagedExtensionsJson: process.env.PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS,
    command,
    deploymentCommand: deploymentPiCommand,
    agentConfiguredEnv: parseObject(parseObject(agent.adapterConfig).env),
    vectorInstallation: isVectorPiInstallation(),
  });

  // Parse model into provider and model id
  const provider = parseModelProvider(model);
  const modelId = parseModelId(model);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  if (!executionTargetIsRemote) {
    await ensureSessionsDir();
  }

  // Restricted Vector profiles deliberately ignore runtime skill paths and
  // selections carried in mutable agent config. The bundled Paperclip
  // operational skill remains mounted explicitly below, even while Pi's
  // ambient skill discovery is disabled.
  const runtimeSkillConfig = vectorProfilePolicy.useBundledPaperclipSkillsOnly ? {} : config;
  const piSkillEntries = await readPaperclipRuntimeSkillEntries(runtimeSkillConfig, __moduleDir);
  const desiredPiSkillNames = resolveLegacyPaperclipDesiredSkillNames(
    runtimeSkillConfig,
    piSkillEntries,
  );
  if (!executionTargetIsRemote && !vectorProfilePolicy.restricted) {
    await ensurePiSkillsInjected(onLog, piSkillEntries, desiredPiSkillNames);
  }

  // Build environment
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
    
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  if (vectorProfilePolicy.restricted) {
    // No shell on restricted profiles: the controller's git/gh launcher
    // environment has nothing to serve and must not shape the Pi process.
    for (const key of Object.keys(env)) {
      if (isPaperclipControllerShellEnvKey(key)) delete env[key];
    }
  }
  // Materialize custom Pi providers (PAPERCLIP_PI_PROVIDERS) into a managed
  // PI_CODING_AGENT_DIR before runtimeEnv is computed, so both local validation
  // and the spawned Pi process resolve models against the managed models.json.
  const preparedRuntimeConfig = await preparePiRuntimeConfig({
    env,
    forceManagedAgentDir: vectorProfilePolicy.restricted,
    vectorProviderAuthority: ctx.vectorProviderAuthority,
  });
  const localAgentConfigDir = preparedRuntimeConfig.agentConfigDir ?? "";
  if (localAgentConfigDir) {
    env.PI_CODING_AGENT_DIR = localAgentConfigDir;
  }
  let cleanupVectorToolCapability: () => Promise<void> = async () => undefined;
  let cleanupConnectorTools: () => Promise<void> = async () => undefined;
  try {
    const vectorToolCapability = await prepareVectorToolCapability(
      ctx.vectorToolAuthority,
      { remote: executionTargetIsRemote },
    );
    cleanupVectorToolCapability = vectorToolCapability.cleanup;
    Object.assign(env, vectorToolCapability.env);
    // Granted Paperclip connections (GitHub, Google, ...) as Pi tools, on
    // every profile. See paperclip-connectors.ts.
    const connectorServers = ctx.runtimeMcp?.getServers() ?? [];
    if (connectorServers.length > 0 && executionTargetIsRemote) {
      await onLog("stderr", "[paperclip] Paperclip connector tools are not delivered to remote Pi targets.\n");
    }
    const connectorTools = await prepareConnectorTools(
      connectorServers,
      ["read", "bash", "edit", "write", "grep", "find", "ls", ...vectorPiPolicyToolNames(vectorProfilePolicy), ...(ctx.vectorToolAuthority?.tools ?? [])],
      {
        remote: executionTargetIsRemote,
        onError: (server, error) => {
          void onLog("stderr", `[paperclip] Connector "${server.name}" tools unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
        },
      },
    );
    cleanupConnectorTools = connectorTools.cleanup;
    Object.assign(env, connectorTools.env);
    if (connectorTools.toolNames.length > 0) {
      vectorProfilePolicy = withPaperclipConnectorTools(
        vectorProfilePolicy,
        await resolvePaperclipConnectorExtensionPath(),
        connectorTools.toolNames,
      );
      await onLog("stdout", `[paperclip] Delivering ${connectorTools.toolNames.length} Paperclip connector tool(s) from ${connectorServers.length} granted connection(s).\n`);
    }
    // Prepend installed skill `bin/` dirs to PATH so an agent's bash tool can
    // invoke skill binaries (e.g. `paperclip-get-issue`) by name. Without this,
    // any pi_local agent whose AGENTS.md calls a skill command via bash hits
    // exit 127 "command not found". Only include skills that ensurePiSkillsInjected
    // actually linked — otherwise non-injected skills' binaries would be reachable
    // to the agent.
    const injectedSkillKeys = new Set(desiredPiSkillNames);
    const skillBinDirs = piSkillEntries
      .filter((entry) => injectedSkillKeys.has(entry.key) && entry.source.length > 0)
      .map((entry) => path.join(entry.source, "bin"));
    const vectorEmbeddedRpc = executionMode === "rpc"
      && process.env.PAPERCLIP_DATABASE_PROFILE?.trim() === "vector-embedded";
    const mergedEnv = ensurePathInEnv(
      vectorEmbeddedRpc
        ? projectVectorEmbeddedPiEnvironment(process.env, env, { githubLaunchers: vectorProfilePolicy.profile === "engineering" })
        : { ...process.env, ...env },
    );
    const pathKey =
      typeof mergedEnv.Path === "string" && mergedEnv.Path.length > 0 && !mergedEnv.PATH
        ? "Path"
        : "PATH";
    const basePath = mergedEnv[pathKey] ?? "";
    if (skillBinDirs.length > 0) {
      const existing = basePath.split(path.delimiter).filter(Boolean);
      const additions = skillBinDirs.filter((dir) => !existing.includes(dir));
      if (additions.length > 0) {
        mergedEnv[pathKey] = [...additions, basePath].filter(Boolean).join(path.delimiter);
      }
    }
    const runtimeEnv = Object.fromEntries(
      Object.entries(mergedEnv).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: SANDBOX_INSTALL_COMMAND,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    let loggedEnv = buildInvocationEnvForLogs(env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });
    delete loggedEnv.PAPERCLIP_VECTOR_TOOL_AUTHORITY_FILE;
    delete loggedEnv[PAPERCLIP_CONNECTOR_TOOLS_ENV];

    if (!executionTargetIsRemote) {
      await ensurePiModelConfiguredAndAvailable({
        model,
        command,
        cwd,
        env: runtimeEnv,
        extraArgs: vectorProfilePolicy.discoveryCliArgs,
      });
    }

    let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
    let remoteRuntimeRootDir: string | null = null;
    let localSkillsDir: string | null = null;
    let remoteSkillsDir: string | null = null;
    let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

    if (vectorProfilePolicy.restricted && !executionTargetIsRemote) {
      localSkillsDir = await buildPiSkillsDir(runtimeSkillConfig);
    }

    if (executionTargetIsRemote) {
      try {
        localSkillsDir = await buildPiSkillsDir(runtimeSkillConfig);
        await onLog(
          "stdout",
          `[paperclip] Syncing workspace and Pi runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        const preparedRemoteRuntime = await prepareAdapterExecutionTargetRuntime({
          runId,
          target: executionTarget,
          adapterKey: "pi",
          timeoutSec,
          workspaceLocalDir: cwd,
          installCommand: SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          onProgress: (line) => onLog("stdout", line),
          onRuntimeProgress: ctx.onRuntimeProgress,
          assets: [
            {
              key: "skills",
              localDir: localSkillsDir,
              followSymlinks: true,
            },
            ...(localAgentConfigDir
              ? [{
                key: "agentConfig",
                localDir: localAgentConfigDir,
              }]
              : []),
          ],
        });
        restoreRemoteWorkspace = () =>
          preparedRemoteRuntime.restoreWorkspace((line) => onLog("stdout", line));
        effectiveExecutionCwd = preparedRemoteRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
        refreshPaperclipWorkspaceEnvForExecution({
          env,
          envConfig,
          workspaceCwd: effectiveWorkspaceCwd,
          workspaceSource,
          workspaceId,
          workspaceRepoUrl,
          workspaceRepoRef,
          workspaceHints,
          agentHome,
          executionTargetIsRemote,
          executionCwd: effectiveExecutionCwd,
        });
        if (adapterExecutionTargetUsesManagedHome(executionTarget) && preparedRemoteRuntime.runtimeRootDir) {
          env.HOME = preparedRemoteRuntime.runtimeRootDir;
        }
        remoteRuntimeRootDir = preparedRemoteRuntime.runtimeRootDir;
        remoteSkillsDir = preparedRemoteRuntime.assetDirs.skills ?? null;
        if (localAgentConfigDir && preparedRemoteRuntime.assetDirs.agentConfig) {
          env.PI_CODING_AGENT_DIR = preparedRemoteRuntime.assetDirs.agentConfig;
        }
      } catch (error) {
        await Promise.allSettled([
          restoreRemoteWorkspace?.(),
          localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
        ]);
        throw error;
      }
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "pi",
        timeoutSec,
        hostApiToken: env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(env, paperclipBridge.env);
        loggedEnv = buildInvocationEnvForLogs(env, {
          runtimeEnv: Object.fromEntries(
            Object.entries(ensurePathInEnv(
              vectorEmbeddedRpc
                ? projectVectorEmbeddedPiEnvironment(process.env, env, { githubLaunchers: vectorProfilePolicy.profile === "engineering" })
                : { ...process.env, ...env },
            )).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          includeRuntimeKeys: ["HOME"],
          resolvedCommand,
        });
        delete loggedEnv.PAPERCLIP_VECTOR_TOOL_AUTHORITY_FILE;
    delete loggedEnv[PAPERCLIP_CONNECTOR_TOOLS_ENV];
      }
    }

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const sessionTargetMatches = adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const rawLegacyContext = runtimeSessionParams.vectorLegacyPiContext;
    const legacyContext = readVectorLegacyPiContextMarker(runtimeSessionParams);
    const legacyRunBinding = parseObject(context.vectorLegacyPiContextBinding);
    if (rawLegacyContext !== undefined && !legacyContext) {
      throw new Error("Vector legacy Pi context marker is malformed");
    }
    let legacyContextAuthorized = false;
    if (legacyContext) {
      if (executionTargetIsRemote) {
        throw new Error("Vector legacy Pi context cannot be resumed on a remote execution target");
      }
      const ingressSecret = process.env.PAPERCLIP_VECTOR_INGRESS_SECRET?.trim() ?? "";
      const installationId = process.env.PAPERCLIP_VECTOR_INSTALLATION_ID?.trim() ?? "";
      const profileId = process.env.PAPERCLIP_VECTOR_PROFILE?.trim() ?? "";
      legacyContextAuthorized = await verifyVectorLegacyPiContextFile({
        marker: legacyContext,
        ingressSecret,
        expected: {
          installationId,
          profileId,
          companyId: agent.companyId,
          agentId: agent.id,
          ownerSha256: asString(legacyRunBinding.ownerSha256, ""),
          externalSessionId: asString(legacyRunBinding.externalSessionId, ""),
        },
      });
      if (!legacyContextAuthorized || runtimeSessionId !== legacyContext.sessionPath) {
        throw new Error("Vector legacy Pi context authority or retained bytes do not match this run");
      }
    }
    const sessionParamsCwdMatches =
      runtimeSessionCwd.length === 0 ||
      executionCwdsMatch(runtimeSessionCwd, effectiveExecutionCwd, executionTargetIsRemote);
    const savedSessionCwd =
      runtimeSessionId.length > 0
        ? await readSavedSessionCwd({
            runId,
            sessionPath: runtimeSessionId,
            executionTarget: runtimeExecutionTarget ?? null,
            cwd,
            env,
            timeoutSec,
            graceSec,
          })
        : null;
    const sessionHeaderCwdMatches =
      runtimeSessionId.length === 0 ||
      (savedSessionCwd !== null &&
        executionCwdsMatch(savedSessionCwd, effectiveExecutionCwd, executionTargetIsRemote));
    const canResumeSession = canResumePiSession({
      sessionId: runtimeSessionId,
      targetMatches: sessionTargetMatches,
      sessionParamsCwdMatches,
      sessionHeaderCwdMatches,
      legacyContextAuthorized,
    });
    const sessionPath = canResumeSession
      ? runtimeSessionId
      : executionTargetIsRemote && remoteRuntimeRootDir
        ? buildRemoteSessionPath(remoteRuntimeRootDir, agent.id, new Date().toISOString())
        : buildSessionPath(agent.id, new Date().toISOString());

    if (runtimeSessionId && !canResumeSession) {
      const staleSessionCwdNote =
        savedSessionCwd !== null && !sessionHeaderCwdMatches
          ? ` Pi stored cwd "${savedSessionCwd}" in the session header, so Paperclip will start a fresh session for "${effectiveExecutionCwd}".`
          : "";
      await onLog(
        "stdout",
        executionTargetIsRemote
          ? `[paperclip] Pi session "${runtimeSessionId}" does not match the current remote execution state and will not be resumed in "${effectiveExecutionCwd}".${staleSessionCwdNote} Starting a fresh remote session.\n`
          : `[paperclip] Pi session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".${staleSessionCwdNote}\n`,
      );
    }

    if (!canResumeSession) {
      if (executionTargetIsRemote) {
        await ensureAdapterExecutionTargetFile(runId, runtimeExecutionTarget, sessionPath, {
          cwd,
          env,
          timeoutSec: 15,
          graceSec: 5,
          onLog,
        });
      } else {
        try {
          await fs.writeFile(sessionPath, "", { flag: "wx" });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
            throw err;
          }
        }
      }
    }

    // Handle instructions file and build system prompt extension
    // Restricted profiles read only the release-owned file the profile policy
    // admitted (its real path), never the raw configured value.
    const instructionsFilePath = vectorProfilePolicy.restricted
      ? vectorProfilePolicy.instructionsFilePath ?? ""
      : asString(config.instructionsFilePath, "").trim();
    const resolvedInstructionsFilePath = instructionsFilePath
      ? path.resolve(cwd, instructionsFilePath)
      : "";
    const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";

    // Vector conversation turns reach Pi as the user's plain message, like the
    // legacy `pi --mode rpc` chat. It needs the agent's own instructions; any
    // turn this cannot reproduce exactly keeps the Paperclip wake prompt.
    const vectorPlainConversation = resolveVectorPlainConversationMessage({
      vectorProfile: process.env.PAPERCLIP_VECTOR_PROFILE,
      context,
    });
    let plainConversationMessage: string | null = null;
    // Connector skill docs move from the wake prompt to the system prompt so
    // the user message stays verbatim.
    const plainConversationSystemBase = (instructionsContents: string) => {
      const connectorSkillInstructions = readPaperclipConnectorSkillInstructions(context.paperclipWake);
      return joinPromptSections([
        instructionsContents,
        connectorSkillInstructions ? `## Assigned connector skills\n\n${connectorSkillInstructions}` : "",
      ]);
    };

    let systemPromptExtension = "";
    let instructionsReadFailed = false;
    if (resolvedInstructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
        if (vectorPlainConversation.plain) {
          plainConversationMessage = vectorPlainConversation.message;
          // The Vector release instructions carry no relative file references,
          // so neither the path directive nor Paperclip's heartbeat/conversation
          // template is appended.
          systemPromptExtension = plainConversationSystemBase(instructionsContents);
        } else if (compactTaskPrompt) {
          systemPromptExtension = `${instructionsContents.trim()}\n\nInstruction base: ${instructionsFileDir}`;
        } else {
          systemPromptExtension =
            `${instructionsContents}\n\n` +
            `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
            `Resolve any relative file references from ${instructionsFileDir}.\n\n` +
            (context.conversationMode === true
              ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
              : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
        }
      } catch (err) {
        instructionsReadFailed = true;
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
        );
        // Fall back to base prompt template
        systemPromptExtension = compactTaskPrompt ? COMPACT_VECTOR_TASK_FALLBACK : promptTemplate;
      }
    } else if (
      vectorPlainConversation.plain &&
      (Object.keys(parseObject(context.vectorPersonaTurn)).length > 0 ||
        Object.keys(parseObject(context.vectorRoleTurn)).length > 0)
    ) {
      // No instructions file (restricted agents without a release asset): the
      // admitted persona/role appended below is the agent's instructions.
      plainConversationMessage = vectorPlainConversation.message;
      systemPromptExtension = plainConversationSystemBase("");
    } else {
      systemPromptExtension = compactTaskPrompt ? COMPACT_VECTOR_TASK_FALLBACK : promptTemplate;
    }

    systemPromptExtension = appendVectorWorkloadSystemPrompt(
      systemPromptExtension,
      context.vectorWorkloadLaunch,
    );
    systemPromptExtension = appendVectorRoleSystemPrompt(
      systemPromptExtension,
      context.vectorRoleTurn,
    );
    systemPromptExtension = appendVectorPersonaSystemPrompt(
      systemPromptExtension,
      context.vectorPersonaTurn,
    );

    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const renderedSystemPromptExtension = appendVectorVoiceContext(
      renderTemplate(systemPromptExtension, templateData), context.vectorVoiceActive,
    );
    const plainConversation = plainConversationMessage !== null;
    const renderedBootstrapPrompt =
      !plainConversation && !canResumeSession && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const taskContextNote = !plainConversation && context.conversationMode === true
      ? selectPaperclipTaskMarkdown(context, { resumedSession: canResumeSession })
      : "";
    const wakePrompt = plainConversation ? "" : renderPaperclipWakePrompt(context.paperclipWake, {
      conversationMode: context.conversationMode === true,
      resumedSession: canResumeSession,
      includeExecutionContract: compactTaskPrompt ? false : undefined,
      suppressIssueDescription: taskContextNote.length > 0,
    });
    const shouldUseResumeDeltaPrompt = canResumeSession && wakePrompt.length > 0;
    const renderedHeartbeatPrompt = plainConversation || shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = plainConversation
      ? ""
      : asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const vectorImageNote = vectorIngressImages.length > 0
      ? "The image attachments for this turn are supplied natively with this prompt. Do not attempt to download them or request Paperclip API credentials."
      : "";
    const userPrompt = joinPromptSections([
      plainConversationMessage,
      renderedBootstrapPrompt,
      wakePrompt,
      taskContextNote,
      sessionHandoffNote,
      vectorImageNote,
      renderedHeartbeatPrompt,
    ]);
    const promptMetrics = {
      systemPromptChars: renderedSystemPromptExtension.length,
      promptChars: userPrompt.length,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      taskContextChars: taskContextNote.length,
      sessionHandoffChars: sessionHandoffNote.length,
      heartbeatPromptChars: renderedHeartbeatPrompt.length,
      compactPrompt: compactTaskPrompt ? 1 : 0,
    };

    const commandNotes = (() => {
      const notes = [...preparedRuntimeConfig.notes];
      if (compactTaskPrompt) notes.push("Compact Vector task prompt: deployment role instructions and one wake brief; generic heartbeat boilerplate omitted. Review, recovery, continuation and connector authority retained.");
      if (plainConversationMessage !== null) {
        notes.push("Vector conversation turn: sent the user's message verbatim with the agent instructions as the system prompt (no Paperclip wake or heartbeat prompt).");
      }
      if (!resolvedInstructionsFilePath) return notes;
      if (instructionsReadFailed) {
        notes.push(
          `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
        );
        return notes;
      }
      notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
      if (plainConversation) return notes;
      notes.push(compactTaskPrompt
        ? `Loaded compact role instructions (relative references from ${instructionsFileDir}).`
        : `Appended instructions + path directive to system prompt (relative references from ${instructionsFileDir}).`);
      return notes;
    })();

    const buildArgs = (sessionFile: string): string[] => {
      const args: string[] = [];

      args.push("--mode", executionMode);
      if (executionMode === "json") {
        args.push("-p"); // Non-interactive mode: process prompt and exit
      }

      // Use --append-system-prompt to extend Pi's default system prompt
      args.push("--append-system-prompt", renderedSystemPromptExtension);

      if (provider) args.push("--provider", provider);
      if (modelId) args.push("--model", modelId);
      if (thinking) args.push("--thinking", thinking);

      args.push(...buildPiBuiltinToolArgs(config, {
        vectorProfile: process.env.PAPERCLIP_VECTOR_PROFILE,
        extraArgs,
        additionalToolNames: vectorProfilePolicy.additionalToolNames,
      }));
      args.push(...vectorProfilePolicy.cliArgs);
      args.push("--session", sessionFile);
      args.push("--skill", remoteSkillsDir ?? localSkillsDir ?? PI_AGENT_SKILLS_DIR);

      if (extraArgs.length > 0) args.push(...extraArgs);

      if (executionMode === "json") {
        // Print/JSON mode accepts the user prompt as its final argument. RPC
        // mode receives the same prompt as a line-delimited command on stdin.
        args.push(userPrompt);
      }

      return args;
    };

    const runAttempt = async (sessionFile: string) => {
      if (vectorIngressImages.length > 0 && executionMode !== "rpc") {
        throw new Error("Vector ingress images require Pi RPC execution mode");
      }
      const args = buildArgs(sessionFile);
      if (onMeta) {
        await onMeta({
          adapterType: "pi_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: args,
          env: loggedEnv,
          prompt: userPrompt,
          promptMetrics,
          context: redactVectorIngressImages(context),
        });
      }

      // Buffer stdout by lines to handle partial JSON chunks
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stderr") {
          // Buffer by lines so a base64 payload split across process chunks
          // cannot cross the persistent-log boundary unredacted.
          stderrBuffer += chunk;
          const lines = stderrBuffer.split("\n");
          stderrBuffer = lines.pop() || "";
          for (const line of lines) {
            await onLog(stream, sanitizePiOutputLine(line, sensitiveImageData) + "\n");
          }
          return;
        }

        // Buffer stdout and emit only complete lines
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        // Keep the last (potentially incomplete) line in the buffer
        stdoutBuffer = lines.pop() || "";

        // Emit complete lines and their normalized live-runtime events. Raw
        // Persisted stdout is normalized only to remove image payload bytes;
        // the aggregate parser consumes the same sanitized JSONL.
        for (const line of lines) {
          if (line) {
            const sanitizedLine = sanitizePiOutputLine(line, sensitiveImageData);
            await onLog(stream, sanitizedLine + "\n");
            for (const event of extractPiRuntimeEvents(sanitizedLine)) {
              await ctx.onEvent?.(event);
            }
          }
        }
      };

      const rpcPrompt = buildPiRpcPrompt(runId, userPrompt, vectorIngressImages);
      const vectorSessionCaptureNonce = randomUUID();
      const processCommand = executionMode === "rpc" ? "node" : command;
      const processArgs = executionMode === "rpc"
        ? ["-e", PI_RPC_TURN_SUPERVISOR, command, JSON.stringify(args), vectorSessionCaptureNonce]
        : args;
      const processEnvSource = executionTargetIsRemote && vectorEmbeddedRpc
        ? ensurePathInEnv(projectVectorEmbeddedPiEnvironment(process.env, env, { githubLaunchers: vectorProfilePolicy.profile === "engineering" }))
        : executionTargetIsRemote
          ? env
          : runtimeEnv;
      const processEnv = Object.fromEntries(
        Object.entries(processEnvSource).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, processCommand, processArgs, {
        cwd,
        env: processEnv,
        inheritProcessEnv: !vectorEmbeddedRpc,
        stdin: executionMode === "rpc" ? rpcPrompt : undefined,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog: bufferedOnLog,
        runLogTail: paperclipBridge?.runLogTail,
        settleRunDisposition: paperclipBridge?.settleRunDisposition,
      });

      // Flush any remaining buffer content
      if (stdoutBuffer) {
        const sanitizedTail = sanitizePiOutputLine(stdoutBuffer, sensitiveImageData);
        await onLog("stdout", sanitizedTail);
        for (const event of extractPiRuntimeEvents(sanitizedTail)) {
          await ctx.onEvent?.(event);
        }
      }
      if (stderrBuffer) {
        await onLog("stderr", sanitizePiOutputLine(stderrBuffer, sensitiveImageData));
      }

      const sanitizedStdout = sanitizePiOutput(proc.stdout, sensitiveImageData);
      const sanitizedStderr = sanitizePiOutput(proc.stderr, sensitiveImageData);
      return {
        proc: { ...proc, stdout: sanitizedStdout, stderr: sanitizedStderr },
        rawStderr: sanitizedStderr,
        parsed: parsePiJsonl(sanitizedStdout),
        vectorPiSession: executionMode === "rpc"
          ? extractVectorPiTurnSessionState(sanitizedStdout, vectorSessionCaptureNonce)
          : null,
      };
    };

    const toResult = (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; errorCode?: string | null };
        rawStderr: string;
        parsed: ReturnType<typeof parsePiJsonl>;
        vectorPiSession: VectorPiTurnSessionState | null;
      },
      clearSessionOnMissingSession = false,
    ): AdapterExecutionResult => {
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const resolvedSessionId = clearSessionOnMissingSession ? null : sessionPath;
      const resolvedSessionParams = resolvedSessionId
        ? {
            sessionId: resolvedSessionId,
            cwd: effectiveExecutionCwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
            ...(executionTargetIsRemote
              ? {
                  remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
                }
              : {}),
          }
        : null;

      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const rawExitCode = attempt.proc.exitCode;
      const parsedError = attempt.parsed.errors.find((error) => error.trim().length > 0) ?? "";
      const effectiveExitCode = (rawExitCode ?? 0) === 0 && parsedError ? 1 : rawExitCode;
      const fallbackErrorMessage = parsedError || stderrLine || `Pi exited with code ${rawExitCode ?? -1}`;

      return {
        exitCode: effectiveExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: (effectiveExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
        // Forward the transport-level error code from the run-disposition seam.
        // A lost duplex control channel surfaces the typed `duplex_channel_lost`
        // code; every other result carries no code here.
        errorCode: attempt.proc.errorCode ?? null,
        usage: {
          inputTokens: attempt.parsed.usage.inputTokens,
          outputTokens: attempt.parsed.usage.outputTokens,
          cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: provider,
        biller: resolvePiBiller(runtimeEnv, provider),
        model: model,
        billingType: "unknown",
        costUsd: attempt.parsed.usage.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
          ...(attempt.vectorPiSession ? { vectorPiSession: attempt.vectorPiSession } : {}),
        },
        summary: attempt.parsed.finalMessage ?? attempt.parsed.messages.join("\n\n").trim(),
        clearSession: Boolean(clearSessionOnMissingSession),
      };
    };

    try {
      const initial = await runAttempt(sessionPath);
      const initialFailed =
        !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || initial.parsed.errors.length > 0);

      if (
        canResumeSession &&
        initialFailed &&
        isPiUnknownSessionError(initial.proc.stdout, initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] Pi session "${runtimeSessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        const newSessionPath = executionTargetIsRemote && remoteRuntimeRootDir
          ? buildRemoteSessionPath(remoteRuntimeRootDir, agent.id, new Date().toISOString())
          : buildSessionPath(agent.id, new Date().toISOString());
        if (executionTargetIsRemote) {
          await ensureAdapterExecutionTargetFile(runId, executionTarget, newSessionPath, {
            cwd,
            env,
            timeoutSec: 15,
            graceSec: 5,
            onLog,
          });
        } else {
          try {
            await fs.writeFile(newSessionPath, "", { flag: "wx" });
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
              throw err;
            }
          }
        }
        const retry = await runAttempt(newSessionPath);
        return toResult(retry, true);
      }

      return toResult(initial);
    } finally {
      await Promise.all([
        paperclipBridge?.stop(),
        restoreRemoteWorkspace?.(),
        localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
      ]);
    }
  } finally {
    await Promise.all([
      cleanupVectorToolCapability(),
      cleanupConnectorTools(),
      preparedRuntimeConfig.cleanup(),
    ]);
  }
}
