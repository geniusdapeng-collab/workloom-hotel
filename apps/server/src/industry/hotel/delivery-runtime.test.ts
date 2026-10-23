/** MC-004: local HTTP model fixture + actual isolated PostgreSQL/RLS; no paid provider calls. */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gatewayAppend } from "@workloom/base/workdata";
import {
  isHotelCollaborativeGoal, isHotelDeliveryPlan, isHotelDraftGoal, runHotelDelivery,
} from "./delivery-runtime.js";

const execFileAsync = promisify(execFile);
const ownerUrl = process.env.HOTEL_DELIVERY_TEST_DATABASE_URL;
const database = ownerUrl ? describe : describe.skip;
type Scope = { tenantId: string; workspaceId: string };
type Fixture = { scope: Scope; threadId: string; sourceId: string };
type PromptInput = {
  step: { id: string; presetKey: string; goal: string };
  sources: Array<{ id: string; text: string }>;
  predecessors: Array<{ eventId: string; text: string }>;
  allowedSourceIds: string[];
  requiredSourceIds: string[];
};
type ModelRequest = { scene: string; prompt: string };

function parseInput(prompt: string): PromptInput {
  const match = /<hotel_delivery_input>\s*([\s\S]*?)\s*<\/hotel_delivery_input>/.exec(prompt);
  if (!match) throw new Error("fixture expected a delimited data context");
  return JSON.parse(match[1]!);
}

function workerReply(prompt: string): string {
  const input = parseInput(prompt);
  return JSON.stringify({
    title: `${input.step.presetKey}内部分析草稿`,
    text: `本草稿仅分析已提供的酒店经营快照，引用材料与模型建议分开记录。${input.step.presetKey}负责核对本岗位数据口径并形成可读建议。` +
      "当前结论只适用于已提供的时间窗口；未来入住率、渠道最新价格、实际退款状态和最终经营结果仍缺乏完整证据，不能推算为已经发生。" +
      "建议门店先核对原始来源，再由店长决定是否采用方案；跨部门应共享异常清单、负责人及复核时间，发现数据冲突就暂停结论并回到来源核查。本次没有调用任何外部经营执行工具。",
    sourceIds: [...new Set([input.sources[0]?.id, ...input.predecessors.map((item) => item.eventId)].filter(Boolean))],
    missingData: ["未来真实房态及最新外部渠道报价未提供"],
    humanDecisions: ["是否采用草稿建议须由门店负责人决定"],
  });
}

function collaborationPlan() {
  return {
    steps: [
      { id: "pricing", presetKey: "pricing-agent", goal: "分析已有房价与入住率并形成收益建议草稿", dependsOn: [] },
      { id: "reconcile", presetKey: "reconcile-agent", goal: "结合收益分析核对财务风险并形成对账清单", dependsOn: ["pricing"] },
      { id: "review", presetKey: "review-agent", goal: "结合财务与收益材料形成口碑风险报告", dependsOn: ["reconcile"] },
    ],
  };
}

describe("酒店内部交付入口识别", () => {
  it.each(["撰写入住率分析报告", "提供退款风险分析方案，不执行退款", "生成差评回复草稿，不发布", "整理客房检查清单", "单员工，仅起草内部客房排班建议", "生成桌面核查清单，不操控GUI"])("明确内部产物：%s", (goal) => {
    expect(isHotelDraftGoal(goal)).toBe(true);
  });
  it.each(["立即退款500元", "分析房价后实际执行改价", "生成草稿然后立即发布", "通过GUI点击退款并给出报告", "请将本店房价改为400并生成分析报告", "生成分析报告并退款500元", "起草方案并发布到美团", "生成报告，同时发送给客户", "调价2%", "继续"])("执行动作或非产物目标不进入报告链：%s", (goal) => {
    expect(isHotelDraftGoal(goal)).toBe(false);
  });
  it("识别明确协作及跨岗位，单员工仍保持单任务", () => {
    expect(isHotelCollaborativeGoal("多员工协作形成经营方案")).toBe(true);
    expect(isHotelCollaborativeGoal("收益定价官与财务司库官联合形成报告")).toBe(true);
    expect(isHotelCollaborativeGoal("单员工分析竞对并形成报告")).toBe(false);
  });
  it("旧Quest数组、空值和仅有schema标签的对象不是可恢复交付计划", () => {
    for (const plan of [null, [], {}, { schema: "workloom.hotel-delivery/v1" }]) expect(isHotelDeliveryPlan(plan)).toBe(false);
  });
});

database("酒店交付真实隔离PG/RLS + 自有HTTP模型夹具", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let gateway: pg.Pool;
  let server: Server;
  let modelUrl: string;
  let calls: ModelRequest[];
  let respond: (input: ModelRequest) => Promise<string> | string;

  const llmCallFor = (scene: string, _sessionId: string) => async (prompt: string, signal?: AbortSignal) => {
    const response = await fetch(modelUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene, prompt }), signal,
    });
    if (!response.ok) throw new Error(`local model fixture HTTP ${response.status}`);
    return ((await response.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content;
  };

  beforeAll(async () => {
    const url = new URL(ownerUrl!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "55439" || !url.pathname.startsWith("/workloom_hotel_")) {
      throw new Error("delivery tests require the task-owned loopback PostgreSQL fixture at port 55439");
    }
    owner = new pg.Pool({ connectionString: ownerUrl, max: 3 });
    const directory = (await owner.query<{ data_directory: string }>("SHOW data_directory")).rows[0]!.data_directory;
    const expected = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../runtime-state/pgdata");
    expect(realpathSync(directory)).toBe(realpathSync(expected));
    app = new pg.Pool({ connectionString: ownerUrl, options: "-c role=workloom_app", max: 8 });
    gateway = new pg.Pool({ connectionString: ownerUrl, options: "-c role=workloom_gateway", max: 3 });
    expect((await app.query<{ current_user: string }>("SELECT current_user")).rows[0]!.current_user).toBe("workloom_app");
    server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input: ModelRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        calls.push(input);
        const content = await respond(input);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      } catch {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "local fixture failure" }));
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture failed to bind");
    modelUrl = `http://127.0.0.1:${address.port}/chat/completions`;
  });

  beforeEach(() => {
    calls = [];
    respond = ({ scene, prompt }) => scene === "quest-plan" ? JSON.stringify(collaborationPlan()) : workerReply(prompt);
  });

  afterAll(async () => {
    if (server) await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    await Promise.all([owner?.end(), app?.end(), gateway?.end()]);
  });

  async function fixture(): Promise<Fixture> {
    const suffix = randomUUID();
    const scope = { tenantId: `hd-tenant-${suffix}`, workspaceId: `hd-ws-${suffix}` };
    const threadId = `HD-T-${suffix}`;
    await owner.query("INSERT INTO tenants(id,name) VALUES($1,'delivery fixture')", [scope.tenantId]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'delivery fixture',$1,'hotel','audit-only')", [scope.workspaceId, scope.tenantId]);
    await owner.query("INSERT INTO profiles(workspace_id,tenant_id,industry,archive) VALUES($1,$2,'hotel',$3)", [scope.workspaceId, scope.tenantId, JSON.stringify({
      property: { name: "隔离测试酒店", city: "杭州", rooms: 86 }, business: { floor_price: 380 },
      history_curve: { "2026-09": { occ: 0.75, adr: 480, revpar: 360 } }, dataMode: "simulated",
      forbidden: [{ rule: "不得承诺档案外优惠" }],
      operations: { shifts: ["早班08:00-16:00"], night_window: { start: "22:00", end: "08:00" } },
      brand_guideline: { banned_words: ["全网最低价"] }, sop: ["差评24小时内响应"],
      charter: { mode: "trial", identity: { name: "数字负责人", persona: "稳健" }, autonomy: { caps: { procurement: { label: "采购上限", limit: 5000 } } }, escalate: ["新渠道上线必审"], grant: { granted_by: "fake-private-grant-marker" } },
      credentials: { api_key: "fake-private-archive-marker" },
      incident_profile: { emergency_contacts: [{ name: "fake-private-contact-marker", phone: "13800000001" }] },
    })]);
    for (const preset of ["pricing-agent", "reconcile-agent", "review-agent", "frontdesk-agent", "disabled-agent"]) {
      await owner.query("INSERT INTO agents(id,workspace_id,preset_key,name,version,kind,status,fence_bindings,meta) VALUES($1,$2,$3,$3,'fixture-v1','delivery',$4,'[]',$5)", [
        `${scope.workspaceId}-${preset}`, scope.workspaceId, preset, preset === "disabled-agent" ? "disabled" : "ready",
        JSON.stringify({ prompt: `岗位完整提示词：${preset}:ASSEMBLY-PROMPT`, tools: [{ name: "pms.price.read", access: "read", desc: "只读房价" }] }),
      ]);
    }
    await owner.query("INSERT INTO threads(id,tenant_id,workspace_id,title,mode,status,created_by,agent_id) VALUES($1,$2,$3,'隔离内部分析','quest','queued','MEM-FIXTURE',$4)", [threadId, scope.tenantId, scope.workspaceId, `${scope.workspaceId}-pricing-agent`]);
    const source = await gatewayAppend(gateway, { ...scope, actor: { type: "human", id: "MEM-FIXTURE" }, sessionId: `fixture-source-${suffix}` }, {
      who: { type: "human", id: "MEM-FIXTURE" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), data_mode: "simulated" },
      object: { type: "hotel-metrics", id: "fixture" }, decision: { action: "hotel.metrics.snapshot", after: { occ: 0.75, adr: 480, revpar: 360, room_count: 86, dataMode: "simulated" } }, rule_impact: [],
    });
    return { scope, threadId, sourceId: source.eventId };
  }

  function run(f: Fixture, extra: Partial<Parameters<typeof runHotelDelivery>[0]> = {}) {
    return runHotelDelivery({ app, gateway, ...f, goal: "撰写入住率分析报告", presetKey: "pricing-agent", llmCallFor, ...extra });
  }
  async function thread(f: Fixture) {
    return (await owner.query<{ status: string; plan: any; progress_done: number; progress_total: number; error: string | null }>("SELECT status,plan,progress_done,progress_total,error FROM threads WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3", [f.scope.tenantId, f.scope.workspaceId, f.threadId])).rows[0]!;
  }
  async function events(f: Fixture) {
    return (await owner.query<{ payload: any }>("SELECT payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND session_id=$3 ORDER BY seq", [f.scope.tenantId, f.scope.workspaceId, f.threadId])).rows.map((row) => row.payload);
  }

  it("单员工完整prompt/档案阶段目标 + 可读真实事件回执，隔离敏感字段", async () => {
    const f = await fixture();
    const result = await run(f);
    expect(result.status).toBe("completed");
    expect(result.answer!.length).toBeGreaterThan(120);
    expect(result.stepsDone).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("pricing-agent:ASSEMBLY-PROMPT");
    expect(calls[0]!.prompt).toContain("audit-only");
    expect(calls[0]!.prompt).toContain(f.sourceId);
    expect(calls[0]!.prompt).not.toContain("fake-private-archive-marker");
    expect(calls[0]!.prompt).not.toContain("fake-private-contact-marker");
    expect(calls[0]!.prompt).not.toContain("fake-private-grant-marker");
    expect(calls[0]!.prompt).toContain("早班08:00-16:00");
    expect(calls[0]!.prompt).toContain("新渠道上线必审");
    const receipts = (await events(f)).filter((event) => event.decision.action === "ask.answer");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].who).toMatchObject({ id: "pricing-agent", version: "fixture-v1" });
    expect(receipts[0].decision.after.text).toBe(result.answer);
    expect(receipts[0].receipt.synced).toBe(false);
    expect(isHotelDeliveryPlan((await thread(f)).plan)).toBe(true);
  });

  it("多员工由模型规划DAG，实际逐岗生成并消费前序真实产物，最终links全部回执", async () => {
    const f = await fixture();
    const result = await run(f, { goal: "多员工协作完成收益、财务与口碑分析报告" });
    expect(result).toMatchObject({ status: "completed", stepsDone: 3, stepsTotal: 3 });
    expect(calls).toHaveLength(4);
    const receipts = (await events(f)).filter((event) => event.decision.action === "ask.answer");
    const workers = receipts.filter((event) => event.decision.after.delivery.kind === "worker");
    expect(workers.map((event) => event.who.id)).toEqual(["pricing-agent", "reconcile-agent", "review-agent"]);
    const second = parseInput(calls[2]!.prompt);
    expect(second.predecessors[0]?.eventId).toBe(workers[0].event_id);
    expect(second.predecessors[0]?.text).toBe(workers[0].decision.after.text);
    expect(second.allowedSourceIds).toEqual([...second.sources.map((source) => source.id), ...second.predecessors.map((previous) => previous.eventId)]);
    expect(second.requiredSourceIds).toEqual([workers[0].event_id]);
    const summary = receipts.find((event) => event.decision.after.delivery.kind === "summary");
    expect(summary.links).toEqual(workers.map((event) => event.event_id));
    expect(summary.decision.after.businessDataMode).toBe("simulated");
    expect(summary.decision.after.businessDataModes).toEqual(["simulated"]);
    for (const worker of workers) expect(result.answer).toContain(worker.decision.after.text);
  });

  it.each(["cycle", "duplicate", "unknown-dependency", "disabled-worker", "external-action", "single-role"])("非法规划 %s 不调用worker、不假成功", async (kind) => {
    const f = await fixture();
    const plan = collaborationPlan();
    if (kind === "cycle") plan.steps[0]!.dependsOn = ["review"];
    if (kind === "duplicate") plan.steps[1]!.id = "pricing";
    if (kind === "unknown-dependency") plan.steps[1]!.dependsOn = ["missing"];
    if (kind === "disabled-worker") plan.steps[1]!.presetKey = "disabled-agent";
    if (kind === "external-action") plan.steps[1]!.goal = "分析后实际执行退款";
    if (kind === "single-role") for (const step of plan.steps) step.presetKey = "pricing-agent";
    respond = () => JSON.stringify(plan);
    const result = await run(f, { goal: "多员工协作形成经营分析报告" });
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(1);
    expect((await events(f)).filter((event) => event.decision.action === "ask.answer")).toHaveLength(0);
  });

  it.each(["empty", "unknown-source", "false-execution"])("产物 %s 不被标记完成", async (kind) => {
    const f = await fixture();
    respond = ({ prompt }) => {
      if (kind === "empty") return "";
      const output = JSON.parse(workerReply(prompt));
      if (kind === "unknown-source") output.sourceIds = ["E-NOT-A-REAL-SOURCE"];
      if (kind === "false-execution") output.text += "已经执行退款并成功发布到OTA。";
      return JSON.stringify(output);
    };
    const result = await run(f);
    expect(result.status).toBe("failed");
    expect((await thread(f)).progress_done).toBe(0);
    expect((await events(f)).filter((event) => event.decision.action === "ask.answer")).toHaveLength(0);
  });

  it.each([
    { field: "humanDecisions", claim: "是否批准任何低于380元保底价的定价，必须人工升级审批" },
    { field: "humanDecisions", claim: "是否批准或撤销低于保底价380的调价记录" },
    { field: "humanDecisions", claim: "保底价与安全禁区相关规则的任何调整" },
    { field: "text", claim: "店长可特批368元房价作为当前保底价的例外" },
    { field: "missingData", claim: "因缺少审批回执，无法判断368是否越线及是否已获授权" },
    { field: "text", claim: "携程12%佣金后净额约323.84元，美团10%后约331.2元，均低于380元保底口径" },
  ])("现行硬约束与价格口径矛盾的$field被拒绝：$claim", async ({ field, claim }) => {
    const f = await fixture();
    respond = ({ prompt }) => {
      const output = JSON.parse(workerReply(prompt));
      if (field === "text") output.text += claim + "。";
      else output[field] = [claim];
      return JSON.stringify(output);
    };
    const result = await run(f);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/底价|口径|硬约束/);
    expect((await thread(f)).progress_done).toBe(0);
    expect((await events(f)).filter((event) => event.decision.action === "ask.answer")).toHaveLength(0);
  });

  it.each([
    "不能通过人工审批豁免当前保底价；低于380元不得批准，发现记录应由人核查并纠正。",
    "不应通过普通审批豁免保底价380元，相关越线记录应由人核查并纠正；若另行修改底价须另立版本治理，不在本任务范围。",
    "净价=368*(1-12%)=323.84元，仅为收益测算，不与未注明净口径的标价底线混比。",
    "在不低于380元底价的前提下，涨幅超过8%须人审；500元退款及200元内善意补偿仍须按审批矩阵复核。",
  ])("不放宽硬约束的正常审批与独立净额测算仍可交付：%s", async (statement) => {
    const f = await fixture();
    respond = ({ prompt }) => {
      const output = JSON.parse(workerReply(prompt));
      output.text += statement;
      output.humanDecisions = ["500元退款须按审批矩阵复核；保底价以上的活动涨幅超过8%需人审"];
      return JSON.stringify(output);
    };
    expect((await run(f)).status).toBe("completed");
    expect((await events(f)).filter((event) => event.decision.action === "ask.answer")).toHaveLength(1);
  });

  it("前序正文带出的祖先ID不自动获得引用权限，拒绝而非静默删改未知引用", async () => {
    const f = await fixture();
    let ancestorId: string | undefined;
    respond = ({ scene, prompt }) => {
      if (scene === "quest-plan") return JSON.stringify(collaborationPlan());
      const input = parseInput(prompt);
      const output = JSON.parse(workerReply(prompt));
      if (input.step.id === "reconcile") ancestorId = input.predecessors[0]!.eventId;
      if (input.step.id === "review") {
        expect(input.allowedSourceIds).not.toContain(ancestorId);
        expect(input.requiredSourceIds).toEqual(input.predecessors.map((prior) => prior.eventId));
        output.sourceIds.push(ancestorId);
      }
      return JSON.stringify(output);
    };
    const result = await run(f, { goal: "多员工协作形成收益财务口碑分析报告" });
    expect(result).toMatchObject({ status: "failed", stepsDone: 2, stepsTotal: 3 });
    expect(result.error).toMatch(/来源ID/);
    expect((await events(f)).filter((event) => event.decision.action === "ask.answer")).toHaveLength(2);
  });

  it("无模型不能伪造交付；保留可见错误", async () => {
    const f = await fixture();
    const result = await run(f, { llmCallFor: () => undefined });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/模型/);
    expect(calls).toHaveLength(0);
    expect((await thread(f)).error).toBeTruthy();
  });

  it("模型失败后重新进入可继续，已失败不能冒充完成", async () => {
    const f = await fixture();
    respond = () => { throw new Error("fixture unavailable"); };
    expect((await run(f)).status).toBe("failed");
    respond = ({ prompt }) => workerReply(prompt);
    expect((await run(f)).status).toBe("completed");
    expect((await events(f)).filter((event) => event.decision.action === "ask.answer")).toHaveLength(1);
  });

  it("跨租户/跨工作区与禁用岗位拒绝，无模型I/O", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(run(f, { scope: { tenantId: other.scope.tenantId, workspaceId: f.scope.workspaceId } })).rejects.toThrow(/不存在|无权/);
    await expect(run(f, { scope: other.scope })).rejects.toThrow(/不存在|无权/);
    await expect(run(f, { presetKey: "disabled-agent" })).rejects.toThrow(/disabled|不可|岗位/);
    expect(calls).toHaveLength(0);
  });

  it("并发CAS只允许一个实例付费工作，另一个返回running", async () => {
    const f = await fixture();
    let release!: (value: string) => void;
    const waiting = new Promise<string>((done) => { release = done; });
    respond = () => waiting;
    const first = run(f);
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((done) => setTimeout(done, 5));
    expect(calls).toHaveLength(1);
    expect((await run(f)).status).toBe("running");
    release(workerReply(calls[0]!.prompt));
    expect((await first).status).toBe("completed");
    expect(calls).toHaveLength(1);
  });

  it("scheduler预先CAS的槽位可内部接续，普通调用不能冒认", async () => {
    const f = await fixture();
    await owner.query("UPDATE threads SET status='running' WHERE id=$1", [f.threadId]);
    await expect(run(f)).rejects.toThrow(/运行|scheduler/);
    expect(calls).toHaveLength(0);
    expect((await run(f, { claimedByScheduler: true })).status).toBe("completed");
    expect(calls).toHaveLength(1);
  });

  it("scheduler内部标记也不能覆盖活动owner，暂停后新generation阻止旧结果回写", async () => {
    const f = await fixture();
    let release!: (value: string) => void;
    const waiting = new Promise<string>((done) => { release = done; });
    respond = () => waiting;
    const oldRun = run(f);
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((done) => setTimeout(done, 5));
    expect((await run(f, { claimedByScheduler: true })).status).toBe("running");
    expect(calls).toHaveLength(1);
    await owner.query("UPDATE threads SET status='paused' WHERE id=$1", [f.threadId]);
    respond = ({ prompt }) => workerReply(prompt);
    expect((await run(f)).status).toBe("completed");
    release(workerReply(calls[0]!.prompt));
    expect((await oldRun).status).toBe("completed");
    const saved = await thread(f);
    expect(saved.plan.generation).toBe(2);
    expect((await events(f)).filter((event) => event.decision.action === "ask.answer")).toHaveLength(1);
  });

  it("租约失联先报告未知结果，显式重试后才继续", async () => {
    const f = await fixture();
    let release!: (value: string) => void;
    const waiting = new Promise<string>((done) => { release = done; });
    respond = () => waiting;
    const oldRun = run(f);
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((done) => setTimeout(done, 5));
    await owner.query("UPDATE threads SET plan=jsonb_set(plan,'{leaseUntil}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [f.threadId]);
    expect((await run(f)).status).toBe("failed");
    expect(calls).toHaveLength(1);
    release(workerReply(calls[0]!.prompt));
    expect((await oldRun).status).toBe("failed");
    respond = ({ prompt }) => workerReply(prompt);
    expect((await run(f)).status).toBe("completed");
    expect(calls).toHaveLength(2);
  });

  it("岗位版本变化或停用使未完成步骤失败，不能静默换人", async () => {
    const f = await fixture();
    expect((await run(f, { goal: "多员工协作形成分析报告", maxWorkersPerRun: 1 })).status).toBe("paused");
    await owner.query("UPDATE agents SET version='fixture-v2' WHERE workspace_id=$1 AND preset_key='reconcile-agent'", [f.scope.workspaceId]);
    expect((await run(f)).status).toBe("failed");
    expect(calls).toHaveLength(2);
    expect((await thread(f)).progress_done).toBe(1);
  });

  it("受控断点后新进程恢复原计划，已完成步骤不重规划/不再调用", async () => {
    const f = await fixture();
    const goal = "多员工协作形成收益与财务及口碑分析报告";
    const partial = await run(f, { goal, maxWorkersPerRun: 1 });
    expect(partial).toMatchObject({ status: "paused", stepsDone: 1, stepsTotal: 3 });
    expect(calls).toHaveLength(2);
    const script = `
      import pg from 'pg';
      import {runHotelDelivery} from ${JSON.stringify(new URL("./delivery-runtime.ts", import.meta.url).href)};
      const config=JSON.parse(process.env.HD_TEST_INPUT);
      const app=new pg.Pool({connectionString:config.url,options:'-c role=workloom_app'});
      const gateway=new pg.Pool({connectionString:config.url,options:'-c role=workloom_gateway'});
      try {
        const result=await runHotelDelivery({app,gateway,scope:config.scope,threadId:config.threadId,goal:'继续',presetKey:'pricing-agent',
          llmCallFor:(scene)=>async(prompt,signal)=>{const r=await fetch(config.modelUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scene,prompt}),signal});if(!r.ok)throw new Error('fixture HTTP '+r.status);return (await r.json()).choices[0].message.content;}});
        console.log(JSON.stringify(result));
      } finally {await Promise.all([app.end(),gateway.end()]);}
    `;
    const child = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.."),
      env: { ...process.env, HD_TEST_INPUT: JSON.stringify({ url: ownerUrl, scope: f.scope, threadId: f.threadId, modelUrl }) }, timeout: 20_000,
    });
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
    expect(result).toMatchObject({ status: "completed", stepsDone: 3 });
    expect(calls).toHaveLength(4);
    expect(calls.filter((call) => call.scene === "quest-plan")).toHaveLength(1);
    expect((await thread(f)).plan.goal).toBe(goal);
  }, 30_000);

  it("completed重放验证同线程实际回执，不触发模型工厂", async () => {
    const f = await fixture();
    const first = await run(f);
    const replay = await run(f, { goal: "继续", llmCallFor: () => { throw new Error("must not invoke model factory"); } });
    expect(replay.answer).toBe(first.answer);
    expect(replay.artifactEventIds).toEqual(first.artifactEventIds);
    expect(calls).toHaveLength(1);
  });

  it("缺失真实事件回执的完成步骤不能跳过或冒充交付", async () => {
    const f = await fixture();
    await run(f, { goal: "多员工协作形成经营分析报告", maxWorkersPerRun: 1 });
    const saved = await thread(f);
    saved.plan.steps[0].output.eventId = "E-999999999999999";
    await owner.query("UPDATE threads SET plan=$2 WHERE id=$1", [f.threadId, JSON.stringify(saved.plan)]);
    const result = await run(f);
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(2);
  });

  it("取消后旧运行者的在途输出不能回写完成", async () => {
    const f = await fixture();
    let release!: (value: string) => void;
    const waiting = new Promise<string>((done) => { release = done; });
    respond = () => waiting;
    const first = run(f);
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((done) => setTimeout(done, 5));
    await owner.query("UPDATE threads SET status='cancelled' WHERE id=$1", [f.threadId]);
    release(workerReply(calls[0]!.prompt));
    expect((await first).status).toBe("cancelled");
    expect((await thread(f)).status).toBe("cancelled");
    expect((await events(f)).filter((event) => event.decision.action === "ask.answer")).toHaveLength(0);
  });

  it("产物事件和进度状态在同一事务回滚，不留下半份回执", async () => {
    const f = await fixture();
    const trigger = `hd_fail_${randomUUID().replaceAll("-", "")}`;
    await owner.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=TG_ARGV[0] AND NEW.progress_done>OLD.progress_done THEN RAISE EXCEPTION 'fixture progress rollback'; END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON threads FOR EACH ROW EXECUTE FUNCTION ${trigger}('${f.threadId}')`);
    try {
      expect((await run(f)).status).toBe("failed");
      expect((await thread(f)).progress_done).toBe(0);
      expect((await events(f)).filter((event) => event.decision.action === "ask.answer")).toHaveLength(0);
    } finally {
      await owner.query(`DROP TRIGGER ${trigger} ON threads`);
      await owner.query(`DROP FUNCTION ${trigger}()`);
    }
  });

  it("行业ask.deliver输出围栏仍生效", async () => {
    const f = await fixture();
    await owner.query("INSERT INTO fence_rules(id,rule_id,version,workspace_id,name,level,match_spec,action,is_baseline,status,created_by) VALUES($1,'HD-OUTPUT','fixture',$2,'fixture output block','block',$3,'{}',false,'active','fixture')", [
      `hd-fence-${randomUUID()}`, f.scope.workspaceId, JSON.stringify({ object_types: ["ask_answer"], actions: ["ask.deliver"], when: "true" }),
    ]);
    expect((await run(f)).status).toBe("failed");
    expect((await events(f)).filter((event) => event.decision.action === "ask.answer")).toHaveLength(0);
  });

  it("模型请求在途新增输出block在提交事务内重判，不留下worker回执", async () => {
    const f = await fixture();
    let release!: (value: string) => void;
    const waiting = new Promise<string>((done) => { release = done; });
    respond = () => waiting;
    const running = run(f);
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((done) => setTimeout(done, 5));
    expect(calls).toHaveLength(1);
    await owner.query("INSERT INTO fence_rules(id,rule_id,version,workspace_id,name,level,match_spec,action,is_baseline,status,created_by) VALUES($1,'HD-INFLIGHT','fixture',$2,'inflight output block','block',$3,'{}',false,'active','fixture')", [
      `hd-fence-${randomUUID()}`, f.scope.workspaceId, JSON.stringify({ object_types: ["ask_answer"], actions: ["ask.deliver"], when: "true" }),
    ]);
    release(workerReply(calls[0]!.prompt));
    expect((await running).status).toBe("failed");
    expect((await thread(f)).progress_done).toBe(0);
    expect((await events(f)).filter((event) => event.decision.action === "ask.answer")).toHaveLength(0);
  });

  it("最终汇总文本单独触发围栏，保留三岗成果而不写入summary或完成状态", async () => {
    const f = await fixture();
    await owner.query("INSERT INTO fence_rules(id,rule_id,version,workspace_id,name,level,match_spec,action,is_baseline,status,created_by) VALUES($1,'HD-SUMMARY','fixture',$2,'summary output block','block',$3,'{}',false,'active','fixture')", [
      `hd-fence-${randomUUID()}`, f.scope.workspaceId, JSON.stringify({ object_types: ["ask_answer"], actions: ["ask.deliver"], when: "contains(params.text, '酒店多员工内部分析与草稿交付')" }),
    ]);
    expect((await run(f, { goal: "多员工协作形成经营分析报告" })).status).toBe("failed");
    expect(calls).toHaveLength(4);
    const receipts = (await events(f)).filter((event) => event.decision.action === "ask.answer");
    expect(receipts.filter((event) => event.decision.after.delivery.kind === "worker")).toHaveLength(3);
    expect(receipts.filter((event) => event.decision.after.delivery.kind === "summary")).toHaveLength(0);
    const saved = await thread(f);
    expect(saved.progress_done).toBe(3);
    expect(saved.plan.final).toBeUndefined();
  });

  it("结构化岗位prompt的私密扩展不能绕过档案白名单", async () => {
    const f = await fixture();
    await owner.query("UPDATE agents SET meta=jsonb_set(meta,'{prompt}',$2::jsonb) WHERE workspace_id=$1 AND preset_key='pricing-agent'", [f.scope.workspaceId, JSON.stringify({
      role: "收益岗位完整说明", goals: ["按资料给出分析"], constraints: ["不执行外部动作"],
      archive: { credentials: "fake-private-prompt-marker" }, api_key: "fake-private-prompt-marker",
    })]);
    expect((await run(f)).status).toBe("completed");
    expect(calls[0]!.prompt).toContain("收益岗位完整说明");
    expect(calls[0]!.prompt).not.toContain("fake-private-prompt-marker");
  });

  it("明确至少三岗不得被规划裁成两岗，超过硬上限也不暗中裁剪", async () => {
    const f = await fixture();
    const plan = collaborationPlan();
    plan.steps.pop();
    respond = () => JSON.stringify(plan);
    expect((await run(f, { goal: "多员工协作，至少3个真实岗位形成分析报告" })).status).toBe("failed");
    expect(calls).toHaveLength(1);
    const other = await fixture();
    expect((await run(other, { goal: "多员工协作，至少6个岗位形成分析报告" })).status).toBe("failed");
    expect(calls).toHaveLength(1);
  });

  it.each(["10个岗位", "12名员工", "十个岗位", "十二名员工", "9007199254740992个岗位"])("超过支持范围的明确最低岗位数 %s 在规划I/O前失败", async (minimum) => {
    const f = await fixture();
    const result = await run(f, { goal: `多员工协作，至少${minimum}形成内部分析报告` });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/岗位|员工/);
    expect(calls).toHaveLength(0);
    expect((await events(f)).some((event) => event.decision.action === "ask.answer")).toBe(false);
  });

  it("显式research facts引用可校验并完整保留URL，默认无隐式搜索", async () => {
    const f = await fixture();
    const research = [{ id: "research:official-page", text: "官方来源的公开资料，用于分析而非渠道实际报价。", url: "https://example.org/hotel" }];
    respond = ({ prompt }) => {
      const output = JSON.parse(workerReply(prompt));
      output.sourceIds.push(research[0]!.id);
      return JSON.stringify(output);
    };
    expect((await run(f, { researchFacts: research })).status).toBe("completed");
    expect(calls[0]!.prompt).toContain(research[0]!.url);
    expect((await events(f)).find((event) => event.decision.action === "ask.answer").decision.after.sourceFacts).toEqual(expect.arrayContaining([expect.objectContaining(research[0]!)]));
  });

  it("可读产物只列实际引用的公开网页URL及原来源检索时间", async () => {
    const f = await fixture();
    const research = [
      { id: "web:cited-page", text: "公开网页检索资料（检索时间 2026-10-24T01:23:45.000Z；页面日期未知）：可引用的公开材料。", url: "https://example.org/cited-hotel" },
      { id: "web:unused-page", text: "公开网页检索资料（检索时间 2026-10-24T01:23:46.000Z；页面日期未知）：未被引用的材料。", url: "https://example.org/unused-hotel" },
    ];
    respond = ({ prompt }) => {
      const output = JSON.parse(workerReply(prompt));
      output.sourceIds.push(research[0]!.id);
      return JSON.stringify(output);
    };
    const result = await run(f, { researchFacts: research });
    expect(result.status).toBe("completed");
    expect(result.answer).toContain(research[0]!.url);
    expect(result.answer).toContain("2026-10-24T01:23:45.000Z");
    expect(result.answer).not.toContain(research[1]!.url);
    expect(result.answer).not.toContain("2026-10-24T01:23:46.000Z");
  });

  it("围栏治理事件不挤占有限经营资料窗口，保持原始经营事件可追溯", async () => {
    const f = await fixture();
    const governanceIds: string[] = [];
    for (let i = 0; i < 21; i++) {
      const receipt = await gatewayAppend(gateway, { ...f.scope, actor: { type: "human", id: "MEM-FIXTURE" }, sessionId: `fixture-governance-${randomUUID()}` }, {
        who: { type: "human", id: "MEM-FIXTURE" },
        context: { tenant_id: f.scope.tenantId, workspace_id: f.scope.workspaceId, time: new Date().toISOString() },
        object: { type: "fence-rule", id: `fixture-${i}` }, decision: { action: "fence.rule.propose", after: { status: "pending" } }, rule_impact: [],
      });
      governanceIds.push(receipt.eventId);
    }
    expect((await run(f)).status).toBe("completed");
    const input = parseInput(calls[0]!.prompt);
    expect(input.sources.some((source) => source.id === f.sourceId)).toBe(true);
    expect(input.sources.some((source) => governanceIds.includes(source.id))).toBe(false);
  }, 20_000);

  it("目标中的电话与provider样式凭据先脱敏，再进入模型与可恢复计划", async () => {
    const f = await fixture();
    const privateKey = "sk-fixture-private-goal-marker-123456789";
    const privatePhone = "13800000001";
    expect((await run(f, { goal: `单员工生成内部分析报告；联系号码${privatePhone}，误粘凭据${privateKey}。` })).status).toBe("completed");
    const persisted = JSON.stringify((await thread(f)).plan);
    for (const privateValue of [privateKey, privatePhone]) {
      expect(calls[0]!.prompt).not.toContain(privateValue);
      expect(persisted).not.toContain(privateValue);
    }
  });

  it("长目标全文持久化且模型可见，超限拒绝而非截断", async () => {
    const f = await fixture();
    const goal = `生成分析报告：${"完整目标。".repeat(220)}末尾目标标识`;
    expect((await run(f, { goal })).status).toBe("completed");
    expect((await thread(f)).plan.goal).toBe(goal);
    expect(calls[0]!.prompt).toContain("末尾目标标识");
    const other = await fixture();
    await expect(run(other, { goal: "分析报告" + "长".repeat(50_000) })).rejects.toThrow(/上限|过长/);
    expect(calls).toHaveLength(1);
  });
});
