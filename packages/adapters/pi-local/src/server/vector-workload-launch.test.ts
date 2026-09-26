import { describe, expect, it } from "vitest";
import { appendVectorRoleSystemPrompt, appendVectorWorkloadSystemPrompt } from "./execute.js";

describe("Vector workload launch system prompt", () => {
  it("appends only a complete admitted workload prompt", () => {
    const result = appendVectorWorkloadSystemPrompt("Static agent policy.", {
      schemaVersion: 1,
      workloadKey: "current_scout",
      taskId: "task-1",
      systemPrompt: "Dynamic Vector charter.",
    });
    expect(result).toContain("Static agent policy.");
    expect(result).toContain("signed, installation-scoped ingress");
    expect(result).toContain("Dynamic Vector charter.");
    expect(appendVectorWorkloadSystemPrompt("Static agent policy.", undefined)).toBe(
      "Static agent policy.",
    );
  });

  it("fails closed on partial workload context", () => {
    expect(() => appendVectorWorkloadSystemPrompt("Static", {
      schemaVersion: 1,
      workloadKey: "current_scout",
      taskId: "task-1",
    })).toThrow("malformed");
  });
});

describe("Vector role turn system prompt", () => {
  it("appends only a complete admitted staging role prompt", () => {
    const result = appendVectorRoleSystemPrompt("Static agent policy.", {
      schemaVersion: 1,
      role: "funky-analyst",
      noBuiltinTools: true,
      systemPrompt: "Dynamic product charter.",
    });
    expect(result).toContain("Static agent policy.");
    expect(result).toContain("signed, installation-scoped ingress");
    expect(result).toContain("Dynamic product charter.");
    expect(appendVectorRoleSystemPrompt("Static", undefined)).toBe("Static");
  });

  it("fails closed on a partial or tool-widening role turn", () => {
    expect(() => appendVectorRoleSystemPrompt("Static", {
      schemaVersion: 1,
      role: "funky-analyst",
      systemPrompt: "Dynamic",
      noBuiltinTools: false,
    })).toThrow("malformed");
  });
});
