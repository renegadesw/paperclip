import { Router } from "express";
import { forbidden } from "../errors.js";
import type { CloudInstanceEnv } from "../services/cloud-instance.js";

/** Kept for API compatibility; this fork has no Paperclip Cloud portfolio. */
export function cloudRoutes(_opts: {
  runtimeEnv?: CloudInstanceEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
} = {}) {
  const router = Router();
  router.get("/stacks", () => {
    throw forbidden("Paperclip Cloud is disabled in Vector", { code: "PAPERCLIP_CLOUD_DISABLED" });
  });
  return router;
}
