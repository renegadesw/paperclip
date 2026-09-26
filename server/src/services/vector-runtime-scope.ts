import { eq, inArray } from "drizzle-orm";
import {
  agents,
  type Db,
  vectorInstallationOwnerships,
} from "@paperclipai/db";
import { z } from "zod";

export const VECTOR_INSTALLATION_ID_ENV = "PAPERCLIP_VECTOR_INSTALLATION_ID";
export const VECTOR_PROFILE_ENV = "PAPERCLIP_VECTOR_PROFILE";
export const VECTOR_COMPANY_ID_ENV = "PAPERCLIP_VECTOR_COMPANY_ID";
export const VECTOR_ALLOWED_AGENT_IDS_ENV = "PAPERCLIP_VECTOR_ALLOWED_AGENT_IDS";

const installationIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const profileSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const uuidSchema = z.string().uuid();

export interface VectorRuntimeScope {
  installationId: string;
  profile: string;
  companyId: string;
  allowedAgentIds: readonly string[];
}

export interface VectorRuntimeScopePort {
  getOwnershipByInstallationId(installationId: string): Promise<{
    installationId: string;
    profile: string;
    companyId: string;
  } | null>;
  listAgentCompanyBindings(agentIds: readonly string[]): Promise<Array<{
    id: string;
    companyId: string;
  }>>;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`vector-embedded runtime scope requires ${name}`);
  return value;
}

export function resolveVectorRuntimeScope(
  databaseProfile: string,
  env: NodeJS.ProcessEnv = process.env,
): VectorRuntimeScope | null {
  if (databaseProfile !== "vector-embedded") return null;
  const allowedAgentIds = requireEnv(env, VECTOR_ALLOWED_AGENT_IDS_ENV)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowedAgentIds.length === 0 || new Set(allowedAgentIds).size !== allowedAgentIds.length) {
    throw new Error(`${VECTOR_ALLOWED_AGENT_IDS_ENV} must contain unique agent UUIDs`);
  }
  return Object.freeze({
    installationId: installationIdSchema.parse(requireEnv(env, VECTOR_INSTALLATION_ID_ENV)),
    profile: profileSchema.parse(requireEnv(env, VECTOR_PROFILE_ENV)),
    companyId: uuidSchema.parse(requireEnv(env, VECTOR_COMPANY_ID_ENV)),
    allowedAgentIds: Object.freeze(allowedAgentIds.map((id) => uuidSchema.parse(id)).sort()),
  });
}

export async function assertVectorRuntimeScopeOwnership(
  port: VectorRuntimeScopePort,
  scope: VectorRuntimeScope,
): Promise<void> {
  const ownership = await port.getOwnershipByInstallationId(scope.installationId);
  if (!ownership) throw new Error("Vector runtime scope has no provisioned installation ownership");
  if (ownership.companyId !== scope.companyId || ownership.profile !== scope.profile) {
    throw new Error("Vector runtime scope does not match provisioned installation ownership");
  }
  const agentsFound = await port.listAgentCompanyBindings(scope.allowedAgentIds);
  const byId = new Map(agentsFound.map((agent) => [agent.id, agent.companyId]));
  for (const agentId of scope.allowedAgentIds) {
    if (byId.get(agentId) !== scope.companyId) {
      throw new Error("Vector runtime scope contains an agent outside its provisioned company");
    }
  }
}

export function vectorRuntimeScopePort(db: Db): VectorRuntimeScopePort {
  return {
    getOwnershipByInstallationId: async (installationId) =>
      db
        .select({
          installationId: vectorInstallationOwnerships.installationId,
          profile: vectorInstallationOwnerships.profile,
          companyId: vectorInstallationOwnerships.companyId,
        })
        .from(vectorInstallationOwnerships)
        .where(eq(vectorInstallationOwnerships.installationId, installationId))
        .then((rows) => rows[0] ?? null),
    listAgentCompanyBindings: async (agentIds) => {
      if (agentIds.length === 0) return [];
      return db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(inArray(agents.id, [...agentIds]));
    },
  };
}

export async function assertVectorRuntimeScopeForDatabase(
  db: Db,
  scope: VectorRuntimeScope,
): Promise<void> {
  await assertVectorRuntimeScopeOwnership(vectorRuntimeScopePort(db), scope);
}
