/** MC-004 integration: actual tRPC/router/model transport, disposable PostgreSQL/RLS. No paid model calls. */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@workloom/base/tenancy";

const state = vi.hoisted(() => ({ app: null as unknown as pg.Pool, gateway: null as unknown as pg.Pool, owner: null as unknown as pg.Pool }));
vi.mock("@workloom/db", async (original) => ({
  ...await original<typeof import("@workloom/db")>(),
  getAppPool: () => state.app, getGatewayPool: () => state.gateway, getOwnerPool: () => state.owner,
}));

import { appRouter } from "./router.js";
import { registerIndustryQuestPlanner, runQuestForThread } from "../runtime/thread-runner.js";
import { resetLlmAssembly } from "../service/llm.js";

const database = process.env.RUN_HOTEL_ENTRYPOINT_DB_TESTS === "1" ? describe : describe.skip;
interface Fixture { tenantId: string; workspaceId: string }
type RequestBody = { model: string; messages: Array<{ content: string }> };
type DeliveryInput = { goal: string; step: { id: string; presetKey: string }; sources: Array<{ id: string }>; predecessors: Array<{ eventId: string; text: string }> };

database("Hotel document delivery shares the real router, RLS, scoped model sink and research configuration", () => {
  let server: Server;
  let base: string;
  let requests: Array<{ path: string; body: any }> = [];
  let failSearch = false;
  let holdWorker: Promise<void> | null = null;
  const created: Fixture[] = [];
  const parse = (prompt: string): DeliveryInput => JSON.parse(/<hotel_delivery_input>\s*([\s\S]*?)\s*<\/hotel_delivery_input>/.exec(prompt)![1]!);
  const member = (scope: Fixture, role: Identity["role"] = "owner"): Identity => ({
    kind: "member", memberId: `${scope.workspaceId}-${role}`, memberNo: role === "owner" ? "MEM-001" : "MEM-003",
    name: "酒店交付路由隔离测试", role, ...scope, plan: "pro",
  });
  const caller = (scope: Fixture, role: Identity["role"] = "owner") => {
    const identity = member(scope, role);
    return appRouter.createCaller({ identity, session: identity, partnerIdentity: null, headers: new Headers() });
  };
  const modelRequests = () => requests.filter((request) => request.path === "/v1/chat/completions");
  const thread = async (id: string) => (await state.owner.query<{ plan: any; status: string }>("SELECT plan,status FROM threads WHERE id=$1", [id])).rows[0]!;
  const events = async (scope: Fixture, threadId: string) => (await state.owner.query<{ payload: any; session_id: string }>(
    "SELECT payload,session_id FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND session_id=$3 ORDER BY seq", [scope.tenantId, scope.workspaceId, threadId],
  )).rows.map((row) => row.payload);
  const dispatch = (scope: Fixture, title: string, immediate = true, extra: { goalRef?: string; presetKey?: string } = {}) => caller(scope).threads.dispatch({
    title, presetKey: extra.presetKey ?? "pricing-agent", runImmediately: immediate, ...(extra.goalRef ? { goalRef: extra.goalRef } : {}),
  });
  const routed = <T extends { kind: string }>(value: T): T & { threadId: string } => {
    if (value.kind !== "routed" || !("threadId" in value) || typeof value.threadId !== "string") throw new Error("Expected routed delivery");
    return value as T & { threadId: string };
  };

  beforeAll(async () => {
    const url = process.env.HOTEL_ENTRYPOINT_TEST_DATABASE_URL;
    const expected = process.env.HOTEL_ENTRYPOINT_TEST_EXPECTED_PGDATA;
    if (!url || !expected) throw new Error("Explicit task-owned PostgreSQL URL and data-directory guard required");
    const parsed = new URL(url);
    if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55439" || !parsed.pathname.startsWith("/workloom_hotel_")) throw new Error("Refusing a database outside the task-owned loopback fixture");
    state.owner = new pg.Pool({ connectionString: url });
    const directory = (await state.owner.query("SHOW data_directory")).rows[0].data_directory;
    if (realpathSync(directory) !== realpathSync(expected) || !resolve(expected).endsWith("/work/runtime-state/pgdata")) throw new Error("Database ownership guard failed");
    state.app = new pg.Pool({ connectionString: url, options: "-c role=workloom_app", max: 12 });
    state.gateway = new pg.Pool({ connectionString: url, options: "-c role=workloom_gateway", max: 4 });
    expect((await state.app.query("SELECT current_user AS role")).rows[0].role).toBe("workloom_app");
    expect((await state.app.query("SELECT count(*)::int AS n FROM threads")).rows[0].n).toBe(0);
    server = createServer(async (request, response) => {
      try {
        response.setHeader("content-type", "application/json");
        if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "deepseek-flash" }] })); return; }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push({ path: request.url!, body });
        if (request.url === "/v1/tools/search") {
          response.statusCode = failSearch ? 503 : 200;
          response.end(JSON.stringify(failSearch ? { error: "fixture search failure" } : { results: [{
            url: "https://example.org/official-hotel-report", title: "酒店经营公开资料", summary: "这是隔离HTTP夹具提供的公开资料，仅用于测试引用回执，不是实时酒店经营证据。", date: "2026-10-24",
          }] })); return;
        }
        const prompt = (body as RequestBody).messages[0]!.content;
        let content: string;
        if (prompt.includes("你是意图路由器")) content = JSON.stringify({ mode: "quest", rationale: "隔离HTTP分类夹具" });
        else if (prompt.includes("hotel_delivery_input")) {
          const input = parse(prompt);
          if (!input.step) content = JSON.stringify({ steps: [
            { id: "pricing", presetKey: "pricing-agent", goal: "形成收益分析报告草稿", dependsOn: [] },
            { id: "finance", presetKey: "reconcile-agent", goal: "结合收益报告形成财务风险分析清单", dependsOn: ["pricing"] },
          ] });
          else {
            if (holdWorker) await holdWorker;
            content = JSON.stringify({ title: "隔离酒店岗位分析报告", text: "本报告以已提供的酒店资料为依据，只形成内部分析与草稿。".repeat(8)
              + "末尾完整成果标记。财务岗位将读取前序真实产物后核对交接内容；当前资料不足以证明最新外部房价、退款状态或实际经营结果，采用建议前仍需店长核对原始凭证。",
              sourceIds: [...new Set([input.sources[0]!.id, ...input.sources.filter((source) => source.id.startsWith("web:")).map((source) => source.id), ...input.predecessors.map((item) => item.eventId)])],
              missingData: ["实时渠道报价未提供"], humanDecisions: ["经营动作须由负责人另行决定"],
            });
          }
        } else content = JSON.stringify([{ action: "pms.price.read", objectType: "room_rate", tool: "pms.price.read", params: {}, label: "普通业务读取夹具" }]);
        response.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 120, completion_tokens: 300 } }));
      } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); }
    });
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture not bound");
    base = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  beforeEach(() => {
    requests = []; failSearch = false; holdWorker = null;
    vi.stubEnv("LLM_PROVIDER", "deepseek"); vi.stubEnv("LLM_MODEL", "deepseek-flash");
    vi.stubEnv("LLM_BASE_URL", `${base}/v1`); vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("DEEPSEEK_SEARCH_ENABLED", "0");
    vi.stubEnv("HOTEL_DELIVERY_MAX_WORKERS_PER_RUN", "5");
    resetLlmAssembly();
  });
  afterAll(async () => {
    registerIndustryQuestPlanner(null); resetLlmAssembly(); vi.unstubAllEnvs();
    if (server) { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); }
    await Promise.all([state.app?.end(), state.gateway?.end(), state.owner?.end()]);
    // Only unique fixture tenants/workspaces are added. Their append-only evidence stays for inspection.
  });

  async function fixture(industry = "hotel"): Promise<Fixture> {
    const stamp = randomUUID();
    const scope = { tenantId: `he-tenant-${stamp}`, workspaceId: `he-ws-${stamp}` }; created.push(scope);
    await state.owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Hotel entrypoint fixture','pro')", [scope.tenantId]);
    await state.owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'Hotel entrypoint fixture',$1,$3,'managed')", [scope.workspaceId, scope.tenantId, industry]);
    await state.owner.query("INSERT INTO profiles(workspace_id,tenant_id,industry,archive) VALUES($1,$2,$3,$4)", [scope.workspaceId, scope.tenantId, industry, JSON.stringify({ property: { name: "隔离测试酒店", rooms: 86 }, business: { floor_price: 380 }, dataMode: "simulated" })]);
    for (const role of ["owner", "readonly"] as const) {
      const identity = member(scope, role);
      await state.owner.query("INSERT INTO members(id,workspace_id,member_no,name,role) VALUES($1,$2,$3,$4,$5)", [identity.memberId, scope.workspaceId, identity.memberNo, identity.name, role]);
    }
    for (const preset of ["pricing-agent", "reconcile-agent", "competitor-agent"]) await state.owner.query(
      "INSERT INTO agents(id,workspace_id,preset_key,name,version,kind,status,fence_bindings,meta) VALUES($1,$2,$3,'酒店岗位','fixture-v1','delivery','ready','[]',$4)",
      [`${scope.workspaceId}-${preset}`, scope.workspaceId, preset, JSON.stringify({ prompt: `隔离酒店岗位提示词:${preset}`, tools: [{ name: "pms.price.read", access: "read", desc: "读取价格" }] })],
    );
    return scope;
  }

  it("single immediate delivery uses one model call without classification, and meters the same thread", async () => {
    const scope = await fixture();
    const result = routed(await dispatch(scope, "单员工形成入住率内部分析报告"));
    expect(result).toMatchObject({ kind: "routed", mode: "quest", via: "rule", status: "completed", stepsDone: 1 });
    expect(modelRequests()).toHaveLength(1);
    expect(modelRequests()[0]!.body.messages[0].content).not.toContain("你是意图路由器");
    const saved = await thread(result.threadId);
    expect(saved.plan).toMatchObject({ schema: "workloom.hotel-delivery/v1", goal: "单员工形成入住率内部分析报告" });
    const ledger = await events(scope, result.threadId);
    expect(ledger.filter((event) => event.decision.action === "model.call")).toHaveLength(1);
    expect(ledger.find((event) => event.decision.action === "model.call").model_trace.model_id).toBe("deepseek-flash");
    expect(ledger.find((event) => event.decision.action === "ask.answer").decision.after.text).toContain("末尾完整成果标记");
    expect(ledger.some((event) => event.decision.kind === "execute")).toBe(false);
  });

  it("collaboration actually consumes predecessor outputs and returns all durable worker links", async () => {
    const scope = await fixture();
    const result = routed(await dispatch(scope, "多员工协作完成收益与财务内部分析报告"));
    expect(result).toMatchObject({ status: "completed", stepsDone: 2, stepsTotal: 2 });
    expect(modelRequests()).toHaveLength(3);
    const ledger = await events(scope, result.threadId);
    const workers = ledger.filter((event) => event.decision.after?.delivery?.kind === "worker");
    expect(workers.map((event) => event.who.id)).toEqual(["pricing-agent", "reconcile-agent"]);
    const last = parse(modelRequests()[2]!.body.messages[0].content);
    expect(last.predecessors[0]).toMatchObject({ eventId: workers[0].event_id, text: workers[0].decision.after.text });
    expect(ledger.find((event) => event.decision.after?.delivery?.kind === "summary").links).toEqual(workers.map((event) => event.event_id));
  });

  it("queues the entire goalRef snapshot, ignores mutable archive changes and restores it when asked to continue", async () => {
    const scope = await fixture();
    const fullGoal = `单员工撰写入住率内部分析报告：${"必须逐项核对经营资料，不执行外部动作。".repeat(50)}末尾完整目标标记`;
    await state.owner.query("UPDATE profiles SET archive=archive || $2::jsonb WHERE workspace_id=$1", [scope.workspaceId, JSON.stringify({ goals: { longBrief: { text: fullGoal, version: "fixture-v7" } } })]);
    const queued = routed(await dispatch(scope, "执行档案中的完整目标", false, { goalRef: "longBrief" }));
    expect(queued).toMatchObject({ status: "queued", via: "rule" });
    expect(modelRequests()).toHaveLength(0);
    await state.owner.query("UPDATE profiles SET archive=jsonb_set(archive,'{goals,longBrief,text}','\"已被改写的档案\"') WHERE workspace_id=$1", [scope.workspaceId]);
    expect((await caller(scope).threads.run({ threadId: queued.threadId, goal: "继续" })).status).toBe("completed");
    expect((await thread(queued.threadId)).plan.goal).toBe(fullGoal);
    expect(modelRequests()[0]!.body.messages[0].content).toContain("末尾完整目标标记");
    const ledger = await events(scope, queued.threadId);
    expect(ledger.find((event) => event.decision.action === "thread.dispatch").decision.after).toMatchObject({ goal_text: fullGoal, goal_ref: "longBrief", goal_ref_version: "fixture-v7" });
  });

  it("does not persist provider secrets or phone numbers in the Hotel title, dispatch brief, plan or model request", async () => {
    const scope = await fixture();
    const privateKey = "sk-fixture-private-dispatch-marker-123456789";
    const privatePhone = "13800000001";
    const title = `单员工形成内部分析报告，联系${privatePhone}，误粘凭据${privateKey}`;
    const goal = `单员工形成入住率内部分析报告；${"保留完整的非敏感经营要求。".repeat(45)}联系${privatePhone}，误粘凭据${privateKey}；末尾非敏感目标必须保留。`;
    await state.owner.query("UPDATE profiles SET archive=archive || $2::jsonb WHERE workspace_id=$1", [scope.workspaceId, JSON.stringify({ goals: { privateBrief: { text: goal, version: "fixture-private-v1" } } })]);
    const result = routed(await dispatch(scope, title, true, { goalRef: "privateBrief" }));
    expect(result.status).toBe("completed"); expect(modelRequests()).toHaveLength(1);
    const saved = (await state.owner.query<{ title: string; plan: any }>("SELECT title,plan FROM threads WHERE id=$1", [result.threadId])).rows[0]!;
    const ledger = await events(scope, result.threadId);
    const dispatchEvent = ledger.find((event) => event.decision.action === "thread.dispatch");
    for (const privateValue of [privateKey, privatePhone]) {
      expect(saved.title).not.toContain(privateValue);
      expect(JSON.stringify(saved.plan)).not.toContain(privateValue);
      expect(JSON.stringify(dispatchEvent)).not.toContain(privateValue);
      expect(JSON.stringify(modelRequests())).not.toContain(privateValue);
    }
    expect(saved.title).toContain("单员工形成内部分析报告");
    expect(saved.plan.goal).toContain("末尾非敏感目标必须保留");
    expect(dispatchEvent.decision.after.goal_text).toContain("末尾非敏感目标必须保留");
    expect(modelRequests()[0]!.body.messages[0].content).toContain("末尾非敏感目标必须保留");
  });

  it("completed replays do not classify, replan or regenerate", async () => {
    const scope = await fixture();
    const result = routed(await dispatch(scope, "单员工形成内部经营分析报告"));
    const first = await caller(scope).threads.run({ threadId: result.threadId, goal: "继续" });
    expect(first.status).toBe("completed");
    expect(modelRequests()).toHaveLength(1);
    expect((await events(scope, result.threadId)).filter((event) => event.decision.action === "ask.answer")).toHaveLength(1);
  });

  it("bounded worker runs pause and resume the exact saved goal without repeating completed work", async () => {
    const scope = await fixture();
    vi.stubEnv("HOTEL_DELIVERY_MAX_WORKERS_PER_RUN", "1");
    const goal = "多员工协作形成收益与财务内部分析报告";
    const result = routed(await dispatch(scope, goal));
    expect(result).toMatchObject({ status: "paused", stepsDone: 1, stepsTotal: 2 });
    expect(modelRequests()).toHaveLength(2);
    vi.stubEnv("HOTEL_DELIVERY_MAX_WORKERS_PER_RUN", "5");
    expect((await caller(scope).threads.run({ threadId: result.threadId, goal: "继续" })).status).toBe("completed");
    expect(modelRequests()).toHaveLength(3);
    expect((await thread(result.threadId)).plan.goal).toBe(goal);
    expect((await events(scope, result.threadId)).filter((event) => event.decision.after?.delivery?.kind === "worker")).toHaveLength(2);
  });

  it("damaged Hotel plan snapshots never fall through to legacy Quest", async () => {
    const scope = await fixture();
    const result = routed(await dispatch(scope, "单员工形成内部分析报告", false));
    await state.owner.query("UPDATE threads SET plan=$2::jsonb WHERE id=$1", [result.threadId, JSON.stringify({ schema: "workloom.hotel-delivery/v1" })]);
    await expect(caller(scope).threads.run({ threadId: result.threadId })).rejects.toThrow(/计划快照损坏/);
    expect(modelRequests()).toHaveLength(0);
    expect((await thread(result.threadId)).plan).toEqual({ schema: "workloom.hotel-delivery/v1" });
  });

  it("legacy queued Hotel briefs use the saved thread title when the caller only says continue", async () => {
    const scope = await fixture();
    const id = `he-legacy-${randomUUID()}`;
    const goal = "单员工形成内部入住率分析报告";
    await state.owner.query("INSERT INTO threads(id,tenant_id,workspace_id,title,mode,status,created_by,agent_id) VALUES($1,$2,$3,$4,'quest','queued','MEM-001',$5)",
      [id, scope.tenantId, scope.workspaceId, goal, `${scope.workspaceId}-pricing-agent`]);
    expect((await caller(scope).threads.run({ threadId: id, goal: "继续" })).status).toBe("completed");
    expect((await thread(id)).plan.goal).toBe(goal); expect(modelRequests()).toHaveLength(1);
  });

  it("invalid worker limits fail before creating a task or calling a model", async () => {
    const scope = await fixture(); vi.stubEnv("HOTEL_DELIVERY_MAX_WORKERS_PER_RUN", "0");
    await expect(dispatch(scope, "单员工形成内部分析报告")).rejects.toThrow(/岗位上限/);
    expect((await state.owner.query("SELECT count(*)::int AS n FROM threads WHERE workspace_id=$1", [scope.workspaceId])).rows[0].n).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("the scheduler-preclaimed slot enters the Hotel owner-token protocol instead of staying running", async () => {
    const scope = await fixture();
    const result = routed(await dispatch(scope, "单员工形成内部经营分析报告", false));
    await state.owner.query("UPDATE threads SET status='running' WHERE id=$1 AND status='queued'", [result.threadId]);
    expect((await runQuestForThread(scope, { threadId: result.threadId, goal: "继续", presetRef: `${scope.workspaceId}-pricing-agent`, skipClaim: true })).status).toBe("completed");
    expect(modelRequests()).toHaveLength(1);
  });

  it("concurrent manual runs only start one model request", async () => {
    const scope = await fixture();
    const result = routed(await dispatch(scope, "单员工形成内部经营分析报告", false));
    let release!: () => void;
    holdWorker = new Promise<void>((done) => { release = done; });
    const first = caller(scope).threads.run({ threadId: result.threadId });
    for (let attempt = 0; attempt < 100 && modelRequests().length === 0; attempt++) await new Promise((done) => setTimeout(done, 5));
    expect(modelRequests()).toHaveLength(1);
    expect((await caller(scope).threads.run({ threadId: result.threadId, goal: "继续" })).status).toBe("running");
    release();
    expect((await first).status).toBe("completed");
    expect(modelRequests()).toHaveLength(1);
  });

  it("uses the configured research provider and persists real source URLs alongside the worker", async () => {
    const scope = await fixture();
    vi.stubEnv("DEEPSEEK_SEARCH_ENABLED", "1"); vi.stubEnv("DEEPSEEK_SEARCH_BASE_URL", base); vi.stubEnv("DEEPSEEK_API_KEY", "fixture-public-test-marker");
    const result = routed(await dispatch(scope, "单员工检索公开资料并形成竞对分析报告", true, { presetKey: "competitor-agent" }));
    expect(result.status).toBe("completed");
    expect(requests.filter((request) => request.path === "/v1/tools/search")).toHaveLength(1);
    expect(modelRequests()).toHaveLength(1);
    const worker = (await events(scope, result.threadId)).find((event) => event.decision.after?.delivery?.kind === "worker");
    expect(worker.decision.after.sourceFacts).toEqual(expect.arrayContaining([expect.objectContaining({ url: "https://example.org/official-hotel-report" })]));
    expect(worker.decision.after.artifact.sourceIds.some((id: string) => id.startsWith("web:"))).toBe(true);
  });

  it("search failure leaves a visible failed task before any worker model call", async () => {
    const scope = await fixture(); failSearch = true;
    vi.stubEnv("DEEPSEEK_SEARCH_ENABLED", "1"); vi.stubEnv("DEEPSEEK_SEARCH_BASE_URL", base); vi.stubEnv("DEEPSEEK_API_KEY", "fixture-public-test-marker");
    const result = routed(await dispatch(scope, "单员工检索并形成竞对分析报告", true, { presetKey: "competitor-agent" }));
    expect(result.status).toBe("failed"); expect(modelRequests()).toHaveLength(0);
    expect((await events(scope, result.threadId)).find((event) => event.decision.action === "hotel.delivery.failed")).toBeTruthy();
  });

  it("missing or overlong goalRef fails before creating a task or calling a model", async () => {
    const scope = await fixture();
    await expect(dispatch(scope, "读取完整目标档案", true, { goalRef: "missing" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await state.owner.query("UPDATE profiles SET archive=archive || $2::jsonb WHERE workspace_id=$1", [scope.workspaceId, JSON.stringify({ goals: { tooLong: "形成内部分析报告" + "长".repeat(20_000) } })]);
    await expect(dispatch(scope, "读取完整目标档案", true, { goalRef: "tooLong" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await state.owner.query("SELECT count(*)::int AS n FROM threads WHERE workspace_id=$1", [scope.workspaceId])).rows[0].n).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("ordinary executable business requests and non-Hotel workspaces retain Quest", async () => {
    registerIndustryQuestPlanner(() => () => [{ stepId: "normal", action: "pms.price.read", objectType: "room_rate", tool: "pms.price.read", params: {}, label: "普通业务读取" }]);
    const scope = await fixture();
    const ordinary = routed(await dispatch(scope, "分析房价后实际执行改价"));
    expect(Array.isArray((await thread(ordinary.threadId)).plan)).toBe(true);
    expect(modelRequests().some((request) => request.body.messages[0].content.includes("你是意图路由器"))).toBe(true);
    expect((await events(scope, ordinary.threadId)).some((event) => event.decision.after?.delivery?.schema)).toBe(false);
    requests = []; resetLlmAssembly();
    const other = await fixture("other-industry");
    const result = routed(await dispatch(other, "生成内部分析报告"));
    expect(Array.isArray((await thread(result.threadId)).plan)).toBe(true);
    expect(modelRequests().some((request) => request.body.messages[0].content.includes("你是意图路由器"))).toBe(true);
  });

  it("readonly and cross-tenant callers cannot generate or read Hotel artifacts", async () => {
    const scope = await fixture(); const other = await fixture();
    await expect(caller(scope, "readonly").threads.dispatch({ title: "单员工形成内部分析报告", runImmediately: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const result = routed(await dispatch(scope, "单员工形成内部分析报告", false));
    await expect(caller(other).threads.run({ threadId: result.threadId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await caller(other).threads.events({ threadId: result.threadId })).toEqual([]);
    expect(modelRequests()).toHaveLength(0);
  });
});
