import { describe, expect, it } from "vitest";
import {
  assertVectorRuntimeScopeOwnership,
  resolveVectorRuntimeScope,
  type VectorRuntimeScopePort,
} from "./vector-runtime-scope.js";

const installationA = "t480-engineering";
const companyA = "12d42db4-38df-5ae1-9b10-204b6f2e5d0c";
const companyB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentA = "e5b45684-168d-51af-9bb4-e9a5d96f6329";
const agentB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PAPERCLIP_VECTOR_INSTALLATION_ID: installationA,
    PAPERCLIP_VECTOR_PROFILE: "engineering",
    PAPERCLIP_VECTOR_COMPANY_ID: companyA,
    PAPERCLIP_VECTOR_ALLOWED_AGENT_IDS: agentA,
    ...overrides,
  };
}

function port(): VectorRuntimeScopePort {
  const ownerships = [
    { installationId: installationA, profile: "engineering", companyId: companyA },
    { installationId: "stecke1-standard", profile: "standard", companyId: companyB },
  ];
  const agents = [
    { id: agentA, companyId: companyA },
    { id: agentB, companyId: companyB },
  ];
  return {
    getOwnershipByInstallationId: async (id) => ownerships.find((row) => row.installationId === id) ?? null,
    listAgentCompanyBindings: async (ids) => agents.filter((row) => ids.includes(row.id)),
  };
}

describe("Vector runtime installation scope", () => {
  it("preserves standalone defaults but requires a complete vector-embedded scope", () => {
    expect(resolveVectorRuntimeScope("standalone", {})).toBeNull();
    expect(() => resolveVectorRuntimeScope("vector-embedded", {})).toThrow(
      "PAPERCLIP_VECTOR_ALLOWED_AGENT_IDS",
    );
    expect(resolveVectorRuntimeScope("vector-embedded", env())).toEqual({
      installationId: installationA,
      profile: "engineering",
      companyId: companyA,
      allowedAgentIds: [agentA],
    });
    expect(() => resolveVectorRuntimeScope("vector-embedded", env({
      PAPERCLIP_VECTOR_ALLOWED_AGENT_IDS: `${agentA},${agentA}`,
    }))).toThrow(/unique agent UUIDs/);
  });

  it("accepts each independently owned installation and rejects cross-install scope", async () => {
    const runtimePort = port();
    const scopeA = resolveVectorRuntimeScope("vector-embedded", env())!;
    const scopeB = resolveVectorRuntimeScope("vector-embedded", env({
      PAPERCLIP_VECTOR_INSTALLATION_ID: "stecke1-standard",
      PAPERCLIP_VECTOR_PROFILE: "standard",
      PAPERCLIP_VECTOR_COMPANY_ID: companyB,
      PAPERCLIP_VECTOR_ALLOWED_AGENT_IDS: agentB,
    }))!;
    await expect(assertVectorRuntimeScopeOwnership(runtimePort, scopeA)).resolves.toBeUndefined();
    await expect(assertVectorRuntimeScopeOwnership(runtimePort, scopeB)).resolves.toBeUndefined();
    await expect(assertVectorRuntimeScopeOwnership(runtimePort, {
      ...scopeA,
      companyId: companyB,
    })).rejects.toThrow(/does not match/);
    await expect(assertVectorRuntimeScopeOwnership(runtimePort, {
      ...scopeA,
      allowedAgentIds: [agentB],
    })).rejects.toThrow(/outside its provisioned company/);
  });

  it("fails closed when ownership is missing or its profile drifts", async () => {
    const scope = resolveVectorRuntimeScope("vector-embedded", env())!;
    await expect(assertVectorRuntimeScopeOwnership({
      getOwnershipByInstallationId: async () => null,
      listAgentCompanyBindings: async () => [],
    }, scope)).rejects.toThrow(/no provisioned installation ownership/);
    await expect(assertVectorRuntimeScopeOwnership({
      getOwnershipByInstallationId: async () => ({ ...scope, profile: "standard" }),
      listAgentCompanyBindings: async () => [{ id: agentA, companyId: companyA }],
    }, scope)).rejects.toThrow(/does not match/);
  });
});
