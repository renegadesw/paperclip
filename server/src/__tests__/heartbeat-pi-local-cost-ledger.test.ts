import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.js";

// Vector's runs are pi_local over Pi RPC through the router. Paperclip's run
// ledger, not a Vector-side meter, must record their tokens, model, and cost.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function writeUsagePi(commandPath: string): Promise<void> {
  await fs.writeFile(commandPath, `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("router    Qwen3.8-Flash");
  process.exit(0);
}
let handled = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (handled || !chunk.includes("\\n")) return;
  handled = true;
  const command = JSON.parse(chunk.slice(0, chunk.indexOf("\\n")));
  console.log(JSON.stringify({ type: "response", command: "prompt", success: true, id: command.id }));
  for (const usage of [
    { input: 1200, output: 340, cacheRead: 100, cost: { total: 0.25 } },
    { input: 800, output: 60, cacheRead: 0, cost: { total: 0.1 } },
  ]) {
    console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage }, toolResults: [] }));
  }
  console.log(JSON.stringify({ type: "agent_settled" }));
});
process.stdin.on("end", () => process.exit(0));
`, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function waitForRun(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("pi_local RPC cost ledger", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let root = "";
  const saved = { ...process.env };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-pi-local-cost-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-cost-"));
  }, 30_000);

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await tempDb?.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("records input/output tokens, model, and cost for a Standard pi_local RPC run", async () => {
    const commandPath = path.join(root, "pi");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await writeUsagePi(commandPath);
    Object.assign(process.env, {
      PAPERCLIP_VECTOR_PROFILE: "standard",
      PAPERCLIP_VECTOR_PI_COMMAND: commandPath,
    });

    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Cost ledger",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Standard Chat",
      role: "standard-chat",
      status: "idle",
      adapterType: "pi_local",
      adapterConfig: {
        command: commandPath,
        cwd: workspace,
        model: "router/Qwen3.8-Flash",
        executionMode: "rpc",
        promptTemplate: "Answer.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRun(heartbeat, queued!.id);
    expect(finished?.status, JSON.stringify(finished?.error ?? null)).toBe("succeeded");

    // The ledger is written as the run finalizes; settle the execution before reading it.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const rows = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, queued!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      agentId,
      provider: "router",
      model: "router/Qwen3.8-Flash",
      inputTokens: 2000,
      outputTokens: 400,
      cachedInputTokens: 100,
      costCents: 35,
    });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
    expect(run?.agentId).toBe(agentId);
  }, 30_000);
});
