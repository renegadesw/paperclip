import { is, Table } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export const VECTOR_RUNTIME_DATABASE_ROLE = "paperclip_runtime";
const POLICY = "paperclip_vector_runtime_v1";
const COMPANY = "NULLIF(current_setting('paperclip.company_id', true), '')::uuid";
const INSTALLATION = "NULLIF(current_setting('paperclip.installation_id', true), '')";

// These are owned by Vector OS, not the Paperclip child process. Do not change
// their policies or grant the child access to their owner-scoped contents.
const PARENT_OWNED = new Set(["paperclip_questions", "paperclip_todos"]);

// Explicit quarantine, NOT a claim that instance-global services are ported.
// Keep the process singleton until these services have installation ownership.
const QUARANTINED = new Set([
  "announcement_dismissals", "announcement_publications", "account", "session",
  "user", "verification", "board_api_keys", "environment_custom_image_setup_sessions",
  "environment_custom_image_templates", "environments", "instance_settings",
  "instance_user_roles", "plugin_database_namespaces", "plugin_jobs",
  "plugin_migrations", "plugin_state", "plugins", "user_sidebar_preferences",
]);

const PARENT_SCOPE: Record<string, [string, string]> = {
  company_secret_versions: ["secret_id", "company_secrets"],
  decision_effect_executions: ["decision_id", "decisions"],
  pipeline_stages: ["pipeline_id", "pipelines"],
  pipeline_transitions: ["pipeline_id", "pipelines"],
  status_card_updates: ["card_id", "status_cards"],
  vector_ingress_turns: ["conversation_id", "vector_ingress_conversations"],
};

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("Unsafe isolation SQL identifier");
  return `"${value}"`;
}

export interface VectorIsolationRelation {
  table: string;
  mode: "company" | "parent" | "quarantined" | "vector-parent";
  using: string;
  check: string;
  foreignKeyCheck?: string;
  readOnly: boolean;
}

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
      readOnly: name === "vector_installation_ownerships" || name === "companies",
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
export async function installVectorRuntimeIsolation(connectionString: string): Promise<{
  scopedTables: number; quarantinedTables: string[]; parentOwnedTables: string[];
}> {
  const relations = vectorIsolationRelations();
  const db = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(1346588754, 1380733745)`;
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
      const permitted = relations.filter((row) => row.mode !== "vector-parent").map((row) => row.table);
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
      await tx.unsafe(`GRANT USAGE ON SCHEMA llm TO ${VECTOR_RUNTIME_DATABASE_ROLE}`);
      // A SECURITY INVOKER trigger performs the SELECT under the runtime role.
      // Putting FK/self-reference lookups in WITH CHECK causes PostgreSQL's
      // policy rewriter to recurse for agents.reports_to and similar cycles.
      await tx.unsafe(`CREATE OR REPLACE FUNCTION llm.paperclip_vector_check_foreign_refs()
        RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $body$
        DECLARE allowed boolean;
        BEGIN
          IF current_user <> 'paperclip_runtime' THEN RETURN NEW; END IF;
          EXECUTE 'SELECT ' || TG_ARGV[0] INTO allowed USING to_jsonb(NEW);
          IF allowed IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'Vector runtime foreign reference is outside installation scope' USING ERRCODE = '42501';
          END IF;
          RETURN NEW;
        END $body$`);
      await tx.unsafe(`REVOKE ALL ON FUNCTION llm.paperclip_vector_check_foreign_refs() FROM PUBLIC`);
      for (const relation of relations) {
        if (relation.mode === "vector-parent") continue;
        const target = `llm.${identifier(relation.table)}`;
        const rows = await tx`SELECT c.relowner = r.oid AS owned FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN pg_roles r
          WHERE n.nspname = 'llm' AND c.relname = ${relation.table}
            AND r.rolname = ${VECTOR_RUNTIME_DATABASE_ROLE}`;
        if (rows.length !== 1 || rows[0]!.owned) {
          throw new Error(`Missing relation or unsafe runtime owner: ${relation.table}`);
        }
        await tx.unsafe(`ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY`);
        // Restrictive gate cannot be widened by an existing permissive policy.
        await tx.unsafe(`DROP POLICY IF EXISTS ${POLICY} ON ${target}`);
        await tx.unsafe(`DROP POLICY IF EXISTS ${POLICY}_gate ON ${target}`);
        await tx.unsafe(`CREATE POLICY ${POLICY} ON ${target} TO ${VECTOR_RUNTIME_DATABASE_ROLE} USING (true) WITH CHECK (true)`);
        await tx.unsafe(`CREATE POLICY ${POLICY}_gate ON ${target} AS RESTRICTIVE TO ${VECTOR_RUNTIME_DATABASE_ROLE} USING (${relation.using}) WITH CHECK (${relation.check})`);
        await tx.unsafe(`DROP TRIGGER IF EXISTS paperclip_vector_foreign_refs ON ${target}`);
        if (relation.foreignKeyCheck && !relation.readOnly && relation.mode !== "quarantined") {
          const argument = relation.foreignKeyCheck.replaceAll("'", "''");
          await tx.unsafe(`CREATE TRIGGER paperclip_vector_foreign_refs BEFORE INSERT OR UPDATE ON ${target}
            FOR EACH ROW EXECUTE FUNCTION llm.paperclip_vector_check_foreign_refs('${argument}')`);
        }
        await tx.unsafe(`REVOKE ALL ON ${target} FROM ${VECTOR_RUNTIME_DATABASE_ROLE}`);
        await tx.unsafe(`GRANT ${relation.readOnly || relation.mode === "quarantined" ? "SELECT" : "SELECT, INSERT, UPDATE, DELETE"} ON ${target} TO ${VECTOR_RUNTIME_DATABASE_ROLE}`);
      }
      // A monotonic transport identifier, not a scheduler or company-data table.
      await tx.unsafe(`GRANT USAGE ON SEQUENCE llm.chat_telegram_draft_ids TO ${VECTOR_RUNTIME_DATABASE_ROLE}`);
    });
    return {
      scopedTables: relations.filter((row) => row.mode === "company" || row.mode === "parent").length,
      quarantinedTables: relations.filter((row) => row.mode === "quarantined").map((row) => row.table),
      parentOwnedTables: relations.filter((row) => row.mode === "vector-parent").map((row) => row.table),
    };
  } finally {
    await db.end({ timeout: 1 });
  }
}
