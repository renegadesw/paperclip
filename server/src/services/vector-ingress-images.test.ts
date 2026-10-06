import { describe, expect, it } from "vitest";
import { validateVectorIngressImages } from "./vector-ingress-images.js";
import { hydrateVectorIngressImages } from "./vector-ingress-image-hydration.js";

describe("Vector ingress image validation", () => {
  const jpeg = { type: "image" as const, data: "/9j/AA==", mimeType: "image/jpeg" as const };

  it("accepts canonical bounded image data and derives stable storage identity", () => {
    const [image] = validateVectorIngressImages([jpeg]);
    expect(image).toMatchObject({ byteSize: 4, mimeType: "image/jpeg" });
    expect(image?.filename).toMatch(/^vector-ingress-image-001-[a-f0-9]{16}\.jpg$/);
  });

  it("rejects malformed, mismatched, or excessive image input", () => {
    const invalid = [
      [{ ...jpeg, data: "%%%" }],
      [{ ...jpeg, data: "/9j/AA==\n" }],
      [{ ...jpeg, mimeType: "image/png" as const }],
      Array.from({ length: 9 }, () => jpeg),
    ];
    for (const images of invalid) expect(() => validateVectorIngressImages(images)).toThrow();
  });

  it("rejects too many attachment IDs before touching database or storage", async () => {
    const db = new Proxy({}, { get: () => { throw new Error("database touched"); } });
    const storage = new Proxy({}, { get: () => { throw new Error("storage touched"); } });
    await expect(hydrateVectorIngressImages({
      db: db as never,
      storage: storage as never,
      companyId: "company",
      issueId: "issue",
      commentId: "comment",
      attachmentIds: Array.from({ length: 9 }, (_, index) => `attachment-${index}`),
    })).rejects.toThrow("attachment identity is invalid");
  });
});
