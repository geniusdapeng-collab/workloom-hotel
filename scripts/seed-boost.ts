/**
 * scripts/seed-boost.ts · 酒店经营饱满运行态增强包（客群：酒店业主/店长）（SALES-DEMO）
 * 用法：pnpm db:seed:boost（幂等：事件存在即跳过、审批同 ID 跳过）
 */
import pg from "pg";
import { eventHash, safeParseReplayAwareEvent } from "@workloom/base/workdata";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom_hotel";
const GATEWAY_URL = process.env.DATABASE_GATEWAY_URL ?? "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom_hotel";
const TENANT_ID = "tenant-demo";
const WS_ID = "ws-yunqi";
const WS_NAME = "云栖酒店";
const FENCE_VERSION = "hotel-baseline/v3";
const GENESIS_HASH = "GENESIS";

const now = Date.now();
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const who = (id: string, version = "v3.0") => ({ type: "agent" as const, id, version });
const ctx = (time: string) => ({ tenant_id: TENANT_ID, workspace_id: WS_ID, time, stage: "stable", store: WS_NAME });
const mt = { model_id: "mock-001", tier: "standard", window: "peak", credits: 1 };
const receipt = (time: string) => ({ synced: true, snapshot_uri: "data/snapshots/boost.png", verified_at: time });
const ri = (rule_id: string, result = "pass") => [{ rule_id, version: FENCE_VERSION, result }];

const EVENTS: unknown[] = [
  { event_id: "E-SEED-BT-0101", who: who("channel-watcher"), context: ctx(at(2800)), object: { type: "booking_order", id: "bk-d1", label: "今日新收订" },
    decision: { action: "booking.confirm", after: {"rooms": 23, "nights": 41, "occ_forecast": "91%", "adr": 642, "revpar": 584, "channels": {"直连": 11, "OTA": 8, "企微": 4}}, basis: ["酒店管理系统实时同步"] },
    rule_impact: [], receipt: receipt(at(2800)), model_trace: mt },
  { event_id: "E-SEED-BT-0102", who: who("pricing-agent"), context: ctx(at(2600)), object: { type: "poi_store", id: "price-w", label: "周末价格策略" },
    decision: { action: "price.adjust", after: {"room": "高级大床房", "from": 628, "to": 688, "reason": "周末预测入住率 91%，超出自动放行上限", "revpar_est": "+12.4%"}, basis: ["收益管理模型"] },
    rule_impact: ri("R21","review"), receipt: receipt(at(2600)), model_trace: mt },
  { event_id: "E-SEED-BT-0103", who: who("reconcile-agent"), context: ctx(at(2400)), object: { type: "booking_order", id: "rc-d", label: "对账核销" },
    decision: { action: "order.reconcile", after: {"orders": 186, "diff": 0, "channels": 6, "note": "连续 30 天零差错"}, basis: ["三方对账规程"] },
    rule_impact: [], receipt: receipt(at(2400)), model_trace: mt },
  { event_id: "E-SEED-BT-0104", who: who("review-agent"), context: ctx(at(2200)), object: { type: "content", id: "rv-88201", label: "差评 2 小时处置" },
    decision: { action: "review.reply", after: {"rating": 2, "topic": "电梯等待", "sla": "1小时42分", "comp": "¥50 早餐券", "public": true}, basis: ["差评 2 小时内响应"] },
    rule_impact: [], receipt: receipt(at(2200)), model_trace: mt },
  { event_id: "E-SEED-BT-0105", who: who("review-agent"), context: ctx(at(2100)), object: { type: "content", id: "rv-88215", label: "好评资产化" },
    decision: { action: "review.asset.boost", after: {"rating": 5, "topic": "亲子乐园", "action": "置顶 + 沉淀 FAQ", "exposures": 1860}, basis: ["好评资产化"] },
    rule_impact: [], receipt: receipt(at(2100)), model_trace: mt },
  { event_id: "E-SEED-BT-0106", who: who("ai-receptionist"), context: ctx(at(2000)), object: { type: "service_ticket", id: "tk-5521", label: "送物工单" },
    decision: { action: "service.ticket.complete", after: {"item": "儿童牙刷×2 + 矿泉水×4", "room": "1208", "sla_min": 12, "rating": 5}, basis: ["送物 15 分钟 SLA"] },
    rule_impact: [], receipt: receipt(at(2000)), model_trace: mt },
  { event_id: "E-SEED-BT-0107", who: who("ai-receptionist"), context: ctx(at(1900)), object: { type: "service_ticket", id: "tk-5522", label: "报修工单" },
    decision: { action: "service.ticket.complete", after: {"item": "空调制冷弱", "room": "1516", "sla_min": 26, "rating": 5}, basis: ["报修 30 分钟 SLA"] },
    rule_impact: [], receipt: receipt(at(1900)), model_trace: mt },
  { event_id: "E-SEED-BT-0108", who: who("voice-front-agent"), context: ctx(at(1800)), object: { type: "service_dialog", id: "call-3392", label: "语音前台接听" },
    decision: { action: "service.chat", after: {"intent": "延迟退房", "duration_s": 47, "resolved": true, "hour": "02:13"}, basis: ["24 小时语音前台"] },
    rule_impact: [], receipt: receipt(at(1800)), model_trace: mt },
  { event_id: "E-SEED-BT-0109", who: who("channel-watcher"), context: ctx(at(1600)), object: { type: "poi_store", id: "ch-al", label: "渠道倒挂警报" },
    decision: { action: "market.scan", after: {"channel": "某在线渠道", "issue": "挂牌价低于直连 ¥30", "action": "已自动调价拉回 + 记黄牌"}, basis: ["渠道价格巡检"] },
    rule_impact: ri("R14","review"), receipt: receipt(at(1600)), model_trace: mt },
  { event_id: "E-SEED-BT-0110", who: who("guest-success"), context: ctx(at(1400)), object: { type: "service_ticket", id: "tk-5528", label: "入退高峰调度" },
    decision: { action: "service.ticket.advance", after: {"checkins": 34, "checkouts": 29, "queue": "前厅高峰 17:00-19:00 已加派 2 人"}, basis: ["入退看板"] },
    rule_impact: [], receipt: receipt(at(1400)), model_trace: mt },
  { event_id: "E-SEED-BT-0111", who: who("guest-success"), context: ctx(at(1300)), object: { type: "service_ticket", id: "tk-5530", label: "智能排房" },
    decision: { action: "booking.confirm", after: {"rooms": 18, "rules": "亲子同层/安静上楼/长住连房", "manual_fix": 1}, basis: ["智能排房引擎"] },
    rule_impact: [], receipt: receipt(at(1300)), model_trace: mt },
  { event_id: "E-SEED-BT-0112", who: who("content-agent"), context: ctx(at(1200)), object: { type: "content", id: "rc-week", label: "口碑周报" },
    decision: { action: "funnel.weekly", after: {"score": 4.7, "delta": "+0.1", "reviews": 86, "topics": ["隔音好评 ↑", "早餐丰富 ↑", "电梯等待 ↓"]}, basis: ["口碑聚类"] },
    rule_impact: [], receipt: receipt(at(1200)), model_trace: mt },
  { event_id: "E-SEED-BT-0113", who: who("desktop-agent"), context: ctx(at(1100)), object: { type: "service_ticket", id: "linen", label: "布草深度清洁" },
    decision: { action: "inspection.scan", after: {"rooms": 42, "standard": "长住房每周 2 次", "issues": 0}, basis: ["客房巡检"] },
    rule_impact: [], receipt: receipt(at(1100)), model_trace: mt },
  { event_id: "E-SEED-BT-0114", who: who("night-shift"), context: ctx(at(480)), object: { type: "night_package", id: "np-d", label: "夜班日报" },
    decision: { action: "night.package.deliver", after: {"overnight": {"calls": 7, "inquiries": 11, "resolved": "100%", "escalation": 0}, "note": "语音前台全覆盖"}, basis: ["夜班值守"] },
    rule_impact: [], receipt: receipt(at(480)), model_trace: mt },
  { event_id: "E-SEED-BT-0115", who: who("company-ceo"), context: ctx(at(60)), object: { type: "conversion", id: "brief-d", label: "经营晨报" },
    decision: { action: "ceo.briefing", after: { "occ": "91%", "revpar": 584, "adr": 642, "reconcile": "零差错（连续 30 天）", "review_sla": "100%", "today": "婚宴踩点 15 桌 + 协议客户 1 家",
      // 剧场汇报气泡只取 after.text（客户端中文校验，夹带未收录拉丁缩写会整串回落兜底文案——V4 走查修复：补 text 且全部用中文业务词）
      "text": "老板，早报已备：昨夜入住率 91%、平均房价 ¥642、每间可售房收入 ¥584，对账连续 30 天零差错，差评全部在 2 小时内办结。今日重点：婚宴踩点 15 桌、协议客户 1 家；另有 2 件老板级事项请您定。" }, basis: ["晨报节拍"] },
    rule_impact: [], receipt: receipt(at(60)), model_trace: mt },
];

const APPROVALS = [
  { id: "apr-boost-h1", eventRef: "E-SEED-BT-0102",
    snapshot: { action: "price.adjust", summary: "周末提价审批：高级大床房 ¥628 → ¥688（预测入住率 91%）", title: "周末提价 ¥628→¥688",
      ceo_rationale: "预测周末入住率 91% 超熔断线；提价后每间可售房收入预计 +12.4%，竞对同档 ¥695 仍有价格优势", rule_version: "R21 hotel-baseline/v3", gate: "必审",
      params: {"room": "高级大床房", "from": 628, "to": 688, "occ_forecast": "91%"},
      before: {"price": 628}, after: {"price": 688, "revpar_est": "+12.4%"} } },
  { id: "apr-boost-h2", eventRef: "E-SEED-BT-0101",
    snapshot: { action: "deal.quote", summary: "婚宴报价审批：国庆 15 桌 + 宾客房 30 间 ¥68,000", title: "婚宴 15 桌报价 ¥68,000",
      ceo_rationale: "国庆档期紧张，该单可锁定 30 间夜客房 + 餐饮 ¥38,000；建议赠送婚房布置换取周五晚宴档期", rule_version: "R21 hotel-baseline/v3", gate: "必审",
      params: {"tables": 15, "rooms": 30, "amount": 68000, "date": "国庆"},
      before: {"channel": "到店踩点"}, after: {"amount": 68000, "include": "15桌+30间夜+婚房布置"} } },
];

async function main() {
  const owner = new pg.Client({ connectionString: DATABASE_URL });
  await owner.connect();
  let aprNew = 0;
  for (const a of APPROVALS) {
    const exists = await owner.query(`SELECT 1 FROM approvals WHERE approval_id=$1`, [a.id]);
    if ((exists.rowCount ?? 0) > 0) continue;
    await owner.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot, created_at)
       VALUES ($1,$2,$3,$4,'inapp','pending','l4_chairman',$5,$6)`,
      [a.id, TENANT_ID, WS_ID, (a as unknown as { eventRef: string }).eventRef, JSON.stringify(a.snapshot), at(90)],
    );
    aprNew++;
  }
  console.log(`✓ 待审批：新写入 ${aprNew} 条（L4 老板级）`);
  await owner.end();

  const gw = new pg.Client({ connectionString: GATEWAY_URL });
  await gw.connect();
  await gw.query("BEGIN");
  await gw.query("SELECT set_config('app.workspace_id', $1, true)", [WS_ID]);
  await gw.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_ID]);
  const last = await gw.query(`SELECT hash FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq DESC LIMIT 1`, [TENANT_ID, WS_ID]);
  let prevHash = (last.rows[0]?.hash as string) ?? GENESIS_HASH;
  let inserted = 0, skipped = 0;
  for (const raw of EVENTS) {
    const ev = raw as { event_id: string; context: { time: string } };
    const checked = safeParseReplayAwareEvent(ev as never);
    if (!checked.success) throw new Error(`事件 ${ev.event_id} 未过校验：${checked.error.message}`);
    const dup = await gw.query(`SELECT 1 FROM biz_events WHERE tenant_id=$1 AND event_id=$2`, [TENANT_ID, ev.event_id]);
    if ((dup.rowCount ?? 0) > 0) { skipped++; continue; }
    const payload = JSON.stringify(checked.data);
    const hash = eventHash(prevHash, checked.data);
    const res = await gw.query<{ inserted: boolean }>(
      `SELECT * FROM append_event_insert($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ev.event_id, TENANT_ID, WS_ID, null, payload, prevHash, hash, ev.context.time],
    );
    if (res.rows[0]?.inserted) { prevHash = hash; inserted++; } else skipped++;
  }
  await gw.query("COMMIT");
  await gw.end();
  console.log(`✓ 剧本事件：新写入 ${inserted} 条，幂等跳过 ${skipped} 条`);
  console.log("酒店经营饱满运行态就绪 ✅（OCC 91% · 对账零差错30d · 差评2h SLA · L4决策2件）");
}

main().catch((e) => { console.error(e); process.exit(1); });
