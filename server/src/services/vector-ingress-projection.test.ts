import { describe, expect, it } from "vitest";
import { projectVectorEventPayload } from "./vector-ingress.js";

describe("Vector ingress transcript projection", () => {
  it("removes error commands before projection", () => {
    expect(projectVectorEventPayload("error", {
      source: "provider",
      requestId: "request-1",
      command: "curl -H 'Authorization: secret'",
    })).toEqual({ source: "provider", requestId: "request-1" });
  });

  it("recursively redacts and bounds tool arguments and results", () => {
    const projected = projectVectorEventPayload("tool_result", {
      toolCallId: "tool-1",
      toolName: "vault_read",
      result: {
        apiKey: "hidden-key",
        nested: [{ password: "hidden-password", accessToken: "hidden-token" }],
        auth: "Bearer hidden-bearer",
        database: "postgres://user:hidden-password@example.test/vector",
        oversized: "x".repeat(40_000),
      },
      internalTrace: "not-projected",
    });
    const wire = JSON.stringify(projected);
    expect(projected).toMatchObject({
      toolCallId: "tool-1",
      toolName: "vault_read",
      result: {
        apiKey: "[redacted]",
        nested: [{ password: "[redacted]", accessToken: "[redacted]" }],
        auth: "[redacted]",
        database: "[redacted]example.test/vector",
      },
    });
    expect(wire).not.toContain("hidden-key");
    expect(wire).not.toContain("hidden-password");
    expect(wire).not.toContain("hidden-token");
    expect(wire).not.toContain("hidden-bearer");
    expect(wire).not.toContain("internalTrace");
    expect(wire.length).toBeLessThan(5_000);
    expect(wire).toContain("[truncated]");
  });
});
