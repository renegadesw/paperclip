import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";
import {
  acquireVectorRuntimeOwnership,
  VectorRuntimeOwnershipError,
} from "./vector-runtime-ownership.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("vector-embedded runtime ownership", () => {
  it("allows distinct installations, excludes duplicate owners and fences legacy servers in both directions", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-scoped-owners-");
    cleanups.push(database.cleanup);
    const a = { companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", installationId: "funkydev-t480" };
    const b = { companyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", installationId: "standard-stecke1" };
    const first = await acquireVectorRuntimeOwnership(database.connectionString, a);
    cleanups.push(() => first.release());
    const second = await acquireVectorRuntimeOwnership(database.connectionString, b);
    cleanups.push(() => second.release());
    await expect(acquireVectorRuntimeOwnership(database.connectionString, a)).rejects.toBeInstanceOf(VectorRuntimeOwnershipError);
    await expect(acquireVectorRuntimeOwnership(database.connectionString)).rejects.toBeInstanceOf(VectorRuntimeOwnershipError);
    await first.release();
    await second.release();
    const legacy = await acquireVectorRuntimeOwnership(database.connectionString);
    cleanups.push(() => legacy.release());
    await expect(acquireVectorRuntimeOwnership(database.connectionString, b)).rejects.toBeInstanceOf(VectorRuntimeOwnershipError);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it(
    "allows the first owner and clearly rejects a second server process",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-vector-owner-");
      cleanups.push(database.cleanup);
      const owner = await acquireVectorRuntimeOwnership(database.connectionString);
      cleanups.push(() => owner.release());

      const secondAttempt = acquireVectorRuntimeOwnership(database.connectionString);
      await expect(secondAttempt).rejects.toBeInstanceOf(VectorRuntimeOwnershipError);
      await expect(secondAttempt).rejects.toMatchObject({
        code: "vector_runtime_already_owned",
      });
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "releases ownership cleanly so a replacement process can acquire it",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-vector-reacquire-");
      cleanups.push(database.cleanup);
      const first = await acquireVectorRuntimeOwnership(database.connectionString);
      await first.release();

      const replacement = await acquireVectorRuntimeOwnership(database.connectionString);
      cleanups.push(() => replacement.release());
      await expect(replacement.release()).resolves.toBeUndefined();
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "reports ownership loss when PostgreSQL drops the reserved backend and permits reacquisition",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-vector-owner-loss-");
      cleanups.push(database.cleanup);
      const owner = await acquireVectorRuntimeOwnership(database.connectionString);
      const control = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(async () => control.end({ timeout: 1 }));

      const sessions = await control<{ pid: number }[]>`
        SELECT pid
        FROM pg_stat_activity
        WHERE application_name = 'paperclip-vector-runtime-owner'
          AND pid <> pg_backend_pid()
      `;
      expect(sessions).toHaveLength(1);
      await control`SELECT pg_terminate_backend(${sessions[0]!.pid})`;

      const loss = await Promise.race([
        owner.lost,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("ownership loss was not detected")), 5_000),
        ),
      ]);
      expect(loss.message).toMatch(/Lost the vector-embedded Paperclip runtime ownership session/);
      await owner.release().catch(() => {});

      const replacement = await acquireVectorRuntimeOwnership(database.connectionString);
      cleanups.push(() => replacement.release());
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it("fails closed when the ownership database cannot be reached", async () => {
    await expect(
      acquireVectorRuntimeOwnership("postgres://paperclip:paperclip@127.0.0.1:1/paperclip"),
    ).rejects.toBeInstanceOf(Error);
  });
});
