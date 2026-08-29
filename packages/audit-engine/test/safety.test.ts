/** 安全与断点线单测：担保异常 / 断点高频（正反例 + 边界 + 根因闭环建议） */
import { describe, expect, it } from "vitest";
import { analyzeSafety } from "../src/analyzers/safety.js";
import { CTX, dateFromNow, daysAgo, hoursAgo, makeSnapshot } from "./helpers.js";

const order = (over: Partial<import("../src/types.js").HotelOrderRecord>) => ({
  hotelId: "hotel-a",
  orderId: "O-1",
  channel: "ctrip",
  roomTypeId: "RT-KING",
  amount: 1200,
  currency: "CNY",
  nights: 2,
  status: "confirmed" as const,
  checkIn: dateFromNow(10),
  createdAt: daysAgo(3),
  ...over,
});

describe("safety · 担保订单异常（R5 同源）", () => {
  it("担保未预授权 → P1，敞口 = 首晚房费（订单额/间夜）", () => {
    const s = makeSnapshot({ orders: [order({ guarantee: { type: "credit-card", preauthorized: false } })] });
    const f = analyzeSafety(s, CTX).find((x) => x.title.includes("未预授权"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.estimatedImpact?.amount).toBe(600); // 1200/2
    expect(f!.estimatedImpact?.confidence).toBe("baseline");
  });

  it("no-show 且担保未结算 → P0，按订单全额估敞口", () => {
    const s = makeSnapshot({ orders: [order({ status: "no-show", guarantee: { type: "credit-card", preauthorized: true, preauthAmount: 600, settled: false } })] });
    const f = analyzeSafety(s, CTX).find((x) => x.title.includes("no-show 担保未结算"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P0");
    expect(f!.estimatedImpact?.amount).toBe(1200);
  });

  it("预授权不足首晚 → P1；超额 >1.5× → P2；足额合理 → 不报", () => {
    const low = makeSnapshot({ orders: [order({ orderId: "O-L", guarantee: { type: "credit-card", preauthorized: true, preauthAmount: 400 } })] });
    const fl = analyzeSafety(low, CTX).find((x) => x.title.includes("预授权不足"));
    expect(fl?.severity).toBe("P1");
    expect(fl?.estimatedImpact?.amount).toBe(200); // 首晚 600 − 400

    const over = makeSnapshot({ orders: [order({ orderId: "O-O", guarantee: { type: "credit-card", preauthorized: true, preauthAmount: 2000 } })] });
    expect(analyzeSafety(over, CTX).find((x) => x.title.includes("预授权超额"))?.severity).toBe("P2");

    const ok = makeSnapshot({ orders: [order({ orderId: "O-OK", guarantee: { type: "credit-card", preauthorized: true, preauthAmount: 700 } })] });
    expect(analyzeSafety(ok, CTX)).toHaveLength(0);
  });

  it("无担保标记订单 → 子项跳过；已取消单不再追预授权", () => {
    const none = makeSnapshot({ orders: [order({})] });
    expect(analyzeSafety(none, CTX)).toHaveLength(0);

    const cancelled = makeSnapshot({ orders: [order({ status: "cancelled", guarantee: { type: "credit-card", preauthorized: false } })] });
    expect(analyzeSafety(cancelled, CTX)).toHaveLength(0);
  });
});

describe("safety · 断点高频项（断点是资产）", () => {
  const bp = (id: string, hoursAgoN: number, rootCause?: string) => ({
    hotelId: "hotel-a",
    breakpointId: id,
    category: "ota-sync-failed",
    occurredAt: hoursAgo(hoursAgoN),
    ...(rootCause ? { rootCause } : {}),
  });

  it("同类断点 7 天 ≥2 次 → P1 且附根因闭环建议；≥4 次 → P0", () => {
    const two = makeSnapshot({ breakpoints: [bp("BP-1", 24), bp("BP-2", 48)] });
    const f = analyzeSafety(two, CTX).find((x) => x.title.includes("断点高频"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.suggestion).toContain("闭环建议");
    expect(f!.description).toContain("尚无根因沉淀");

    const four = makeSnapshot({ breakpoints: [bp("BP-1", 12), bp("BP-2", 24), bp("BP-3", 48), bp("BP-4", 72)] });
    expect(analyzeSafety(four, CTX).find((x) => x.title.includes("断点高频"))?.severity).toBe("P0");
  });

  it("窗口外断点不计入（8 天前）；单次 → 不报；已沉淀根因被引用", () => {
    const old = makeSnapshot({ breakpoints: [bp("BP-1", 24), bp("BP-2", 8 * 24)] });
    expect(analyzeSafety(old, CTX).filter((x) => x.title.includes("断点高频"))).toHaveLength(0);

    const single = makeSnapshot({ breakpoints: [bp("BP-1", 24)] });
    expect(analyzeSafety(single, CTX)).toHaveLength(0);

    const withCause = makeSnapshot({ breakpoints: [bp("BP-1", 24, "渠道直连凭证过期"), bp("BP-2", 48)] });
    const f = analyzeSafety(withCause, CTX).find((x) => x.title.includes("断点高频"));
    expect(f!.description).toContain("渠道直连凭证过期");
    expect(f!.calculation.inputs["rootCauseCoverage"]).toBe("1/2");
  });
});
