/** 引擎编排单测：覆盖度降级 / Top10 年化排序 / 门店归集 / 编号唯一性 */
import { describe, expect, it } from "vitest";
import { runFastScan } from "../src/engine.js";
import { dateFromNow, daysAgo, hoursAgo, makeSnapshot, NOW } from "./helpers.js";

/** 全数据源齐备的快照（各线数据源至少一行，且不触发任何发现） */
function fullSnapshot() {
  return makeSnapshot({
    channelPrices: [{ hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(3), channel: "ctrip", price: 500, currency: "CNY" }],
    roomDays: [{ hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(3), channel: "ctrip", totalRooms: 20, sold: 10, maintenanceRooms: 0, available: 10, closed: false }],
    orders: [{ hotelId: "hotel-a", orderId: "O-1", channel: "ctrip", roomTypeId: "RT-KING", amount: 1000, currency: "CNY", nights: 2, status: "completed", checkIn: dateFromNow(3), createdAt: daysAgo(5), guarantee: { type: "credit-card", preauthorized: true, preauthAmount: 600, settled: true } }],
    channelBills: [{ hotelId: "hotel-a", channel: "ctrip", billId: "B-1", period: "2026-08", lines: [] }],
    reviews: [{ hotelId: "hotel-a", reviewId: "RV-1", rating: 5, createdAt: hoursAgo(6), repliedAt: hoursAgo(5) }],
    breakpoints: [{ hotelId: "hotel-a", breakpointId: "BP-1", category: "ota-sync-failed", occurredAt: hoursAgo(24) }],
  });
}

describe("engine · 覆盖度与降级", () => {
  it("全数据源齐备 → 五线全 covered，报告正常产出", () => {
    const r = runFastScan(fullSnapshot(), { now: NOW });
    for (const line of ["price", "inventory", "channel", "reputation", "safety"] as const) {
      expect(r.coverage[line], line).toBe("covered");
    }
    expect(r.overview.hotelCount).toBe(1);
    expect(r.reportId).toBe("RPT-SNAP-TEST");
  });

  it("房价日历缺失 → price not-covered；其余线不受影响", () => {
    const r = runFastScan(fullSnapshot(), { now: NOW });
    expect(r.coverage.price).toBe("covered");
    const r2 = runFastScan(makeSnapshot({ ...fullSnapshot(), channelPrices: [] }), { now: NOW });
    expect(r2.coverage.price).toBe("not-covered");
    expect(r2.coverageNotes.some((n) => n.includes("房价日历"))).toBe(true);
    expect(r2.coverage.inventory).toBe("covered");
  });

  it("节假日期历缺失 → price partial；保底价未采集 → price partial 且注明默认 380", () => {
    const noHoliday = runFastScan(makeSnapshot({ ...fullSnapshot(), holidays: [] }), { now: NOW });
    expect(noHoliday.coverage.price).toBe("partial");
    expect(noHoliday.coverageNotes.some((n) => n.includes("节假日"))).toBe(true);

    const noFloor = runFastScan(
      makeSnapshot({ ...fullSnapshot(), hotels: [{ hotelId: "hotel-a", hotelName: "云栖酒店", currency: "CNY", timezone: "Asia/Shanghai", rating: 4.5, ratingDelta30d: 0.05, channels: [{ channel: "ctrip", commissionRate: 0.15 }] }] }),
      { now: NOW },
    );
    expect(noFloor.coverage.price).toBe("partial");
    expect(noFloor.coverageNotes.some((n) => n.includes("380"))).toBe(true);
  });

  it("评价缺失 → reputation not-covered；断点缺失 → safety partial；账单缺失 → channel partial", () => {
    const r = runFastScan(makeSnapshot({ ...fullSnapshot(), reviews: [] }), { now: NOW });
    expect(r.coverage.reputation).toBe("not-covered");

    const r2 = runFastScan(makeSnapshot({ ...fullSnapshot(), breakpoints: [] }), { now: NOW });
    expect(r2.coverage.safety).toBe("partial");

    const r3 = runFastScan(makeSnapshot({ ...fullSnapshot(), channelBills: [] }), { now: NOW });
    expect(r3.coverage.channel).toBe("partial");
    expect(r3.coverageNotes.some((n) => n.includes("佣金勾稽"))).toBe(true);
  });

  it("时间预算为 0 → 全部线超时 not-covered，出空报告不报错", () => {
    const r = runFastScan(fullSnapshot(), { now: NOW, timeBudgetMinutes: 0 });
    expect(Object.values(r.coverage).every((c) => c === "not-covered")).toBe(true);
    expect(r.overview.findingCount).toBe(0);
  });
});

describe("engine · 汇总", () => {
  it("Top10 按年化挽回金额降序（monthly ×12 优先于大额 one-off）", () => {
    // 倒挂：monthly 288（年化 3456）vs no-show 未结算 one-off 1200 → 倒挂排前
    const s = makeSnapshot({
      channelPrices: [
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(5), channel: "ctrip", price: 528, currency: "CNY" },
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(5), channel: "meituan", price: 600, currency: "CNY" },
      ],
      orders: [
        { hotelId: "hotel-a", orderId: "O-1", channel: "ctrip", roomTypeId: "RT-KING", amount: 2112, currency: "CNY", nights: 4, status: "completed", checkIn: dateFromNow(5), createdAt: daysAgo(3) },
        { hotelId: "hotel-a", orderId: "O-2", channel: "ctrip", roomTypeId: "RT-KING", amount: 1200, currency: "CNY", nights: 2, status: "no-show", checkIn: dateFromNow(1), createdAt: daysAgo(8), guarantee: { type: "credit-card", preauthorized: true, settled: false } },
      ],
    });
    const r = runFastScan(s, { now: NOW });
    expect(r.top10.length).toBeGreaterThanOrEqual(2);
    expect(r.top10[0]!.line).toBe("price"); // 288×12 = 3456 > 1200
    expect(r.top10[1]!.line).toBe("safety");
  });

  it("门店归集 + totalRecoverable 求和；finding id 全局唯一且格式 FND-<LINE>-<n>", () => {
    const s = makeSnapshot({
      hotels: [
        { hotelId: "hotel-a", hotelName: "云栖酒店", currency: "CNY", timezone: "Asia/Shanghai", channels: [] },
        { hotelId: "hotel-b", hotelName: "山舍酒店", currency: "CNY", timezone: "Asia/Shanghai", channels: [] },
      ],
      channelPrices: [
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(1), channel: "ctrip", price: 300, currency: "CNY" },
        { hotelId: "hotel-b", roomTypeId: "RT-KING", date: dateFromNow(1), channel: "ctrip", price: 320, currency: "CNY" },
      ],
    });
    const r = runFastScan(s, { now: NOW });
    const a = r.hotels.find((x) => x.hotelId === "hotel-a")!;
    const b = r.hotels.find((x) => x.hotelId === "hotel-b")!;
    expect(a.counts.P0).toBe(1);
    expect(b.counts.P0).toBe(1);
    const ids = r.hotels.flatMap((x) => x.findings.map((f) => f.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^FND-[A-Z]+-\d{3}$/.test(id))).toBe(true);
  });

  it("集团总览：按币种分桶合计 + 严重度计数", () => {
    const s = makeSnapshot({
      channelPrices: [{ hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(1), channel: "ctrip", price: 300, currency: "CNY" }],
      orders: [
        { hotelId: "hotel-a", orderId: "O-1", channel: "ctrip", roomTypeId: "RT-KING", amount: 600, currency: "CNY", nights: 2, status: "completed", checkIn: dateFromNow(1), createdAt: daysAgo(3) },
        // 稀释 ctrip 依赖度（2/5=40% ≤60%），避免干扰分桶断言
        { hotelId: "hotel-a", orderId: "O-2", channel: "meituan", roomTypeId: "RT-KING", amount: 900, currency: "CNY", nights: 3, status: "completed", checkIn: dateFromNow(1), createdAt: daysAgo(4) },
      ],
    });
    const r = runFastScan(s, { now: NOW });
    // 破防 P0：(380−300)×间夜2 = 160
    expect(r.overview.totalRecoverableByCurrency["CNY"]).toBe(160);
    expect(r.overview.counts.P0).toBe(1);
  });
});
