import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "./execute.js";
import { resolveVectorPlainConversationMessage } from "./vector-plain-conversation.js";

const GOLDEN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "vector-plain-conversation-golden.json",
);

const INSTRUCTIONS = "## Who you are\n\nYou are Funky Dev.\n";
const PERSONA = {
  schemaVersion: 1,
  personaId: "00000000-0000-0000-0000-000000000023",
  personaVersion: "abcdef012345",
  noBuiltinTools: true,
  systemPrompt: "Friendly standard-chat persona.",
  model: "router/Qwen3.8-Flash",
};
const ROLE = {
  schemaVersion: 1,
  role: "funky-analyst",
  model: "",
  tools: [] as string[],
  noBuiltinTools: true,
  systemPrompt: "Use the current Vector charter and cite every claim.",
  metadata: { run_kind: "chat" },
};
const PERSONA_APPEND =
  "Vector OS admitted this selected standard-chat persona through the signed, installation-scoped ingress. It applies to this conversation and remains subordinate to Paperclip's deployment and agent safety policy.";
const ROLE_APPEND =
  "Vector OS admitted the following product role instructions through the signed, installation-scoped ingress. They apply only to this turn and remain subordinate to Paperclip's deployment and agent safety policy.";
const IMAGE_NOTE =
  "The image attachments for this turn are supplied natively with this prompt. Do not attempt to download them or request Paperclip API credentials.";

function userComment(id: string, body: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    issueId: "issue-1",
    body,
    bodyTruncated: false,
    createdAt: "2026-09-28T12:00:00.000Z",
    author: { type: "user", id: "user-1" },
    authorType: "user",
    ...extra,
  };
}

function conversationWake(comments: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return {
    reason: "issue_commented",
    issue: { id: "issue-1", identifier: "VECA-1", title: "Agent chat", status: "in_progress", priority: "medium" },
    commentIds: comments.map((comment) => comment.id),
    latestCommentId: comments.at(-1)?.id ?? null,
    comments,
    commentWindow: { requestedCount: comments.length, includedCount: comments.length, missingCount: 0 },
    truncated: false,
    fallbackFetchNeeded: false,
    ...extra,
  };
}

async function writeRpcPiCommand(commandPath: string, argsDumpPath: string, promptDumpPath: string) {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  console.log("router    Qwen3.8-Flash");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(argsDumpPath)}, JSON.stringify(process.argv.slice(2)));
let buffer = "";
let handled = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (handled || newline < 0) return;
  handled = true;
  const command = JSON.parse(buffer.slice(0, newline));
  fs.writeFileSync(${JSON.stringify(promptDumpPath)}, JSON.stringify(command));
  console.log(JSON.stringify({ type: "response", command: "prompt", success: true, id: command.id }));
  console.log(JSON.stringify({ type: "agent_start" }));
  console.log(JSON.stringify({ type: "turn_start" }));
  const message = { role: "assistant", content: [{ type: "text", text: "RPC reply" }], usage: { input: 1, output: 1 } };
  console.log(JSON.stringify({ type: "message_end", message }));
  console.log(JSON.stringify({ type: "turn_end", message, toolResults: [] }));
  console.log(JSON.stringify({ type: "agent_settled" }));
});
process.stdin.on("end", () => process.exit(0));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type Harness = {
  root: string;
  workspace: string;
  commandPath: string;
  instructionsPath: string;
  argsDumpPath: string;
  promptDumpPath: string;
};

let harness: Harness;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["HOME", "PAPERCLIP_VECTOR_PROFILE", "PAPERCLIP_VECTOR_PI_COMMAND", "PAPERCLIP_PI_EXECUTION_MODE"];

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-plain-convo-")));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  harness = {
    root,
    workspace,
    commandPath: path.join(root, "pi"),
    instructionsPath: path.join(root, "release", "AGENTS.md"),
    argsDumpPath: path.join(root, "args.json"),
    promptDumpPath: path.join(root, "prompt.json"),
  };
  await fs.mkdir(path.dirname(harness.instructionsPath), { recursive: true });
  await fs.writeFile(harness.instructionsPath, INSTRUCTIONS, "utf8");
  await writeRpcPiCommand(harness.commandPath, harness.argsDumpPath, harness.promptDumpPath);
  process.env.HOME = root;
  process.env.PAPERCLIP_VECTOR_PI_COMMAND = harness.commandPath;
  delete process.env.PAPERCLIP_PI_EXECUTION_MODE;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await fs.rm(harness.root, { recursive: true, force: true });
});

async function runTurn(input: {
  profile: string | null;
  context: Record<string, unknown>;
  runtime?: { sessionId: string | null; sessionParams: Record<string, unknown> | null };
  config?: Record<string, unknown>;
}) {
  if (input.profile === null) delete process.env.PAPERCLIP_VECTOR_PROFILE;
  else process.env.PAPERCLIP_VECTOR_PROFILE = input.profile;
  const metadata: Array<Record<string, unknown>> = [];
  const result = await execute({
    runId: "run-plain-convo",
    agent: {
      id: "agent-plain-convo",
      companyId: "company-plain-convo",
      name: "Funky Dev",
      adapterType: "pi_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: input.runtime?.sessionId ?? null,
      sessionParams: input.runtime?.sessionParams ?? null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: harness.commandPath,
      cwd: harness.workspace,
      model: "google/gemini-3-flash-preview",
      executionMode: "rpc",
      // Restricted Vector profiles forbid an instructions file; the admitted
      // persona/role context carries their instructions.
      ...(input.profile === null || input.profile === "engineering"
        ? { instructionsFilePath: harness.instructionsPath }
        : {}),
      ...input.config,
    },
    context: input.context,
    authToken: "run-jwt-token",
    onLog: async () => {},
    onMeta: async (meta) => { metadata.push(meta as unknown as Record<string, unknown>); },
  });
  expect(result.exitCode).toBe(0);
  const args = JSON.parse(await fs.readFile(harness.argsDumpPath, "utf8")) as string[];
  const rpc = JSON.parse(await fs.readFile(harness.promptDumpPath, "utf8")) as Record<string, unknown>;
  const systemPrompt = args[args.indexOf("--append-system-prompt") + 1]!;
  const meta = metadata[0]!;
  const normalize = (value: string) => value.split(harness.root).join("<ROOT>");
  return {
    prompt: meta.prompt as string,
    rpcMessage: rpc.message as string,
    rpcImages: rpc.images,
    systemPrompt,
    session: args[args.indexOf("--session") + 1]!,
    commandNotes: meta.commandNotes as string[],
    promptMetrics: meta.promptMetrics as Record<string, number>,
    normalized: {
      prompt: normalize(meta.prompt as string),
      systemPrompt: normalize(systemPrompt),
    },
  };
}

describe("Vector plain conversation turns", () => {
  it("sends one standard-chat comment verbatim with only the persona as system prompt", async () => {
    const turn = await runTurn({
      profile: "standard",
      context: {
        conversationMode: true,
        issueId: "issue-1",
        vectorPersonaTurn: PERSONA,
        paperclipTaskMarkdown: "## Task\nConversation policy that must not reach Pi.",
        paperclipSessionHandoffMarkdown: "Handoff that must not reach Pi.",
        paperclipWake: conversationWake([userComment("comment-1", "What's our cash position today?")]),
      },
    });
    expect(turn.prompt).toBe("What's our cash position today?");
    expect(turn.rpcMessage).toBe("What's our cash position today?");
    expect(turn.systemPrompt).toBe(`${PERSONA_APPEND}\n\n${PERSONA.systemPrompt}`);
    expect(turn.systemPrompt).not.toContain("The above agent instructions were loaded from");
    expect(turn.systemPrompt).not.toContain("Continue your Paperclip conversation");
    expect(turn.prompt).not.toContain("Paperclip Wake Payload");
    expect(turn.promptMetrics).toMatchObject({
      wakePromptChars: 0,
      taskContextChars: 0,
      sessionHandoffChars: 0,
      heartbeatPromptChars: 0,
      bootstrapPromptChars: 0,
    });
    expect(turn.commandNotes.join("\n")).toContain("sent the user's message verbatim");
  });

  it("joins several pending comments in order with blank lines and moves connector skills to the system prompt", async () => {
    const turn = await runTurn({
      profile: "engineering",
      context: {
        conversationMode: true,
        issueId: "issue-1",
        paperclipWake: {
          ...conversationWake([
            userComment("comment-1", "Check the t480 runner."),
            userComment("comment-2", "  And then open a PR.\n"),
          ]),
          connectorSkillInstructions: "### github-code\n\nUse the GitHub connection tools.",
        },
      },
      config: { bootstrapPromptTemplate: "Bootstrap that must not reach Pi." },
    });
    expect(turn.prompt).toBe("Check the t480 runner.\n\nAnd then open a PR.");
    expect(turn.rpcMessage).toBe(turn.prompt);
    expect(turn.systemPrompt).toBe(
      `${INSTRUCTIONS.trim()}\n\n## Assigned connector skills\n\n### github-code\n\nUse the GitHub connection tools.`,
    );
  });

  it("strips the trusted role-turn envelope and appends the native image note", async () => {
    const data = "/9j/AA==";
    const turn = await runTurn({
      profile: "production",
      context: {
        conversationMode: true,
        issueId: "issue-1",
        vectorRoleTurn: ROLE,
        vectorIngressImages: [{ type: "image", data, mimeType: "image/jpeg" }],
        paperclipWake: conversationWake([
          userComment(
            "comment-1",
            `[VECTOR_ROLE_TURN_V1]\n${JSON.stringify({ ...ROLE, metadata: { run_kind: "chat" } })}\n\nWhat is in this screenshot?`,
          ),
        ]),
      },
    });
    expect(turn.prompt).toBe(`What is in this screenshot?\n\n${IMAGE_NOTE}`);
    expect(turn.rpcMessage).toBe(turn.prompt);
    expect(turn.rpcImages).toEqual([{ type: "image", data, mimeType: "image/jpeg" }]);
    expect(turn.systemPrompt).toBe(`${ROLE_APPEND}\n\n${ROLE.systemPrompt}`);
  });

  it("sends the same plain message when Pi resumes the conversation session", async () => {
    const sessionPath = path.join(harness.root, "existing-session.jsonl");
    await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", cwd: harness.workspace })}\n`, "utf8");
    const turn = await runTurn({
      profile: "engineering",
      runtime: { sessionId: sessionPath, sessionParams: { sessionId: sessionPath, cwd: harness.workspace } },
      context: {
        conversationMode: true,
        issueId: "issue-1",
        paperclipWake: conversationWake([userComment("comment-2", "Follow-up question.")]),
      },
    });
    expect(turn.session).toBe(sessionPath);
    expect(turn.prompt).toBe("Follow-up question.");
    expect(turn.systemPrompt).toBe(INSTRUCTIONS.trim());
  });
});

describe("Vector restricted profiles with a release-owned instructions file", () => {
  const RELEASE_INSTRUCTIONS = "# Standard Chat\n\nYou are the Vector standard chat agent.\n";
  const STAGING_INSTRUCTIONS = "# Funky Scout\n\nRequire a Vector claim envelope.\n";

  // The provisioner writes releases/current/...; the supervisor pins
  // PAPERCLIP_VECTOR_PI_COMMAND=<release>/runtime/bin/pi.
  async function installRelease() {
    const release = path.join(harness.root, "releases", "r1");
    const current = path.join(harness.root, "releases", "current");
    const piCommand = path.join(current, "runtime", "bin", "pi");
    await fs.mkdir(path.join(release, "runtime", "bin"), { recursive: true });
    await writeRpcPiCommand(path.join(release, "runtime", "bin", "pi"), harness.argsDumpPath, harness.promptDumpPath);
    const asset = async (profile: string, agent: string, body: string) => {
      const file = path.join(release, "paperclip", "profile-assets", profile, agent, "AGENTS.md");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body, "utf8");
      return {
        provisioned: path.join(current, "paperclip", "profile-assets", profile, agent, "AGENTS.md"),
        real: file,
      };
    };
    await fs.symlink(release, current);
    process.env.PAPERCLIP_VECTOR_PI_COMMAND = piCommand;
    return {
      piCommand,
      standardChat: await asset("standard", "standard-chat", RELEASE_INSTRUCTIONS),
      stagingScout: await asset("staging", "funky-scout", STAGING_INSTRUCTIONS),
    };
  }

  it("launches a standard conversation turn with the release instructions as system prompt", async () => {
    const release = await installRelease();
    const turn = await runTurn({
      profile: "standard",
      config: { command: release.piCommand, instructionsFilePath: release.standardChat.provisioned },
      context: {
        conversationMode: true,
        issueId: "issue-1",
        vectorPersonaTurn: PERSONA,
        paperclipTaskMarkdown: "## Task\nConversation policy that must not reach Pi.",
        paperclipWake: conversationWake([userComment("comment-1", "What's our cash position today?")]),
      },
    });
    expect(turn.prompt).toBe("What's our cash position today?");
    expect(turn.rpcMessage).toBe("What's our cash position today?");
    expect(turn.systemPrompt).toBe(
      `${RELEASE_INSTRUCTIONS.trim()}\n\n${PERSONA_APPEND}\n\n${PERSONA.systemPrompt}`,
    );
    expect(turn.systemPrompt).not.toContain("The above agent instructions were loaded from");
    expect(turn.commandNotes).toContain(`Loaded agent instructions from ${release.standardChat.real}`);
  });

  it("launches a staging workload run with the release instructions and the admitted charter", async () => {
    const release = await installRelease();
    const turn = await runTurn({
      profile: "staging",
      config: { command: release.piCommand, instructionsFilePath: release.stagingScout.provisioned },
      context: {
        issueId: "issue-3",
        vectorWorkloadLaunch: {
          schemaVersion: 1,
          workloadKey: "current_scout",
          taskId: "task-1",
          systemPrompt: "Dynamic Vector charter.",
        },
        paperclipWake: conversationWake([userComment("comment-1", "Analyze the evidence envelope.")], {
          reason: "issue_assigned",
        }),
      },
    });
    expect(turn.systemPrompt.startsWith(STAGING_INSTRUCTIONS)).toBe(true);
    expect(turn.systemPrompt).toContain(`The above agent instructions were loaded from ${release.stagingScout.real}.`);
    expect(turn.systemPrompt).toContain("Dynamic Vector charter.");
    expect(turn.prompt).toContain("Analyze the evidence envelope.");
  });

  it("still refuses to launch with an instructions file outside the release assets", async () => {
    const release = await installRelease();
    process.env.PAPERCLIP_VECTOR_PROFILE = "standard";
    await expect(execute({
      runId: "run-restricted-outside",
      agent: { id: "agent-1", companyId: "company-1", name: "Standard Chat", adapterType: "pi_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: release.piCommand,
        cwd: harness.workspace,
        model: "google/gemini-3-flash-preview",
        executionMode: "rpc",
        instructionsFilePath: harness.instructionsPath,
      },
      context: { conversationMode: true, issueId: "issue-1", vectorPersonaTurn: PERSONA },
      authToken: "run-jwt-token",
      onLog: async () => {},
    })).rejects.toThrow('forbids Pi runtime resource field "instructionsFilePath"');
  });
});

// These cases retain upstream prompt composition outside Vector plain chat.
// Refreshed for upstream 67ebed8a5's prompt sections and connection guidance;
// plain Vector chat and release-owned instructions are asserted separately above.
const GOLDEN_CASES: Record<string, () => Parameters<typeof runTurn>[0]> = {
  nonVectorConversation: () => ({
    profile: null,
    context: {
      conversationMode: true,
      issueId: "issue-1",
      paperclipTaskMarkdown: "## Task\nConversation policy.",
      paperclipWake: conversationWake([userComment("comment-1", "Hello from a non-Vector board.")]),
    },
  }),
  vectorBoardTask: () => ({
    profile: "engineering",
    context: {
      issueId: "issue-2",
      paperclipWake: conversationWake([userComment("comment-1", "Please also update the docs.")], {
        issue: { id: "issue-2", identifier: "VECA-2", title: "Board task", status: "todo", priority: "high" },
      }),
    },
  }),
  vectorWorkloadLaunch: () => ({
    profile: "staging",
    context: {
      conversationMode: true,
      issueId: "issue-3",
      vectorWorkloadLaunch: {
        schemaVersion: 1,
        workloadKey: "current_scout",
        taskId: "task-1",
        systemPrompt: "Dynamic Vector charter.",
      },
      paperclipWake: conversationWake([userComment("comment-1", "Analyze the evidence envelope.")]),
    },
  }),
  vectorConversationFallbackFetch: () => ({
    profile: "standard",
    context: {
      conversationMode: true,
      issueId: "issue-1",
      vectorPersonaTurn: PERSONA,
      paperclipWake: conversationWake([userComment("comment-1", "Partial batch.")], {
        commentIds: ["comment-0", "comment-1"],
        commentWindow: { requestedCount: 2, includedCount: 1, missingCount: 1 },
        truncated: true,
        fallbackFetchNeeded: true,
      }),
    },
  }),
  vectorRestrictedConversationWithoutPersona: () => ({
    profile: "staging",
    context: {
      conversationMode: true,
      issueId: "issue-1",
      paperclipWake: conversationWake([userComment("comment-1", "Board chat with no admitted role.")]),
    },
  }),
  vectorConversationRecovery: () => ({
    profile: "engineering",
    context: {
      conversationMode: true,
      issueId: "issue-1",
      paperclipWake: conversationWake([userComment("comment-1", "Are you there?")], {
        recovery: { cause: "process_lost", failureSummary: "runner restarted" },
      }),
    },
  }),
};

describe("unchanged prompts outside Vector plain conversation turns", () => {
  it("renders non-Vector, non-conversation, workload and fail-safe runs byte-identically", async () => {
    const rendered: Record<string, { prompt: string; systemPrompt: string }> = {};
    for (const [name, build] of Object.entries(GOLDEN_CASES)) {
      await fs.rm(harness.argsDumpPath, { force: true });
      await fs.rm(harness.promptDumpPath, { force: true });
      rendered[name] = (await runTurn(build())).normalized;
    }
    if (process.env.VECTOR_PLAIN_CONVO_WRITE_GOLDEN === "1") {
      await fs.writeFile(GOLDEN_PATH, `${JSON.stringify(rendered, null, 2)}\n`, "utf8");
    }
    const golden = JSON.parse(await fs.readFile(GOLDEN_PATH, "utf8")) as typeof rendered;
    expect(rendered).toEqual(golden);
    // Sanity: the guard actually covers the scaffolding it protects.
    expect(golden.nonVectorConversation!.prompt).toContain("Hello from a non-Vector board.");
    expect(golden.vectorConversationFallbackFetch!.prompt).toContain("fallback fetch needed: yes");
    expect(golden.vectorBoardTask!.systemPrompt).toContain("The above agent instructions were loaded from");
  });
});

describe("resolveVectorPlainConversationMessage fail-safe", () => {
  const base = (wake: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    resolveVectorPlainConversationMessage({
      vectorProfile: "standard",
      context: { conversationMode: true, paperclipWake: wake, ...extra },
    });

  it("keeps the Paperclip prompt for every case it cannot reproduce exactly", () => {
    const one = [userComment("c1", "hi")];
    expect(resolveVectorPlainConversationMessage({ vectorProfile: "", context: { conversationMode: true, paperclipWake: conversationWake(one) } }))
      .toEqual({ plain: false, reason: "not_vector_installation" });
    expect(base(conversationWake(one), { conversationMode: false })).toEqual({ plain: false, reason: "not_conversation" });
    expect(base(conversationWake([]))).toMatchObject({ plain: false });
    expect(base(conversationWake(one, { fallbackFetchNeeded: true }))).toEqual({ plain: false, reason: "incomplete_comment_batch" });
    expect(base(conversationWake([userComment("c1", "hi", { bodyTruncated: true })])))
      .toEqual({ plain: false, reason: "incomplete_comment_batch" });
    expect(base(conversationWake([userComment("c1", "hi", { author: { type: "agent", id: "a" }, authorType: "agent" })])))
      .toEqual({ plain: false, reason: "non_user_comment" });
    expect(base(conversationWake(one, { questionResponse: { interactionId: "i1", summaryMarkdown: "Yes" } })))
      .toEqual({ plain: false, reason: "interaction_or_continuation" });
    expect(base(conversationWake(one, { recovery: { cause: "process_lost" } }))).toEqual({ plain: false, reason: "recovery" });
    expect(base(conversationWake([userComment("c1", "[VECTOR_ROLE_TURN_V1]\nnot-json\n\nhi")]), { vectorRoleTurn: ROLE }))
      .toEqual({ plain: false, reason: "unrecognized_turn_envelope" });
    expect(base(conversationWake(one))).toEqual({ plain: true, message: "hi" });
  });
});
