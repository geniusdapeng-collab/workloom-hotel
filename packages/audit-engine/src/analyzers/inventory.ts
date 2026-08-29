/**
 * 房态库存健康线（fast-scan SKILL.md 步骤 3）
 * 四个子项：
 *  1) 超售：PMS 已售 > 实盘总房量，或渠道可售为负（R18 熔断口径 → P0）
 *  2) 漏售：渠道关房但 PMS 仍有可售净房（扣问题房）且无维修占用 → 有房未上架
 *  3) 问题房占比 >10%（维修中/锁房间数 / 实盘总房量，同房型同日）
 *  4) 连住日期房态断档：渠道在相邻两个可售日之间关房且无维修占用（连住客人订不进）
 * 降级纪律：maintenanceRooms 全未采集 → 子项 2/3/4 的维修判定降级（engine 标 partial）。
 */
import type { AuditSnapshot, Finding } from "../types.js";
import { makeFinding, round2, shiftDate, type AnalyzerContext } from "./util.js";

/** 问题房占比红线（任务规格：>10%） */
export const MAINTENANCE_RATIO_REDLINE = 0.1;

/** 近 30 天该房型平均成交价（漏售损失估算口径；无订单则回退渠道挂牌中位价，再无则不估值） */
function avgDealPrice30d(snapshot: AuditSnapshot, ctx: AnalyzerContext, hotelId: string, roomTypeId: string): number | undefined {
  const deals = snapshot.orders.filter(
    (o) =>
      o.hotelId === hotelId &&
      o.roomTypeId === roomTypeId &&
      o.nights > 0 &&
      (o.status === "confirmed" || o.status === "completed") &&
      ctx.now.getTime() - Date.parse(o.createdAt) <= 30 * 86_400_000,
  );
  if (deals.length > 0) {
    return round2(deals.reduce((s, o) => s + o.amount / o.nights, 0) / deals.length);
  }
  const listed = snapshot.channelPrices.filter((p) => p.hotelId === hotelId && p.roomTypeId === roomTypeId).map((p) => p.price);
  if (listed.length > 0) return round2(listed.reduce((s, x) => s + x, 0) / listed.length);
  return undefined;
}

export function analyzeInventory(snapshot: AuditSnapshot, ctx: AnalyzerContext): Finding[] {
  void ctx;
  const findings: Finding[] = [];
  const hotelById = new Map(snapshot.hotels.map((h) => [h.hotelId, h]));

  /* ---------- 子项 1：超售 ---------- */
  // PMS 口径超售：sold > totalRooms（同房型同日去重，跨渠道行 PMS 字段一致）
  const pmsSeen = new Set<string>();
  for (const r of snapshot.roomDays) {
    const key = `${r.hotelId}::${r.roomTypeId}::${r.date}`;
    if (pmsSeen.has(key)) continue;
    pmsSeen.add(key);
    if (r.sold > r.totalRooms) {
      const oversold = r.sold - r.totalRooms;
      const price = avgDealPrice30d(snapshot, ctx, r.hotelId, r.roomTypeId);
      findings.push(
        makeFinding({
          line: "inventory",
          severity: "P0",
          hotelId: r.hotelId,
          title: `${r.roomTypeId} ${r.date} 超售 ${oversold} 间（已售 ${r.sold} > 实盘 ${r.totalRooms}）`,
          description: `${hotelById.get(r.hotelId)?.hotelName ?? r.hotelId} 该房型当日已售 ${r.sold} 间超过实盘 ${r.totalRooms} 间，命中 R18 超售熔断口径，到店无房将引发赔付与差评。`,
          suggestion: "立即关停各渠道该日房态并逐单排查超卖来源（渠道直连延迟/手工开房）；已超卖订单按 SOP 提前外送安置。",
          evidence: [{ kind: "room-day", id: key, fields: { totalRooms: r.totalRooms, sold: r.sold, oversold } }],
          calculation: {
            formula: "PMS 已售 > 实盘总房量 → 超售",
            inputs: { roomTypeId: r.roomTypeId, date: r.date, totalRooms: r.totalRooms, sold: r.sold },
            result: `${r.sold} > ${r.totalRooms}`,
          },
          ...(price !== undefined
            ? {
                estimatedImpact: {
                  amount: round2(oversold * price),
                  currency: snapshot.hotels.find((h) => h.hotelId === r.hotelId)?.currency ?? "CNY",
                  period: "one-off" as const,
                  confidence: "estimate" as const,
                  basis: `超卖 ${oversold} 间 × 近30天均房价 ${price}（按外送安置/赔付一间一晚经验估算）`,
                },
              }
            : {}),
        }),
      );
    }
  }
  // 渠道口径超售：渠道可售为负
  for (const r of snapshot.roomDays) {
    if (r.available < 0) {
      const key = `${r.hotelId}::${r.roomTypeId}::${r.date}::${r.channel}`;
      findings.push(
        makeFinding({
          line: "inventory",
          severity: "P0",
          hotelId: r.hotelId,
          title: `${r.roomTypeId} ${r.date} ${r.channel} 渠道可售为负（${r.available}）`,
          description: `${r.channel} 渠道可售 ${r.available} 间，已实质超卖，命中 R18 超售熔断口径。`,
          suggestion: "立即熔断该渠道当日房态并核对同步流水；排查库存同步失败记录。",
          evidence: [{ kind: "room-day", id: key, fields: { channel: r.channel, available: r.available } }],
          calculation: {
            formula: "渠道可售 < 0 → 超售",
            inputs: { roomTypeId: r.roomTypeId, date: r.date, channel: r.channel, available: r.available },
            result: `${r.available} < 0`,
          },
        }),
      );
    }
  }

  /* ---------- 子项 2：漏售（关房未售且无维修记录） ---------- */
  const missed = new Map<string, { dates: string[]; unsoldTotal: number; roomTypeId: string; channel: string; hotelId: string }>();
  for (const r of snapshot.roomDays) {
    if (!r.closed) continue;
    const netSellable = r.totalRooms - r.sold - (r.maintenanceRooms ?? 0);
    if (netSellable <= 0) continue; // 满房或全是问题房：关房合理
    const key = `${r.hotelId}::${r.roomTypeId}::${r.channel}`;
    const g = missed.get(key) ?? { dates: [], unsoldTotal: 0, roomTypeId: r.roomTypeId, channel: r.channel, hotelId: r.hotelId };
    g.dates.push(r.date);
    g.unsoldTotal += netSellable;
    missed.set(key, g);
  }
  for (const g of missed.values()) {
    const price = avgDealPrice30d(snapshot, ctx, g.hotelId, g.roomTypeId);
    g.dates.sort();
    findings.push(
      makeFinding({
        line: "inventory",
        severity: "P1",
        hotelId: g.hotelId,
        title: `${g.roomTypeId} 在 ${g.channel} 关房未售 ${g.dates.length} 天（累计空关 ${g.unsoldTotal} 间夜）`,
        description: `${g.channel} 渠道 ${g.dates[0]} 起 ${g.dates.length} 天关房，但 PMS 同期有可售净房且无维修占用——有房未上架，直接损失间夜收入（占流失 15% 的漏售场景）。`,
        suggestion: "核对是否为库存同步失败导致的被动关房（R18：同步失败应自动下架并转 review）；非计划关房应立即重新上架。",
        evidence: [{ kind: "room-day", id: `${g.channel}|${g.roomTypeId}`, fields: { closedDays: g.dates.length, unsoldRoomNights: g.unsoldTotal, firstDate: g.dates[0]! } }],
        calculation: {
          formula: "渠道关房 且 (实盘 − 已售 − 问题房) > 0 → 漏售",
          inputs: { roomTypeId: g.roomTypeId, channel: g.channel, closedDays: g.dates.length, unsoldRoomNights: g.unsoldTotal },
          result: `${g.unsoldTotal} 间夜空关`,
        },
        ...(price !== undefined
          ? {
              estimatedImpact: {
                amount: round2(g.unsoldTotal * price * 0.7),
                currency: snapshot.hotels.find((h) => h.hotelId === g.hotelId)?.currency ?? "CNY",
                period: "one-off" as const,
                confidence: "baseline" as const,
                basis: `空关 ${g.unsoldTotal} 间夜 × 近30天均房价 ${price} × 70% 可达入住率折算`,
              },
            }
          : {}),
      }),
    );
  }

  /* ---------- 子项 3：问题房占比 >10% ---------- */
  const pmsSeen2 = new Set<string>();
  const mGroups = new Map<string, { maxRatio: number; days: number; worstDate: string; worstM: number; total: number; roomTypeId: string; hotelId: string }>();
  for (const r of snapshot.roomDays) {
    if (r.maintenanceRooms === undefined || r.totalRooms <= 0) continue;
    const pmsKey = `${r.hotelId}::${r.roomTypeId}::${r.date}`;
    if (pmsSeen2.has(pmsKey)) continue;
    pmsSeen2.add(pmsKey);
    const ratio = r.maintenanceRooms / r.totalRooms;
    if (ratio <= MAINTENANCE_RATIO_REDLINE) continue;
    const gKey = `${r.hotelId}::${r.roomTypeId}`;
    const g = mGroups.get(gKey) ?? { maxRatio: 0, days: 0, worstDate: r.date, worstM: 0, total: r.totalRooms, roomTypeId: r.roomTypeId, hotelId: r.hotelId };
    g.days += 1;
    if (ratio > g.maxRatio) {
      g.maxRatio = ratio;
      g.worstDate = r.date;
      g.worstM = r.maintenanceRooms;
    }
    mGroups.set(gKey, g);
  }
  for (const g of mGroups.values()) {
    const price = avgDealPrice30d(snapshot, ctx, g.hotelId, g.roomTypeId);
    findings.push(
      makeFinding({
        line: "inventory",
        severity: "P1",
        hotelId: g.hotelId,
        title: `${g.roomTypeId} 问题房占比 ${(g.maxRatio * 100).toFixed(1)}% 超 10% 红线（${g.days} 天越线）`,
        description: `${g.worstDate} 问题房 ${g.worstM}/${g.total} 间（${(g.maxRatio * 100).toFixed(1)}%），近窗口共 ${g.days} 天越线。维修周转慢直接压缩可售房量。`,
        suggestion: "盘点问题房维修工单时效，超 48h 未闭环的升级工程负责人；评估外包快修通道。",
        evidence: [{ kind: "room-day", id: `${g.roomTypeId}|${g.worstDate}`, fields: { maintenanceRooms: g.worstM, totalRooms: g.total, ratio: round2(g.maxRatio * 100) + "%" } }],
        calculation: {
          formula: "问题房间数 / 实盘总房量 > 10%",
          inputs: { roomTypeId: g.roomTypeId, worstDate: g.worstDate, maintenanceRooms: g.worstM, totalRooms: g.total },
          result: `${(round2(g.maxRatio * 1000) / 10).toFixed(1)}% > 10%`,
        },
        ...(price !== undefined
          ? {
              estimatedImpact: {
                amount: round2(g.worstM * price * g.days * 0.7),
                currency: snapshot.hotels.find((h) => h.hotelId === g.hotelId)?.currency ?? "CNY",
                period: "one-off" as const,
                confidence: "estimate" as const,
                basis: `问题房 ${g.worstM} 间 × 越线 ${g.days} 天 × 均房价 ${price} × 70% 入住率折算（经验估计）`,
              },
            }
          : {}),
      }),
    );
  }

  /* ---------- 子项 4：连住日期房态断档 ---------- */
  const bySeries = new Map<string, Map<string, { closed: boolean; available: number; maintenanceRooms: number }>>();
  for (const r of snapshot.roomDays) {
    const key = `${r.hotelId}::${r.roomTypeId}::${r.channel}`;
    const m = bySeries.get(key) ?? new Map();
    m.set(r.date, { closed: r.closed, available: r.available, maintenanceRooms: r.maintenanceRooms ?? 0 });
    bySeries.set(key, m);
  }
  for (const [key, days] of bySeries) {
    const [hotelId, roomTypeId, channel] = key.split("::") as [string, string, string];
    for (const [date, d] of days) {
      if (!d.closed || d.maintenanceRooms > 0) continue;
      const prev = days.get(shiftDate(date, -1));
      const next = days.get(shiftDate(date, 1));
      if (prev && next && !prev.closed && !next.closed && prev.available > 0 && next.available > 0) {
        findings.push(
          makeFinding({
            line: "inventory",
            severity: "P2",
            hotelId,
            title: `${roomTypeId} 在 ${channel} ${date} 房态断档（前后日均可售）`,
            description: `${channel} 渠道 ${shiftDate(date, -1)} 与 ${shiftDate(date, 1)} 均可售，唯独 ${date} 关房且无维修占用——连住两晚以上的客人无法下单，订单被让渡给竞对。`,
            suggestion: "核对当日是否为误关房/同步丢单；连住断档日应立即补开并排查同步链路。",
            evidence: [{ kind: "room-day", id: `${channel}|${roomTypeId}|${date}`, fields: { date, prevAvailable: prev.available, nextAvailable: next.available } }],
            calculation: {
              formula: "当日关房 且 前一日/后一日均可售 且 无维修占用 → 连住断档",
              inputs: { roomTypeId, channel, date, prevAvailable: prev.available, nextAvailable: next.available },
              result: "断档 1 天",
            },
          }),
        );
      }
    }
  }

  return findings;
}
