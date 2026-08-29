/**
 * 分析器公共工具：时间窗、数值修约、分析器上下文。
 * 所有分析器为纯函数：同一份快照 + 同一个 now 必得同一份发现（确定性纪律，可复算）。
 */
import type { Finding } from "../types.js";

/** 分析器上下文：锚定时间与可调阈值（由 engine 注入，分析器不读系统时钟） */
export interface AnalyzerContext {
  /** 报告锚定时间（差评 24h SLA、近 30 天窗口、断点 7 天窗口以此为界） */
  now: Date;
  /** 默认保底价（一店一档缺失时回退，R2 口径 ¥380） */
  floorPriceDefault: number;
}

/** 两位小数修约（金额口径统一） */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 百分比修约（pp 判定展示用） */
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 两个 ISO 时间的小时差（now - at） */
export function hoursSince(now: Date, at: string): number {
  return (now.getTime() - Date.parse(at)) / 3_600_000;
}

/** 两个 ISO 时间的天数差（now - at） */
export function daysSince(now: Date, at: string): number {
  return hoursSince(now, at) / 24;
}

/** 近 N 天窗口起点（含边界） */
export function windowStart(now: Date, days: number): number {
  return now.getTime() - days * 86_400_000;
}

/** YYYY-MM-DD 日期序列工具：date ± n 天 */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 中位数（已过滤空序列调用方保证非空） */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 构造发现时统一收口：占位 id（由 engine 统一编号 FND-<line>-<n>） */
export function makeFinding(f: Omit<Finding, "id">): Finding {
  return { ...f, id: "" };
}
