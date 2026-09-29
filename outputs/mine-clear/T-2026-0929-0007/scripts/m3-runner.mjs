#!/usr/bin/env node
/**
 * MCD M3 · 联动排雷执行器（状态投影保真度 · workloom-hotel · T-2026-0929-0007）
 *
 * 证据口径：每个"面"在**真机制造状态变更前后**各取一次原文（API 响应 + owner 直查 + 服务端日志切片）。
 * 覆盖面：
 *   F1 PC 任务页（threads.list / threads.get / threads.events）
 *   F2 PC·B端 审批页（approvals.list，webb 与 web 消费同一服务端投影）
 *   F3 剧场工位（captain.theater → floor 派生：asking / blocked / celebrating / working / queued / idle）
 *   F4 播报结算流（threads.settledSince，客户端补播报不依赖"亲眼见证跃迁"）
 *   F5 事件账本（/events 页 = 最近 12 个线程 × threads.events）
 *   F6 夜班决策包 + 巡检状态条（进度/异常两个侧面）
 *   F7 C 端服务前台（/c/session → /c/tickets）↔ PC 服务前台（service.tickets.list/advance）
 *   F8 问答入口（ask：计数类 / 明细类 / 行业数据类）
 *
 * 前置：PG 已迁移+种子；服务端在 M3_BASE 运行（stdio 落盘 M3_SERVER_LOG）；
 *       SERVICE_C_DEMO_AUTH=true（出厂演示默认）以允许 h5 演示直登。
 *
 * 用法：
 *   M3_BASE=http://127.0.0.1:8802 M3_SERVER_LOG=... node m3-runner.mjs
 */
import pg from "pg";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../evidence/m3");
mkdirSync(OUT, { recursive: true });

const BASE = process.env.M3_BASE ?? "http://127.0.0.1:8802";
const BASE_PREVIEW = process.env.M3_BASE_PREVIEW ?? "http://127.0.0.1:8807";     // preview:all 口径（SERVICE_C_WORKSPACE_ID=ws-aipm-demo）
const BASE_CONFIGURED = process.env.M3_BASE_CONFIGURED ?? "http://127.0.0.1:8808"; // 全配口径（SERVICE_C_WORKSPACE_ID=ws-yunqi）
const OWNER_URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5461/wl_mc_m23";
const SERVER_LOG = process.env.M3_SERVER_LOG ?? resolve(HERE, "../evidence/m3/server-m3.log");
const RUN_ID = `m3-${Date.now().toString(36)}`;

const owner = new pg.Pool({ connectionString: OWNER_URL, max: 6 });
const results = [];
const startedAt = new Date().toISOString();
const jsonl = join(OUT, `cases-${RUN_ID}.jsonl`);

function logOffset() { try { return statSync(SERVER_LOG).size; } catch { return 0; } }
function logSlice(from) {
  try {
    const buf = readFileSync(SERVER_LOG);
    const s = buf.subarray(Math.min(Math.max(from, 0), buf.length)).toString("utf8");
    return s.length > 4000 ? s.slice(-4000) : s;
  } catch (err) { return `<日志不可读：${String(err)}>`; }
}

async function api(path, opts = {}) {
  const { method, token, body, timeoutMs = 120_000, headers = {}, base = BASE } = opts;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: method ?? (body !== undefined ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 600) }; }
    return { path, httpStatus: res.status, bizStatus: data?.error?.data?.httpStatus ?? res.status, ms: Date.now() - t0, request: body ?? null, response: data };
  } catch (err) {
    return { path, httpStatus: 0, bizStatus: 0, ms: Date.now() - t0, request: body ?? null, response: { transportError: String(err) } };
  } finally { clearTimeout(timer); }
}

async function q(sql, params = []) {
  const r = await owner.query(sql, params);
  return { sql: sql.replace(/\s+/g, " ").trim(), rows: r.rows, rowCount: r.rowCount };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gql = (path, input, token) => api(`${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { token });

async function runCase(id, dimension, title, expectation, fn) {
  const ctx = { api, q, gql, sleep, evidence: { api: [], db: [], notes: [] } };
  const t0 = Date.now();
  const logFrom = logOffset();
  let verdict = "PASS", summary = "", error = null, extra = {};
  try {
    const out = await fn(ctx);
    summary = out?.summary ?? ""; verdict = out?.verdict ?? "PASS"; extra = out ?? {};
  } catch (err) {
    verdict = "ERROR"; error = err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(0, 3).join("\n")}` : String(err);
  }
  ctx.evidence.logs = [{ after: logFrom, text: logSlice(logFrom) }];
  const record = { id, dimension, title, expectation, verdict, summary, error, extra, durationMs: Date.now() - t0, evidence: ctx.evidence };
  results.push(record);
  appendFileSync(jsonl, JSON.stringify(record) + "\n");
  const mark = verdict === "PASS" ? "✓" : verdict === "FAIL" ? "✗" : verdict === "OBSERVE" ? "◉" : "!";
  console.log(`${mark} ${id} ${title}${summary ? ` — ${summary}` : ""}${error ? ` （${error.split("\n")[0]}）` : ""}`);
  return record;
}

const A = (ctx, r) => { ctx.evidence.api.push(r); return r; };
const D = (ctx, r) => { ctx.evidence.db.push(r); return r; };
const N = (ctx, s) => { ctx.evidence.notes.push(s); };

let token = null;
let reviewThreadId = null;
let reviewApprovalId = null;
let rejectThreadId = null;
let cToken = null;
let cTicketId = null;
const uniq = (s) => `${s} [${RUN_ID}]`;

async function drain(ctx) {
  const r = await q(
    `UPDATE threads SET status='completed', closed_at=now(), updated_at=now()
      WHERE workspace_id='ws-yunqi' AND status IN ('queued','running') AND id NOT IN ('T-101','T-102','T-103')`);
  D(ctx, r); N(ctx, `清位 ${r.rowCount} 条 queued/running`);
}

async function floorOf(ctx) {
  const r = A(ctx, await api("/trpc/captain.theater", { token }));
  const floor = r.response?.result?.data?.floor;
  return Array.isArray(floor?.agents) ? floor.agents : (Array.isArray(floor) ? floor : []);
}

const floorAgent = (agents, presetKey) => agents.find((a) => a.presetKey === presetKey) ?? null;

/* ================= F1–F5：线程生命周期辐射 ================= */

await runCase("M3-A1", "联动基线", "主链路五个面基线快照（任务/审批/剧场/播报/账本）",
  "基线可读且一致（线程数、待审批数、剧场人数）", async (ctx) => {
    const login = A(ctx, await api("/trpc/auth.loginAs", { body: { workspaceSlug: "yunqi-hotel", memberNo: "MEM-001" } }));
    token = login.response?.result?.data?.token ?? null;
    if (!token) return { verdict: "FAIL", summary: "登录失败" };
    await drain(ctx);
    const tasks = A(ctx, await api("/trpc/threads.list", { token }));
    const approvals = A(ctx, await gql("/trpc/approvals.list", { status: "pending" }, token));
    const settled = A(ctx, await gql("/trpc/threads.settledSince", {}, token));
    const floor = await floorOf(ctx);
    const night = A(ctx, await api("/trpc/nightShift.current", { token }));
    const inspection = A(ctx, await api("/trpc/inspection.status", { token }));
    N(ctx, `任务=${tasks.response?.result?.data?.length ?? 0}，待批=${approvals.response?.result?.data?.length ?? 0}，剧场员工=${floor.length}，已结算=${settled.response?.result?.data?.length ?? 0}`);
    return { verdict: floor.length > 0 ? "PASS" : "FAIL", summary: `任务 ${tasks.response?.result?.data?.length ?? 0} / 待批 ${approvals.response?.result?.data?.length ?? 0} / 剧场 ${floor.length} 人` };
  });

await runCase("M3-A2", "联动（状态变更）", "派遣差评 Quest → 挂起：任务页 / 审批页 / 剧场 / 播报 逐面取证",
  "任务页 pending_review 且带 pending_approval_id；审批页出现该单；剧场对应员工 asking 且 approvalId 一致；播报不出现（未终结）", async (ctx) => {
    const beforeFloor = await floorOf(ctx);
    const d = A(ctx, await api("/trpc/threads.dispatch", { token, body: { title: uniq("回复那条 2 分差评（联动探针）"), presetKey: "review-agent", runImmediately: true } }));
    reviewThreadId = d.response?.result?.data?.threadId ?? null;
    if (!reviewThreadId) return { verdict: "FAIL", summary: `派遣失败：${JSON.stringify(d.response).slice(0, 160)}` };
    const detail = A(ctx, await gql("/trpc/threads.get", { threadId: reviewThreadId }, token));
    reviewApprovalId = detail.response?.result?.data?.pending_approval_id ?? null;
    const tasks = A(ctx, await api("/trpc/threads.list", { token }));
    const taskRow = (tasks.response?.result?.data ?? []).find((t) => t.id === reviewThreadId) ?? null;
    const approvals = A(ctx, await gql("/trpc/approvals.list", { status: "pending" }, token));
    const approvalRow = (approvals.response?.result?.data ?? []).find((a) => a.approval_id === reviewApprovalId) ?? null;
    const floor = await floorOf(ctx);
    const agent = floorAgent(floor, "review-agent");
    const settled = A(ctx, await gql("/trpc/threads.settledSince", {}, token));
    const inSettled = (settled.response?.result?.data ?? []).some((t) => t.id === reviewThreadId);
    const events = A(ctx, await gql("/trpc/threads.events", { threadId: reviewThreadId }, token));
    const eventActions = (events.response?.result?.data ?? []).map((e) => e?.decision?.action);
    D(ctx, await q(
      `SELECT id,status,progress_done,progress_total,agent_id FROM threads WHERE id=$1`, [reviewThreadId]));
    D(ctx, await q(`SELECT approval_id,status,tier,snapshot->>'gate' AS gate FROM approvals WHERE approval_id=$1`, [reviewApprovalId]));
    D(ctx, await q(
      `SELECT payload->'decision'->>'action' AS action, payload->'rule_impact' AS rule_impact, payload->'who'->>'id' AS who
         FROM biz_events WHERE session_id=$1 AND payload->'decision'->>'action'='review.reply' ORDER BY seq DESC LIMIT 1`, [reviewThreadId]));
    N(ctx, `变更前 review-agent=${beforeFloor.find((a) => a.presetKey === "review-agent")?.state ?? "-"}；变更后=${agent?.state ?? "-"}`);
    N(ctx, `任务页 entry=${JSON.stringify(taskRow)}；审批单=${approvalRow ? `${approvalRow.approval_id}/${approvalRow.status}` : "缺失"}；剧场=${agent?.state}/${agent?.approvalId}；播报含本线程=${inSettled}`);
    N(ctx, `线程事件流动作=${JSON.stringify(eventActions)}`);
    if (agent?.state === "blocked" && agent?.approvalId == null) {
      N(ctx, "断点：挂起事件 rule_impact 仍带 result=blocked（W-01 降级保留原 impacts）→ 剧场按“遇阻”渲染且优先级高于 asking，approvalId 丢失（无法直达审批）");
    }
    const ok = taskRow?.status === "pending_review"
      && Boolean(reviewApprovalId) && approvalRow?.status === "pending"
      && agent?.state === "asking" && agent?.approvalId === reviewApprovalId
      && !inSettled;
    return { verdict: ok ? "PASS" : "FAIL", summary: `任务=${taskRow?.status} 审批=${approvalRow?.status} 剧场=${agent?.state}(approvalId=${agent?.approvalId === reviewApprovalId}) 播报=${inSettled}` };
  });

await runCase("M3-A3", "联动（状态变更）", "批准 + 续跑 → 完成：任务页 / 审批页 / 剧场 / 播报 / 账本 逐面取证",
  "任务页 completed；审批页不再 pending 且状态 approved；剧场不再 asking；播报包含该线程；账本事件流应含裁决动作（缺则记联动断点）", async (ctx) => {
    const approve = A(ctx, await api("/trpc/approvals.decide", { token, body: { approvalId: reviewApprovalId, gesture: "approve" } }));
    const run = A(ctx, await api("/trpc/threads.run", { token, body: { threadId: reviewThreadId } }));
    await sleep(800);
    const tasks = A(ctx, await api("/trpc/threads.list", { token }));
    const taskRow = (tasks.response?.result?.data ?? []).find((t) => t.id === reviewThreadId) ?? null;
    const pending = A(ctx, await gql("/trpc/approvals.list", { status: "pending" }, token));
    const stillPending = (pending.response?.result?.data ?? []).some((a) => a.approval_id === reviewApprovalId);
    const approvedList = A(ctx, await gql("/trpc/approvals.list", { status: "approved" }, token));
    const approvedRow = (approvedList.response?.result?.data ?? []).find((a) => a.approval_id === reviewApprovalId) ?? null;
    const floor = await floorOf(ctx);
    const agent = floorAgent(floor, "review-agent");
    const settled = A(ctx, await gql("/trpc/threads.settledSince", {}, token));
    const inSettled = (settled.response?.result?.data ?? []).find((t) => t.id === reviewThreadId) ?? null;
    const events = A(ctx, await gql("/trpc/threads.events", { threadId: reviewThreadId }, token));
    const actions = (events.response?.result?.data ?? []).map((e) => e?.decision?.action);
    const gestureInStream = actions.includes("approval.gesture");
    D(ctx, await q(`SELECT id,status,progress_done,progress_total,closed_at FROM threads WHERE id=$1`, [reviewThreadId]));
    D(ctx, await q(`SELECT event_id, session_id FROM biz_events WHERE payload->'decision'->'after'->>'approvalId'=$1`, [reviewApprovalId]));
    N(ctx, `剧场 review-agent=${agent?.state}（celebrating=${Boolean(agent?.celebrating)}）；播报=${inSettled ? `${inSettled.status}@${inSettled.closed_at}` : "缺失"}；账本动作=${JSON.stringify(actions)}`);
    const ok = approve.response?.result?.data?.status === "approved"
      && run.response?.result?.data?.status === "completed"
      && taskRow?.status === "completed"
      && !stillPending && approvedRow?.status === "approved"
      && agent?.state !== "asking"
      && Boolean(inSettled);
    return {
      verdict: ok ? "PASS" : "FAIL",
      summary: `任务=${taskRow?.status} 审批=${approvedRow?.status} 剧场=${agent?.state} 播报=${inSettled ? "有" : "无"}${gestureInStream ? "" : "；断点：裁决动作不在任务事件流（approval.gesture session_id=NULL）"}`,
      gestureInStream,
    };
  });

await runCase("M3-A4", "联动（驳回路径）", "驳回 → 任务取消：任务页 / 审批页 / 剧场 / 播报 四面对账",
  "任务页 cancelled；审批页 rejected 且带原因；播报包含 cancelled 线程；剧场“驳回→遇阻”表达必须由其声明机制驱动（floor 读 decision.params.gesture=reject 且 actor=员工 preset_key）", async (ctx) => {
    await drain(ctx);
    const d = A(ctx, await api("/trpc/threads.dispatch", { token, body: { title: uniq("回复那条 2 分差评（驳回联动探针）"), presetKey: "review-agent", runImmediately: true } }));
    rejectThreadId = d.response?.result?.data?.threadId ?? null;
    const detail = A(ctx, await gql("/trpc/threads.get", { threadId: rejectThreadId }, token));
    const approvalId = detail.response?.result?.data?.pending_approval_id;
    const decide = A(ctx, await api("/trpc/approvals.decide", { token, body: { approvalId, gesture: "reject", reasonEnum: "reply.tone", reasonText: "联动探针：语气不符" } }));
    await sleep(1200);
    const tasks = A(ctx, await api("/trpc/threads.list", { token }));
    const taskRow = (tasks.response?.result?.data ?? []).find((t) => t.id === rejectThreadId) ?? null;
    const allApprovals = A(ctx, await gql("/trpc/approvals.list", {}, token));
    const approvalRow = (allApprovals.response?.result?.data ?? []).find((a) => a.approval_id === approvalId) ?? null;
    const floor = await floorOf(ctx);
    const agent = floorAgent(floor, "review-agent");
    const settled = A(ctx, await gql("/trpc/threads.settledSince", {}, token));
    const inSettled = (settled.response?.result?.data ?? []).find((t) => t.id === rejectThreadId) ?? null;
    const gestureRow = D(ctx, await q(
      `SELECT event_id, payload->'decision'->>'action' AS action,
              payload->'who'->>'id' AS who_id, payload->'who'->>'type' AS who_type,
              payload->'decision'->'after'->>'gesture' AS after_gesture,
              payload->'decision'->'params'->>'gesture' AS params_gesture
         FROM biz_events WHERE payload->'decision'->'after'->>'approvalId'=$1`, [approvalId]));
    N(ctx, `驳回后：任务=${taskRow?.status}，审批=${approvalRow?.status}/${approvalRow?.gesture?.reason_enum}，剧场 review-agent=${agent?.state}，播报=${inSettled?.status ?? "无"}`);
    N(ctx, `手势事件字段：who=${gestureRow.rows[0]?.who_type}:${gestureRow.rows[0]?.who_id}，after.gesture=${gestureRow.rows[0]?.after_gesture}，params.gesture=${gestureRow.rows[0]?.params_gesture ?? "NULL"}`);
    const projectionOk = taskRow?.status === "cancelled" && approvalRow?.status === "rejected" && inSettled?.status === "cancelled";
    // 机制核查：floor 的驳回分支要求 params.gesture=reject 且 actor 命中员工 preset_key；
    // 生产写的是 after.gesture + who=人类成员 → 分支确定性空转（守卫空转）。
    const mechanismWired = gestureRow.rows[0]?.params_gesture === "reject" && gestureRow.rows[0]?.who_type === "agent";
    const floorOk = mechanismWired;
    return {
      verdict: projectionOk && floorOk ? "PASS" : "FAIL",
      summary: `任务=${taskRow?.status} 审批=${approvalRow?.status} 播报=${inSettled?.status ?? "无"}；剧场=${agent?.state}；驳回→遇阻分支接线=${mechanismWired}（生产 after.gesture=${gestureRow.rows[0]?.after_gesture}/who=${gestureRow.rows[0]?.who_type}，floor 读 params.gesture=NULL）`,
      floorOk, projectionOk,
    };
  });

await runCase("M3-A5", "联动（覆盖度机检）", "事件账本/任务事件流的数据源覆盖度",
  "统计 biz_events 中无 session_id（非线程）事件占比；这些事件在任务页/账本页（threads.events 投影）均不可见", async (ctx) => {
    const stats = D(ctx, await q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE session_id IS NULL)::int AS no_session,
              count(*) FILTER (WHERE session_id IS NOT NULL)::int AS with_session,
              count(DISTINCT payload->'decision'->>'action')::int AS actions
         FROM biz_events WHERE workspace_id='ws-yunqi'`));
    const byAction = D(ctx, await q(
      `SELECT payload->'decision'->>'action' AS action, count(*)::int AS n,
              count(*) FILTER (WHERE session_id IS NULL)::int AS no_session
         FROM biz_events WHERE workspace_id='ws-yunqi' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`));
    const r = stats.rows[0];
    const pct = r.total ? Math.round((r.no_session / r.total) * 100) : 0;
    N(ctx, `动作分布=${JSON.stringify(byAction.rows)}`);
    return {
      verdict: "OBSERVE",
      summary: `事件 ${r.total} 条，其中非线程事件（session_id NULL）${r.no_session} 条（${pct}%）在 /events 账本页与任务事件流中不可见`,
      coverage: { total: r.total, noSession: r.no_session, pct },
    };
  });

/* ================= F7：C 端 ↔ 员工端 ================= */

await runCase("M3-B1", "联动（跨端/出厂默认）", "出厂默认配置下 C 端会话可用性",
  "出厂 .env/.env.example 未声明 SERVICE_C_*，按产品文档口径应先可用或明确给出可执行的配置引导；此处如实记录实际返回", async (ctx) => {
    const session = A(ctx, await api("/c/session", { body: { channel: "h5", openid: uniq("m3-device"), nickname: "M3 联调客" } }));
    const err = session.response?.error ?? null;
    N(ctx, `默认配置 /c/session → ${session.httpStatus} ${JSON.stringify(err)}`);
    return {
      verdict: session.httpStatus === 200 ? "PASS" : "FAIL",
      summary: `默认配置 C 端会话=${session.httpStatus}（${err ?? "ok"}）`,
    };
  });

await runCase("M3-B2", "联动（跨端/官方首启路径）", "pnpm preview:all 口径（SERVICE_C_WORKSPACE_ID=ws-aipm-demo）C 端会话可用性",
  "官方推荐首启路径必须让 C 端可达；若指向不存在的工作区（酒店仓只有 ws-yunqi）判 FAIL", async (ctx) => {
    const session = A(ctx, await api("/c/session", { base: BASE_PREVIEW, body: { channel: "h5", openid: uniq("m3-preview-device"), nickname: "首启探针" } }));
    const err = session.response?.error ?? null;
    D(ctx, await q(`SELECT id, slug, industry FROM workspaces ORDER BY id`));
    N(ctx, `preview:all 口径 /c/session → ${session.httpStatus} ${JSON.stringify(err)}`);
    return {
      verdict: session.httpStatus === 200 ? "PASS" : "FAIL",
      summary: `preview:all 口径 C 端会话=${session.httpStatus}（${err ?? "ok"}）`,
    };
  });

await runCase("M3-B3", "联动（跨端/全配）", "正确配置（SERVICE_C_WORKSPACE_ID=ws-yunqi）：C 端建单 → PC 服务前台可见 → 推进 → C 端回读",
  "三面一致：C 端创建成功；PC service.tickets.list 命中；PC advance 后 C 端 /c/tickets 读到新状态", async (ctx) => {
    const session = A(ctx, await api("/c/session", { base: BASE_CONFIGURED, body: { channel: "h5", openid: uniq("m3-device"), nickname: "M3 联调客" } }));
    cToken = session.response?.token ?? session.response?.result?.data?.token ?? null;
    if (!cToken) return { verdict: "FAIL", summary: `C 端会话失败：${JSON.stringify(session.response).slice(0, 200)}` };
    const created = A(ctx, await api("/c/tickets", {
      base: BASE_CONFIGURED,
      token: cToken,
      body: { kind: "delivery", title: uniq("送两瓶水到 812 房"), payload: { room: "812", item: "矿泉水" }, conversationId: uniq("conv"), idempotencyKey: uniq("idem") },
    }));
    cTicketId = created.response?.ticket?.id ?? null;
    if (!cTicketId) return { verdict: "FAIL", summary: `C 端建单失败：${JSON.stringify(created.response).slice(0, 200)}` };
    const staff = A(ctx, await gql("/trpc/service.tickets.list", {}, token));
    const staffTicket = (staff.response?.result?.data?.tickets ?? []).find((t) => t.id === cTicketId) ?? null;
    D(ctx, await q(`SELECT id, kind, status, title, workspace_id FROM c_tickets WHERE id=$1`, [cTicketId]).catch(() => ({ sql: "c_tickets（查询失败）", rows: [], rowCount: 0 })));
    let advance = null;
    if (staffTicket) {
      advance = A(ctx, await api("/trpc/service.tickets.advance", { token, body: { ticketId: cTicketId, action: "start" } }));
    }
    const cList = A(ctx, await api("/c/tickets", { base: BASE_CONFIGURED, token: cToken }));
    const cTicket = (cList.response?.tickets ?? []).find((t) => t.id === cTicketId) ?? null;
    const ok = Boolean(staffTicket) && Boolean(advance?.response?.result) && Boolean(cTicket);
    N(ctx, `C 端建单=${cTicketId}；PC 服务前台命中=${Boolean(staffTicket)}（${staffTicket?.status ?? "-"}）；推进返回=${JSON.stringify(advance?.response?.result?.data ?? advance?.response?.error?.message ?? null).slice(0, 120)}；C 端回读=${cTicket?.status ?? "-"}（${cTicket?.statusText ?? "-"}）`);
    return {
      verdict: ok ? "PASS" : "FAIL",
      summary: `C=${cTicket?.status ?? "-"} PC=${staffTicket?.status ?? "缺失"} 推进=${advance?.bizStatus ?? "-"}`,
    };
  });

/* ================= F8：问答入口覆盖 ================= */

await runCase("M3-C1", "问答覆盖", "ask 计数类：待审批数量应与数据库事实一致",
  "答案中的待审批数量 == DB count(approvals where pending)", async (ctx) => {
    const truth = D(ctx, await q(`SELECT count(*)::int AS n FROM approvals WHERE workspace_id='ws-yunqi' AND status='pending'`));
    const ask = A(ctx, await api("/trpc/threads.dispatch", { token, body: { title: "现在有多少条待审批？", presetKey: "review-agent" } }));
    const answer = ask.response?.result?.data?.answer ?? "";
    const nums = [...String(answer).matchAll(/(\d+)\s*项/g)].map((m) => Number(m[1]));
    const expected = truth.rows[0].n;
    const matched = nums.includes(expected);
    N(ctx, `DB 待审批=${expected}；ask 回答=${String(answer).slice(0, 200)}`);
    return { verdict: matched ? "PASS" : (answer ? "FAIL" : "ERROR"), summary: `DB=${expected}，回答命中=${matched}，answer=${String(answer).slice(0, 80)}` };
  });

await runCase("M3-C2", "问答覆盖", "ask 明细类：被驳回的调价明细",
  "若回答只能给系统统计、给不出任何具体审批/事件明细，判覆盖不足（FAIL）", async (ctx) => {
    const truth = D(ctx, await q(
      `SELECT a.approval_id, a.status, a.snapshot->>'action' AS action
         FROM approvals a WHERE a.workspace_id='ws-yunqi' AND a.status='rejected' ORDER BY a.decided_at DESC LIMIT 3`));
    const ask = A(ctx, await api("/trpc/threads.dispatch", { token, body: { title: "上个月被驳回的调价有哪些？" } }));
    const data = ask.response?.result?.data ?? {};
    const answer = String(data.answer ?? "");
    const hitDetail = truth.rows.some((r) => answer.includes(String(r.approval_id)));
    N(ctx, `DB 最近被驳回=${JSON.stringify(truth.rows)}；回答=${answer.slice(0, 240)}；sources 未见（产品未在响应暴露 sources）`);
    if (data.mode === "clarify") return { verdict: "OBSERVE", summary: `意图路由判定为含糊反问：${String(data.question ?? "").slice(0, 80)}` };
    return {
      verdict: hitDetail ? "PASS" : "FAIL",
      summary: `回答未含任何被驳回审批明细（DB 有 ${truth.rows.length} 条样本）；answer=${answer.slice(0, 100)}`,
    };
  });

await runCase("M3-C3", "问答覆盖", "ask 行业数据类：本月营收",
  "行业包未注册 ask 事实面时，回答应至少明确说明无该数据（不得用系统统计冒充营收）", async (ctx) => {
    const ask = A(ctx, await api("/trpc/threads.dispatch", { token, body: { title: "本月营收多少？" } }));
    const data = ask.response?.result?.data ?? {};
    const answer = String(data.answer ?? "");
    const mentionsRevenue = /营收|收入|营业额/.test(answer);
    const admitsMissing = /暂(无|未)|没有|缺失|不包含|无法|未接/.test(answer);
    N(ctx, `answer=${answer.slice(0, 240)}`);
    const ok = !mentionsRevenue ? admitsMissing : true;
    return {
      verdict: ok ? "OBSERVE" : "FAIL",
      summary: ok ? `未声称有营收数据（回答=${answer.slice(0, 90)}）` : `回答声称含营收数据：${answer.slice(0, 120)}`,
    };
  });

await runCase("M3-C4", "问答覆盖（对照）", "ask 短问句对照：事实装填顺序是否与问题相关",
  "短问句下若仍只有“事件库规模/动作分布”这类系统统计、而“当前待审批/进行中线程”被挤出，说明事实排序与问题无关（120 字硬闸按固定顺序截断）", async (ctx) => {
    const truth = D(ctx, await q(`SELECT count(*)::int AS pending FROM approvals WHERE workspace_id='ws-yunqi' AND status='pending'`));
    const truthThreads = D(ctx, await q(`SELECT count(*)::int AS active FROM threads WHERE workspace_id='ws-yunqi' AND status IN ('queued','running','pending_review','paused')`));
    const ask = A(ctx, await api("/trpc/threads.dispatch", { token, body: { title: "待审批？" } }));
    const answer = String(ask.response?.result?.data?.answer ?? "");
    const hasPendingFact = /当前待审批/.test(answer);
    const hasThreadFact = /进行中线程/.test(answer);
    N(ctx, `DB 待审批=${truth.rows[0].pending}、进行中=${truthThreads.rows[0].active}；回答=${answer.replace(/\n/g, " ")}`);
    return {
      verdict: hasPendingFact ? "PASS" : "FAIL",
      summary: `回答含“当前待审批”事实=${hasPendingFact}、含“进行中线程”=${hasThreadFact}；answer=${answer.replace(/\n/g, " ").slice(0, 120)}`,
    };
  });

/* ---------------- 汇总 ---------------- */

const summary = {
  taskId: "T-2026-0929-0007",
  phase: "M3 联动排雷",
  base: BASE,
  runId: RUN_ID,
  startedAt,
  finishedAt: new Date().toISOString(),
  counts: {
    total: results.length,
    pass: results.filter((r) => r.verdict === "PASS").length,
    fail: results.filter((r) => r.verdict === "FAIL").length,
    observe: results.filter((r) => r.verdict === "OBSERVE").length,
    error: results.filter((r) => r.verdict === "ERROR").length,
  },
  results,
};
writeFileSync(join(OUT, `m3-report-${RUN_ID}.json`), JSON.stringify(summary, null, 2));

const md = [
  `# M3 联动排雷执行记录（${RUN_ID}）`,
  "",
  `- 目标：${BASE}`,
  `- 时间：${startedAt} → ${summary.finishedAt}`,
  `- 结果：${summary.counts.pass} 通过 / ${summary.counts.fail} 失败 / ${summary.counts.observe} 观察 / ${summary.counts.error} 异常（共 ${summary.counts.total}）`,
  "",
  "| 用例 | 维度 | 判定 | 期望 | 实测摘要 |",
  "| --- | --- | --- | --- | --- |",
  ...results.map((r) => `| ${r.id} | ${r.dimension} | ${r.verdict} | ${r.expectation.replace(/\|/g, "/")} | ${String(r.summary).replace(/\|/g, "/").slice(0, 240)} |`),
  "",
  ...results.flatMap((r) => [
    `### ${r.id} ${r.title}（${r.verdict}）`,
    "",
    `- 期望：${r.expectation}`,
    `- 实测：${r.summary || r.error || "(无摘要)"}`,
    `- 证据：API ${r.evidence.api.length} 条 / DB ${r.evidence.db.length} 条`,
    ...(r.evidence.notes.length ? ["- 备注：", ...r.evidence.notes.map((n) => `  - ${n}`)] : []),
    "",
  ]),
].join("\n");
writeFileSync(join(OUT, `m3-report-${RUN_ID}.md`), md);

console.log(`\n════ M3 汇总：${summary.counts.pass} 通过 / ${summary.counts.fail} 失败 / ${summary.counts.observe} 观察 / ${summary.counts.error} 异常 ════`);
console.log(`产物：${join(OUT, `m3-report-${RUN_ID}.json`)}`);
await owner.end();
process.exit(summary.counts.fail + summary.counts.error > 0 ? 2 : 0);
