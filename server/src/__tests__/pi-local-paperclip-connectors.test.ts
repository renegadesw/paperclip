import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-pi-local/server";

// A fake RPC Pi that records its argv and environment, then settles one turn.
async function writeRecordingPi(commandPath: string, argsPath: string, envPath: string): Promise<void> {
  await fs.writeFile(commandPath, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("router    Qwen3.8-Flash");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify(process.env));
let handled = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (handled || !chunk.includes("\\n")) return;
  handled = true;
  const command = JSON.parse(chunk.slice(0, chunk.indexOf("\\n")));
  console.log(JSON.stringify({ type: "response", command: "prompt", success: true, id: command.id }));
  console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolResults: [] }));
  console.log(JSON.stringify({ type: "agent_settled" }));
});
process.stdin.on("end", () => process.exit(0));
`, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function withGateway<T>(fn: (url: string, calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const message = JSON.parse(body);
      calls.push(`${req.headers.authorization} ${message.method}`);
      if (message.method === "notifications/initialized") { res.statusCode = 202; res.end(); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: message.method === "tools/list"
          ? { tools: [{ name: "create_pull_request", description: "Open a pull request", inputSchema: { type: "object" } }] }
          : { protocolVersion: "2025-03-26" },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/gateways/gw-1`, calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runPi(profile: string, options: { servers?: Array<{ name: string; url: string; token: string; connectionId: string }>; env?: Record<string, string> }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-connectors-"));
  const workspace = path.join(root, "workspace");
  const commandPath = path.join(root, "pi");
  const argsPath = path.join(root, "args.json");
  const envPath = path.join(root, "env.json");
  await fs.mkdir(workspace, { recursive: true });
  await writeRecordingPi(commandPath, argsPath, envPath);
  const saved = { ...process.env };
  Object.assign(process.env, {
    HOME: root,
    PAPERCLIP_DATABASE_PROFILE: "vector-embedded",
    PAPERCLIP_VECTOR_PROFILE: profile,
    PAPERCLIP_VECTOR_PI_COMMAND: commandPath,
  });
  let connectorFileDuringRun: string | undefined;
  try {
    const result = await execute({
      runId: `run-connectors-${profile}`,
      agent: { id: "agent-1", companyId: "company-1", name: "Pi", adapterType: "pi_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath,
        cwd: workspace,
        model: "router/Qwen3.8-Flash",
        executionMode: "rpc",
        promptTemplate: "Work.",
        ...(options.env ? { env: options.env } : {}),
      },
      context: {},
      runtimeMcp: { getServers: () => options.servers ?? [] },
      authToken: "run-token",
      onLog: async () => {},
    });
    const args = JSON.parse(await fs.readFile(argsPath, "utf8")) as string[];
    const env = JSON.parse(await fs.readFile(envPath, "utf8")) as Record<string, string>;
    connectorFileDuringRun = env.PAPERCLIP_CONNECTOR_TOOLS_FILE;
    return { result, args, env, connectorFileDuringRun };
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await fs.rm(root, { recursive: true, force: true });
  }
}

function toolsArg(args: string[]): string[] {
  const values = args.flatMap((arg, index) => (arg === "--tools" ? [args[index + 1] ?? ""] : []));
  return values.flatMap((value) => value.split(","));
}

describe("pi_local Paperclip connector delivery", () => {
  it("delivers a granted connector's tools to a Standard run without Pi built-ins", async () => {
    await withGateway(async (url, calls) => {
      const { result, args, env, connectorFileDuringRun } = await runPi("standard", {
        servers: [{ name: "GitHub", url, token: "gateway-run-token", connectionId: "conn-1" }],
      });
      expect(result.exitCode).toBe(0);
      expect(calls).toEqual([
        "Bearer gateway-run-token initialize",
        "Bearer gateway-run-token notifications/initialized",
        "Bearer gateway-run-token tools/list",
      ]);
      expect(toolsArg(args)).toEqual(["create_pull_request"]);
      expect(args).toContain("--no-builtin-tools");
      const extension = args[args.lastIndexOf("--extension") + 1] ?? "";
      expect(path.basename(extension)).toMatch(/^paperclip-connectors\.(js|ts)$/);
      expect(connectorFileDuringRun).toBeTruthy();
      await expect(fs.stat(connectorFileDuringRun!)).rejects.toThrow();
      expect(env).not.toHaveProperty("PAPERCLIP_GITHUB_BROKER_TOKEN");
    });
  });

  it("delivers nothing extra when no connection is granted", async () => {
    const { args, env } = await runPi("standard", {});
    expect(args).toContain("--no-tools");
    expect(args.join(" ")).not.toContain("paperclip-connectors");
    expect(env).not.toHaveProperty("PAPERCLIP_CONNECTOR_TOOLS_FILE");
  });

  it("forwards Paperclip's GitHub launchers to FunkyDev's shell and admits connector tools beside built-ins", async () => {
    await withGateway(async (url) => {
      const { args, env } = await runPi("engineering", {
        servers: [{ name: "GitHub", url, token: "gateway-run-token", connectionId: "conn-1" }],
        env: {
          PATH: `/run/github-launchers:${process.env.PATH ?? ""}`,
          PAPERCLIP_GITHUB_BROKER_URL: "http://127.0.0.1:3100",
          PAPERCLIP_GITHUB_BROKER_TOKEN: "broker-run-token",
          PAPERCLIP_GITHUB_LAUNCHER_DIR: "/run/github-launchers",
          GH_CONFIG_DIR: "/run/github-launchers/gh-config",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      expect(toolsArg(args)).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "create_pull_request"]));
      // Only Paperclip's skill bin dirs may precede the launchers; system git/gh never do.
      const entries = (env.PATH ?? "").split(path.delimiter);
      const launcher = entries.indexOf("/run/github-launchers");
      expect(launcher).toBeGreaterThanOrEqual(0);
      expect(entries.slice(0, launcher).every((entry) => entry.includes(`${path.sep}skills${path.sep}`))).toBe(true);
      expect(env).toMatchObject({
        PAPERCLIP_GITHUB_BROKER_URL: "http://127.0.0.1:3100",
        PAPERCLIP_GITHUB_BROKER_TOKEN: "broker-run-token",
        GH_CONFIG_DIR: "/run/github-launchers/gh-config",
        GIT_CONFIG_GLOBAL: "/dev/null",
      });
    });
  });
});
