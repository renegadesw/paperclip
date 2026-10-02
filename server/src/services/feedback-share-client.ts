import { PaperclipCloudDisabledError } from "@paperclipai/shared/paperclip-cloud-policy";
import type { FeedbackTraceBundle } from "@paperclipai/shared";
import type { Config } from "../config.js";

export interface FeedbackTraceShareClient {
  uploadTraceBundle(bundle: FeedbackTraceBundle): Promise<{ objectKey: string }>;
}

/** Local feedback and downloads remain available; external sharing is prohibited. */
export function createFeedbackTraceShareClientFromConfig(
  _config: Pick<Config, "feedbackExportBackendUrl" | "feedbackExportBackendToken">,
): FeedbackTraceShareClient {
  return {
    async uploadTraceBundle() {
      throw new PaperclipCloudDisabledError();
    },
  };
}
