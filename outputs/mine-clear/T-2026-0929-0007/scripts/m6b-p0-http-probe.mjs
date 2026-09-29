#!/usr/bin/env node
/**
 * M6-B · P0 独立复验（HTTP 端到端，MC-201 假完成）
 *
 * 目的：独立于修复者 scripts/m2-runner.mjs 的实现，用「接口响应 + 本人直连 SQL」
 * 复现 P0 触发链：差评 Quest → 围栏求值异常降级人审 → 批准 → 续跑。
 *
 * 断言（失败即退出码 1）：
 *  1. dispatch 返回 pending_review，且线程确有 pending 审批
 *  2. 批准前：被降级的写步骤「没有执行回执」（挂起事件不得算已执行）
 *  3. 批准后 threads.run 返回 completed，DB 线程 completed 且 progress_done==progress_total
 *  4. 批准后：每个步骤都有带回执的执行事件（被降级步骤必须真的执行，不得被跳过）
 *  5. 该线程无任何 pending 审批残留
 *  6. 全工作区属性：不存在 completed 且 progress 未满的线程；不存在 completed 且仍有 pending 审批的线程
 *
 * 用法：SERVER_BASE=http://127.0.0.1:8830 ./node_modules/.bin/tsx --env-file=.env \
 *        outputs/mine-clear/T-2026-0929-0007/scripts/m6b-p0-http-probe.mjs
 */
import pg from "pg";

const BASE = process.env.SERVER_BASE ?? "http://127.0.0.1:8830";
const OWNER_URL = process.env.DATABASE_URL;
if (!OWNER_URL) {
  console.error("DATABASE_URL 未设置");
  process.exit(2);
}

const owner = new pg.Pool({ connectionString: OWNER_URL });
const results = [];
const failures = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
}

async function api(path, { token, body, method } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { httpStatus: res.status, data: json.result?.data, error: json.error };
}

const login = await api("/trpc/auth.loginAs", { body: { workspaceSlug: "yunqi-hotel", memberNo: "MEM-001" } });
const token = login.data?.token;
check("登录 MEM-001 成功", Boolean(token), `http=${login.httpStatus} token=${token ? "有" : "无"}`);
if (!token) process.exit(2);

const title = `回复那条 2 分差评（M6-B 独立复验 ${Date.now().toString(36)}）`;
const dispatch = await api("/trpc/threads.dispatch", {
  token,
  body: { title, presetKey: "review-agent", runImmediately: true },
});
const threadId = dispatch.data?.threadId;
check("① dispatch 返回 threadId", Boolean(threadId), `status=${dispatch.data?.status} thread=${threadId ?? JSON.stringify(dispatch).slice(0, 200)}`);
if (!threadId) process.exit(2);

const detail = await api(`/trpc/threads.get?input=${encodeURIComponent(JSON.stringify({ threadId }))}`, { token });
const pendingApprovalId = detail.data?.pending_approval_id ?? null;
check(
  "① dispatch 状态为 pending_review（降级人审）",
  dispatch.data?.status === "pending_review",
  `dispatch.status=${dispatch.data?.status}`,
);
check("① 线程带 pending 审批 id", Boolean(pendingApprovalId), `pending_approval_id=${pendingApprovalId}`);

const eventsPre = await owner.query(
  `SELECT seq, payload->'decision'->>'action' AS action, payload->'decision'->>'step_id' AS step,
          (payload->'receipt') AS receipt, payload->'decision'->'basis' AS basis,
          payload->'rule_impact' AS rule_impact
     FROM biz_events WHERE session_id=$1 ORDER BY seq`,
  [threadId],
);
const stepsPre = [...new Set(eventsPre.rows.map((r) => r.step).filter(Boolean))];
const withReceiptPre = new Set(eventsPre.rows.filter((r) => r.receipt && r.receipt !== null).map((r) => r.step));
const hangingSteps = stepsPre.filter((s) => !withReceiptPre.has(s));
check(
  "② 批准前：存在「已挂起但无回执」的写步骤（P0 触发点成立）",
  hangingSteps.length > 0,
  `steps=${JSON.stringify(stepsPre)} 无回执步骤=${JSON.stringify(hangingSteps)} 事件数=${eventsPre.rows.length}`,
);

if (pendingApprovalId) {
  const decide = await api("/trpc/approvals.decide", { token, body: { approvalId: pendingApprovalId, gesture: "approve" } });
  check("③ 批准成功", decide.data?.status === "approved", `status=${decide.data?.status ?? JSON.stringify(decide.error).slice(0, 160)}`);
}

const run = await api("/trpc/threads.run", { token, body: { threadId } });
check("③ threads.run 返回 completed", run.data?.status === "completed", `status=${run.data?.status} steps=${run.data?.stepsDone}/${run.data?.stepsTotal}`);

const thread = (await owner.query(`SELECT status, progress_done, progress_total FROM threads WHERE id=$1`, [threadId])).rows[0];
check(
  "③ DB 线程 completed 且 progress 满载",
  thread?.status === "completed" && Number(thread.progress_done) === Number(thread.progress_total),
  `status=${thread?.status} progress=${thread?.progress_done}/${thread?.progress_total}`,
);

const eventsPost = await owner.query(
  `SELECT seq, payload->'decision'->>'action' AS action, payload->'decision'->>'step_id' AS step,
          (payload->'receipt') AS receipt, payload->'decision'->'basis' AS basis
     FROM biz_events WHERE session_id=$1 ORDER BY seq`,
  [threadId],
);
const stepsPost = [...new Set(eventsPost.rows.map((r) => r.step).filter(Boolean))];
const withReceiptPost = new Set(eventsPost.rows.filter((r) => r.receipt && r.receipt !== null).map((r) => r.step));
const missing = stepsPost.filter((s) => !withReceiptPost.has(s));
check(
  "④ 批准后：每个步骤均有带回执的执行事件（降级步骤真的执行了）",
  stepsPost.length > 0 && missing.length === 0,
  `steps=${JSON.stringify(stepsPost)} 无回执=${JSON.stringify(missing)}`,
);
check(
  "④ 批准前挂起的步骤在批准后获得回执",
  hangingSteps.length > 0 && hangingSteps.every((s) => withReceiptPost.has(s)),
  `挂起步骤=${JSON.stringify(hangingSteps)} 批准后回执集合=${JSON.stringify([...withReceiptPost])}`,
);

const pendingLeft = await owner.query(
  `SELECT count(*)::int AS n FROM approvals a JOIN biz_events e ON e.event_id=a.event_id AND e.workspace_id=a.workspace_id
    WHERE a.status='pending' AND e.session_id=$1`,
  [threadId],
);
check("⑤ 线程无 pending 审批残留", pendingLeft.rows[0].n === 0, `pending=${pendingLeft.rows[0].n}`);

const propProgress = await owner.query(
  `SELECT count(*)::int AS n FROM threads WHERE status='completed' AND progress_done < progress_total`,
);
check("⑥ 属性：无 completed 且 progress 未满的线程", propProgress.rows[0].n === 0, `违规线程=${propProgress.rows[0].n}`);

const propPending = await owner.query(
  `SELECT count(*)::int AS n FROM threads t WHERE t.status='completed' AND EXISTS (
     SELECT 1 FROM approvals a JOIN biz_events e ON e.event_id=a.event_id AND e.workspace_id=a.workspace_id
      WHERE a.status='pending' AND e.session_id=t.id)`,
);
check("⑥ 属性：无 completed 且仍有 pending 审批的线程", propPending.rows[0].n === 0, `违规线程=${propPending.rows[0].n}`);

const gesture = await owner.query(
  `SELECT count(*)::int AS n FROM biz_events
    WHERE payload->'decision'->>'action'='approval.gesture' AND payload->'decision'->'after'->>'approvalId'=$1`,
  [pendingApprovalId ?? ""],
);
check("⑦ 批准手势恰留痕 1 条（审批语义未被改动）", gesture.rows[0].n === 1, `approval.gesture=${gesture.rows[0].n}`);

const lastEvents = eventsPost.rows
  .filter((r) => r.step && withReceiptPost.has(r.step))
  .map((r) => ({ seq: r.seq, action: r.action, step: r.step, receipt: r.receipt, basis: r.basis }));
console.log("\n降级步骤执行事件（原文）：");
console.log(JSON.stringify(lastEvents[lastEvents.length - 1] ?? null, null, 1));

console.log("\n=== M6-B P0 HTTP 探针结果 ===");
console.log(JSON.stringify({ threadId, approvalId: pendingApprovalId, cases: results, failures }, null, 1));

await owner.end();
process.exit(failures.length === 0 ? 0 : 1);
