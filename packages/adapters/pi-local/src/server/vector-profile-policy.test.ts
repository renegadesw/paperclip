import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  FUNKYDEV_CAPABILITY_INVENTORY,
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

  describe("release-owned instructions file", () => {
    // Mirrors the Vector release layout: releases/<id>/runtime/bin/pi and
    // releases/<id>/paperclip/profile-assets/<profile>/<agent>/AGENTS.md,
    // with releases/current -> <id>.
    async function releaseTree() {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-vector-release-")));
      cleanupPaths.add(root);
      const release = path.join(root, "releases", "r1");
      const current = path.join(root, "releases", "current");
      await fs.mkdir(path.join(release, "runtime", "bin"), { recursive: true });
      await fs.writeFile(path.join(release, "runtime", "bin", "pi"), "#!/bin/sh\n");
      for (const profile of ["standard", "staging"]) {
        const dir = path.join(release, "paperclip", "profile-assets", profile, `${profile}-agent`);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "AGENTS.md"), `# ${profile}\n`);
      }
      await fs.symlink(release, current);
      const outside = path.join(root, "outside.md");
      await fs.writeFile(outside, "# not release-owned\n");
      return {
        root,
        release,
        current,
        outside,
        piCommand: (base: string) => path.join(base, "runtime", "bin", "pi"),
        asset: (base: string, profile = "standard") =>
          path.join(base, "paperclip", "profile-assets", profile, `${profile}-agent`, "AGENTS.md"),
      };
    }

    async function prepare(profile: string, instructionsFilePath: unknown, deploymentCommand: string) {
      return prepareVectorPiProfilePolicy({
        profile,
        config: { instructionsFilePath },
        command: deploymentCommand,
        deploymentCommand,
      });
    }

    it("admits the release-owned profile asset and returns its real path", async () => {
      const tree = await releaseTree();
      const policy = await prepare("standard", tree.asset(tree.release), tree.piCommand(tree.release));
      expect(policy.restricted).toBe(true);
      expect(policy.instructionsFilePath).toBe(tree.asset(tree.release));
      // Every other Pi resource stays disabled.
      expect(policy.cliArgs).toEqual([
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        "--no-tools",
      ]);
    });

    it.each([
      ["provisioner writes current, deployment pins current", "current", "current"],
      ["provisioner writes current, deployment pins the release", "current", "release"],
      ["provisioner writes the release, deployment pins current", "release", "current"],
    ] as const)("accepts the releases/current symlink form: %s", async (_label, assetBase, commandBase) => {
      const tree = await releaseTree();
      const policy = await prepare("staging", tree.asset(tree[assetBase], "staging"), tree.piCommand(tree[commandBase]));
      expect(policy.instructionsFilePath).toBe(tree.asset(tree.release, "staging"));
    });

    it("rejects a file outside the release", async () => {
      const tree = await releaseTree();
      await expect(prepare("standard", tree.outside, tree.piCommand(tree.release)))
        .rejects.toThrow(/forbids Pi runtime resource field "instructionsFilePath" \(the file is outside/);
    });

    it("rejects a `..` escape out of the profile assets", async () => {
      const tree = await releaseTree();
      const escape = `${path.join(tree.release, "paperclip", "profile-assets", "standard")}/../../../../../outside.md`;
      await expect(prepare("standard", escape, tree.piCommand(tree.release)))
        .rejects.toThrow("outside the deployment-owned release profile assets");
    });

    it("rejects a symlink inside the profile assets that escapes them", async () => {
      const tree = await releaseTree();
      const link = path.join(tree.release, "paperclip", "profile-assets", "standard", "standard-agent", "LINK.md");
      await fs.symlink(tree.outside, link);
      await expect(prepare("standard", link, tree.piCommand(tree.release)))
        .rejects.toThrow("outside the deployment-owned release profile assets");
    });

    it("rejects a non-file inside the profile assets", async () => {
      const tree = await releaseTree();
      const dir = path.dirname(tree.asset(tree.release));
      await expect(prepare("standard", dir, tree.piCommand(tree.release))).rejects.toThrow("not a regular file");
    });

    it("rejects another profile's release assets", async () => {
      const tree = await releaseTree();
      await expect(prepare("standard", tree.asset(tree.release, "staging"), tree.piCommand(tree.release)))
        .rejects.toThrow("outside the deployment-owned release profile assets");
    });

    it("rejects a missing file, a relative path and a non-string value", async () => {
      const tree = await releaseTree();
      const command = tree.piCommand(tree.release);
      await expect(prepare("standard", path.join(path.dirname(tree.asset(tree.release)), "MISSING.md"), command))
        .rejects.toThrow("the file does not exist");
      await expect(prepare("standard", "paperclip/profile-assets/standard/standard-agent/AGENTS.md", command))
        .rejects.toThrow("requires an absolute path");
      await expect(prepare("standard", ["/etc/passwd"], command)).rejects.toThrow("requires an absolute path");
    });

    it("rejects when the deployment Pi command identifies no release root", async () => {
      const tree = await releaseTree();
      const asset = tree.asset(tree.release);
      await expect(prepareVectorPiProfilePolicy({ profile: "standard", config: { instructionsFilePath: asset } }))
        .rejects.toThrow("identifies no release root");
      const bare = path.join(tree.release, "pi");
      await expect(prepare("standard", asset, bare)).rejects.toThrow("identifies no release root");
    });

    it("keeps every other restricted resource field rejected alongside an admitted file", async () => {
      const tree = await releaseTree();
      const command = tree.piCommand(tree.release);
      await expect(prepareVectorPiProfilePolicy({
        profile: "standard",
        config: { instructionsFilePath: tree.asset(tree.release), skills: ["./evil-skill"] },
        command,
        deploymentCommand: command,
      })).rejects.toThrow('runtime resource field "skills"');
    });
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
      additionalToolNames: [],
    });
  });

  it("loads the manifest-selected, hash-pinned Vault bridge only for engineering", async () => {
    const extensionPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../vector-extensions/funkydev-vault-reference.ts",
    );
    const contents = await fs.readFile(extensionPath);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    const engineering = await prepareVectorPiProfilePolicy({
      profile: "engineering",
      config: {},
      packagedExtensionsJson: JSON.stringify([{
        profile: "engineering",
        path: extensionPath,
        sha256,
        tools: ["vault_read", "vault_search"],
        permissions: { filesystem: true, shell: false },
      }]),
    });
    expect(engineering.additionalToolNames).toEqual(["vault_read", "vault_search"]);
    expect(engineering.cliArgs).toHaveLength(2);
    expect(engineering.cliArgs[0]).toBe("--extension");
    expect(engineering.cliArgs[1]).toMatch(/funkydev-vault-reference\.ts$/);

    await expect(prepareVectorPiProfilePolicy({
      profile: "standard",
      config: {},
      packagedExtensionsJson: JSON.stringify([{
        profile: "engineering",
        path: extensionPath,
        sha256,
        tools: ["vault_read", "vault_search"],
        permissions: { filesystem: true, shell: false },
      }]),
    })).rejects.toThrow('declares profile "engineering", expected "standard"');
  });

  it("rejects filesystem or shell authority in a restricted profile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-extension-policy-"));
    cleanupPaths.add(root);
    const extensionPath = path.join(root, "unsafe.ts");
    const contents = "export default function unsafe() {}\n";
    await fs.writeFile(extensionPath, contents, "utf8");
    const sha256 = createHash("sha256").update(contents).digest("hex");
    await expect(prepareVectorPiProfilePolicy({
      profile: "standard",
      config: {},
      packagedExtensionsJson: JSON.stringify([{
        profile: "standard",
        path: extensionPath,
        sha256,
        tools: ["unsafe_read"],
        permissions: { filesystem: true, shell: false },
      }]),
    })).rejects.toThrow("forbids packaged Pi extensions with filesystem or shell authority");
  });

  it("records callback-bound tools by their implemented authority parity", () => {
    const statuses = new Map(FUNKYDEV_CAPABILITY_INVENTORY.map((entry) => [entry.capability, entry.status]));
    expect(statuses.get("vault-reference")).toBe("ported");
    expect(statuses.get("voice-marker")).toBe("ported");
    expect(statuses.get("pi-builtins")).toBe("native");
    expect(statuses.get("operator-question")).toBe("ported");
    expect(statuses.get("todos")).toBe("ported");
    expect(statuses.get("github")).toBe("external");
    expect(statuses.has("github-broker")).toBe(false);
    expect(statuses.get("personal-memory")).toBe("ported");
    expect(statuses.get("vector-os-mcp")).toBe("blocked");
    expect(statuses.get("rctl")).toBe("external");
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
        {
          profile: "standard",
          path: extensionPath,
          sha256,
          tools: ["vector_chat_read"],
          permissions: { filesystem: false, shell: false },
        },
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
        {
          profile: "standard",
          path: extensionPath,
          sha256: "0".repeat(64),
          tools: [],
          permissions: { filesystem: false, shell: false },
        },
      ]),
    })).rejects.toThrow("digest mismatch");
  });
});
