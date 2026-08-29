/**
 * 口碑健康线（fast-scan SKILL.md 步骤 5）
 * 三个子项：
 *  1) 差评（≤3 分，R6 口径）>24h 未回复（R19 酒店 SLA；>72h 升 P0——舆情已发酵）
 *  2) 评分 <4.2 且近30天评分下滑 >0.3（门店档案指标；未采集则跳过，engine 标 partial）
 *  3) 差评关键词聚集：近30天差评中同关键词 ≥3 条（隔音/热水/卫生/前台/早餐/空调/异味/安全；
 *     「安全」类聚集升 P0）
 */
import type { AuditSnapshot, Finding } from "../types.js";
import { hoursSince, makeFinding, round2, windowStart, type AnalyzerContext } from "./util.js";

/** 差评分值口径（R6：≤3 分） */
export const BAD_RATING_MAX = 3;
/** 未回复时长红线（R19：24h，酒店 SLA 严于电商） */
export const UNREPLIED_HOURS = 24;
/** 升级 P0 的时长（72h，舆情发酵） */
export const UNREPLIED_HOURS_P0 = 72;
/** 低评分红线与下滑红线（任务规格：<4.2 且 30 天下滑 >0.3） */
export const LOW_RATING = 4.2;
export const RATING_DROP_REDLINE = 0.3;
/** 差评聚集口径：30 天窗口内同关键词 ≥3 条 */
export const CLUSTER_DAYS = 30;
export const CLUSTER_MIN_BAD = 3;
/** 差评关键词表（SKILL.md：卫生/隔音/前台/早餐 + 高频硬件词） */
export const BAD_KEYWORDS = ["卫生", "隔音", "热水", "前台", "早餐", "空调", "异味", "安全"] as const;

export function analyzeReputation(snapshot: AuditSnapshot, ctx: AnalyzerContext): Finding[] {
  const findings: Finding[] = [];
  const hotelById = new Map(snapshot.hotels.map((h) => [h.hotelId, h]));

  /* ---------- 子项 1：差评 >24h 未回复 ---------- */
  for (const r of snapshot.reviews) {
    if (r.rating > BAD_RATING_MAX || r.repliedAt !== undefined) continue;
    const hours = hoursSince(ctx.now, r.createdAt);
    if (hours > UNREPLIED_HOURS) {
      findings.push(
        makeFinding({
          line: "reputation",
          severity: hours > UNREPLIED_HOURS_P0 ? "P0" : "P1",
          hotelId: r.hotelId,
          title: `${r.rating} 分差评 ${Math.floor(hours)}h 未回复（${hotelById.get(r.hotelId)?.hotelName ?? r.hotelId}）`,
          description: `差评发布于 ${r.createdAt}，已超 24h 响应红线（R19 SLA）${hours > UNREPLIED_HOURS_P0 ? "且超 72h，舆情发酵风险高" : ""}。差评响应慢占酒店流失 20%。`,
          suggestion: "立即按 SOP 回复（致歉→核实→措施→承诺），不承诺档案外补偿；托管后由 review-crisis 接管处置。",
          evidence: [{ kind: "review", id: r.reviewId, fields: { rating: r.rating, hoursUnreplied: Math.floor(hours), ...(r.channel ? { channel: r.channel } : {}) } }],
          calculation: {
            formula: "rating ≤ 3 且 未回复 且 now − createdAt > 24h",
            inputs: { reviewId: r.reviewId, rating: r.rating, hoursUnreplied: round2(hours) },
            result: `${Math.floor(hours)}h > 24h`,
          },
        }),
      );
    }
  }

  /* ---------- 子项 2：评分 <4.2 且近30天下滑 >0.3 ---------- */
  for (const h of snapshot.hotels) {
    if (h.rating === undefined || h.ratingDelta30d === undefined) continue;
    if (h.rating < LOW_RATING && h.ratingDelta30d < -RATING_DROP_REDLINE) {
      findings.push(
        makeFinding({
          line: "reputation",
          severity: "P1",
          hotelId: h.hotelId,
          title: `评分 ${round2(h.rating)} 且近30天下滑 ${round2(-h.ratingDelta30d)}（双红线）`,
          description: `当前评分 ${round2(h.rating)} < ${LOW_RATING}，且近 30 天下滑 ${round2(-h.ratingDelta30d)} > ${RATING_DROP_REDLINE}——存量口碑与趋势同时恶化，OTA 流量权重将持续走低。`,
          suggestion: "按差评关键词聚集清单定位根因（见同报告聚集项）；优先整改高频问题房型并回捞近 30 天差评客人。",
          evidence: [{ kind: "hotel", id: h.hotelId, fields: { rating: h.rating, ratingDelta30d: h.ratingDelta30d } }],
          calculation: {
            formula: "rating < 4.2 且 ratingDelta30d < −0.3",
            inputs: { hotelId: h.hotelId, rating: h.rating, ratingDelta30d: h.ratingDelta30d },
            result: `${round2(h.rating)} / ${round2(h.ratingDelta30d)}`,
          },
        }),
      );
    }
  }

  /* ---------- 子项 3：差评关键词聚集（近30天同关键词 ≥3 条） ---------- */
  const clusters = new Map<string, { hotelId: string; keyword: string; ids: string[] }>();
  for (const r of snapshot.reviews) {
    if (r.rating > BAD_RATING_MAX || !r.content) continue;
    if (Date.parse(r.createdAt) < windowStart(ctx.now, CLUSTER_DAYS)) continue;
    for (const kw of BAD_KEYWORDS) {
      if (!r.content.includes(kw)) continue;
      const key = `${r.hotelId}::${kw}`;
      const e = clusters.get(key) ?? { hotelId: r.hotelId, keyword: kw, ids: [] };
      e.ids.push(r.reviewId);
      clusters.set(key, e);
    }
  }
  for (const c of clusters.values()) {
    if (c.ids.length < CLUSTER_MIN_BAD) continue;
    findings.push(
      makeFinding({
        line: "reputation",
        severity: c.keyword === "安全" ? "P0" : "P1",
        hotelId: c.hotelId,
        title: `差评关键词聚集：「${c.keyword}」近30天 ${c.ids.length} 条差评`,
        description: `近 ${CLUSTER_DAYS} 天含「${c.keyword}」的差评 ${c.ids.length} 条 ≥ ${CLUSTER_MIN_BAD} 条，同一问题正在重复伤害客人体验${c.keyword === "安全" ? "——安全类聚集为最高优先处置项" : ""}。`,
        suggestion: `按关键词回溯工单与问题房记录定位根因（如「隔音」查楼层/窗型、「热水」查锅炉与末端水温）；整改后用好评资产对冲搜索结果。`,
        evidence: c.ids.map((id) => ({ kind: "review", id, fields: { keyword: c.keyword } })),
        calculation: {
          formula: `近${CLUSTER_DAYS}天差评（≤3分）content 含同关键词条数 ≥ ${CLUSTER_MIN_BAD}`,
          inputs: { keyword: c.keyword, count: c.ids.length, windowDays: CLUSTER_DAYS },
          result: `${c.ids.length} ≥ ${CLUSTER_MIN_BAD}`,
        },
      }),
    );
  }

  return findings;
}
