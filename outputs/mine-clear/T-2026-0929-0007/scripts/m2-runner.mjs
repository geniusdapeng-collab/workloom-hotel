#!/usr/bin/env node
/**
 * MCD M2 · 动态排雷执行器（workloom-hotel · 任务 T-2026-0929-0007）
 *
 * 目的：五维用例矩阵（主链路闭环 / 并发竞争 / 异常注入 / 边界值 / 状态机遍历）
 *       + 三类错误（业务 / 配置 / 环境），每个用例取证三件套：
 *       ① API 响应原文 ② 数据库特权直查（owner 连接绕 RLS） ③ 服务端日志切片。
 *
 * 前置条件（脚本不自动做的部分，见 M2 报告）：
 *   - PG 17 已起（127.0.0.1:5461），wl_mc_m23 已 migrate+seed；
 *   - 服务端已在 BASE（默认 127.0.0.1:8802）运行，且 stdio 落盘到 M2_SERVER_LOG；
 *   - .env 为出厂演示配置（LLM_PROVIDER=mock / IM_DRIVER=mock / TOOL_UNVERIFIED_RATE=0）。
 *
 * 可复跑：脚本自带清理（清空上一轮遗留 queued/running 线程）、用例数据带 M2 前缀、
 *         仅写本工作区（ws-yunqi，tenant-demo），不触碰种子线程 T-101..T-103。
 *
 * 用法：
 *   M2_BASE=http://127.0.0.1:8802 \
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5461/wl_mc_m23 \
 *   M2_SERVER_LOG=outputs/mine-clear/T-2026-0929-0007/evidence/server.log \
 *   node outputs/mine-clear/T-2026-0929-0007/scripts/m2-runner.mjs
 */
import pg from "pg";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_EVIDENCE = resolve(HERE, "../evidence/m2");
mkdirSync(OUT_EVIDENCE, { recursive: true });

const BASE = process.env.M2_BASE ?? "http://127.0.0.1:8802";
const OWNER_URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5461/wl_mc_m23";
const APP_URL = process.env.DATABASE_APP_URL ?? OWNER_URL;
const SERVER_LOG = process.env.M2_SERVER_LOG ?? resolve(HERE, "../evidence/server.log");
const WORKSPACE_SLUG = process.env.M2_WS_SLUG ?? "yunqi-hotel";
const ONLY = process.env.M2_ONLY ? new Set(process.env.M2_ONLY.split(",")) : null;
const RUN_ID = `m2-${Date.now().toString(36)}`;

const owner = new pg.Pool({ connectionString: OWNER_URL, max: 8 });
const appPool = new pg.Pool({ connectionString: APP_URL, max: 4 });

const results = [];
const startedAt = new Date().toISOString();
const jsonlPath = join(OUT_EVIDENCE, `cases-${RUN_ID}.jsonl`);

/* ---------------- 基础设施 ---------------- */

function logOffset() {
  try { return statSync(SERVER_LOG).size; } catch { return 0; }
}

function logSlice(from) {
  try {
    const buf = readFileSync(SERVER_LOG);
    const slice = buf.subarray(Math.min(Math.max(from, 0), buf.length)).toString("utf8");
    return slice.length > 6000 ? slice.slice(-6000) : slice;
  } catch (err) {
    return `<服务端日志不可读：${err instanceof Error ? err.message : String(err)}>`;
  }
}

async function api(path, opts = {}) {
  const { method, token, body, timeoutMs = 120_000 } = opts;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: method ?? (body !== undefined ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    return {
      path, method: method ?? (body !== undefined ? "POST" : "GET"), httpStatus: res.status,
      bizStatus: data?.error?.data?.httpStatus ?? res.status,
      ms: Date.now() - started, request: body ?? null, response: data,
    };
  } catch (err) {
    return {
      path, method: method ?? "GET", httpStatus: 0, bizStatus: 0, ms: Date.now() - started,
      request: body ?? null,
      response: { transportError: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function q(sql, params = []) {
  const r = await owner.query(sql, params);
  return { sql: sql.replace(/\s+/g, " ").trim(), rowCount: r.rowCount, rows: r.rows };
}

/** app 角色 + RLS 上下文查询（验证“越权返回空”口径） */
async function qAppScoped(sql, params = [], scope = { workspaceId: "ws-yunqi", tenantId: "tenant-demo" }) {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query(sql, params);
    await client.query("COMMIT");
    return { sql: sql.replace(/\s+/g, " ").trim(), rowCount: r.rowCount, rows: r.rows, as: "app+RLS" };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(memberNo) {
  const r = await api("/trpc/auth.loginAs", { body: { workspaceSlug: WORKSPACE_SLUG, memberNo } });
  return r.response?.result?.data?.token ?? null;
}

/* ---------------- 用例骨架 ---------------- */

async function runCase(id, dimension, title, expectation, fn) {
  if (ONLY && !ONLY.has(id)) return;
  const ctx = { api, q, qAppScoped, login, sleep, evidence: { api: [], db: [], logs: [], notes: [] } };
  const logFrom = logOffset();
  const t0 = Date.now();
  let verdict = "PASS";
  let error = null;
  let summary = "";
  let extra = {};
  try {
    const out = await fn(ctx);
    summary = out?.summary ?? "";
    if (out?.verdict) verdict = out.verdict;
    extra = out ?? {};
  } catch (err) {
    verdict = "ERROR";
    error = err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(0, 4).join("\n")}` : String(err);
  }
  ctx.evidence.logs.push({ after: logFrom, text: logSlice(logFrom) });
  const record = {
    id, dimension, title, expectation, verdict, summary, error, extra,
    startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0,
    evidence: ctx.evidence,
  };
  results.push(record);
  appendFileSync(jsonlPath, JSON.stringify(record) + "\n");
  const mark = verdict === "PASS" ? "✓" : verdict === "FAIL" ? "✗" : verdict === "OBSERVE" ? "◉" : "!";
  console.log(`${mark} ${id} ${title}${summary ? ` — ${summary}` : ""}${error ? ` （${error.split("\n")[0]}）` : ""}`);
  return record;
}

const pushApi = (ctx, r) => { ctx.evidence.api.push(r); return r; };
const pushDb = (ctx, r) => { ctx.evidence.db.push(r); return r; };
const note = (ctx, text) => { ctx.evidence.notes.push(text); };

/* ---------------- 用例共享状态 ---------------- */

let tokenOwner = null;
let tokenManager = null;
let tokenReadonly = null;
let reviewThread = null;         // 指定口碑岗的主链路线程
let reviewApprovalId = null;
let defaultRoutingThread = null; // 不指定岗位的差评线程（默认路由）
let priceThread = null;
let queuedForConcurrency = [];

const uniq = (s) => `${s} [${RUN_ID}]`;

async function dispatch(ctx, body, token = tokenOwner) {
  return pushApi(ctx, await api("/trpc/threads.dispatch", { token, body }));
}

async function threadRow(ctx, threadId) {
  return pushDb(ctx, await q(
    `SELECT id, title, mode, status, progress_done, progress_total, agent_id, created_by, created_at, updated_at, closed_at
       FROM threads WHERE id=$1`, [threadId],
  ));
}

async function threadDetail(token, threadId) {
  return api(`/trpc/threads.get?input=${encodeURIComponent(JSON.stringify({ threadId }))}`, { token });
}

/**
 * 清空工作区 queued/running 占位（保持种子 T-101..T-103 不动），让后续用例拿到并发额度。
 * 记录为 DB 证据，保证"后面的用例不是因为 429 而失败"这一前提可复核。
 */
async function drainWorkspace(ctx, label = "") {
  const r = await q(
    `UPDATE threads SET status='completed', closed_at=now(), updated_at=now()
      WHERE workspace_id='ws-yunqi' AND status IN ('queued','running') AND id NOT IN ('T-101','T-102','T-103')`);
  const left = await q(`SELECT count(*)::int AS n FROM threads WHERE workspace_id='ws-yunqi' AND status IN ('queued','running')`);
  pushDb(ctx, r);
  pushDb(ctx, left);
  note(ctx, `drain${label ? `（${label}）` : ""}：清理 ${r.rowCount} 条占位，剩余 queued/running=${left.rows[0].n}`);
  return left.rows[0].n;
}

/* ============ A · 主链路闭环 ============ */

await runCase("A1", "主链路", "健康检查 + 三成员登录（owner/manager/readonly）",
  "health 200 / system.health db=up / 三 token 互不相同", async (ctx) => {
    const health = pushApi(ctx, await api("/health"));
    const sysHealth = pushApi(ctx, await api("/trpc/system.health"));
    tokenOwner = await login("MEM-001");
    tokenManager = await login("MEM-002");
    tokenReadonly = await login("MEM-003");
    note(ctx, `owner token 长度=${tokenOwner?.length ?? 0}, manager=${tokenManager?.length ?? 0}, readonly=${tokenReadonly?.length ?? 0}`);
    const ok = health.response?.ok === true
      && sysHealth.response?.result?.data?.db === "up"
      && tokenOwner && tokenManager && tokenReadonly
      && new Set([tokenOwner, tokenManager, tokenReadonly]).size === 3;
    return { verdict: ok ? "PASS" : "FAIL", summary: `health=${health.httpStatus}, db=${sysHealth.response?.result?.data?.db}` };
  });

await runCase("A2", "主链路", "差评回复闭环（指定口碑岗）：派遣→挂起→人工批准→续跑完成",
  "dispatch 返回 pending_review 且带 pending_approval_id；批准后 threads.run 返回 completed 2/2", async (ctx) => {
    const d = await dispatch(ctx, { title: uniq("回复那条 2 分差评（口碑岗）"), presetKey: "review-agent", runImmediately: true });
    const data = d.response?.result?.data;
    if (!data?.threadId) return { verdict: "FAIL", summary: `dispatch 未返回 threadId：${JSON.stringify(d.response).slice(0, 200)}` };
    reviewThread = data.threadId;
    await threadRow(ctx, reviewThread);
    const detail = pushApi(ctx, await threadDetail(tokenOwner, reviewThread));
    reviewApprovalId = detail.response?.result?.data?.pending_approval_id ?? null;
    const queue = pushApi(ctx, await api(`/trpc/approvals.list?input=${encodeURIComponent(JSON.stringify({ status: "pending" }))}`, { token: tokenOwner }));
    const inQueue = (queue.response?.result?.data ?? []).some((a) => a.approval_id === reviewApprovalId);
    pushDb(ctx, await q(
      `SELECT a.approval_id, a.status, a.tier, a.event_id, e.session_id
         FROM approvals a JOIN biz_events e ON e.event_id=a.event_id WHERE a.approval_id=$1`, [reviewApprovalId]));
    const decide = pushApi(ctx, await api("/trpc/approvals.decide", { token: tokenOwner, body: { approvalId: reviewApprovalId, gesture: "approve" } }));
    const run = pushApi(ctx, await api("/trpc/threads.run", { token: tokenOwner, body: { threadId: reviewThread } }));
    const final = (await threadRow(ctx, reviewThread)).rows[0];
    const stepEvents = pushDb(ctx, await q(
      `SELECT payload->'decision'->>'action' AS action, payload->'decision'->>'step_id' AS step,
              payload->'receipt'->>'synced' AS synced, payload->'decision'->'basis' AS basis
         FROM biz_events WHERE session_id=$1 AND payload->'decision'->>'action' <> 'thread.dispatch' ORDER BY seq`, [reviewThread]));
    // 不变量：completed 线程的每个步骤都应有"真执行"事件（receipt.synced 非空），且 progress_done==progress_total
    const executedSteps = new Set(stepEvents.rows.filter((r) => r.synced === "true" || r.synced === "false").map((r) => r.step));
    const missingExecution = [...new Set(stepEvents.rows.map((r) => r.step).filter(Boolean))].filter((s) => !executedSteps.has(s));
    const progressConsistent = Number(final?.progress_done) === Number(final?.progress_total);
    const ok = data.status === "pending_review"
      && Boolean(reviewApprovalId)
      && inQueue
      && decide.response?.result?.data?.status === "approved"
      && run.response?.result?.data?.status === "completed"
      && final?.status === "completed"
      && progressConsistent
      && missingExecution.length === 0;
    if (!ok) note(ctx, `dispatch=${JSON.stringify(data)}; approve=${JSON.stringify(decide.response?.result?.data)}; run=${JSON.stringify(run.response?.result?.data)}; final=${JSON.stringify(final)}`);
    return {
      verdict: ok ? "PASS" : "FAIL",
      summary: `dispatch=${data.status}, approval=${reviewApprovalId}, final=${final?.status} ${final?.progress_done}/${final?.progress_total}, run 回报 ${run.response?.result?.data?.stepsDone}/${run.response?.result?.data?.stepsTotal}, 未执行步骤=${JSON.stringify(missingExecution)}`,
      progressConsistent, missingExecution,
    };
  });

await runCase("A3", "主链路/语义层", "差评回复闭环（用户默认入口：不指定岗位，模拟对话框派任务）",
  "默认路由应把「回复差评」交给带 review.reply 的岗位并走挂起审批；派给他岗并以不相关工具 completed 判 FAIL（假交付）", async (ctx) => {
    const d = await dispatch(ctx, { title: uniq("回复那条 2 分差评（默认入口）"), runImmediately: true });
    const data = d.response?.result?.data ?? {};
    defaultRoutingThread = data.threadId ?? null;
    if (!defaultRoutingThread) return { verdict: "FAIL", summary: `dispatch 未返回 threadId：${JSON.stringify(d.response).slice(0, 200)}` };
    await threadRow(ctx, defaultRoutingThread);
    const detail = pushApi(ctx, await threadDetail(tokenOwner, defaultRoutingThread));
    const preset = detail.response?.result?.data?.preset_key ?? null;
    const events = pushDb(ctx, await q(
      `SELECT payload->'decision'->>'action' AS action, payload->'who'->>'id' AS who,
              payload->'decision'->'after'->>'tool' AS tool, payload->'decision'->'after'->>'status' AS status
         FROM biz_events WHERE session_id=$1 ORDER BY seq`, [defaultRoutingThread]));
    const actions = events.rows.map((r) => r.action);
    const didReviewReply = events.rows.some((r) => String(r.action ?? "").includes("review.reply"));
    note(ctx, `默认路由岗位=${preset}；事件动作序列=${JSON.stringify(actions)}`);
    if (data.status === "pending_review" && didReviewReply) {
      return { verdict: "PASS", summary: `默认路由正确：preset=${preset}，已挂起` };
    }
    return {
      verdict: "FAIL",
      summary: `错配：preset=${preset}，线程终态=${data.status}，实际执行动作=${JSON.stringify(actions.filter((a) => a !== "thread.dispatch"))}（用户目标是差评回复，未发生 review.reply）`,
    };
  });

await runCase("A4", "主链路", "调价闭环（价带内 2% 应 auto 完成，不产生审批）",
  "dispatch 返回 completed；DB 内 price.adjust 步骤带 after.price 且无 pending 审批（用 2% 同时满足 R1 ≤8% 与 R7 夜班 ≤3% 的 auto 区间）", async (ctx) => {
    await drainWorkspace(ctx, "A4 前清位");
    const d = await dispatch(ctx, { title: uniq("把雅致大床房调价 2%"), runImmediately: true });
    const data = d.response?.result?.data ?? {};
    priceThread = data.threadId ?? null;
    if (!priceThread) return { verdict: "FAIL", summary: `dispatch 未返回 threadId：${JSON.stringify(d.response).slice(0, 200)}` };
    await threadRow(ctx, priceThread);
    const detail = pushApi(ctx, await threadDetail(tokenOwner, priceThread));
    const preset = detail.response?.result?.data?.preset_key ?? null;
    const events = pushDb(ctx, await q(
      `SELECT payload->'decision'->>'action' AS action, payload->'decision'->'after' AS after,
              payload->'rule_impact' AS rule_impact
         FROM biz_events WHERE session_id=$1 ORDER BY seq`, [priceThread]));
    const adjust = events.rows.find((r) => r.action === "price.adjust");
    const approvals = pushDb(ctx, await q(
      `SELECT count(*)::int AS n FROM approvals a JOIN biz_events e ON e.event_id=a.event_id
        WHERE e.session_id=$1 AND a.status='pending'`, [priceThread]));
    const ok = data.status === "completed" && Boolean(adjust) && Number(approvals.rows[0]?.n) === 0;
    note(ctx, `preset=${preset}；price.adjust after=${JSON.stringify(adjust?.after)}；pending approvals=${approvals.rows[0]?.n}`);
    return { verdict: ok ? "PASS" : "FAIL", summary: `preset=${preset}, status=${data.status}, after=${JSON.stringify(adjust?.after ?? null)}` };
  });

await runCase("A5", "主链路", "含糊指令→反问澄清（不建任务）",
  "dispatch 返回 kind=clarify 且工作区线程数不增加", async (ctx) => {
    const before = pushDb(ctx, await q(`SELECT count(*)::int AS n FROM threads WHERE workspace_id='ws-yunqi'`));
    const d = await dispatch(ctx, { title: "帮我看看" });
    const after = pushDb(ctx, await q(`SELECT count(*)::int AS n FROM threads WHERE workspace_id='ws-yunqi'`));
    const data = d.response?.result?.data;
    const ok = data?.kind === "clarify" && before.rows[0].n === after.rows[0].n;
    return { verdict: ok ? "PASS" : "FAIL", summary: `kind=${data?.kind ?? "?"}, threads ${before.rows[0].n}→${after.rows[0].n}` };
  });

await runCase("A6", "主链路", "问数闭环（ask 模式即时应答）",
  "dispatch 返回 mode=ask 且带非空 answer；线程终态 completed", async (ctx) => {
    const d = await dispatch(ctx, { title: uniq("查一下昨天的订单量") });
    const data = d.response?.result?.data ?? {};
    if (data.threadId) await threadRow(ctx, data.threadId);
    const ok = data.mode === "ask" && typeof data.answer === "string" && data.answer.length > 0;
    note(ctx, `answer=${String(data.answer ?? "").slice(0, 160)}`);
    return { verdict: ok ? "PASS" : "FAIL", summary: `mode=${data.mode}, answer 长度=${String(data.answer ?? "").length}` };
  });

/* ============ B · 并发竞争 ============ */

await runCase("B1", "并发", "12 路并发裁决同一审批（只允许一次生效）",
  "仅 1 路非 deduped；approvals.status=approved；approval.gesture 事件恰 1 条；无 5xx", async (ctx) => {
    const d = await dispatch(ctx, { title: uniq("回复那条 2 分差评（并发裁决探针）"), presetKey: "review-agent", runImmediately: true });
    const tid = d.response?.result?.data?.threadId;
    const detail = await threadDetail(tokenOwner, tid);
    pushApi(ctx, detail);
    const approvalId = detail.response?.result?.data?.pending_approval_id;
    if (!approvalId) return { verdict: "FAIL", summary: "未拿到待审审批" };
    const calls = await Promise.all(Array.from({ length: 12 }, () =>
      api("/trpc/approvals.decide", { token: tokenOwner, body: { approvalId, gesture: "approve" } })));
    calls.forEach((c) => pushApi(ctx, c));
    const nonDeduped = calls.filter((c) => c.response?.result?.data?.deduped === false).length;
    const fivexx = calls.filter((c) => c.httpStatus >= 500 || c.bizStatus >= 500).length;
    const row = pushDb(ctx, await q(`SELECT status, decided_by, decided_at FROM approvals WHERE approval_id=$1`, [approvalId]));
    const gestures = pushDb(ctx, await q(
      `SELECT count(*)::int AS n FROM biz_events WHERE workspace_id='ws-yunqi'
        AND payload->'decision'->>'action'='approval.gesture'
        AND payload->'decision'->'after'->>'approvalId'=$1`, [approvalId]));
    const ok = nonDeduped === 1 && fivexx === 0 && row.rows[0]?.status === "approved" && Number(gestures.rows[0].n) === 1;
    note(ctx, `每路结果=${JSON.stringify(calls.map((c) => c.response?.result?.data?.deduped ?? c.bizStatus))}`);
    return { verdict: ok ? "PASS" : "FAIL", summary: `生效=${nonDeduped}，5xx=${fivexx}，gesture 事件=${gestures.rows[0].n}` };
  });

await runCase("B2", "并发", "12 路并发派遣（工作区并发上限 10）",
  "无 5xx；成功数 ≤10；每路 threadId 唯一；429 为预期拒绝码", async (ctx) => {
    pushDb(ctx, await q(
      `UPDATE threads SET status='completed', closed_at=now(), updated_at=now()
        WHERE workspace_id='ws-yunqi' AND status IN ('queued','running') AND id NOT IN ('T-101','T-102','T-103')`));
    const calls = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      api("/trpc/threads.dispatch", {
        token: tokenOwner,
        body: { title: uniq(`渠道价格巡检 ${i + 1}`), presetKey: "inspection-agent", runImmediately: false },
      })));
    calls.forEach((c) => pushApi(ctx, c));
    const ok200 = calls.filter((c) => c.response?.result?.data?.threadId);
    const ids = ok200.map((c) => c.response.result.data.threadId);
    const fivexx = calls.filter((c) => c.httpStatus >= 500 || c.bizStatus >= 500);
    const rejected = calls.filter((c) => c.bizStatus === 429);
    queuedForConcurrency = ids;
    pushDb(ctx, await q(`SELECT id, status FROM threads WHERE id = ANY($1::text[]) ORDER BY id`, [ids]));
    pushDb(ctx, await q(`SELECT count(*)::int AS n FROM threads WHERE workspace_id='ws-yunqi' AND status IN ('queued','running')`));
    const ok = fivexx.length === 0 && new Set(ids).size === ids.length && ok200.length <= 10 && ok200.length + rejected.length === 12;
    note(ctx, `成功=${ok200.length}，429=${rejected.length}，其它=${calls.length - ok200.length - rejected.length}`);
    return { verdict: ok ? "PASS" : "FAIL", summary: `成功=${ok200.length}, 429=${rejected.length}, 5xx=${fivexx.length}` };
  });

await runCase("B3", "并发", "12 路并发续跑同一线程（replay 幂等）",
  "全部请求不 5xx；终态唯一；该线程 step 事件不重复", async (ctx) => {
    if (queuedForConcurrency.length === 0) return { verdict: "OBSERVE", summary: "B2 未产出可续跑线程，跳过" };
    const tid = queuedForConcurrency[queuedForConcurrency.length - 1];
    const calls = await Promise.all(Array.from({ length: 12 }, () =>
      api("/trpc/threads.run", { token: tokenOwner, body: { threadId: tid, presetKey: "inspection-agent" } })));
    calls.forEach((c) => pushApi(ctx, c));
    const fivexx = calls.filter((c) => c.httpStatus >= 500 || c.bizStatus >= 500);
    const row = pushDb(ctx, await q(`SELECT status, progress_done, progress_total FROM threads WHERE id=$1`, [tid]));
    const steps = pushDb(ctx, await q(
      `SELECT payload->'decision'->>'action' AS action, payload->'decision'->'after'->>'stepId' AS step, count(*)::int AS n
         FROM biz_events WHERE session_id=$1 GROUP BY 1,2 ORDER BY 1,2`, [tid]));
    const dupeSteps = steps.rows.filter((r) => r.step && r.n > 1);
    const ok = fivexx.length === 0 && row.rows[0]?.status === "completed" && dupeSteps.length === 0;
    note(ctx, `step 事件分布=${JSON.stringify(steps.rows)}`);
    return { verdict: ok ? "PASS" : "FAIL", summary: `5xx=${fivexx.length}, 终态=${row.rows[0]?.status}, 重复 step=${dupeSteps.length}` };
  });

await runCase("B4", "并发", "12 路并发超时扫描 approvals.sweep",
  "全部成功；过期项不重复标；同项不重复写手势事件", async (ctx) => {
    const calls = await Promise.all(Array.from({ length: 12 }, () =>
      api("/trpc/approvals.sweep", { token: tokenOwner, body: {} })));
    calls.forEach((c) => pushApi(ctx, c));
    const fivexx = calls.filter((c) => c.httpStatus >= 500 || c.bizStatus >= 500);
    const rows = pushDb(ctx, await q(
      `SELECT status, count(*)::int AS n FROM approvals WHERE workspace_id='ws-yunqi' GROUP BY 1 ORDER BY 1`));
    const dupGesture = pushDb(ctx, await q(
      `SELECT approval_id, count(*)::int AS n FROM (
         SELECT payload->'decision'->'after'->>'approvalId' AS approval_id
           FROM biz_events
          WHERE workspace_id='ws-yunqi' AND payload->'decision'->>'action'='approval.gesture'
       ) s WHERE approval_id IS NOT NULL GROUP BY 1 HAVING count(*) > 2`));
    const ok = fivexx.length === 0 && dupGesture.rows.length === 0;
    return { verdict: ok ? "PASS" : "FAIL", summary: `5xx=${fivexx.length}, 状态分布=${JSON.stringify(rows.rows)}` };
  });

await runCase("B5", "并发（对照）", "串行派遣 12 次：并发上限应生效（对照组）",
  "串行到第 11 条左右出现 429（上限 10 生效）；与 B2 的 12/12 全放行形成对照", async (ctx) => {
    await drainWorkspace(ctx, "B5 前清位");
    const outcomes = [];
    for (let i = 1; i <= 12; i += 1) {
      const r = await api("/trpc/threads.dispatch", {
        token: tokenOwner,
        body: { title: uniq(`串行派遣对照 ${i}`), presetKey: "inspection-agent", runImmediately: false },
      });
      outcomes.push({ i, status: r.bizStatus, threadId: r.response?.result?.data?.threadId ?? null });
    }
    ctx.evidence.notes.push(`串行结果=${JSON.stringify(outcomes.map((o) => o.status))}`);
    pushDb(ctx, await q(`SELECT count(*)::int AS n FROM threads WHERE workspace_id='ws-yunqi' AND status IN ('queued','running')`));
    const firstReject = outcomes.find((o) => o.status === 429);
    await drainWorkspace(ctx, "B5 后清位");
    const ok = Boolean(firstReject) && firstReject.i <= 11;
    return { verdict: ok ? "PASS" : "FAIL", summary: `首次 429 在第 ${firstReject?.i ?? "-"} 条；成功 ${outcomes.filter((o) => o.status === 200).length} 条` };
  });

/* ============ C · 异常注入 ============ */

await runCase("C1", "异常注入/配置", "模型配置写入（不可达 baseUrl）必须 fail-closed",
  "saveLlmConfig 拒绝落盘（400）且 .env 的 LLM_PROVIDER 保持 mock", async (ctx) => {
    const r = pushApi(ctx, await api("/trpc/onboarding.saveLlmConfig", {
      token: tokenOwner,
      body: { provider: "dead", baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-dead", model: "dead-1" },
    }));
    const envPath = resolve(HERE, "../../../../.env");
    const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const providerLine = envText.split("\n").find((l) => l.startsWith("LLM_PROVIDER=")) ?? "(missing)";
    note(ctx, `.env: ${providerLine}`);
    const ok = r.bizStatus === 400 && providerLine === "LLM_PROVIDER=mock";
    return { verdict: ok ? "PASS" : "FAIL", summary: `status=${r.bizStatus}, ${providerLine}` };
  });

await runCase("C2", "异常注入", "goalRef 指向不存在档案 → fail-closed 且留日志",
  "线程仍建立（按标题规划），服务端出现 [dispatch] 未取到档案 警告", async (ctx) => {
    await drainWorkspace(ctx, "C2 前清位");
    const d = await dispatch(ctx, { title: uniq("渠道价格巡检（goalRef 缺失探针）"), presetKey: "inspection-agent", goalRef: `goal-nonexistent-${RUN_ID}`, runImmediately: true });
    const data = d.response?.result?.data ?? {};
    if (data.threadId) await threadRow(ctx, data.threadId);
    const logs = logSlice(0);
    ctx.evidence.logs.push({ after: 0, text: logs.slice(-3000) });
    const ok = Boolean(data.threadId) && /未取到档案/.test(logs);
    pushDb(ctx, await q(`SELECT payload->'decision'->'after' AS after FROM biz_events WHERE session_id=$1 LIMIT 1`, [data.threadId ?? ""]));
    return { verdict: ok ? "PASS" : "FAIL", summary: `threadId=${data.threadId ?? "-"}, 日志含警告=${/未取到档案/.test(logs)}` };
  });

await runCase("C3", "异常注入/状态机", "驳回路径出口探测：挂起线程被驳回后是否可达终态",
  "驳回后线程不得永久滞留 pending_review；必须有可解释的出口（终态或可续跑）", async (ctx) => {
    await drainWorkspace(ctx, "C3 前清位");
    const d = await dispatch(ctx, { title: uniq("回复那条 2 分差评（驳回探针）"), presetKey: "review-agent", runImmediately: true });
    const tid = d.response?.result?.data?.threadId;
    const detail = await threadDetail(tokenOwner, tid);
    pushApi(ctx, detail);
    const approvalId = detail.response?.result?.data?.pending_approval_id;
    if (!approvalId) return { verdict: "FAIL", summary: "未拿到待审审批" };
    const decide = pushApi(ctx, await api("/trpc/approvals.decide", {
      token: tokenOwner, body: { approvalId, gesture: "reject", reasonEnum: "reply.tone", reasonText: "M2 驳回探针" },
    }));
    await sleep(1200);
    const afterReject = (await threadRow(ctx, tid)).rows[0];
    const runAttempt = pushApi(ctx, await api("/trpc/threads.run", { token: tokenOwner, body: { threadId: tid } }));
    await sleep(800);
    const final = (await threadRow(ctx, tid)).rows[0];
    const ok = ["completed", "failed", "cancelled"].includes(String(final?.status))
      || runAttempt.response?.result?.data?.status === "completed";
    note(ctx, `驳回=${decide.response?.result?.data?.status}; 驳回后=${afterReject?.status}; run 返回值=${JSON.stringify(runAttempt.response?.result?.data ?? runAttempt.response?.error?.message)}; run 后=${final?.status}`);
    return { verdict: ok ? "PASS" : "FAIL", summary: `驳回后状态=${afterReject?.status}，run 后=${final?.status}（若仍滞留说明无出口）` };
  });

await runCase("C4", "异常注入", "重复提交同一目标（模拟双击）",
  "观察行为：是否产生两条独立线程（幂等键缺失）", async (ctx) => {
    const title = uniq("渠道价格巡检（重复提交探针）");
    const a = await dispatch(ctx, { title, presetKey: "inspection-agent", runImmediately: false });
    const b = await dispatch(ctx, { title, presetKey: "inspection-agent", runImmediately: false });
    const ida = a.response?.result?.data?.threadId;
    const idb = b.response?.result?.data?.threadId;
    pushDb(ctx, await q(`SELECT id, title, status FROM threads WHERE id = ANY($1::text[]) ORDER BY id`, [[ida, idb].filter(Boolean)]));
    const duplicated = Boolean(ida && idb && ida !== idb);
    return {
      verdict: duplicated ? "OBSERVE" : "PASS",
      summary: duplicated ? `同一目标生成两条线程 ${ida} / ${idb}（无幂等键）` : `deduped（${ida}）`,
    };
  });

await runCase("C5", "异常注入/环境", "外部工具不可用时的手尾（海报生图工具未配置）",
  "线程不得永久 running；应落到可解释终态且日志留痕", async (ctx) => {
    await drainWorkspace(ctx, "C5 前清位");
    const d = await dispatch(ctx, { title: uniq("给周末促销活动做一张海报"), presetKey: "content-agent", runImmediately: true });
    const data = d.response?.result?.data ?? {};
    if (data.threadId) {
      await sleep(1500);
      await threadRow(ctx, data.threadId);
      pushDb(ctx, await q(
        `SELECT payload->'decision'->>'action' AS action, payload->'receipt' AS receipt, payload->'decision'->'after' AS after
           FROM biz_events WHERE session_id=$1 ORDER BY seq`, [data.threadId]));
    }
    const row = data.threadId ? (await q(`SELECT status, progress_done, progress_total FROM threads WHERE id=$1`, [data.threadId])).rows[0] : null;
    const ok = Boolean(row) && row.status !== "running";
    return { verdict: ok ? "PASS" : "FAIL", summary: `dispatch=${data.status ?? "?"}, 终态=${row?.status ?? "-"} ${row?.progress_done ?? "-"}/${row?.progress_total ?? "-"}` };
  });

/* ============ D · 边界值 ============ */

await runCase("D1", "边界", "标题长度边界 0 / 500 / 501",
  "空标题 400；500 字接受；501 字 400", async (ctx) => {
    await drainWorkspace(ctx, "D1 前清位");
    const empty = pushApi(ctx, await api("/trpc/threads.dispatch", { token: tokenOwner, body: { title: "" } }));
    const max = pushApi(ctx, await api("/trpc/threads.dispatch", { token: tokenOwner, body: { title: "长".repeat(500), presetKey: "inspection-agent" } }));
    const over = pushApi(ctx, await api("/trpc/threads.dispatch", { token: tokenOwner, body: { title: "长".repeat(501) } }));
    const ok = empty.bizStatus === 400 && Boolean(max.response?.result?.data?.threadId) && over.bizStatus === 400;
    return { verdict: ok ? "PASS" : "FAIL", summary: `空=${empty.bizStatus}, 500=${max.bizStatus}, 501=${over.bizStatus}` };
  });

await runCase("D2", "边界/注入", "注入式/畸形标题（SQL / HTML / emoji / 零宽字符）原样落库不炸",
  "创建成功且 DB 中标题与输入逐字一致；无 5xx", async (ctx) => {
    await drainWorkspace(ctx, "D2 前清位");
    const samples = [
      "'; DROP TABLE threads; --",
      "<img src=x onerror=alert(1)>",
      "emoji \u{1F3E8}\u{1F525} 与零宽\u200b字符",
    ];
    const ids = [];
    for (const s of samples) {
      const r = await dispatch(ctx, { title: uniq(s), presetKey: "inspection-agent" });
      ids.push(r.response?.result?.data?.threadId ?? null);
    }
    const rows = pushDb(ctx, await q(`SELECT id, title FROM threads WHERE id = ANY($1::text[])`, [ids.filter(Boolean)]));
    const expected = samples.map((s) => uniq(s));
    const mismatch = rows.rows.filter((r) => !expected.includes(r.title));
    const ok = ids.every(Boolean) && rows.rows.length === samples.length && mismatch.length === 0;
    return { verdict: ok ? "PASS" : "FAIL", summary: `创建=${ids.filter(Boolean).length}/3，逐字一致=${mismatch.length === 0}` };
  });

await runCase("D3", "边界", "事件流分页 limit 边界 0 / 1 / 200 / 201",
  "0 与 201 被 400 拒绝；1 与 200 正常返回", async (ctx) => {
    const tid = reviewThread ?? defaultRoutingThread;
    const call = (limit) => api(`/trpc/threads.events?input=${encodeURIComponent(JSON.stringify({ threadId: tid, limit }))}`, { token: tokenOwner });
    const r0 = pushApi(ctx, await call(0));
    const r1 = pushApi(ctx, await call(1));
    const r200 = pushApi(ctx, await call(200));
    const r201 = pushApi(ctx, await call(201));
    const ok = r0.bizStatus === 400 && r1.bizStatus === 200 && r200.bizStatus === 200 && r201.bizStatus === 400;
    return { verdict: ok ? "PASS" : "FAIL", summary: `0=${r0.bizStatus}, 1=${r1.bizStatus}, 200=${r200.bizStatus}, 201=${r201.bizStatus}` };
  });

await runCase("D4", "边界", "审批状态过滤非法枚举",
  "非法 status 被 400 拒绝", async (ctx) => {
    const r = pushApi(ctx, await api(`/trpc/approvals.list?input=${encodeURIComponent(JSON.stringify({ status: "bogus" }))}`, { token: tokenOwner }));
    return { verdict: r.bizStatus === 400 ? "PASS" : "FAIL", summary: `status=${r.bizStatus}` };
  });

await runCase("D5", "边界", "批量裁决边界：空数组 / 51 项",
  "空数组 400；51 项 400（上限 50）", async (ctx) => {
    const empty = pushApi(ctx, await api("/trpc/approvals.batchApprove", { token: tokenOwner, body: { approvalIds: [] } }));
    const many = pushApi(ctx, await api("/trpc/approvals.batchApprove", {
      token: tokenOwner, body: { approvalIds: Array.from({ length: 51 }, (_, i) => `apr-m2-${i}`) },
    }));
    const ok = empty.bizStatus === 400 && many.bizStatus === 400;
    return { verdict: ok ? "PASS" : "FAIL", summary: `空=${empty.bizStatus}, 51=${many.bizStatus}` };
  });

await runCase("D6", "边界", "驳回原因长度边界 200 / 201",
  "200 字接受；201 字 400", async (ctx) => {
    await drainWorkspace(ctx, "D6 前清位");
    const mk = async () => {
      const d = await dispatch(ctx, { title: uniq("回复那条 2 分差评（原因长度探针）"), presetKey: "review-agent", runImmediately: true });
      const detail = await threadDetail(tokenOwner, d.response?.result?.data?.threadId);
      return detail.response?.result?.data?.pending_approval_id;
    };
    const a1 = await mk();
    const r200 = pushApi(ctx, await api("/trpc/approvals.decide", {
      token: tokenOwner, body: { approvalId: a1, gesture: "reject", reasonEnum: "reply.tone", reasonText: "长".repeat(200) },
    }));
    const a2 = await mk();
    const r201 = pushApi(ctx, await api("/trpc/approvals.decide", {
      token: tokenOwner, body: { approvalId: a2, gesture: "reject", reasonEnum: "reply.tone", reasonText: "长".repeat(201) },
    }));
    const ok = r200.bizStatus === 200 && r201.bizStatus === 400;
    return { verdict: ok ? "PASS" : "FAIL", summary: `200 字=${r200.bizStatus}, 201 字=${r201.bizStatus}` };
  });

/* ============ E · 状态机遍历 ============ */

await runCase("E1", "状态机", "completed 线程再 run（replay 是否幂等）",
  "重复 run completed 线程不产生重复 step 事件、状态不变", async (ctx) => {
    const tid = reviewThread;
    const before = pushDb(ctx, await q(`SELECT status, progress_done, progress_total FROM threads WHERE id=$1`, [tid]));
    const run = pushApi(ctx, await api("/trpc/threads.run", { token: tokenOwner, body: { threadId: tid } }));
    await sleep(500);
    const after = pushDb(ctx, await q(`SELECT status, progress_done, progress_total FROM threads WHERE id=$1`, [tid]));
    const dupSteps = pushDb(ctx, await q(
      `SELECT payload->'decision'->'after'->>'stepId' AS step, count(*)::int AS n
         FROM biz_events WHERE session_id=$1 AND payload->'decision'->>'action'='review.reply'
        GROUP BY 1 HAVING count(*) > 1`, [tid]));
    const ok = run.bizStatus === 200 && after.rows[0]?.status === "completed" && dupSteps.rows.length === 0;
    return { verdict: ok ? "PASS" : "FAIL", summary: `before=${before.rows[0]?.status}, after=${after.rows[0]?.status}, 重复执行=${dupSteps.rows.length}` };
  });

await runCase("E2", "状态机", "过期审批：decide 与 sweep 的终态一致性",
  "过期快照 decide 被拒并标 expired；不会出现 approved", async (ctx) => {
    const eventId = `E-m2-exp-${RUN_ID}`;
    const approvalId = `apr-m2-exp-${RUN_ID}`;
    pushDb(ctx, await q(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot, tier)
       VALUES ($1,'tenant-demo','ws-yunqi',$2,'inapp','pending',$3,'l2_captain')
       ON CONFLICT (approval_id) DO NOTHING`,
      [approvalId, eventId, JSON.stringify({ expires_at: new Date(Date.now() - 60_000).toISOString(), after: { v: 1 } })],
    ));
    const decide = pushApi(ctx, await api("/trpc/approvals.decide", { token: tokenOwner, body: { approvalId, gesture: "approve" } }));
    const row = pushDb(ctx, await q(`SELECT status FROM approvals WHERE approval_id=$1`, [approvalId]));
    const ok = decide.bizStatus >= 400 && row.rows[0]?.status === "expired";
    return { verdict: ok ? "PASS" : "FAIL", summary: `decide=${decide.bizStatus}, 终态=${row.rows[0]?.status}` };
  });

await runCase("E3", "状态机/联动", "夜班决策包投递（夜班出口链路）",
  "nightShift.deliver 正常推进状态机；若被安全网关拒绝判 FAIL", async (ctx) => {
    const current = pushApi(ctx, await api("/trpc/nightShift.current", { token: tokenOwner }));
    const runId = current.response?.result?.data?.run?.id ?? null;
    if (!runId) return { verdict: "OBSERVE", summary: "无夜班班次可投递" };
    const deliver = pushApi(ctx, await api("/trpc/nightShift.deliver", {
      token: tokenOwner,
      body: { runId, window: { from: new Date(Date.now() - 12 * 3600e3).toISOString(), to: new Date().toISOString() } },
    }));
    const after = pushApi(ctx, await api("/trpc/nightShift.current", { token: tokenOwner }));
    const ok = deliver.bizStatus === 200;
    return {
      verdict: ok ? "PASS" : "FAIL",
      summary: `deliver=${deliver.bizStatus}${ok ? "" : `：${deliver.response?.error?.message ?? ""}`}；班次状态 ${current.response?.result?.data?.run?.status} → ${after.response?.result?.data?.run?.status}`,
    };
  });

await runCase("E4", "状态机/越权", "readonly 成员越权与跨工作区读取",
  "readonly dispatch/run 403；跨工作区 threadId 查询返回空（不泄露存在性）", async (ctx) => {
    const rd = pushApi(ctx, await api("/trpc/threads.dispatch", { token: tokenReadonly, body: { title: uniq("readonly 越权探针") } }));
    const rrun = pushApi(ctx, await api("/trpc/threads.run", { token: tokenReadonly, body: { threadId: reviewThread } }));
    const foreign = pushApi(ctx, await api(`/trpc/threads.get?input=${encodeURIComponent(JSON.stringify({ threadId: "T-999999" }))}`, { token: tokenOwner }));
    pushDb(ctx, await qAppScoped(`SELECT id FROM threads WHERE workspace_id='ws-other' AND id='T-101'`));
    const ok = rd.bizStatus === 403 && rrun.bizStatus === 403 && foreign.bizStatus === 200 && foreign.response?.result?.data === null;
    return { verdict: ok ? "PASS" : "FAIL", summary: `readonly dispatch=${rd.bizStatus}, run=${rrun.bizStatus}, 不存在线程查询=${foreign.response?.result?.data === null ? "null" : "有数据"}` };
  });

await runCase("E5", "状态机（属性断言）", "全工作区不变量：completed 线程不得留未决审批 / 不得进度未满",
  "completed 且存在 pending 审批的线程数=0；completed 且 progress_done<progress_total 的线程数=0", async (ctx) => {
    const withPending = pushDb(ctx, await q(
      `SELECT t.id, t.status, t.progress_done, t.progress_total, a.approval_id, a.status AS approval_status
         FROM threads t
         JOIN biz_events e ON e.session_id = t.id
         JOIN approvals a ON a.event_id = e.event_id
        WHERE t.workspace_id='ws-yunqi' AND t.status='completed' AND a.status='pending'`));
    const progressShort = pushDb(ctx, await q(
      `SELECT id, status, progress_done, progress_total FROM threads
        WHERE workspace_id='ws-yunqi' AND status='completed'
          AND COALESCE(progress_done,0) < COALESCE(progress_total,0)`));
    const ok = withPending.rows.length === 0 && progressShort.rows.length === 0;
    return {
      verdict: ok ? "PASS" : "FAIL",
      summary: `completed+未决审批=${withPending.rows.length} 条（${withPending.rows.map((r) => r.id).join(",") || "-"}）；completed+进度未满=${progressShort.rows.length} 条（${progressShort.rows.map((r) => r.id).join(",") || "-"}）`,
    };
  });

/* ============ F · 三类错误 ============ */

await runCase("F1", "业务错误", "业务错误路径：不存在审批 / 越权角色 / 非法手势",
  "不存在审批 400/404（当前实现 BAD_REQUEST）；readonly 裁决 403；非法手势 400（结构校验）", async (ctx) => {
    const notFound = pushApi(ctx, await api("/trpc/approvals.decide", { token: tokenOwner, body: { approvalId: `apr-nonexistent-${RUN_ID}`, gesture: "approve" } }));
    const readonly = pushApi(ctx, await api("/trpc/approvals.decide", { token: tokenReadonly, body: { approvalId: reviewApprovalId, gesture: "approve" } }));
    const badGesture = pushApi(ctx, await api("/trpc/approvals.decide", { token: tokenOwner, body: { approvalId: reviewApprovalId, gesture: "maybe" } }));
    const ok = [400, 404].includes(notFound.bizStatus) && readonly.bizStatus === 403 && badGesture.bizStatus === 400;
    return { verdict: ok ? "PASS" : "FAIL", summary: `不存在=${notFound.bizStatus}, readonly=${readonly.bizStatus}, 非法手势=${badGesture.bizStatus}` };
  });

await runCase("F2", "配置错误/环境", "CEO 节拍在围栏规则装载后的可用性（company-ceo 写权限）",
  "runBeat 在规则装载后仍可写事件；若被系统级禁写 500 判 FAIL", async (ctx) => {
    const beat = pushApi(ctx, await api("/trpc/captain.runBeat", { token: tokenOwner, body: { beat: "daily" } }));
    const ok = Boolean(beat.response?.result?.data?.eventId);
    if (!ok) note(ctx, `error=${JSON.stringify(beat.response?.error ?? null).slice(0, 300)}`);
    return { verdict: ok ? "PASS" : "FAIL", summary: `status=${beat.bizStatus}, eventId=${beat.response?.result?.data?.eventId ?? "-"}` };
  });

await runCase("F3", "环境错误", "触发器引擎是否有生产调度（cron 触发器实际触发）",
  "存在消费点：trigger_fires 有记录 / trigger.fired 事件存在；否则判 FAIL（触发器空转）", async (ctx) => {
    const fires = pushDb(ctx, await q(`SELECT count(*)::int AS n FROM trigger_fires`));
    const fired = pushDb(ctx, await q(`SELECT count(*)::int AS n FROM biz_events WHERE payload->'decision'->>'action'='trigger.fired'`));
    const triggers = pushDb(ctx, await q(`SELECT count(*)::int AS n, count(*) FILTER (WHERE enabled)::int AS enabled FROM triggers WHERE workspace_id='ws-yunqi'`));
    const ok = Number(fires.rows[0].n) > 0 && Number(fired.rows[0].n) > 0;
    return {
      verdict: ok ? "PASS" : "FAIL",
      summary: `种子触发器 ${triggers.rows[0].enabled}/${triggers.rows[0].n} 启用，trigger_fires=${fires.rows[0].n}，trigger.fired 事件=${fired.rows[0].n}`,
    };
  });

/* ---------------- 汇总输出 ---------------- */

const summary = {
  taskId: "T-2026-0929-0007",
  phase: "M2 动态排雷",
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

writeFileSync(join(OUT_EVIDENCE, `m2-report-${RUN_ID}.json`), JSON.stringify(summary, null, 2));

const md = [
  `# M2 动态排雷执行记录（${RUN_ID}）`,
  "",
  `- 目标：${BASE}；工作区：${WORKSPACE_SLUG}`,
  `- 时间：${startedAt} → ${summary.finishedAt}`,
  `- 结果：${summary.counts.pass} 通过 / ${summary.counts.fail} 失败 / ${summary.counts.observe} 观察 / ${summary.counts.error} 执行异常（共 ${summary.counts.total}）`,
  "",
  "| 用例 | 维度 | 判定 | 期望 | 实测摘要 |",
  "| --- | --- | --- | --- | --- |",
  ...results.map((r) => `| ${r.id} | ${r.dimension} | ${r.verdict} | ${r.expectation.replace(/\|/g, "/")} | ${String(r.summary).replace(/\|/g, "/").slice(0, 220)} |`),
  "",
  "## 失败/观察项明细",
  "",
  ...results.filter((r) => r.verdict !== "PASS").flatMap((r) => [
    `### ${r.id} ${r.title}（${r.verdict}）`,
    "",
    `- 期望：${r.expectation}`,
    `- 实测：${r.summary || r.error || "(无摘要)"}`,
    `- 证据：API ${r.evidence.api.length} 条 / DB ${r.evidence.db.length} 条 / 日志 ${r.evidence.logs.length} 段`,
    "",
  ]),
].join("\n");
writeFileSync(join(OUT_EVIDENCE, `m2-report-${RUN_ID}.md`), md);

console.log(`\n════ M2 汇总：${summary.counts.pass} 通过 / ${summary.counts.fail} 失败 / ${summary.counts.observe} 观察 / ${summary.counts.error} 异常 ════`);
console.log(`产物：${join(OUT_EVIDENCE, `m2-report-${RUN_ID}.json`)}`);

await owner.end();
await appPool.end();
process.exit(summary.counts.fail + summary.counts.error > 0 ? 2 : 0);
