import postgres from "postgres";
import { createHash } from "node:crypto";

// Two stable positive int32 keys make the lock visible and diagnosable in
// pg_locks without coupling ownership to a table in Vector's application DB.
const VECTOR_RUNTIME_LOCK_CLASS_ID = 0x50435052; // "PCPR"
const VECTOR_RUNTIME_LOCK_OBJECT_ID = 0x56454331; // "VEC1"

export class VectorRuntimeOwnershipError extends Error {
  readonly code = "vector_runtime_already_owned";

  constructor() {
    super(
      "The vector-embedded Paperclip runtime is already owned by another server process. " +
        "Another process owns this installation, or a legacy unscoped process owns the shared database.",
    );
    this.name = "VectorRuntimeOwnershipError";
  }
}

export type VectorRuntimeOwnership = {
  /**
   * Resolves if the reserved PostgreSQL session disappears or no longer owns
   * the advisory lock. The server must stop rather than continue scheduling.
   * Graceful release does not resolve this promise.
   */
  lost: Promise<Error>;
  release(): Promise<void>;
};

/**
 * The unscoped call retains the legacy exclusive database-wide gate. A scoped
 * caller must first pass assertVectorRuntimeIsolation, then shares that gate
 * (excluding legacy servers) and exclusively owns its company/installation.
 */
export async function acquireVectorRuntimeOwnership(
  connectionString: string,
  scope?: { companyId: string; installationId: string },
): Promise<VectorRuntimeOwnership> {
  const scopedKey = scope ? createHash("sha256")
    .update(`paperclip-vector-owner-v1\0${scope.companyId}\0${scope.installationId}`)
    .digest().readBigInt64BE().toString() : null;
  let released = false;
  let acquired = false;
  let ownershipLost = false;
  let resolveLost!: (error: Error) => void;
  const lost = new Promise<Error>((resolve) => {
    resolveLost = resolve;
  });
  const reportLost = (cause: unknown) => {
    if (released || !acquired || ownershipLost) return;
    ownershipLost = true;
    const detail = cause instanceof Error ? cause.message : String(cause);
    resolveLost(
      new Error(
        `Lost the vector-embedded Paperclip runtime ownership session; refusing to continue: ${detail}`,
        { cause },
      ),
    );
  };

  const client = postgres(connectionString, {
    max: 1,
    idle_timeout: 0,
    // postgres.js ends every connection after a random 30-60 minutes by
    // default. This one holds the ownership lock for the process's lifetime,
    // so a scheduled end reported the session lost and Paperclip exited
    // (prod1 restarted twice mid-run). Never rotate it.
    max_lifetime: 0,
    onnotice: () => {},
    connection: {
      application_name: "paperclip-vector-runtime-owner",
      search_path: "llm,public",
    },
    onclose: () => reportLost(new Error("the reserved PostgreSQL backend connection closed")),
  });

  let reserved: Awaited<ReturnType<typeof client.reserve>> | null = null;
  try {
    reserved = await client.reserve();
    const rows = scope ? await reserved<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock_shared(
        ${VECTOR_RUNTIME_LOCK_CLASS_ID}, ${VECTOR_RUNTIME_LOCK_OBJECT_ID}
      ) AS acquired
    ` : await reserved<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(
        ${VECTOR_RUNTIME_LOCK_CLASS_ID},
        ${VECTOR_RUNTIME_LOCK_OBJECT_ID}
      ) AS acquired
    `;
    if (rows[0]?.acquired !== true) throw new VectorRuntimeOwnershipError();
    if (scopedKey !== null) {
      const scoped = await reserved<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(${scopedKey}::bigint) AS acquired
      `;
      if (!scoped[0]?.acquired) throw new VectorRuntimeOwnershipError();
    }
    acquired = true;
  } catch (error) {
    reserved?.release();
    await client.end({ timeout: 1 }).catch(() => {});
    throw error;
  }

  return {
    lost,
    release: async () => {
      if (released) return;
      released = true;
      try {
        if (!ownershipLost) {
          // This dedicated reserved backend holds only the gates acquired above.
          await reserved!`SELECT pg_advisory_unlock_all()`;
        }
      } finally {
        reserved!.release();
        reserved = null;
        await client.end({ timeout: 1 }).catch(() => {});
      }
    },
  };
}
