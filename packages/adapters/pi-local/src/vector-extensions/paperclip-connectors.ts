// @ts-nocheck
/*
 * paperclip-connectors — the run's granted Paperclip connections as Pi tools.
 *
 * The pi_local adapter lists each granted Paperclip tool-gateway endpoint
 * before spawn and writes the tools and endpoints to a private 0600 file named
 * by PAPERCLIP_CONNECTOR_TOOLS_FILE. This extension registers exactly those
 * tools and forwards each call to the same gateway's `tools/call`. The gateway
 * enforces the grant, write and destructive approval, and audit. This file
 * holds no credential beyond the run-scoped gateway token and has no
 * filesystem or shell authority.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

interface Capability {
  version: 1;
  servers: Array<{ url: string; token: string }>;
  tools: Array<{ name: string; upstreamName: string; server: number; description: string; inputSchema: Record<string, unknown> }>;
}

function loadCapability(): Capability | null {
  const file = (process.env.PAPERCLIP_CONNECTOR_TOOLS_FILE ?? "").trim();
  if (!file) return null;
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<Capability>;
  if (
    value.version !== 1 ||
    !Array.isArray(value.servers) ||
    !Array.isArray(value.tools) ||
    value.servers.some((server) => {
      try {
        const url = new URL(server?.url ?? "");
        return (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password ||
          typeof server.token !== "string" || server.token.length === 0;
      } catch {
        return true;
      }
    }) ||
    value.tools.some((tool) =>
      typeof tool?.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(tool.name) ||
      typeof tool.upstreamName !== "string" || tool.upstreamName.length === 0 ||
      !Number.isInteger(tool.server) || tool.server < 0 || tool.server >= value.servers!.length)
  ) {
    throw new Error("Paperclip connector capability file is invalid");
  }
  return value as Capability;
}

const capability = loadCapability();

function parseBody(text: string, contentType: string | null) {
  if ((contentType ?? "").includes("text/event-stream")) {
    const frames = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(frames[i]);
        if (parsed && ("result" in parsed || "error" in parsed)) return parsed;
      } catch {
        // earlier frame
      }
    }
    return null;
  }
  return text ? JSON.parse(text) : null;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item && typeof item === "object" && item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(item)))
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  if (!capability) return;
  for (const tool of capability.tools) {
    const server = capability.servers[tool.server];
    pi.registerTool({
      name: tool.name,
      label: tool.upstreamName,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_id, args, signal) {
        const response = await fetch(server.url, {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${server.token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: randomUUID(),
            method: "tools/call",
            params: { name: tool.upstreamName, arguments: args ?? {} },
          }),
          signal,
        });
        const payload = parseBody(await response.text(), response.headers.get("content-type"));
        if (!response.ok && !payload?.error) {
          throw new Error(`Connector tool ${tool.upstreamName} failed with status ${response.status}`);
        }
        if (payload?.error) {
          // A gateway denial or approval hold is the tool's answer; return it
          // so the model can adjust instead of ending the turn.
          const message = typeof payload.error.message === "string" ? payload.error.message : "denied";
          return { content: [{ type: "text" as const, text: `${tool.upstreamName} refused: ${message}` }], details: payload.error };
        }
        const result = payload?.result ?? {};
        const text = textOf(result.content) || JSON.stringify(result.structuredContent ?? result);
        return { content: [{ type: "text" as const, text }], details: result };
      },
    });
  }
}
