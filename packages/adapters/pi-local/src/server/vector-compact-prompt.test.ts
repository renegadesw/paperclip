import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isBundledPaperclipSkill,
  isVectorOwnedPromptInstallation,
  removeBundledPaperclipSkillLinks,
  renderVectorRunData,
} from "./vector-compact-prompt.js";

describe("Vector-owned prompt policy", () => {
  it("covers every Vector profile and the installation id, with no opt-out", () => {
    for (const profile of ["engineering", "standard", "staging", "production", "demo"]) {
      expect(isVectorOwnedPromptInstallation(profile, {})).toBe(true);
    }
    expect(isVectorOwnedPromptInstallation(undefined, { PAPERCLIP_VECTOR_INSTALLATION_ID: "i-1" })).toBe(true);
    expect(isVectorOwnedPromptInstallation("", { PAPERCLIP_VECTOR_COMPANY_ID: "c-1" })).toBe(true);
  });

  it("leaves installations outside Vector on the upstream prompts", () => {
    expect(isVectorOwnedPromptInstallation(undefined, {})).toBe(false);
    expect(isVectorOwnedPromptInstallation("  ", { PAPERCLIP_VECTOR_INSTALLATION_ID: " " })).toBe(false);
  });

  it("identifies bundled Paperclip skills only", () => {
    expect(isBundledPaperclipSkill({ key: "paperclipai/paperclip/paperclip" })).toBe(true);
    expect(isBundledPaperclipSkill({ key: "paperclipai/paperclip/agentmail" })).toBe(true);
    expect(isBundledPaperclipSkill({ key: "company/acme/owner-skill" })).toBe(false);
  });
});

describe("renderVectorRunData", () => {
  const parse = (rendered: string) => {
    const match = /^(`{3,})json\n([\s\S]*)\n\1$/.exec(rendered);
    expect(match).not.toBeNull();
    return (JSON.parse(match![2]!) as { run: Record<string, unknown> }).run;
  };

  it("carries issue, comments, review stage and handoff bullets as data only", () => {
    const rendered = renderVectorRunData({
      paperclipSessionHandoffMarkdown: "Paperclip session handoff:\n- Previous session: s-1\nContinue from the current task state.",
      paperclipWake: {
        reason: "issue_assigned",
        issue: { id: "i", identifier: "VECA-1", title: "Review", description: "EXACT_TASK <b>", status: "in_review" },
        executionStage: { stageId: "s", wakeRole: "reviewer", stageType: "review", allowedActions: ["approve", "request_changes"] },
        comments: [{ id: "c", body: "EXACT_HUMAN_DIRECTION ```", author: { type: "user", id: "u" } }],
        commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
        connectorSkillInstructions: "EXACT_CONNECTOR_INSTRUCTIONS",
      },
    });
    const run = parse(rendered);
    expect(run).toMatchObject({
      reason: "issue_assigned",
      issue: { identifier: "VECA-1", description: "EXACT_TASK <b>", status: "in_review" },
      executionStage: { wakeRole: "reviewer", allowedActions: ["approve", "request_changes"] },
      sessionHandoff: ["Previous session: s-1"],
    });
    expect(JSON.stringify(run)).toContain("EXACT_HUMAN_DIRECTION");
    // Markup cannot break out of the data block; connector skill docs are not run data.
    expect(rendered).not.toContain("<b>");
    expect(rendered.startsWith("````json\n")).toBe(true);
    expect(rendered).not.toContain("EXACT_CONNECTOR_INSTRUCTIONS");
    expect(rendered).not.toContain("Continue from the current task state");
    expect(rendered).not.toContain("Paperclip session handoff");
  });

  it("names the wake reason when the run has no wake payload", () => {
    expect(parse(renderVectorRunData({ wakeReason: "timer" }))).toEqual({ reason: "timer" });
    expect(parse(renderVectorRunData({}))).toEqual({ reason: "heartbeat" });
  });
});

describe("removeBundledPaperclipSkillLinks", () => {
  it("removes only bundled-skill symlinks into a skills directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vector-skill-links-"));
    try {
      const home = path.join(root, "home");
      const bundled = path.join(root, "release", "skills");
      await fs.mkdir(path.join(bundled, "paperclip"), { recursive: true });
      await fs.mkdir(path.join(root, "elsewhere", "paperclip-board"), { recursive: true });
      await fs.mkdir(path.join(home, "para-memory-files"), { recursive: true });
      await fs.symlink(path.join(bundled, "paperclip"), path.join(home, "paperclip"));
      await fs.symlink(path.join(root, "elsewhere", "paperclip-board"), path.join(home, "paperclip-board"));
      const removed = await removeBundledPaperclipSkillLinks(home, ["paperclip", "paperclip-board", "para-memory-files", "absent"]);
      expect(removed).toEqual(["paperclip"]);
      expect((await fs.readdir(home)).sort()).toEqual(["paperclip-board", "para-memory-files"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
