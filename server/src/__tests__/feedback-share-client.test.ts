import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeedbackTraceShareClientFromConfig } from "../services/feedback-share-client.js";

afterEach(() => vi.unstubAllGlobals());
describe("feedback trace sharing prohibition", () => {
  it.each([undefined, "https://telemetry.paperclip.ing", "https://custom.example.test", "http://127.0.0.1:9999", "not a URL"])(
    "rejects upload without I/O for backend %s", async (feedbackExportBackendUrl) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const client = createFeedbackTraceShareClientFromConfig({ feedbackExportBackendUrl, feedbackExportBackendToken: "test-token" });
      const bundle = {
      traceId: "trace-1",
      exportId: "export-1",
      companyId: "company-1",
      issueId: "issue-1",
      issueIdentifier: "PAP-1",
      adapterType: "codex_local",
      captureStatus: "full",
      notes: [],
      envelope: {},
      surface: null,
      paperclipRun: null,
      rawAdapterTrace: null,
      normalizedAdapterTrace: null,
      privacy: null,
      integrity: {},
      files: [],
    };
      await expect(client.uploadTraceBundle(bundle)).rejects.toMatchObject({ code: "PAPERCLIP_CLOUD_DISABLED" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
