import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { useCompactVectorTaskPrompt } from "./vector-compact-prompt.js";

describe("compact Vector task policy", () => {
  it("defaults only engineering and standard tasks to compact", () => {
    for (const profile of ["engineering", "standard"]) expect(useCompactVectorTaskPrompt(profile, {}, {})).toBe(true);
    for (const profile of [undefined, "staging", "production"]) expect(useCompactVectorTaskPrompt(profile, {}, {})).toBe(false);
    expect(useCompactVectorTaskPrompt("engineering", { promptMode: "full" }, {})).toBe(false);
    expect(useCompactVectorTaskPrompt("production", { promptMode: "compact" }, {})).toBe(true);
    expect(useCompactVectorTaskPrompt(undefined, { promptMode: "compact" }, {})).toBe(false);
  });
  it("does not change conversation contracts", () => {
    expect(useCompactVectorTaskPrompt("engineering", {}, { conversationMode: true })).toBe(false);
  });
  it("omits the generic resume contract while preserving review and human direction", () => {
    const wake = { reason: "issue_assigned", issue: { id: "i", identifier: "VECA-1", title: "Review", description: "EXACT_TASK", status: "in_review" },
      executionStage: { stageId: "s", wakeRole: "reviewer", stageType: "review", allowedActions: ["approve", "request_changes"], currentParticipant: { type: "agent", agentId: "a" }, returnAssignee: { type: "agent", agentId: "b" } },
      comments: [{ id: "c", body: "EXACT_HUMAN_DIRECTION", author: { type: "user", id: "u" } }],
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 }, connectorSkillInstructions: "EXACT_CONNECTOR_INSTRUCTIONS" };
    const prompt = renderPaperclipWakePrompt(wake, { resumedSession: true, includeExecutionContract: false });
    expect(prompt).not.toContain("Execution contract: take concrete action");
    expect(prompt).toContain("Do not execute the task itself or continue executor work.");
    expect(prompt).toContain("approve, request_changes");
    expect(prompt).toContain("EXACT_TASK");
    expect(prompt).toContain("EXACT_HUMAN_DIRECTION");
    expect(prompt).toContain("EXACT_CONNECTOR_INSTRUCTIONS");
    expect(renderPaperclipWakePrompt(wake, { resumedSession: true })).toContain("Execution contract: take concrete action");
  });
});
