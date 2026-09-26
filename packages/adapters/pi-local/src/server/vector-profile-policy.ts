import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type VectorPiProfilePolicy = {
  profile: string;
  restricted: boolean;
  cliArgs: string[];
  discoveryCliArgs: string[];
  useBundledPaperclipSkillsOnly: boolean;
  additionalToolNames: string[];
};

type PackagedExtension = {
  profile: string;
  path: string;
  sha256: string;
  tools: string[];
  delivery: "local" | "callback";
  permissions: {
    filesystem: boolean;
    shell: boolean;
  };
};

export type FunkyDevCapabilityStatus = "native" | "ported" | "blocked" | "external";

export type FunkyDevCapability = {
  capability: string;
  tools: string[];
  status: FunkyDevCapabilityStatus;
  dependency?: string;
};

/**
 * Audited against vector-os/agents' pinative source on 2026-09-26; the
 * model-facing definitions are pinned by funkydev-legacy-tool-parity.test.ts.
 *
 * Keep blocked entries visible.  A matching tool name is not parity when its
 * run-scoped identity, callback, or frontend consumer still belongs to the
 * legacy Agents service.
 */
export const FUNKYDEV_CAPABILITY_INVENTORY: readonly FunkyDevCapability[] = [
  {
    capability: "pi-builtins",
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    status: "native",
  },
  {
    capability: "vault-reference",
    tools: ["vault_search", "vault_read"],
    status: "ported",
  },
  {
    capability: "operator-question",
    tools: ["ask_user"],
    status: "ported",
    dependency: "Uses the run-scoped Vector callback authority and durable llm.paperclip_questions continuation state.",
  },
  {
    capability: "todos",
    tools: ["todo_add", "todo_list", "todo_update", "todo_mark_done"],
    status: "ported",
    dependency: "Uses the run-scoped Vector callback authority and durable llm.paperclip_todos state.",
  },
  {
    capability: "github",
    tools: [],
    status: "external",
    dependency: "Paperclip's github.code connector: hosted GitHub MCP tools and run-scoped git/gh launchers, granted to the agent on the board. Vector's legacy github_* tools and gh shim are retired.",
  },
  {
    capability: "personal-memory",
    tools: ["memory_save", "memory_search", "memory_forget"],
    status: "ported",
    dependency: "Uses the run-scoped Vector callback authority and canonical owner-scoped personal memory store.",
  },
  {
    capability: "voice-marker",
    tools: ["speak"],
    status: "ported",
    dependency: "Requires the matching sealed Vector OS speak asset and tool-frame gateway; device playback remains rollout acceptance.",
  },
  {
    capability: "rctl",
    tools: [],
    status: "external",
    dependency: "Current FunkyDev installs rctl on PATH for Pi bash; source does not mount it as an MCP server.",
  },
  {
    capability: "vector-os-mcp",
    tools: [],
    status: "blocked",
    dependency: "The /os/mcp bridge is current Funky analyst behavior, not current native FunkyDev behavior; it needs explicit Vector authority before adoption.",
  },
] as const;

const RESTRICTED_CONFIG_FIELDS = [
  "agentDir",
  "agentDirectory",
  "customTools",
  "extensions",
  "instructionsFilePath",
  "mcp",
  "mcpConfig",
  "mcpServers",
  "promptTemplates",
  "settings",
  "settingsPath",
  "skills",
  "themes",
  "tools",
] as const;

const RESTRICTED_LONG_FLAGS = [
  "--agent-dir",
  "--extension",
  "--exclude-tools",
  "--mcp-config",
  "--package",
  "--prompt-template",
  "--settings",
  "--skill",
  "--theme",
  "--tools",
  "--use-theme",
] as const;

/**
 * Shell and Git environment the Paperclip controller itself injects into every
 * run (prepareGitHubExecutionEnvironment and prepareGitHubOperationLaunchers):
 * the managed git/gh launchers on PATH, the GitHub broker URL/token, and Git
 * hardening. It is not agent configuration. Engineering forwards it to Pi's
 * bash; restricted profiles have no shell, ignore it here, and strip it.
 */
const PAPERCLIP_CONTROLLER_SHELL_ENV_KEY =
  /^(PATH|ZDOTDIR|BASH_ENV|GH_CONFIG_DIR|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|SSH_AUTH_SOCK|SSH_ASKPASS|GIT_[A-Z0-9_]+|PAPERCLIP_GITHUB_[A-Z0-9_]+|PAPERCLIP_GIT_[A-Z0-9_]+|PAPERCLIP_RUNNER_NETWORK_[A-Z0-9_]+)$/;

export function isPaperclipControllerShellEnvKey(key: string): boolean {
  return PAPERCLIP_CONTROLLER_SHELL_ENV_KEY.test(key);
}

// The controller's per-run scratch and temp directories (paperclipScratch).
const PAPERCLIP_CONTROLLER_SCRATCH_ENV_KEY =
  /^(TMPDIR|TEMP|TMP|PAPERCLIP_TMPDIR|PAPERCLIP_SCRATCH_DIR|PAPERCLIP_RUN_SCRATCH_DIR|PAPERCLIP_TASK_SCRATCH_DIR)$/;

function isPaperclipControllerEnvKey(key: string): boolean {
  return PAPERCLIP_CONTROLLER_SHELL_ENV_KEY.test(key) || PAPERCLIP_CONTROLLER_SCRATCH_ENV_KEY.test(key);
}

function normalizeProfile(profile: string | undefined): string {
  return profile?.trim().toLowerCase() ?? "";
}

export function vectorPiProfileIsRestricted(profile: string | undefined): boolean {
  const normalized = normalizeProfile(profile);
  return normalized.length > 0 && normalized !== "engineering";
}

function hasConfiguredValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function normalizedEnv(config: Record<string, unknown>): Record<string, unknown> {
  const value = config.env;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function restrictedFlag(arg: string): string | null {
  for (const flag of RESTRICTED_LONG_FLAGS) {
    if (arg === flag || arg.startsWith(`${flag}=`)) return flag;
  }

  if (arg === "-e" || /^-e.+/.test(arg)) return "--extension";
  if (arg === "-t" || /^-t.+/.test(arg)) return "--tools";
  if (arg === "-xt" || /^-xt.+/.test(arg)) return "--exclude-tools";
  return null;
}

function validateRestrictedConfig(
  profile: string,
  config: Record<string, unknown>,
  extraArgs: readonly string[],
  command: string,
  deploymentCommand: string | undefined,
  agentConfiguredEnv: Record<string, unknown> | undefined,
): void {
  const allowedCommand = deploymentCommand?.trim() || "pi";
  if (command !== allowedCommand) {
    throw new Error(
      `Vector profile "${profile}" requires the deployment-owned Pi command "${allowedCommand}".`,
    );
  }
  for (const field of RESTRICTED_CONFIG_FIELDS) {
    if (hasConfiguredValue(config[field])) {
      throw new Error(
        `Vector profile "${profile}" forbids Pi runtime resource field "${field}".`,
      );
    }
  }

  // With the agent's own configured env in hand, every key the agent set is
  // rejected, and the runtime config may additionally carry only
  // controller-owned run env. Without it, any env is rejected.
  const env = normalizedEnv(config);
  const agentNames = agentConfiguredEnv ? Object.keys(agentConfiguredEnv) : null;
  const envNames = agentNames === null
    ? Object.keys(env)
    : Array.from(new Set([
      ...agentNames,
      ...Object.keys(env).filter((name) => !agentNames.includes(name) && !isPaperclipControllerEnvKey(name)),
    ]));
  if (envNames.length > 0) {
    throw new Error(
      `Vector profile "${profile}" forbids mutable agent env (${envNames.sort().join(", ")}); move required values to the deployment process environment.`,
    );
  }

  for (const arg of extraArgs) {
    const flag = restrictedFlag(arg);
    if (flag) {
      throw new Error(
        `Vector profile "${profile}" forbids Pi runtime-loading flag "${flag}" in extraArgs.`,
      );
    }
    throw new Error(
      `Vector profile "${profile}" forbids mutable Pi extraArgs; configure the deployment-owned runtime surface instead.`,
    );
  }
}

function parsePackagedExtensions(raw: string | undefined, activeProfile: string): PackagedExtension[] {
  if (!raw?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS must be valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS must be a JSON array.");
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Packaged Pi extension entry ${index} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const profile = typeof record.profile === "string" ? normalizeProfile(record.profile) : "";
    const extensionPath = typeof record.path === "string" ? record.path.trim() : "";
    const sha256 = typeof record.sha256 === "string" ? record.sha256.trim().toLowerCase() : "";
    const tools = Array.isArray(record.tools)
      ? record.tools.map((tool) => typeof tool === "string" ? tool.trim() : "")
      : [];
    const delivery = record.delivery === undefined ? "local" : record.delivery;
    const permissions = typeof record.permissions === "object" && record.permissions !== null && !Array.isArray(record.permissions)
      ? record.permissions as Record<string, unknown>
      : {};

    if (profile !== activeProfile) {
      throw new Error(
        `Packaged Pi extension entry ${index} declares profile "${profile || "<empty>"}", expected "${activeProfile}".`,
      );
    }

    if (!path.isAbsolute(extensionPath)) {
      throw new Error(`Packaged Pi extension entry ${index} requires an absolute path.`);
    }
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Packaged Pi extension entry ${index} requires a lowercase SHA-256 digest.`);
    }
    if (tools.some((tool) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(tool))) {
      throw new Error(`Packaged Pi extension entry ${index} contains an invalid tool name.`);
    }
    if (delivery !== "local" && delivery !== "callback") {
      throw new Error(
        `Packaged Pi extension entry ${index} requires delivery "local" or "callback".`,
      );
    }
    if (typeof permissions.filesystem !== "boolean" || typeof permissions.shell !== "boolean") {
      throw new Error(
        `Packaged Pi extension entry ${index} must explicitly declare boolean filesystem and shell permissions.`,
      );
    }
    if (activeProfile !== "engineering" && (permissions.filesystem || permissions.shell)) {
      throw new Error(
        `Vector profile "${activeProfile}" forbids packaged Pi extensions with filesystem or shell authority.`,
      );
    }
    return {
      profile,
      path: path.resolve(extensionPath),
      sha256,
      tools: Array.from(new Set(tools)),
      delivery,
      permissions: {
        filesystem: permissions.filesystem,
        shell: permissions.shell,
      },
    };
  });
}

async function verifyPackagedExtensions(
  raw: string | undefined,
  activeProfile: string,
): Promise<PackagedExtension[]> {
  const extensions = parsePackagedExtensions(raw, activeProfile);
  for (const extension of extensions) {
    const stat = await fs.stat(extension.path).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`Packaged Pi extension is not a regular file: ${extension.path}`);
    }
    const digest = createHash("sha256")
      .update(await fs.readFile(extension.path))
      .digest("hex");
    if (digest !== extension.sha256) {
      throw new Error(`Packaged Pi extension digest mismatch: ${extension.path}`);
    }
  }
  return extensions;
}

/**
 * Resolve the deployment-owned Pi surface for a Vector profile.
 *
 * The packaged extension hook is deliberately sourced only from the Paperclip
 * server process environment. Agent config and adapter env cannot add paths or
 * digests. With no deployment allowlist, restricted profiles expose no tools.
 */
export async function prepareVectorPiProfilePolicy(input: {
  profile?: string;
  config: Record<string, unknown>;
  extraArgs?: readonly string[];
  packagedExtensionsJson?: string;
  command?: string;
  deploymentCommand?: string;
  /** The agent's stored adapterConfig.env, as opposed to the controller-merged runtime env. */
  agentConfiguredEnv?: Record<string, unknown>;
}): Promise<VectorPiProfilePolicy> {
  const profile = normalizeProfile(input.profile);
  const restricted = vectorPiProfileIsRestricted(profile);
  if (!restricted) {
    const engineeringExtensions = profile === "engineering"
      ? await verifyPackagedExtensions(input.packagedExtensionsJson, profile)
      : [];
    return {
      profile,
      restricted: false,
      cliArgs: engineeringExtensions.flatMap((entry) => ["--extension", entry.path]),
      discoveryCliArgs: [],
      useBundledPaperclipSkillsOnly: false,
      additionalToolNames: engineeringExtensions.flatMap((entry) => entry.tools),
    };
  }

  validateRestrictedConfig(
    profile,
    input.config,
    input.extraArgs ?? [],
    input.command?.trim() || "pi",
    input.deploymentCommand,
    input.agentConfiguredEnv,
  );
  const extensions = await verifyPackagedExtensions(input.packagedExtensionsJson, profile);
  const allowedTools = Array.from(new Set(extensions.flatMap((entry) => entry.tools)));

  return {
    profile,
    restricted: true,
    cliArgs: [
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      ...(allowedTools.length > 0 ? ["--tools", allowedTools.join(",")] : ["--no-tools"]),
      ...extensions.flatMap((entry) => ["--extension", entry.path]),
    ],
    discoveryCliArgs: [
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--no-tools",
    ],
    useBundledPaperclipSkillsOnly: true,
    additionalToolNames: [],
  };
}

/** Tool names a profile policy already admits (Pi built-ins excluded). */
export function vectorPiPolicyToolNames(policy: VectorPiProfilePolicy): string[] {
  const names = [...policy.additionalToolNames];
  const toolsIndex = policy.cliArgs.indexOf("--tools");
  if (toolsIndex >= 0 && policy.cliArgs[toolsIndex + 1]) {
    names.push(...policy.cliArgs[toolsIndex + 1]!.split(",").map((name) => name.trim()).filter(Boolean));
  }
  return Array.from(new Set(names));
}

/**
 * Admit the run's Paperclip connector tools on any profile. The connector
 * extension is adapter-owned and registers only tools the Paperclip gateway
 * listed for this run's grants; it adds no Pi built-in and no filesystem or
 * shell authority, so restricted profiles stay restricted.
 */
export function withPaperclipConnectorTools(
  policy: VectorPiProfilePolicy,
  extensionPath: string,
  toolNames: readonly string[],
): VectorPiProfilePolicy {
  const names = Array.from(new Set(toolNames.map((name) => name.trim()).filter(Boolean)));
  if (names.length === 0) return policy;
  if (!policy.restricted) {
    return {
      ...policy,
      cliArgs: [...policy.cliArgs, "--extension", extensionPath],
      additionalToolNames: Array.from(new Set([...policy.additionalToolNames, ...names])),
    };
  }
  const cliArgs = [...policy.cliArgs];
  const toolsIndex = cliArgs.indexOf("--tools");
  if (toolsIndex >= 0) {
    cliArgs[toolsIndex + 1] = Array.from(new Set([
      ...(cliArgs[toolsIndex + 1] ?? "").split(",").filter(Boolean),
      ...names,
    ])).join(",");
  } else {
    const noTools = cliArgs.indexOf("--no-tools");
    if (noTools >= 0) cliArgs.splice(noTools, 1, "--tools", names.join(","));
    else cliArgs.push("--tools", names.join(","));
  }
  cliArgs.push("--extension", extensionPath);
  return { ...policy, cliArgs };
}
