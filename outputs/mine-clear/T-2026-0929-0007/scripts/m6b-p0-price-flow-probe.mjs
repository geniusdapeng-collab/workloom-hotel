#!/usr/bin/env node
/**
 * M6-B · P0 独立复验（真实 HTTP 流 & 多步写步骤幂等）：调价 Quest
 * 目的：在产品真实入口（threads.dispatch → 审批 → threads.run 续跑）中观察
 *       「续跑是否重复执行已完成的步骤」。与 A2 差评流不同，本流首步即写步骤。
 * 用法：SERVER_BASE=http://127.0.0.1:8830 ./node_modules/.bin/tsx --env-file=.env \
 *        outputs/mine-clear/T-2026-0929-0007/scripts/m6b-p0-price-flow-probe.mjs
 */
import pg from "pg";

const BASE = process.env.SERVER_BASE ?? "http://127.0.0.1:8830";
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const tag = Date.now().toString(36);

async function api(path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { httpStatus: res.status, data: json.result?.data, error: json.error };
}

const login = await api("/trpc/auth.loginAs", { body: { workspaceSlug: "yunqi-hotel", memberNo: "MEM-001" } });
const token = login.data?.token;
const dispatch = await api("/trpc/threads.dispatch", {
  token,
  body: { title: `把雅致大床房调价 2%（M6-B 幂等 ${tag}）`, runImmediately: true },
});
const threadId = dispatch.data?.threadId;
console.log("dispatch:", JSON.stringify(dispatch.data));

async function dump(label) {
  const rows = (await owner.query(
    `SELECT seq, payload->'decision'->>'action' AS action, payload->'decision'->>'tool' AS tool,
            payload->'decision'->>'step_id' AS step, payload->'decision'->'params' AS params,
            (payload->'receipt' IS NOT NULL) AS has_receipt, payload->'receipt'->>'snapshot_uri' AS snapshot
       FROM biz_events WHERE session_id=$1 ORDER BY seq`,
    [threadId],
  )).rows;
  console.log(`--- ${label} ---`);
  for (const r of rows) console.log(JSON.stringify(r));
  return rows;
}

const before = await dump("首跑事件");
const approvalId = dispatch.data?.pending_approval_id
  ?? (await api(`/trpc/threads.get?input=${encodeURIComponent(JSON.stringify({ threadId }))}`, { token })).data?.pending_approval_id;

let after = before;
if (approvalId) {
  const decide = await api("/trpc/approvals.decide", { token, body: { approvalId, gesture: "approve" } });
  const run = await api("/trpc/threads.run", { token, body: { threadId } });
  console.log("decide:", JSON.stringify(decide.data), "run:", JSON.stringify(run.data));
  after = await dump("续跑后事件");
} else {
  console.log("未产生审批（首跑未挂起）");
}

const counts = {};
for (const r of after) {
  if (!r.step || !r.has_receipt) continue;
  counts[r.step] = counts[r.step] ?? { n: 0, tools: [] };
  counts[r.step].n += 1;
  counts[r.step].tools.push(r.tool);
}
const dup = Object.entries(counts).filter(([, v]) => v.n > 1);
console.log("\n每步回执执行次数:", JSON.stringify(counts));
console.log(dup.length ? `✗ 发现重复执行：${JSON.stringify(dup)}` : "✓ 无重复执行");

const thread = (await owner.query(`SELECT status, progress_done, progress_total FROM threads WHERE id=$1`, [threadId])).rows[0];
console.log("线程终态:", JSON.stringify(thread));
await owner.end();
process.exit(dup.length ? 1 : 0);
