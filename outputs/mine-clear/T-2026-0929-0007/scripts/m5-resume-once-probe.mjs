#!/usr/bin/env node
/**
 * 续跑幂等探针（M6-B A5 反例的回归锚）：
 *   2 步 Quest：s1 = 只读（auto 执行）→ s2 = 写（挂起人审）→ 批准 → 续跑
 *   断言：s1 恰好 1 条回执（不得因续跑重跑）、s2 恰好 1 条回执、线程 completed 2/2
 *
 * 用法：./node_modules/.bin/tsx --env-file=.env outputs/mine-clear/T-2026-0929-0007/scripts/m5-resume-once-probe.mjs
 */
import pg from "pg";
import { runQuest } from "@workloom/runtime";

const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
const gw = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ws = await owner.query(`SELECT id, tenant_id FROM workspaces ORDER BY id LIMIT 1`);
const scope = { tenantId: ws.rows[0].tenant_id, workspaceId: ws.rows[0].id };
const tid = `T-M5RESUME-${Math.random().toString(36).slice(2, 8)}`;
const presetKey = "review-agent";

await owner.query(
  `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, created_by)
   VALUES ($1,$2,$3,'续跑幂等探针','quest','queued','MEM-001')`,
  [tid, scope.tenantId, scope.workspaceId],
);

const plan = JSON.stringify([
  { action: "review.list", objectType: "review", tool: "review.list", params: {}, label: "读取差评" },
  { action: "review.reply", objectType: "review", tool: "review.reply", params: { reply: "抱歉给您带来不便" }, label: "回复差评" },
]);
const run = () => runQuest(app, gw, scope, { threadId: tid, goal: "回复差评并留痕", presetKey, llmCall: async () => plan });

const receipts = async () => {
  const r = await owner.query(
    `SELECT payload->'decision'->>'step_id' AS step_id, count(*)::int AS n
       FROM biz_events
      WHERE workspace_id=$1 AND session_id=$2 AND payload->'receipt' IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
    [scope.workspaceId, tid],
  );
  return Object.fromEntries(r.rows.map((x) => [x.step_id, Number(x.n)]));
};

const r1 = await run();
const first = await receipts();

if (r1.status === "pending_review" && r1.pendingApprovalId) {
  await owner.query(`UPDATE approvals SET status='approved', decided_at=now() WHERE approval_id=$1`, [r1.pendingApprovalId]);
}
const r2 = await run();
const second = await receipts();
const thread = (await owner.query(`SELECT status, progress_done, progress_total FROM threads WHERE id=$1`, [tid])).rows[0];

const ok = r2.status === "completed"
  && second.s1 === 1 && second.s2 === 1
  && Number(thread.progress_done) === 2 && Number(thread.progress_total) === 2;

console.log(JSON.stringify({
  threadId: tid,
  run1: { status: r1.status, steps: `${r1.stepsDone}/${r1.stepsTotal}`, approval: r1.pendingApprovalId ?? null },
  receiptsAfterRun1: first,
  run2: { status: r2.status, steps: `${r2.stepsDone}/${r2.stepsTotal}` },
  receiptsAfterRun2: second,
  thread,
  duplicateExecution: Object.values(second).some((n) => n > 1),
}, null, 2));

await owner.query(`DELETE FROM approvals WHERE event_id IN (SELECT event_id FROM biz_events WHERE session_id=$1)`, [tid]);
await owner.query(`DELETE FROM threads WHERE id=$1`, [tid]);
await app.end(); await gw.end(); await owner.end();
console.log(ok ? "✓ 续跑幂等成立（每步恰好一条执行回执）" : "✗ 续跑幂等不成立（存在重复执行或未完成）");
process.exit(ok ? 0 : 1);
