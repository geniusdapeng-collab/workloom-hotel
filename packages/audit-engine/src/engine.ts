/**
 * 引擎编排：runFastScan（酒店版）
 * 纪律（fast-scan SKILL.md 四）：
 *  - 时间纪律：软预算默认 30 分钟，逐线检查耗时，超时后剩余线标注 not-covered 出部分报告；
 *  - 降级纪律：某数据源缺失 → 该线标注 not-covered / partial，不阻塞整体；
 *  - 估算透明：所有 Finding 金额必须带 confidence 与计算口径（分析器层已强制）。
 * 输出：一店一份 + 集团总览 + 按年化挽回金额降序 Top10。
 */
import { analyzeChannel } from "./analyzers/channel.js";
import { analyzeInventory } from "./analyzers/inventory.js";
import { analyzePrice } from "./analyzers/price.js";
import { analyzeReputation } from "./analyzers/reputation.js";
import { analyzeSafety } from "./analyzers/safety.js";
import type { AnalyzerContext } from "./analyzers/util.js";
import type {
  AuditLine,
  AuditReport,
  AuditSnapshot,
  FastScanOptions,
  Finding,
  HotelReport,
  ImpactPeriod,
  LineCoverage,
  Severity,
} from "./types.js";

/** 线的执行顺序（对齐 SKILL.md 步骤 2→6） */
const LINE_ORDER: readonly AuditLine[] = ["price", "inventory", "channel", "reputation", "safety"];

const ANALYZERS: Record<AuditLine, (s: AuditSnapshot, ctx: AnalyzerContext) => Finding[]> = {
  price: analyzePrice,
  inventory: analyzeInventory,
  channel: analyzeChannel,
  reputation: analyzeReputation,
  safety: analyzeSafety,
};

/** 默认保底价（R2 口径 ¥380；一店一档缺失时回退并标注） */
export const DEFAULT_FLOOR_PRICE = 380;

/**
 * 数据源覆盖度预判：某线所需数据集全空 → not-covered；关键子集缺失 → partial。
 */
function precheckLine(line: AuditLine, s: AuditSnapshot): { coverage: LineCoverage; note?: string } {
  switch (line) {
    case "price": {
      if (s.channelPrices.length === 0) return { coverage: "not-covered", note: "房价日历源缺失，价格健康线未覆盖" };
      if (s.hotels.every((h) => h.floorPrice === undefined))
        return { coverage: "partial", note: `一店一档保底价未采集，按默认 ¥${DEFAULT_FLOOR_PRICE} 判定（破防子项估算口径）` };
      if (s.holidays.length === 0) return { coverage: "partial", note: "节假日期历缺失，远期日历异常子项降级" };
      return { coverage: "covered" };
    }
    case "inventory": {
      if (s.roomDays.length === 0) return { coverage: "not-covered", note: "房态源缺失，房态库存健康线未覆盖" };
      if (s.roomDays.every((r) => r.maintenanceRooms === undefined)) return { coverage: "partial", note: "问题房字段未采集，问题房占比/漏售维修判定子项降级" };
      return { coverage: "covered" };
    }
    case "channel": {
      if (s.channelBills.length === 0 && s.orders.length === 0) return { coverage: "not-covered", note: "渠道账单与订单源均缺失，渠道健康线未覆盖" };
      if (s.channelBills.length === 0) return { coverage: "partial", note: "渠道账单缺失，佣金勾稽子项降级" };
      if (s.orders.length === 0) return { coverage: "partial", note: "订单源缺失，渠道依赖度子项降级" };
      if (s.hotels.every((h) => h.channels.every((c) => c.commissionRate === undefined)))
        return { coverage: "partial", note: "渠道佣金协议比例缺失，佣金勾稽子项降级" };
      return { coverage: "covered" };
    }
    case "reputation": {
      if (s.reviews.length === 0) return { coverage: "not-covered", note: "评价源缺失，口碑健康线未覆盖" };
      if (s.hotels.every((h) => h.rating === undefined || h.ratingDelta30d === undefined))
        return { coverage: "partial", note: "门店评分/评分趋势未采集，评分下滑子项降级" };
      return { coverage: "covered" };
    }
    case "safety": {
      if (s.orders.length === 0 && s.breakpoints.length === 0) return { coverage: "not-covered", note: "订单与断点源均缺失，安全与断点线未覆盖" };
      if (s.orders.every((o) => o.guarantee === undefined)) return { coverage: "partial", note: "担保标记未采集，担保异常子项降级" };
      if (s.breakpoints.length === 0) return { coverage: "partial", note: "断点记录缺失，断点高频子项降级" };
      return { coverage: "covered" };
    }
  }
}

/** 严重度计数器 */
function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { P0: 0, P1: 0, P2: 0 };
  for (const f of findings) c[f.severity] += 1;
  return c;
}

/** 年化折算系数（Top10 按年化挽回金额排序：monthly ×12，one-off/yearly 原值） */
const ANNUALIZE: Record<ImpactPeriod, number> = { "one-off": 1, monthly: 12, yearly: 1 };

function annualized(f: Finding): number {
  const i = f.estimatedImpact;
  return i ? i.amount * ANNUALIZE[i.period] : 0;
}

/**
 * 快速体检主入口：快照 → 五线 → 报告。
 * 纯函数（除耗时计量）：同一快照 + 同一 now 必得同一报告正文。
 */
export function runFastScan(snapshot: AuditSnapshot, opts: FastScanOptions = {}): AuditReport {
  const startedAt = Date.now();
  const budgetMs = (opts.timeBudgetMinutes ?? 30) * 60_000;
  const ctx: AnalyzerContext = {
    now: opts.now ?? new Date(snapshot.generatedAt),
    floorPriceDefault: opts.floorPriceDefault ?? DEFAULT_FLOOR_PRICE,
  };

  const coverage = {} as Record<AuditLine, LineCoverage>;
  const coverageNotes: string[] = [];
  const allFindings: Finding[] = [];

  for (const line of LINE_ORDER) {
    // 时间纪律：逐线检查软预算，超时后剩余线 not-covered（部分报告仍是有效交付）
    if (Date.now() - startedAt >= budgetMs) {
      coverage[line] = "not-covered";
      coverageNotes.push(`时间预算耗尽（${opts.timeBudgetMinutes ?? 30} 分钟），${line} 线未执行`);
      continue;
    }
    const pre = precheckLine(line, snapshot);
    coverage[line] = pre.coverage;
    if (pre.note) coverageNotes.push(pre.note);
    if (pre.coverage === "not-covered") continue;
    const findings = ANALYZERS[line](snapshot, ctx);
    // 统一编号：FND-<LINE>-<全局序号>（报告可回溯）
    for (const f of findings) {
      f.id = `FND-${line.toUpperCase()}-${String(allFindings.length + 1).padStart(3, "0")}`;
      allFindings.push(f);
    }
  }

  /* ---------- 一店一份 ---------- */
  const byHotel = new Map<string, Finding[]>();
  for (const f of allFindings) {
    const arr = byHotel.get(f.hotelId) ?? [];
    arr.push(f);
    byHotel.set(f.hotelId, arr);
  }
  const severityRank: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };
  const hotels: HotelReport[] = snapshot.hotels.map((h) => {
    const findings = (byHotel.get(h.hotelId) ?? []).sort(
      (a, b) => severityRank[a.severity] - severityRank[b.severity] || annualized(b) - annualized(a),
    );
    return {
      hotelId: h.hotelId,
      hotelName: h.hotelName,
      currency: h.currency,
      findings,
      counts: countBySeverity(findings),
      // 同店同币种，直接求和；无金额的发现不计入
      totalRecoverable: round2(findings.reduce((sum, f) => sum + (f.estimatedImpact?.amount ?? 0), 0)),
    };
  });
  // 有发现但门店不在快照 hotels 里的兜底桶（防御性；正常快照不会触发）
  for (const [hotelId, findings] of byHotel) {
    if (hotels.some((h) => h.hotelId === hotelId)) continue;
    hotels.push({
      hotelId,
      hotelName: hotelId,
      currency: findings[0]?.estimatedImpact?.currency ?? "CNY",
      findings,
      counts: countBySeverity(findings),
      totalRecoverable: round2(findings.reduce((sum, f) => sum + (f.estimatedImpact?.amount ?? 0), 0)),
    });
  }

  /* ---------- 集团总览 + Top10（年化口径） ---------- */
  const totalByCurrency: Record<string, number> = {};
  for (const f of allFindings) {
    if (!f.estimatedImpact) continue;
    const cur = f.estimatedImpact.currency;
    totalByCurrency[cur] = round2((totalByCurrency[cur] ?? 0) + f.estimatedImpact.amount);
  }
  const top10 = [...allFindings]
    .filter((f) => f.estimatedImpact)
    .sort((a, b) => annualized(b) - annualized(a))
    .slice(0, 10);

  return {
    reportId: `RPT-${snapshot.snapshotId}`,
    generatedAt: ctx.now.toISOString(),
    snapshotId: snapshot.snapshotId,
    coverage,
    coverageNotes,
    hotels,
    overview: {
      hotelCount: snapshot.hotels.length,
      findingCount: allFindings.length,
      counts: countBySeverity(allFindings),
      totalRecoverableByCurrency: totalByCurrency,
    },
    top10,
    elapsedMs: Date.now() - startedAt,
    timeBudgetMinutes: opts.timeBudgetMinutes ?? 30,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
