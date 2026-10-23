import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@workloom/base/tenancy";

const state = vi.hoisted(() => ({
  app: null as unknown as pg.Pool,
  gateway: null as unknown as pg.Pool,
  owner: null as unknown as pg.Pool,
}));

vi.mock("@workloom/db", async (original) => {
  const actual = await original<typeof import("@workloom/db")>();
  return { ...actual, getAppPool: () => state.app, getGatewayPool: () => state.gateway, getOwnerPool: () => state.owner };
});

import { appRouter } from "./router.js";
import { registerIndustryQuestPlanner } from "../runtime/thread-runner.js";
import { resetToolExecutorCache } from "../runtime/tool-executor.js";
import { resetLlmAssembly } from "../service/llm.js";

/** Production entrypoints and real RLS are exercised only against an explicitly owned disposable PG cluster. */
const runPg = process.env.RUN_RUNTIME_ENTRYPOINT_DB_TESTS === "1";
const pgSuite = runPg ? describe : describe.skip;

pgSuite("thread execution entrypoints share industry planning, tool bridges and claim guards (MC-003)", () => {
  const stamp = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const a = { tenantId: `tenant-entry-${stamp}-a`, workspaceId: `ws-entry-${stamp}-a` };
  const b = { tenantId: `tenant-entry-${stamp}-b`, workspaceId: `ws-entry-${stamp}-b` };
  const presetKey = "entrypoint-inspection-agent";
  const plannerCalls: string[] = [];
  let fixtureDirectory = "";
  let modulePath = "";
  let callsPath = "";
  let counter = 0;
  const title = (prefix: string) => `执行 ${prefix} 巡检 marker-${stamp}-${++counter}`;
  const identity = (scope = a, role: Identity["role"] = "owner"): Identity => ({
    kind: "member", memberId: `${scope.workspaceId}-${role}`, memberNo: role === "owner" ? "MEM-001" : "MEM-003",
    name: "线程入口隔离测试", role, ...scope, plan: "pro",
  });
  const caller = (scope = a, role: Identity["role"] = "owner") => {
    const member = identity(scope, role);
    return appRouter.createCaller({ identity: member, session: member, partnerIdentity: null, headers: new Headers() });
  };
  const bridgeCalls = async (): Promise<Array<{ name: string; params: Record<string, unknown>; workspaceId: string }>> => {
    const raw = await readFile(callsPath, "utf8");
    return raw.trim() ? raw.trim().split("\n").map((line) => JSON.parse(line)) : [];
  };
  const executions = async (threadId: string) => (await state.owner.query<{ payload: Record<string, any> }>(
    "SELECT payload FROM biz_events WHERE workspace_id=$1 AND session_id=$2 AND payload->'decision'->>'kind'='execute' ORDER BY seq", [a.workspaceId, threadId],
  )).rows.map((row) => row.payload);
  const dispatch = (goal: string, immediate: boolean) => caller().threads.dispatch({ title: goal, presetKey, runImmediately: immediate });
  const queued = async (goal: string) => {
    const result = await dispatch(goal, false);
    if (result.kind !== "routed" || !result.threadId) throw new Error("Expected a routed thread");
    return result.threadId;
  };
  const assertDelivered = async (threadId: string, marker: string) => {
    const events = await executions(threadId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      who: { id: presetKey },
      decision: { tool: "evaluation.read", params: { marker }, after: { result: { marker, artifact: "fixture://inspection-result" } } },
      receipt: { synced: true, mode: "simulated", snapshot_uri: "fixture://inspection-result" },
    });
    const calls = await bridgeCalls();
    expect(calls).toEqual([{ name: "evaluation.read", params: { marker, delayMs: 0 }, workspaceId: a.workspaceId }]);
  };

  beforeAll(async () => {
    const databaseUrl = process.env.RUNTIME_ENTRYPOINT_TEST_DATABASE_URL;
    const expectedPgdata = process.env.RUNTIME_ENTRYPOINT_TEST_EXPECTED_PGDATA;
    if (!databaseUrl || !expectedPgdata) throw new Error("Explicit RUNTIME_ENTRYPOINT_TEST_DATABASE_URL and RUNTIME_ENTRYPOINT_TEST_EXPECTED_PGDATA are required");
    const url = new URL(databaseUrl);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.port) throw new Error("Entrypoint regression requires an explicit loopback database port");
    state.owner = new pg.Pool({ connectionString: databaseUrl });
    const target = (await state.owner.query("SELECT current_setting('data_directory') AS pgdata")).rows[0];
    if (await realpath(target.pgdata) !== await realpath(expectedPgdata)) throw new Error("Database target ownership mismatch");
    state.app = new pg.Pool({ connectionString: databaseUrl, options: "-c role=workloom_app", max: 12 });
    state.gateway = new pg.Pool({ connectionString: databaseUrl, options: "-c role=workloom_gateway" });
    expect((await state.app.query("SELECT current_user AS role")).rows[0]?.role).toBe("workloom_app");
    expect((await state.app.query("SELECT count(*)::int AS n FROM threads")).rows[0]?.n).toBe(0);
    for (const scope of [a, b]) {
      await state.owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'线程入口隔离测试','pro')", [scope.tenantId]);
      await state.owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'线程入口隔离测试',$1,'hotel','managed')", [scope.workspaceId, scope.tenantId]);
      await state.owner.query("INSERT INTO profiles(workspace_id,tenant_id,industry,archive) VALUES($1,$2,'hotel',$3)", [scope.workspaceId, scope.tenantId, JSON.stringify({ dataMode: "simulated", property: { name: "隔离夹具酒店" } })]);
      for (const role of ["owner", "readonly"] as const) {
        const member = identity(scope, role);
        await state.owner.query("INSERT INTO members(id,workspace_id,member_no,name,role) VALUES($1,$2,$3,$4,$5)", [member.memberId, scope.workspaceId, member.memberNo, member.name, role]);
      }
      await state.owner.query("INSERT INTO agents(id,workspace_id,preset_key,name,version,kind,fence_bindings,meta) VALUES($1,$2,$3,'隔离巡检员','v1','inspection',$4,$5)", [
        `${scope.workspaceId}-agent`, scope.workspaceId, presetKey, JSON.stringify(["R88101"]), JSON.stringify({ tools: [
          { name: "evaluation.read", access: "read", desc: "隔离巡检读取" },
          { name: "evaluation.write", access: "write", desc: "隔离巡检写入，必须审批" },
        ] }),
      ]);
      await state.owner.query("INSERT INTO fence_rules(id,rule_id,version,workspace_id,name,level,match_spec,action,is_baseline,status,created_by) VALUES($1,'R88101','v1',$2,'隔离写动作必审','review',$3,$4,false,'active','entrypoint-fixture')", [
        `${scope.workspaceId}-rule`, scope.workspaceId,
        JSON.stringify({ object_types: ["evaluation_record"], actions: ["evaluation.write"], when: "true" }), JSON.stringify({ result: "review" }),
      ]);
    }
    fixtureDirectory = await mkdtemp(join(tmpdir(), "workloom-entrypoint-fixture-"));
    callsPath = join(fixtureDirectory, "calls.jsonl");
    modulePath = join(fixtureDirectory, "bridge.mjs");
    await writeFile(callsPath, "");
    await writeFile(modulePath, `import { appendFile } from 'node:fs/promises';
export function createToolExecutorForScope(scope) {
  return async function(name, params) {
    await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({name, params, workspaceId: scope.workspaceId}) + '\\n');
    if (String(params.marker).includes('throw-bridge')) throw new Error('entrypoint fixture injected failure');
    if (params.delayMs) await new Promise(resolve => setTimeout(resolve, Number(params.delayMs)));
    return {result: {marker: params.marker, artifact: 'fixture://inspection-result'}, receipt: {synced: true, mode: 'simulated', snapshot_uri: 'fixture://inspection-result', verified_at: new Date().toISOString()}};
  };
}
`);
    vi.stubEnv("LLM_PROVIDER", "mock");
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("WORKLOOM_TOOL_EXECUTOR_MODULE", undefined);
    resetLlmAssembly();
  }, 30_000);

  beforeEach(async () => {
    vi.stubEnv("LLM_PROVIDER", "mock");
    resetLlmAssembly();
    plannerCalls.length = 0;
    await writeFile(callsPath, "");
    vi.stubEnv("WORKLOOM_TOOL_EXECUTOR_MODULES", `${modulePath}::::evaluation.read|evaluation.write`);
    resetToolExecutorCache();
    registerIndustryQuestPlanner((goal) => (_goal, preset) => {
      plannerCalls.push(goal);
      const write = goal.includes("review-write");
      const tool = write ? "evaluation.write" : "evaluation.read";
      if (!preset.tools.some((item) => item.name === tool)) throw new Error("Fixture tool not assembled");
      return [{ stepId: "s1", action: tool, objectType: "evaluation_record", tool,
        params: { marker: goal, delayMs: goal.includes("concurrent") ? 250 : 0 }, label: "隔离巡检 sentinel 步骤" }];
    });
  });

  afterAll(async () => {
    registerIndustryQuestPlanner(null);
    resetToolExecutorCache();
    resetLlmAssembly();
    vi.unstubAllEnvs();
    await Promise.all([state.app?.end(), state.gateway?.end(), state.owner?.end()]);
    // Only files created by this suite are removed; append-only DB evidence remains for inspection.
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
  });

  it("immediate dispatch consumes the registered industry plan and deployment bridge receipt", async () => {
    const goal = title("immediate");
    const result = await dispatch(goal, true);
    expect(result).toMatchObject({ kind: "routed", mode: "quest", status: "completed", stepsDone: 1, stepsTotal: 1 });
    if (result.kind !== "routed") throw new Error("Expected a routed thread");
    expect(plannerCalls).toEqual([goal]);
    await assertDelivered(result.threadId, goal);
  });

  it("manual run uses the same planner, bridge and attribution as immediate dispatch", async () => {
    const goal = title("manual");
    const threadId = await queued(goal);
    const result = await caller().threads.run({ threadId });
    expect(result).toMatchObject({ status: "completed", stepsDone: 1, stepsTotal: 1 });
    expect(plannerCalls).toEqual([goal]);
    await assertDelivered(threadId, goal);
  });

  it("reuses an existing persisted plan and executes it through the deployment bridge", async () => {
    const goal = title("persisted");
    const threadId = await queued(goal);
    await state.owner.query("UPDATE threads SET plan=$2::jsonb,plan_version=1 WHERE id=$1", [threadId, JSON.stringify([
      { stepId: "s1", action: "evaluation.read", objectType: "evaluation_record", tool: "evaluation.read", params: { marker: goal, delayMs: 0 }, label: "持久化的巡检步骤" },
    ])]);
    const result = await caller().threads.run({ threadId });
    expect(result).toMatchObject({ status: "completed", planReused: true });
    expect(plannerCalls).toEqual([]);
    await assertDelivered(threadId, goal);
  });

  it("claims the thread before planning so concurrent manual runs execute a tool only once", async () => {
    const goal = title("concurrent");
    const threadId = await queued(goal);
    const results = await Promise.all([caller().threads.run({ threadId }), caller().threads.run({ threadId })]);
    expect(results.map((item) => item.status).sort()).toEqual(["completed", "running"]);
    expect(plannerCalls).toEqual([goal]);
    expect(await bridgeCalls()).toHaveLength(1);
    expect(await executions(threadId)).toHaveLength(1);
  });

  it("does not re-execute a verified completed step when manually replayed", async () => {
    const goal = title("replay");
    const threadId = await queued(goal);
    expect((await caller().threads.run({ threadId })).status).toBe("completed");
    expect((await caller().threads.run({ threadId })).status).toBe("completed");
    expect(plannerCalls).toEqual([goal]);
    expect(await bridgeCalls()).toHaveLength(1);
    expect(await executions(threadId)).toHaveLength(1);
  });

  it("keeps an uncovered tool unverified instead of returning a simulated success", async () => {
    vi.stubEnv("WORKLOOM_TOOL_EXECUTOR_MODULES", `${modulePath}::::evaluation.other`);
    resetToolExecutorCache();
    const goal = title("uncovered");
    const threadId = await queued(goal);
    const result = await caller().threads.run({ threadId });
    expect(result.status).toBe("failed");
    if (!("unverified" in result)) throw new Error("Expected a Quest execution result");
    expect(result.unverified).toEqual(["s1"]);
    expect(await bridgeCalls()).toHaveLength(0);
    expect((await executions(threadId))[0]).toMatchObject({ receipt: { synced: false, mode: "real" }, decision: { after: { result: { state: "connector-required" } } } });
  });

  it("records bridge exceptions as a failed terminal event instead of fake completion", async () => {
    const goal = title("throw-bridge");
    const threadId = await queued(goal);
    const result = await caller().threads.run({ threadId });
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("entrypoint fixture injected failure") });
    expect((await executions(threadId))[0]).toMatchObject({ decision: { outcome: "error" }, receipt: { synced: false } });
  });

  it("requires approval for the write step and resumes the same persisted plan after approval", async () => {
    const goal = title("review-write");
    const threadId = await queued(goal);
    const pending = await caller().threads.run({ threadId });
    expect(pending.status).toBe("pending_review");
    expect(await bridgeCalls()).toHaveLength(0);
    if (!("pendingApprovalId" in pending) || !pending.pendingApprovalId) throw new Error("Expected a step approval");
    await caller().approvals.decide({ approvalId: pending.pendingApprovalId, gesture: "approve" });
    const result = await caller().threads.run({ threadId });
    expect(result).toMatchObject({ status: "completed", planReused: true });
    expect(plannerCalls).toEqual([goal]);
    expect(await bridgeCalls()).toHaveLength(1);
    expect((await executions(threadId))[0]?.receipt).toMatchObject({ synced: true, mode: "simulated" });
  });

  it("preserves agent mode step confirmation when manually running a queued task", async () => {
    const goal = `逐步${title("agent-mode")}`;
    const dispatched = await dispatch(goal, true);
    expect(dispatched).toMatchObject({ kind: "routed", mode: "agent", status: "queued" });
    if (dispatched.kind !== "routed") throw new Error("Expected a routed thread");
    const pending = await caller().threads.run({ threadId: dispatched.threadId });
    expect(pending.status).toBe("pending_review");
    expect(await bridgeCalls()).toHaveLength(0);
    if (!("pendingApprovalId" in pending) || !pending.pendingApprovalId) throw new Error("Expected per-step agent confirmation");
    await caller().approvals.decide({ approvalId: pending.pendingApprovalId, gesture: "approve" });
    expect((await caller().threads.run({ threadId: dispatched.threadId })).status).toBe("completed");
    expect(await bridgeCalls()).toHaveLength(1);
  });

  it("rejects readonly dispatch and cross-tenant manual run before tool execution", async () => {
    await expect(caller(a, "readonly").threads.dispatch({ title: title("readonly"), presetKey, runImmediately: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const threadId = await queued(title("tenant-boundary"));
    await expect(caller(b).threads.run({ threadId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await bridgeCalls()).toHaveLength(0);
  });

  it("rejects overlong titles without creating or executing a thread", async () => {
    const before = (await state.owner.query("SELECT count(*)::int AS n FROM threads WHERE workspace_id=$1", [a.workspaceId])).rows[0].n;
    await expect(dispatch("执行".repeat(251), true)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await state.owner.query("SELECT count(*)::int AS n FROM threads WHERE workspace_id=$1", [a.workspaceId])).rows[0].n).toBe(before);
    expect(await bridgeCalls()).toHaveLength(0);
  });

  it("keeps real HTTP planner usage scoped to the tenant and records the selected physical model", async () => {
    const goal = title("loopback-model");
    const threadId = await queued(goal);
    const requests: string[] = [];
    const server = createServer(async (req, res) => {
      try {
        res.setHeader("content-type", "application/json");
        if (req.method === "GET" && req.url === "/v1/models") {
          res.end(JSON.stringify({ data: [{ id: "deepseek-flash" }] }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push(body.model);
        if (req.method !== "POST" || req.url !== "/v1/chat/completions" || body.model !== "deepseek-flash") {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Unexpected local planner request" }));
          return;
        }
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
          { action: "evaluation.read", objectType: "evaluation_record", tool: "evaluation.read", params: { marker: goal, delayMs: 0 }, label: "HTTP 夹具规划的巡检步骤" },
        ]) } }], usage: { prompt_tokens: 120, completion_tokens: 40 } }));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(error) }));
      }
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local planner address");
    try {
      vi.stubEnv("LLM_PROVIDER", "deepseek");
      vi.stubEnv("LLM_MODEL", "deepseek-flash");
      vi.stubEnv("LLM_API_KEY", "");
      vi.stubEnv("LLM_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
      resetLlmAssembly();
      const result = await caller().threads.run({ threadId });
      expect(result.status).toBe("completed");
      expect(requests).toEqual(["deepseek-flash"]);
      expect(plannerCalls).toEqual([]);
      await assertDelivered(threadId, goal);
      const calls = await state.owner.query<{ payload: Record<string, any> }>(
        "SELECT payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND payload->'decision'->>'action'='model.call' ORDER BY seq DESC LIMIT 1", [a.tenantId, a.workspaceId],
      );
      expect(calls.rows[0]?.payload).toMatchObject({
        context: { tenant_id: a.tenantId, workspace_id: a.workspaceId },
        decision: { after: { action: "quest-plan", scene: "quest-plan" } },
        model_trace: { model_id: "deepseek-flash" },
      });
    } finally {
      vi.stubEnv("LLM_PROVIDER", "mock");
      resetLlmAssembly();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
