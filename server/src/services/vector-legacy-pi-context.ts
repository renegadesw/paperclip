import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agentTaskSessions,
  agents,
  issues,
  vectorIngressConversations,
  type Db,
} from "@paperclipai/db";
import {
  readVectorLegacyPiContextMarker,
  stageVectorLegacyPiContext,
  verifyVectorLegacyPiContextMarker,
  verifyVectorLegacyPiContextSource,
  type StageVectorLegacyPiContextResult,
  type VectorLegacyService,
} from "@paperclipai/adapter-pi-local/server";
import { conflict, notFound } from "../errors.js";

export const VECTOR_LEGACY_PI_CONTEXT_ORIGIN = "vector-ingress/legacy-pi-context/v1";

export interface VectorLegacyPiContextImportInput {
  companyId: string;
  agentId: string;
  issueId: string;
  ownerId: string;
  installationId: string;
  profileId: string;
  externalSessionId: string;
  legacyService: VectorLegacyService;
  legacyPiSessionId: string;
}

export function vectorLegacyOwnerSha256(input: Pick<VectorLegacyPiContextImportInput,
  "companyId" | "agentId" | "installationId" | "profileId" | "ownerId">) {
  return createHash("sha256")
    .update("paperclip-vector-ingress-owner/v1\0")
    .update(input.companyId).update("\0")
    .update(input.agentId).update("\0")
    .update(input.installationId.trim()).update("\0")
    .update(input.profileId.trim()).update("\0")
    .update(input.ownerId.trim())
    .digest("hex");
}

export interface VectorLegacyPiContextImportResult {
  companyId: string;
  agentId: string;
  issueId: string;
  externalSessionId: string;
  sourceSha256: string;
  replayed: boolean;
}

export interface VectorLegacyPiContextImporter {
  importContext(input: VectorLegacyPiContextImportInput): Promise<VectorLegacyPiContextImportResult>;
}

async function existingImportReceipt(
  existing: typeof agentTaskSessions.$inferSelect,
  input: VectorLegacyPiContextImportInput,
  ingressSecret: string,
  sourceRoot: string,
) {
  const marker = readVectorLegacyPiContextMarker(existing.sessionParamsJson);
  if (!marker || existing.adapterType !== "pi_local" || existing.lastRunId !== null || existing.lastError !== null ||
    existing.sessionDisplayId !== marker.sessionPath || marker.ownerSha256 !== vectorLegacyOwnerSha256(input) ||
    marker.externalSessionId !== input.externalSessionId || marker.legacyService !== input.legacyService ||
    marker.legacyPiSessionId !== input.legacyPiSessionId ||
    !verifyVectorLegacyPiContextMarker({
      marker, ingressSecret,
      expected: {
        installationId: input.installationId, profileId: input.profileId,
        companyId: input.companyId, agentId: input.agentId,
        ownerSha256: vectorLegacyOwnerSha256(input), externalSessionId: input.externalSessionId,
      },
      sessionPath: marker.sessionPath,
    }) || !(await verifyVectorLegacyPiContextSource({ marker, sourceRoot }))) return null;
  return marker;
}

function importFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("vector_legacy_context_conflict:")) {
    throw conflict(message, { code: "vector_legacy_context_conflict" });
  }
  if (message.startsWith("vector_legacy_context_invalid:")) {
    throw conflict(message, { code: "vector_legacy_context_unavailable" });
  }
  throw error;
}

export function vectorLegacyPiContextImporter(db: Db, options: {
  sourceRoot: string;
  ingressSecret: string;
  sessionsRoot?: string;
  stage?: typeof stageVectorLegacyPiContext;
}): VectorLegacyPiContextImporter {
  const stage = options.stage ?? stageVectorLegacyPiContext;

  async function assertOwnedMapping(input: VectorLegacyPiContextImportInput) {
    if (!input.ownerId.trim()) {
      throw conflict("Vector legacy context owner binding does not match", { code: "vector_legacy_context_owner_mismatch" });
    }
    const expectedOwnerSha256 = vectorLegacyOwnerSha256(input);
    const row = await db.select({
      mappingCompanyId: vectorIngressConversations.companyId,
      mappingAgentId: vectorIngressConversations.agentId,
      mappingIssueId: vectorIngressConversations.issueId,
      installationId: vectorIngressConversations.installationId,
      profileId: vectorIngressConversations.profileId,
      ownerSha256: vectorIngressConversations.ownerSha256,
      externalSessionId: vectorIngressConversations.externalSessionId,
      issueCompanyId: issues.companyId,
      conversationAgentId: issues.conversationAgentId,
      adapterType: agents.adapterType,
    }).from(vectorIngressConversations)
      .innerJoin(issues, and(eq(issues.id, vectorIngressConversations.issueId), eq(issues.companyId, vectorIngressConversations.companyId)))
      .innerJoin(agents, and(eq(agents.id, vectorIngressConversations.agentId), eq(agents.companyId, vectorIngressConversations.companyId)))
      .where(and(
        eq(vectorIngressConversations.issueId, input.issueId),
        eq(vectorIngressConversations.companyId, input.companyId),
        eq(vectorIngressConversations.agentId, input.agentId),
      )).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Vector conversation import target not found");
    if (row.mappingCompanyId !== input.companyId || row.mappingAgentId !== input.agentId ||
      row.mappingIssueId !== input.issueId || row.issueCompanyId !== input.companyId ||
      row.conversationAgentId !== input.agentId || row.installationId !== input.installationId ||
      row.profileId !== input.profileId || row.ownerSha256 !== expectedOwnerSha256 ||
      row.externalSessionId !== input.externalSessionId || row.adapterType !== "pi_local") {
      throw conflict("Vector legacy context owner binding does not match", { code: "vector_legacy_context_owner_mismatch" });
    }
  }

  async function importContext(input: VectorLegacyPiContextImportInput): Promise<VectorLegacyPiContextImportResult> {
    await assertOwnedMapping(input);
    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select({ id: issues.id }).from(issues).where(and(
        eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), eq(issues.conversationAgentId, input.agentId),
      )).for("update");
      if (!locked) throw notFound("Vector conversation import target not found");
      const existing = await tx.select().from(agentTaskSessions).where(and(
        eq(agentTaskSessions.companyId, input.companyId), eq(agentTaskSessions.agentId, input.agentId),
        eq(agentTaskSessions.adapterType, "pi_local"), eq(agentTaskSessions.taskKey, input.issueId),
      )).then((rows) => rows[0] ?? null);
      if (existing) {
        const marker = await existingImportReceipt(existing, input, options.ingressSecret, options.sourceRoot);
        if (marker) {
          await tx.update(issues).set({ originFingerprint: VECTOR_LEGACY_PI_CONTEXT_ORIGIN, updatedAt: new Date() }).where(and(
            eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), eq(issues.conversationAgentId, input.agentId),
          ));
          return { replayed: true, sourceSha256: marker.sourceSha256 };
        }
        throw conflict("Vector conversation already has different provider context", { code: "vector_legacy_context_conflict" });
      }
      let staged: StageVectorLegacyPiContextResult;
      try {
        staged = await stage({
          installationId: input.installationId, profileId: input.profileId,
          companyId: input.companyId, agentId: input.agentId,
          ownerSha256: vectorLegacyOwnerSha256(input), externalSessionId: input.externalSessionId,
          legacyService: input.legacyService, legacyPiSessionId: input.legacyPiSessionId,
          sourceRoot: options.sourceRoot, sessionsRoot: options.sessionsRoot,
          ingressSecret: options.ingressSecret,
        });
      } catch (error) { importFailure(error); }
      await tx.insert(agentTaskSessions).values({
        companyId: input.companyId, agentId: input.agentId, adapterType: "pi_local", taskKey: input.issueId,
        sessionParamsJson: staged.sessionParams, sessionDisplayId: staged.sessionParams.sessionId,
        lastRunId: null, lastError: null,
      });
      await tx.update(issues).set({ originFingerprint: VECTOR_LEGACY_PI_CONTEXT_ORIGIN, updatedAt: new Date() }).where(and(
        eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), eq(issues.conversationAgentId, input.agentId),
      ));
      return { replayed: false, sourceSha256: staged.sourceSha256 };
    });
    return {
      companyId: input.companyId, agentId: input.agentId, issueId: input.issueId,
      externalSessionId: input.externalSessionId, sourceSha256: result.sourceSha256,
      replayed: result.replayed,
    };
  }

  return { importContext };
}
