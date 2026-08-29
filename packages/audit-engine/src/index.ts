/**
 * @workloom/audit-engine —— 质检模式「快速体检」确定性检测引擎（酒店版）
 * 出口：类型 + 五个分析器 + runFastScan 主入口 + 阈值常量（测试/调参用）。
 * 方法论锚点：bundles/hotel/skills/fast-scan/SKILL.md（五线）+ bundles/hotel/fences/hotel-baseline.yml（阈值）。
 */
export * from "./types.js";
export { runFastScan, DEFAULT_FLOOR_PRICE } from "./engine.js";
export {
  analyzePrice,
  PARITY_GAP_THRESHOLD,
  PARITY_GAP_P0,
  HOLIDAY_UPLIFT_MIN,
  WEEKDAY_HIGH_RATIO,
  WEEKDAY_LOW_RATIO,
  CALENDAR_MIN_SAMPLES,
} from "./analyzers/price.js";
export { analyzeInventory, MAINTENANCE_RATIO_REDLINE } from "./analyzers/inventory.js";
export {
  analyzeChannel,
  COMMISSION_TOLERANCE_PP,
  COMMISSION_DIFF_P1_AMOUNT,
  CHANNEL_DEPENDENCE_REDLINE,
  CHANNEL_DEPENDENCE_P0,
} from "./analyzers/channel.js";
export {
  analyzeReputation,
  BAD_RATING_MAX,
  UNREPLIED_HOURS,
  UNREPLIED_HOURS_P0,
  LOW_RATING,
  RATING_DROP_REDLINE,
  CLUSTER_DAYS,
  CLUSTER_MIN_BAD,
  BAD_KEYWORDS,
} from "./analyzers/reputation.js";
export {
  analyzeSafety,
  BREAKPOINT_WINDOW_DAYS,
  BREAKPOINT_MIN_COUNT,
  BREAKPOINT_P0_COUNT,
  PREAUTH_OVER_RATIO,
} from "./analyzers/safety.js";
export type { AnalyzerContext } from "./analyzers/util.js";
