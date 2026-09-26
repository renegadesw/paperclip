import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { type Db, vectorInstallationOwnerships } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { agentService } from "./agents.js";
import { companyService } from "./companies.js";

const UUID = z.string().uuid();
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);

const companyMutableField = z.enum(["name", "description", "budgetMonthlyCents"]);
const agentMutableField = z.enum([
  "name",
  "role",
  "title",
  "capabilities",
  "adapterConfig",
  "runtimeConfig",
  "budgetMonthlyCents",
  "permissions",
  "metadata",
]);

const toolPolicySchema = z.object({
  profile: z.literal("engineering"),
  builtinTools: z.array(z.enum(["bash", "edit", "find", "grep", "ls", "read", "write"])),
  extensions: z.array(z.object({
    name: z.string().min(1),
    tools: z.array(z.string().min(1)),
    permissions: z.object({ filesystem: z.boolean(), shell: z.boolean() }).strict(),
  }).strict()),
}).strict();

const heartbeatRuntimeConfigSchema = z.object({
  heartbeat: z.object({
    enabled: z.literal(false),
    wakeOnDemand: z.literal(true),
    maxConcurrentRuns: z.number().int().positive().max(1),
  }).strict(),
}).strict();

const agentPermissionsSchema = z.object({
  canCreateAgents: z.literal(false),
  canCreateSkills: z.literal(false),
}).strict();

const forbiddenManifestKey = /(?:^|_)(?:api_?key|token|password|secret|credential|database_?url|private_?key|env|environment)(?:$|_)/i;
const forbiddenManifestValue = /(?:\$\{[^}]+\}|\$[A-Z][A-Z0-9_]*|^(?:env|secret|credential):|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

function assertNoEmbeddedAuthority(value: unknown, location = "manifest"): void {
  if (typeof value === "string") {
    if (forbiddenManifestValue.test(value)) {
      throw new Error(`Vector provisioning manifest must not contain credential or environment references at ${location}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoEmbeddedAuthority(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_");
    if (forbiddenManifestKey.test(normalizedKey)) {
      throw new Error(`Vector provisioning manifest must not contain secret-bearing key ${location}.${key}`);
    }
    assertNoEmbeddedAuthority(entry, `${location}.${key}`);
  }
}

export const vectorInstallationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  manifestRevision: z.number().int().positive(),
  installationId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  profile: z.literal("engineering"),
  company: z.object({
    id: UUID,
    name: z.string().min(1),
    description: z.string().nullable(),
    budgetMonthlyCents: z.number().int().nonnegative(),
    mutableFields: z.array(companyMutableField),
  }).strict(),
  agent: z.object({
    id: UUID,
    name: z.string().min(1),
    role: z.string().min(1),
    title: z.string().nullable(),
    capabilities: z.string().nullable(),
    adapterType: z.literal("pi_local"),
    adapterConfig: z.object({
      model: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
      executionMode: z.literal("rpc"),
      cwd: z.string().refine(path.isAbsolute, "cwd must be absolute"),
    }).strict(),
    instructions: z.object({
      path: z.string().min(1),
      sha256: SHA256,
    }).strict(),
    runtimeConfig: heartbeatRuntimeConfigSchema,
    budgetMonthlyCents: z.number().int().nonnegative(),
    permissions: agentPermissionsSchema,
    mutableFields: z.array(agentMutableField),
  }).strict(),
  toolPolicy: toolPolicySchema,
}).strict().superRefine((manifest, ctx) => {
  for (const [label, values] of [
    ["company.mutableFields", manifest.company.mutableFields],
    ["agent.mutableFields", manifest.agent.mutableFields],
  ] as const) {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: "custom", path: label.split("."), message: `${label} must be unique` });
    }
  }
  if (!path.posix.isAbsolute(manifest.agent.instructions.path)
      && (manifest.agent.instructions.path !== path.posix.normalize(manifest.agent.instructions.path)
        || manifest.agent.instructions.path.startsWith("../"))) {
    ctx.addIssue({
      code: "custom",
      path: ["agent", "instructions", "path"],
      message: "instructions path must be a clean release-relative path",
    });
  }
  if (path.posix.isAbsolute(manifest.agent.instructions.path)) {
    ctx.addIssue({
      code: "custom",
      path: ["agent", "instructions", "path"],
      message: "instructions path must be release-relative",
    });
  }
});

export type VectorInstallationManifest = z.infer<typeof vectorInstallationManifestSchema>;
export type VectorToolPolicy = z.infer<typeof toolPolicySchema>;

type CompanyRecord = {
  id: string;
  name: string;
  description: string | null;
  budgetMonthlyCents: number;
};

type AgentRecord = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title: string | null;
  capabilities: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  budgetMonthlyCents: number;
  permissions: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
};

type InstallationOwnershipRecord = {
  installationId: string;
  profile: string;
  companyId: string;
};

export interface VectorProvisioningPort {
  listCompanies(): Promise<CompanyRecord[]>;
  getCompany(id: string): Promise<CompanyRecord | null>;
  createCompany(input: CompanyRecord): Promise<CompanyRecord>;
  getOwnershipByInstallationId(installationId: string): Promise<InstallationOwnershipRecord | null>;
  getOwnershipByCompanyId(companyId: string): Promise<InstallationOwnershipRecord | null>;
  createOwnership(input: InstallationOwnershipRecord): Promise<InstallationOwnershipRecord>;
  listAgents(companyId: string): Promise<AgentRecord[]>;
  getAgent(id: string): Promise<AgentRecord | null>;
  createAgent(companyId: string, input: Omit<AgentRecord, "companyId">): Promise<AgentRecord>;
}

export interface VectorProvisioningInput {
  manifest: unknown;
  selectedProfile: string;
  stagedReleaseRoot: string;
  activeReleaseRoot: string;
  effectiveToolPolicy: unknown;
}

export interface VectorProvisioningReceipt {
  schemaVersion: 1;
  installationId: string;
  profile: "engineering";
  manifestRevision: number;
  companyId: string;
  agentId: string;
  created: { company: boolean; ownership: boolean; agent: boolean };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`Vector provisioning drift: immutable field ${label} differs`);
  }
}

function assertImmutableFields(
  kind: "company" | "agent",
  actual: object,
  expected: object,
  mutableFields: readonly string[],
): void {
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const mutable = new Set(mutableFields);
  for (const key of Object.keys(expectedRecord)) {
    if (!mutable.has(key)) assertEqual(`${kind}.${key}`, actualRecord[key], expectedRecord[key]);
  }
}

function containedReleasePath(root: string, relative: string): string {
  if (!path.isAbsolute(root)) throw new Error("Vector provisioning release roots must be absolute");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Vector provisioning instructions path escapes release root");
  }
  return resolved;
}

async function resolveManifest(input: VectorProvisioningInput) {
  assertNoEmbeddedAuthority(input.manifest);
  const manifest = vectorInstallationManifestSchema.parse(input.manifest);
  if (input.selectedProfile !== manifest.profile) {
    throw new Error(`Vector provisioning profile mismatch: selected ${input.selectedProfile}, manifest ${manifest.profile}`);
  }
  const effectiveToolPolicy = toolPolicySchema.parse(input.effectiveToolPolicy);
  assertEqual("toolPolicy", effectiveToolPolicy, manifest.toolPolicy);

  const stagedInstructionsPath = containedReleasePath(
    input.stagedReleaseRoot,
    manifest.agent.instructions.path,
  );
  const stat = await fs.stat(stagedInstructionsPath).catch(() => null);
  if (!stat?.isFile()) throw new Error("Vector provisioning instructions asset is missing");
  const digest = createHash("sha256").update(await fs.readFile(stagedInstructionsPath)).digest("hex");
  if (digest !== manifest.agent.instructions.sha256) {
    throw new Error("Vector provisioning instructions asset digest mismatch");
  }

  return {
    manifest,
    instructionsFilePath: containedReleasePath(
      input.activeReleaseRoot,
      manifest.agent.instructions.path,
    ),
  };
}

export async function reconcileVectorInstallation(
  port: VectorProvisioningPort,
  input: VectorProvisioningInput,
): Promise<VectorProvisioningReceipt> {
  const { manifest, instructionsFilePath } = await resolveManifest(input);
  const companyExpected = {
    id: manifest.company.id,
    name: manifest.company.name,
    description: manifest.company.description,
    budgetMonthlyCents: manifest.company.budgetMonthlyCents,
  };
  const agentExpected = {
    id: manifest.agent.id,
    name: manifest.agent.name,
    role: manifest.agent.role,
    title: manifest.agent.title,
    capabilities: manifest.agent.capabilities,
    adapterType: manifest.agent.adapterType,
    adapterConfig: {
      ...manifest.agent.adapterConfig,
      instructionsFilePath,
    },
    runtimeConfig: manifest.agent.runtimeConfig,
    budgetMonthlyCents: manifest.agent.budgetMonthlyCents,
    permissions: manifest.agent.permissions,
    metadata: {
      vectorProvisioning: {
        schemaVersion: 1,
        installationId: manifest.installationId,
        profile: manifest.profile,
        manifestRevision: manifest.manifestRevision,
      },
    },
  };

  let company = await port.getCompany(manifest.company.id);
  let companyCreated = false;
  if (company) {
    assertImmutableFields("company", company, companyExpected, manifest.company.mutableFields);
  } else {
    const collision = (await port.listCompanies()).find((candidate) => candidate.name === manifest.company.name);
    if (collision) throw new Error("Vector provisioning company identity collision");
    company = await port.createCompany(companyExpected);
    assertImmutableFields("company", company, companyExpected, []);
    companyCreated = true;
  }

  const ownershipExpected = {
    installationId: manifest.installationId,
    profile: manifest.profile,
    companyId: company.id,
  };
  const installationOwnership = await port.getOwnershipByInstallationId(manifest.installationId);
  const companyOwnership = await port.getOwnershipByCompanyId(company.id);
  if (installationOwnership && companyOwnership
      && stableJson(installationOwnership) !== stableJson(companyOwnership)) {
    throw new Error("Vector provisioning installation ownership collision");
  }
  const ownership = installationOwnership ?? companyOwnership;
  let ownershipCreated = false;
  if (ownership) {
    assertEqual("installationOwnership", ownership, ownershipExpected);
  } else {
    const created = await port.createOwnership(ownershipExpected);
    assertEqual("installationOwnership", created, ownershipExpected);
    ownershipCreated = true;
  }

  let agent = await port.getAgent(manifest.agent.id);
  let agentCreated = false;
  if (agent) {
    if (agent.companyId !== company.id) throw new Error("Vector provisioning agent belongs to another company");
    assertImmutableFields("agent", agent, agentExpected, manifest.agent.mutableFields);
  } else {
    const collision = (await port.listAgents(company.id)).find((candidate) => candidate.name === manifest.agent.name);
    if (collision) throw new Error("Vector provisioning agent identity collision");
    agent = await port.createAgent(company.id, agentExpected);
    assertImmutableFields("agent", agent, { ...agentExpected, companyId: company.id }, []);
    agentCreated = true;
  }

  return {
    schemaVersion: 1,
    installationId: manifest.installationId,
    profile: manifest.profile,
    manifestRevision: manifest.manifestRevision,
    companyId: company.id,
    agentId: agent.id,
    created: { company: companyCreated, ownership: ownershipCreated, agent: agentCreated },
  };
}

function productionPort(db: Db): VectorProvisioningPort {
  const companies = companyService(db);
  const agents = agentService(db);
  return {
    listCompanies: () => companies.list() as Promise<CompanyRecord[]>,
    getCompany: (id) => companies.getById(id) as Promise<CompanyRecord | null>,
    createCompany: (input) => companies.create(input) as Promise<CompanyRecord>,
    getOwnershipByInstallationId: (installationId) =>
      db
        .select({
          installationId: vectorInstallationOwnerships.installationId,
          profile: vectorInstallationOwnerships.profile,
          companyId: vectorInstallationOwnerships.companyId,
        })
        .from(vectorInstallationOwnerships)
        .where(eq(vectorInstallationOwnerships.installationId, installationId))
        .then((rows) => rows[0] ?? null),
    getOwnershipByCompanyId: (companyId) =>
      db
        .select({
          installationId: vectorInstallationOwnerships.installationId,
          profile: vectorInstallationOwnerships.profile,
          companyId: vectorInstallationOwnerships.companyId,
        })
        .from(vectorInstallationOwnerships)
        .where(eq(vectorInstallationOwnerships.companyId, companyId))
        .then((rows) => rows[0] ?? null),
    createOwnership: (input) =>
      db.insert(vectorInstallationOwnerships).values(input).returning({
        installationId: vectorInstallationOwnerships.installationId,
        profile: vectorInstallationOwnerships.profile,
        companyId: vectorInstallationOwnerships.companyId,
      }).then((rows) => rows[0]!),
    listAgents: (companyId) => agents.list(companyId, { includeTerminated: true }) as Promise<AgentRecord[]>,
    getAgent: (id) => agents.getById(id) as Promise<AgentRecord | null>,
    createAgent: (companyId, input) => agents.create(companyId, input) as Promise<AgentRecord>,
  };
}

export async function provisionVectorInstallation(
  db: Db,
  input: VectorProvisioningInput,
): Promise<VectorProvisioningReceipt> {
  return db.transaction(async (tx) =>
    reconcileVectorInstallation(productionPort(tx as unknown as Db), input));
}
