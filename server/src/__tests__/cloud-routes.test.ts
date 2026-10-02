import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { cloudRoutes } from "../routes/cloud.js";

const cloudEnv = {
  PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-secret",
  PAPERCLIP_CLOUD_STACK_ID: "stack-current",
  PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.test/control-plane",
};

function cloudActor(userId: string) {
  return {
    type: "board" as const,
    source: "cloud_tenant" as const,
    userId,
    companyIds: ["company-1"],
  };
}

function createApp(options: {
  actor?: ReturnType<typeof cloudActor> | {
    type: "board";
    source: "session";
    userId: string;
  };
  runtimeEnv?: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  now?: () => number;
}) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = options.actor ?? cloudActor("actor-user");
    next();
  });
  app.use("/api/cloud", cloudRoutes({
    runtimeEnv: options.runtimeEnv ?? cloudEnv,
    fetchImpl: options.fetchImpl,
    now: options.now,
  }));
  app.use(errorHandler);
  return app;
}

describe("GET /api/cloud/stacks", () => {
  it.each([{}, cloudEnv])("refuses the portfolio even with managed tenant credentials", async (runtimeEnv) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = createApp({ runtimeEnv, fetchImpl });
    const response = await request(app).get("/api/cloud/stacks?userId=spoofed").set("authorization", "Bearer client-token");
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("PAPERCLIP_CLOUD_DISABLED");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain("tenant-secret");
  });
});
