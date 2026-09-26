import fs from "node:fs";
import { sql as drizzleSql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
  assertMigrationsCurrent,
  closeRegisteredClients,
  createDb,
  inspectMigrations,
  transformMigrationSqlForProfile,
} from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("vector-embedded migration rewriting", () => {
  it("leaves standalone SQL byte-for-byte intact and removes every explicit public-schema target", async () => {
    const entries = await fs.promises.readdir(new URL("./migrations", import.meta.url), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
      const source = await fs.promises.readFile(
        new URL(`./migrations/${entry.name}`, import.meta.url),
        "utf8",
      );
      expect(transformMigrationSqlForProfile(source, "standalone")).toBe(source);
      const embedded = transformMigrationSqlForProfile(source, "vector-embedded");
      expect(embedded, entry.name).not.toMatch(/"public"\./);
      expect(embedded, entry.name).not.toMatch(/\bpublic\./);
      expect(embedded, entry.name).not.toContain("'public'");
    }
  });
});

describeEmbeddedPostgres("vector-embedded database profile", () => {
  it(
    "fails closed on drift, migrates only llm, and preserves existing application schemas",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase(
        "paperclip-vector-embedded-profile-",
      );
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(async () => sql.end({ timeout: 1 }));

      // Simulate Vector's existing application database already containing a
      // complete standalone Paperclip schema. Reusing constraint/index names
      // across schemas is valid PostgreSQL and catches migration probes that
      // accidentally inspect every schema instead of only `llm`.
      await applyPendingMigrations(database.connectionString, "standalone");

      await sql.unsafe(`
        CREATE SCHEMA os;
        CREATE SCHEMA llm;
        CREATE TABLE os.vector_profile_guard (id integer PRIMARY KEY, value text NOT NULL);
        INSERT INTO os.vector_profile_guard (id, value) VALUES (1, 'unchanged');
        CREATE TABLE public.vector_profile_guard (id integer PRIMARY KEY, value text NOT NULL);
        INSERT INTO public.vector_profile_guard (id, value) VALUES (1, 'unchanged');
        CREATE TABLE llm.vector_profile_guard (id integer PRIMARY KEY, value text NOT NULL);
        INSERT INTO llm.vector_profile_guard (id, value) VALUES (1, 'unchanged');
      `);
      const outsideBefore = await sql<
        { schema_name: string; relation_name: string; relation_kind: string }[]
      >`
        SELECT
          namespace.nspname AS schema_name,
          relation.relname AS relation_name,
          relation.relkind AS relation_kind
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('os', 'public')
        ORDER BY namespace.nspname, relation.relname, relation.relkind
      `;

      await expect(
        assertMigrationsCurrent(database.connectionString, "vector-embedded"),
      ).rejects.toThrow(/Run the explicit migration command/);
      expect(
        await sql`
          SELECT
            to_regclass('llm.companies')::text AS companies,
            to_regclass('llm.paperclip_migrations')::text AS journal
        `,
      ).toEqual([
        { companies: null, journal: null },
      ]);
      expect(await sql`SELECT * FROM llm.vector_profile_guard`).toEqual([
        { id: 1, value: "unchanged" },
      ]);

      await applyPendingMigrations(database.connectionString, "vector-embedded");
      await expect(
        assertMigrationsCurrent(database.connectionString, "vector-embedded"),
      ).resolves.toBeUndefined();

      const state = await inspectMigrations(database.connectionString, "vector-embedded");
      expect(state.status).toBe("upToDate");
      expect(
        await sql`
          SELECT
            to_regclass('llm.companies')::text AS companies,
            to_regclass('llm.paperclip_migrations')::text AS journal,
            to_regclass('llm.__drizzle_migrations')::text AS legacy_journal
        `,
      ).toEqual([
        {
          companies: "llm.companies",
          journal: "llm.paperclip_migrations",
          legacy_journal: null,
        },
      ]);

      expect(await sql`SELECT * FROM os.vector_profile_guard`).toEqual([
        { id: 1, value: "unchanged" },
      ]);
      expect(await sql`SELECT * FROM public.vector_profile_guard`).toEqual([
        { id: 1, value: "unchanged" },
      ]);
      expect(await sql`SELECT * FROM llm.vector_profile_guard`).toEqual([
        { id: 1, value: "unchanged" },
      ]);
      const outsideAfter = await sql<
        { schema_name: string; relation_name: string; relation_kind: string }[]
      >`
        SELECT
          namespace.nspname AS schema_name,
          relation.relname AS relation_name,
          relation.relkind AS relation_kind
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('os', 'public')
        ORDER BY namespace.nspname, relation.relname, relation.relkind
      `;
      expect(outsideAfter).toEqual(outsideBefore);

      const db = createDb(database.connectionString, {
        deploymentProfile: "vector-embedded",
      });
      const schema = await db.execute<{ current_schema: string }>(
        drizzleSql`SELECT current_schema() AS current_schema`,
      );
      expect(schema).toEqual([{ current_schema: "llm" }]);
      await closeRegisteredClients(database.connectionString);
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
