import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "./execute.js";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  WATCHDOG_DEFAULT_MANDATE,
} from "@paperclipai/adapter-utils/server-utils";
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
// Paperclip-authored prompt text that must never reach Pi inside a Vector
// installation, whatever the profile or mode.
const PAPERCLIP_PROMPT_TEXT = [
  ...DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE.split("\n"),
  ...DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE.split("\n"),
  ...WATCHDOG_DEFAULT_MANDATE.split("\n"),
]
  .map((line) => line.replace(/\{\{[^}]+\}\}/g, "").trim())
  .filter((line) => line.length > 12)
  .concat([
    "Paperclip Wake Payload",
    "Paperclip Resume Delta",
    "Execution contract",
    "Recovery contract",
    "The above agent instructions were loaded from",
    "Resolve any relative file references",
    "Vector OS admitted",
    "subordinate to Paperclip",
    "Assigned connector skills",
    "Use the AgentMail tools.",
    "Treat this wake payload",
    "heartbeat",
    "Do not execute the task itself",
    "Continue from the current task state",
    "Conversation policy that must not reach Pi.",
    "Bootstrap that must not reach Pi.",
    "Template that must not reach Pi.",
    "The image attachments for this turn are supplied natively",
  ]);

function expectNoPaperclipPromptText(text: string) {
  for (const marker of PAPERCLIP_PROMPT_TEXT) expect(text, marker).not.toContain(marker);
}

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
const skillIndex = process.argv.indexOf("--skill");
const skillDir = skillIndex >= 0 ? process.argv[skillIndex + 1] : null;
fs.writeFileSync(${JSON.stringify(argsDumpPath)} + ".skills", JSON.stringify(
  skillDir && fs.existsSync(skillDir) ? fs.readdirSync(skillDir).sort() : [],
));
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
    skills: JSON.parse(await fs.readFile(`${harness.argsDumpPath}.skills`, "utf8")) as string[],
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
    expect(turn.systemPrompt).toBe(PERSONA.systemPrompt);
    expectNoPaperclipPromptText(turn.systemPrompt);
    expectNoPaperclipPromptText(turn.prompt);
    expect(turn.promptMetrics).toMatchObject({
      wakePromptChars: 0,
      taskContextChars: 0,
      sessionHandoffChars: 0,
      heartbeatPromptChars: 0,
      bootstrapPromptChars: 0,
    });
    expect(turn.commandNotes.join("\n")).toContain("sent the user's message verbatim");
  });

  it("joins several pending comments in order and sends no connector skill or bootstrap text", async () => {
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
          connectorSkillInstructions: "### agentmail\n\nUse the AgentMail tools.",
        },
      },
      config: { bootstrapPromptTemplate: "Bootstrap that must not reach Pi." },
    });
    expect(turn.prompt).toBe("Check the t480 runner.\n\nAnd then open a PR.");
    expect(turn.rpcMessage).toBe(turn.prompt);
    expect(turn.systemPrompt).toBe(`${INSTRUCTIONS.trim()}\n\nInstruction base: ${path.dirname(harness.instructionsPath)}/`);
    expectNoPaperclipPromptText(turn.systemPrompt);
  });

  it("strips the trusted role-turn envelope and sends images natively with no Paperclip note", async () => {
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
    expect(turn.prompt).toBe("What is in this screenshot?");
    expect(turn.rpcMessage).toBe(turn.prompt);
    expect(turn.rpcImages).toEqual([{ type: "image", data, mimeType: "image/jpeg" }]);
    expect(turn.systemPrompt).toBe(ROLE.systemPrompt);
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
    expect(turn.systemPrompt).toBe(`${INSTRUCTIONS.trim()}\n\nInstruction base: ${path.dirname(harness.instructionsPath)}/`);
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
    expect(turn.systemPrompt).toBe(`${RELEASE_INSTRUCTIONS.trim()}\n\n${PERSONA.systemPrompt}`);
    expectNoPaperclipPromptText(turn.systemPrompt);
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
    expect(turn.systemPrompt).toBe(`${STAGING_INSTRUCTIONS.trim()}\n\nDynamic Vector charter.`);
    expect(turn.prompt).toContain("Analyze the evidence envelope.");
    expectNoPaperclipPromptText(turn.systemPrompt);
    expectNoPaperclipPromptText(turn.prompt);
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

describe("Vector-owned prompting in every profile and mode", () => {
  const PROFILES = ["engineering", "standard", "staging", "production", "demo"] as const;
  const PROFILE_INSTRUCTIONS = "# Vector role\n\nYou are the deployment-owned Vector agent.\n";
  const CHARTER = "Dynamic Vector routine charter.";

  // Restricted profiles admit only <release>/paperclip/profile-assets/<profile>/;
  // engineering takes its configured instructions path.
  async function installProfile(profile: string) {
    const release = path.join(harness.root, "releases", "r1");
    const current = path.join(harness.root, "releases", "current");
    await fs.mkdir(path.join(release, "runtime", "bin"), { recursive: true });
    await writeRpcPiCommand(path.join(release, "runtime", "bin", "pi"), harness.argsDumpPath, harness.promptDumpPath);
    const file = path.join(release, "paperclip", "profile-assets", profile, "agent", "AGENTS.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, PROFILE_INSTRUCTIONS, "utf8");
    await fs.symlink(release, current).catch(() => undefined);
    const piCommand = path.join(current, "runtime", "bin", "pi");
    process.env.PAPERCLIP_VECTOR_PI_COMMAND = piCommand;
    return {
      command: piCommand,
      instructionsFilePath: path.join(current, "paperclip", "profile-assets", profile, "agent", "AGENTS.md"),
      // Agent-config prompt text is not the deployment's prompt.
      promptTemplate: "Template that must not reach Pi.",
      bootstrapPromptTemplate: "Bootstrap that must not reach Pi.",
    };
  }

  const reviewWake = () => conversationWake([userComment("comment-1", "EXACT_HUMAN_DIRECTION")], {
    reason: "issue_assigned",
    issue: { id: "issue-2", identifier: "VECA-2", title: "Review the change", status: "in_review", priority: "high", description: "UNIQUE_TASK_BRIEF" },
    executionStage: {
      stageId: "stage-1", wakeRole: "reviewer", stageType: "review", allowedActions: ["approve", "request_changes"],
      currentParticipant: { type: "agent", agentId: "agent-a" }, returnAssignee: { type: "agent", agentId: "agent-b" },
    },
    connectorSkillInstructions: "### agentmail\n\nUse the AgentMail tools.",
  });

  const MODES: Record<string, () => Record<string, unknown>> = {
    conversation: () => ({
      conversationMode: true,
      issueId: "issue-1",
      paperclipTaskMarkdown: "## Task\nConversation policy that must not reach Pi.",
      paperclipWake: conversationWake([userComment("comment-1", "What changed today?")]),
    }),
    incompleteConversation: () => ({
      conversationMode: true,
      issueId: "issue-1",
      paperclipTaskMarkdown: "## Task\nConversation policy that must not reach Pi.",
      paperclipWake: conversationWake([userComment("comment-1", "Partial batch.")], {
        commentIds: ["comment-0", "comment-1"],
        commentWindow: { requestedCount: 2, includedCount: 1, missingCount: 1 },
        truncated: true,
        fallbackFetchNeeded: true,
      }),
    }),
    task: () => ({
      issueId: "issue-2",
      paperclipSessionHandoffMarkdown: "Paperclip session handoff:\n- Previous session: s-1\n- Rotation reason: budget\nContinue from the current task state. Rebuild only the minimum context you need.",
      paperclipWake: reviewWake(),
    }),
    recovery: () => ({
      issueId: "issue-1",
      paperclipWake: conversationWake([userComment("comment-1", "Are you there?")], {
        recovery: { cause: "process_lost", failureSummary: "runner restarted" },
      }),
    }),
    routine: () => ({
      issueId: "issue-3",
      vectorWorkloadLaunch: { schemaVersion: 1, workloadKey: "current_scout", taskId: "task-1", systemPrompt: CHARTER },
      paperclipWake: conversationWake([userComment("comment-1", "Analyze the evidence envelope.")], { reason: "issue_assigned" }),
    }),
  };

  function runData(prompt: string): Record<string, unknown> {
    const match = /^(`{3,})json\n([\s\S]*)\n\1$/.exec(prompt);
    expect(match, prompt).not.toBeNull();
    return (JSON.parse(match![2]!) as { run: Record<string, unknown> }).run;
  }

  for (const profile of PROFILES) {
    for (const [mode, buildContext] of Object.entries(MODES)) {
      it(`${profile} ${mode}: only the deployment's prompt, run state as data`, async () => {
        const config = await installProfile(profile);
        const turn = await runTurn({ profile, config, context: buildContext() });
        expectNoPaperclipPromptText(turn.systemPrompt);
        expectNoPaperclipPromptText(turn.prompt);
        expect(turn.rpcMessage).toBe(turn.prompt);
        expect(turn.promptMetrics).toMatchObject({ vectorOwnedPrompt: 1, heartbeatPromptChars: 0, bootstrapPromptChars: 0 });
        // Engineering release role files resolve ../WORKFLOW.md against the
        // instruction base and read the operational Paperclip skill; every
        // other profile receives the deployment's instructions alone.
        const base = profile === "engineering"
          ? `${PROFILE_INSTRUCTIONS.trim()}\n\nInstruction base: ${path.dirname(config.instructionsFilePath)}/`
          : PROFILE_INSTRUCTIONS.trim();
        if (profile !== "engineering") expect(turn.skills).toEqual([]);
        expect(turn.systemPrompt).toBe(mode === "routine" ? `${base}\n\n${CHARTER}` : base);
        if (mode === "conversation") {
          expect(turn.prompt).toBe("What changed today?");
          return;
        }
        const run = runData(turn.prompt);
        if (mode === "incompleteConversation") {
          expect(run).toMatchObject({ fallbackFetchNeeded: true, missingCount: 1 });
        }
        if (mode === "task") {
          // Review stage, authority and the human direction survive as data.
          expect(run).toMatchObject({
            reason: "issue_assigned",
            issue: { identifier: "VECA-2", status: "in_review", description: "UNIQUE_TASK_BRIEF" },
            executionStage: { wakeRole: "reviewer", allowedActions: ["approve", "request_changes"] },
            sessionHandoff: ["Previous session: s-1", "Rotation reason: budget"],
          });
          expect(turn.prompt.split("UNIQUE_TASK_BRIEF")).toHaveLength(2);
          expect(turn.prompt).toContain("EXACT_HUMAN_DIRECTION");
        }
        if (mode === "recovery") {
          expect(run).toMatchObject({ recovery: { cause: "process_lost", failureSummary: "runner restarted" } });
        }
        if (mode === "routine") expect(turn.prompt).toContain("Analyze the evidence envelope.");
      });
    }
  }

  it("keeps a resumed task session on run data, not a Paperclip resume delta", async () => {
    const sessionPath = path.join(harness.root, "existing-session.jsonl");
    await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", cwd: harness.workspace })}\n`, "utf8");
    const turn = await runTurn({
      profile: "engineering",
      config: await installProfile("engineering"),
      runtime: { sessionId: sessionPath, sessionParams: { sessionId: sessionPath, cwd: harness.workspace } },
      context: MODES.task!(),
    });
    expect(turn.session).toBe(sessionPath);
    expectNoPaperclipPromptText(turn.prompt);
    expect(runData(turn.prompt)).toMatchObject({ executionStage: { allowedActions: ["approve", "request_changes"] } });
  });

  it("fails the run visibly when the release instructions file cannot be read", async () => {
    await fs.rm(harness.instructionsPath);
    await expect(runTurn({ profile: "engineering", context: MODES.task!() }))
      .rejects.toThrow(/Vector release instructions file .* could not be read/);
  });

  it("fails the run visibly when the release instructions file is empty", async () => {
    await fs.writeFile(harness.instructionsPath, "  \n", "utf8");
    await expect(runTurn({ profile: "engineering", context: MODES.task!() }))
      .rejects.toThrow(/Vector release instructions file .* is empty/);
  });

  it("fails the run visibly with no release instructions and no admitted Vector prompt", async () => {
    await expect(runTurn({
      profile: "staging",
      context: { conversationMode: true, issueId: "issue-1", paperclipWake: conversationWake([userComment("comment-1", "Board chat with no admitted role.")]) },
    })).rejects.toThrow("no release instructions file and no admitted Vector OS persona, role or workload prompt");
  });
});

// Byte-identical guard for installations outside Vector: these runs must
// render exactly what the upstream Paperclip prompts did. nonVectorConversation
// was generated against 625c5858c; the other cases against 759b5998d, whose
// non-Vector path predates Vector-owned prompting
// (VECTOR_PLAIN_CONVO_WRITE_GOLDEN=1).
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
  nonVectorTask: () => ({
    profile: null,
    context: {
      issueId: "issue-2",
      paperclipSessionHandoffMarkdown: "Paperclip session handoff:\n- Previous session: s-1\nContinue from the current task state.",
      paperclipWake: conversationWake([userComment("comment-1", "Please also update the docs.")], {
        reason: "issue_assigned",
        issue: { id: "issue-2", identifier: "PAP-2", title: "Board task", status: "todo", priority: "high", description: "Task brief." },
        connectorSkillInstructions: "### agentmail\n\nUse the AgentMail tools.",
      }),
    },
    config: { bootstrapPromptTemplate: "Bootstrap for {{agent.name}}." },
  }),
  nonVectorRecovery: () => ({
    profile: null,
    context: {
      issueId: "issue-1",
      paperclipWake: conversationWake([userComment("comment-1", "Are you there?")], {
        recovery: { cause: "process_lost", failureSummary: "runner restarted" },
      }),
    },
  }),
};

describe("unchanged prompts outside a Vector installation", () => {
  it("renders non-Vector conversation, task and recovery runs byte-identically", async () => {
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
    // Sanity: the guard actually covers the upstream scaffolding it protects.
    expect(golden.nonVectorConversation!.prompt).toContain("Hello from a non-Vector board.");
    expect(golden.nonVectorTask!.systemPrompt).toContain("The above agent instructions were loaded from");
    expect(golden.nonVectorTask!.systemPrompt).toContain("Continue your Paperclip work.");
    expect(golden.nonVectorTask!.prompt).toContain("Paperclip Wake Payload");
    expect(golden.nonVectorTask!.prompt).toContain("## Assigned connector skills");
    expect(golden.nonVectorRecovery!.prompt).toContain("Recovery contract");
  });
});

describe("resolveVectorPlainConversationMessage fail-safe", () => {
  const base = (wake: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    resolveVectorPlainConversationMessage({
      vectorProfile: "standard",
      context: { conversationMode: true, paperclipWake: wake, ...extra },
    });

  it("falls back to run data for every case it cannot reproduce exactly", () => {
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
