import { pathToFileURL } from "node:url";
import { assertMigrationsCurrent, assertVectorRuntimeIsolation } from "@paperclipai/db";

/** Offline, read-only final installer check using only the child credential. */
export async function checkVectorRuntimeFromEnvironment(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const companyId = process.env.PAPERCLIP_VECTOR_COMPANY_ID?.trim();
  const installationId = process.env.PAPERCLIP_VECTOR_INSTALLATION_ID?.trim();
  if (!databaseUrl || !companyId || !installationId || process.env.DATABASE_MIGRATION_URL) {
    throw new Error("Vector runtime check requires restricted credentials and installation scope only");
  }
  await assertMigrationsCurrent(databaseUrl, "vector-embedded");
  await assertVectorRuntimeIsolation(databaseUrl, { companyId, installationId });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  checkVectorRuntimeFromEnvironment().then(() => {
    process.stdout.write('{"ok":true,"databaseRole":"paperclip_runtime"}\n');
  }).catch(() => {
    process.stderr.write("Vector runtime isolation validation failed\n");
    process.exitCode = 1;
  });
}
