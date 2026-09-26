import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { readVectorLegacyPiContextMarker } from "./vector-legacy-context.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readLegacyVectorContext(value: Record<string, unknown>) {
  return readVectorLegacyPiContextMarker(value)
    ? { vectorLegacyPiContext: value.vectorLegacyPiContext }
    : {};
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id) ??
      readNonEmptyString(record.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...readLegacyVectorContext(record),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...readLegacyVectorContext(params),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session)
    );
  },
};

export { execute, ENGINEERING_TODO_WORKER_PROMPT } from "./execute.js";
export {
  readVectorLegacyPiContextMarker,
  stageVectorLegacyPiContext,
  verifyVectorLegacyPiContextMarker,
  verifyVectorLegacyPiContextFile,
  verifyVectorLegacyPiContextSource,
  type StageVectorLegacyPiContextResult,
  type VectorLegacyPiContextMarker,
  type VectorLegacyPiContextScope,
  type VectorLegacyPiContextSessionParams,
  type VectorLegacyService,
} from "./vector-legacy-context.js";
export {
  controlVectorPiSession,
  removeVectorPiForkFile,
  VectorPiSessionControlError,
  type VectorPiForkPoint,
  type VectorPiSessionControlInput,
  type VectorPiSessionControlResult,
  type VectorPiSessionState,
} from "./vector-session-control.js";
export { listPiSkills, syncPiSkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export {
  listPiModels,
  discoverPiModels,
  discoverPiModelsCached,
  ensurePiModelConfiguredAndAvailable,
  resetPiModelsCacheForTests,
} from "./models.js";
export { parsePiJsonl, isPiUnknownSessionError } from "./parse.js";
