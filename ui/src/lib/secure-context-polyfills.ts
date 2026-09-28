// Browsers expose crypto.randomUUID only in secure contexts (HTTPS or
// localhost). A self-hosted board served over plain HTTP on a LAN or tailnet
// address is not one, and every call site that assumed it silently failed —
// Agent Chat could not send its first message. getRandomValues exists in every
// context, so provide the same RFC 4122 version 4 UUID from it.
export function randomUUIDFromValues(fill: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>): string {
  const bytes = fill(new Uint8Array(new ArrayBuffer(16)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function installSecureContextPolyfills(target: { crypto?: Crypto } = globalThis): void {
  const webCrypto = target.crypto;
  if (!webCrypto || typeof webCrypto.randomUUID === "function") return;
  Object.defineProperty(webCrypto, "randomUUID", {
    configurable: true,
    writable: true,
    value: () => randomUUIDFromValues((bytes) => webCrypto.getRandomValues(bytes)),
  });
}

installSecureContextPolyfills();
