import { afterEach, describe, expect, it, vi } from "vitest";
import { PAPERCLIP_CLOUD_ENABLED, requireLocalPaperclipServiceUrl } from "./paperclip-cloud-policy.js";
import { resolveTelemetryConfig } from "./telemetry/config.js";

afterEach(() => vi.unstubAllEnvs());

describe("Vector Paperclip Cloud policy", () => {
  it.each(["engineering", "staging", "production"])("cannot be enabled in %s", (profile) => {
    vi.stubEnv("PAPERCLIP_VECTOR_PROFILE", profile);
    vi.stubEnv("PAPERCLIP_TELEMETRY_DISABLED", "0");
    vi.stubEnv("DO_NOT_TRACK", "0");
    vi.stubEnv("PAPERCLIP_TELEMETRY_ENDPOINT", "https://telemetry.paperclip.ing/ingest");
    expect(PAPERCLIP_CLOUD_ENABLED).toBe(false);
    expect(resolveTelemetryConfig({ enabled: true }).enabled).toBe(false);
  });

  it.each([undefined, "", "https://my.paperclip.app", "https://my-staging.paperclip.app", "https://id.paperclip.app", "http://localhost:8431", "http://127.0.0.1.evil.test", "http://user:secret@127.0.0.1", "http://127.0.0.1#fragment", "file:///tmp/test"])(
    "rejects missing, hosted or ambiguous destination %s", (destination) => {
      expect(() => requireLocalPaperclipServiceUrl(destination)).toThrow(/disabled in Vector/);
    },
  );

  it.each(["http://127.0.0.1:8431", "https://127.0.0.1:8431", "http://[::1]:8431"])(
    "preserves the local broker %s", (destination) => {
      expect(requireLocalPaperclipServiceUrl(destination).origin).toBe(destination);
    },
  );
});
