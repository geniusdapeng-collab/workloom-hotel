/**
 * 价格健康线（fast-scan SKILL.md 步骤 2）
 * 三个子项：
 *  1) 同房型同日跨 OTA 价差 >8% 倒挂（>15% 升 P0；R17 口径，对齐任务规格 8% 告警线）
 *  2) 售价 < 保底价破防（一店一档 business.floor_price 同源，缺失按默认 ¥380 并标注；R2 熔断口径 → P0）
 *  3) 远期价格日历异常：节假日未调价（≤平日中位价 ×1.05）/ 平日价格畸高（>1.5×）畸低（<0.6×）
 * 只扫今天及以后的可售日期（历史日期已成交，无挽回意义）。
 * 降级纪律：节假日清单缺失 → 子项 3 跳过（engine 据此标 partial）。
 */
import type { AuditSnapshot, Finding, HotelOrderRecord } from "../types.js";
import { makeFinding, median, round2, type AnalyzerContext } from "./util.js";

/** 倒挂告警阈值（任务规格：价差 >8%；R1 涨幅口径同源） */
export const PARITY_GAP_THRESHOLD = 0.08;
/** 倒挂升 P0 阈值 */
export const PARITY_GAP_P0 = 0.15;
/** 节假日未调价判定：节日价 ≤ 平日中位价 ×1.05 */
export const HOLIDAY_UPLIFT_MIN = 1.05;
/** 平日价格畸高/畸低阈值（相对平日中位价） */
export const WEEKDAY_HIGH_RATIO = 1.5;
export const WEEKDAY_LOW_RATIO = 0.6;
/** 远期日历子项最少平日样本量（不足则不判定，避免小样本误判） */
export const CALENDAR_MIN_SAMPLES = 3;

/** 近 30 天该房型在该渠道的已成交间夜（挽回金额测算分母） */
function roomNights30d(snapshot: AuditSnapshot, ctx: AnalyzerContext, hotelId: string, roomTypeId: string, channel?: string): number {
  const isLive = (o: HotelOrderRecord) => o.status === "confirmed" || o.status === "completed";
  return snapshot.orders
    .filter(
      (o) =>
        o.hotelId === hotelId &&
        o.roomTypeId === roomTypeId &&
        (channel === undefined || o.channel === channel) &&
        isLive(o) &&
        ctx.now.getTime() - Date.parse(o.createdAt) <= 30 * 86_400_000,
    )
    .reduce((s, o) => s + o.nights, 0);
}

export function analyzePrice(snapshot: AuditSnapshot, ctx: AnalyzerContext): Finding[] {
  const findings: Finding[] = [];
  const hotelById = new Map(snapshot.hotels.map((h) => [h.hotelId, h]));
  const today = ctx.now.toISOString().slice(0, 10);
  const futurePrices = snapshot.channelPrices.filter((p) => p.date >= today);

  /* ---------- 子项 1：同房型同日跨 OTA 价差 >8% 倒挂 ---------- */
  const byCell = new Map<string, typeof futurePrices>();
  for (const p of futurePrices) {
    const key = `${p.hotelId}::${p.roomTypeId}::${p.date}`;
    const arr = byCell.get(key) ?? [];
    arr.push(p);
    byCell.set(key, arr);
  }
  for (const [key, rows] of byCell) {
    if (rows.length < 2) continue;
    // 跨币种不比价（报告层才做汇率折算，引擎保持同币种确定性）
    if (new Set(rows.map((r) => r.currency)).size > 1) continue;
    let minRow = rows[0]!;
    let maxRow = rows[0]!;
    for (const r of rows) {
      if (r.price < minRow.price) minRow = r;
      if (r.price > maxRow.price) maxRow = r;
    }
    const gap = (maxRow.price - minRow.price) / maxRow.price;
    if (gap > PARITY_GAP_THRESHOLD) {
      const [hotelId, roomTypeId, date] = key.split("::") as [string, string, string];
      const hotel = hotelById.get(hotelId);
      const perNight = round2(maxRow.price - minRow.price);
      const nights = roomNights30d(snapshot, ctx, hotelId, roomTypeId, minRow.channel);
      findings.push(
        makeFinding({
          line: "price",
          severity: gap > PARITY_GAP_P0 ? "P0" : "P1",
          hotelId,
          title: `${roomTypeId} ${date} 跨渠道价格倒挂 ${(gap * 100).toFixed(1)}%（${hotel?.hotelName ?? hotelId}）`,
          description: `${minRow.channel} 售价 ${minRow.price} ${minRow.currency}，${maxRow.channel} 售价 ${maxRow.price}，价差 ${(gap * 100).toFixed(1)}% > 8% 告警线（R17 倒挂口径）。低价渠道正在补贴高价渠道流量，并拉低品牌价格锚点。`,
          suggestion: `建议 ${minRow.channel} 提价至 ${round2(maxRow.price * (1 - PARITY_GAP_THRESHOLD))} 以上，或排查是否为促销忘恢复/渠道私自改价；托管后由 overbooking-parity-guard 实时防护。`,
          evidence: [
            { kind: "channel-price", id: `${minRow.channel}|${roomTypeId}|${date}`, fields: { channel: minRow.channel, price: minRow.price } },
            { kind: "channel-price", id: `${maxRow.channel}|${roomTypeId}|${date}`, fields: { channel: maxRow.channel, price: maxRow.price } },
          ],
          calculation: {
            formula: "gap = (最高价 − 最低价) / 最高价（同房型同日跨渠道）",
            inputs: { roomTypeId, date, minPrice: minRow.price, maxPrice: maxRow.price, minChannel: minRow.channel, maxChannel: maxRow.channel },
            result: round2(gap * 100) + "%",
          },
          ...(nights > 0
            ? {
                estimatedImpact: {
                  amount: round2(perNight * nights),
                  currency: minRow.currency,
                  period: "monthly" as const,
                  confidence: "baseline" as const,
                  basis: `近30天 ${minRow.channel} 该房型间夜 ${nights} × 每间夜价差 ${perNight}`,
                },
              }
            : {}),
        }),
      );
    }
  }

  /* ---------- 子项 2：售价 < 保底价破防（R2 熔断口径） ---------- */
  const breachGroups = new Map<string, { prices: number[]; dates: string[]; currency: string; usingDefaultFloor: boolean; floor: number }>();
  for (const p of futurePrices) {
    const hotel = hotelById.get(p.hotelId);
    const floor = hotel?.floorPrice ?? ctx.floorPriceDefault;
    if (p.price >= floor) continue;
    const key = `${p.hotelId}::${p.roomTypeId}::${p.channel}`;
    const g = breachGroups.get(key) ?? { prices: [], dates: [], currency: p.currency, usingDefaultFloor: hotel?.floorPrice === undefined, floor };
    g.prices.push(p.price);
    g.dates.push(p.date);
    breachGroups.set(key, g);
  }
  for (const [key, g] of breachGroups) {
    const [hotelId, roomTypeId, channel] = key.split("::") as [string, string, string];
    const minPrice = Math.min(...g.prices);
    const nights = roomNights30d(snapshot, ctx, hotelId, roomTypeId, channel);
    findings.push(
      makeFinding({
        line: "price",
        severity: "P0",
        hotelId,
        title: `${roomTypeId} 在 ${channel} 破保底价：最低 ${minPrice} < ${g.floor}（${g.dates.length} 天）`,
        description: `${channel} 渠道 ${g.dates.length} 个在售日期售价低于保底价 ¥${g.floor}（最低 ${minPrice}），命中 R2 保底价熔断口径，卖一间亏一间。${
          g.usingDefaultFloor ? "（该店一店一档保底价未采集，按默认 ¥380 判定，报告中标注估算口径）" : ""
        }`,
        suggestion: `立即熔断 ${channel} 低价日期并回拉至 ¥${g.floor} 以上；排查是否为促销叠加失误或渠道私自改价。`,
        evidence: [{ kind: "channel-price", id: `${channel}|${roomTypeId}`, fields: { minPrice, daysBelowFloor: g.dates.length, floorPrice: g.floor } }],
        calculation: {
          formula: "售价 < 保底价（一店一档 floor_price，缺失按默认 ¥380）",
          inputs: { roomTypeId, channel, minPrice, floorPrice: g.floor, daysBelowFloor: g.dates.length, ...(g.usingDefaultFloor ? { floorSource: "default-380" } : { floorSource: "hotel-profile" }) },
          result: `${minPrice} < ${g.floor}`,
        },
        ...(nights > 0
          ? {
              estimatedImpact: {
                amount: round2((g.floor - minPrice) * nights),
                currency: g.currency,
                period: "monthly" as const,
                confidence: "baseline" as const,
                basis: `近30天该渠道该房型间夜 ${nights} × 每间夜破防差额 ${round2(g.floor - minPrice)}`,
              },
            }
          : {}),
      }),
    );
  }

  /* ---------- 子项 3：远期价格日历异常 ---------- */
  const holidaySet = new Set(snapshot.holidays);
  if (holidaySet.size > 0) {
    const bySeries = new Map<string, typeof futurePrices>();
    for (const p of futurePrices) {
      const key = `${p.hotelId}::${p.roomTypeId}::${p.channel}`;
      const arr = bySeries.get(key) ?? [];
      arr.push(p);
      bySeries.set(key, arr);
    }
    for (const [key, rows] of bySeries) {
      const weekdayPrices = rows.filter((r) => !holidaySet.has(r.date)).map((r) => r.price);
      if (weekdayPrices.length < CALENDAR_MIN_SAMPLES) continue;
      const med = median(weekdayPrices);
      const [hotelId, roomTypeId, channel] = key.split("::") as [string, string, string];
      // 3a：节假日未调价
      const staleHolidays = rows.filter((r) => holidaySet.has(r.date) && r.price <= med * HOLIDAY_UPLIFT_MIN);
      if (staleHolidays.length > 0) {
        const dates = staleHolidays.map((r) => r.date).sort();
        const hotel = hotelById.get(hotelId);
        // 挽回 = 节假日天数 × 应有涨幅缺口（按平日中位价 ×1.3 目标估算）× 该店总房量占比近似——按经验口径从简：缺口×间夜基数
        const nights = roomNights30d(snapshot, ctx, hotelId, roomTypeId, channel);
        const gapPerNight = round2(Math.max(0, med * 1.3 - Math.min(...staleHolidays.map((r) => r.price))));
        findings.push(
          makeFinding({
            line: "price",
            severity: "P1",
            hotelId,
            title: `${roomTypeId} 在 ${channel} 节假日未调价：${dates.length} 天（${dates[0]} 起）`,
            description: `节假日 ${dates.join("、")} 售价仍贴平日中位价 ${round2(med)}（未超 ×${HOLIDAY_UPLIFT_MIN}），节假日需求峰值被平价卖出。`,
            suggestion: `按收益日历对节假日上调（参考平日中位价 ×1.3 ≈ ${round2(med * 1.3)}），并纳入节假日调价 SOP 复核。`,
            evidence: staleHolidays.map((r) => ({ kind: "channel-price", id: `${channel}|${roomTypeId}|${r.date}`, fields: { date: r.date, price: r.price } })),
            calculation: {
              formula: "节假日售价 ≤ 平日中位价 × 1.05 → 未调价",
              inputs: { roomTypeId, channel, weekdayMedian: round2(med), holidayDays: staleHolidays.length, firstDate: dates[0]! },
              result: `${staleHolidays.length} 天未调价`,
            },
            ...(nights > 0 && gapPerNight > 0
              ? {
                  estimatedImpact: {
                    amount: round2((gapPerNight * nights * staleHolidays.length) / 30),
                    currency: staleHolidays[0]!.currency,
                    period: "monthly" as const,
                    confidence: "estimate" as const,
                    basis: `节假日 ${staleHolidays.length} 天 × 间夜基数 ${nights}/30天 × 每间夜调价缺口 ${gapPerNight}（按平日中位价 ×1.3 目标经验估算）`,
                  },
                }
              : {}),
          }),
        );
      }
      // 3b：平日价格畸高/畸低
      for (const r of rows) {
        if (holidaySet.has(r.date)) continue;
        if (r.price > med * WEEKDAY_HIGH_RATIO || r.price < med * WEEKDAY_LOW_RATIO) {
          const high = r.price > med * WEEKDAY_HIGH_RATIO;
          findings.push(
            makeFinding({
              line: "price",
              severity: "P2",
              hotelId,
              title: `${roomTypeId} 在 ${channel} ${r.date} 平日价格畸${high ? "高" : "低"}：${r.price}（中位价 ${round2(med)}）`,
              description: `非节假日售价 ${r.price} ${high ? `> 平日中位价 ×${WEEKDAY_HIGH_RATIO}` : `< 平日中位价 ×${WEEKDAY_LOW_RATIO}`}，疑似手动改价遗留或促销叠加失误。`,
              suggestion: high ? "核对是否为展会/赛事日，非特殊日应回落至价格带内。" : "核对是否为促销忘恢复；若无促销计划应回拉至价格带内。",
              evidence: [{ kind: "channel-price", id: `${channel}|${roomTypeId}|${r.date}`, fields: { date: r.date, price: r.price, weekdayMedian: round2(med) } }],
              calculation: {
                formula: `平日售价 ${high ? `> 中位价 ×${WEEKDAY_HIGH_RATIO}` : `< 中位价 ×${WEEKDAY_LOW_RATIO}`}`,
                inputs: { roomTypeId, channel, date: r.date, price: r.price, weekdayMedian: round2(med) },
                result: `${r.price} ${high ? ">" : "<"} ${round2(high ? med * WEEKDAY_HIGH_RATIO : med * WEEKDAY_LOW_RATIO)}`,
              },
            }),
          );
        }
      }
    }
  }

  return findings;
}
