/**
 * 埋点考卷（集成验证，本任务的成败判据）
 * 构造一份含 6 个已知埋点的酒店快照，引擎必须全部独立算出，且严重度 / 金额口径正确。
 * 任何一条漏报或错级 = 考卷不过。
 *
 * 埋点清单：
 *  ① RT-DELUXE-KING 2026-09-01 跨渠道倒挂 12%（携程 528 vs 美团 600）
 *  ② RT-STD-TWIN 飞猪破保底价 360 < 380（R2 熔断口径）
 *  ③ RT-DELUXE-KING 2026-09-05 超售（已售 21 > 实盘 20）
 *  ④ 账单 BILL-202608 佣金多提 0.6pp（订单 20000，应提 15%=3000，实提 3120）
 *  ⑤ 差评 RV-BAD-001 36h 未回复（>24h SLA，未超 72h 升级线）
 *  ⑥ 担保订单 O-9004 未预授权（敞口 = 首晚房费 600）
 */
import { describe, expect, it } from "vitest";
import { runFastScan } from "../src/engine.js";
import type { AuditSnapshot, Finding } from "../src/types.js";
import { daysAgo, hoursAgo, NOW } from "./helpers.js";

/** 含 6 个埋点的完整快照（各埋点数据互相隔离，避免交叉触发干扰断言） */
function plantedSnapshot(): AuditSnapshot {
  return {
    snapshotId: "SNAP-PLANTED",
    generatedAt: NOW.toISOString(),
    hotels: [
      {
        hotelId: "H-001",
        hotelName: "云栖酒店",
        currency: "CNY",
        timezone: "Asia/Shanghai",
        floorPrice: 380,
        roomCount: 60,
        rating: 4.5,
        ratingDelta30d: 0.05,
        channels: [
          { channel: "ctrip", commissionRate: 0.15 },
          { channel: "meituan", commissionRate: 0.12 },
          { channel: "fliggy", commissionRate: 0.1 },
        ],
      },
    ],
    roomTypes: [
      { hotelId: "H-001", roomTypeId: "RT-DELUXE-KING", name: "豪华大床房", basePrice: 550, currency: "CNY" },
      { hotelId: "H-001", roomTypeId: "RT-STD-TWIN", name: "高级双床房", basePrice: 420, currency: "CNY" },
    ],
    channelPrices: [
      // 埋点①：同房型同日 携程 528 / 美团 600 → 倒挂 12%
      { hotelId: "H-001", roomTypeId: "RT-DELUXE-KING", date: "2026-09-01", channel: "ctrip", price: 528, currency: "CNY" },
      { hotelId: "H-001", roomTypeId: "RT-DELUXE-KING", date: "2026-09-01", channel: "meituan", price: 600, currency: "CNY" },
      // 埋点②：飞猪 3 天售价 360 < 保底价 380
      { hotelId: "H-001", roomTypeId: "RT-STD-TWIN", date: "2026-09-01", channel: "fliggy", price: 360, currency: "CNY" },
      { hotelId: "H-001", roomTypeId: "RT-STD-TWIN", date: "2026-09-02", channel: "fliggy", price: 360, currency: "CNY" },
      { hotelId: "H-001", roomTypeId: "RT-STD-TWIN", date: "2026-09-03", channel: "fliggy", price: 360, currency: "CNY" },
    ],
    roomDays: [
      // 埋点③：已售 21 > 实盘 20 → 超售 1 间（其余口径健康：未关房/无问题房/渠道可售 0 非负）
      { hotelId: "H-001", roomTypeId: "RT-DELUXE-KING", date: "2026-09-05", channel: "ctrip", totalRooms: 20, sold: 21, maintenanceRooms: 0, available: 0, closed: false },
    ],
    orders: [
      // 埋点④的对账锚：订单 20000（间夜 2，同时稀释渠道依赖度：ctrip 4/12=33%）
      { hotelId: "H-001", orderId: "O-9001", channel: "ctrip", roomTypeId: "RT-DELUXE-KING", amount: 20000, currency: "CNY", nights: 2, status: "completed", checkIn: "2026-09-01", createdAt: daysAgo(12) },
      { hotelId: "H-001", orderId: "O-9002", channel: "meituan", roomTypeId: "RT-STD-TWIN", amount: 2500, currency: "CNY", nights: 5, status: "completed", checkIn: "2026-09-02", createdAt: daysAgo(10) },
      { hotelId: "H-001", orderId: "O-9003", channel: "fliggy", roomTypeId: "RT-STD-TWIN", amount: 1500, currency: "CNY", nights: 3, status: "completed", checkIn: "2026-09-03", createdAt: daysAgo(8) },
      // 埋点⑥：信用卡担保但未预授权（首晚 1200/2 = 600 敞口）
      { hotelId: "H-001", orderId: "O-9004", channel: "ctrip", roomTypeId: "RT-DELUXE-KING", amount: 1200, currency: "CNY", nights: 2, status: "confirmed", checkIn: "2026-09-10", createdAt: daysAgo(5), guarantee: { type: "credit-card", preauthorized: false } },
    ],
    channelBills: [
      // 埋点④：佣金实提 3120 vs 应提 20000×15%=3000 → 多提 0.6pp（差额 120 ≤ 500 → P2）
      {
        hotelId: "H-001",
        channel: "ctrip",
        billId: "BILL-202608",
        period: "2026-08",
        lines: [
          { lineId: "BL-1", type: "order", refId: "O-9001", amount: 20000, currency: "CNY" },
          { lineId: "BL-2", type: "commission", refId: "O-9001", amount: 3120, currency: "CNY" },
        ],
      },
    ],
    reviews: [
      // 埋点⑤：2 分差评恰好 36h 未回复（>24h 命中；升级线为严格 >72h，36h 仍 P1）
      { hotelId: "H-001", reviewId: "RV-BAD-001", channel: "ctrip", roomTypeId: "RT-DELUXE-KING", rating: 2, createdAt: hoursAgo(36), content: "空调坏了没人修" },
      // 对照：5 分好评已回复，不触发任何子项
      { hotelId: "H-001", reviewId: "RV-GOOD-001", channel: "meituan", rating: 5, createdAt: hoursAgo(10), repliedAt: hoursAgo(9), content: "服务很好" },
    ],
    // 单条断点（<2 次不触发；保证 safety 线 covered 而非 partial）
    breakpoints: [{ hotelId: "H-001", breakpointId: "BP-1001", category: "ota-sync-failed", occurredAt: hoursAgo(30) }],
    // 节假日期历齐备（保证 price 线 covered；2026-10-01 无在售行 → 不误报未调价）
    holidays: ["2026-10-01"],
  };
}

const report = runFastScan(plantedSnapshot(), { now: NOW });
const all = report.hotels.flatMap((h) => h.findings);
const find = (pred: (f: Finding) => boolean): Finding | undefined => all.find(pred);

describe("埋点考卷 · 6 个已知埋点必须全部检出", () => {
  it("① 跨渠道倒挂 12% → 检出，P1，挂低价渠道，价差口径正确", () => {
    const f = find((x) => x.line === "price" && x.title.includes("RT-DELUXE-KING") && x.title.includes("倒挂"));
    expect(f, "埋点①未检出").toBeDefined();
    expect(f!.severity).toBe("P1"); // 12% > 8%，未超 15% 升级线
    expect(f!.hotelId).toBe("H-001");
    expect(f!.calculation.inputs["minPrice"]).toBe(528);
    expect(f!.calculation.inputs["maxPrice"]).toBe(600);
    expect(f!.calculation.inputs["minChannel"]).toBe("ctrip");
    expect(f!.calculation.result).toBe("12%");
  });

  it("② 破保底价 360 < 380 → 检出，P0（R2 熔断口径），3 天聚合", () => {
    const f = find((x) => x.line === "price" && x.title.includes("破保底价"));
    expect(f, "埋点②未检出").toBeDefined();
    expect(f!.severity).toBe("P0");
    expect(f!.calculation.inputs["minPrice"]).toBe(360);
    expect(f!.calculation.inputs["floorPrice"]).toBe(380);
    expect(f!.calculation.inputs["daysBelowFloor"]).toBe(3);
    expect(f!.calculation.inputs["channel"]).toBe("fliggy");
  });

  it("③ 超售 1 间 → 检出，P0（R18 口径），已售 21 > 实盘 20", () => {
    const f = find((x) => x.line === "inventory" && x.title.includes("超售"));
    expect(f, "埋点③未检出").toBeDefined();
    expect(f!.severity).toBe("P0");
    expect(f!.calculation.result).toBe("21 > 20");
    expect(f!.evidence[0]!.fields?.["oversold"]).toBe(1);
  });

  it("④ 佣金多提 0.6pp → 检出，P2（差额 120 ≤ 500），金额 = 120（exact）", () => {
    const f = find((x) => x.line === "channel" && x.title.includes("佣金错算"));
    expect(f, "埋点④未检出").toBeDefined();
    expect(f!.severity).toBe("P2");
    expect(f!.calculation.result).toBe("0.60pp");
    expect(f!.estimatedImpact?.amount).toBe(120);
    expect(f!.estimatedImpact?.confidence).toBe("exact");
  });

  it("⑤ 差评 36h 未回 → 检出，P1（>24h 命中，未触发 >72h 升级）", () => {
    const f = find((x) => x.line === "reputation" && x.title.includes("未回复"));
    expect(f, "埋点⑤未检出").toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.evidence[0]!.id).toBe("RV-BAD-001");
    expect(f!.calculation.result).toBe("36h > 24h");
  });

  it("⑥ 担保未预授权 → 检出，P1，敞口 = 首晚房费 600（baseline）", () => {
    const f = find((x) => x.line === "safety" && x.title.includes("未预授权"));
    expect(f, "埋点⑥未检出").toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.evidence[0]!.id).toBe("O-9004");
    expect(f!.estimatedImpact?.amount).toBe(600);
    expect(f!.estimatedImpact?.confidence).toBe("baseline");
  });

  it("考卷整体：五线覆盖度全 covered，报告结构完整（一店一份 + 总览 + Top10）", () => {
    for (const line of ["price", "inventory", "channel", "reputation", "safety"] as const) {
      expect(report.coverage[line], line).toBe("covered");
    }
    expect(report.hotels).toHaveLength(1);
    expect(report.overview.findingCount).toBeGreaterThanOrEqual(6);
    expect(report.top10.length).toBeGreaterThanOrEqual(1);
    // 隔离性兜底：豪华大床房不应误触发破防（528/600 均 > 380）
    expect(find((x) => x.title.includes("RT-DELUXE-KING") && x.title.includes("破保底价"))).toBeUndefined();
    // 隔离性兜底：单条断点不应误报高频
    expect(find((x) => x.title.includes("断点高频"))).toBeUndefined();
    // 隔离性兜底：依赖度 33%/42%/25% 均 ≤60%
    expect(find((x) => x.title.includes("单渠道依赖度"))).toBeUndefined();
  });
});
