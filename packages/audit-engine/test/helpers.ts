/**
 * 测试辅助：确定性快照工厂 + 分析器上下文。
 * 所有测试锚定固定钟 NOW，保证纯函数断言可复现。
 */
import type { AnalyzerContext } from "../src/analyzers/util.js";
import type { AuditSnapshot } from "../src/types.js";

/** 固定锚定时间（差评时长/近 30 天窗口/断点 7 天窗口以此为界） */
export const NOW = new Date("2026-08-27T12:00:00+08:00");

export const CTX: AnalyzerContext = { now: NOW, floorPriceDefault: 380 };

/** 近 N 天/小时前的 ISO 时间（相对固定钟） */
export function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}
export function daysAgo(d: number): string {
  return hoursAgo(d * 24);
}
export function dateDaysAgo(d: number): string {
  return daysAgo(d).slice(0, 10);
}

/** 今天起 N 天后的 YYYY-MM-DD（价格日历/房态记录用；引擎只扫今天及以后） */
export function dateFromNow(d: number): string {
  return new Date(NOW.getTime() + d * 86_400_000).toISOString().slice(0, 10);
}

/** 最小可用快照：一店（云栖酒店，保底价 380，三渠道佣金档案齐备）；各测试按需覆盖字段 */
export function makeSnapshot(overrides: Partial<AuditSnapshot> = {}): AuditSnapshot {
  return {
    snapshotId: "SNAP-TEST",
    generatedAt: NOW.toISOString(),
    hotels: [
      {
        hotelId: "hotel-a",
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
      { hotelId: "hotel-a", roomTypeId: "RT-KING", name: "豪华大床房", basePrice: 500, currency: "CNY" },
      { hotelId: "hotel-a", roomTypeId: "RT-TWIN", name: "高级双床房", basePrice: 420, currency: "CNY" },
    ],
    channelPrices: [],
    roomDays: [],
    orders: [],
    channelBills: [],
    reviews: [],
    breakpoints: [],
    holidays: ["2026-10-01", "2026-10-02"],
    ...overrides,
  };
}
