import { createHash, createHmac, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createVectorScheduleRoutineDispatcher,
  vectorScheduleRoutineDispatcherFromEnv,
} from "./vector-schedule-routine-dispatch.js";

describe("Vector schedule routine dispatch", () => {
  it("sends only sealed schedule identity and installation scope", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      const timestamp = String((init?.headers as Record<string, string>)["x-paperclip-timestamp"]);
      const digest = createHash("sha256").update(body).digest("hex");
      const expected = `v1=${createHmac("sha256", "abcdef0123456789abcdef0123456789")
        .update(`POST\n/internal/paperclip/schedules/dispatch\n${timestamp}\n${digest}`)
        .digest("hex")}`;
      expect((init?.headers as Record<string, string>)["x-paperclip-signature"]).toBe(expected);
      expect(JSON.parse(body)).toEqual(expect.objectContaining({
        installationId: "stg1-staging",
        profile: "staging",
        companyId: "0f6d6b20-b9dd-43fc-8d48-5f8f65c6e047",
        scheduleKey: "fa_research_daily",
      }));
      expect(body).not.toContain("cron");
      expect(body).not.toContain("target");
      expect(body).not.toContain("parameter");
      return new Response(JSON.stringify({
        accepted: true, skipped: false, duplicate: false, state: "accepted", reason: "accepted",
      }), { status: 202 });
    });
    const dispatcher = createVectorScheduleRoutineDispatcher({
      url: "http://127.0.0.1:8430/internal/paperclip/schedules/dispatch",
      secret: "abcdef0123456789abcdef0123456789",
      installationId: "stg1-staging",
      profile: "staging",
      companyId: "0f6d6b20-b9dd-43fc-8d48-5f8f65c6e047",
      now: () => 1_700_000_000_000,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(dispatcher.dispatch({
      routineRunId: randomUUID(), routineId: randomUUID(), triggerId: randomUUID(),
      companyId: "0f6d6b20-b9dd-43fc-8d48-5f8f65c6e047", scheduleKey: "fa_research_daily",
    })).resolves.toEqual({
      accepted: true, skipped: false, duplicate: false, state: "accepted", reason: "accepted",
    });
  });

  it("rejects non-loopback URLs, non-staging scope and partial configuration", () => {
    expect(() => createVectorScheduleRoutineDispatcher({
      url: "https://example.com/internal/paperclip/schedules/dispatch",
      secret: "abcdef0123456789abcdef0123456789",
      installationId: "stg1-staging", profile: "staging", companyId: randomUUID(),
    })).toThrow("exact loopback");
    expect(() => createVectorScheduleRoutineDispatcher({
      url: "http://127.0.0.1:8430/internal/paperclip/schedules/dispatch",
      secret: "abcdef0123456789abcdef0123456789",
      installationId: "stecke1-standard", profile: "standard", companyId: randomUUID(),
    })).toThrow("staging installation scope");
    expect(() => vectorScheduleRoutineDispatcherFromEnv({
      PAPERCLIP_VECTOR_SCHEDULE_DISPATCH_URL: "http://127.0.0.1:8430/internal/paperclip/schedules/dispatch",
    })).toThrow("configured together");
  });
});
