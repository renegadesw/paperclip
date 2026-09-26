import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareVectorPiProfilePolicy,
  vectorPiProfileIsRestricted,
} from "./vector-profile-policy.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanupPaths].map((entry) => fs.rm(entry, { recursive: true, force: true })));
  cleanupPaths.clear();
});

describe("Vector Pi profile isolation", () => {
  it.each(["standard", "staging", "production", "demo", "prodution", " future "])(
    "fails closed for configured non-engineering profile %s",
    (profile) => {
      expect(vectorPiProfileIsRestricted(profile)).toBe(true);
    },
  );

  it.each([undefined, "", "engineering", " Engineering "])(
    "retains upstream or engineering behavior for profile %s",
    (profile) => {
      expect(vectorPiProfileIsRestricted(profile)).toBe(false);
    },
  );

  it("disables ambient resources and all tools while preserving an explicit skill seam", async () => {
    const policy = await prepareVectorPiProfilePolicy({
      profile: "standard",
      config: {},
    });

    expect(policy).toMatchObject({
      profile: "standard",
      restricted: true,
      useBundledPaperclipSkillsOnly: true,
    });
    expect(policy.cliArgs).toEqual([
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--no-tools",
    ]);
    expect(policy.cliArgs).not.toContain("--skill");
  });

  it.each([
    ["--extension", "./evil.ts"],
    ["--extension=./evil.ts"],
    ["-e", "./evil.ts"],
    ["-e./evil.ts"],
    ["--skill", "./evil-skill"],
    ["--skill=./evil-skill"],
    ["--tools", "mcp_call"],
    ["--tools=mcp_call"],
    ["-t", "mcp_call"],
    ["-tmcp_call"],
    ["--exclude-tools", "read"],
    ["--exclude-tools=read"],
    ["-xt", "read"],
    ["-xtread"],
    ["--mcp-config", "./mcp.json"],
    ["--mcp-config=./mcp.json"],
    ["--prompt-template", "./override.md"],
    ["--theme=./extension-theme.ts"],
  ])("rejects mutable runtime-loading extraArgs: %j", async (...extraArgs) => {
    await expect(prepareVectorPiProfilePolicy({
      profile: "standard",
      config: {},
      extraArgs,
    })).rejects.toThrow("forbids Pi runtime-loading flag");
  });

  it("rejects unrecognized extraArgs instead of relying on today's Pi parser", async () => {
    await expect(prepareVectorPiProfilePolicy({
      profile: "standard",
      config: {},
      extraArgs: ["--future-mcp-loader", "./mcp.json"],
    })).rejects.toThrow("forbids mutable Pi extraArgs");
  });

  it("rejects an agent-configured command wrapper outside the deployment pin", async () => {
    await expect(prepareVectorPiProfilePolicy({
      profile: "standard",
      config: { command: "/tmp/pi-wrapper" },
      command: "/tmp/pi-wrapper",
      deploymentCommand: "/opt/vector/bin/pi",
    })).rejects.toThrow("requires the deployment-owned Pi command");
  });

  it.each([
    ["extensions", ["./evil.ts"]],
    ["skills", ["./evil-skill"]],
    ["customTools", [{ name: "shell" }]],
    ["mcpServers", { local: { command: "evil" } }],
    ["agentDir", "/tmp/evil-agent"],
    ["settingsPath", "/tmp/evil-settings.json"],
    ["instructionsFilePath", "/etc/passwd"],
  ])("rejects mutable runtime resource field %s", async (field, value) => {
    await expect(prepareVectorPiProfilePolicy({
      profile: "standard",
      config: { [field]: value },
    })).rejects.toThrow(`runtime resource field "${field}"`);
  });

  it.each([
    "HOME",
    "home",
    "PATH",
    "Path",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PI_CODING_AGENT_DIR",
    "PI_PACKAGE_DIR",
    "XDG_CONFIG_HOME",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "ANTHROPIC_API_KEY",
    "FUTURE_PI_RESOURCE_LOADER",
  ])("rejects mutable environment variable %s from agent config", async (name) => {
    await expect(prepareVectorPiProfilePolicy({
      profile: "standard",
      config: { env: { [name]: "/tmp/attacker-controlled" } },
    })).rejects.toThrow("forbids mutable agent env");
  });

  it("allows engineering to retain configured coding surfaces", async () => {
    await expect(prepareVectorPiProfilePolicy({
      profile: "engineering",
      config: {
        extensions: ["./engineering-extension.ts"],
        env: { PI_CODING_AGENT_DIR: "/tmp/engineering-pi" },
      },
      extraArgs: ["--mcp-config", "./engineering-mcp.json"],
    })).resolves.toEqual({
      profile: "engineering",
      restricted: false,
      cliArgs: [],
      discoveryCliArgs: [],
      useBundledPaperclipSkillsOnly: false,
    });
  });

  it("loads only deployment-owned packaged extensions with an exact path and digest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-extension-policy-"));
    cleanupPaths.add(root);
    const extensionPath = path.join(root, "vector-chat.ts");
    const contents = "export default function vectorChat() {}\n";
    await fs.writeFile(extensionPath, contents, "utf8");
    const sha256 = createHash("sha256").update(contents).digest("hex");

    const policy = await prepareVectorPiProfilePolicy({
      profile: "standard",
      config: {},
      packagedExtensionsJson: JSON.stringify([
        { path: extensionPath, sha256, tools: ["vector_chat_read"] },
      ]),
    });

    expect(policy.cliArgs).toContain("--no-extensions");
    expect(policy.cliArgs).toContain("--tools");
    expect(policy.cliArgs).toContain("vector_chat_read");
    expect(policy.cliArgs).toContain("--extension");
    expect(policy.cliArgs).toContain(extensionPath);
    expect(policy.cliArgs).not.toContain("--no-tools");
  });

  it("fails closed when a packaged extension digest no longer matches", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-extension-policy-"));
    cleanupPaths.add(root);
    const extensionPath = path.join(root, "vector-chat.ts");
    await fs.writeFile(extensionPath, "changed\n", "utf8");

    await expect(prepareVectorPiProfilePolicy({
      profile: "standard",
      config: {},
      packagedExtensionsJson: JSON.stringify([
        { path: extensionPath, sha256: "0".repeat(64), tools: [] },
      ]),
    })).rejects.toThrow("digest mismatch");
  });
});
