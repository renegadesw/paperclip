import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface VectorToolCapabilityInput {
  callbackUrl: string;
  bearerToken: string;
  tools: readonly string[];
}

export interface PreparedVectorToolCapability {
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

export async function prepareVectorToolCapability(
  input: VectorToolCapabilityInput | undefined,
  options: { remote: boolean; tempRoot?: string } = { remote: false },
): Promise<PreparedVectorToolCapability> {
  if (!input) return { env: {}, cleanup: async () => undefined };
  if (options.remote) {
    throw new Error(
      "Vector tool authority requires a local Pi execution target with private capability-file delivery",
    );
  }

  const root = await fs.mkdtemp(
    path.join(options.tempRoot ?? os.tmpdir(), "paperclip-vector-tool-"),
  );
  await fs.chmod(root, 0o700);
  const capabilityPath = path.join(root, "authority.json");
  try {
    await fs.writeFile(
      capabilityPath,
      JSON.stringify({
        version: 1,
        callbackUrl: input.callbackUrl,
        bearerToken: input.bearerToken,
        tools: [...input.tools],
      }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await fs.chmod(capabilityPath, 0o600);
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }

  return {
    env: { PAPERCLIP_VECTOR_TOOL_AUTHORITY_FILE: capabilityPath },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
