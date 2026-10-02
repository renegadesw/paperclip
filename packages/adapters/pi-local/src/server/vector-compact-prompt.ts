/** Keep the deployment's own role instructions; do not layer a second generic
 * Paperclip heartbeat contract over them. Other profiles remain unchanged. */
export function useCompactVectorTaskPrompt(
  profile: string | undefined,
  config: Record<string, unknown>,
  context: Record<string, unknown>,
): boolean {
  // Plain chat and interaction/chat fallbacks retain their existing contracts.
  if (context.conversationMode === true) return false;
  if (!profile?.trim()) return false;
  if (config.promptMode === "full") return false;
  if (config.promptMode === "compact") return true;
  return ["engineering", "standard"].includes(profile.trim().toLowerCase());
}

export const COMPACT_VECTOR_TASK_FALLBACK =
  "Work only on the assigned request. Obey the supplied review, recovery and authority constraints. " +
  "Return verified evidence and the required task disposition; never claim an unconfirmed action succeeded.";
