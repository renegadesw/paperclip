import { afterEach, describe, expect, it, vi } from "vitest";
import extension from "../vector-extensions/paperclip-coordination.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function tool(origin = "http://127.0.0.1:3100/api/") {
  for (const [key, value] of Object.entries({ PAPERCLIP_API_URL: origin, PAPERCLIP_API_KEY: "private-run-key", PAPERCLIP_COMPANY_ID: "company-a", PAPERCLIP_AGENT_ID: "agent-a", PAPERCLIP_RUN_ID: "run-a" })) vi.stubEnv(key, value);
  const registered: any[] = [];
  const events: any[] = [];
  extension({ registerTool: (t: any) => registered.push(t), on: (_: string, cb: any) => events.push(cb) } as any);
  return { run: registered[0].execute, events };
}
describe("native Paperclip coordination", () => {
  it("uses the company route and run credentials without duplicating /api", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json([{ id: "agent-a" }])); vi.stubGlobal("fetch", fetchMock);
    const t = tool(); await t.run("c", { action: "agents" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:3100/api/companies/company-a/agents");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error", headers: { authorization: "Bearer private-run-key", "X-Paperclip-Run-Id": "run-a" } });
    expect(t.events[0]({ systemPrompt: "base" }).systemPrompt).toContain("native paperclip tool");
  });
  it("checks out only as this agent and treats conflicts as errors without retrying", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "Checkout conflict" }, { status: 409 })); vi.stubGlobal("fetch", fetchMock);
    const result = await tool().run("c", { action: "checkout", id: "VECA-12", body: { agentId: "other", expectedStatuses: ["todo"] } });
    expect(result.isError).toBe(true); expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).toEqual({ agentId: "agent-a", expectedStatuses: ["todo"] });
    expect(result.content[0].text).toContain("HTTP 409");
  });
  it("encodes filters and refuses path escape or arbitrary actions", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json([])); vi.stubGlobal("fetch", fetchMock);
    const t = tool();
    await t.run("c", { action: "issues", query: { projectId: "p-1", q: "a&status=done" } });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("q")).toBe("a&status=done");
    for (const args of [{ action: "issue", id: "../../companies/b" }, { action: "fetch", id: "https://evil.test" }, { action: "issues", query: { companyId: "b" } }]) expect((await t.run("c", args)).isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("bounds context and does not echo credentials or transport errors", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('private-run-key')).mockResolvedValueOnce(new Response('x'.repeat(25000))).mockRejectedValueOnce(new Error('private-run-key'));
    vi.stubGlobal("fetch", fetchMock); const t = tool();
    for (let n = 0; n < 3; n++) {
      const result = await t.run("c", { action: "issue", id: "i-1" });
      expect(JSON.stringify(result)).not.toContain("private-run-key");
      expect(result.content[0].text.length).toBeLessThan(1000);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("does not register without run authority and rejects credential-bearing origins", () => {
    vi.stubEnv("PAPERCLIP_API_KEY", ""); const registerTool = vi.fn();
    extension({ registerTool } as any); expect(registerTool).not.toHaveBeenCalled();
    expect(() => tool("http://user:password@host")).toThrow("Invalid Paperclip API origin");
  });
});
