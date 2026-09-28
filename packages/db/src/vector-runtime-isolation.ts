import { is, Table } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema/index.js";
import { postgresJsOptions } from "./client.js";

export const VECTOR_RUNTIME_DATABASE_ROLE = "paperclip_runtime";
const POLICY = "paperclip_vector_runtime_v1";
const COMPANY = "NULLIF(current_setting('paperclip.company_id', true), '')::uuid";
const INSTALLATION = "NULLIF(current_setting('paperclip.installation_id', true), '')";

function policyFingerprint(relation: VectorIsolationRelation): string {
  return createHash("sha256").update(JSON.stringify(relation)).digest("hex");
}

// These are owned by Vector OS, not the Paperclip child process. Do not change
// their policies or grant the child access to their owner-scoped contents.
const PARENT_OWNED = new Set(["paperclip_questions", "paperclip_todos"]);

// No new unscoped table is automatically admitted. Keep this list explicit if
// an upstream addition needs temporary quarantine before a scoped port.
const QUARANTINED = new Set<string>();

const PARENT_SCOPE: Record<string, [string, string]> = {
  company_secret_versions: ["secret_id", "company_secrets"],
  decision_effect_executions: ["decision_id", "decisions"],
  pipeline_stages: ["pipeline_id", "pipelines"],
  pipeline_transitions: ["pipeline_id", "pipelines"],
  status_card_updates: ["card_id", "status_cards"],
  vector_ingress_turns: ["conversation_id", "vector_ingress_conversations"],
  environment_custom_image_setup_sessions: ["environment_id", "environments"],
  environment_custom_image_templates: ["environment_id", "environments"],
  plugin_database_namespaces: ["plugin_id", "plugins"],
  plugin_jobs: ["plugin_id", "plugins"],
  plugin_migrations: ["plugin_id", "plugins"],
  plugin_state: ["plugin_id", "plugins"],
};

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("Unsafe isolation SQL identifier");
  return `"${value}"`;
}

export interface VectorIsolationRelation {
  table: string;
  mode: "company" | "installation" | "parent" | "quarantined" | "vector-parent";
  using: string;
  check: string;
  foreignKeyCheck?: string;
  readOnly: boolean;
}

/** Catalog columns both the installer and the startup gate compare. */
interface RelationCatalogRow {
  relrowsecurity: boolean;
  owned: boolean;
  polpermissive: boolean | null;
  polcmd: string | null;
  applies: boolean | null;
  fingerprint: string | null;
  digest: string | null;
  tgenabled: string | null;
  tgtype: number | null;
  trigger_args: string | null;
  trigger_function: boolean | null;
}

function expectsForeignRefGuard(relation: VectorIsolationRelation): relation is VectorIsolationRelation & { foreignKeyCheck: string } {
  return Boolean(relation.foreignKeyCheck) && !relation.readOnly && relation.mode !== "quarantined";
}

function gateIsCurrent(relation: VectorIsolationRelation, row: RelationCatalogRow): boolean {
  return row.relrowsecurity && !row.owned && row.polpermissive === false && row.polcmd === "*" && row.applies === true &&
    row.fingerprint === `${policyFingerprint(relation)}:${row.digest}`;
}

function foreignRefGuardIsCurrent(relation: VectorIsolationRelation, row: RelationCatalogRow): boolean {
  if (!expectsForeignRefGuard(relation)) return true;
  return row.tgenabled === "O" && row.tgtype === 23 && row.trigger_function === true &&
    row.trigger_args === Buffer.from(relation.foreignKeyCheck + "\0").toString("hex");
}

function runtimePrivileges(relation: VectorIsolationRelation): string[] {
  if (relation.readOnly || relation.mode === "quarantined") return ["SELECT"];
  if (relation.table === "companies") return ["SELECT", "UPDATE"];
  return ["DELETE", "INSERT", "SELECT", "UPDATE"];
}

const GUARD_FUNCTION_BODY = `
        DECLARE allowed boolean;
        BEGIN
          IF current_user <> 'paperclip_runtime' THEN RETURN NEW; END IF;
          EXECUTE 'SELECT ' || TG_ARGV[0] INTO allowed USING to_jsonb(NEW);
          IF allowed IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'Vector runtime foreign reference is outside installation scope' USING ERRCODE = '42501';
          END IF;
          RETURN NEW;
        END `;

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/** Every exported relation must be classified; a new unscoped table fails closed. */
export function vectorIsolationRelations(): VectorIsolationRelation[] {
  const exports: unknown[] = Object.values(schema);
  const tables = exports.filter((value): value is PgTable => is(value, Table));
  const result = tables.map((table): VectorIsolationRelation => {
    const config = getTableConfig(table);
    const name = config.name;
    if (PARENT_OWNED.has(name)) {
      return { table: name, mode: "vector-parent", using: "false", check: "false", readOnly: true };
    }
    let mode: VectorIsolationRelation["mode"] = "company";
    let predicate: string;
    if (name === "companies") predicate = `id = ${COMPANY}`;
    else if (name === "vector_installation_ownerships") {
      predicate = `company_id = ${COMPANY} AND installation_id = ${INSTALLATION}`;
    } else if (config.columns.some((column) => column.name === "vector_installation_id")) {
      mode = "installation";
      predicate = `vector_installation_id = ${INSTALLATION}`;
    } else if (["plugin_entities", "plugin_job_runs", "plugin_logs", "plugin_webhook_deliveries"].includes(name)) {
      predicate = `(company_id = ${COMPANY} OR company_id IS NULL) AND EXISTS (SELECT 1 FROM llm.plugins AS owner WHERE owner.id = ${identifier(name)}.plugin_id)`;
    } else if (config.columns.some((column) => column.name === "company_id")) {
      // NULL company is deliberately not a wildcard (e.g. instance plugin runs).
      predicate = `company_id = ${COMPANY}`;
    } else if (name === "cli_auth_challenges") {
      predicate = `requested_company_id = ${COMPANY}`;
    } else if (PARENT_SCOPE[name]) {
      const [column, parent] = PARENT_SCOPE[name]!;
      mode = "parent";
      predicate = `EXISTS (SELECT 1 FROM llm.${identifier(parent)} AS owner WHERE owner.id = ${identifier(name)}.${identifier(column)})`;
    } else if (QUARANTINED.has(name)) {
      mode = "quarantined";
      predicate = "false";
    } else {
      throw new Error(`Unclassified Vector runtime relation: ${name}`);
    }
    if (name !== "vector_installation_ownerships" && mode !== "quarantined") {
      predicate = `(${predicate}) AND EXISTS (SELECT 1 FROM llm.vector_installation_ownerships AS binding WHERE binding.company_id = ${COMPANY} AND binding.installation_id = ${INSTALLATION})`;
    }
    // PostgreSQL FK checks bypass RLS. A foreign UUID must not let one company
    // create an edge to another company's row (or mutate it via a later cascade).
    const references = config.foreignKeys.map((key) => {
      const ref = key.reference();
      const parent = getTableConfig(ref.foreignTable).name;
      const nulls = ref.columns.map((column) => `${identifier(name)}.${identifier(column.name)} IS NULL`).join(" OR ");
      const joins = ref.columns.map((column, index) =>
        `related.${identifier(ref.foreignColumns[index]!.name)} = ${identifier(name)}.${identifier(column.name)}`,
      ).join(" AND ");
      return `((${nulls}) OR EXISTS (SELECT 1 FROM llm.${identifier(parent)} AS related WHERE ${joins}))`;
    });
    return {
      table: name, mode, using: predicate,
      check: predicate,
      foreignKeyCheck: references.length ? references.map((part) => `(${part})`).join(" AND ")
        .replaceAll(`${identifier(name)}.`, `(jsonb_populate_record(NULL::llm.${identifier(name)}, $1)).`) : undefined,
      readOnly: name === "vector_installation_ownerships",
    };
  });
  return result.sort((a, b) => a.table.localeCompare(b.table));
}

/**
 * Explicit privileged installation step, never run by server startup. Creates
 * ONE shared role without a password/login; credential enrollment is separate.
 * Does not grant on ALL TABLES/ALL FUNCTIONS or change Vector's own relations.
 * Runtime isolation is protection against accidental unscoped application
 * queries, not against a trusted host deliberately changing its session GUCs.
 */
export async function installVectorRuntimeIsolation(
  connectionString: string,
  options: { lockTimeoutMs?: number } = {},
): Promise<{
  scopedTables: number; quarantinedTables: string[]; parentOwnedTables: string[];
}> {
  const relations = vectorIsolationRelations();
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw new Error("Vector runtime isolation lock timeout is invalid");
  const db = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    await db.begin(async (tx) => {
      // pg_get_expr/functiondef must deparse with a stable search_path when
      // installation and startup compute their independent policy fingerprints.
      await tx`SELECT set_config('search_path', 'pg_catalog', true)`;
      await tx`SELECT pg_advisory_xact_lock(1346588754, 1380733745)`;
      // Live Paperclip servers share this database. A relation that still needs
      // DDL must fail fast rather than queue behind (or deadlock with) them.
      await tx`SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`;
      const roles = await tx`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
        FROM pg_roles WHERE rolname = ${VECTOR_RUNTIME_DATABASE_ROLE}`;
      if (roles.length === 0) {
        await tx.unsafe(`CREATE ROLE ${VECTOR_RUNTIME_DATABASE_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`);
      } else if (Object.values(roles[0]!).some(Boolean)) {
        throw new Error("Existing paperclip_runtime role has elevated privileges; refusing to alter it");
      }
      const memberships = await tx`SELECT 1 FROM pg_auth_members
        WHERE member = (SELECT oid FROM pg_roles WHERE rolname = ${VECTOR_RUNTIME_DATABASE_ROLE})`;
      if (memberships.length) throw new Error("paperclip_runtime must not be a member of another role");
      const elevatedSchema = await tx`SELECT 1 WHERE
        has_schema_privilege(${VECTOR_RUNTIME_DATABASE_ROLE}, 'llm', 'CREATE') OR
        has_database_privilege(${VECTOR_RUNTIME_DATABASE_ROLE}, current_database(), 'CREATE')`;
      if (elevatedSchema.length) throw new Error("paperclip_runtime must not have schema/database creation authority");
      const permitted = [...relations.filter((row) => row.mode !== "vector-parent").map((row) => row.table), "paperclip_migrations"];
      const outsideGrants = await tx`SELECT n.nspname, c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (n.nspname = 'llm' OR has_schema_privilege(${VECTOR_RUNTIME_DATABASE_ROLE}, n.oid, 'USAGE'))
          AND NOT (n.nspname = 'llm' AND c.relname = ANY(${permitted}))
          AND has_table_privilege(${VECTOR_RUNTIME_DATABASE_ROLE}, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`;
      if (outsideGrants.length) throw new Error("paperclip_runtime has access outside its managed relations (possibly through PUBLIC)");
      const definers = await tx`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
          AND (n.nspname = 'llm' OR has_schema_privilege(${VECTOR_RUNTIME_DATABASE_ROLE}, n.oid, 'USAGE'))
          AND p.prosecdef AND has_function_privilege(${VECTOR_RUNTIME_DATABASE_ROLE}, p.oid, 'EXECUTE') LIMIT 1`;
      if (definers.length) throw new Error("paperclip_runtime can execute an application SECURITY DEFINER function; review its grants first");
      const [schemaUsage] = await tx`SELECT has_schema_privilege(${VECTOR_RUNTIME_DATABASE_ROLE}, 'llm', 'USAGE') AS held`;
      if (!schemaUsage!.held) await tx.unsafe(`GRANT USAGE ON SCHEMA llm TO ${VECTOR_RUNTIME_DATABASE_ROLE}`);
      // A SECURITY INVOKER trigger performs the SELECT under the runtime role.
      // Putting FK/self-reference lookups in WITH CHECK causes PostgreSQL's
      // policy rewriter to recurse for agents.reports_to and similar cycles.
      const [currentGuard] = await tx`SELECT p.prosrc = ${GUARD_FUNCTION_BODY} AND NOT p.prosecdef
          AND p.proconfig = ARRAY['search_path=pg_catalog']
          AND p.proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) AS acl WHERE acl.grantee = 0)
          AND obj_description(p.oid, 'pg_proc') = md5(pg_get_functiondef(p.oid)) AS current
        FROM pg_proc p WHERE p.oid = to_regprocedure('llm.paperclip_vector_check_foreign_refs()')`;
      if (!currentGuard?.current) {
        await tx.unsafe(`CREATE OR REPLACE FUNCTION llm.paperclip_vector_check_foreign_refs()
        RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $body$${GUARD_FUNCTION_BODY}$body$`);
        await tx.unsafe(`REVOKE ALL ON FUNCTION llm.paperclip_vector_check_foreign_refs() FROM PUBLIC`);
        const [guard] = await tx`SELECT md5(pg_get_functiondef('llm.paperclip_vector_check_foreign_refs()'::regprocedure)) AS digest`;
        await tx.unsafe(`COMMENT ON FUNCTION llm.paperclip_vector_check_foreign_refs() IS '${guard!.digest}'`);
      }
      // Catalog reads take no relation locks, so a converged install touches
      // no table that a live server is using.
      const catalog = await tx`SELECT c.relname, c.relrowsecurity, c.relowner = r.oid AS owned,
          gate.polpermissive, gate.polcmd, gate.polroles = ARRAY[r.oid] AS applies,
          obj_description(gate.oid, 'pg_policy') AS fingerprint,
          md5(pg_get_expr(gate.polqual, gate.polrelid) || '|' || pg_get_expr(gate.polwithcheck, gate.polrelid)) AS digest,
          base.polpermissive AS base_permissive, base.polcmd AS base_cmd, base.polroles = ARRAY[r.oid] AS base_applies,
          pg_get_expr(base.polqual, base.polrelid) AS base_using, pg_get_expr(base.polwithcheck, base.polrelid) AS base_check,
          t.oid IS NOT NULL AS has_trigger, t.tgenabled, t.tgtype, encode(t.tgargs, 'hex') AS trigger_args,
          t.tgfoid = to_regprocedure('llm.paperclip_vector_check_foreign_refs()') AS trigger_function,
          ARRAY(SELECT DISTINCT acl.privilege_type FROM aclexplode(c.relacl) AS acl
            WHERE acl.grantee = r.oid ORDER BY acl.privilege_type) AS privileges
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN pg_roles r
        LEFT JOIN pg_policy gate ON gate.polrelid = c.oid AND gate.polname = ${POLICY + "_gate"}
        LEFT JOIN pg_policy base ON base.polrelid = c.oid AND base.polname = ${POLICY}
        LEFT JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgname = 'paperclip_vector_foreign_refs'
        WHERE n.nspname = 'llm' AND c.relkind IN ('r', 'p') AND r.rolname = ${VECTOR_RUNTIME_DATABASE_ROLE}`;
      const byName = new Map(catalog.map((row) => [row.relname as string, row]));
      for (const relation of relations) {
        if (relation.mode === "vector-parent") continue;
        const target = `llm.${identifier(relation.table)}`;
        const row = byName.get(relation.table);
        if (!row || row.owned) {
          throw new Error(`Missing relation or unsafe runtime owner: ${relation.table}`);
        }
        const state = row as unknown as RelationCatalogRow & {
          base_permissive: boolean | null; base_cmd: string | null; base_applies: boolean | null;
          base_using: string | null; base_check: string | null; has_trigger: boolean; privileges: string[];
        };
        if (
          gateIsCurrent(relation, state) && foreignRefGuardIsCurrent(relation, state) &&
          (expectsForeignRefGuard(relation) || !state.has_trigger) &&
          state.base_permissive === true && state.base_cmd === "*" && state.base_applies === true &&
          state.base_using === "true" && state.base_check === "true" &&
          state.privileges.join(",") === runtimePrivileges(relation).join(",")
        ) continue;
        try {
          await tx.unsafe(`ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY`);
          // Restrictive gate cannot be widened by an existing permissive policy.
          await tx.unsafe(`DROP POLICY IF EXISTS ${POLICY} ON ${target}`);
          await tx.unsafe(`DROP POLICY IF EXISTS ${POLICY}_gate ON ${target}`);
          await tx.unsafe(`CREATE POLICY ${POLICY} ON ${target} TO ${VECTOR_RUNTIME_DATABASE_ROLE} USING (true) WITH CHECK (true)`);
          await tx.unsafe(`CREATE POLICY ${POLICY}_gate ON ${target} AS RESTRICTIVE TO ${VECTOR_RUNTIME_DATABASE_ROLE} USING (${relation.using}) WITH CHECK (${relation.check})`);
          const [policy] = await tx`SELECT md5(pg_get_expr(polqual, polrelid) || '|' || pg_get_expr(polwithcheck, polrelid)) AS digest
            FROM pg_policy WHERE polrelid = ${target}::regclass AND polname = ${POLICY + "_gate"}`;
          await tx.unsafe(`COMMENT ON POLICY ${POLICY}_gate ON ${target} IS '${policyFingerprint(relation)}:${policy!.digest}'`);
          await tx.unsafe(`DROP TRIGGER IF EXISTS paperclip_vector_foreign_refs ON ${target}`);
          if (expectsForeignRefGuard(relation)) {
            const argument = relation.foreignKeyCheck.replaceAll("'", "''");
            await tx.unsafe(`CREATE TRIGGER paperclip_vector_foreign_refs BEFORE INSERT OR UPDATE ON ${target}
              FOR EACH ROW EXECUTE FUNCTION llm.paperclip_vector_check_foreign_refs('${argument}')`);
          }
          await tx.unsafe(`REVOKE ALL ON ${target} FROM ${VECTOR_RUNTIME_DATABASE_ROLE}`);
          await tx.unsafe(`GRANT ${runtimePrivileges(relation).join(", ")} ON ${target} TO ${VECTOR_RUNTIME_DATABASE_ROLE}`);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === "55P03" || code === "40P01") {
            throw new Error(
              `Vector runtime isolation ${code === "55P03" ? `lock timeout (${lockTimeoutMs}ms)` : "deadlock"} on relation ${target}: ` +
              "a live Paperclip server holds a conflicting lock; stop the servers using this database and retry",
              { cause: error },
            );
          }
          throw error;
        }
      }
      const [held] = await tx`SELECT
          has_table_privilege(${VECTOR_RUNTIME_DATABASE_ROLE}, 'llm.paperclip_migrations', 'SELECT') AS migrations,
          has_sequence_privilege(${VECTOR_RUNTIME_DATABASE_ROLE}, 'llm.chat_telegram_draft_ids', 'USAGE') AS sequence`;
      if (!held!.migrations) await tx.unsafe(`GRANT SELECT ON llm.paperclip_migrations TO ${VECTOR_RUNTIME_DATABASE_ROLE}`);
      // A monotonic transport identifier, not a scheduler or company-data table.
      if (!held!.sequence) await tx.unsafe(`GRANT USAGE ON SEQUENCE llm.chat_telegram_draft_ids TO ${VECTOR_RUNTIME_DATABASE_ROLE}`);
      // serial/bigserial defaults call nextval() under the caller, so a table the
      // runtime may INSERT into needs USAGE on its owned sequence (identity
      // columns are exempt). USAGE is nextval/currval only, never setval.
      // MATERIALIZED keeps the privilege checks off non-sequence relations.
      const sequences = await tx`WITH owned AS MATERIALIZED (
          SELECT s.oid, s.relname, d.refobjid FROM pg_class s
          JOIN pg_namespace n ON n.oid = s.relnamespace
          JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid AND d.deptype = 'a'
          WHERE n.nspname = 'llm' AND s.relkind = 'S')
        SELECT relname FROM owned
        WHERE has_table_privilege(${VECTOR_RUNTIME_DATABASE_ROLE}, refobjid, 'INSERT')
          AND NOT has_sequence_privilege(${VECTOR_RUNTIME_DATABASE_ROLE}, oid, 'USAGE')`;
      for (const sequence of sequences) {
        await tx.unsafe(`GRANT USAGE ON SEQUENCE llm.${identifier(sequence.relname as string)} TO ${VECTOR_RUNTIME_DATABASE_ROLE}`);
      }
    });
    return {
      scopedTables: relations.filter((row) => !["quarantined", "vector-parent"].includes(row.mode)).length,
      quarantinedTables: relations.filter((row) => row.mode === "quarantined").map((row) => row.table),
      parentOwnedTables: relations.filter((row) => row.mode === "vector-parent").map((row) => row.table),
    };
  } finally {
    await db.end({ timeout: 1 });
  }
}

/** Read-only startup gate. A privileged/owner connection must never be accepted. */
export async function assertVectorRuntimeIsolation(
  connectionString: string,
  scope: { companyId: string; installationId: string },
): Promise<void> {
  const relations = vectorIsolationRelations();
  if (relations.some((row) => row.mode === "quarantined")) {
    throw new Error("Vector runtime isolation has unported global relations");
  }
  const db = postgres(connectionString, {
    ...postgresJsOptions({ deploymentProfile: "vector-embedded", vectorRuntimeScope: scope }),
    max: 1, onnotice: () => {},
  });
  try {
    await db`SET search_path TO pg_catalog`;
    const [role] = await db`SELECT current_user, session_user, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
      FROM pg_roles WHERE rolname = current_user`;
    if (!role || role.current_user !== VECTOR_RUNTIME_DATABASE_ROLE || role.session_user !== VECTOR_RUNTIME_DATABASE_ROLE ||
        role.rolsuper || role.rolbypassrls || role.rolcreaterole || role.rolcreatedb || role.rolreplication) {
      throw new Error("Vector runtime requires direct authentication as the restricted paperclip_runtime role");
    }
    const memberships = await db`SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`;
    if (memberships.length) throw new Error("Vector runtime role must not inherit or SET ROLE to another role");
    const tables = await db`SELECT c.relname, c.relrowsecurity, c.relowner = r.oid AS owned,
        p.polpermissive, p.polcmd, p.polroles @> ARRAY[r.oid] AS applies,
        obj_description(p.oid, 'pg_policy') AS fingerprint,
        md5(pg_get_expr(p.polqual, p.polrelid) || '|' || pg_get_expr(p.polwithcheck, p.polrelid)) AS digest,
        t.tgenabled, t.tgtype, encode(t.tgargs, 'hex') AS trigger_args,
        t.tgfoid = to_regprocedure('llm.paperclip_vector_check_foreign_refs()') AS trigger_function,
        has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE') AS can_write,
        has_table_privilege(c.oid, 'INSERT,DELETE') AS can_create_delete,
        has_table_privilege(c.oid, 'TRUNCATE') OR has_table_privilege(c.oid, 'TRIGGER') AS dangerous_grant
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN pg_roles r
      LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = ${POLICY + "_gate"}
      LEFT JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgname = 'paperclip_vector_foreign_refs'
      WHERE n.nspname = 'llm' AND c.relkind IN ('r', 'p') AND r.rolname = current_user`;
    const byName = new Map(tables.map((row) => [row.relname, row]));
    for (const relation of relations) {
      if (relation.mode === "vector-parent") continue;
      const row = byName.get(relation.table);
      if (!row || row.dangerous_grant || !gateIsCurrent(relation, row as unknown as RelationCatalogRow)) {
        throw new Error(`Vector runtime isolation policy is missing or unsafe: ${relation.table}`);
      }
      if ((relation.readOnly && row.can_write) || (relation.table === "companies" && row.can_create_delete)) {
        throw new Error(`Vector runtime control-plane relation is overprivileged: ${relation.table}`);
      }
      if (!foreignRefGuardIsCurrent(relation, row as unknown as RelationCatalogRow)) {
        throw new Error(`Vector runtime foreign-reference guard is missing or unsafe: ${relation.table}`);
      }
    }
    const [guard] = await db`SELECT NOT prosecdef AND obj_description(oid, 'pg_proc') = md5(pg_get_functiondef(oid)) AS valid
      FROM pg_proc WHERE oid = to_regprocedure('llm.paperclip_vector_check_foreign_refs()')`;
    if (!guard?.valid) throw new Error("Vector runtime foreign-reference function is missing or changed");
    const binding = await db`SELECT 1 FROM llm.vector_installation_ownerships
      WHERE company_id = ${scope.companyId} AND installation_id = ${scope.installationId}`;
    if (binding.length !== 1) throw new Error("Vector runtime database scope has no matching installation ownership");
    const unsafeSchema = await db`SELECT 1 WHERE has_schema_privilege('llm', 'CREATE')
      OR has_database_privilege(current_database(), 'CREATE')`;
    if (unsafeSchema.length) throw new Error("Vector runtime role has schema/database creation authority");
    const permitted = [...relations.filter((row) => row.mode !== "vector-parent").map((row) => row.table), "paperclip_migrations"];
    const outside = await db`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_schema_privilege(n.oid, 'USAGE')
        AND NOT (n.nspname = 'llm' AND c.relname = ANY(${permitted}))
        AND has_table_privilege(c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') LIMIT 1`;
    if (outside.length) throw new Error("Vector runtime role has access outside managed relations");
    const definers = await db`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
        AND has_schema_privilege(n.oid, 'USAGE') AND p.prosecdef AND has_function_privilege(p.oid, 'EXECUTE') LIMIT 1`;
    if (definers.length) throw new Error("Vector runtime role can execute an application SECURITY DEFINER function");
    const ungranted = await db`WITH owned AS MATERIALIZED (
        SELECT s.oid, s.relname AS sequence_name, t.oid AS table_oid, t.relname AS table_name FROM pg_class s
        JOIN pg_namespace n ON n.oid = s.relnamespace
        JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid AND d.deptype = 'a'
        JOIN pg_class t ON t.oid = d.refobjid
        WHERE n.nspname = 'llm' AND s.relkind = 'S')
      SELECT table_name, sequence_name FROM owned
      WHERE has_table_privilege(table_oid, 'INSERT') AND NOT has_sequence_privilege(oid, 'USAGE')`;
    if (ungranted.length) {
      const names = ungranted.map((row) => `${row.table_name} (${row.sequence_name})`).join(", ");
      throw new Error(`Vector runtime role cannot draw ids for writable relations: ${names}; rerun the isolation installer`);
    }
  } finally {
    await db.end({ timeout: 1 });
  }
}
