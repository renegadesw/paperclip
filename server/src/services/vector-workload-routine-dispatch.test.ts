import { createHash, createHmac, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createVectorWorkloadRoutineDispatcher,
  vectorWorkloadRoutineDispatcherFromEnv,
} from "./vector-workload-routine-dispatch.js";

describe("Vector workload routine dispatch", () => {
  it("sends a scope-bound exact-body HMAC without caller authority", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      const timestamp = String((init?.headers as Record<string, string>)["x-paperclip-timestamp"]);
      const digest = createHash("sha256").update(body).digest("hex");
      const expected = `v1=${createHmac("sha256", "0123456789abcdef0123456789abcdef")
        .update(`POST\n/internal/paperclip/workloads/dispatch\n${timestamp}\n${digest}`)
        .digest("hex")}`;
      expect((init?.headers as Record<string, string>)["x-paperclip-signature"]).toBe(expected);
      expect(JSON.parse(body)).toEqual(expect.objectContaining({
        installationId: "stg1-staging",
        profile: "staging",
        companyId: "0f6d6b20-b9dd-43fc-8d48-5f8f65c6e047",
        queue: "research",
      }));
      expect(body).not.toContain("token");
      return new Response(JSON.stringify({ claimed: 1, duplicate: false, state: "done" }), { status: 200 });
    });
    const dispatcher = createVectorWorkloadRoutineDispatcher({
      url: "http://127.0.0.1:8430/internal/paperclip/workloads/dispatch",
      secret: "0123456789abcdef0123456789abcdef",
      installationId: "stg1-staging",
      profile: "staging",
      companyId: "0f6d6b20-b9dd-43fc-8d48-5f8f65c6e047",
      now: () => 1_700_000_000_000,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(dispatcher.dispatch({
      routineRunId: randomUUID(), routineId: randomUUID(), triggerId: randomUUID(),
      companyId: "0f6d6b20-b9dd-43fc-8d48-5f8f65c6e047", queue: "research",
    })).resolves.toEqual({ claimed: 1, duplicate: false, state: "done" });
  });

  it("rejects non-loopback URLs and partial environment configuration", () => {
    expect(() => createVectorWorkloadRoutineDispatcher({
      url: "https://example.com/internal/paperclip/workloads/dispatch",
      secret: "0123456789abcdef0123456789abcdef",
      installationId: "stg1-staging", profile: "staging", companyId: randomUUID(),
    })).toThrow("exact loopback");
    expect(() => vectorWorkloadRoutineDispatcherFromEnv({
      PAPERCLIP_VECTOR_WORKLOAD_DISPATCH_URL: "http://127.0.0.1:8430/internal/paperclip/workloads/dispatch",
    })).toThrow("configured together");
  });
});
