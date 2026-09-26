// @ts-nocheck
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

interface Capability {
  version: 1;
  callbackUrl: string;
  bearerToken: string;
  tools: string[];
}

function loadCapability(): Capability | null {
  const capabilityPath = (process.env.PAPERCLIP_VECTOR_TOOL_AUTHORITY_FILE ?? "").trim();
  if (!capabilityPath) return null;
  const raw = readFileSync(capabilityPath, "utf8");
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

const githubToolDefinitions: Record<string, {
  label: string;
  description: string;
  parameters: Record<string, unknown>;
}> = {
  github_read: {
    label: "Read GitHub",
    description:
      "Read GitHub through the Vector callback broker. Use this instead of `gh` because this session has no GitHub credential. " +
      "kind=pr_view returns state, draft, mergeable_state, head/base refs, head sha and labels. " +
      "kind=pr_diff returns the unified diff. kind=pr_checks returns each check plus a verdict of passing/failing/pending/none at the current head. " +
      "kind=run_failures returns the failing job, failing step and the pre-filtered failure lines for a workflow run id. " +
      "kind=pr_list and kind=issue_list return open pull requests / issues. " +
      "kind=repo_list lists App repositories; kind=file_read reads a repository path. " +
      "Native FunkyDev supplies repo=owner/name; assigned sessions remain pinned to their recorded repository.",
    parameters: {
      type: "object",
      properties: {
        kind: { enum: ["pr_view", "pr_diff", "pr_checks", "run_failures", "pr_list", "issue_list", "repo_list", "file_read"] },
        repo: { type: "string", description: "Repository as owner/name. FunkyDev may choose any repository available to its GitHub App." },
        number: { type: "number", description: "Pull request number. Omit to use this session's assigned PR." },
        run_id: { type: "number", description: "Workflow run id. Required for kind=run_failures." },
        path: { type: "string", description: "Repository-relative path. Required for kind=file_read." },
        ref: { type: "string", description: "Branch, tag, or SHA for kind=file_read." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  github_manage: {
    label: "Manage GitHub",
    description:
      "Change GitHub through the Vector callback broker: label_add / label_remove, label_ensure, ready, draft, or merge with the validated head `sha`. " +
      "Merge requires the head sha from a pr_view in this turn and refuses if the head moved, if the PR is draft, or if mergeable_state is not clean. " +
      "The merge method is always a merge commit. Read-only roles are refused. Native FunkyDev supplies repo=owner/name.",
    parameters: {
      type: "object",
      properties: {
        kind: { enum: ["label_add", "label_remove", "ready", "draft", "merge", "label_ensure"] },
        repo: { type: "string", description: "Repository as owner/name. FunkyDev may choose any repository available to its GitHub App." },
        number: { type: "number", description: "Pull request number. Omit to use this session's assigned PR." },
        numbers: { type: "array", items: { type: "number" }, description: "Pull request numbers for a batch label operation." },
        labels: { type: "array", items: { type: "string" }, description: "Labels, for label_add / label_remove." },
        sha: { type: "string", description: "Head sha you validated. Required for kind=merge." },
        color: { type: "string", description: "Six-digit color for label_ensure." },
        description: { type: "string", description: "Label description for label_ensure." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  github_api: {
    label: "GitHub API",
    description:
      "Call GitHub's repo-scoped REST API through FunkyDev's GitHub App authority. This is the general tool for creating/updating/closing/commenting on PRs and issues, reviews, workflow dispatch/rerun/cancel, deployments, releases, branches, and other repository operations. " +
      "Use a path beginning /repos/owner/repo. PR merge is intentionally handled by github_manage(kind=merge) so its exact-head guard remains enforced.",
    parameters: {
      type: "object",
      properties: {
        method: { enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
        path: { type: "string", description: "GitHub REST path beginning /repos/owner/repo; query parameters are allowed." },
        body: { description: "Request body as an object literal, not a JSON string. The callback broker handles serialization." },
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
  },
  github_repo: {
    label: "GitHub repository",
    description:
      "Operate on a private or public GitHub checkout without exposing credentials or a shell. clone creates owner/name inside this session workspace. branch creates a non-default topic branch using ref. status reports the branch and changed files. commit stages all workspace changes and commits them using message. fetch/pull refresh; push publishes the current non-default branch; publish is an alias for push.",
    parameters: {
      type: "object",
      properties: {
        kind: { enum: ["clone", "fetch", "pull", "branch", "status", "commit", "push", "publish"] },
        repo: { type: "string", description: "Repository as owner/name." },
        ref: { type: "string", description: "Branch/tag for clone, or new topic branch for kind=branch." },
        message: { type: "string", description: "Commit message for kind=commit." },
      },
      required: ["kind", "repo"],
      additionalProperties: false,
    },
  },
};

function result(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  };
}

export default function (pi: ExtensionAPI) {
  if (!capability) return;
  for (const tool of capability.tools) {
    const definition = githubToolDefinitions[tool];
    pi.registerTool({
      name: tool,
      label: definition?.label ?? tool.replace(/[_.:-]+/g, " "),
      description: definition?.description ?? `Run the deployment-owned Vector tool ${tool} with this run's bounded authority.`,
      parameters: definition?.parameters ?? {
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
