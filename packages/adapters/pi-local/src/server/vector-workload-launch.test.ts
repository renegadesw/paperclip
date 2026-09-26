import { describe, expect, it } from "vitest";
import {
  appendVectorPersonaSystemPrompt,
  appendVectorRoleSystemPrompt,
  appendVectorWorkloadSystemPrompt,
  ENGINEERING_TODO_WORKER_PROMPT,
  resolveVectorRuntimeSelection,
} from "./execute.js";

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

describe("Vector runtime selection", () => {
  it("keeps the configured provider while selecting a signed model and thinking level", () => {
    expect(resolveVectorRuntimeSelection("router/Default", "low", { model: "Other", thinking: "high" }))
      .toEqual({ model: "router/Other", thinking: "high" });
  });

  it("rejects provider widening and invalid thinking", () => {
    expect(() => resolveVectorRuntimeSelection("anthropic/claude", "low", { model: "Other", thinking: "high" })).toThrow("widens");
    expect(() => resolveVectorRuntimeSelection("router/Default", "low", { model: "Other", thinking: "auto" })).toThrow("malformed");
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

  it("admits builtin tools only for the exact engineering implementation-worker alias", () => {
    const alias = {
      schemaVersion: 1,
      role: "implementation-worker",
      model: "router/Qwen3.8-Flash",
      noBuiltinTools: false,
      systemPrompt: ENGINEERING_TODO_WORKER_PROMPT,
      metadata: {
        todo_id: "00000000-0000-4000-8000-000000000023",
        launch_digest: "a".repeat(32),
        launch_mode: "scoped",
      },
    };
    expect(appendVectorRoleSystemPrompt("Static", alias, "engineering"))
      .toContain(ENGINEERING_TODO_WORKER_PROMPT);
    expect(() => appendVectorRoleSystemPrompt("Static", alias, "standard")).toThrow("malformed");
    expect(() => appendVectorRoleSystemPrompt("Static", { ...alias, role: "engineer" }, "engineering")).toThrow("malformed");
    expect(() => appendVectorRoleSystemPrompt("Static", { ...alias, systemPrompt: "changed" }, "engineering")).toThrow("malformed");
  });
});

describe("Vector persona system prompt", () => {
  it("appends only a complete admitted standard persona", () => {
    const result = appendVectorPersonaSystemPrompt("Static agent policy.", {
      schemaVersion: 1,
      personaId: "00000000-0000-0000-0000-000000000023",
      personaVersion: "abcdef012345",
      noBuiltinTools: true,
      systemPrompt: "Friendly standard-chat persona.",
    });
    expect(result).toContain("Static agent policy.");
    expect(result).toContain("selected standard-chat persona");
    expect(result).toContain("Friendly standard-chat persona.");
  });

  it("fails closed on partial persona context", () => {
    expect(() => appendVectorPersonaSystemPrompt("Static", {
      schemaVersion: 1,
      personaId: "00000000-0000-0000-0000-000000000023",
      personaVersion: "wrong",
      noBuiltinTools: true,
      systemPrompt: "Friendly",
    })).toThrow("malformed");
  });
});
