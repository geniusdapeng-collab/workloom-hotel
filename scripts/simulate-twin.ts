/**
 * A6 · 售前数字孪生：云栖酒店 30 天经营模拟（PRD 售前演示场景）
 * 用法：pnpm db:seed && pnpm demo:twin（在种子之上叠加 30 天经营数据；幂等，可重复执行）
 *      pnpm demo:twin:snapshot  —— 导出快照到 demo/twin/yunqi-30d.sql.gz
 *      pnpm demo:twin:restore   —— 免模拟一键恢复快照（售前现场演示用）
 *
 * 目的：让客户在签约前看到「一家真实使用中的酒店」——
 *   30 天 × 全业务域五元事件（订单/调价/差评/夜审/电话/FAQ/断点/倒挂/布草），
 *   含完整哈希链、审批流、围栏命中（R1–R24 全谱样本）、根因闭环与 FAQ 知识库生长。
 *
 * 纪律：
 *  - 确定性随机（mulberry32 固定种子），任意时刻重跑产出逐字节一致的数据集；
 *  - 事件只经 workloom_gateway 角色写入（F1.2），逐条过 safeParseBusinessEvent（附录 E）；
 *  - 哈希链与生产同口径（eventHash/canonicalJson，#32 修复口径）；
 *  - 幂等：UNIQUE(tenant_id,event_id) 冲突丢弃（L1.4），审批 ON CONFLICT DO NOTHING。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { safeParseBusinessEvent } from "@workloom/shared";
import { eventHash } from "@workloom/base/workdata";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BUNDLE_DIR = join(REPO_ROOT, "bundles/hotel");

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
const GATEWAY_URL =
  process.env.DATABASE_GATEWAY_URL ??
  "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";

const TENANT_ID = "tenant-demo";
const WS_ID = "ws-yunqi";
const WS_NAME = "云栖酒店";
const FENCE_VERSION = "hotel-baseline/v3";
const GENESIS_HASH = "GENESIS";
const EVENT_BASE = 20000; // 事件编号 E-20001 起（与 seed 的 E-88xx 区段隔离）
const DAYS = 30;
const START = new Date("2026-07-22T00:00:00+08:00"); // 固定窗口：2026-07-22 ~ 2026-08-20

/* ================= 确定性随机 ================= */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260821);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;
const iso = (d: Date) => d.toISOString();

/* ================= 演示维度 ================= */
const ROOM_TYPES = [
  { id: "RT-DLX-KING", label: "雅致大床房", base: 458 },
  { id: "RT-FAM-TWIN", label: "亲子双床房", base: 528 },
  { id: "RT-BIZ-KING", label: "商旅大床房", base: 398 },
] as const;
const CHANNELS = ["美团", "携程", "飞猪"] as const;
const FAQ_TOPICS = ["停车场", "早餐时间", "退房时间", "WIFI密码", "发票开具", "加床政策", "充电桩", "宠物入住", "行李寄存", "周边地铁"] as const;

interface Preset { preset_key: string; version: string }
function loadPresets(): Preset[] {
  const dir = join(BUNDLE_DIR, "presets");
  return readdirSync(dir).sort().map((f) => {
    const raw = readFileSync(join(dir, f), "utf-8");
    return {
      preset_key: raw.match(/^preset_key:\s*(.+)$/m)?.[1]?.trim() ?? f.replace(/\.yml$/, ""),
      version: raw.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? "v1.0",
    };
  });
}
let PRESETS: Preset[] = [];
const agentWho = (key: string) => {
  const p = PRESETS.find((x) => x.preset_key === key);
  return { type: "agent" as const, id: key, version: p?.version ?? "v1.0" };
};
const humanWho = (id: string) => ({ type: "human" as const, id });

interface TwinEvent {
  event_id: string;
  who: { type: "human" | "agent" | "system"; id: string; version?: string };
  context: { tenant_id: string; workspace_id: string; time: string; channel?: string; stage?: string; store?: string; [k: string]: unknown };
  object: { type: string; id?: string; [k: string]: unknown };
  decision: { action: string; before?: unknown; after?: unknown; basis?: string[]; [k: string]: unknown };
  rule_impact: Array<{ rule_id: string; version: string; result: string }>;
  receipt?: { synced?: boolean; snapshot_uri?: string; verified_at?: string };
  model_trace?: { model_id: string; tier?: string; window?: string; credits?: number };
  [k: string]: unknown;
}

let seq = 0;
const nextId = () => `E-${EVENT_BASE + ++seq}`;
const mt = (tier: "standard" | "flagship", night: boolean) => ({
  model_id: "mock-hotel-001", tier, window: night ? "off-peak" : "peak", credits: tier === "flagship" ? 2 : 1,
});
const receipt = (t: Date, id: string) => ({
  synced: true, snapshot_uri: `data/snapshots/${id.toLowerCase()}.png`, verified_at: iso(new Date(t.getTime() + 45_000)),
});
const ctx = (t: Date, channel?: string) => ({
  tenant_id: TENANT_ID, workspace_id: WS_ID, time: iso(t), stage: "stable", store: WS_NAME,
  ...(channel ? { channel } : {}),
});
const at = (day: number, h: number, m = int(0, 59)) =>
  new Date(START.getTime() + day * 86_400_000 + (h * 60 + m) * 60_000);

/** 审批队列登记项（review/block 事件 → approvals 表） */
interface ApprovalItem { eventId: string; level: "review" | "block"; title: string; time: Date }
const approvalsToCreate: ApprovalItem[] = [];

/** 夜班决策包事件登记（事件落库后回填 night_runs 表） */
const nightPackages: Array<{ day: number; runDate: string; eventId: string; done: number; pending: number; escalate: number }> = [];
const fmtDate = (day: number) => new Date(START.getTime() + day * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10);

/* ================= 场景生成器 ================= */
function evOrderConfirm(t: Date): TwinEvent {
  const rt = pick(ROOM_TYPES);
  const id = nextId();
  return {
    event_id: id, who: agentWho("frontdesk-agent"), context: ctx(t, pick(CHANNELS)),
    object: { type: "order", id: `OD-${int(100000, 999999)}` },
    decision: {
      action: "order.confirm",
      params: { available: int(1, 12), room_type: rt.id, nights: int(1, 3), amount: rt.base * int(1, 3) },
      after: { status: "confirmed" }, basis: ["信息完整校验通过", "可售库存充足"],
    },
    rule_impact: [], receipt: receipt(t, id), model_trace: mt("standard", false),
  };
}
function evCheckinOut(t: Date, kind: "checkin" | "checkout"): TwinEvent {
  const id = nextId();
  return {
    event_id: id, who: agentWho("frontdesk-agent"), context: ctx(t),
    object: { type: "room", id: `${int(2, 8)}0${int(1, 8)}` },
    decision: {
      action: kind === "checkin" ? "pms.checkin" : "pms.checkout",
      after: kind === "checkin" ? { room_assigned: true, eta_min: 3 } : { settled: true, deposit_refund_min: 4 },
      basis: [kind === "checkin" ? "智能排房（画像+房况）" : "自动查房达标+自动结算"],
    },
    rule_impact: [], receipt: receipt(t, id),
  };
}
function evPriceAdjust(t: Date, night: boolean): TwinEvent {
  const rt = pick(ROOM_TYPES);
  const id = nextId();
  const before = rt.base + int(-15, 15);
  const maxUp = night ? 0.03 : 0.07;
  const after = Math.round(before * (1 + rand() * maxUp));
  const rule = night ? "R7" : "R1";
  return {
    event_id: id, who: agentWho("pricing-agent"),
    context: { ...ctx(t, pick(CHANNELS)), night_shift: night },
    object: { type: "room_price", id: rt.id, label: rt.label },
    decision: {
      action: "price.adjust", before: { price: before }, after: { price: after },
      basis: night ? ["夜班窗口微调（R7 ≤3%）", "竞对西湖云舍同房型 ¥" + (after + int(10, 40))] : ["近 7 日 OCC 0.78", "竞对价格卡"],
    },
    rule_impact: [{ rule_id: rule, version: FENCE_VERSION, result: "pass" }],
    receipt: receipt(t, id), model_trace: mt("standard", night),
  };
}
function evReview(t: Date, bad: boolean, pendingApproval: boolean): TwinEvent {
  const id = nextId();
  const rating = bad ? int(1, 3) : int(4, 5);
  return {
    event_id: id, who: agentWho("review-agent"), context: ctx(t, pick(CHANNELS)),
    object: { type: "review", id: `RV-${int(10000, 99999)}` },
    decision: {
      action: "review.reply",
      params: { rating },
      after: bad
        ? { draft: "非常抱歉给您带来不好的体验，我们已核实问题并安排整改……" }
        : { published: true, reply: "感谢您的认可，期待下次光临！" },
      basis: bad ? ["品牌规范致歉结构", "档案 forbidden 已核对"] : ["好评感谢模板+个性化元素"],
    },
    rule_impact: bad ? [{ rule_id: "R6", version: FENCE_VERSION, result: "review" }] : [],
    model_trace: mt("standard", false),
    ...(pendingApproval ? {} : {}),
  };
}
function evPhoneCall(t: Date): TwinEvent {
  const id = nextId();
  const topic = pick(FAQ_TOPICS);
  const hit = rand() < 0.78;
  return {
    event_id: id, who: agentWho("phone-agent"), context: ctx(t),
    object: { type: "phone_call", id: `PC-${int(10000, 99999)}` },
    decision: {
      action: "call.summary",
      params: { intent: hit ? "faq" : "transfer", topic, faq_hit: hit, duration_sec: int(25, 180) },
      after: hit ? { answered: true, answer_source: "faq_kb" } : { transferred: "frontdesk", context_attached: true },
      basis: [hit ? `faq_kb 命中「${topic}」（一店一档口径）` : "超出知识库→转人工（不硬答）"],
    },
    rule_impact: [], model_trace: mt("standard", false),
  };
}
function evReconcile(t: Date): TwinEvent {
  const id = nextId();
  return {
    event_id: id, who: agentWho("reconcile-agent"), context: ctx(t, "夜班"),
    object: { type: "order", id: `OD-${int(100000, 999999)}` },
    decision: {
      action: "order.reconcile", params: { guarantee_anomaly: false },
      after: { diff: 0, rounds: 3 }, basis: ["订单流水 × 渠道结算 × 担保核验三轮比对一致"],
    },
    rule_impact: [{ rule_id: "R5", version: FENCE_VERSION, result: "pass" }],
    model_trace: mt("standard", true),
  };
}
function evCompetitorFetch(t: Date): TwinEvent {
  const id = nextId();
  return {
    event_id: id, who: agentWho("competitor-agent"), context: ctx(t, "夜班"),
    object: { type: "channel", id: "competitor-watch" },
    decision: {
      action: "competitor.fetch",
      after: { cards: 3, cheapest: 360 + int(0, 60) }, basis: ["竞对 ×3 价格卡采集"],
    },
    rule_impact: [], receipt: receipt(t, id),
  };
}
function evNightPackage(t: Date, day: number): TwinEvent {
  const id = nextId();
  return {
    event_id: id, who: { type: "system", id: "night-shift" }, context: ctx(t, "夜班"),
    object: { type: "shift", id: `nr-${new Date(t.getTime() - 86_400_000).toISOString().slice(0, 10)}` },
    decision: {
      action: "night.package.deliver",
      after: { done: int(6, 12), pending: int(0, 2), escalate: day % 9 === 0 ? 1 : 0, fence_snapshot: FENCE_VERSION },
      basis: ["夜班班组三段投影（✓已完成/◆待审批/▲需介入）"],
    },
    rule_impact: [], receipt: receipt(t, id),
  };
}
function evHousekeeping(t: Date): TwinEvent {
  const id = nextId();
  return {
    event_id: id, who: agentWho("housekeeper-agent"), context: ctx(t),
    object: { type: "task", id: `HK-${int(10000, 99999)}` },
    decision: {
      action: "task.complete",
      after: { room: `${int(2, 8)}0${int(1, 8)}`, photo_check: "pass", minutes: int(28, 44) },
      basis: ["清单化清洁+拍照 AI 初检达标"],
    },
    rule_impact: [], receipt: receipt(t, id),
  };
}
function evContentPublish(t: Date): TwinEvent {
  const id = nextId();
  const platform = pick(["小红书", "抖音"] as const);
  return {
    event_id: id, who: agentWho("content-agent"), context: ctx(t, platform),
    object: { type: "campaign", id: `CM-${int(1000, 9999)}` },
    decision: {
      action: "content.publish",
      params: { platform },
      after: { published: true, title: pick(["云栖的秋天，从一扇窗开始", "带娃住进茶园边", "出差党的深夜食堂地图"] as const) },
      basis: ["品牌规范校验通过", "无禁词命中"],
    },
    rule_impact: [{ rule_id: "R3", version: FENCE_VERSION, result: "pass" }],
    receipt: receipt(t, id), model_trace: mt("flagship", false),
  };
}

/* ---- 特种场景（围栏 v3 新增规则 + 断点闭环的演示锚点） ---- */
function evParityBlock(t: Date): TwinEvent {
  const id = nextId();
  approvalsToCreate.push({ eventId: id, level: "block", title: "飞猪倒挂发布熔断（R17）", time: t });
  return {
    event_id: id, who: agentWho("competitor-agent"), context: ctx(t, "飞猪"),
    object: { type: "channel", id: "飞猪" },
    decision: {
      action: "price.publish",
      params: { channel_price: 398, other_channel_min: 458 },
      after: { blocked: true, gap_pct: -13.1 },
      basis: ["发布价 ¥398 < 他渠道最低 ¥458 × 90% = ¥412，倒挂熔断"],
    },
    rule_impact: [{ rule_id: "R17", version: FENCE_VERSION, result: "blocked" }],
    model_trace: mt("standard", false),
  };
}
function evParityFixed(t: Date): TwinEvent {
  const id = nextId();
  return {
    event_id: id, who: agentWho("competitor-agent"), context: ctx(t, "飞猪"),
    object: { type: "channel", id: "飞猪" },
    decision: {
      action: "channel.parity.fixed",
      after: { restored_price: 458, approved_by: "MEM-001" },
      basis: ["店长审批恢复一致性定价", "检出→处置→结果三段留痕"],
    },
    rule_impact: [], receipt: receipt(t, id),
  };
}
function evSyncFail(t: Date): TwinEvent {
  const id = nextId();
  approvalsToCreate.push({ eventId: id, level: "review", title: "美团库存同步失败·自动下架保护（R18）", time: t });
  return {
    event_id: id, who: agentWho("reconcile-agent"), context: ctx(t, "美团"),
    object: { type: "channel", id: "美团" },
    decision: {
      action: "inventory.sync",
      params: { sync_failed: true, available: 3 },
      after: { auto_offshelf: true, reason: "同步失败保护性下架，防漏售/超售" },
      basis: ["直连心跳 ×3 失败", "R18 熔断：下架该渠道房态 + review 待人工恢复"],
    },
    rule_impact: [{ rule_id: "R18", version: FENCE_VERSION, result: "blocked" }],
    model_trace: mt("standard", false),
  };
}
function evSyncRestored(t: Date): TwinEvent {
  const id = nextId();
  return {
    event_id: id, who: humanWho("MEM-001"), context: ctx(t, "美团"),
    object: { type: "channel", id: "美团" },
    decision: {
      action: "inventory.sync.restore",
      after: { onshelf: true, verified: true }, basis: ["直连恢复，人工核验后重新上架"],
    },
    rule_impact: [], receipt: receipt(t, id),
  };
}
function evReviewSla(t: Date): TwinEvent {
  const id = nextId();
  approvalsToCreate.push({ eventId: id, level: "review", title: "差评 26h 未响应·SLA 升级（R19）", time: t });
  return {
    event_id: id, who: agentWho("review-agent"), context: ctx(t, "携程"),
    object: { type: "review", id: `RV-${int(10000, 99999)}` },
    decision: {
      action: "alert.escalate",
      params: { review_age_hours: 26, replied: false, rating: 2 },
      after: { escalated_to: "MEM-001", sla_hours: 24 },
      basis: ["差评超 24h 未响应，自动升级店长（差评响应慢占流失 20%）"],
    },
    rule_impact: [{ rule_id: "R19", version: FENCE_VERSION, result: "review" }],
    model_trace: mt("standard", false),
  };
}
function evLinenLoss(t: Date): TwinEvent {
  const id = nextId();
  approvalsToCreate.push({ eventId: id, level: "review", title: "布草月损耗 4.8% 超基线（R20）", time: t });
  return {
    event_id: id, who: agentWho("housekeeper-agent"), context: ctx(t),
    object: { type: "inventory", id: "linen-bath-towel" },
    decision: {
      action: "inventory.loss",
      params: { loss_rate: 0.048, baseline_loss_rate: 0.03, item: "浴巾" },
      after: { heatmap: "3F 亲子房集中",归因: "客人带走疑似 ×6" },
      basis: ["损耗率 4.8% > 基线 3% × 1.5，必审", "损耗热力图已出"],
    },
    rule_impact: [{ rule_id: "R20", version: FENCE_VERSION, result: "review" }],
    model_trace: mt("standard", false),
  };
}
function evIncident(t: Date, kind: "identity_fail" | "lock_failure"): TwinEvent {
  const id = nextId();
  const first = kind === "identity_fail";
  return {
    event_id: id, who: { type: "system", id: "incident-monitor" }, context: ctx(t, "夜班"),
    object: { type: "alert", id: `INC-${int(1000, 9999)}` },
    decision: {
      action: "incident.postmortem",
      params: {
        breakpoint: first ? "身份验证失败" : "夜间门锁失灵",
        fallback_level: first ? "remote_video" : "on_site_emergency",
        root_cause: first ? "数据缺失" : "能力边界",
      },
      after: first
        ? { fix: "一店一档补录「入住人证件有效期」字段", next_week_same_kind: 0 }
        : { fix: "登记人工保留区 + 应急预案更新（机械钥匙位置同步应急树）" },
      basis: ["三级兜底结案 → 根因强制四分类 → 优化动作映射（未分类不许结案）"],
    },
    rule_impact: first ? [] : [{ rule_id: "R10", version: FENCE_VERSION, result: "blocked" }],
    receipt: receipt(t, id),
  };
}
function evFaqMine(t: Date, topic: string, hits: number): TwinEvent {
  const id = nextId();
  return {
    event_id: id, who: agentWho("phone-agent"), context: ctx(t),
    object: { type: "phone_call", id: "faq-kb" },
    decision: {
      action: "faq.mine",
      params: { topic, weekly_hits: hits },
      after: { candidate: true, pending_confirm: true },
      basis: [`「${topic}」本周被问 ${hits} 次未命中 → 进入 faq_kb 候选（店长确认入库）`],
    },
    rule_impact: [], model_trace: mt("standard", false),
  };
}
function evWeeklyReport(t: Date): TwinEvent {
  const id = nextId();
  return {
    event_id: id, who: { type: "system", id: "incident-monitor" }, context: ctx(t),
    object: { type: "alert", id: "weekly-incident-report" },
    decision: {
      action: "incident.weekly.report",
      after: { incidents: int(1, 4), convergence: "down", sink_rate: 0.6 + rand() * 0.3 },
      basis: ["断点率周报：总量/分类分布/层级下沉率/收敛曲线"],
    },
    rule_impact: [],
  };
}

/* ================= 主流程 ================= */
async function main(): Promise<void> {
  const owner = new pg.Client({ connectionString: DATABASE_URL });
  await owner.connect();
  const ws = await owner.query(`SELECT id FROM workspaces WHERE id=$1`, [WS_ID]);
  if (ws.rowCount === 0) {
    throw new Error("未检测到种子数据：请先执行 pnpm db:seed，再运行 pnpm demo:twin");
  }
  PRESETS = loadPresets();
  console.log(`✓ 售前数字孪生启动：${DAYS} 天经营模拟（${START.toISOString().slice(0, 10)} 起，确定性种子）`);

  // —— 逐日生成事件 ——
  const events: Array<{ ev: TwinEvent; session: string | null }> = [];
  const push = (ev: TwinEvent, session: string | null = null) => events.push({ ev, session });

  for (let d = 0; d < DAYS; d++) {
    const dow = new Date(START.getTime() + d * 86_400_000).getDay();
    const weekend = dow === 5 || dow === 6;
    // 主店每日经营快照（P18 驾驶舱/P19 走势数据源；与姊妹店同口径）
    const dayOcc = Math.min(0.97, Math.max(0.62, 0.78 + (weekend ? 0.09 : 0) + (rand() - 0.5) * 0.1));
    const dayAdr = Math.round(496 * (1 + (weekend ? 0.06 : 0) + (rand() - 0.5) * 0.08));
    push({
      event_id: nextId(), who: { type: "system", id: "cockpit-daily" }, context: ctx(at(d, 23, 55)),
      object: { type: "store", id: WS_ID },
      decision: {
        action: "store.daily.summary",
        after: { occ: Number(dayOcc.toFixed(2)), adr: dayAdr, revpar: Math.round(dayOcc * dayAdr), rooms: 86 },
        basis: ["当日订单/收款聚合快照（驾驶舱 KPI 数据源）"],
      },
      rule_impact: [],
    });
    // 订单与入退（周末峰值）
    const orders = weekend ? int(11, 14) : int(7, 10);
    for (let k = 0; k < orders; k++) push(evOrderConfirm(at(d, int(8, 22))));
    // 全链样板单 ×2/日：同一订单号贯穿 确认→入住→退房（P13 穿透演示锚点）
    for (let k = 0; k < 2; k++) {
      const od = `OD-${880000 + d * 10 + k}`;
      const rt = pick(ROOM_TYPES);
      push({
        event_id: nextId(), who: agentWho("frontdesk-agent"), context: ctx(at(d, int(8, 12)), pick(CHANNELS)),
        object: { type: "order", id: od },
        decision: { action: "order.confirm", params: { available: int(1, 9), room_type: rt.id, amount: rt.base * 2 }, after: { status: "confirmed" }, basis: ["信息完整校验通过", "可售库存充足"] },
        rule_impact: [],
      });
      push({
        event_id: nextId(), who: agentWho("frontdesk-agent"), context: ctx(at(d, 14, int(0, 59))),
        object: { type: "order", id: od },
        decision: { action: "pms.checkin", after: { room_assigned: true, room: `${int(2, 8)}0${int(1, 8)}`, eta_min: 3 }, basis: ["智能排房（画像+房况避坑）", "人脸核验通过"] },
        rule_impact: [],
      });
      push({
        event_id: nextId(), who: agentWho("frontdesk-agent"), context: ctx(at(d + 1, 11, int(0, 59))),
        object: { type: "order", id: od },
        decision: { action: "pms.checkout", after: { settled: true, deposit_refund_min: 4, invoice_sent: true }, basis: ["自动查房达标+自动结算", "电子发票 2 分钟开出"] },
        rule_impact: [],
      });
    }
    for (let k = 0; k < Math.round(orders * 0.8); k++) {
      push(evCheckinOut(at(d, int(9, 11)), "checkout"));
      push(evCheckinOut(at(d, int(14, 17)), "checkin"));
    }
    // 收益：白班 R1 + 夜班 R7 微调
    push(evPriceAdjust(at(d, int(10, 16)), false), "T-101");
    push(evPriceAdjust(at(d, 23, int(0, 59)), true), "T-101");
    // 评价：1–3 条，约 15% 差评
    const reviews = int(1, 3);
    for (let k = 0; k < reviews; k++) {
      const bad = rand() < 0.15;
      const ev = evReview(at(d, int(9, 21)), bad, false);
      if (bad) approvalsToCreate.push({ eventId: ev.event_id, level: "review", title: "差评回复审批（R6）", time: at(d, int(9, 21)) });
      push(ev, "T-102");
    }
    // 电话：3–6 通
    for (let k = 0; k < int(3, 6); k++) push(evPhoneCall(at(d, int(7, 23))));
    // 客房工单
    for (let k = 0; k < int(3, 5); k++) push(evHousekeeping(at(d, int(9, 16))));
    // 夜班：竞对采集 + 对账 + 08:30 决策包
    push(evCompetitorFetch(at(d, 23, int(0, 30))));
    push(evReconcile(at(d, 23, int(31, 59))));
    const pkg = evNightPackage(at(d + 1, 8, 30), d);
    nightPackages.push({
      day: d, runDate: fmtDate(d), eventId: pkg.event_id,
      done: (pkg.decision.after as { done: number }).done,
      pending: (pkg.decision.after as { pending: number }).pending,
      escalate: (pkg.decision.after as { escalate: number }).escalate,
    });
    push(pkg);
    // 内容营销：每周 2–3 篇
    if (d % 3 === 1) push(evContentPublish(at(d, int(15, 20))), "T-103");
    // 周频：FAQ 萃取 + 断点周报 + 经营目标追踪（p12 仪表盘数据源）
    if (d % 7 === 6) {
      push(evFaqMine(at(d, 3, 5), FAQ_TOPICS[(d / 7) % FAQ_TOPICS.length] as string, int(3, 6)));
      push(evWeeklyReport(at(d, 4, 0)));
      const wk = Math.floor(d / 7) + 1;
      const occNow = 0.78 + (rand() - 0.5) * 0.08;
      push({
        event_id: nextId(), who: { type: "system", id: "goal-tracker" }, context: ctx(at(d, 6, 0)),
        object: { type: "store", id: WS_ID },
        decision: {
          action: "goal.tracking",
          params: { week: wk, month: "2026-08" },
          after: {
            occ: { target: 0.83, actual: Number(occNow.toFixed(2)), pace: occNow >= 0.83 * (wk / 4.3) ? "on_track" : "behind" },
            revenue: { target: 108000, actual: int(68000, 118000) },
            attribution: occNow < 0.8 ? ["竞对云栖轻奢降价事件 ×2", "台风天退订 ×3"] : [],
          },
          basis: ["月目标 vs 时序进度比对，偏差超阈值自动归因（p12 仪表盘）"],
        },
        rule_impact: [],
      });
    }
    // 特种场景锚点（围栏 v3 + 断点闭环演示剧本）
    if (d === 4) { push(evParityBlock(at(d, 14, 20))); push(evParityFixed(at(d, 16, 5))); }
    if (d === 8) { push(evSyncFail(at(d, 2, 40))); push(evSyncRestored(at(d, 9, 15))); }
    if (d === 11) push(evReviewSla(at(d, 10, 30)));
    if (d === 15) push(evLinenLoss(at(d, 11, 0)));
    if (d === 19) push(evIncident(at(d, 1, 20), "identity_fail"));
    if (d === 23) push(evIncident(at(d, 2, 50), "lock_failure"));
  }

  // —— 事件落库（gateway 角色 + 哈希链 + 附录 E 校验） ——
  const gw = new pg.Client({ connectionString: GATEWAY_URL });
  await gw.connect();
  await gw.query("SELECT set_config('app.workspace_id', $1, false)", [WS_ID]);
  await gw.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT_ID]);
  const last = await gw.query(`SELECT hash FROM biz_events WHERE tenant_id=$1 ORDER BY seq DESC LIMIT 1`, [TENANT_ID]);
  let prevHash = (last.rows[0]?.hash as string) ?? GENESIS_HASH;

  let inserted = 0, dup = 0;
  for (const { ev, session } of events) {
    const checked = safeParseBusinessEvent(ev);
    if (!checked.success) throw new Error(`孪生事件 ${ev.event_id} 未过附录 E 校验：${checked.error.message}`);
    const payload = JSON.stringify(checked.data);
    const hash = eventHash(prevHash, checked.data);
    const res = await gw.query(
      `INSERT INTO biz_events (event_id, tenant_id, workspace_id, session_id, payload, prev_hash, hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id, event_id) DO NOTHING RETURNING seq`,
      [ev.event_id, TENANT_ID, WS_ID, session, payload, prevHash, hash, ev.context.time],
    );
    if (res.rowCount && res.rowCount > 0) { prevHash = hash; inserted++; } else dup++;
  }
  console.log(`✓ 五元事件：新写入 ${inserted} 条，幂等丢弃 ${dup} 条（30 天全业务域）`);

  // —— 审批流（review/block 事件：多数已批准、最新 2 条 pending、1 条驳回） ——
  let aprInserted = 0;
  for (const [idx, a] of approvalsToCreate.entries()) {
    const status = idx >= approvalsToCreate.length - 2 ? "pending" : idx === 3 ? "rejected" : "approved";
    const res = await gw.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, gesture, snapshot, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,'inapp',$5,$6,$7,$8,$9)
       ON CONFLICT (event_id, channel) DO NOTHING`,
      [
        `apr-${a.eventId.toLowerCase()}`, TENANT_ID, WS_ID, a.eventId, status,
        status === "pending" ? null : JSON.stringify(status === "approved" ? { type: "approve", weight: 1 } : { type: "reject", weight: 1, reason: "补偿超档案口径，退回重拟" }),
        JSON.stringify({ title: a.title, level: a.level }),
        status === "pending" ? null : "MEM-001",
        status === "pending" ? null : iso(new Date(a.time.getTime() + int(20, 120) * 60_000)),
      ],
    );
    aprInserted += res.rowCount ?? 0;
  }
  console.log(`✓ 审批流 ×${aprInserted}（含 pending ×2 / rejected ×1：演示三手势与驳回回流）`);

  // —— 补盲 ①：night_runs ×30（夜班驾驶舱 P9 的表格投影，与决策包事件一一对应） ——
  let nrInserted = 0;
  for (const np of nightPackages) {
    const res = await owner.query(
      `INSERT INTO night_runs (id, workspace_id, run_date, status, fence_snapshot_version, candidate_count, stats, started_at, package_event_id)
       VALUES ($1,$2,$3,'package_generated',$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [
        `nr-${np.runDate}`, WS_ID, np.runDate, FENCE_VERSION, int(3, 5),
        JSON.stringify({ done: np.done, pending: np.pending, escalate: np.escalate, credits: int(7, 11) }),
        iso(new Date(START.getTime() + np.day * 86_400_000 + 22 * 3_600_000)),
        np.eventId,
      ],
    );
    nrInserted += res.rowCount ?? 0;
  }
  console.log(`✓ 夜班班次表 ×${nrInserted}（30 天 package_generated，快照 ${FENCE_VERSION}）`);

  // —— 补盲 ②：组织记忆 ×8 + 使用归因（经验资产化的可见证据） ——
  const evIdBy = async (action: string, limit: number) => {
    const r = await gw.query(
      `SELECT event_id FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND payload->'decision'->>'action'=$3 ORDER BY seq LIMIT $4`,
      [TENANT_ID, WS_ID, action, limit],
    );
    return r.rows.map((x) => x.event_id as string);
  };
  const priceIds = await evIdBy("price.adjust", 5);
  const reviewIds = await evIdBy("review.reply", 5);
  const phoneIds = await evIdBy("call.summary", 5);
  const reconIds = await evIdBy("order.reconcile", 3);
  const memories = [
    { id: "mem-pat-weekend-family", scope: "workspace", kind: "pattern", conf: 0.86, content: "周五/六亲子双床房需求显著高于平日（30 天订单分布），建议周四前完成周末溢价调价", src: priceIds.slice(0, 3) },
    { id: "mem-pat-night-micro", scope: "workspace", kind: "pattern", conf: 0.82, content: "夜班 R7 微调（≤3%）主要集中在 23:00–01:00 预订收尾窗口，30 天零越线", src: priceIds.slice(2, 5) },
    { id: "mem-sop-review-apology", scope: "workspace", kind: "sop", conf: 0.9, content: "差评致歉结构 v2：共情→核实→整改→邀约回流；禁用「百分百满意」等档案外承诺", src: reviewIds.slice(0, 3) },
    { id: "mem-sop-sync-outage", scope: "workspace", kind: "sop", conf: 0.78, content: "渠道直连中断 SOP：自动下架保护→人工核验→恢复上架→复盘直连稳定性", src: reconIds.slice(0, 2) },
    { id: "mem-pref-owner-pricing", scope: "agent", kind: "preference", conf: 0.75, content: "王店长调价偏好：节假日提前 3 天布局、单次涨幅 ≤5% 为宜", src: priceIds.slice(0, 2) },
    { id: "mem-pat-faq-topics", scope: "workspace", kind: "pattern", conf: 0.88, content: "电话咨询 TOP3：停车场/早餐时间/退房时间，占呼入 60%+，知识库命中即答", src: phoneIds.slice(0, 3) },
    { id: "mem-pat-linen-3f", scope: "workspace", kind: "pattern", conf: 0.7, content: "3F 亲子房布草损耗偏高（客人带走疑似），已联动查房检项加严", src: reviewIds.slice(3, 5) },
    { id: "mem-sop-incident-triage", scope: "workspace", kind: "sop", conf: 0.84, content: "断点根因四分类纪律：未分类不许结案；同类周均≥3 次触发固化建议", src: reconIds.slice(1, 3) },
  ];
  let memInserted = 0;
  for (const m of memories) {
    const res = await owner.query(
      `INSERT INTO org_memory (memory_id, tenant_id, workspace_id, scope, kind, content, source_events, confidence, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active') ON CONFLICT (memory_id) DO NOTHING`,
      [m.id, TENANT_ID, WS_ID, m.scope, m.kind, m.content, m.src, m.conf],
    );
    memInserted += res.rowCount ?? 0;
    for (const evId of m.src.slice(0, 2)) {
      await owner.query(`INSERT INTO memory_usage (memory_id, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [m.id, evId]);
    }
  }
  console.log(`✓ 组织记忆 ×${memInserted}（pattern/sop/preference，来源事件可归因）`);

  // —— 补盲 ③：fence_dry_runs ×3（围栏演进史：2 confirmed / 1 rejected，含单调守卫驳回样本） ——
  const dryRuns = [
    { id: "dr-r7-tighten", rule: "R7", ver: "hotel-patch/v-next", status: "confirmed", report: { replayed: 10, would_block: 0, would_review: 1, impact: "夜班微调上限 3%→2%：回放 10 条夜班调价，1 条转入必审，无熔断" } },
    { id: "dr-r17-parity", rule: "R17", ver: FENCE_VERSION, status: "confirmed", report: { replayed: 30, would_block: 2, would_review: 0, impact: "倒挂防护预演：回放 30 条发布，2 条历史倒挂将熔断（d5 已实证）" } },
    { id: "dr-r1-loosen", rule: "R1", ver: "draft-loosen-10pct", status: "rejected", report: { replayed: 30, would_block: 0, would_review: 6, impact: "涨幅上限 8%→10% 放宽提案：单调守卫拒绝（基线只可收紧），店长驳回留痕" } },
  ];
  let drInserted = 0;
  for (const dr of dryRuns) {
    const res = await owner.query(
      `INSERT INTO fence_dry_runs (id, workspace_id, rule_id, rule_version, report, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'MEM-001') ON CONFLICT (id) DO NOTHING`,
      [dr.id, WS_ID, dr.rule, dr.ver, JSON.stringify(dr.report), dr.status],
    );
    drInserted += res.rowCount ?? 0;
  }
  console.log(`✓ 围栏 dry-run 报告 ×${drInserted}（含单调守卫驳回样本：只紧不松可演示）`);

  // —— 补盲 ④：跨店工作区 ×2（owner-cockpit 多店驾驶舱的数据基础） ——
  const sisterStores = [
    { id: "ws-xixi", name: "云栖·西溪店", slug: "yunqi-xixi", rooms: 32, segment: "homestay", occ: 0.72, adr: 388 },
    { id: "ws-manlong", name: "云栖·满陇店", slug: "yunqi-manlong", rooms: 24, segment: "unmanned", occ: 0.81, adr: 328 },
  ];
  for (const s of sisterStores) {
    await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage) VALUES ($1,$2,$3,$4,'hotel','stable')
       ON CONFLICT (id) DO NOTHING`,
      [s.id, TENANT_ID, s.name, s.slug],
    );
    await owner.query(
      `INSERT INTO profiles (workspace_id, tenant_id, industry, archive, forbidden, pii_vault)
       VALUES ($1,$2,'hotel',$3,$4,NULL) ON CONFLICT (workspace_id) DO NOTHING`,
      [s.id, TENANT_ID, JSON.stringify({ property: { name: s.name, city: "杭州", rooms: s.rooms, segment: s.segment } }),
       JSON.stringify([{ rule: "不低于保底价", scope: "room_price" }])],
    );
  }
  // 跨店轻量事件：每日经营快照 + 夜班决策包（驾驶舱 KPI 与 digest 数据源）
  // 哈希链为「每工作区独立链」（verify-chain 按 ws 分组验证）：跨店事件从各自链尾/GENESIS 续接
  let sisInserted = 0;
  for (const s of sisterStores) {
    await gw.query("SELECT set_config('app.workspace_id', $1, false)", [s.id]);
    const sisTail = await gw.query(`SELECT hash FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq DESC LIMIT 1`, [TENANT_ID, s.id]);
    let sisPrev = (sisTail.rows[0]?.hash as string) ?? GENESIS_HASH;
    for (let d = 0; d < DAYS; d++) {
      const dayOcc = Math.min(0.98, Math.max(0.4, s.occ + (rand() - 0.5) * 0.2));
      const dayAdr = Math.round(s.adr * (1 + (rand() - 0.5) * 0.12));
      const evs: TwinEvent[] = [
        {
          event_id: nextId(), who: { type: "system", id: "cockpit-daily" }, context: ctx(at(d, 23, 55)),
          object: { type: "store", id: s.id },
          decision: {
            action: "store.daily.summary",
            after: { occ: Number(dayOcc.toFixed(2)), adr: dayAdr, revpar: Math.round(dayOcc * dayAdr), rooms: s.rooms },
            basis: ["当日订单/收款聚合快照（驾驶舱 KPI 数据源）"],
          },
          rule_impact: [],
        },
        {
          event_id: nextId(), who: { type: "system", id: "night-shift" }, context: ctx(at(d + 1, 8, 30), "夜班"),
          object: { type: "shift", id: `nr-${s.id}-${fmtDate(d)}` },
          decision: {
            action: "night.package.deliver",
            after: { done: int(4, 9), pending: int(0, 2), escalate: d % 11 === 0 ? 1 : 0, fence_snapshot: FENCE_VERSION },
            basis: ["夜班班组三段投影（✓已完成/◆待审批/▲需介入）"],
          },
          rule_impact: [],
        },
      ];
      for (const ev of evs) {
        const checked = safeParseBusinessEvent(ev);
        if (!checked.success) throw new Error(`跨店事件 ${ev.event_id} 未过校验：${checked.error.message}`);
        const payload = JSON.stringify(checked.data);
        const hash = eventHash(sisPrev, checked.data);
        const res = await gw.query(
          `INSERT INTO biz_events (event_id, tenant_id, workspace_id, session_id, payload, prev_hash, hash, created_at)
           VALUES ($1,$2,$3,NULL,$4,$5,$6,$7)
           ON CONFLICT (tenant_id, event_id) DO NOTHING RETURNING seq`,
          [ev.event_id, TENANT_ID, s.id, payload, sisPrev, hash, ev.context.time],
        );
        if (res.rowCount && res.rowCount > 0) { sisPrev = hash; sisInserted++; }
      }
    }
  }
  await gw.query("SELECT set_config('app.workspace_id', $1, false)", [WS_ID]);
  console.log(`✓ 跨店工作区 ×2（西溪 32 间民宿型/满陇 24 间无人型）· 驾驶舱事件 ×${sisInserted}`);

  // —— FAQ 知识库生长结果回写一店一档（萃取产物可见） ——
  const prof = await owner.query(`SELECT archive FROM profiles WHERE workspace_id=$1`, [WS_ID]);
  const archive = prof.rows[0]?.archive as Record<string, unknown>;
  if (archive) {
    const faqKb = (archive.faq_kb ?? {}) as Record<string, unknown>;
    faqKb.last_mined_at = iso(at(DAYS - 1, 3, 5));
    faqKb.pending_candidates = [
      { q: "有充电桩吗", weekly_hits: 5, source_call_ids: ["pc-30012", "pc-30088", "pc-30145"], confirmed: false },
      { q: "能带宠物吗", weekly_hits: 4, source_call_ids: ["pc-30031", "pc-30102"], confirmed: false },
    ];
    archive.faq_kb = faqKb;
    await owner.query(`UPDATE profiles SET archive=$2, updated_at=now() WHERE workspace_id=$1`, [WS_ID, JSON.stringify(archive)]);
    console.log("✓ FAQ 知识库生长回写（候选 ×2 待店长确认，来源通话可归因）");
  }

  // —— 验收：回读本批事件逐条过 zod ——
  const ids = events.map((x) => x.ev.event_id);
  const check = await gw.query(
    `SELECT payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND event_id = ANY($3::text[])`,
    [TENANT_ID, WS_ID, ids],
  );
  let valid = 0;
  for (const row of check.rows) if (safeParseBusinessEvent(row.payload).success) valid++;
  const rate = check.rowCount ? valid / check.rowCount : 0;
  console.log(`✓ 验收：回读 ${check.rowCount} 条，五元完整 ${valid} 条，完整率 ${(rate * 100).toFixed(1)}%`);
  if (rate !== 1) throw new Error("验收失败：五元完整率未达 100%");

  await gw.end();
  await owner.end();
  console.log("数字孪生完成 ✅（云栖酒店 30 天经营态就绪：pnpm demo:twin:snapshot 可导出快照）");
}

main().catch((err) => {
  console.error("孪生模拟失败：", err?.message ?? err);
  process.exit(1);
});
