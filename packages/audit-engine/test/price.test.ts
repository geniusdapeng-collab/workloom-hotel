/** 价格健康线单测：倒挂 / 破保底价 / 远期日历异常（正反例 + 边界 + 降级） */
import { describe, expect, it } from "vitest";
import { analyzePrice } from "../src/analyzers/price.js";
import { CTX, dateFromNow, daysAgo, makeSnapshot } from "./helpers.js";

describe("price · 跨渠道倒挂", () => {
  it("价差 >8% → P1，挂低价渠道，口径与证据正确", () => {
    const s = makeSnapshot({
      channelPrices: [
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(5), channel: "ctrip", price: 528, currency: "CNY" },
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(5), channel: "meituan", price: 600, currency: "CNY" },
      ],
      orders: [
        { hotelId: "hotel-a", orderId: "O-1", channel: "ctrip", roomTypeId: "RT-KING", amount: 2112, currency: "CNY", nights: 4, status: "completed", checkIn: dateFromNow(5), createdAt: daysAgo(3) },
      ],
    });
    const fs = analyzePrice(s, CTX);
    const f = fs.find((x) => x.title.includes("倒挂"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1"); // 12% > 8%，未超 15% 升级线
    expect(f!.hotelId).toBe("hotel-a");
    expect(f!.calculation.inputs["minChannel"]).toBe("ctrip");
    expect(f!.calculation.result).toBe("12%");
    // 挽回 = 间夜 4 × 价差 72 = 288（monthly / baseline）
    expect(f!.estimatedImpact?.amount).toBe(288);
    expect(f!.estimatedImpact?.period).toBe("monthly");
    expect(f!.estimatedImpact?.confidence).toBe("baseline");
  });

  it("价差 >15% → 升 P0", () => {
    const s = makeSnapshot({
      channelPrices: [
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(5), channel: "ctrip", price: 400, currency: "CNY" },
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(5), channel: "meituan", price: 500, currency: "CNY" },
      ],
    });
    const f = analyzePrice(s, CTX).find((x) => x.title.includes("倒挂"));
    expect(f!.severity).toBe("P0");
  });

  it("边界：价差恰好 8% → 不触发（口径为严格大于）", () => {
    const s = makeSnapshot({
      channelPrices: [
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(5), channel: "ctrip", price: 552, currency: "CNY" },
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(5), channel: "meituan", price: 600, currency: "CNY" },
      ],
    });
    expect(analyzePrice(s, CTX).filter((x) => x.title.includes("倒挂"))).toHaveLength(0);
  });

  it("同房型同日仅单渠道 / 历史日期 → 不判定倒挂", () => {
    const s = makeSnapshot({
      channelPrices: [
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(5), channel: "ctrip", price: 400, currency: "CNY" },
        // 历史日期（昨天）：即使价差 50% 也不扫（已成交无挽回意义）
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(-1), channel: "ctrip", price: 300, currency: "CNY" },
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(-1), channel: "meituan", price: 600, currency: "CNY" },
      ],
    });
    expect(analyzePrice(s, CTX).filter((x) => x.title.includes("倒挂"))).toHaveLength(0);
  });
});

describe("price · 破保底价（R2 口径）", () => {
  it("售价 < 一店一档保底价 → P0，按房型×渠道聚合，天数与最低价正确", () => {
    const s = makeSnapshot({
      channelPrices: [
        { hotelId: "hotel-a", roomTypeId: "RT-TWIN", date: dateFromNow(1), channel: "fliggy", price: 360, currency: "CNY" },
        { hotelId: "hotel-a", roomTypeId: "RT-TWIN", date: dateFromNow(2), channel: "fliggy", price: 350, currency: "CNY" },
        { hotelId: "hotel-a", roomTypeId: "RT-TWIN", date: dateFromNow(3), channel: "fliggy", price: 420, currency: "CNY" },
      ],
    });
    const fs = analyzePrice(s, CTX).filter((x) => x.title.includes("破保底价"));
    expect(fs).toHaveLength(1);
    expect(fs[0]!.severity).toBe("P0");
    expect(fs[0]!.calculation.inputs["minPrice"]).toBe(350);
    expect(fs[0]!.calculation.inputs["daysBelowFloor"]).toBe(2);
    expect(fs[0]!.calculation.inputs["floorSource"]).toBe("hotel-profile");
  });

  it("一店一档保底价缺失 → 按默认 ¥380 判定并标注 default 口径", () => {
    const s = makeSnapshot({
      hotels: [{ hotelId: "hotel-a", hotelName: "云栖酒店", currency: "CNY", timezone: "Asia/Shanghai", channels: [] }],
      channelPrices: [{ hotelId: "hotel-a", roomTypeId: "RT-TWIN", date: dateFromNow(1), channel: "ctrip", price: 370, currency: "CNY" }],
    });
    const f = analyzePrice(s, CTX).find((x) => x.title.includes("破保底价"));
    expect(f).toBeDefined();
    expect(f!.calculation.inputs["floorPrice"]).toBe(380);
    expect(f!.calculation.inputs["floorSource"]).toBe("default-380");
    expect(f!.description).toContain("默认 ¥380");
  });

  it("售价 = 保底价 → 不触发（口径为严格小于）", () => {
    const s = makeSnapshot({
      channelPrices: [{ hotelId: "hotel-a", roomTypeId: "RT-TWIN", date: dateFromNow(1), channel: "ctrip", price: 380, currency: "CNY" }],
    });
    expect(analyzePrice(s, CTX).filter((x) => x.title.includes("破保底价"))).toHaveLength(0);
  });
});

describe("price · 远期价格日历异常", () => {
  const weekdayRows = [1, 2, 3, 4].map((d) => ({ hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(d), channel: "ctrip", price: 500, currency: "CNY" }));

  it("节假日贴平日价（≤中位价 ×1.05）→ P1 未调价", () => {
    const s = makeSnapshot({
      channelPrices: [
        ...weekdayRows,
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: "2026-10-01", channel: "ctrip", price: 500, currency: "CNY" },
      ],
    });
    const f = analyzePrice(s, CTX).find((x) => x.title.includes("节假日未调价"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.calculation.inputs["holidayDays"]).toBe(1);
  });

  it("节假日已上调（>中位价 ×1.05）→ 不误报", () => {
    const s = makeSnapshot({
      channelPrices: [
        ...weekdayRows,
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: "2026-10-01", channel: "ctrip", price: 700, currency: "CNY" },
      ],
    });
    expect(analyzePrice(s, CTX).filter((x) => x.title.includes("节假日未调价"))).toHaveLength(0);
  });

  it("平日价格畸高（>1.5×）与畸低（<0.6×）→ P2", () => {
    const s = makeSnapshot({
      channelPrices: [
        ...weekdayRows,
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(6), channel: "ctrip", price: 800, currency: "CNY" },
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(7), channel: "ctrip", price: 250, currency: "CNY" },
      ],
    });
    const fs = analyzePrice(s, CTX);
    expect(fs.find((x) => x.title.includes("畸高"))?.severity).toBe("P2");
    expect(fs.find((x) => x.title.includes("畸低"))?.severity).toBe("P2");
  });

  it("平日样本 <3 → 日历子项不判定（小样本防误判）；节假日清单缺失 → 子项整体跳过", () => {
    const few = makeSnapshot({
      channelPrices: [
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: dateFromNow(1), channel: "ctrip", price: 500, currency: "CNY" },
        { hotelId: "hotel-a", roomTypeId: "RT-KING", date: "2026-10-01", channel: "ctrip", price: 500, currency: "CNY" },
      ],
    });
    expect(analyzePrice(few, CTX).filter((x) => x.title.includes("节假日未调价"))).toHaveLength(0);

    const noHolidays = makeSnapshot({
      holidays: [],
      channelPrices: [...weekdayRows, { hotelId: "hotel-a", roomTypeId: "RT-KING", date: "2026-10-01", channel: "ctrip", price: 500, currency: "CNY" }],
    });
    expect(analyzePrice(noHolidays, CTX).filter((x) => x.title.includes("节假日未调价") || x.title.includes("畸"))).toHaveLength(0);
  });
});
