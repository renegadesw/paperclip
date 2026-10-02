import {
  asString,
  normalizePaperclipWakePayload,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";
import { isVectorPiInstallation } from "./vector-profile-policy.js";
import { isVectorInstallationProfile } from "./vector-plain-conversation.js";

// Inside a Vector installation the deployment's own Vector OS prompt is the
// only prompt prose Pi receives: the release instructions file plus the
// signed persona/role/workload prompts Vector OS admits. Every profile and
// every mode (conversation, task, routine) is covered, with no opt-out.
// Paperclip run state still reaches Pi, but as data only. Outside a Vector
// installation the adapter keeps the upstream Paperclip prompts.

export function isVectorOwnedPromptInstallation(
  profile: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isVectorInstallationProfile(profile) || isVectorPiInstallation(env);
}

/** Bundled Paperclip skills are Paperclip-authored prompt text; engineering opts in. */
export function isBundledPaperclipSkill(entry: Pick<PaperclipSkillEntry, "key">): boolean {
  return entry.key.trim().toLowerCase().startsWith("paperclipai/paperclip/");
}

function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(pruneEmpty).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, pruneEmpty(item)] as const)
      .filter(([, item]) => item !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  if (value === null || value === undefined || value === false || value === "") return undefined;
  return value;
}

function fenced(text: string, info: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${info}\n${text}\n${fence}`;
}

/**
 * The run's Paperclip state (issue, comments, review stage, recovery,
 * continuation, authority constraints, session handoff) as one JSON data
 * block, with no Paperclip instruction prose around it.
 */
export function renderVectorRunData(context: Record<string, unknown>): string {
  const wake = normalizePaperclipWakePayload(context.paperclipWake);
  const reason = asString(context.wakeReason, "").trim() || asString(context.wakeSource, "").trim();
  // The server's handoff note is data bullets plus one line of Paperclip
  // instruction prose; only the bullets are run data.
  const sessionHandoff = asString(context.paperclipSessionHandoffMarkdown, "")
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
  const run = pruneEmpty({
    ...(wake ?? { reason: reason || "heartbeat" }),
    sessionHandoff,
  }) ?? {};
  const json = JSON.stringify({ run }, null, 2).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return fenced(json, "json");
}
