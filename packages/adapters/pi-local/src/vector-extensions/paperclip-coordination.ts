// @ts-nocheck
// Adapter-owned control-plane tools. The existing API enforces company, run,
// checkout, review and approval authority; this extension never mints a grant.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const actions = ["me", "agents", "projects", "issues", "issue", "create_issue", "update_issue", "checkout", "release", "comments", "comment", "wake"];
class ArgumentError extends Error {}
const id = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ArgumentError("A valid resource id is required; use the issue UUID/identifier or agent ID from a list result");
  return encodeURIComponent(value);
};

export default function (pi: ExtensionAPI) {
  const env = process.env;
  const token = env.PAPERCLIP_API_KEY?.trim();
  const company = env.PAPERCLIP_COMPANY_ID?.trim();
  const agent = env.PAPERCLIP_AGENT_ID?.trim();
  const run = env.PAPERCLIP_RUN_ID?.trim();
  const origin = env.PAPERCLIP_API_URL?.trim();
  if (!token || !company || !agent || !run || !origin) return;
  let base: URL;
  try { base = new URL(origin); } catch { throw new Error("Invalid Paperclip API origin"); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || !["", "/", "/api", "/api/"].includes(base.pathname)) {
    throw new Error("Invalid Paperclip API origin");
  }
  base.pathname = "/api/";
  const companyPath = `companies/${id(company)}`;
  pi.registerTool({
    name: "paperclip",
    label: "Paperclip coordination",
    description: "Coordinate this run's company directly. Actions: me; agents; projects; issues (query filters projectId, assigneeAgentId, status, q, limit, offset); issue/comments (id); create_issue (body); update_issue (id, body); checkout (id, body.expectedStatuses; checks out as this agent); release (id); comment (id, body.body); wake (agent id, body). Use update_issue to assign and activate ready work: body assigneeAgentId/status/parentId/comment. Preserve dependencies and review gates. A 409 checkout conflict means stop working that issue, never retry or bypass its owner. Mutations use the current run and the API's existing authorization. Verify writes with issue. Do not discover this tool through search_tools, construct curl routes, or reread the full operational skill for these actions.",
    parameters: {
      type: "object", additionalProperties: false, required: ["action"],
      properties: {
        action: { type: "string", enum: actions },
        id: { type: "string", description: "Issue UUID/identifier, or agent ID for wake" },
        query: { type: "object", additionalProperties: false, properties: Object.fromEntries(["projectId", "assigneeAgentId", "status", "q", "limit", "offset"].map(k => [k, { type: "string" }])) },
        body: { type: "object", additionalProperties: true, description: "The existing Paperclip operation's JSON body. For checkout expectedStatuses is required; agentId is supplied by the adapter." },
      },
    },
    async execute(_call, args, signal) {
      let path: string;
      let method = "GET";
      let body = args.body;
      try {
        switch (args.action) {
          case "me": path = "agents/me"; break;
          case "agents": path = `${companyPath}/agents`; break;
          case "projects": path = `${companyPath}/projects`; break;
          case "issues": path = `${companyPath}/issues`; break;
          case "issue": path = `issues/${id(args.id)}`; break;
          case "comments": path = `issues/${id(args.id)}/comments`; break;
          case "create_issue": path = `${companyPath}/issues`; method = "POST"; break;
          case "update_issue": path = `issues/${id(args.id)}`; method = "PATCH"; break;
          case "checkout": path = `issues/${id(args.id)}/checkout`; method = "POST"; body = { ...body, agentId: agent }; break;
          case "release": path = `issues/${id(args.id)}/release`; method = "POST"; body = {}; break;
          case "comment": path = `issues/${id(args.id)}/comments`; method = "POST"; break;
          case "wake": path = `agents/${id(args.id)}/wakeup`; method = "POST"; break;
          default: throw new ArgumentError("Unknown Paperclip action; use one of the listed actions");
        }
        const url = new URL(path, base);
        for (const [key, value] of Object.entries(args.query ?? {})) {
          if (!["projectId", "assigneeAgentId", "status", "q", "limit", "offset"].includes(key) || typeof value !== "string") throw new ArgumentError("Unsupported query filter; use only projectId, assigneeAgentId, status, q, limit or offset as strings");
          url.searchParams.set(key, value);
        }
        const response = await fetch(url, {
          method, redirect: "error",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "X-Paperclip-Run-Id": run },
          ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        });
        const raw = await response.text();
        // Preserve server errors as tool errors, rather than ending Pi's turn.
        // Large results require narrower filters, not an unbounded context dump.
        const safe = raw.split(token).join("[redacted]");
        const text = safe.length <= 24_000 ? safe : "Response exceeds 24000 characters. Narrow query filters/paginate. If this was a mutation, verify its state before issuing another write.";
        return { content: [{ type: "text", text: `HTTP ${response.status}\n${text}` }], isError: !response.ok, details: { status: response.status } };
      } catch (error) {
        if (signal?.aborted) throw error;
        // Network error strings can contain origins or credentials. Do not
        // echo them. Writes may have reached the server: never retry blindly.
        return { content: [{ type: "text", text: error instanceof ArgumentError ? error.message : "Paperclip request failed. Verify state before retrying a write; do not retry automatically." }], isError: true };
      }
    },
  });
  pi.on?.("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + `\n\nPaperclip coordination is available as the native paperclip tool for company ${company}, agent ${agent}. Use its listed actions directly. Assigned connector tools are already registered; call a matching available tool directly before using search_tools for additional discovery. Task: ${env.PAPERCLIP_TASK_ID || "owner conversation; coordinate the owner's requested outcome"}. Wake reason: ${env.PAPERCLIP_WAKE_REASON || "conversation"}. Check out assigned execution work before implementation; delegate through issue assignments, preserve active ownership/review gates, and verify writes. Never wait for an idle PM to infer an unrecorded handoff.\n`,
  }));
}
