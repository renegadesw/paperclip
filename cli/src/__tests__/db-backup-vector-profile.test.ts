import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dbBackupCommand } from "../commands/db-backup.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("db:backup vector profile", () => {
  it("refuses a whole-database Paperclip backup", async () => {
    vi.stubEnv("PAPERCLIP_DATABASE_PROFILE", "vector-embedded");
    const missingConfig = path.join(
      os.tmpdir(),
      `paperclip-vector-backup-config-${process.pid}.json`,
    );

    await expect(
      dbBackupCommand({ config: missingConfig }),
    ).rejects.toThrow(/Vector's application-database backup system/);
  });
});
