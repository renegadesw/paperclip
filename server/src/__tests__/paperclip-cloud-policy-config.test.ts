import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";

afterEach(() => vi.unstubAllEnvs());

describe("Paperclip Cloud runtime policy", () => {
  it.each(["engineering", "staging", "production"])("refuses cloud settings in %s", (profile) => {
    vi.stubEnv("PAPERCLIP_VECTOR_PROFILE", profile);
    for (const key of ["PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "PAPERCLIP_CLOUD_API_ORIGIN", "PAPERCLIP_CLOUD_CONNECTOR_BASE_URL"]) {
      vi.stubEnv(key, key.endsWith("TOKEN") ? "test-token" : "https://my.paperclip.app");
      expect(() => loadConfig()).toThrow(/disabled in Vector/);
      vi.stubEnv(key, "");
    }
  });

  it("keeps local engineering and production settings independent of protocol labels", () => {
    vi.stubEnv("PAPERCLIP_CONFIG", "/private/tmp/pv-cloud-ban/missing-config.json");
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "");
    vi.stubEnv("PAPERCLIP_CLOUD_API_ORIGIN", "");
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", "http://127.0.0.1:8431");
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT", "production");
    vi.stubEnv("PAPERCLIP_ANNOUNCEMENTS_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_TELEMETRY_DISABLED", "0");
    for (const profile of ["engineering", "production"]) {
      vi.stubEnv("PAPERCLIP_VECTOR_PROFILE", profile);
      expect(loadConfig()).toMatchObject({ telemetryEnabled: false, announcementsEnabled: false, announcementsFeedUrl: "" });
    }
  });
});
