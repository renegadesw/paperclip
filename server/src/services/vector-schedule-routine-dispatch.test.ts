import { createHash, createHmac, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createVectorScheduleRoutineDispatcher,
  RETIRED_VECTOR_SCHEDULE_KEYS,
  type VectorScheduleKey,
  vectorScheduleRoutineDispatcherFromEnv,
} from "./vector-schedule-routine-dispatch.js";

describe("Vector schedule routine dispatch", () => {
  it.each([
    ["stg1-staging", "staging"],
    ["vector-os-production", "production"],
  ] as const)("sends only sealed schedule identity and %s installation scope", async (installationId, profile) => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      const timestamp = String((init?.headers as Record<string, string>)["x-paperclip-timestamp"]);
      const digest = createHash("sha256").update(body).digest("hex");
      const expected = `v1=${createHmac("sha256", "abcdef0123456789abcdef0123456789")
        .update(`POST\n/inbound/paperclip/schedules/dispatch\n${timestamp}\n${digest}`)
        .digest("hex")}`;
      expect((init?.headers as Record<string, string>)["x-paperclip-signature"]).toBe(expected);
      expect(JSON.parse(body)).toEqual(expect.objectContaining({
        installationId,
        profile,
        companyId: "0f6d6b20-b9dd-43fc-8d48-5f8f65c6e047",
        scheduleKey: "fa_rollup_query_themes",
      }));
      expect(body).not.toContain("cron");
      expect(body).not.toContain("target");
      expect(body).not.toContain("parameter");
      return new Response(JSON.stringify({
        accepted: true, skipped: false, duplicate: false, state: "accepted", reason: "accepted",
      }), { status: 202 });
    });
    const dispatcher = createVectorScheduleRoutineDispatcher({
      url: "http://127.0.0.1:8430/inbound/paperclip/schedules/dispatch",
      secret: "abcdef0123456789abcdef0123456789",
      installationId,
      profile,
      companyId: "0f6d6b20-b9dd-43fc-8d48-5f8f65c6e047",
      now: () => 1_700_000_000_000,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(dispatcher.dispatch({
      routineRunId: randomUUID(), routineId: randomUUID(), triggerId: randomUUID(),
      companyId: "0f6d6b20-b9dd-43fc-8d48-5f8f65c6e047", scheduleKey: "fa_rollup_query_themes",
    })).resolves.toEqual({
      accepted: true, skipped: false, duplicate: false, state: "accepted", reason: "accepted",
    });
  });

  it("rejects non-loopback URLs, non-Funky-server scope and partial configuration", () => {
    expect(() => createVectorScheduleRoutineDispatcher({
      url: "https://example.com/inbound/paperclip/schedules/dispatch",
      secret: "abcdef0123456789abcdef0123456789",
      installationId: "stg1-staging", profile: "staging", companyId: randomUUID(),
    })).toThrow("exact loopback");
    expect(() => createVectorScheduleRoutineDispatcher({
      url: "http://127.0.0.1:8430/inbound/paperclip/schedules/dispatch",
      secret: "abcdef0123456789abcdef0123456789",
      installationId: "stecke1-standard", profile: "standard", companyId: randomUUID(),
    })).toThrow("Funky server (staging or production) installation scope");
    expect(() => createVectorScheduleRoutineDispatcher({
      url: "http://127.0.0.1:8430/inbound/paperclip/schedules/dispatch",
      secret: "abcdef0123456789abcdef0123456789",
      installationId: "t480-engineering", profile: "engineering", companyId: randomUUID(),
    })).toThrow("Funky server (staging or production) installation scope");
    expect(() => createVectorScheduleRoutineDispatcher({
      url: "http://127.0.0.1:8430/inbound/paperclip/schedules/dispatch",
      secret: "abcdef0123456789abcdef0123456789",
      installationId: "vector-os-production", profile: "Production", companyId: randomUUID(),
    })).toThrow("Funky server (staging or production) installation scope");
    expect(() => vectorScheduleRoutineDispatcherFromEnv({
      PAPERCLIP_VECTOR_SCHEDULE_DISPATCH_URL: "http://127.0.0.1:8430/inbound/paperclip/schedules/dispatch",
    })).toThrow("configured together");
  });

  it("refuses the schedules the native research routines replaced, without calling Vector OS", async () => {
    const fetchImpl = vi.fn();
    const companyId = "0f6d6b20-b9dd-43fc-8d48-5f8f65c6e047";
    const dispatcher = createVectorScheduleRoutineDispatcher({
      url: "http://127.0.0.1:8430/inbound/paperclip/schedules/dispatch",
      secret: "abcdef0123456789abcdef0123456789",
      installationId: "prod1-production",
      profile: "production",
      companyId,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for (const scheduleKey of RETIRED_VECTOR_SCHEDULE_KEYS) {
      await expect(dispatcher.dispatch({
        routineRunId: randomUUID(), routineId: randomUUID(), companyId,
        scheduleKey: scheduleKey as unknown as VectorScheduleKey,
      })).rejects.toThrow("Unsupported Vector schedule key");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
