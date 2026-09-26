import { describe, expect, it } from "vitest";
import {
  buildPiRpcPrompt,
  parseVectorIngressImages,
  redactVectorIngressImages,
  sanitizePiOutput,
} from "./vector-images.js";

describe("Pi RPC Vector images", () => {
  const jpeg = { type: "image", data: "/9j/AA==", mimeType: "image/jpeg" };

  it("validates the RPC envelope and removes bytes from metadata", () => {
    expect(parseVectorIngressImages([jpeg])).toEqual([jpeg]);
    expect(redactVectorIngressImages({ vectorIngressImages: [jpeg], issueId: "issue" })).toEqual({ issueId: "issue" });
    expect(JSON.parse(buildPiRpcPrompt("run-1", "describe", parseVectorIngressImages([jpeg])))).toEqual({
      id: "paperclip-run-1", type: "prompt", message: "describe", images: [jpeg],
    });
  });

  it("redacts image blocks echoed by Pi lifecycle events and malformed output", () => {
    const raw = [
      JSON.stringify({ type: "message_start", message: { role: "user", content: [jpeg] } }),
      JSON.stringify({ type: "agent_end", messages: [{ role: "user", content: [jpeg] }] }),
      `malformed echo ${jpeg.data}`,
    ].join("\n");
    const sanitized = sanitizePiOutput(raw, [jpeg.data]);
    expect(sanitized).not.toContain(jpeg.data);
    expect(sanitized.match(/\[redacted image data\]/g)).toHaveLength(3);
    expect(sanitized).toContain("message_start");
    expect(sanitized).toContain("agent_end");
  });

  it("rejects malformed image context", () => {
    const invalid: unknown[] = [
      [{ ...jpeg, data: "%%%" }],
      [{ ...jpeg, mimeType: "image/png" }],
      [{ ...jpeg, extra: true }],
      Array.from({ length: 9 }, () => jpeg),
    ];
    for (const images of invalid) expect(() => parseVectorIngressImages(images)).toThrow();
  });
});
