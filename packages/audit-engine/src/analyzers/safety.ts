/**
 * 安全与断点线（fast-scan SKILL.md 步骤 6）
 * 两个子项：
 *  1) 担保订单异常（R5 同源）：
 *     a. no-show 且担保未结算 → P0（钱货两空，最高优先）
 *     b. 担保未预授权/未收押金 → P1（敞口=首晚房费）
 *     c. 预授权不足首晚房费 → P1；预授权超订单额 1.5× → P2（客人投诉风险）
 *  2) 断点高频项：同类断点 7 天 ≥2 次（≥4 次升 P0）。断点是资产——每条发现附根因闭环建议，
 *     已沉淀根因的引用根因，未沉淀的要求补录（无人酒店断点档案纪律）。
 */
import type { AuditSnapshot, BreakpointRecord, Finding } from "../types.js";
import { makeFinding, round2, windowStart, type AnalyzerContext } from "./util.js";

/** 断点高频口径：7 天窗口 ≥2 次 */
export const BREAKPOINT_WINDOW_DAYS = 7;
export const BREAKPOINT_MIN_COUNT = 2;
/** 升 P0 阈值：7 天 ≥4 次 */
export const BREAKPOINT_P0_COUNT = 4;
/** 预授权超额判定：> 订单总额 ×1.5 */
export const PREAUTH_OVER_RATIO = 1.5;

/** 断点类别 → 根因闭环建议（断点资产库的种子条目） */
const BREAKPOINT_PLAYBOOK: Record<string, string> = {
  "ota-sync-failed": "闭环建议：核对渠道直连凭证有效期与回调地址；加同步失败自动重试+失败自动下架（R18）；根因沉淀到断点档案后周会复核复发率。",
  "pms-callback-timeout": "闭环建议：排查 PMS 网关超时峰值（多在夜审/早交班窗口）；加超时告警与降级队列；根因沉淀到断点档案。",
  "door-lock-offline": "闭环建议：检查门锁网关供电与弱电井网络；离线超 10 分钟自动派工程工单；安全禁区纪律（R10）——只告警联动，绝不远程开门。",
  "payment-callback-timeout": "闭环建议：核对支付通道证书与回调重放日志；超时单自动对账兜底，避免重复收款/漏收款。",
  "self-service-kiosk-fault": "闭环建议：盘点自助机故障部件（发卡器/身份证阅读器为高频件）；备件前置到店，故障自动转人工兜底流程。",
};
const BREAKPOINT_PLAYBOOK_DEFAULT = "闭环建议：补录根因到断点档案（断点是资产）；评估是否需加自动重试/告警/降级流程，周会复核同类断点复发率。";

export function analyzeSafety(snapshot: AuditSnapshot, ctx: AnalyzerContext): Finding[] {
  const findings: Finding[] = [];
  const hotelById = new Map(snapshot.hotels.map((h) => [h.hotelId, h]));

  /* ---------- 子项 1：担保订单异常 ---------- */
  for (const o of snapshot.orders) {
    if (!o.guarantee) continue;
    const g = o.guarantee;
    const firstNight = o.nights > 0 ? round2(o.amount / o.nights) : o.amount;

    // a. no-show 且担保未结算 → P0
    if (o.status === "no-show" && g.settled !== true) {
      findings.push(
        makeFinding({
          line: "safety",
          severity: "P0",
          hotelId: o.hotelId,
          title: `no-show 担保未结算：订单 ${o.orderId}（敞口 ${o.amount} ${o.currency}）`,
          description: `订单 ${o.orderId} 客人 no-show，担保${g.preauthorized === true ? "已预授权" : "未预授权"}但未结算——房晚已空耗且担保款未划扣，钱货两空（R5 担保异常介入口径）。`,
          suggestion: "立即向支付通道/OTA 发起担保结算申诉；核对 no-show 判定与结算流水，逾期走平台仲裁。",
          evidence: [{ kind: "order", id: o.orderId, fields: { status: o.status, amount: o.amount, preauthorized: g.preauthorized === true ? "yes" : "no" } }],
          calculation: {
            formula: "status = no-show 且 guarantee.settled ≠ true",
            inputs: { orderId: o.orderId, amount: o.amount, nights: o.nights },
            result: "未结算",
          },
          estimatedImpact: {
            amount: o.amount,
            currency: o.currency,
            period: "one-off",
            confidence: "baseline",
            basis: "按订单全额估算担保结算追回敞口（实际划扣比例待通道确认后转 exact）",
          },
        }),
      );
      continue;
    }

    // 只对在住/将入住订单判预授权异常（已完成/已取消/已退款单不再追）
    if (o.status !== "confirmed") continue;

    // b. 担保未预授权 → P1
    if (g.preauthorized !== true) {
      findings.push(
        makeFinding({
          line: "safety",
          severity: "P1",
          hotelId: o.hotelId,
          title: `担保订单未预授权：${o.orderId}（敞口首晚 ${firstNight} ${o.currency}）`,
          description: `订单 ${o.orderId} 标记为${g.type === "deposit" ? "押金" : "信用卡"}担保，但未做预授权/未收押金——客人 no-show 时无兜底（R5 担保异常介入口径）。`,
          suggestion: "入住前补做预授权或收押金；渠道担保单核对 OTA 担保结算条款，避免假担保。",
          evidence: [{ kind: "order", id: o.orderId, fields: { checkIn: o.checkIn, amount: o.amount, guaranteeType: g.type } }],
          calculation: {
            formula: "guarantee 存在 且 preauthorized ≠ true 且 status = confirmed",
            inputs: { orderId: o.orderId, firstNight, nights: o.nights },
            result: "未预授权",
          },
          estimatedImpact: {
            amount: firstNight,
            currency: o.currency,
            period: "one-off",
            confidence: "baseline",
            basis: `按首晚房费 ${firstNight} 估算 no-show 敞口（订单额 ${o.amount} / ${o.nights} 间夜）`,
          },
        }),
      );
      continue;
    }

    // c. 预授权金额异常
    if (g.preauthAmount !== undefined) {
      if (g.preauthAmount < firstNight) {
        findings.push(
          makeFinding({
            line: "safety",
            severity: "P1",
            hotelId: o.hotelId,
            title: `担保预授权不足：${o.orderId}（${g.preauthAmount} < 首晚 ${firstNight}）`,
            description: `预授权 ${g.preauthAmount} ${o.currency} 不足首晚房费 ${firstNight}，no-show 时无法足额划扣。`,
            suggestion: "补做差额预授权；将预授权不足校验纳入接单 SOP。",
            evidence: [{ kind: "order", id: o.orderId, fields: { preauthAmount: g.preauthAmount, firstNight } }],
            calculation: {
              formula: "preauthAmount < 订单额 / 间夜数（首晚房费）",
              inputs: { orderId: o.orderId, preauthAmount: g.preauthAmount, firstNight },
              result: `${g.preauthAmount} < ${firstNight}`,
            },
            estimatedImpact: {
              amount: round2(firstNight - g.preauthAmount),
              currency: o.currency,
              period: "one-off",
              confidence: "baseline",
              basis: "首晚房费 − 已预授权金额（no-show 敞口差额）",
            },
          }),
        );
      } else if (g.preauthAmount > o.amount * PREAUTH_OVER_RATIO) {
        findings.push(
          makeFinding({
            line: "safety",
            severity: "P2",
            hotelId: o.hotelId,
            title: `担保预授权超额：${o.orderId}（${g.preauthAmount} > 订单额 ×${PREAUTH_OVER_RATIO}）`,
            description: `预授权 ${g.preauthAmount} ${o.currency} 超订单总额 ${o.amount} 的 ${PREAUTH_OVER_RATIO} 倍，占用客人额度易引发投诉与拒付。`,
            suggestion: "释放超额预授权至合理水位（建议首晚房费 1–1.5×）；核对是否为夜班手工误操作。",
            evidence: [{ kind: "order", id: o.orderId, fields: { preauthAmount: g.preauthAmount, amount: o.amount } }],
            calculation: {
              formula: `preauthAmount > 订单额 × ${PREAUTH_OVER_RATIO}`,
              inputs: { orderId: o.orderId, preauthAmount: g.preauthAmount, amount: o.amount },
              result: `${g.preauthAmount} > ${round2(o.amount * PREAUTH_OVER_RATIO)}`,
            },
          }),
        );
      }
    }
  }

  /* ---------- 子项 2：断点高频项（同类 7 天 ≥2 次） ---------- */
  const groups = new Map<string, { hotelId: string; category: string; items: BreakpointRecord[] }>();
  for (const b of snapshot.breakpoints) {
    if (Date.parse(b.occurredAt) < windowStart(ctx.now, BREAKPOINT_WINDOW_DAYS)) continue;
    const key = `${b.hotelId}::${b.category}`;
    const e = groups.get(key) ?? { hotelId: b.hotelId, category: b.category, items: [] };
    e.items.push(b);
    groups.set(key, e);
  }
  for (const g of groups.values()) {
    if (g.items.length < BREAKPOINT_MIN_COUNT) continue;
    g.items.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const withRootCause = g.items.filter((b) => b.rootCause);
    const hotel = hotelById.get(g.hotelId);
    findings.push(
      makeFinding({
        line: "safety",
        severity: g.items.length >= BREAKPOINT_P0_COUNT ? "P0" : "P1",
        hotelId: g.hotelId,
        title: `断点高频：「${g.category}」7 天 ${g.items.length} 次（${hotel?.hotelName ?? g.hotelId}）`,
        description: `同类断点 ${BREAKPOINT_WINDOW_DAYS} 天内发生 ${g.items.length} 次（${g.items[0]!.occurredAt.slice(0, 10)} 起）。${
          withRootCause.length > 0
            ? `已沉淀根因 ${withRootCause.length}/${g.items.length} 条（最近：${withRootCause[withRootCause.length - 1]!.rootCause}），但复发说明闭环未生效。`
            : "尚无根因沉淀——断点是资产，必须先补录根因再谈闭环。"
        }`,
        suggestion: BREAKPOINT_PLAYBOOK[g.category] ?? BREAKPOINT_PLAYBOOK_DEFAULT,
        evidence: g.items.map((b) => ({ kind: "breakpoint", id: b.breakpointId, fields: { occurredAt: b.occurredAt, resolved: b.resolvedAt ? "yes" : "no" } })),
        calculation: {
          formula: `同类断点 ${BREAKPOINT_WINDOW_DAYS} 天窗口内次数 ≥ ${BREAKPOINT_MIN_COUNT}`,
          inputs: { category: g.category, count7d: g.items.length, windowDays: BREAKPOINT_WINDOW_DAYS, rootCauseCoverage: `${withRootCause.length}/${g.items.length}` },
          result: `${g.items.length} ≥ ${BREAKPOINT_MIN_COUNT}`,
        },
      }),
    );
  }

  return findings;
}
