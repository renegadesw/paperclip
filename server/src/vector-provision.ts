import { pathToFileURL } from "node:url";
import { closeRegisteredClients, createDb } from "@paperclipai/db";
import {
  provisionVectorInstallation,
  type VectorProvisioningInput,
} from "./services/vector-installation-provisioning.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Vector provisioning requires ${name}`);
  return value;
}

export async function runVectorProvisionFromEnvironment(): Promise<void> {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const manifest = JSON.parse(requiredEnv("PAPERCLIP_VECTOR_PROVISION_MANIFEST_JSON"));
  const effectiveToolPolicy = JSON.parse(requiredEnv("PAPERCLIP_VECTOR_TOOL_POLICY_JSON"));
  const input: VectorProvisioningInput = {
    manifest,
    effectiveToolPolicy,
    selectedProfile: requiredEnv("PAPERCLIP_VECTOR_PROFILE"),
    stagedReleaseRoot: requiredEnv("PAPERCLIP_VECTOR_STAGED_RELEASE_ROOT"),
    activeReleaseRoot: requiredEnv("PAPERCLIP_VECTOR_ACTIVE_RELEASE_ROOT"),
  };
  const db = createDb(databaseUrl);
  try {
    const receipt = await provisionVectorInstallation(db, input);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await closeRegisteredClients(databaseUrl);
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry === import.meta.url) {
  runVectorProvisionFromEnvironment().catch(() => {
    // The caller deliberately receives a generic failure. Database clients and
    // service errors may contain connection URLs or environment-specific paths.
    process.stderr.write("Vector provisioning failed\n");
    process.exitCode = 1;
  });
}
