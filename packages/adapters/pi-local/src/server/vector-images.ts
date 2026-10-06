const MAX_COUNT = 8;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export interface PiRpcImage {
  type: "image";
  data: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

function matchesMagic(mimeType: PiRpcImage["mimeType"], bytes: Buffer): boolean {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/gif") return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

export function parseVectorIngressImages(raw: unknown): PiRpcImage[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_COUNT) throw new Error("Vector ingress images are malformed");
  let total = 0;
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Vector ingress image is malformed");
    const image = value as Record<string, unknown>;
    const keys = Object.keys(image).sort();
    if (keys.join(",") !== "data,mimeType,type" || image.type !== "image" || typeof image.data !== "string" ||
        !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(String(image.mimeType))) {
      throw new Error("Vector ingress image is malformed");
    }
    const data = image.data;
    if (!data || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || /\s|^data:/i.test(data)) throw new Error("Vector ingress image data is invalid");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== data) throw new Error("Vector ingress image data is invalid");
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("Vector ingress image aggregate is too large");
    const mimeType = image.mimeType as PiRpcImage["mimeType"];
    if (!matchesMagic(mimeType, bytes)) throw new Error("Vector ingress image MIME does not match content");
    return { type: "image", data, mimeType };
  });
}

export function redactVectorIngressImages(context: Record<string, unknown>): Record<string, unknown> {
  const { vectorIngressImages: _images, ...safe } = context;
  return safe;
}

export function buildPiRpcPrompt(runId: string, message: string, images: readonly PiRpcImage[]): string {
  return `${JSON.stringify({
    id: `paperclip-${runId}`,
    type: "prompt",
    message,
    ...(images.length > 0 ? { images } : {}),
  })}\n`;
}

const REDACTED_IMAGE_DATA = "[redacted image data]";

function redactImageNodes(value: unknown, imageContext = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactImageNodes(entry, imageContext));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const isImage = imageContext || record.type === "image" ||
    (typeof record.mimeType === "string" && record.mimeType.startsWith("image/"));
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [
    key,
    key === "data" && isImage && typeof entry === "string"
      ? REDACTED_IMAGE_DATA
      : redactImageNodes(entry, isImage || key === "image"),
  ]));
}

export function sanitizePiOutputLine(line: string, sensitiveImageData: readonly string[]): string {
  let sanitized = line;
  for (const data of sensitiveImageData) {
    if (data) sanitized = sanitized.split(data).join(REDACTED_IMAGE_DATA);
  }
  try {
    return JSON.stringify(redactImageNodes(JSON.parse(sanitized)));
  } catch {
    return sanitized;
  }
}

export function sanitizePiOutput(output: string, sensitiveImageData: readonly string[]): string {
  return output
    .split("\n")
    .map((line) => sanitizePiOutputLine(line, sensitiveImageData))
    .join("\n");
}
