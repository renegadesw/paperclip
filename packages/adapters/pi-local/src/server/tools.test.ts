import { describe, expect, it } from "vitest";
import { buildPiBuiltinToolArgs } from "./tools.js";

describe("buildPiBuiltinToolArgs", () => {
  it("retains the existing all-builtins default when the field is omitted", () => {
    expect(buildPiBuiltinToolArgs({})).toEqual([
      "--tools",
      "read,bash,edit,write,grep,find,ls",
    ]);
  });

  it.each(["standard", "staging", "production", "demo"])(
    "enforces zero built-ins for the Vector %s profile when agent config omits the field",
    (vectorProfile) => {
      expect(buildPiBuiltinToolArgs({}, { vectorProfile })).toEqual(["--no-builtin-tools"]);
    },
  );

  it.each(["standard", "staging", "production", "demo"])(
    "rejects agent-configured built-ins for the Vector %s profile",
    (vectorProfile) => {
      expect(() => buildPiBuiltinToolArgs(
        { builtinTools: ["read", "bash", "edit", "write"] },
        { vectorProfile },
      )).toThrow(`Vector profile "${vectorProfile}" requires builtinTools to be empty`);
      expect(buildPiBuiltinToolArgs({ builtinTools: [] }, { vectorProfile })).toEqual([
        "--no-builtin-tools",
      ]);
    },
  );

  it("rejects extraArgs that could bypass a non-engineering profile ceiling", () => {
    for (const extraArgs of [["--tools", "bash"], ["--tools=read"], ["-t", "write"], ["-tedit"]]) {
      expect(() => buildPiBuiltinToolArgs(
        { builtinTools: [] },
        { vectorProfile: "standard", extraArgs },
      )).toThrow("forbids Pi tool-enabling flags in extraArgs");
    }
  });

  it("allows the engineering profile to retain or narrow the configured built-ins", () => {
    expect(buildPiBuiltinToolArgs({}, { vectorProfile: "engineering" })).toEqual([
      "--tools",
      "read,bash,edit,write,grep,find,ls",
    ]);
    expect(buildPiBuiltinToolArgs(
      { builtinTools: ["read", "grep"] },
      { vectorProfile: "engineering", extraArgs: ["--tools", "read"] },
    )).toEqual(["--tools", "read,grep"]);
  });

  it("fails closed for an unknown configured Vector profile", () => {
    expect(buildPiBuiltinToolArgs({}, { vectorProfile: "prodution" })).toEqual([
      "--no-builtin-tools",
    ]);
  });

  it("uses Pi's explicit zero-builtins switch for an empty selection", () => {
    expect(buildPiBuiltinToolArgs({ builtinTools: [] })).toEqual(["--no-builtin-tools"]);
  });

  it("preserves configured order while removing duplicates", () => {
    expect(buildPiBuiltinToolArgs({ builtinTools: ["read", "grep", "read"] })).toEqual([
      "--tools",
      "read,grep",
    ]);
  });

  it("rejects non-arrays, blank entries, and unknown tools", () => {
    expect(() => buildPiBuiltinToolArgs({ builtinTools: "read" })).toThrow("must be an array");
    expect(() => buildPiBuiltinToolArgs({ builtinTools: [""] })).toThrow("non-empty strings");
    expect(() => buildPiBuiltinToolArgs({ builtinTools: ["deploy"] })).toThrow(
      'Unsupported Pi built-in tool "deploy"',
    );
  });
});
