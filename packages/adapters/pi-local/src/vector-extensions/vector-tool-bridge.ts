// @ts-nocheck
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";

interface Capability {
  version: 1;
  callbackUrl: string;
  bearerToken: string;
  tools: string[];
}

function loadCapability(): Capability | null {
  const capabilityPath = (process.env.PAPERCLIP_VECTOR_TOOL_AUTHORITY_FILE ?? "").trim();
  if (!capabilityPath) return null;
  let raw: string;
  try {
    raw = readFileSync(capabilityPath, "utf8");
  } finally {
    unlinkSync(capabilityPath);
  }
  const value = JSON.parse(raw) as Partial<Capability>;
  const url = new URL(value.callbackUrl ?? "");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (
    value.version !== 1 ||
    url.protocol !== "http:" ||
    !loopback ||
    url.username ||
    url.password ||
    url.pathname !== "/api/internal/vector/v1/tools/callback" ||
    url.search ||
    url.hash ||
    typeof value.bearerToken !== "string" ||
    !/^[A-Za-z0-9_-]{32,}$/.test(value.bearerToken) ||
    !Array.isArray(value.tools) ||
    value.tools.length === 0 ||
    value.tools.some((tool) =>
      typeof tool !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(tool)
    )
  ) {
    throw new Error("Vector tool capability file is invalid");
  }
  return value as Capability;
}

const capability = loadCapability();

function result(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  };
}

export default function (pi: ExtensionAPI) {
  if (!capability) return;
  for (const tool of capability.tools) {
    pi.registerTool({
      name: tool,
      label: tool.replace(/[_.:-]+/g, " "),
      description: `Run the deployment-owned Vector tool ${tool} with this run's bounded authority.`,
      parameters: {
        type: "object",
        additionalProperties: true,
      },
      async execute(_id, args, signal) {
        const response = await fetch(capability.callbackUrl, {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${capability.bearerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            requestId: randomUUID(),
            tool,
            arguments: args,
          }),
          signal,
        });
        const text = await response.text();
        let payload: unknown;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          throw new Error(`Vector tool ${tool} returned an invalid response`);
        }
        if (!response.ok) {
          throw new Error(`Vector tool ${tool} failed with status ${response.status}`);
        }
        if (!payload || typeof payload !== "object" || !("result" in payload)) {
          throw new Error(`Vector tool ${tool} returned an invalid result envelope`);
        }
        return result((payload as { result: unknown }).result);
      },
    });
  }
}
