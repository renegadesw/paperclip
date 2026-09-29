import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverConnectorTools, parseJsonRpcBody, prepareConnectorTools } from "./paperclip-connectors.js";
import { prepareVectorPiProfilePolicy, withPaperclipConnectorTools } from "./vector-profile-policy.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const github = { name: "GitHub", url: "http://127.0.0.1:3100/mcp/gateways/gw-github", token: "run-token-1", connectionId: "c-1" };
const google = { name: "Google Drive", url: "http://127.0.0.1:3100/mcp/gateways/gw-drive", token: "run-token-2", connectionId: "c-2" };

function gateway(tools: Record<string, Array<Record<string, unknown>>>, failing = new Set<string>()) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (failing.has(String(url))) return new Response("{}", { status: 503 });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } });
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: tools[String(url)] ?? [] } });
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { message: "unexpected" } });
  });
}

describe("Paperclip connector delivery for Pi", () => {
  it("lists each granted gateway with its run token and names tools without colliding", async () => {
    const fetchImpl = gateway({
      [github.url]: [
        { name: "create_pull_request", description: "Open a PR", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
        { name: "bash" },
      ],
      [google.url]: [{ name: "drive.create_file" }, { name: "create_pull_request" }],
    });
    const tools = await discoverConnectorTools([github, google], ["read", "bash", "todo_add"], { fetchImpl: fetchImpl as typeof fetch });
    expect(tools.map((tool) => [tool.name, tool.upstreamName, tool.server])).toEqual([
      ["create_pull_request", "create_pull_request", 0],
      ["bash_2", "bash", 0],
      ["drive_create_file", "drive.create_file", 1],
      ["create_pull_request_2", "create_pull_request", 1],
    ]);
    expect(tools[0]!.description).toBe("Open a PR");
    const auth = fetchImpl.mock.calls.map(([url, init]) => [String(url), (init?.headers as Record<string, string>).authorization]);
    expect(auth.filter(([url]) => url === github.url).every(([, header]) => header === "Bearer run-token-1")).toBe(true);
    expect(auth.filter(([url]) => url === google.url).every(([, header]) => header === "Bearer run-token-2")).toBe(true);
  });

  it("omits a gateway that cannot be listed instead of guessing its tools", async () => {
    const errors: string[] = [];
    const fetchImpl = gateway({ [google.url]: [{ name: "search" }] }, new Set([github.url]));
    const tools = await discoverConnectorTools([github, google], [], {
      fetchImpl: fetchImpl as typeof fetch,
      onError: (server) => errors.push(server.name),
    });
    expect(tools.map((tool) => tool.upstreamName)).toEqual(["search"]);
    expect(errors).toEqual(["GitHub"]);
  });

  it("reads SSE-framed JSON-RPC responses", () => {
    expect(parseJsonRpcBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n', "text/event-stream"))
      .toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("writes a private capability file and nothing for remote targets or no grants", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-connectors-test-"));
    roots.push(root);
    const fetchImpl = gateway({ [github.url]: [{ name: "merge_pull_request" }] });
    const prepared = await prepareConnectorTools([github], [], { remote: false, tempRoot: root, fetchImpl: fetchImpl as typeof fetch });
    expect(prepared.toolNames).toEqual(["merge_pull_request"]);
    const file = prepared.env.PAPERCLIP_CONNECTOR_TOOLS_FILE!;
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(file, "utf8")).servers).toEqual([{ url: github.url, token: "run-token-1" }]);
    await prepared.cleanup();
    await expect(fs.stat(file)).rejects.toThrow();
    expect((await prepareConnectorTools([github], [], { remote: true, fetchImpl: fetchImpl as typeof fetch })).toolNames).toEqual([]);
    expect((await prepareConnectorTools([], [], { remote: false })).toolNames).toEqual([]);
  });

  it("admits connector tools on restricted profiles without enabling Pi built-ins", async () => {
    for (const profile of ["standard", "staging", "production", "demo"]) {
      const base = await prepareVectorPiProfilePolicy({ profile, config: {}, command: "pi" });
      expect(base.cliArgs).toContain("--no-tools");
      const policy = withPaperclipConnectorTools(base, "/release/paperclip-connectors.js", ["create_pull_request", "search"]);
      expect(policy.restricted).toBe(true);
      expect(policy.cliArgs).not.toContain("--no-tools");
      expect(policy.cliArgs.slice(policy.cliArgs.indexOf("--tools"), policy.cliArgs.indexOf("--tools") + 2))
        .toEqual(["--tools", "create_pull_request,search"]);
      expect(policy.cliArgs.slice(-2)).toEqual(["--extension", "/release/paperclip-connectors.js"]);
      for (const builtin of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
        expect(policy.cliArgs.join(" ")).not.toMatch(new RegExp(`--tools \\S*\\b${builtin}\\b`));
      }
    }
  });

  it("extends an existing restricted allowlist and the engineering tool list", async () => {
    const restricted = withPaperclipConnectorTools({
      profile: "standard", restricted: true, cliArgs: ["--tools", "ask_user,speak", "--extension", "/b.js"],
      discoveryCliArgs: [], useBundledPaperclipSkillsOnly: true, additionalToolNames: [],
    }, "/c.js", ["search"]);
    expect(restricted.cliArgs).toEqual(["--tools", "ask_user,speak,search", "--extension", "/b.js", "--extension", "/c.js"]);
    const engineering = withPaperclipConnectorTools(
      await prepareVectorPiProfilePolicy({ profile: "engineering", config: {} }),
      "/c.js",
      ["create_pull_request"],
    );
    expect(engineering.additionalToolNames).toEqual(["create_pull_request"]);
    expect(engineering.cliArgs).toEqual(["--extension", "/c.js"]);
  });

  it("the extension registers the listed tools and forwards calls to the gateway", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-connectors-ext-"));
    roots.push(root);
    const file = path.join(root, "connectors.json");
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      servers: [{ url: github.url, token: "run-token-1" }],
      tools: [{ name: "create_pull_request", upstreamName: "create_pull_request", server: 0, description: "Open a PR", inputSchema: { type: "object" } }],
    }), { mode: 0o600 });
    vi.stubEnv("PAPERCLIP_CONNECTOR_TOOLS_FILE", file);
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.params.arguments.title === "deny") {
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "approval required" } });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "PR #7 opened" }] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { default: extension } = await import("../vector-extensions/paperclip-connectors.js");
    const registered: Array<Record<string, any>> = [];
    extension({ registerTool: (tool: Record<string, any>) => registered.push(tool) } as any);
    expect(registered.map((tool) => [tool.name, tool.description])).toEqual([["create_pull_request", "Open a PR"]]);
    const output = await registered[0]!.execute("call-1", { title: "Fix" });
    expect(output.content).toEqual([{ type: "text", text: "PR #7 opened" }]);
    const request = fetchMock.mock.calls[0]!;
    expect(String(request[0])).toBe(github.url);
    expect((request[1]!.headers as Record<string, string>).authorization).toBe("Bearer run-token-1");
    expect(JSON.parse(String(request[1]!.body))).toMatchObject({ method: "tools/call", params: { name: "create_pull_request", arguments: { title: "Fix" } } });
    const denied = await registered[0]!.execute("call-2", { title: "deny" });
    expect(denied.content[0].text).toBe("create_pull_request refused: approval required");
  });
});

describe("restricted profiles and controller-owned run env", () => {
  it("accepts Paperclip's git/scratch env but still rejects agent env by name", async () => {
    const controllerEnv = {
      PATH: "/run/launchers:/usr/bin", GH_CONFIG_DIR: "/run/launchers/gh", GIT_CONFIG_GLOBAL: "/dev/null",
      PAPERCLIP_GITHUB_BROKER_TOKEN: "t", PAPERCLIP_GIT_METADATA_ROOTS: "[]", PAPERCLIP_RUNNER_NETWORK_ACCESS: "enabled",
      TMPDIR: "/run/tmp", PAPERCLIP_RUN_SCRATCH_DIR: "/run/scratch",
    };
    await expect(prepareVectorPiProfilePolicy({ profile: "standard", config: { env: controllerEnv }, command: "pi", agentConfiguredEnv: {} }))
      .resolves.toMatchObject({ restricted: true });
    await expect(prepareVectorPiProfilePolicy({ profile: "standard", config: { env: { ...controllerEnv, OPENAI_API_KEY: "x" } }, command: "pi", agentConfiguredEnv: {} }))
      .rejects.toThrow("forbids mutable agent env (OPENAI_API_KEY)");
    // A controller-shaped key the agent itself configured is still rejected.
    await expect(prepareVectorPiProfilePolicy({ profile: "standard", config: { env: controllerEnv }, command: "pi", agentConfiguredEnv: { PATH: "/evil" } }))
      .rejects.toThrow("forbids mutable agent env (PATH)");
  });
});
