#!/usr/bin/env node
/**
 * M6-B · 跨进程互斥探针（单臂）
 * 用法：ARM_LABEL=A ADM_DELAY_MS=0 ARM_HOLD_MS=4000 tsx --env-file=.env m6b-lock-arm.mjs <threadId>
 * 两臂并行运行同一 threadId：期望恰一臂 completed，另一臂 status=running（让位），且无重复执行。
 */
import pg from "pg";
import { runQuest } from "@workloom/runtime";

const tid = process.argv[2];
const label = process.env.ARM_LABEL ?? "?";
const delayMs = Number(process.env.ARM_DELAY_MS ?? 0);
const holdMs = Number(process.env.ARM_HOLD_MS ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
const gw = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
const ws = (await owner.query(`SELECT id, tenant_id FROM workspaces WHERE slug='yunqi-hotel' LIMIT 1`)).rows[0];
const scope = { tenantId: ws.tenant_id, workspaceId: ws.id };
const plan = JSON.stringify([
  { action: "review.list", objectType: "review", tool: "review.list", params: {}, label: "并发互斥探针·只读步骤" },
]);

await sleep(delayMs);
const startedAt = Date.now();
const r = await runQuest(app, gw, scope, {
  threadId: tid,
  goal: "M6-B 跨进程互斥探针",
  presetKey: "review-agent",
  llmCall: async () => { await sleep(holdMs); return plan; },
});
console.log(JSON.stringify({
  arm: label,
  startedAt: new Date(startedAt).toISOString(),
  elapsedMs: Date.now() - startedAt,
  status: r.status,
  steps: `${r.stepsDone}/${r.stepsTotal}`,
  blockedBy: r.blockedBy ?? null,
}));
await owner.end(); await app.end(); await gw.end();
