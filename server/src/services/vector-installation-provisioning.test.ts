import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  reconcileVectorInstallation,
  type VectorProvisioningPort,
} from "./vector-installation-provisioning.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-vector-provision-"));
  roots.push(root);
  const stagedReleaseRoot = path.join(root, "stage");
  const activeReleaseRoot = path.join(root, "releases", "current");
  const relative = "paperclip/profile-assets/engineering/funkydev/AGENTS.md";
  const body = "# FunkyDev\n";
  await fs.mkdir(path.dirname(path.join(stagedReleaseRoot, relative)), { recursive: true });
  await fs.writeFile(path.join(stagedReleaseRoot, relative), body);
  const toolPolicy = {
    profile: "engineering",
    builtinTools: ["bash", "edit", "find", "grep", "ls", "read", "write"],
    extensions: [{
      name: "funkydev.vault-reference",
      tools: ["vault_read", "vault_search"],
      permissions: { filesystem: true, shell: false },
    }],
  };
  const manifest = {
    schemaVersion: 1,
    manifestRevision: 1,
    installationId: "t480-engineering",
    profile: "engineering",
    company: {
      id: "12d42db4-38df-5ae1-9b10-204b6f2e5d0c",
      name: "Vector Engineering",
      description: "Vector engineering control plane",
      budgetMonthlyCents: 0,
      mutableFields: [],
    },
    agent: {
      id: "e5b45684-168d-51af-9bb4-e9a5d96f6329",
      name: "FunkyDev",
      role: "engineer",
      title: "Standing Vector engineer",
      capabilities: "Repository engineering and operator collaboration.",
      adapterType: "pi_local",
      adapterConfig: {
        model: "router/Qwen3.8-Flash",
        thinking: "high",
        executionMode: "rpc",
        cwd: "/home/funkydev",
      },
      instructions: { path: relative, sha256: createHash("sha256").update(body).digest("hex") },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      budgetMonthlyCents: 0,
      permissions: { canCreateAgents: false, canCreateSkills: false },
      mutableFields: [],
    },
    toolPolicy,
  };
  return { manifest, toolPolicy, stagedReleaseRoot, activeReleaseRoot };
}

function memoryPort(): VectorProvisioningPort & { companies: any[]; ownerships: any[]; agents: any[] } {
  const companies: any[] = [];
  const ownerships: any[] = [];
  const agents: any[] = [];
  return {
    companies,
    ownerships,
    agents,
    listCompanies: async () => companies,
    getCompany: async (id) => companies.find((row) => row.id === id) ?? null,
    createCompany: async (input) => { companies.push({ ...input }); return companies.at(-1); },
    getOwnershipByInstallationId: async (installationId) => ownerships.find((row) => row.installationId === installationId) ?? null,
    getOwnershipByCompanyId: async (companyId) => ownerships.find((row) => row.companyId === companyId) ?? null,
    createOwnership: async (input) => { ownerships.push({ ...input }); return ownerships.at(-1); },
    listAgents: async (companyId) => agents.filter((row) => row.companyId === companyId),
    getAgent: async (id) => agents.find((row) => row.id === id) ?? null,
    createAgent: async (companyId, input) => { agents.push({ ...input, companyId }); return agents.at(-1); },
  };
}

describe("Vector installation provisioning", () => {
  it("creates once and retries with identical stable ids", async () => {
    const f = await fixture();
    const port = memoryPort();
    const first = await reconcileVectorInstallation(port, { ...f, selectedProfile: "engineering", effectiveToolPolicy: f.toolPolicy });
    const retry = await reconcileVectorInstallation(port, { ...f, selectedProfile: "engineering", effectiveToolPolicy: f.toolPolicy });
    expect(first).toMatchObject({
      companyId: f.manifest.company.id,
      agentId: f.manifest.agent.id,
      created: { company: true, ownership: true, agent: true },
    });
    expect(retry).toMatchObject({
      companyId: first.companyId,
      agentId: first.agentId,
      created: { company: false, ownership: false, agent: false },
    });
    expect(port.companies).toHaveLength(1);
    expect(port.ownerships).toEqual([{
      installationId: f.manifest.installationId,
      profile: f.manifest.profile,
      companyId: f.manifest.company.id,
    }]);
    expect(port.agents).toHaveLength(1);
    expect(port.agents[0].adapterConfig).toMatchObject({
      executionMode: "rpc",
      model: "router/Qwen3.8-Flash",
      cwd: "/home/funkydev",
      instructionsFilePath: path.join(f.activeReleaseRoot, f.manifest.agent.instructions.path),
    });
    expect(port.agents[0].adapterConfig).not.toHaveProperty("env");
  });

  it("fails closed on immutable drift but preserves explicitly mutable fields", async () => {
    const f = await fixture();
    const port = memoryPort();
    await reconcileVectorInstallation(port, { ...f, selectedProfile: "engineering", effectiveToolPolicy: f.toolPolicy });
    port.agents[0].title = "operator title";
    await expect(reconcileVectorInstallation(port, {
      ...f,
      selectedProfile: "engineering",
      effectiveToolPolicy: f.toolPolicy,
    })).rejects.toThrow("immutable field agent.title");
    (f.manifest.agent.mutableFields as string[]).push("title");
    const receipt = await reconcileVectorInstallation(port, {
      ...f,
      selectedProfile: "engineering",
      effectiveToolPolicy: f.toolPolicy,
    });
    expect(receipt.created.agent).toBe(false);
    expect(port.agents[0].title).toBe("operator title");
  });

  it("rejects profile, tool policy, digest, and identity mismatches before mutation", async () => {
    const f = await fixture();
    for (const change of [
      { selectedProfile: "standard" },
      { effectiveToolPolicy: { ...f.toolPolicy, builtinTools: [] } },
      { manifest: { ...f.manifest, agent: { ...f.manifest.agent, instructions: { ...f.manifest.agent.instructions, sha256: "0".repeat(64) } } } },
    ]) {
      const port = memoryPort();
      await expect(reconcileVectorInstallation(port, {
        ...f,
        selectedProfile: "engineering",
        effectiveToolPolicy: f.toolPolicy,
        ...change,
      })).rejects.toThrow();
      expect(port.companies).toHaveLength(0);
      expect(port.ownerships).toHaveLength(0);
      expect(port.agents).toHaveLength(0);
    }

    const port = memoryPort();
    port.companies.push({ ...f.manifest.company, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    await expect(reconcileVectorInstallation(port, {
      ...f,
      selectedProfile: "engineering",
      effectiveToolPolicy: f.toolPolicy,
    })).rejects.toThrow("company identity collision");
  });

  it("fails on installation, company, or profile ownership drift", async () => {
    const f = await fixture();
    const cases = [
      { installationId: f.manifest.installationId, profile: "standard", companyId: f.manifest.company.id },
      { installationId: "another-installation", profile: f.manifest.profile, companyId: f.manifest.company.id },
      { installationId: f.manifest.installationId, profile: f.manifest.profile, companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    ];
    for (const ownership of cases) {
      const port = memoryPort();
      port.companies.push({ ...f.manifest.company });
      port.ownerships.push(ownership);
      await expect(reconcileVectorInstallation(port, {
        ...f,
        selectedProfile: "engineering",
        effectiveToolPolicy: f.toolPolicy,
      })).rejects.toThrow(/ownership|installationOwnership/);
      expect(port.agents).toHaveLength(0);
    }
  });

  it("keeps two installation ownerships distinct on a shared database port", async () => {
    const first = await fixture();
    const second = await fixture();
    second.manifest.installationId = "stecke1-engineering";
    second.manifest.company = {
      ...second.manifest.company,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Vector Engineering Two",
    };
    second.manifest.agent = {
      ...second.manifest.agent,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "FunkyDev Two",
    };
    const port = memoryPort();
    await reconcileVectorInstallation(port, {
      ...first,
      selectedProfile: "engineering",
      effectiveToolPolicy: first.toolPolicy,
    });
    await reconcileVectorInstallation(port, {
      ...second,
      selectedProfile: "engineering",
      effectiveToolPolicy: second.toolPolicy,
    });
    expect(port.ownerships).toEqual([
      {
        installationId: first.manifest.installationId,
        profile: "engineering",
        companyId: first.manifest.company.id,
      },
      {
        installationId: second.manifest.installationId,
        profile: "engineering",
        companyId: second.manifest.company.id,
      },
    ]);
    const crossed = {
      ...second,
      manifest: {
        ...second.manifest,
        installationId: first.manifest.installationId,
      },
    };
    await expect(reconcileVectorInstallation(port, {
      ...crossed,
      selectedProfile: "engineering",
      effectiveToolPolicy: second.toolPolicy,
    })).rejects.toThrow(/ownership/);
  });

  it.each([
    ["token", { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 }, nested: { token: "abc" } } }],
    ["password", { permissions: { canCreateAgents: false, canCreateSkills: false, password: "abc" } }],
    ["apiKey", { adapterConfig: { model: "router/Qwen3.8-Flash", thinking: "high", executionMode: "rpc", cwd: "/home/funkydev", apiKey: "abc" } }],
    ["databaseUrl", { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 }, databaseUrl: "postgres://example" } }],
    ["privateKey", { permissions: { canCreateAgents: false, canCreateSkills: false, nested: { privateKey: "abc" } } }],
    ["environment expansion", { capabilities: "Use ${PROVIDER_API_KEY}" }],
  ])("rejects embedded %s authority before mutation", async (_label, agentPatch) => {
    const f = await fixture();
    const port = memoryPort();
    await expect(reconcileVectorInstallation(port, {
      ...f,
      manifest: {
        ...f.manifest,
        agent: { ...f.manifest.agent, ...agentPatch },
      },
      selectedProfile: "engineering",
      effectiveToolPolicy: f.toolPolicy,
    })).rejects.toThrow(/must not contain/);
    expect(port.companies).toHaveLength(0);
    expect(port.agents).toHaveLength(0);
  });
});
