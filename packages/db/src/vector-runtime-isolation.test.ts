import { randomUUID } from "node:crypto";
import { sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, assertMigrationsCurrent, closeRegisteredClients, createDb, postgresJsOptions } from "./client.js";
import { assertVectorRuntimeIsolation, installVectorRuntimeIsolation, vectorIsolationRelations } from "./vector-runtime-isolation.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const support = await getEmbeddedPostgresTestSupport();
const embedded = support.supported ? describe : describe.skip;

describe("Vector runtime isolation contract", () => {
  it("classifies every table and scopes both global scheduling and auth", () => {
    const tables = vectorIsolationRelations();
    expect(tables.length).toBeGreaterThan(200);
    expect(new Set(tables.map((row) => row.table)).size).toBe(tables.length);
    expect(tables.find((row) => row.table === "plugin_jobs")).toMatchObject({ mode: "parent" });
    expect(tables.find((row) => row.table === "account")).toMatchObject({ mode: "installation" });
    expect(tables.find((row) => row.table === "paperclip_todos")).toMatchObject({ mode: "vector-parent" });
    expect(tables.find((row) => row.table === "vector_ingress_turns")).toMatchObject({ mode: "parent" });
    expect(tables.find((row) => row.table === "vector_installation_ownerships")).toMatchObject({ readOnly: true });
  });

  it("requires an explicit embedded profile and validates context before opening a pool", () => {
    const vectorRuntimeScope = { companyId: randomUUID(), installationId: "funkydev-t480" };
    expect(() => postgresJsOptions({ vectorRuntimeScope })).toThrow(/Invalid/);
    expect(() => postgresJsOptions({ deploymentProfile: "vector-embedded", vectorRuntimeScope: { ...vectorRuntimeScope, installationId: "bad;SQL" } })).toThrow(/Invalid/);
    expect(postgresJsOptions({ deploymentProfile: "vector-embedded", vectorRuntimeScope })).toMatchObject({
      connection: { "paperclip.company_id": vectorRuntimeScope.companyId, "paperclip.installation_id": "funkydev-t480", search_path: "llm,public" },
    });
  });
});

embedded("shared runtime role on real PostgreSQL", () => {
  it("isolates unfiltered concurrent claims, FK edges and restart recovery without touching Vector tables", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-runtime-isolation-");
    cleanups.push(database.cleanup);
    const admin = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(() => admin.end({ timeout: 1 }));
    // The fixture already migrated standalone, including two explicit llm tables.
    await admin.unsafe("ALTER SCHEMA llm RENAME TO prior_standalone_llm");
    await applyPendingMigrations(database.connectionString, "vector-embedded");
    await admin.unsafe("CREATE TABLE llm.vector_existing_data (id integer PRIMARY KEY); INSERT INTO llm.vector_existing_data VALUES (7)");
    const companyA = randomUUID(), companyB = randomUUID();
    const agentA = randomUUID(), agentB = randomUUID();
    await admin`INSERT INTO llm.companies (id, name, issue_prefix) VALUES (${companyA}, 'A', 'A'), (${companyB}, 'B', 'B')`;
    await admin`INSERT INTO llm.vector_installation_ownerships (company_id, installation_id, profile) VALUES
      (${companyA}, 'funkydev-t480', 'engineering'), (${companyB}, 'standard-stecke1', 'standard')`;
    await admin`INSERT INTO llm.agents (id, company_id, name, role) VALUES (${agentA}, ${companyA}, 'A', 'general'), (${agentB}, ${companyB}, 'B', 'general')`;
    const receipt = await installVectorRuntimeIsolation(database.connectionString);
    expect(receipt.scopedTables).toBeGreaterThan(180);
    expect(receipt.quarantinedTables).toEqual([]);
    // Reapplying is transactional/idempotent and never changes existing Vector data.
    expect(await installVectorRuntimeIsolation(database.connectionString)).toEqual(receipt);
    expect(await admin`SELECT * FROM llm.vector_existing_data`).toEqual([{ id: 7 }]);
    expect(await admin`SELECT relrowsecurity FROM pg_class WHERE oid = 'llm.vector_existing_data'::regclass`).toEqual([{ relrowsecurity: false }]);
    // Test-only credentials on the disposable database, not SET ROLE from admin.
    await admin.unsafe("ALTER ROLE paperclip_runtime LOGIN PASSWORD 'test-only-runtime'");
    const runtimeUrl = new URL(database.connectionString);
    runtimeUrl.username = "paperclip_runtime";
    runtimeUrl.password = "test-only-runtime";
    await expect(assertMigrationsCurrent(runtimeUrl.href, "vector-embedded")).resolves.toBeUndefined();
    await expect(assertVectorRuntimeIsolation(database.connectionString, { companyId: companyA, installationId: "funkydev-t480" })).rejects.toThrow(/restricted paperclip_runtime role/);
    await expect(assertVectorRuntimeIsolation(runtimeUrl.href, { companyId: companyA, installationId: "funkydev-t480" })).resolves.toBeUndefined();
    await expect(assertVectorRuntimeIsolation(runtimeUrl.href, { companyId: companyA, installationId: "standard-stecke1" })).rejects.toThrow(/no matching installation/);
    const connect = (companyId: string, installationId: string) => createDb(runtimeUrl.href, {
      deploymentProfile: "vector-embedded", vectorRuntimeScope: { companyId, installationId }, maxConnections: 3,
    });
    cleanups.push(() => closeRegisteredClients(database.connectionString));
    const a = connect(companyA, "funkydev-t480"), b = connect(companyB, "standard-stecke1");
    const pluginA = randomUUID(), pluginB = randomUUID();
    const jobA = randomUUID(), jobB = randomUUID();
    const environmentA = randomUUID(), environmentB = randomUUID();
    // Identical logical names must work on both hosts, not just random UUIDs.
    await a.execute(drizzleSql`INSERT INTO environments (id, name, driver) VALUES (${environmentA}, 'Local', 'local')`);
    await b.execute(drizzleSql`INSERT INTO environments (id, name, driver) VALUES (${environmentB}, 'Local', 'local')`);
    for (const [client, id] of [[a, pluginA], [b, pluginB]] as const) {
      await client.execute(drizzleSql`INSERT INTO plugins (id, plugin_key, package_name, version, manifest_json) VALUES (${id}, 'vector-test', 'vector-test', '1.0.0', '{}')`);
      await client.execute(drizzleSql`INSERT INTO instance_settings (singleton_key) VALUES ('default') ON CONFLICT (vector_installation_id, singleton_key) DO UPDATE SET updated_at = now()`);
    }
    for (const [client, installation] of [[a, "funkydev-t480"], [b, "standard-stecke1"]] as const) {
      await client.execute(drizzleSql`INSERT INTO "user" (id, name, email, created_at, updated_at)
        VALUES (${`local-board:${installation}`}, 'Board', ${`${installation}@paperclip.local`}, now(), now())`);
      await client.execute(drizzleSql`INSERT INTO announcement_publications (announcement_id) VALUES ('same-feed-id')`);
    }
    expect(await a.execute(drizzleSql`SELECT id FROM "user"`)).toEqual([{ id: "local-board:funkydev-t480" }]);
    expect(await b.execute(drizzleSql`SELECT id FROM "user"`)).toEqual([{ id: "local-board:standard-stecke1" }]);
    await expect(a.execute(drizzleSql`INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ('local-board:standard-stecke1', 'bad', 'fixture')`)).rejects.toThrow();
    await a.execute(drizzleSql`INSERT INTO plugin_jobs (id, plugin_id, job_key, schedule) VALUES (${jobA}, ${pluginA}, 'tick', '* * * * *')`);
    await b.execute(drizzleSql`INSERT INTO plugin_jobs (id, plugin_id, job_key, schedule) VALUES (${jobB}, ${pluginB}, 'tick', '* * * * *')`);
    expect(await a.execute(drizzleSql`SELECT id FROM environments`)).toEqual([{ id: environmentA }]);
    expect(await b.execute(drizzleSql`SELECT id FROM environments`)).toEqual([{ id: environmentB }]);
    expect(await a.execute(drizzleSql`SELECT vector_installation_id FROM instance_settings`)).toEqual([{ vector_installation_id: "funkydev-t480" }]);
    expect(await b.execute(drizzleSql`SELECT vector_installation_id FROM instance_settings`)).toEqual([{ vector_installation_id: "standard-stecke1" }]);
    expect(await Promise.all([
      a.execute(drizzleSql`UPDATE plugin_jobs SET last_run_at = now() RETURNING id`),
      b.execute(drizzleSql`UPDATE plugin_jobs SET last_run_at = now() RETURNING id`),
    ])).toEqual([[{ id: jobA }], [{ id: jobB }]]);
    await expect(a.execute(drizzleSql`INSERT INTO plugin_jobs (plugin_id, job_key, schedule) VALUES (${pluginB}, 'bad', '* * * * *')`)).rejects.toThrow();
    await expect(a.execute(drizzleSql`UPDATE instance_settings SET default_environment_id = ${environmentB}`)).rejects.toThrow();
    await a.execute(drizzleSql`INSERT INTO plugin_job_runs (job_id, plugin_id, trigger) VALUES (${jobA}, ${pluginA}, 'scheduled')`);
    expect(await b.execute(drizzleSql`SELECT id FROM plugin_job_runs`)).toEqual([]);
    const runA = randomUUID(), runB = randomUUID();
    const routineA = randomUUID(), routineB = randomUUID();
    await admin`INSERT INTO llm.heartbeat_runs (id, company_id, agent_id) VALUES (${runA}, ${companyA}, ${agentA}), (${runB}, ${companyB}, ${agentB})`;
    await admin`INSERT INTO llm.routines (id, company_id, title, assignee_agent_id) VALUES (${routineA}, ${companyA}, 'A schedule', ${agentA}), (${routineB}, ${companyB}, 'B schedule', ${agentB})`;
    // Deliberately NO application WHERE: PostgreSQL itself owns the filter.
    const claims = await Promise.all([
      a.execute(drizzleSql`UPDATE agents SET status = 'running' RETURNING id`),
      b.execute(drizzleSql`UPDATE agents SET status = 'running' RETURNING id`),
    ]);
    expect(claims).toEqual([[{ id: agentA }], [{ id: agentB }]]);
    expect(await Promise.all([
      a.execute(drizzleSql`UPDATE heartbeat_runs SET status = 'running' WHERE status = 'queued' RETURNING id`),
      b.execute(drizzleSql`UPDATE heartbeat_runs SET status = 'running' WHERE status = 'queued' RETURNING id`),
    ])).toEqual([[{ id: runA }], [{ id: runB }]]);
    expect(await a.execute(drizzleSql`SELECT id FROM routines WHERE status = 'active'`)).toEqual([{ id: routineA }]);
    expect(await b.execute(drizzleSql`SELECT id FROM routines WHERE status = 'active'`)).toEqual([{ id: routineB }]);
    await expect(a.execute(drizzleSql`INSERT INTO agents (company_id, name, role) VALUES (${companyB}, 'bad', 'general')`)).rejects.toThrow();
    // FK enforcement alone bypasses RLS; policy WITH CHECK must reject this.
    await expect(a.execute(drizzleSql`INSERT INTO agents (company_id, name, role, reports_to) VALUES (${companyA}, 'bad-edge', 'general', ${agentB})`)).rejects.toThrow();
    await expect(a.execute(drizzleSql`UPDATE agents SET company_id = ${companyB}`)).rejects.toThrow();
    expect(await a.execute(drizzleSql`DELETE FROM agents WHERE id = ${agentB} RETURNING id`)).toEqual([]);
    expect(await a.execute(drizzleSql`SELECT * FROM account`)).toEqual([]);
    // Existing permissive policies must not OR their way around our gate.
    await admin.unsafe("CREATE POLICY test_permissive ON llm.agents TO paperclip_runtime USING (true) WITH CHECK (true)");
    expect(await a.execute(drizzleSql`SELECT id FROM agents`)).toEqual([{ id: agentA }]);
    await expect(a.execute(drizzleSql`SELECT * FROM llm.vector_existing_data`)).rejects.toThrow();
    await expect(a.execute(drizzleSql`TRUNCATE agents`)).rejects.toThrow();
    await expect(a.execute(drizzleSql`ALTER TABLE agents DISABLE ROW LEVEL SECURITY`)).rejects.toThrow();
    await expect(a.execute(drizzleSql`UPDATE vector_installation_ownerships SET installation_id = 'stolen'`)).rejects.toThrow();
    const unset = createDb(runtimeUrl.href, { deploymentProfile: "vector-embedded" });
    expect(await unset.execute(drizzleSql`SELECT id FROM agents`)).toEqual([]);
    const wrongBinding = connect(companyA, "standard-stecke1");
    expect(await wrongBinding.execute(drizzleSql`SELECT id FROM agents`)).toEqual([]);
    // New physical connections retain context without request-local SET leakage.
    await closeRegisteredClients(database.connectionString);
    const restarted = connect(companyB, "standard-stecke1");
    expect(await restarted.execute(drizzleSql`UPDATE agents SET status = 'idle' WHERE status = 'running' RETURNING id`)).toEqual([{ id: agentB }]);
    expect(await restarted.execute(drizzleSql`UPDATE heartbeat_runs SET status = 'failed' WHERE status = 'running' RETURNING id`)).toEqual([{ id: runB }]);
    expect(await admin`SELECT status FROM llm.heartbeat_runs WHERE id = ${runA}`).toEqual([{ status: "running" }]);
    expect(await admin`SELECT status FROM llm.agents WHERE id = ${agentA}`).toEqual([{ status: "running" }]);
    expect(await admin`SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = 'paperclip_runtime'`).toEqual([
      { rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreaterole: false },
    ]);
    await admin.unsafe("ALTER TABLE llm.plugin_jobs DISABLE TRIGGER paperclip_vector_foreign_refs");
    await expect(assertVectorRuntimeIsolation(runtimeUrl.href, { companyId: companyA, installationId: "funkydev-t480" })).rejects.toThrow(/foreign-reference guard/);
    await admin.unsafe("ALTER TABLE llm.plugin_jobs ENABLE TRIGGER paperclip_vector_foreign_refs");
    await admin.unsafe("ALTER POLICY paperclip_vector_runtime_v1_gate ON llm.agents USING (true)");
    await expect(assertVectorRuntimeIsolation(runtimeUrl.href, { companyId: companyA, installationId: "funkydev-t480" })).rejects.toThrow(/isolation policy/);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("refuses to absorb an existing privileged role or inherited public table grants", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-runtime-role-audit-");
    cleanups.push(database.cleanup);
    const admin = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(() => admin.end({ timeout: 1 }));
    await admin.unsafe("ALTER SCHEMA llm RENAME TO prior_standalone_llm");
    await applyPendingMigrations(database.connectionString, "vector-embedded");
    await admin.unsafe("CREATE ROLE paperclip_runtime NOLOGIN BYPASSRLS");
    await expect(installVectorRuntimeIsolation(database.connectionString)).rejects.toThrow(/elevated privileges/);
    expect(await admin`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'paperclip_runtime'`).toEqual([{ rolbypassrls: true }]);
    await admin.unsafe("ALTER ROLE paperclip_runtime NOBYPASSRLS");
    await admin.unsafe("CREATE TABLE llm.vector_private (id integer); GRANT SELECT ON llm.vector_private TO PUBLIC");
    await expect(installVectorRuntimeIsolation(database.connectionString)).rejects.toThrow(/outside its managed relations/);
    expect(await admin`SELECT relrowsecurity FROM pg_class WHERE oid = 'llm.agents'::regclass`).toEqual([{ relrowsecurity: false }]);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
