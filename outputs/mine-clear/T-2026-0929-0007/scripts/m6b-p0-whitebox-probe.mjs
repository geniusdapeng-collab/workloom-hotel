#!/usr/bin/env node
/**
 * M6-B · P0 独立复验（白盒，直调 runQuest）
 *
 * 目的（全部独立于修复者脚本实现）：
 *  A. 续跑幂等性：plan = [写步骤 s1（R21 好评回复·auto）, 写步骤 s2（缺参 → W-01 降级人审）]
 *     → 批准 → threads.run 续跑。断言「每个步骤恰好执行一次（各 1 条带回执事件）」。
 *     若 s1 出现 2 条回执事件 → 续跑重复执行了已完成的写步骤（幂等性回归）。
 *  B. 收尾校验②（未决审批不得 completed）两臂对照：
 *     控制臂：completed 线程再次 threads.run → 仍 completed；
 *     处理臂：先给线程挂一条 pending 审批（绑定其已有事件）→ threads.run 必须停在 pending_review。
 *  两臂差异只来自 pending 审批，排除「runner 拒绝重跑」的干扰解释。
 *
 * 用法：SERVER_BASE=http://127.0.0.1:8830 ./node_modules/.bin/tsx --env-file=.env \
 *        outputs/mine-clear/T-2026-0929-0007/scripts/m6b-p0-whitebox-probe.mjs
 */
import pg from "pg";
import { runQuest } from "@workloom/runtime";

const BASE = process.env.SERVER_BASE ?? "http://127.0.0.1:8830";
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
const gw = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });

const results = [];
const failures = [];
const observations = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
}
function observe(name, detail) {
  observations.push({ name, detail });
  console.log(`◌ ${name} — ${detail}`);
}

async function api(path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { httpStatus: res.status, data: json.result?.data, error: json.error };
}

const ws = (await owner.query(`SELECT id, tenant_id FROM workspaces WHERE is_example=true ORDER BY created_at DESC NULLS LAST LIMIT 1`)).rows[0];
if (!ws) {
  console.error("找不到示例工作区");
  process.exit(2);
}
const scope = { tenantId: ws.tenant_id, workspaceId: ws.id };
const agent = (await owner.query(`SELECT preset_key FROM agents WHERE workspace_id=$1 AND preset_key='review-agent' AND status IN ('ready','active') LIMIT 1`, [ws.id])).rows[0];
if (!agent) {
  console.error("示例工作区没有 review-agent");
  process.exit(2);
}

const login = await api("/trpc/auth.loginAs", { body: { workspaceSlug: "yunqi-hotel", memberNo: "MEM-001" } });
const token = login.data?.token;
check("登录 MEM-001", Boolean(token), `http=${login.httpStatus}`);

/* ---------- A. 续跑幂等性（写步骤不得重复执行） ---------- */
const tidA = `T-M6B-W1-${Math.random().toString(36).slice(2, 8)}`;
await owner.query(
  `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, created_by)
   VALUES ($1,$2,$3,'M6-B 续跑幂等探针','quest','running','MEM-001')`,
  [tidA, scope.tenantId, scope.workspaceId],
);
const planA = JSON.stringify([
  { action: "review.reply", objectType: "review", tool: "review.reply", params: { rating: 5, text: "感谢您的评价，期待再次光临" }, label: "好评回复（写步骤·R21 auto）" },
  { action: "review.reply", objectType: "review", tool: "review.reply", params: {}, label: "缺参回复（写步骤·R6 求值异常 → 人审）" },
]);
const runA1 = await runQuest(app, gw, scope, { threadId: tidA, goal: "M6-B 续跑幂等探针", presetKey: "review-agent", llmCall: async () => planA });
check("A1 首跑停在 pending_review 并挂起审批", runA1.status === "pending_review" && Boolean(runA1.pendingApprovalId), `status=${runA1.status} approval=${runA1.pendingApprovalId} steps=${runA1.stepsDone}/${runA1.stepsTotal}`);

const pre = await owner.query(
  `SELECT payload->'decision'->>'step_id' AS step,
          count(*) FILTER (WHERE payload->'receipt' IS NOT NULL)::int AS receipts
     FROM biz_events WHERE session_id=$1 GROUP BY 1 ORDER BY 1`,
  [tidA],
);
check(
  "A2 首跑：s1 已执行（1 条回执）、s2 挂起（0 条回执）",
  pre.rows.find((r) => r.step === "s1")?.receipts === 1 && pre.rows.find((r) => r.step === "s2")?.receipts === 0,
  JSON.stringify(pre.rows),
);

if (runA1.pendingApprovalId) {
  const decide = await api("/trpc/approvals.decide", { token, body: { approvalId: runA1.pendingApprovalId, gesture: "approve" } });
  check("A3 批准成功", decide.data?.status === "approved", `status=${decide.data?.status ?? JSON.stringify(decide.error).slice(0, 120)}`);
}
const runA2 = await api("/trpc/threads.run", { token, body: { threadId: tidA } });
check("A4 续跑后线程 completed 2/2", runA2.data?.status === "completed", `status=${runA2.data?.status} steps=${runA2.data?.stepsDone}/${runA2.data?.stepsTotal}`);

const post = await owner.query(
  `SELECT payload->'decision'->>'step_id' AS step,
          count(*) FILTER (WHERE payload->'receipt' IS NOT NULL)::int AS receipts,
          json_agg(DISTINCT payload->'receipt'->>'snapshot_uri') AS snapshots
     FROM biz_events WHERE session_id=$1 GROUP BY 1 ORDER BY 1`,
  [tidA],
);
const s1 = post.rows.find((r) => r.step === "s1");
const s2 = post.rows.find((r) => r.step === "s2");
check(
  "A5【幂等断言】每个步骤恰好执行一次（各 1 条回执）",
  s1?.receipts === 1 && s2?.receipts === 1,
  `s1 回执=${s1?.receipts}（${JSON.stringify(s1?.snapshots)}）; s2 回执=${s2?.receipts}（${JSON.stringify(s2?.snapshots)}）`,
);
if ((s1?.receipts ?? 0) > 1) {
  observe(
    "A5-发现：已完成写步骤在续跑时被重复执行",
    `s1(review.reply·R21 auto) 回执 ${s1.receipts} 条、快照 ${JSON.stringify(s1.snapshots)}；s2(人审步骤) 回执 ${s2?.receipts} 条`,
  );
}

/* ---------- B. 收尾校验②：未决审批不得 completed（两臂对照） ---------- */
const control = await api("/trpc/threads.run", { token, body: { threadId: tidA } });
check("B1 控制臂：无 pending 审批时重跑 → completed", control.data?.status === "completed", `status=${control.data?.status}`);

const anchor = (await owner.query(
  `SELECT event_id FROM biz_events WHERE session_id=$1 AND payload->'receipt' IS NOT NULL ORDER BY seq DESC LIMIT 1`,
  [tidA],
)).rows[0];
const injectedApproval = `apr-inj-${Date.now().toString(36)}`;
await owner.query(
  `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot, tier)
   VALUES ($1,$2,$3,$4,'slack','pending','{"injected":"m6b-probe"}','l2_captain')`,
  [injectedApproval, scope.tenantId, scope.workspaceId, anchor.event_id],
);
const treated = await api("/trpc/threads.run", { token, body: { threadId: tidA } });
const treatedRow = (await owner.query(`SELECT status, progress_done, progress_total FROM threads WHERE id=$1`, [tidA])).rows[0];
check(
  "B2 处理臂：存在 pending 审批时重跑 → 必须停在 pending_review（fail-closed）",
  treated.data?.status === "pending_review" && treatedRow?.status === "pending_review",
  `run.status=${treated.data?.status} db.status=${treatedRow?.status} progress=${treatedRow?.progress_done}/${treatedRow?.progress_total}`,
);

// 清理本探针注入的审批与线程（事件留痕保留：业务事件 append-only）
await owner.query(`DELETE FROM approvals WHERE approval_id=$1`, [injectedApproval]);
await owner.query(`UPDATE threads SET status='completed', closed_at=now(), updated_at=now() WHERE id=$1`, [tidA]);

console.log("\n=== M6-B 白盒探针结果 ===");
console.log(JSON.stringify({ workspace: scope.workspaceId, threadA: tidA, results, observations, failures }, null, 1));
await owner.end();
await app.end();
await gw.end();
process.exit(failures.length === 0 ? 0 : 1);
