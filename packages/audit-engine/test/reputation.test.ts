/** 口碑健康线单测：24h 未回 SLA / 评分下滑 / 关键词聚集（正反例 + 边界） */
import { describe, expect, it } from "vitest";
import { analyzeReputation } from "../src/analyzers/reputation.js";
import { CTX, hoursAgo, makeSnapshot } from "./helpers.js";

const review = (over: Partial<import("../src/types.js").HotelReviewRecord>) => ({
  hotelId: "hotel-a",
  reviewId: "RV-1",
  channel: "ctrip",
  rating: 2,
  createdAt: hoursAgo(36),
  ...over,
});

describe("reputation · 差评 24h 未回（R19 SLA）", () => {
  it("36h 未回 → P1；>72h → P0；恰好 24h → 不触发", () => {
    const s = makeSnapshot({ reviews: [review({})] });
    const f = analyzeReputation(s, CTX).find((x) => x.title.includes("未回复"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.calculation.result).toBe("36h > 24h");

    const p0 = makeSnapshot({ reviews: [review({ reviewId: "RV-2", createdAt: hoursAgo(80) })] });
    expect(analyzeReputation(p0, CTX).find((x) => x.title.includes("未回复"))?.severity).toBe("P0");

    const atLine = makeSnapshot({ reviews: [review({ reviewId: "RV-3", createdAt: hoursAgo(24) })] });
    expect(analyzeReputation(atLine, CTX).filter((x) => x.title.includes("未回复"))).toHaveLength(0);
  });

  it("已回复 / 4 分以上 → 不报；3 分恰为差评口径（R6 ≤3 分）", () => {
    const replied = makeSnapshot({ reviews: [review({ repliedAt: hoursAgo(1) })] });
    expect(analyzeReputation(replied, CTX).filter((x) => x.title.includes("未回复"))).toHaveLength(0);

    const good = makeSnapshot({ reviews: [review({ rating: 4 })] });
    expect(analyzeReputation(good, CTX).filter((x) => x.title.includes("未回复"))).toHaveLength(0);

    const three = makeSnapshot({ reviews: [review({ rating: 3 })] });
    expect(analyzeReputation(three, CTX).find((x) => x.title.includes("未回复"))).toBeDefined();
  });
});

describe("reputation · 评分双红线", () => {
  it("评分 <4.2 且 30 天下滑 >0.3 → P1；单项越线不误报", () => {
    const both = makeSnapshot({
      hotels: [{ hotelId: "hotel-a", hotelName: "云栖酒店", currency: "CNY", timezone: "Asia/Shanghai", rating: 4.1, ratingDelta30d: -0.4, channels: [] }],
      reviews: [review({})],
    });
    expect(analyzeReputation(both, CTX).find((x) => x.title.includes("双红线"))?.severity).toBe("P1");

    const onlyLow = makeSnapshot({
      hotels: [{ hotelId: "hotel-a", hotelName: "云栖酒店", currency: "CNY", timezone: "Asia/Shanghai", rating: 4.1, ratingDelta30d: -0.2, channels: [] }],
      reviews: [review({})],
    });
    expect(analyzeReputation(onlyLow, CTX).filter((x) => x.title.includes("双红线"))).toHaveLength(0);

    const onlyDrop = makeSnapshot({
      hotels: [{ hotelId: "hotel-a", hotelName: "云栖酒店", currency: "CNY", timezone: "Asia/Shanghai", rating: 4.5, ratingDelta30d: -0.5, channels: [] }],
      reviews: [review({})],
    });
    expect(analyzeReputation(onlyDrop, CTX).filter((x) => x.title.includes("双红线"))).toHaveLength(0);
  });

  it("评分指标未采集 → 子项跳过（降级由 engine 标 partial）", () => {
    const s = makeSnapshot({
      hotels: [{ hotelId: "hotel-a", hotelName: "云栖酒店", currency: "CNY", timezone: "Asia/Shanghai", channels: [] }],
      reviews: [review({})],
    });
    expect(analyzeReputation(s, CTX).filter((x) => x.title.includes("双红线"))).toHaveLength(0);
  });
});

describe("reputation · 差评关键词聚集", () => {
  it("近30天同关键词 ≥3 条 → P1；「安全」聚集 → P0；2 条 → 不报", () => {
    const three = makeSnapshot({
      reviews: [1, 2, 3].map((i) => review({ reviewId: `RV-${i}`, createdAt: hoursAgo(i * 10), content: "房间隔音太差，半夜被吵醒" })),
    });
    const f = analyzeReputation(three, CTX).find((x) => x.title.includes("「隔音」"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.calculation.result).toBe("3 ≥ 3");

    const safety = makeSnapshot({
      reviews: [1, 2, 3].map((i) => review({ reviewId: `RV-S${i}`, createdAt: hoursAgo(i * 10), content: "门锁安全隐患让人担心" })),
    });
    expect(analyzeReputation(safety, CTX).find((x) => x.title.includes("「安全」"))?.severity).toBe("P0");

    const two = makeSnapshot({
      reviews: [1, 2].map((i) => review({ reviewId: `RV-T${i}`, createdAt: hoursAgo(i * 10), content: "卫生状况差" })),
    });
    expect(analyzeReputation(two, CTX).filter((x) => x.title.includes("聚集"))).toHaveLength(0);
  });

  it("30 天窗口外的差评不计入聚集", () => {
    const s = makeSnapshot({
      reviews: [
        review({ reviewId: "RV-N1", createdAt: hoursAgo(10), content: "热水不热" }),
        review({ reviewId: "RV-O1", createdAt: hoursAgo(40 * 24), content: "热水不热" }),
        review({ reviewId: "RV-O2", createdAt: hoursAgo(50 * 24), content: "热水不热" }),
      ],
    });
    expect(analyzeReputation(s, CTX).filter((x) => x.title.includes("「热水」"))).toHaveLength(0);
  });
});
