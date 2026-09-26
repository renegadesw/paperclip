import { describe, expect, it } from "vitest";
import { appendVectorWorkloadSystemPrompt } from "./execute.js";

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
