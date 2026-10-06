import { describe, expect, it } from "vitest";
import { installSecureContextPolyfills, randomUUIDFromValues } from "./secure-context-polyfills";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("secure-context polyfills", () => {
  it("formats getRandomValues output as an RFC 4122 v4 UUID", () => {
    expect(randomUUIDFromValues((bytes) => bytes.fill(0xff))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(randomUUIDFromValues((bytes) => bytes.fill(0))).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("adds randomUUID when an insecure HTTP context omits it", () => {
    const insecure = { getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => globalThis.crypto.getRandomValues(bytes) } as unknown as Crypto;
    installSecureContextPolyfills({ crypto: insecure });
    const first = insecure.randomUUID();
    expect(first).toMatch(UUID_V4);
    expect(insecure.randomUUID()).not.toBe(first);
  });

  it("keeps the native implementation in secure contexts", () => {
    const native = () => "00000000-0000-4000-8000-000000000001" as const;
    const secure = { randomUUID: native, getRandomValues: globalThis.crypto.getRandomValues } as unknown as Crypto;
    installSecureContextPolyfills({ crypto: secure });
    expect(secure.randomUUID).toBe(native);
  });
});
