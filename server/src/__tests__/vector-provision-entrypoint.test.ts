import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  db: {},
  assertMigrationsCurrent: vi.fn(),
  createDb: vi.fn(),
  closeRegisteredClients: vi.fn(),
  provision: vi.fn(),
}));
vi.mock("@paperclipai/db", () => ({
  assertMigrationsCurrent: calls.assertMigrationsCurrent,
  createDb: calls.createDb,
  closeRegisteredClients: calls.closeRegisteredClients,
}));
vi.mock("../services/vector-installation-provisioning.js", () => ({
  provisionVectorInstallation: calls.provision,
  vectorInstallationManifestSchema: { parse: (value: unknown) => value },
}));
import { runVectorProvisionFromEnvironment } from "../vector-provision.js";

describe("Vector installer schema boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", "postgres://fixture/vector");
    vi.stubEnv("PAPERCLIP_VECTOR_PROVISION_MANIFEST_JSON", JSON.stringify({ installationId: "standard-test", company: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }));
    vi.stubEnv("PAPERCLIP_VECTOR_TOOL_POLICY_JSON", "{}");
    vi.stubEnv("PAPERCLIP_VECTOR_PROFILE", "standard");
    vi.stubEnv("PAPERCLIP_VECTOR_STAGED_RELEASE_ROOT", "/fixture/staged");
    vi.stubEnv("PAPERCLIP_VECTOR_ACTIVE_RELEASE_ROOT", "/fixture/current");
    calls.assertMigrationsCurrent.mockResolvedValue(undefined);
    calls.createDb.mockReturnValue(calls.db);
    calls.provision.mockResolvedValue({ schemaVersion: 1 });
    calls.closeRegisteredClients.mockResolvedValue(undefined);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("checks the llm migration journal and opens only the embedded profile", async () => {
    await runVectorProvisionFromEnvironment();
    expect(calls.assertMigrationsCurrent).toHaveBeenCalledWith("postgres://fixture/vector", "vector-embedded");
    expect(calls.createDb).toHaveBeenCalledWith("postgres://fixture/vector", {
      deploymentProfile: "vector-embedded", vectorRuntimeScope: { installationId: "standard-test", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    expect(calls.assertMigrationsCurrent.mock.invocationCallOrder[0]).toBeLessThan(calls.createDb.mock.invocationCallOrder[0]);
    expect(calls.provision).toHaveBeenCalledWith(calls.db, expect.objectContaining({ selectedProfile: "standard" }));
    expect(calls.closeRegisteredClients).toHaveBeenCalledWith("postgres://fixture/vector");
  });

  it("refuses schema drift before any provisioning connection or write", async () => {
    calls.assertMigrationsCurrent.mockRejectedValue(new Error("schema drift"));
    await expect(runVectorProvisionFromEnvironment()).rejects.toThrow("schema drift");
    expect(calls.createDb).not.toHaveBeenCalled();
    expect(calls.provision).not.toHaveBeenCalled();
  });

  it("closes the scoped pool if provisioning rejects the manifest", async () => {
    calls.provision.mockRejectedValue(new Error("manifest drift"));
    await expect(runVectorProvisionFromEnvironment()).rejects.toThrow("manifest drift");
    expect(calls.closeRegisteredClients).toHaveBeenCalledWith("postgres://fixture/vector");
  });
});
