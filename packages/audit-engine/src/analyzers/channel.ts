/**
 * 渠道健康线（fast-scan SKILL.md 步骤 4）
 * 三个子项：
 *  1) 佣金错算：|实提比例 − 应提比例| > 0.5pp（逐笔勾稽，exact）
 *  2) 订单与账单勾稽差异：账单订单行金额 ≠ PMS 订单金额（P1）；账单订单行无法匹配 PMS 订单（P2）
 *  3) 单渠道依赖度 >60%（按近 90 天有效订单间夜占比；>80% 升 P0）
 * 降级纪律：渠道缺 commissionRate → 子项 1 该渠道跳过（engine 据此标 partial）。
 */
import type { AuditSnapshot, Finding } from "../types.js";
import { makeFinding, round2, round4, type AnalyzerContext } from "./util.js";

/** 佣金错算阈值：0.5 个百分点（任务规格） */
export const COMMISSION_TOLERANCE_PP = 0.005;
/** 佣金错算金额升 P1 阈值（元） */
export const COMMISSION_DIFF_P1_AMOUNT = 500;
/** 单渠道依赖度红线（任务规格：>60%） */
export const CHANNEL_DEPENDENCE_REDLINE = 0.6;
/** 依赖度升 P0 阈值 */
export const CHANNEL_DEPENDENCE_P0 = 0.8;

export function analyzeChannel(snapshot: AuditSnapshot, ctx: AnalyzerContext): Finding[] {
  void ctx;
  const findings: Finding[] = [];
  const hotelById = new Map(snapshot.hotels.map((h) => [h.hotelId, h]));
  const orderById = new Map(snapshot.orders.map((o) => [`${o.hotelId}::${o.orderId}`, o]));

  /* ---------- 子项 1+2：账单逐笔勾稽 ---------- */
  for (const bill of snapshot.channelBills) {
    const hotel = hotelById.get(bill.hotelId);
    const rate = hotel?.channels.find((c) => c.channel === bill.channel)?.commissionRate;

    // 子项 1：佣金错算
    if (rate !== undefined) {
      for (const line of bill.lines) {
        if (line.type !== "commission") continue;
        const order = orderById.get(`${bill.hotelId}::${line.refId}`);
        if (!order || order.amount <= 0) continue; // 订单不在快照窗口 → 无法勾稽，跳过
        const expected = order.amount * rate;
        const actual = Math.abs(line.amount);
        const diff = actual - expected;
        const pp = diff / order.amount;
        if (Math.abs(pp) > COMMISSION_TOLERANCE_PP) {
          findings.push(
            makeFinding({
              line: "channel",
              severity: Math.abs(diff) > COMMISSION_DIFF_P1_AMOUNT ? "P1" : "P2",
              hotelId: bill.hotelId,
              title: `账单 ${bill.billId} 佣金错算：订单 ${line.refId} ${diff > 0 ? "多提" : "少提"} ${(round4(Math.abs(pp) * 100)).toFixed(2)}pp`,
              description: `订单金额 ${order.amount} ${line.currency}，应提 ${(rate * 100).toFixed(1)}% = ${round2(expected)}，实提 ${round2(actual)}，差异 ${round2(diff)}（${(round4(pp * 100)).toFixed(2)}pp > 0.5pp 容差）。`,
              suggestion: "向 OTA 发起账单申诉追回差额；核对佣金协议档位是否被单方面调整（费率用错档）。",
              evidence: [
                { kind: "bill-line", id: line.lineId, fields: { refId: line.refId, actual: round2(actual), expected: round2(expected) } },
                { kind: "order", id: line.refId, fields: { amount: order.amount, channel: order.channel } },
              ],
              calculation: {
                formula: "差异pp = (实提佣金 − 订单金额 × 应提比例) / 订单金额；|差异| > 0.5pp 告警",
                inputs: { orderId: line.refId, orderAmount: order.amount, commissionRate: rate, expected: round2(expected), actual: round2(actual) },
                result: `${(round4(pp * 100)).toFixed(2)}pp`,
              },
              estimatedImpact: {
                amount: round2(Math.abs(diff)),
                currency: line.currency,
                period: "one-off",
                confidence: "exact",
                basis: "逐笔勾稽差值（账单行 vs 订单 × 协议比例）",
              },
            }),
          );
        }
      }
    }

    // 子项 2：订单与账单勾稽差异
    for (const line of bill.lines) {
      if (line.type !== "order") continue;
      const order = orderById.get(`${bill.hotelId}::${line.refId}`);
      if (!order) {
        findings.push(
          makeFinding({
            line: "channel",
            severity: "P2",
            hotelId: bill.hotelId,
            title: `账单 ${bill.billId} 订单行无法勾稽：${line.refId}`,
            description: `账单 ${bill.period} 订单行 ${line.refId}（${line.amount} ${line.currency}）在 PMS 近 90 天订单中无对应单据，疑似渠道虚增流水或快照窗口外订单。`,
            suggestion: "导出该渠道完整流水逐笔比对；确认非窗口外订单后向 OTA 发起差异申诉。",
            evidence: [{ kind: "bill-line", id: line.lineId, fields: { refId: line.refId, amount: line.amount } }],
            calculation: {
              formula: "账单订单行 refId ∉ PMS 订单集合",
              inputs: { billId: bill.billId, refId: line.refId, amount: line.amount },
              result: "无匹配订单",
            },
          }),
        );
        continue;
      }
      const diff = Math.abs(line.amount) - order.amount;
      if (Math.abs(diff) > 0.01) {
        findings.push(
          makeFinding({
            line: "channel",
            severity: "P1",
            hotelId: bill.hotelId,
            title: `账单 ${bill.billId} 订单金额勾稽差异：${line.refId} 差 ${round2(diff)}`,
            description: `PMS 订单金额 ${order.amount} ${order.currency}，账单流水 ${round2(Math.abs(line.amount))}，差异 ${round2(diff)}——佣金计提基数随之失真。`,
            suggestion: "核对是否存在退款未冲抵/no-show 担保未结算；向 OTA 提交差异明细要求更正账单。",
            evidence: [
              { kind: "bill-line", id: line.lineId, fields: { refId: line.refId, billAmount: round2(Math.abs(line.amount)) } },
              { kind: "order", id: line.refId, fields: { amount: order.amount, status: order.status } },
            ],
            calculation: {
              formula: "账单订单行金额 − PMS 订单金额；|差异| > 0.01 告警",
              inputs: { orderId: line.refId, pmsAmount: order.amount, billAmount: round2(Math.abs(line.amount)) },
              result: round2(diff),
            },
            estimatedImpact: {
              amount: round2(Math.abs(diff)),
              currency: order.currency,
              period: "one-off",
              confidence: "baseline",
              basis: "账单与 PMS 订单金额差值（待渠道流水确认后转 exact）",
            },
          }),
        );
      }
    }
  }

  /* ---------- 子项 3：单渠道依赖度 >60% ---------- */
  const live = snapshot.orders.filter((o) => o.status === "confirmed" || o.status === "completed");
  const byHotel = new Map<string, typeof live>();
  for (const o of live) {
    const arr = byHotel.get(o.hotelId) ?? [];
    arr.push(o);
    byHotel.set(o.hotelId, arr);
  }
  for (const [hotelId, orders] of byHotel) {
    const totalNights = orders.reduce((s, o) => s + o.nights, 0);
    if (totalNights <= 0) continue;
    const byChannel = new Map<string, { nights: number; amount: number; currency: string }>();
    for (const o of orders) {
      const e = byChannel.get(o.channel) ?? { nights: 0, amount: 0, currency: o.currency };
      e.nights += o.nights;
      e.amount += o.amount;
      byChannel.set(o.channel, e);
    }
    for (const [channel, e] of byChannel) {
      const share = e.nights / totalNights;
      if (share > CHANNEL_DEPENDENCE_REDLINE) {
        const monthlyRevenue = e.amount / 3; // 快照窗口近 90 天 → 月均
        findings.push(
          makeFinding({
            line: "channel",
            severity: share > CHANNEL_DEPENDENCE_P0 ? "P0" : "P1",
            hotelId,
            title: `单渠道依赖度 ${(share * 100).toFixed(1)}%：${channel} 占近90天间夜 ${e.nights}/${totalNights}`,
            description: `${channel} 贡献 ${(share * 100).toFixed(1)}% 间夜（>60% 红线）。渠道一旦限流/涨佣/封号，门店营收无缓冲垫。`,
            suggestion: "制定直销（自有会员/企业协议）与其他 OTA 的分流计划，目标 90 天内将单一渠道占比压至 60% 以下。",
            evidence: [{ kind: "hotel", id: hotelId, fields: { channel, nights: e.nights, totalNights, share: round2(share * 100) + "%" } }],
            calculation: {
              formula: "渠道间夜 / 全渠道有效间夜（近90天，confirmed+completed）",
              inputs: { channel, channelNights: e.nights, totalNights, windowDays: 90 },
              result: `${(round4(share * 100)).toFixed(1)}%`,
            },
            estimatedImpact: {
              amount: round2(monthlyRevenue * 0.3),
              currency: e.currency,
              period: "one-off",
              confidence: "estimate",
              basis: `经验估计：若该渠道断供一个月，按其月均贡献 ${round2(monthlyRevenue)} × 30% 不可恢复比例估算敞口`,
            },
          }),
        );
      }
    }
  }

  return findings;
}
