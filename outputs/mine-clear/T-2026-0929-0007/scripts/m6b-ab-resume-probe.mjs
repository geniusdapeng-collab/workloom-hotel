#!/usr/bin/env node
/**
 * M6-B · A/B 复验：续跑锚点行为（同一探针，分别在 6264944 与 12d3bda 两版代码上跑）
 *
 * 场景：plan = [s1 review.reply(rating=5 → R21 auto·写步骤), s2 review.reply(缺参 → W-01 降级人审)]
 *   ① 首跑：s1 执行（1 条回执），s2 挂起（审批 pending）
 *   ② 批准（SQL 直改 approvals.status='approved'，等价 approvals.decide 的续跑前置）
 *   ③ 续跑：期望「已完成步骤 s1 不再执行」（锚点语义）；若 s1 回执变 2 条 = 锚点失效、重复执行写步骤
 *
 * 输出 JSON：{ stepReceipts, run1, run2 }；退出码 = s1 重复执行则 1。
 * 用法：tsx --env-file=<env> outputs/mine-clear/T-2026-0929-0007/scripts/m6b-ab-resume-probe.mjs
 */
import pg from "pg";
import { runQuest } from "@workloom/runtime";

const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
const gw = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });

const ws = (await owner.query(`SELECT id, tenant_id FROM workspaces WHERE slug='yunqi-hotel' LIMIT 1`)).rows[0]
  ?? (await owner.query(`SELECT id, tenant_id FROM workspaces ORDER BY id LIMIT 1`)).rows[0];
const scope = { tenantId: ws.tenant_id, workspaceId: ws.id };
const tid = `T-M6B-AB-${Math.random().toString(36).slice(2, 8)}`;
await owner.query(
  `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, created_by)
   VALUES ($1,$2,$3,'M6-B A/B 续跑锚点探针','quest','running','MEM-001')`,
  [tid, scope.tenantId, scope.workspaceId],
);
const plan = JSON.stringify([
  { action: "review.reply", objectType: "review", tool: "review.reply", params: { rating: 5, text: "感谢您的评价" }, label: "s1 好评回复（写·R21 auto）" },
  { action: "review.reply", objectType: "review", tool: "review.reply", params: {}, label: "s2 缺参回复（写·W-01 人审）" },
]);

const run1 = await runQuest(app, gw, scope, { threadId: tid, goal: "M6-B A/B 续跑锚点探针", presetKey: "review-agent", llmCall: async () => plan });
if (run1.pendingApprovalId) {
  await owner.query(
    `UPDATE approvals SET status='approved', decided_by='MEM-001', decided_at=now(), gesture='{"type":"approve"}' WHERE approval_id=$1`,
    [run1.pendingApprovalId],
  );
}
const run2 = await runQuest(app, gw, scope, { threadId: tid, goal: "M6-B A/B 续跑锚点探针", presetKey: "review-agent", llmCall: async () => plan });

const rows = (await owner.query(
  `SELECT payload->'decision'->>'step_id' AS step,
          count(*) FILTER (WHERE payload->'receipt' IS NOT NULL)::int AS receipts,
          json_agg(DISTINCT payload->'receipt'->>'snapshot_uri') FILTER (WHERE payload->'receipt' IS NOT NULL) AS snapshots
     FROM biz_events WHERE session_id=$1 GROUP BY 1 ORDER BY 1`,
  [tid],
)).rows;
const s1 = rows.find((r) => r.step === "s1");
const duplicated = (s1?.receipts ?? 0) > 1;
console.log(JSON.stringify({
  threadId: tid,
  run1: { status: run1.status, steps: `${run1.stepsDone}/${run1.stepsTotal}`, approval: run1.pendingApprovalId },
  run2: { status: run2.status, steps: `${run2.stepsDone}/${run2.stepsTotal}` },
  stepReceipts: rows,
  verdict: duplicated ? "重复执行已完成写步骤（锚点失效）" : "已完成步骤未被重复执行（锚点生效）",
}, null, 1));

await owner.query(`UPDATE threads SET status='completed', closed_at=now() WHERE id=$1`, [tid]);
await owner.end(); await app.end(); await gw.end();
process.exit(duplicated ? 1 : 0);
