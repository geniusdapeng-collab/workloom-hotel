#!/usr/bin/env node
/**
 * MC-202 互斥探针（可复跑）：
 *   同一线程并发两次 runQuest，断言
 *     ① 只有一个执行者真正跑（另一个返回 running 且不写事件、不改线程）
 *     ② 事件库里该线程每个 step_id 至多一条**带回执**的执行事件（不重复执行）
 *
 * 用法（需 .env 指向审计库）：
 *   ./node_modules/.bin/tsx --env-file=.env outputs/mine-clear/T-2026-0929-0007/scripts/m5-concurrency-probe.mjs
 */
import pg from "pg";
import { runQuest } from "@workloom/runtime";

const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
const gw = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ws = await owner.query(`SELECT id, tenant_id FROM workspaces ORDER BY id LIMIT 1`);
const scope = { tenantId: ws.rows[0].tenant_id, workspaceId: ws.rows[0].id };
const tid = `T-M5CONC-${Math.random().toString(36).slice(2, 8)}`;

const agent = await owner.query(`SELECT preset_key FROM agents WHERE workspace_id=$1 AND status='ready' ORDER BY preset_key LIMIT 1`, [scope.workspaceId]);
const presetKey = agent.rows[0].preset_key;

await owner.query(
  `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, created_by)
   VALUES ($1,$2,$3,'并发互斥探针','quest','queued','MEM-001')`,
  [tid, scope.tenantId, scope.workspaceId],
);

const plan = JSON.stringify([
  { action: "suite.concurrent.read", objectType: "task", tool: `${presetKey}.read`, params: {}, label: "只读步骤" },
]);
const run = () => runQuest(app, gw, scope, { threadId: tid, goal: "并发互斥探针", presetKey, llmCall: async () => plan });

const [a, b] = await Promise.all([run(), run()]);
const statuses = [a.status, b.status].sort();

const events = await owner.query(
  `SELECT payload->'decision'->>'step_id' AS step_id,
          (payload->'decision'->'receipt' IS NOT NULL) AS has_receipt
     FROM biz_events WHERE workspace_id=$1 AND session_id=$2`,
  [scope.workspaceId, tid],
);
const execEvents = events.rows.filter((r) => r.has_receipt === true);
const dup = execEvents.length - new Set(execEvents.map((r) => r.step_id)).size;
const thread = await owner.query(`SELECT status, progress_done, progress_total FROM threads WHERE id=$1`, [tid]);

console.log(JSON.stringify({
  threadId: tid,
  statuses,
  busyRejected: statuses.filter((s) => s === "running").length,
  executedRuns: statuses.filter((s) => s !== "running").length,
  execEvents: execEvents.length,
  duplicateStepExecutions: dup,
  thread: thread.rows[0],
}, null, 2));

const ok = statuses.filter((s) => s === "running").length === 1 && dup === 0;

// 事件库 append-only（INV-2，触发器 workloom_no_mutate 拒绝 DELETE）——探针只回收审批行与线程行，
// 事件留痕保留（探针线程 ID 带 T-M5CONC- 前缀，可据此区分）。
await owner.query(`DELETE FROM approvals WHERE event_id IN (SELECT event_id FROM biz_events WHERE session_id=$1)`, [tid]);
await owner.query(`DELETE FROM threads WHERE id=$1`, [tid]);
await app.end(); await gw.end(); await owner.end();
console.log(ok ? "✓ MC-202 互斥成立（恰一个执行者，零重复执行）" : "✗ MC-202 互斥未成立");
process.exit(ok ? 0 : 1);
