import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Vector tool bridge extension", () => {
  it("retains the private file for run-local shims and relays only its approved tools", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-vector-bridge-test-"));
    roots.push(root);
    const capabilityPath = path.join(root, "authority.json");
    await fs.writeFile(capabilityPath, JSON.stringify({
      version: 1,
      callbackUrl: "http://127.0.0.1:3100/api/internal/vector/v1/tools/callback",
      bearerToken: "a".repeat(43),
      tools: ["ask_user"],
    }), { mode: 0o600 });
    vi.stubEnv("PAPERCLIP_VECTOR_TOOL_AUTHORITY_FILE", capabilityPath);
    const fetchMock = vi.fn(
      async (..._args: [RequestInfo | URL, RequestInit?]) => new Response(
        JSON.stringify({ result: { answer: "approved" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { default: extension } = await import("../vector-extensions/vector-tool-bridge.js");
    expect((await fs.stat(capabilityPath)).mode & 0o777).toBe(0o600);
    const registered: Array<Record<string, any>> = [];
    extension({ registerTool: (tool: Record<string, any>) => registered.push(tool) } as any);
    expect(registered.map((tool) => tool.name)).toEqual(["ask_user"]);

    const output = await registered[0].execute("call-1", { question: "Proceed?" });
    expect(output.details).toEqual({ answer: "approved" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.headers).toMatchObject({ authorization: `Bearer ${"a".repeat(43)}` });
    expect(JSON.parse(request.body as string)).toMatchObject({
      tool: "ask_user",
      arguments: { question: "Proceed?" },
    });
  });

  it("registers the exact GitHub tool schemas and preserves callback arguments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-vector-github-tools-test-"));
    roots.push(root);
    const capabilityPath = path.join(root, "authority.json");
    await fs.writeFile(capabilityPath, JSON.stringify({
      version: 1,
      callbackUrl: "http://127.0.0.1:3100/api/internal/vector/v1/tools/callback",
      bearerToken: "b".repeat(43),
      tools: ["github_read", "github_manage", "github_api", "github_repo"],
    }), { mode: 0o600 });
    vi.stubEnv("PAPERCLIP_VECTOR_TOOL_AUTHORITY_FILE", capabilityPath);
    const fetchMock = vi.fn(
      async (..._args: [RequestInfo | URL, RequestInit?]) => new Response(
        JSON.stringify({ result: { ok: true } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { default: extension } = await import("../vector-extensions/vector-tool-bridge.js");
    const registered: Array<Record<string, any>> = [];
    extension({ registerTool: (tool: Record<string, any>) => registered.push(tool) } as any);

    expect(registered.map((tool) => tool.name)).toEqual([
      "github_read",
      "github_manage",
      "github_api",
      "github_repo",
    ]);
    const literals = (schema: { anyOf: Array<{ const: string }> }) => schema.anyOf.map((entry) => entry.const);
    expect(literals(registered[0].parameters.properties.kind)).toEqual([
      "pr_view", "pr_diff", "pr_checks", "run_failures", "pr_list", "issue_list", "repo_list", "file_read",
    ]);
    expect(literals(registered[1].parameters.properties.kind)).toContain("merge");
    expect(literals(registered[2].parameters.properties.method)).toEqual(["GET", "POST", "PATCH", "PUT", "DELETE"]);
    expect(literals(registered[3].parameters.properties.kind)).toContain("publish");
    expect(registered[2].description).toContain("exact-head guard");

    const args = { kind: "pr_view", repo: "renegadesw/vector-os", number: 168 };
    await registered[0].execute("call-github", args);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
      tool: "github_read",
      arguments: args,
    });
  });
});
