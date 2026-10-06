import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

const extensionUrl = new URL("../vector-extensions/funkydev-vault-reference.ts", import.meta.url);

describe("bundled FunkyDev Vault extension contract", () => {
  it("exposes only the two read-only Vault tools", async () => {
    const source = await fs.readFile(extensionUrl, "utf8");
    const toolNames = [...source.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(toolNames).toEqual(["vault_search", "vault_read"]);
    expect(source).not.toMatch(/name:\s*"(?:write|edit|delete|memory_)/);
  });

  it("pins the packaged source digest and checks real paths before reads", async () => {
    const source = await fs.readFile(extensionUrl);
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "8dd309b9ed85d93b85329bc0b0c1965e3947cf650ee54b233149b1b53d60fbb9",
    );
    expect(source.toString("utf8")).toContain("fs.realpath(candidate)");
  });
});
