import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-pi-local/server";

async function writeFakePiCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "" }, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
console.log(JSON.stringify({
  type: "auto_retry_end",
  success: false,
  attempt: 3,
  finalError: "Cloud Code Assist API error (429): RESOURCE_EXHAUSTED"
}));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeEnvDumpPiCommand(commandPath: string, envDumpPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(envDumpPath)}, process.env.PATH || "");
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "" }, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeRpcPiCommand(
  commandPath: string,
  argsDumpPath: string,
  promptDumpPath: string,
  stdinClosedPath: string,
  envDumpPath?: string,
): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
${envDumpPath ? `fs.writeFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify(process.env));` : ""}
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
  console.log(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "RPC " }
  }));
  console.log(JSON.stringify({
    type: "tool_execution_start",
    toolCallId: "rpc-tool-call-1",
    toolName: "read",
    args: { path: "README.md" }
  }));
  console.log(JSON.stringify({
    type: "tool_execution_update",
    toolCallId: "rpc-tool-call-1",
    toolName: "read",
    args: { path: "README.md" },
    partialResult: { content: "partial" }
  }));
  console.log(JSON.stringify({
    type: "tool_execution_end",
    toolCallId: "rpc-tool-call-1",
    toolName: "read",
    result: { content: "complete" },
    isError: false
  }));
  console.log(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "RPC reply" }],
      usage: { input: 11, output: 7, cacheRead: 3, cost: { total: 0.0042 } }
    }
  }));
  console.log(JSON.stringify({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "RPC reply" }],
      usage: { input: 11, output: 7, cacheRead: 3, cost: { total: 0.0042 } }
    },
    toolResults: []
  }));
  console.log(JSON.stringify({ type: "agent_settled" }));
});
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinClosedPath)}, "closed");
  process.exit(0);
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("pi_local execute", () => {
  it("keeps vector-embedded database and controller secrets out of the spawned RPC process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-env-isolation-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const argsDumpPath = path.join(root, "args.json");
    const promptDumpPath = path.join(root, "prompt.json");
    const stdinClosedPath = path.join(root, "stdin-closed");
    const envDumpPath = path.join(root, "env.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeRpcPiCommand(
      commandPath,
      argsDumpPath,
      promptDumpPath,
      stdinClosedPath,
      envDumpPath,
    );

    const saved = { ...process.env };
    Object.assign(process.env, {
      HOME: root,
      PAPERCLIP_DATABASE_PROFILE: "vector-embedded",
      PAPERCLIP_VECTOR_PROFILE: "standard",
      PAPERCLIP_VECTOR_PI_COMMAND: commandPath,
      DATABASE_URL: "postgres://private-database",
      DATABASE_MIGRATION_URL: "postgres://private-migration",
      PAPERCLIP_VECTOR_INGRESS_SECRET: "private-ingress-secret",
      PAPERCLIP_VECTOR_TOOL_BRIDGE_SECRET: "private-tool-secret",
      GLEISS_DATABASE_URL: "postgres://private-gleiss",
      OPENROUTER_API_KEY: "provider-key-is-allowed",
    });

    try {
      const result = await execute({
        runId: "run-vector-env-isolation",
        agent: {
          id: "agent-env-isolation",
          companyId: "company-env-isolation",
          name: "Pi RPC Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          executionMode: "rpc",
          promptTemplate: "Check the environment.",
        },
        context: {},
        authToken: "run-scoped-paperclip-token",
        onLog: async () => {},
      });
      expect(result.exitCode).toBe(0);
      const spawned = JSON.parse(await fs.readFile(envDumpPath, "utf8")) as Record<string, string>;
      expect(spawned).toMatchObject({
        PAPERCLIP_API_KEY: "run-scoped-paperclip-token",
        PAPERCLIP_RUN_ID: "run-vector-env-isolation",
        OPENROUTER_API_KEY: "provider-key-is-allowed",
      });
      for (const forbidden of [
        "DATABASE_URL",
        "DATABASE_MIGRATION_URL",
        "PAPERCLIP_DATABASE_PROFILE",
        "PAPERCLIP_VECTOR_INGRESS_SECRET",
        "PAPERCLIP_VECTOR_TOOL_BRIDGE_SECRET",
        "GLEISS_DATABASE_URL",
      ]) {
        expect(spawned).not.toHaveProperty(forbidden);
      }
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs a complete Pi turn through stdio RPC and closes stdin after settlement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-rpc-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const argsDumpPath = path.join(root, "args.json");
    const promptDumpPath = path.join(root, "prompt.json");
    const stdinClosedPath = path.join(root, "stdin-closed");
    const attackerSkillDir = path.join(root, "attacker-skill");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(attackerSkillDir, { recursive: true });
    await fs.writeFile(path.join(attackerSkillDir, "SKILL.md"), "# attacker skill\n", "utf8");
    await writeRpcPiCommand(commandPath, argsDumpPath, promptDumpPath, stdinClosedPath);

    const previousHome = process.env.HOME;
    const previousVectorProfile = process.env.PAPERCLIP_VECTOR_PROFILE;
    const previousVectorPiCommand = process.env.PAPERCLIP_VECTOR_PI_COMMAND;
    process.env.HOME = root;
    process.env.PAPERCLIP_VECTOR_PROFILE = "standard";
    process.env.PAPERCLIP_VECTOR_PI_COMMAND = commandPath;

    try {
      const events: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
      const result = await execute({
        runId: "run-pi-rpc",
        agent: {
          id: "agent-rpc",
          companyId: "company-rpc",
          name: "Pi RPC Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          executionMode: "rpc",
          promptTemplate: "Work the RPC task.",
          paperclipRuntimeSkills: [
            { key: "attacker/skill", runtimeName: "attacker-skill", source: attackerSkillDir },
          ],
          paperclipSkillSync: { desiredSkills: ["attacker/skill"] },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onEvent: async (event) => { events.push(event); },
      });

      expect(result.exitCode).toBe(0);
      expect(result.summary).toBe("RPC reply");
      expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7, cachedInputTokens: 3 });
      expect(result.costUsd).toBe(0.0042);
      expect(await fs.readFile(stdinClosedPath, "utf8")).toBe("closed");

      const args = JSON.parse(await fs.readFile(argsDumpPath, "utf8")) as string[];
      expect(args).toContain("rpc");
      expect(args).not.toContain("-p");
      expect(args).toContain("--no-builtin-tools");
      expect(args).not.toContain("--tools");
      expect(args).toContain("--no-tools");
      expect(args).toContain("--no-extensions");
      expect(args).toContain("--no-skills");
      expect(args).toContain("--no-context-files");
      expect(args).toContain("--skill");
      expect(args).not.toContain(attackerSkillDir);
      expect(args.at(-1)).not.toBe("Work the RPC task.");

      const prompt = JSON.parse(await fs.readFile(promptDumpPath, "utf8")) as Record<string, unknown>;
      expect(prompt).toMatchObject({ type: "prompt", message: "Work the RPC task." });
      expect(String(prompt.id)).toContain("run-pi-rpc");

      expect(events.map((event) => event.eventType)).toEqual([
        "assistant_delta",
        "tool_call",
        "tool_update",
        "tool_result",
        "assistant_final",
        "usage",
        "agent_settled",
      ]);
      expect(events.filter((event) => event.eventType.startsWith("tool")).map((event) => event.payload?.toolCallId))
        .toEqual(["rpc-tool-call-1", "rpc-tool-call-1", "rpc-tool-call-1"]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousVectorProfile === undefined) delete process.env.PAPERCLIP_VECTOR_PROFILE;
      else process.env.PAPERCLIP_VECTOR_PROFILE = previousVectorProfile;
      if (previousVectorPiCommand === undefined) delete process.env.PAPERCLIP_VECTOR_PI_COMMAND;
      else process.env.PAPERCLIP_VECTOR_PI_COMMAND = previousVectorPiCommand;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("launches an approved packaged extension tool while keeping Pi built-ins unavailable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-extension-rpc-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const extensionPath = path.join(root, "vector-chat.ts");
    const argsDumpPath = path.join(root, "args.json");
    const promptDumpPath = path.join(root, "prompt.json");
    const stdinClosedPath = path.join(root, "stdin-closed");
    const extensionContents = "export default function vectorChat() {}\n";
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(extensionPath, extensionContents, "utf8");
    await writeRpcPiCommand(commandPath, argsDumpPath, promptDumpPath, stdinClosedPath);

    const previousVectorProfile = process.env.PAPERCLIP_VECTOR_PROFILE;
    const previousVectorPiCommand = process.env.PAPERCLIP_VECTOR_PI_COMMAND;
    const previousPackagedExtensions = process.env.PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS;
    process.env.PAPERCLIP_VECTOR_PROFILE = "standard";
    process.env.PAPERCLIP_VECTOR_PI_COMMAND = commandPath;
    process.env.PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS = JSON.stringify([{
      profile: "standard",
      path: extensionPath,
      sha256: createHash("sha256").update(extensionContents).digest("hex"),
      tools: ["vector_chat_read"],
      delivery: "local",
      permissions: { filesystem: false, shell: false },
    }]);

    try {
      const result = await execute({
        runId: "run-pi-approved-extension",
        agent: {
          id: "agent-approved-extension",
          companyId: "company-approved-extension",
          name: "Pi Chat Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          executionMode: "rpc",
          promptTemplate: "Use the approved read-only bridge.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const args = JSON.parse(await fs.readFile(argsDumpPath, "utf8")) as string[];
      expect(args).toContain("--no-builtin-tools");
      expect(args).toContain("--no-extensions");
      expect(args).not.toContain("--no-tools");
      expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
        "--tools",
        "vector_chat_read",
      ]);
      expect(args.slice(args.indexOf("--extension"), args.indexOf("--extension") + 2)).toEqual([
        "--extension",
        extensionPath,
      ]);
      expect(args.join(" ")).not.toMatch(/(?:^|,)read(?:,|$)/);
      expect(args.join(" ")).not.toMatch(/(?:^|,)bash(?:,|$)/);
      expect(args.join(" ")).not.toMatch(/(?:^|,)write(?:,|$)/);
    } finally {
      if (previousVectorProfile === undefined) delete process.env.PAPERCLIP_VECTOR_PROFILE;
      else process.env.PAPERCLIP_VECTOR_PROFILE = previousVectorProfile;
      if (previousVectorPiCommand === undefined) delete process.env.PAPERCLIP_VECTOR_PI_COMMAND;
      else process.env.PAPERCLIP_VECTOR_PI_COMMAND = previousVectorPiCommand;
      if (previousPackagedExtensions === undefined) {
        delete process.env.PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS;
      } else {
        process.env.PAPERCLIP_VECTOR_PI_PACKAGED_EXTENSIONS = previousPackagedExtensions;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported Pi execution modes", async () => {
    await expect(execute({
      runId: "run-pi-invalid-mode",
      agent: {
        id: "agent-invalid-mode",
        companyId: "company-invalid-mode",
        name: "Pi Agent",
        adapterType: "pi_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { executionMode: "interactive" },
      context: {},
      authToken: "run-jwt-token",
      onLog: async () => {},
    })).rejects.toThrow('Unsupported Pi executionMode "interactive"');
  });

  it("fails the run when Pi exhausts automatic retries despite exiting 0", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakePiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-pi-quota-exhausted",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("RESOURCE_EXHAUSTED");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prepends installed skill bin/ dirs to the spawned Pi child PATH", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-path-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const skillDir = path.join(root, "skills", "demo-skill");
    const skillBinDir = path.join(skillDir, "bin");
    const envDumpPath = path.join(root, "captured-path.txt");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(skillBinDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# demo-skill\n", "utf8");
    await writeEnvDumpPiCommand(commandPath, envDumpPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      await execute({
        runId: "run-pi-skill-path",
        agent: {
          id: "agent-skill-path",
          companyId: "company-skill-path",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
          paperclipRuntimeSkills: [
            { key: "demo-skill", runtimeName: "demo-skill", source: skillDir },
          ],
          paperclipSkillSync: {
            desiredSkills: ["demo-skill"],
          },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      const capturedPath = await fs.readFile(envDumpPath, "utf8");
      const entries = capturedPath.split(path.delimiter);
      expect(entries[0]).toBe(skillBinDir);
      expect(entries.filter((entry) => entry === skillBinDir)).toHaveLength(1);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose bin/ dirs from skills that are not injected", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-path-neg-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const nonInjectedSkillDir = path.join(root, "skills", "not-injected");
    const nonInjectedBinDir = path.join(nonInjectedSkillDir, "bin");
    const envDumpPath = path.join(root, "captured-path.txt");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(nonInjectedBinDir, { recursive: true });
    await fs.writeFile(path.join(nonInjectedSkillDir, "SKILL.md"), "# not-injected\n", "utf8");
    await writeEnvDumpPiCommand(commandPath, envDumpPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      await execute({
        runId: "run-pi-skill-path-neg",
        agent: {
          id: "agent-skill-path-neg",
          companyId: "company-skill-path-neg",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
          // The implicit legacy default applies only to the canonical Paperclip
          // operational skill, so this unrelated skill remains unselected.
          paperclipRuntimeSkills: [
            { key: "not-injected", runtimeName: "not-injected", source: nonInjectedSkillDir },
          ],
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      const capturedPath = await fs.readFile(envDumpPath, "utf8");
      expect(capturedPath.split(path.delimiter)).not.toContain(nonInjectedBinDir);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
