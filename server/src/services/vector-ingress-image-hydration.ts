import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { assets, issueAttachments, type Db } from "@paperclipai/db";
import type { StorageService } from "../storage/index.js";
import {
  VECTOR_IMAGE_MAX_TOTAL_BYTES,
  VECTOR_IMAGE_MAX_COUNT,
  validateVectorIngressImages,
  isVectorIngressImageAsset,
  type VectorIngressImageInput,
} from "./vector-ingress-images.js";

const READ_TIMEOUT_MS = 30_000;

async function readBounded(stream: NodeJS.ReadableStream, maximum: number): Promise<Buffer> {
  let timer: NodeJS.Timeout | undefined;
  const read = (async () => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.length;
      if (total > maximum) {
        (stream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy?.();
        throw new Error("Vector image storage object exceeds its bound");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Vector image storage read timed out");
      (stream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy?.(error);
      reject(error);
    }, READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function hydrateVectorIngressImages(input: {
  db: Db;
  storage: StorageService;
  companyId: string;
  issueId: string;
  commentId: string;
  attachmentIds: string[];
}): Promise<VectorIngressImageInput[]> {
  const uniqueIds = [...new Set(input.attachmentIds)];
  if (uniqueIds.length !== input.attachmentIds.length || uniqueIds.length === 0 || uniqueIds.length > VECTOR_IMAGE_MAX_COUNT) {
    throw new Error("Vector image attachment identity is invalid");
  }
  const rows = await input.db
    .select({
      attachmentId: issueAttachments.id,
      objectKey: assets.objectKey,
      contentType: assets.contentType,
      byteSize: assets.byteSize,
      sha256: assets.sha256,
      originalFilename: assets.originalFilename,
    })
    .from(issueAttachments)
    .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
    .where(and(
      eq(issueAttachments.companyId, input.companyId),
      eq(issueAttachments.issueId, input.issueId),
      eq(issueAttachments.issueCommentId, input.commentId),
      eq(assets.companyId, input.companyId),
      inArray(issueAttachments.id, uniqueIds),
    ));
  const byId = new Map(rows.map((row) => [row.attachmentId, row]));
  if (byId.size !== uniqueIds.length) throw new Error("Vector image attachment ownership mismatch");

  const encoded: VectorIngressImageInput[] = [];
  let aggregate = 0;
  for (const attachmentId of input.attachmentIds) {
    const row = byId.get(attachmentId)!;
    if (!isVectorIngressImageAsset({ ...row, companyId: input.companyId, issueId: input.issueId })) {
      throw new Error("Vector image attachment provenance mismatch");
    }
    if (!Number.isSafeInteger(row.byteSize) || row.byteSize <= 0) {
      throw new Error("Vector image attachment size is invalid");
    }
    aggregate += row.byteSize;
    if (aggregate > VECTOR_IMAGE_MAX_TOTAL_BYTES) throw new Error("Vector image attachment aggregate is too large");
    const object = await input.storage.getObject(input.companyId, row.objectKey);
    const bytes = await readBounded(object.stream, row.byteSize);
    if (bytes.length !== row.byteSize || createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
      throw new Error("Vector image attachment integrity mismatch");
    }
    encoded.push({ type: "image", data: bytes.toString("base64"), mimeType: row.contentType as VectorIngressImageInput["mimeType"] });
  }
  return validateVectorIngressImages(encoded).map(({ type, data, mimeType }) => ({ type, data, mimeType }));
}
