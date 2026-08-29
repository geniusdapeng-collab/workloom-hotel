/** 房态库存健康线单测：超售 / 漏售 / 问题房占比 / 连住断档（正反例 + 边界） */
import { describe, expect, it } from "vitest";
import { analyzeInventory } from "../src/analyzers/inventory.js";
import { CTX, dateFromNow, daysAgo, makeSnapshot } from "./helpers.js";

const day = (over: Partial<import("../src/types.js").RoomDayRecord>) => ({
  hotelId: "hotel-a",
  roomTypeId: "RT-KING",
  date: dateFromNow(3),
  channel: "ctrip",
  totalRooms: 20,
  sold: 10,
  maintenanceRooms: 0,
  available: 10,
  closed: false,
  ...over,
});

describe("inventory · 超售", () => {
  it("PMS 已售 > 实盘 → P0，超卖间数与证据正确", () => {
    const s = makeSnapshot({
      roomDays: [day({ sold: 21, available: 0 })],
      orders: [
        { hotelId: "hotel-a", orderId: "O-1", channel: "ctrip", roomTypeId: "RT-KING", amount: 1000, currency: "CNY", nights: 2, status: "completed", checkIn: dateFromNow(3), createdAt: daysAgo(2) },
      ],
    });
    const f = analyzeInventory(s, CTX).find((x) => x.title.includes("超售"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P0");
    expect(f!.calculation.result).toBe("21 > 20");
    // 挽回 = 1 间 × 近30天均房价 500 = 500（estimate）
    expect(f!.estimatedImpact?.amount).toBe(500);
    expect(f!.estimatedImpact?.confidence).toBe("estimate");
  });

  it("渠道可售为负 → P0；可售为 0 → 不误报", () => {
    const neg = makeSnapshot({ roomDays: [day({ available: -1 })] });
    const f = analyzeInventory(neg, CTX).find((x) => x.title.includes("可售为负"));
    expect(f?.severity).toBe("P0");

    const zero = makeSnapshot({ roomDays: [day({ sold: 20, available: 0 })] });
    expect(analyzeInventory(zero, CTX).filter((x) => x.severity === "P0")).toHaveLength(0);
  });

  it("同房型同日多渠道行 → PMS 超售只报一次（去重）", () => {
    const s = makeSnapshot({
      roomDays: [day({ sold: 22 }), day({ channel: "meituan", sold: 22 })],
    });
    expect(analyzeInventory(s, CTX).filter((x) => x.title.includes("超售"))).toHaveLength(1);
  });
});

describe("inventory · 漏售", () => {
  it("关房但有可售净房 → P1，空关间夜聚合；满房关房 → 合理不报", () => {
    const s = makeSnapshot({
      roomDays: [day({ closed: true, available: 0, sold: 10 }), day({ closed: true, available: 0, sold: 10, date: dateFromNow(4) })],
    });
    const f = analyzeInventory(s, CTX).find((x) => x.title.includes("关房未售"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    // 两天各空关 10 间（20-10-0）→ 20 间夜
    expect(f!.calculation.inputs["unsoldRoomNights"]).toBe(20);

    const full = makeSnapshot({ roomDays: [day({ closed: true, available: 0, sold: 20 })] });
    expect(analyzeInventory(full, CTX).filter((x) => x.title.includes("关房未售"))).toHaveLength(0);
  });

  it("关房且剩余全是问题房（维修占用）→ 不报漏售", () => {
    const s = makeSnapshot({ roomDays: [day({ closed: true, available: 0, sold: 15, maintenanceRooms: 5 })] });
    expect(analyzeInventory(s, CTX).filter((x) => x.title.includes("关房未售"))).toHaveLength(0);
  });
});

describe("inventory · 问题房占比", () => {
  it("占比 >10% → P1；恰好 10% → 不触发（严格大于）", () => {
    const over = makeSnapshot({ roomDays: [day({ maintenanceRooms: 3 })] }); // 3/20=15%
    const f = analyzeInventory(over, CTX).find((x) => x.title.includes("问题房占比"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.calculation.result).toBe("15.0% > 10%");

    const atLine = makeSnapshot({ roomDays: [day({ maintenanceRooms: 2 })] }); // 2/20=10%
    expect(analyzeInventory(atLine, CTX).filter((x) => x.title.includes("问题房占比"))).toHaveLength(0);
  });

  it("maintenanceRooms 未采集 → 子项跳过（降级由 engine 标 partial）", () => {
    const { maintenanceRooms: _m, ...noM } = day({});
    const s = makeSnapshot({ roomDays: [noM] });
    expect(analyzeInventory(s, CTX).filter((x) => x.title.includes("问题房占比"))).toHaveLength(0);
  });
});

describe("inventory · 连住断档", () => {
  it("前后可售、当日关房无维修 → P2 断档", () => {
    const s = makeSnapshot({
      roomDays: [
        day({ date: dateFromNow(2) }),
        day({ date: dateFromNow(3), closed: true, available: 0 }),
        day({ date: dateFromNow(4) }),
      ],
    });
    const f = analyzeInventory(s, CTX).find((x) => x.title.includes("断档"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P2");
    expect(f!.calculation.inputs["date"]).toBe(dateFromNow(3));
  });

  it("当日关房但有维修占用 / 相邻日不可售 → 不报断档", () => {
    const withM = makeSnapshot({
      roomDays: [
        day({ date: dateFromNow(2) }),
        day({ date: dateFromNow(3), closed: true, available: 0, maintenanceRooms: 20, sold: 0 }),
        day({ date: dateFromNow(4) }),
      ],
    });
    expect(analyzeInventory(withM, CTX).filter((x) => x.title.includes("断档"))).toHaveLength(0);

    const gap = makeSnapshot({
      roomDays: [
        day({ date: dateFromNow(2), closed: true, available: 0, sold: 20 }),
        day({ date: dateFromNow(3), closed: true, available: 0, sold: 20 }),
        day({ date: dateFromNow(4) }),
      ],
    });
    expect(analyzeInventory(gap, CTX).filter((x) => x.title.includes("断档"))).toHaveLength(0);
  });
});
