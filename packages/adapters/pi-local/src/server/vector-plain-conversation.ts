import {
  asString,
  normalizePaperclipWakePayload,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";

// Vector conversation turns (NexusLink ingress and board Agent Chat on a
// Vector installation) reach Pi the way the legacy `pi --mode rpc` chat did:
// the user's message verbatim as the prompt, with only the agent instructions
// and the admitted Vector persona/role appends as the system prompt. Pi's own
// session file carries the history. No Paperclip wake payload, task markdown,
// heartbeat template, bootstrap template or session handoff note.
//
// Anything this cannot reproduce exactly from the inline wake comments falls
// back to the run state as data (renderVectorRunData), so the model never
// loses a request.

const VECTOR_ROLE_TURN_MARKER = "[VECTOR_ROLE_TURN_V1]\n";
const VECTOR_WORKLOAD_LAUNCH_MARKER = "[VECTOR_WORKLOAD_LAUNCH_V1]\n";

export type VectorPlainConversationFallbackReason =
  | "not_vector_installation"
  | "not_conversation"
  | "workload_launch"
  | "no_wake_payload"
  | "recovery"
  | "external_chat"
  | "interaction_or_continuation"
  | "no_pending_comments"
  | "incomplete_comment_batch"
  | "non_user_comment"
  | "unrecognized_turn_envelope";

export type VectorPlainConversationDecision =
  | { plain: true; message: string }
  | { plain: false; reason: VectorPlainConversationFallbackReason };

export function isVectorInstallationProfile(profile: string | undefined | null): boolean {
  return (profile?.trim().length ?? 0) > 0;
}

function hasEntries(value: unknown): boolean {
  return Object.keys(parseObject(value)).length > 0;
}

/**
 * The trusted ingress stores role-turn comments as
 * `[VECTOR_ROLE_TURN_V1]\n<single-line JSON>\n\n<user body>` so an idempotent
 * retry binds to the same role context. That context already reaches the
 * system prompt through appendVectorRoleSystemPrompt; Pi sees only the body.
 */
function stripVectorRoleTurnEnvelope(body: string): string | null {
  if (!body.startsWith(VECTOR_ROLE_TURN_MARKER)) return body;
  const rest = body.slice(VECTOR_ROLE_TURN_MARKER.length);
  const separator = rest.indexOf("\n\n");
  if (separator < 0) return null;
  const envelope = rest.slice(0, separator);
  if (envelope.includes("\n")) return null;
  try {
    const parsed = JSON.parse(envelope) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }
  return rest.slice(separator + 2);
}

export function resolveVectorPlainConversationMessage(input: {
  vectorProfile: string | undefined;
  context: Record<string, unknown>;
}): VectorPlainConversationDecision {
  const { context } = input;
  if (!isVectorInstallationProfile(input.vectorProfile)) {
    return { plain: false, reason: "not_vector_installation" };
  }
  if (context.conversationMode !== true) return { plain: false, reason: "not_conversation" };
  if (hasEntries(context.vectorWorkloadLaunch)) return { plain: false, reason: "workload_launch" };

  const wake = normalizePaperclipWakePayload(context.paperclipWake);
  if (!wake) return { plain: false, reason: "no_wake_payload" };
  if (wake.recovery || wake.reason === "source_scoped_recovery_action") {
    return { plain: false, reason: "recovery" };
  }
  if (wake.externalChatProvider || wake.externalChatQuestionResponse || wake.externalChatExecutionBound) {
    return { plain: false, reason: "external_chat" };
  }
  if (
    wake.executionContinuation ||
    wake.questionResponse ||
    wake.checkboxSelection ||
    wake.agentMessage ||
    wake.livenessContinuation ||
    wake.taskWatchdog ||
    wake.executionStage ||
    wake.continuationSummary ||
    wake.planReviewContext ||
    wake.documentReviewContext ||
    wake.annotationDeltas.length > 0 ||
    wake.childIssueSummaries.length > 0 ||
    wake.unresolvedBlockerIssueIds.length > 0 ||
    wake.unresolvedBlockerSummaries.length > 0 ||
    wake.activeTreeHold ||
    wake.interactionId ||
    wake.externalInteractionContinuation ||
    wake.dependencyBlockedInteraction ||
    wake.treeHoldInteraction ||
    wake.skillTest
  ) {
    return { plain: false, reason: "interaction_or_continuation" };
  }
  if (wake.comments.length === 0) return { plain: false, reason: "no_pending_comments" };
  if (
    wake.fallbackFetchNeeded ||
    wake.truncated ||
    wake.missingCount > 0 ||
    wake.includedCount !== wake.comments.length ||
    wake.requestedCount !== wake.comments.length ||
    (wake.commentIds.length > 0 && wake.commentIds.length !== wake.comments.length) ||
    wake.comments.some((comment) => comment.bodyTruncated)
  ) {
    return { plain: false, reason: "incomplete_comment_batch" };
  }
  if (wake.comments.some((comment) => comment.authorType !== "user")) {
    return { plain: false, reason: "non_user_comment" };
  }

  const roleTurn = hasEntries(context.vectorRoleTurn);
  const bodies: string[] = [];
  for (const comment of wake.comments) {
    if (comment.body.startsWith(VECTOR_WORKLOAD_LAUNCH_MARKER)) {
      return { plain: false, reason: "unrecognized_turn_envelope" };
    }
    const body = roleTurn ? stripVectorRoleTurnEnvelope(comment.body) : comment.body;
    if (body === null || (roleTurn && body.startsWith(VECTOR_ROLE_TURN_MARKER))) {
      return { plain: false, reason: "unrecognized_turn_envelope" };
    }
    if (!body.trim()) return { plain: false, reason: "no_pending_comments" };
    bodies.push(body.trim());
  }
  return { plain: true, message: bodies.join("\n\n") };
}

/**
 * Connector skills are deployment-owned capability docs (e.g. the GitHub
 * connection). The wake prompt normally carries them; a plain turn moves them
 * to the system prompt so the user message stays verbatim.
 */
export function readPaperclipConnectorSkillInstructions(paperclipWake: unknown): string {
  return asString(parseObject(paperclipWake).connectorSkillInstructions, "").trim();
}
