import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// The legacy native FunkyDev tool surface, captured by executing vector-os
// agents/piext/*.ts (see vector-os contracts/FUNKYDEV_LEGACY_TOOL_SNAPSHOT.json,
// of which this fixture is a byte-for-byte copy checked at build time).
type LegacyTool = {
  extension: string;
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
};
type Snapshot = {
  tools: LegacyTool[];
  prompt_guidelines: Array<{ extension: string; event: string; system_prompt_append: string }>;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshotPath = path.join(here, "fixtures", "funkydev-legacy-tool-snapshot.json");

// speak is the sealed Vector OS asset (tool-assets/engineering/speak.ts); its
// parity is enforced in vector-os. Every other legacy tool is served here.
const VAULT_TOOLS = new Set(["vault_read", "vault_search"]);
const VECTOR_OS_ASSET_TOOLS = new Set(["speak"]);

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function loadSnapshot(): Promise<Snapshot> {
  return JSON.parse(await fs.readFile(snapshotPath, "utf8")) as Snapshot;
}

async function bridgeWith(tools: string[], respond: (tool: string, args: any) => Response) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fd-parity-"));
  roots.push(root);
  const capabilityPath = path.join(root, "authority.json");
  await fs.writeFile(capabilityPath, JSON.stringify({
    version: 1,
    callbackUrl: "http://127.0.0.1:3100/api/internal/vector/v1/tools/callback",
    bearerToken: "p".repeat(43),
    tools,
  }), { mode: 0o600 });
  vi.stubEnv("PAPERCLIP_VECTOR_TOOL_AUTHORITY_FILE", capabilityPath);
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return respond(body.tool, body.arguments);
  });
  vi.stubGlobal("fetch", fetchMock);
  const { default: extension } = await import("../vector-extensions/vector-tool-bridge.js");
  const registered: Array<Record<string, any>> = [];
  const handlers: Array<[string, (event: any) => Promise<any>]> = [];
  extension({
    registerTool: (tool: Record<string, any>) => registered.push(tool),
    on: (event: string, handler: (event: any) => Promise<any>) => handlers.push([event, handler]),
  } as any);
  return { registered, handlers, fetchMock };
}

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

describe("FunkyDev legacy tool parity", () => {
  it("serves every legacy callback tool with the exact legacy label, description, and schema", async () => {
    const snapshot = await loadSnapshot();
    const legacy = snapshot.tools.filter((tool) => !VAULT_TOOLS.has(tool.name) && !VECTOR_OS_ASSET_TOOLS.has(tool.name));
    expect(legacy.map((tool) => tool.name).sort()).toEqual([
      "ask_user", "memory_forget", "memory_save", "memory_search",
      "todo_add", "todo_list", "todo_mark_done", "todo_update",
    ]);
    const { registered } = await bridgeWith(legacy.map((tool) => tool.name), () => json(200, { result: null }));
    for (const tool of legacy) {
      const got = registered.find((candidate) => candidate.name === tool.name);
      expect(got, `legacy tool ${tool.name} is missing`).toBeDefined();
      expect({ label: got!.label, description: got!.description, parameters: got!.parameters }, tool.name).toEqual({
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
      });
    }
  });

  it("serves the vault tools with the exact legacy label, description, and schema", async () => {
    const snapshot = await loadSnapshot();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fd-vault-parity-"));
    roots.push(root);
    vi.stubEnv("PI_VAULT_REFERENCE_ROOT", root);
    // Pi supplies typebox to extensions at runtime; the fork does not install
    // it. This shim reproduces TypeBox 1.3.7's JSON for the constructors the
    // Vault extension uses (Object, String, Integer, Optional).
    const optional = Symbol("optional");
    vi.doMock("typebox", () => ({
      Type: {
        String: (options: object = {}) => ({ type: "string", ...options }),
        Integer: (options: object = {}) => ({ type: "integer", ...options }),
        Optional: (schema: object) => ({ ...schema, [optional]: true }),
        Object: (properties: Record<string, any>) => {
          const required = Object.keys(properties).filter((key) => !properties[key][optional]);
          return { type: "object", ...(required.length ? { required } : {}), properties };
        },
      },
    }));
    const { default: extension } = await import("../vector-extensions/funkydev-vault-reference.js");
    const registered: Array<Record<string, any>> = [];
    extension({ registerTool: (tool: Record<string, any>) => registered.push(tool), on: () => undefined } as any);
    for (const tool of snapshot.tools.filter((candidate) => VAULT_TOOLS.has(candidate.name))) {
      const got = registered.find((candidate) => candidate.name === tool.name);
      expect(got, `legacy tool ${tool.name} is missing`).toBeDefined();
      expect({ label: got!.label, description: got!.description, parameters: JSON.parse(JSON.stringify(got!.parameters)) }, tool.name).toEqual({
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
      });
    }
  });

  it("appends the legacy task-tracker guideline and saved-notes recall verbatim", async () => {
    const snapshot = await loadSnapshot();
    const guideline = (extension: string) =>
      snapshot.prompt_guidelines.find((entry) => entry.extension === extension)!.system_prompt_append;
    const core = { slug: "core-note", summary: "<CORE_SUMMARY>", body: "<CORE_BODY>", tier: "core" };
    const recent = { slug: "recent-note", summary: "<RECENT_SUMMARY>", body: "ignored", tier: "standard" };
    const { handlers, fetchMock } = await bridgeWith(["todo_add", "memory_search"], (tool, args) => {
      expect(tool).toBe("memory_search");
      return json(200, { result: { memories: args.recall === "core" ? [core] : [core, recent] } });
    });
    expect(handlers.map(([event]) => event)).toEqual(["before_agent_start"]);
    const output = await handlers[0][1]({ systemPrompt: "BASE" });
    expect(output.systemPrompt).toBe("BASE" + guideline("todo.ts") + guideline("memory.ts"));
    const recalls = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).arguments);
    expect(recalls).toEqual([
      { query: "", recall: "core", limit: 25 },
      { query: "", recall: "recent", limit: 100 },
    ]);
  });

  it("adds no saved-notes section when recall is empty or unavailable", async () => {
    const { handlers } = await bridgeWith(["memory_search"], () => json(502, { error: "tool_execution_failed" }));
    const output = await handlers[0][1]({ systemPrompt: "BASE" });
    expect(output.systemPrompt).toBe("BASE");
  });

  it("carries no Vector GitHub tool definitions; GitHub is Paperclip's connector", async () => {
    const snapshot = await loadSnapshot();
    expect(snapshot.tools.some((tool) => tool.name.startsWith("github_") || tool.name === "publish_branch")).toBe(false);
    const source = await fs.readFile(path.join(here, "..", "vector-extensions", "vector-tool-bridge.ts"), "utf8");
    expect(source).not.toMatch(/\b(github_read|github_manage|github_api|github_repo|publish_branch)\b/);
  });

  it("returns a refusal to the model as a tool result so it can correct the call", async () => {
    const { registered } = await bridgeWith(["todo_add"], () =>
      json(422, { error: "tool_refused", message: "todo_add requires a non-empty title" }));
    const output = await registered[0].execute("call-todo", { title: "" });
    expect(output).toEqual({
      content: [{ type: "text", text: "todo_add refused: todo_add requires a non-empty title" }],
      details: null,
    });
  });

  it("still fails closed on a transport or authority failure", async () => {
    const { registered } = await bridgeWith(["todo_list"], () => json(403, { error: "invalid_authority" }));
    await expect(registered[0].execute("call-todo", {})).rejects.toThrow("failed with status 403");
  });
});
