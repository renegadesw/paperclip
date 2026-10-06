import { createHash } from "node:crypto";
import { conflict } from "../errors.js";

export const VECTOR_IMAGE_MAX_COUNT = 8;
export const VECTOR_IMAGE_MAX_BYTES = 7 * 1024 * 1024;
export const VECTOR_IMAGE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export interface VectorIngressImageInput {
  type: "image";
  data: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface ValidatedVectorImage {
  type: "image";
  data: string;
  mimeType: VectorIngressImageInput["mimeType"];
  bytes: Buffer;
  byteSize: number;
  sha256: string;
  filename: string;
}

const extensionByMime = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;

function matchesMagic(mimeType: VectorIngressImageInput["mimeType"], bytes: Buffer): boolean {
  switch (mimeType) {
    case "image/jpeg":
      return bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case "image/png":
      return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/gif":
      return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
    case "image/webp":
      return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
}

export function validateVectorIngressImages(
  input: readonly VectorIngressImageInput[] | undefined,
): ValidatedVectorImage[] {
  const images = input ?? [];
  if (images.length > VECTOR_IMAGE_MAX_COUNT) {
    throw conflict("Vector turn has too many images", { code: "vector_ingress_images_invalid" });
  }
  let total = 0;
  return images.map((image, index) => {
    const maximumEncodedLength = Math.ceil(VECTOR_IMAGE_MAX_BYTES / 3) * 4;
    if (!image.data || image.data.length > maximumEncodedLength || /\s|^data:/i.test(image.data)) {
      throw conflict("Vector image data is invalid", { code: "vector_ingress_images_invalid" });
    }
    const bytes = Buffer.from(image.data, "base64");
    if (!bytes.length || bytes.length > VECTOR_IMAGE_MAX_BYTES || bytes.toString("base64") !== image.data) {
      throw conflict("Vector image data is invalid", { code: "vector_ingress_images_invalid" });
    }
    total += bytes.length;
    if (total > VECTOR_IMAGE_MAX_TOTAL_BYTES) {
      throw conflict("Vector image aggregate is too large", { code: "vector_ingress_images_invalid" });
    }
    if (!matchesMagic(image.mimeType, bytes)) {
      throw conflict("Vector image MIME does not match its content", { code: "vector_ingress_images_invalid" });
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      ...image,
      bytes,
      byteSize: bytes.length,
      sha256,
      filename: `vector-ingress-image-${String(index + 1).padStart(3, "0")}-${sha256.slice(0, 16)}.${extensionByMime[image.mimeType]}`,
    };
  });
}

export function isVectorIngressImageAsset(input: {
  companyId: string;
  issueId: string;
  objectKey: string;
  originalFilename: string | null;
}): boolean {
  return Boolean(
    input.originalFilename?.match(/^vector-ingress-image-\d{3}-[a-f0-9]{16}\.(?:jpg|png|gif|webp)$/) &&
    input.objectKey.startsWith(`${input.companyId}/vector-ingress/${input.issueId}/`),
  );
}
