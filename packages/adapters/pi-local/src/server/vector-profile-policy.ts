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
 * Audited against vector-os/agents' pinative source on 2026-09-25.
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
    dependency: "Uses the run-scoped Vector callback authority and durable llm.paperclip_todos state; workers are bound to their launched todo.",
  },
  {
    capability: "github-broker",
    tools: ["github_read", "github_manage", "github_api", "github_repo"],
    status: "blocked",
    dependency: "The current tools call legacy GitHub broker endpoints and require a run-scoped repository/actor capability.",
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

  const env = normalizedEnv(config);
  const envNames = Object.keys(env);
  if (envNames.length > 0) {
    throw new Error(
      `Vector profile "${profile}" forbids mutable agent env; move required values to the deployment process environment.`,
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
