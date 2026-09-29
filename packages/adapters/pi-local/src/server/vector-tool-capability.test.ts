import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareVectorToolCapability } from "./vector-tool-capability.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Vector tool capability file", () => {
  it("keeps the run bearer out of the Pi environment and removes the private file", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-vector-tool-test-"));
    roots.push(tempRoot);
    const prepared = await prepareVectorToolCapability(
      {
        callbackUrl: "http://127.0.0.1:3100/api/internal/vector/v1/tools/callback",
        bearerToken: "run-private-bearer",
        tools: ["ask_user", "todo_write"],
      },
      { remote: false, tempRoot },
    );
    const capabilityPath = prepared.env.PAPERCLIP_VECTOR_TOOL_AUTHORITY_FILE;
    const stat = await fs.stat(capabilityPath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(prepared.env).toEqual({
      PAPERCLIP_VECTOR_TOOL_AUTHORITY_FILE: capabilityPath,
    });
    expect(JSON.parse(await fs.readFile(capabilityPath, "utf8"))).toEqual({
      version: 1,
      callbackUrl: "http://127.0.0.1:3100/api/internal/vector/v1/tools/callback",
      bearerToken: "run-private-bearer",
      tools: ["ask_user", "todo_write"],
    });

    await prepared.cleanup();
    await expect(fs.stat(capabilityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for remote execution instead of copying the bearer", async () => {
    await expect(prepareVectorToolCapability(
      {
        callbackUrl: "http://127.0.0.1:3100/api/internal/vector/v1/tools/callback",
        bearerToken: "run-private-bearer",
        tools: ["ask_user"],
      },
      { remote: true },
    )).rejects.toThrow("requires a local Pi execution target");
  });
});
