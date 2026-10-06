import { describe, expect, it } from "vitest";
import { appendVectorVoiceContext } from "./vector-voice-context.js";

describe("native voice context", () => {
  it("adds the private instruction only for a literal per-turn true", () => {
    expect(appendVectorVoiceContext("persona", true)).toContain("use the speak tool");
    expect(appendVectorVoiceContext("persona", true)).toMatch(/^persona/);
    for (const value of [false, undefined, null, "true", 1, {}]) {
      expect(appendVectorVoiceContext("persona", value)).toBe("persona");
    }
  });
});
