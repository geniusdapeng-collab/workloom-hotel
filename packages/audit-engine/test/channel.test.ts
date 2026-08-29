/** 渠道健康线单测：佣金错算 / 勾稽差异 / 单渠道依赖度（正反例 + 边界 + 降级） */
import { describe, expect, it } from "vitest";
import { analyzeChannel } from "../src/analyzers/channel.js";
import { CTX, dateFromNow, daysAgo, makeSnapshot } from "./helpers.js";

const order = (over: Partial<import("../src/types.js").HotelOrderRecord>) => ({
  hotelId: "hotel-a",
  orderId: "O-1",
  channel: "ctrip",
  roomTypeId: "RT-KING",
  amount: 20000,
  currency: "CNY",
  nights: 2,
  status: "completed" as const,
  checkIn: dateFromNow(6),
  createdAt: daysAgo(10),
  ...over,
});

describe("channel · 佣金错算", () => {
  it("多提 0.6pp → 检出，exact 金额 = 订单额 ×0.6pp", () => {
    const s = makeSnapshot({
      orders: [order({})],
      channelBills: [
        {
          hotelId: "hotel-a",
          channel: "ctrip",
          billId: "B-1",
          period: "2026-08",
          lines: [
            { lineId: "L-1", type: "order", refId: "O-1", amount: 20000, currency: "CNY" },
            { lineId: "L-2", type: "commission", refId: "O-1", amount: 3120, currency: "CNY" }, // 应提 3000
          ],
        },
      ],
    });
    const f = analyzeChannel(s, CTX).find((x) => x.title.includes("佣金错算"));
    expect(f).toBeDefined();
    expect(f!.calculation.result).toBe("0.60pp");
    expect(f!.estimatedImpact?.amount).toBe(120);
    expect(f!.estimatedImpact?.confidence).toBe("exact");
    expect(f!.severity).toBe("P2"); // 差额 120 ≤ 500
  });

  it("差额 >500 升 P1；边界：恰好 0.5pp 不触发", () => {
    const big = makeSnapshot({
      orders: [order({})],
      channelBills: [
        { hotelId: "hotel-a", channel: "ctrip", billId: "B-1", period: "2026-08", lines: [{ lineId: "L-2", type: "commission", refId: "O-1", amount: 3600, currency: "CNY" }] },
      ],
    });
    expect(analyzeChannel(big, CTX).find((x) => x.title.includes("佣金错算"))?.severity).toBe("P1"); // 多提 3pp = 600

    const atLine = makeSnapshot({
      orders: [order({})],
      channelBills: [
        { hotelId: "hotel-a", channel: "ctrip", billId: "B-1", period: "2026-08", lines: [{ lineId: "L-2", type: "commission", refId: "O-1", amount: 3100, currency: "CNY" }] },
      ],
    });
    // 0.5pp 恰好 = 容差 → 不触发（严格大于）
    expect(analyzeChannel(atLine, CTX).filter((x) => x.title.includes("佣金错算"))).toHaveLength(0);
  });

  it("渠道佣金协议比例缺失 → 该渠道佣金子项跳过（不误判）", () => {
    const s = makeSnapshot({
      hotels: [{ hotelId: "hotel-a", hotelName: "云栖酒店", currency: "CNY", timezone: "Asia/Shanghai", channels: [{ channel: "ctrip" }] }],
      orders: [order({})],
      channelBills: [
        { hotelId: "hotel-a", channel: "ctrip", billId: "B-1", period: "2026-08", lines: [{ lineId: "L-2", type: "commission", refId: "O-1", amount: 9999, currency: "CNY" }] },
      ],
    });
    expect(analyzeChannel(s, CTX).filter((x) => x.title.includes("佣金错算"))).toHaveLength(0);
  });
});

describe("channel · 订单与账单勾稽差异", () => {
  it("账单金额 ≠ PMS 订单金额 → P1，差值 exact 口径", () => {
    const s = makeSnapshot({
      orders: [order({})],
      channelBills: [
        { hotelId: "hotel-a", channel: "ctrip", billId: "B-1", period: "2026-08", lines: [{ lineId: "L-1", type: "order", refId: "O-1", amount: 20800, currency: "CNY" }] },
      ],
    });
    const f = analyzeChannel(s, CTX).find((x) => x.title.includes("勾稽差异"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.calculation.result).toBe(800);
  });

  it("账单订单行无匹配 PMS 订单 → P2 无法勾稽", () => {
    const s = makeSnapshot({
      orders: [order({})],
      channelBills: [
        { hotelId: "hotel-a", channel: "ctrip", billId: "B-1", period: "2026-08", lines: [{ lineId: "L-9", type: "order", refId: "O-GHOST", amount: 5000, currency: "CNY" }] },
      ],
    });
    const f = analyzeChannel(s, CTX).find((x) => x.title.includes("无法勾稽"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P2");
    expect(f!.calculation.inputs["refId"]).toBe("O-GHOST");
  });
});

describe("channel · 单渠道依赖度", () => {
  const mk = (ctripNights: number, meituanNights: number) =>
    makeSnapshot({
      orders: [
        order({ orderId: "O-1", channel: "ctrip", nights: ctripNights, amount: ctripNights * 500 }),
        order({ orderId: "O-2", channel: "meituan", nights: meituanNights, amount: meituanNights * 500 }),
      ],
    });

  it("依赖度 >60% → P1；>80% → P0；恰好 60% 不触发", () => {
    const p1 = analyzeChannel(mk(7, 3), CTX).find((x) => x.title.includes("单渠道依赖度"));
    expect(p1?.severity).toBe("P1"); // 70%
    expect(p1?.calculation.result).toBe("70.0%");

    const p0 = analyzeChannel(mk(9, 1), CTX).find((x) => x.title.includes("单渠道依赖度"));
    expect(p0?.severity).toBe("P0"); // 90%

    expect(analyzeChannel(mk(6, 4), CTX).filter((x) => x.title.includes("单渠道依赖度"))).toHaveLength(0);
  });

  it("已取消订单不计入依赖度分母", () => {
    const s = makeSnapshot({
      orders: [
        order({ orderId: "O-1", channel: "ctrip", nights: 5, amount: 2500 }),
        order({ orderId: "O-2", channel: "meituan", nights: 5, amount: 2500 }),
        order({ orderId: "O-3", channel: "ctrip", nights: 99, amount: 1, status: "cancelled" }),
      ],
    });
    expect(analyzeChannel(s, CTX).filter((x) => x.title.includes("单渠道依赖度"))).toHaveLength(0);
  });
});
