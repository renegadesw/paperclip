import postgres from "postgres";

// Two stable positive int32 keys make the lock visible and diagnosable in
// pg_locks without coupling ownership to a table in Vector's application DB.
const VECTOR_RUNTIME_LOCK_CLASS_ID = 0x50435052; // "PCPR"
const VECTOR_RUNTIME_LOCK_OBJECT_ID = 0x56454331; // "VEC1"

export class VectorRuntimeOwnershipError extends Error {
  readonly code = "vector_runtime_already_owned";

  constructor() {
    super(
      "The vector-embedded Paperclip runtime is already owned by another server process. " +
        "Only one Paperclip process may use this shared Vector database until installation-scoped scheduling is implemented.",
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
 * Holds the temporary vector-embedded singleton gate on one reserved backend.
 *
 * This is intentionally not multi-install ownership. It prevents two server
 * processes sharing Vector's `llm` schema from claiming each other's work
 * until installation identity is carried through scheduling, claiming, and
 * recovery queries.
 */
export async function acquireVectorRuntimeOwnership(
  connectionString: string,
): Promise<VectorRuntimeOwnership> {
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
    const rows = await reserved<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(
        ${VECTOR_RUNTIME_LOCK_CLASS_ID},
        ${VECTOR_RUNTIME_LOCK_OBJECT_ID}
      ) AS acquired
    `;
    if (rows[0]?.acquired !== true) throw new VectorRuntimeOwnershipError();
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
          await reserved!`
            SELECT pg_advisory_unlock(
              ${VECTOR_RUNTIME_LOCK_CLASS_ID},
              ${VECTOR_RUNTIME_LOCK_OBJECT_ID}
            )
          `;
        }
      } finally {
        reserved!.release();
        reserved = null;
        await client.end({ timeout: 1 }).catch(() => {});
      }
    },
  };
}
