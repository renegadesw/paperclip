import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

/**
 * Paperclip connector delivery for Pi.
 *
 * Pi has no MCP client. Other local adapters receive the run's granted
 * connections as `ctx.runtimeMcp` servers (one Paperclip tool-gateway endpoint
 * per assignment, each with a short-lived run token) and pass them to their
 * CLI's native MCP support. For Pi the adapter lists each gateway's tools
 * before spawn, writes them and the endpoints to a private capability file,
 * and the adapter-owned `paperclip-connectors` extension registers them as Pi
 * tools that call `tools/call` on the same gateway. The gateway, not this
 * code, enforces grants, write/destructive approval, and audit.
 *
 * The tool names are known before spawn, so the Vector profile policy can add
 * exactly them to Pi's `--tools` allowlist. No profile gains Pi built-ins or
 * filesystem/shell authority from a connector.
 */

export const PAPERCLIP_CONNECTOR_TOOLS_ENV = "PAPERCLIP_CONNECTOR_TOOLS_FILE";

export interface ConnectorToolDescriptor {
  name: string;
  upstreamName: string;
  server: number;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PreparedConnectorTools {
  toolNames: string[];
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

const NONE: PreparedConnectorTools = { toolNames: [], env: {}, cleanup: async () => undefined };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Parse a JSON-RPC response carried either as JSON or as one SSE message. */
export function parseJsonRpcBody(text: string, contentType: string | null): Record<string, unknown> {
  if ((contentType ?? "").includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    for (let i = data.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = record(JSON.parse(data[i]!));
        if ("result" in parsed || "error" in parsed) return parsed;
      } catch {
        // keep scanning earlier frames
      }
    }
    throw new Error("MCP gateway returned no JSON-RPC message");
  }
  return record(JSON.parse(text));
}

async function rpc(
  server: AdapterRuntimeMcpServer,
  method: string,
  params: Record<string, unknown>,
  fetchImpl: typeof fetch,
  id: string | null,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(server.url, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${server.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
  });
  if (id === null) return {};
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const payload = parseJsonRpcBody(await response.text(), response.headers.get("content-type"));
  if (payload.error) throw new Error(`${method} failed: ${String(record(payload.error).message ?? "error")}`);
  return record(payload.result);
}

function piToolName(upstream: string, taken: Set<string>): string {
  const base = upstream.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 60) || "connector_tool";
  let name = base;
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}_${suffix}`;
  taken.add(name);
  return name;
}

/**
 * List every granted gateway's tools. A gateway that cannot be listed
 * contributes nothing: its tools are absent, never guessed.
 */
export async function discoverConnectorTools(
  servers: readonly AdapterRuntimeMcpServer[],
  reservedNames: readonly string[],
  options: { fetchImpl?: typeof fetch; onError?: (server: AdapterRuntimeMcpServer, error: unknown) => void } = {},
): Promise<ConnectorToolDescriptor[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const taken = new Set(reservedNames);
  const tools: ConnectorToolDescriptor[] = [];
  for (const [index, server] of servers.entries()) {
    try {
      await rpc(server, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "paperclip-pi", version: "1" },
      }, fetchImpl, `pi-connectors-${index}-initialize`);
      await rpc(server, "notifications/initialized", {}, fetchImpl, null);
      const listed = await rpc(server, "tools/list", {}, fetchImpl, `pi-connectors-${index}-tools`);
      for (const raw of Array.isArray(listed.tools) ? listed.tools : []) {
        const tool = record(raw);
        const upstreamName = typeof tool.name === "string" ? tool.name.trim() : "";
        if (!upstreamName) continue;
        const schema = record(tool.inputSchema);
        tools.push({
          name: piToolName(upstreamName, taken),
          upstreamName,
          server: index,
          description: typeof tool.description === "string" && tool.description.trim()
            ? tool.description
            : `${server.name}: ${upstreamName}`,
          inputSchema: Object.keys(schema).length > 0 ? schema : { type: "object", properties: {} },
        });
      }
    } catch (error) {
      options.onError?.(server, error);
    }
  }
  return tools;
}

/** Write the private capability file the connector extension reads. */
export async function prepareConnectorTools(
  servers: readonly AdapterRuntimeMcpServer[],
  reservedNames: readonly string[],
  options: {
    remote: boolean;
    tempRoot?: string;
    fetchImpl?: typeof fetch;
    onError?: (server: AdapterRuntimeMcpServer, error: unknown) => void;
  },
): Promise<PreparedConnectorTools> {
  if (servers.length === 0 || options.remote) return NONE;
  const tools = await discoverConnectorTools(servers, reservedNames, options);
  if (tools.length === 0) return NONE;
  const root = await fs.mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "paperclip-pi-connectors-"));
  await fs.chmod(root, 0o700);
  const file = path.join(root, "connectors.json");
  try {
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      servers: servers.map(({ url, token }) => ({ url, token })),
      tools,
    }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    toolNames: tools.map((tool) => tool.name),
    env: { [PAPERCLIP_CONNECTOR_TOOLS_ENV]: file },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
