import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";

const missingConfigPath = path.join(
  os.tmpdir(),
  `paperclip-vector-database-config-${process.pid}.json`,
);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("vector-embedded database configuration", () => {
  it("disables Paperclip-owned backups even when the generic override requests them", () => {
    vi.stubEnv("PAPERCLIP_CONFIG", missingConfigPath);
    vi.stubEnv("PAPERCLIP_DATABASE_PROFILE", "vector-embedded");
    vi.stubEnv("PAPERCLIP_DB_BACKUP_ENABLED", "true");

    const config = loadConfig();

    expect(config.databaseDeploymentProfile).toBe("vector-embedded");
    expect(config.databaseBackupEnabled).toBe(false);
  });

  it("rejects unknown database profiles instead of falling back", () => {
    vi.stubEnv("PAPERCLIP_CONFIG", missingConfigPath);
    vi.stubEnv("PAPERCLIP_DATABASE_PROFILE", "shared-ish");

    expect(() => loadConfig()).toThrow(/PAPERCLIP_DATABASE_PROFILE/);
  });
});
