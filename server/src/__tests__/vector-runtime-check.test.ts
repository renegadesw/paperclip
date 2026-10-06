import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ migrations: vi.fn(), isolation: vi.fn() }));
vi.mock("@paperclipai/db", () => ({ assertMigrationsCurrent: mocks.migrations, assertVectorRuntimeIsolation: mocks.isolation }));
import { checkVectorRuntimeFromEnvironment } from "../vector-runtime-check.js";

describe("read-only installation activation check", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("DATABASE_URL", "postgres://paperclip_runtime:fixture@localhost/vector");
    vi.stubEnv("DATABASE_MIGRATION_URL", "");
    vi.stubEnv("PAPERCLIP_VECTOR_COMPANY_ID", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    vi.stubEnv("PAPERCLIP_VECTOR_INSTALLATION_ID", "fd-native");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("checks exact schema and restricted ownership before activation", async () => {
    await checkVectorRuntimeFromEnvironment();
    expect(mocks.migrations).toHaveBeenCalledWith(process.env.DATABASE_URL, "vector-embedded");
    expect(mocks.isolation).toHaveBeenCalledWith(process.env.DATABASE_URL, { companyId: process.env.PAPERCLIP_VECTOR_COMPANY_ID, installationId: "fd-native" });
    expect(mocks.migrations.mock.invocationCallOrder[0]).toBeLessThan(mocks.isolation.mock.invocationCallOrder[0]!);
  });
  it("refuses migration credentials in the runtime validation child", async () => {
    vi.stubEnv("DATABASE_MIGRATION_URL", "postgres://owner@localhost/vector");
    await expect(checkVectorRuntimeFromEnvironment()).rejects.toThrow(/restricted credentials/);
    expect(mocks.migrations).not.toHaveBeenCalled();
  });
  it("propagates schema drift without attempting a repair", async () => {
    mocks.migrations.mockRejectedValue(new Error("drift"));
    await expect(checkVectorRuntimeFromEnvironment()).rejects.toThrow("drift");
    expect(mocks.isolation).not.toHaveBeenCalled();
  });
});
