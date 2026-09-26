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

/**
 * The legacy native FunkyDev definitions, byte-for-byte: label, description,
 * and the JSON Schema TypeBox 1.3.7 serialised from vector-os agents/piext/*.ts.
 * The parity test compares every entry with the checked-in legacy snapshot, so
 * edit the snapshot's source, not this table, when a legacy tool changes.
 */
const legacyToolDefinitions: Record<string, {
  label: string;
  description: string;
  parameters: Record<string, unknown>;
}> = {
  ask_user: {
    "label": "Ask user",
    "description": "Ask the operator a question and BLOCK until they answer. Use ONLY for genuine forks — decisions the operator's answer changes what you do next, and that you cannot resolve from the code, the task, or a sensible default. Do NOT use for status updates, options-with-a-clear-default, or questions you could answer yourself. `choices` is optional suggestions; the operator may pick one or type a different answer. Cancelling returns the same no-answer result as a timeout. This tool blocks for up to 15 minutes; after no answer you may retry or decide without it.",
    "parameters": {
      "type": "object",
      "required": [
        "question"
      ],
      "properties": {
        "question": {
          "type": "string",
          "description": "The question, phrased for the operator. One sentence, ending in a question mark, load-bearing on what you'll do next with the answer."
        },
        "choices": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "label",
              "value"
            ],
            "properties": {
              "label": {
                "type": "string",
                "description": "What the operator sees on the button."
              },
              "value": {
                "type": "string",
                "description": "What comes back as the answer if they pick this."
              }
            }
          },
          "description": "Optional suggestions. The operator may choose one or type a different free-text answer."
        }
      }
    }
  },
  github_api: {
    "label": "GitHub API",
    "description": "Call GitHub's repo-scoped REST API using FD's GitHub App access. This is the general tool for creating/updating/closing/commenting on PRs and issues, reviews, workflow dispatch/rerun/cancel, deployments, releases, branches, and other repository operations. Use a path beginning /repos/owner/repo (for example POST /repos/acme/app/pulls). The response includes GitHub's status and body. PR merge is intentionally handled by github_manage(kind=merge) so its exact-head guard remains enforced.",
    "parameters": {
      "type": "object",
      "required": [
        "method",
        "path"
      ],
      "properties": {
        "method": {
          "anyOf": [
            {
              "type": "string",
              "const": "GET"
            },
            {
              "type": "string",
              "const": "POST"
            },
            {
              "type": "string",
              "const": "PATCH"
            },
            {
              "type": "string",
              "const": "PUT"
            },
            {
              "type": "string",
              "const": "DELETE"
            }
          ]
        },
        "path": {
          "type": "string",
          "description": "GitHub REST path beginning /repos/owner/repo; query parameters are allowed."
        },
        "body": {
          "description": "Request body as an object literal (NOT a JSON string). Example: {\"base\":\"main\",\"head\":\"artifacts-pr1\",\"title\":\"…\"}. Do NOT call JSON.stringify — the wrapper handles serialization. If you pass a string GitHub returns 422 because bodies must be JSON objects."
        }
      }
    }
  },
  github_manage: {
    "label": "Manage GitHub",
    "description": "Change GitHub through the daemon: label_add / label_remove, label_ensure, ready, draft, or merge with the validated head `sha`. Merge requires the head sha from a pr_view in this turn and refuses if the head moved, if the PR is draft, or if mergeable_state is not \"clean\". The merge method is always a merge commit. Read-only roles are refused. Native FD supplies repo=owner/name.",
    "parameters": {
      "type": "object",
      "required": [
        "kind"
      ],
      "properties": {
        "kind": {
          "anyOf": [
            {
              "type": "string",
              "const": "label_add"
            },
            {
              "type": "string",
              "const": "label_remove"
            },
            {
              "type": "string",
              "const": "ready"
            },
            {
              "type": "string",
              "const": "draft"
            },
            {
              "type": "string",
              "const": "merge"
            },
            {
              "type": "string",
              "const": "label_ensure"
            }
          ]
        },
        "repo": {
          "type": "string",
          "description": "Repository as owner/name. FD may choose any repository available to its GitHub App."
        },
        "number": {
          "type": "number",
          "description": "Pull request number. Omit to use this session's assigned PR."
        },
        "numbers": {
          "type": "array",
          "items": {
            "type": "number"
          },
          "description": "Pull request numbers for a batch label operation."
        },
        "labels": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Labels, for label_add / label_remove."
        },
        "sha": {
          "type": "string",
          "description": "Head sha you validated. Required for kind=merge."
        },
        "color": {
          "type": "string",
          "description": "Six-digit color for label_ensure."
        },
        "description": {
          "type": "string",
          "description": "Label description for label_ensure."
        }
      }
    }
  },
  github_read: {
    "label": "Read GitHub",
    "description": "Read GitHub through the vector-agents daemon. Use this instead of `gh` — this session has no GitHub credential and `gh` is unauthenticated. kind=pr_view returns state, draft, mergeable_state, head/base refs, head sha and labels. kind=pr_diff returns the unified diff. kind=pr_checks returns each check plus a verdict of passing/failing/pending/none at the current head. kind=run_failures returns the failing job, failing step and the pre-filtered failure lines for a workflow run id. kind=pr_list and kind=issue_list return open pull requests / issues. kind=repo_list lists App repositories; kind=file_read reads a repository path. Native FD supplies repo=owner/name; assigned sessions remain pinned to their recorded repository.",
    "parameters": {
      "type": "object",
      "required": [
        "kind"
      ],
      "properties": {
        "kind": {
          "anyOf": [
            {
              "type": "string",
              "const": "pr_view"
            },
            {
              "type": "string",
              "const": "pr_diff"
            },
            {
              "type": "string",
              "const": "pr_checks"
            },
            {
              "type": "string",
              "const": "run_failures"
            },
            {
              "type": "string",
              "const": "pr_list"
            },
            {
              "type": "string",
              "const": "issue_list"
            },
            {
              "type": "string",
              "const": "repo_list"
            },
            {
              "type": "string",
              "const": "file_read"
            }
          ]
        },
        "repo": {
          "type": "string",
          "description": "Repository as owner/name. FD may choose any repository available to its GitHub App."
        },
        "number": {
          "type": "number",
          "description": "Pull request number. Omit to use this session's assigned PR."
        },
        "run_id": {
          "type": "number",
          "description": "Workflow run id. Required for kind=run_failures."
        },
        "path": {
          "type": "string",
          "description": "Repository-relative path. Required for kind=file_read."
        },
        "ref": {
          "type": "string",
          "description": "Branch, tag, or SHA for kind=file_read."
        }
      }
    }
  },
  github_repo: {
    "label": "GitHub repository",
    "description": "Operate on a private or public GitHub checkout without exposing credentials or a shell. clone creates owner/name inside this session workspace. branch creates a non-default topic branch using ref. status reports the branch and changed files. commit stages all workspace changes and commits them using message. fetch/pull refresh; push publishes the current non-default branch; publish is an alias for push.",
    "parameters": {
      "type": "object",
      "required": [
        "kind",
        "repo"
      ],
      "properties": {
        "kind": {
          "anyOf": [
            {
              "type": "string",
              "const": "clone"
            },
            {
              "type": "string",
              "const": "fetch"
            },
            {
              "type": "string",
              "const": "pull"
            },
            {
              "type": "string",
              "const": "branch"
            },
            {
              "type": "string",
              "const": "status"
            },
            {
              "type": "string",
              "const": "commit"
            },
            {
              "type": "string",
              "const": "push"
            },
            {
              "type": "string",
              "const": "publish"
            }
          ]
        },
        "repo": {
          "type": "string",
          "description": "Repository as owner/name."
        },
        "ref": {
          "type": "string",
          "description": "Branch/tag for clone, or new topic branch for kind=branch."
        },
        "message": {
          "type": "string",
          "description": "Commit message for kind=commit."
        }
      }
    }
  },
  memory_forget: {
    "label": "Forget memory",
    "description": "Retire a saved memory by slug when the user asks to forget it or corrects it. Retired notes are no longer recalled.",
    "parameters": {
      "type": "object",
      "required": [
        "slug"
      ],
      "properties": {
        "slug": {
          "type": "string",
          "description": "The memory's stable slug."
        }
      }
    }
  },
  memory_save: {
    "label": "Save memory",
    "description": "Save a durable user fact or preference for future conversations. Save stable preferences, background, constraints, and corrections. Do not save transient requests or private details the user would not expect to see later. Reuse a slug to update a fact. The user can inspect, edit, or forget each saved note.",
    "parameters": {
      "type": "object",
      "required": [
        "slug",
        "summary"
      ],
      "properties": {
        "slug": {
          "type": "string",
          "description": "Stable kebab-case handle; reuse it to update the same fact."
        },
        "summary": {
          "type": "string",
          "description": "Standalone one-line memory, at most 200 characters."
        },
        "body": {
          "type": "string",
          "description": "Optional short detail."
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string",
            "description": "Lowercase matching keyword."
          }
        }
      }
    }
  },
  memory_search: {
    "label": "Search memories",
    "description": "Search the user's saved memories. Their core notes are already in your context. Use this for related standard or deep notes, or when the user asks what you remember.",
    "parameters": {
      "type": "object",
      "required": [
        "query"
      ],
      "properties": {
        "query": {
          "type": "string",
          "description": "Words to search saved summaries, details, and tags."
        },
        "limit": {
          "type": "integer",
          "description": "Maximum results from 1 to 20. Default 8."
        }
      }
    }
  },
  publish_branch: {
    "label": "Publish branch",
    "description": "Publish the current committed branch through the vector-agents daemon. Use this instead of git push or gh. The daemon derives the assigned repository and delivery policy, normally refuses default branches, permits a guarded non-force default-branch push only for an allowlisted direct-main assignment, and never returns its GitHub credential.",
    "parameters": {
      "type": "object",
      "properties": {}
    }
  },
  todo_add: {
    "label": "Add todo",
    "description": "Add one work item to this conversation's model-owned task tracker. For a request with more than two distinct work items, create the plan before starting and keep every status current until completion. `title` is the concise step the operator sees above chat; `body` is optional detail.",
    "parameters": {
      "type": "object",
      "required": [
        "title"
      ],
      "properties": {
        "title": {
          "type": "string",
          "description": "One-line summary (required, non-empty)."
        },
        "body": {
          "type": "string",
          "description": "Optional details — context, references, why it matters. Markdown is fine."
        }
      }
    }
  },
  todo_list: {
    "label": "List todos",
    "description": "List this conversation's task tracker. By default returns only open + in_progress; pass status='all' while reconciling the full plan.",
    "parameters": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "description": "Filter: 'open' | 'in_progress' | 'done' | 'archived' | 'all'. Default 'open,in_progress'."
        }
      }
    }
  },
  todo_mark_done: {
    "label": "Mark todo done",
    "description": "Shortcut for updating a todo to status='done'. Use when you've completed something the operator queued for you, or something you queued for yourself.",
    "parameters": {
      "type": "object",
      "required": [
        "id"
      ],
      "properties": {
        "id": {
          "type": "string",
          "description": "Todo id (UUID)."
        }
      }
    }
  },
  todo_update: {
    "label": "Update todo",
    "description": "Update a tracker item's title, body, or status. Set the current item in_progress, mark it done only after verification, and archive obsolete items. Any absent field is left alone.",
    "parameters": {
      "type": "object",
      "required": [
        "id"
      ],
      "properties": {
        "id": {
          "type": "string",
          "description": "Todo id (UUID)."
        },
        "title": {
          "type": "string"
        },
        "body": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "description": "open | in_progress | done | archived"
        }
      }
    }
  },
};

// todo.ts's before_agent_start addition, verbatim.
const TASK_TRACKER_GUIDELINE =
  "\n\n## Task tracker\n\nThe tracker is yours, not the user's. If the request requires more than two distinct work items, you MUST create a concise plan with todo_add before starting. Mark exactly what you are working on in_progress, update the tracker as the plan changes, mark items done only when they are actually verified, and keep going until every item is done or you clearly report the blocker. Archive obsolete items. Do not ask the user to maintain the tracker and do not use it as a backlog for unrelated future ideas.";

// memory.ts opened every session from the user's notes: core notes first with
// their bodies, then the most recent standard notes as summaries.
const RECENT_NOTES_AT_START = 100;

type CallbackOutcome =
  | { kind: "result"; value: unknown }
  | { kind: "refused"; message: string };

async function callback(tool: string, args: unknown, signal?: AbortSignal): Promise<CallbackOutcome> {
  const response = await fetch(capability!.callbackUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${capability!.bearerToken}`,
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
  // A refusal is the tool's answer, not a transport failure: the legacy
  // extensions returned it as a result so the model could correct the call.
  if (
    response.status === 422 &&
    payload && typeof payload === "object" &&
    (payload as { error?: unknown }).error === "tool_refused" &&
    typeof (payload as { message?: unknown }).message === "string"
  ) {
    return { kind: "refused", message: (payload as { message: string }).message };
  }
  if (!response.ok) {
    throw new Error(`Vector tool ${tool} failed with status ${response.status}`);
  }
  if (!payload || typeof payload !== "object" || !("result" in payload)) {
    throw new Error(`Vector tool ${tool} returned an invalid result envelope`);
  }
  return { kind: "result", value: (payload as { result: unknown }).result };
}

function result(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  };
}

function refusal(tool: string, message: string) {
  return {
    content: [{ type: "text" as const, text: `${tool} refused: ${message}` }],
    details: null,
  };
}

type Note = { slug?: string; summary?: string; body?: string; tier?: string };

async function recall(scope: "core" | "recent", limit: number): Promise<Note[]> {
  try {
    const outcome = await callback("memory_search", { query: "", recall: scope, limit });
    if (outcome.kind !== "result") return [];
    const memories = (outcome.value as { memories?: Note[] } | null)?.memories;
    return Array.isArray(memories) ? memories : [];
  } catch {
    return [];
  }
}

async function savedNotesSection(): Promise<string> {
  const core = await recall("core", 25);
  const seen = new Set(core.map((note) => note.slug));
  const recent = (await recall("recent", RECENT_NOTES_AT_START))
    .filter((note) => note.tier !== "core" && !seen.has(note.slug))
    .slice(0, Math.max(0, RECENT_NOTES_AT_START - core.length));
  if (core.length === 0 && recent.length === 0) return "";
  const lines = [
    ...core.map((note) => note.body ? `- ${note.summary}\n  ${note.body}` : `- ${note.summary}`),
    ...recent.map((note) => `- ${note.summary}`),
  ];
  return "\n\n## Saved notes about this user\n\nThese may be stale; the user's current message wins. Use them quietly rather than reciting them. memory_search finds older notes.\n\n" + lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  if (!capability) return;
  for (const tool of capability.tools) {
    const definition = legacyToolDefinitions[tool];
    pi.registerTool({
      name: tool,
      label: definition?.label ?? tool.replace(/[_.:-]+/g, " "),
      description: definition?.description ?? `Run the deployment-owned Vector tool ${tool} with this run's bounded authority.`,
      parameters: definition?.parameters ?? {
        type: "object",
        additionalProperties: true,
      },
      async execute(_id, args, signal) {
        const outcome = await callback(tool, args ?? {}, signal);
        return outcome.kind === "refused" ? refusal(tool, outcome.message) : result(outcome.value);
      },
    });
  }
  if (typeof pi.on !== "function") return;
  const tools = new Set(capability.tools);
  const tracker = tools.has("todo_add");
  const notes = tools.has("memory_search");
  if (!tracker && !notes) return;
  pi.on("before_agent_start", async (event) => {
    let systemPrompt = event.systemPrompt;
    if (tracker) systemPrompt += TASK_TRACKER_GUIDELINE;
    if (notes) systemPrompt += await savedNotesSection();
    return { systemPrompt };
  });
}
