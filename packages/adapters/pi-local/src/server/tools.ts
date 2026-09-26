const PI_BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

const PI_BUILTIN_TOOL_NAME_SET = new Set<string>(PI_BUILTIN_TOOL_NAMES);

interface PiBuiltinToolOptions {
  vectorProfile?: string;
  extraArgs?: readonly string[];
}

function normalizedVectorProfile(profile: string | undefined): string {
  return profile?.trim().toLowerCase() ?? "";
}

function extraArgCanEnableTools(arg: string): boolean {
  return arg === "--tools" || arg.startsWith("--tools=") || arg === "-t" || /^-t(?:=|[^-])/.test(arg);
}

/**
 * Build Pi's built-in tool-selection arguments.
 *
 * An omitted `builtinTools` field retains Paperclip's existing all-builtins
 * behavior. An explicitly empty array is materially different: Pi needs
 * `--no-builtin-tools`, because an empty `--tools` value does not express the
 * same intent reliably across CLI parsers.
 */
export function buildPiBuiltinToolArgs(
  config: Record<string, unknown>,
  options: PiBuiltinToolOptions = {},
): string[] {
  const vectorProfile = normalizedVectorProfile(options.vectorProfile);
  // An unset profile retains upstream behavior. Once a Vector deployment opts
  // into profiles, engineering is the only profile allowed to expose Pi's
  // built-ins; misspellings and future profiles fail closed.
  const zeroBuiltinCeiling = vectorProfile.length > 0 && vectorProfile !== "engineering";

  if (zeroBuiltinCeiling && options.extraArgs?.some(extraArgCanEnableTools)) {
    throw new Error(
      `Vector profile "${vectorProfile}" forbids Pi tool-enabling flags in extraArgs.`,
    );
  }

  if (!Object.prototype.hasOwnProperty.call(config, "builtinTools")) {
    if (zeroBuiltinCeiling) return ["--no-builtin-tools"];
    return ["--tools", PI_BUILTIN_TOOL_NAMES.join(",")];
  }

  if (!Array.isArray(config.builtinTools)) {
    throw new Error("Pi builtinTools must be an array of built-in tool names.");
  }

  const tools: string[] = [];
  for (const rawTool of config.builtinTools) {
    if (typeof rawTool !== "string" || rawTool.trim().length === 0) {
      throw new Error("Pi builtinTools entries must be non-empty strings.");
    }
    const tool = rawTool.trim();
    if (!PI_BUILTIN_TOOL_NAME_SET.has(tool)) {
      throw new Error(
        `Unsupported Pi built-in tool "${tool}". Expected one of: ${PI_BUILTIN_TOOL_NAMES.join(", ")}.`,
      );
    }
    if (!tools.includes(tool)) tools.push(tool);
  }

  if (zeroBuiltinCeiling && tools.length > 0) {
    throw new Error(
      `Vector profile "${vectorProfile}" requires builtinTools to be empty; agent configuration cannot enable Pi built-in tools.`,
    );
  }

  return tools.length === 0
    ? ["--no-builtin-tools"]
    : ["--tools", tools.join(",")];
}
