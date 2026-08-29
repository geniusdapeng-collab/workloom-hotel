/**
 * @workloom/audit-engine · 核心类型（酒店版）
 * 质检模式（audit_only）「快速体检」的确定性检测引擎数据模型。
 * 方法论事实源：bundles/hotel/skills/fast-scan/SKILL.md（五线扫描）。
 * 阈值口径：bundles/hotel/fences/hotel-baseline.yml（R1 涨幅 8% / R2 保底价 ¥380 / R17 倒挂 / R19 差评 24h SLA）。
 *
 * 数据流：连接器只读快照 → AuditSnapshot（归一化数据集）→ 五个分析器 → Finding[] → AuditReport。
 * 全程只读：引擎不触碰任何 PMS/OTA/IoT 写接口，只读快照进、发现/报告出。
 */

// ---------- 枚举 ----------

/** 五线（fast-scan SKILL.md 步骤 2→6：价格/房态库存/渠道/口碑/安全与断点） */
export type AuditLine = "price" | "inventory" | "channel" | "reputation" | "safety";

/** 严重度：P0=立即止损/安全红线，P1=显著渗漏需本周处理，P2=优化项 */
export type Severity = "P0" | "P1" | "P2";

/** 估算置信度：exact=可逐笔勾稽的精确值；baseline=按门店/商圈基准估算；estimate=经验估计 */
export type Confidence = "exact" | "baseline" | "estimate";

/** 金额口径周期 */
export type ImpactPeriod = "one-off" | "monthly" | "yearly";

// ---------- 快照数据集（输入） ----------

/** 渠道档案（佣金协议比例为对账勾稽基准；缺失时该渠道佣金子项降级） */
export interface ChannelProfile {
  /** 渠道编码：ctrip/meituan/fliggy/dy/direct… */
  channel: string;
  /** OTA 佣金应提比例（0–1；直连/直销渠道可为 0） */
  commissionRate?: number;
}

/** 门店档案 + 口碑指标（一店一档口径；缺省字段表示该指标未采集） */
export interface HotelInfo {
  hotelId: string;
  hotelName: string;
  /** ISO 4217 币种 */
  currency: string;
  timezone: string;
  /** 保底价（business.floor_price 同源，R2；缺失时引擎按默认 ¥380 判定并在报告中标注） */
  floorPrice?: number;
  /** 总房量（问题房占比分母；缺失时该子项按 roomDays 推算） */
  roomCount?: number;
  /** 当前综合评分（OTA 汇总；口碑线输入） */
  rating?: number;
  /** 近 30 天评分变化（负=下滑；口碑线输入） */
  ratingDelta30d?: number;
  /** 已授权渠道档案 */
  channels: ChannelProfile[];
}

/** 房型主数据（价格带基准） */
export interface RoomTypeRecord {
  hotelId: string;
  roomTypeId: string;
  name: string;
  /** 价格带基准价（远期日历异常子项的中位数缺省回退） */
  basePrice?: number;
  currency: string;
}

/** 渠道在售房价（价格日历 × 渠道；倒挂与破防判定输入） */
export interface ChannelPriceRecord {
  hotelId: string;
  roomTypeId: string;
  /** 入住日期 YYYY-MM-DD */
  date: string;
  channel: string;
  price: number;
  currency: string;
}

/**
 * 房态库存逐日记录（PMS 实盘 × 渠道可售）。
 * totalRooms/sold/maintenanceRooms 为 PMS 口径（同房型同日跨渠道行应一致）；
 * available/closed 为渠道口径。
 */
export interface RoomDayRecord {
  hotelId: string;
  roomTypeId: string;
  /** 入住日期 YYYY-MM-DD */
  date: string;
  channel: string;
  /** PMS 实盘总房量（该房型当日） */
  totalRooms: number;
  /** PMS 已售间数 */
  sold: number;
  /** 问题房（维修中/锁房）间数；未采集省略则问题房子项降级 */
  maintenanceRooms?: number;
  /** 渠道可售间数（负值=超售） */
  available: number;
  /** 渠道是否关房 */
  closed: boolean;
}

/** 担保信息（安全线输入；无担保订单省略该字段） */
export interface GuaranteeInfo {
  /** 担保方式：credit-card/deposit */
  type: string;
  /** 是否已预授权/已收押金 */
  preauthorized?: boolean;
  /** 预授权/押金金额 */
  preauthAmount?: number;
  /** no-show 后担保是否已结算 */
  settled?: boolean;
}

/** 酒店订单（近 90 天，含取消/no-show/担保标记） */
export interface HotelOrderRecord {
  hotelId: string;
  orderId: string;
  channel: string;
  roomTypeId?: string;
  /** 成交总额（含全部间夜） */
  amount: number;
  currency: string;
  /** 间夜数 */
  nights: number;
  status: "confirmed" | "completed" | "cancelled" | "no-show" | "refunded";
  /** 入住日期 YYYY-MM-DD */
  checkIn: string;
  createdAt: string; // ISO 8601
  guarantee?: GuaranteeInfo;
}

/** OTA 渠道账单行（渠道健康线勾稽输入） */
export interface ChannelBillLineRecord {
  lineId: string;
  type: "order" | "commission" | "refund" | "no-show-charge";
  /** 关联单据号（订单号） */
  refId: string;
  amount: number;
  currency: string;
}

export interface ChannelBillRecord {
  hotelId: string;
  channel: string;
  billId: string;
  /** 账期 YYYY-MM */
  period: string;
  lines: ChannelBillLineRecord[];
}

/** 评价记录（口碑线输入） */
export interface HotelReviewRecord {
  hotelId: string;
  reviewId: string;
  channel?: string;
  roomTypeId?: string;
  /** 1–5 分 */
  rating: number;
  createdAt: string; // ISO 8601
  /** 回复时间；未回复省略 */
  repliedAt?: string;
  content?: string;
}

/**
 * 断点记录（无人酒店断点是资产：每次断点沉淀根因，闭环后复发率应下降）。
 * 来源：对接失败/同步失败/设备告警历史（只读）。
 */
export interface BreakpointRecord {
  hotelId: string;
  breakpointId: string;
  /** 断点类别：ota-sync-failed/pms-callback-timeout/door-lock-offline/payment-callback-timeout/self-service-kiosk-fault… */
  category: string;
  occurredAt: string; // ISO 8601
  resolvedAt?: string;
  /** 已沉淀根因（有则报告中引用，无则建议补录） */
  rootCause?: string;
}

/**
 * 快照数据集：一次体检的全部输入。
 * 各字段可为空数组——对应数据源缺失时该线标注「未覆盖」，引擎降级出部分报告（SKILL.md 四）。
 */
export interface AuditSnapshot {
  snapshotId: string;
  /** 快照生成时间（差评 24h SLA、近 30 天窗口、断点 7 天窗口等均以 now 为锚） */
  generatedAt: string; // ISO 8601
  hotels: HotelInfo[];
  roomTypes: RoomTypeRecord[];
  channelPrices: ChannelPriceRecord[];
  roomDays: RoomDayRecord[];
  orders: HotelOrderRecord[];
  channelBills: ChannelBillRecord[];
  reviews: HotelReviewRecord[];
  breakpoints: BreakpointRecord[];
  /** 节假日日期清单（YYYY-MM-DD，收益日历来源；缺失时远期日历子项降级） */
  holidays: string[];
}

// ---------- 发现（输出） ----------

/** 证据记录引用：指向快照中的具体单据 */
export interface EvidenceRef {
  /** 证据类别：channel-price/room-day/order/bill-line/review/breakpoint/hotel… */
  kind: string;
  id: string;
  /** 关键字段快照（审计留痕，原样透传） */
  fields?: Record<string, string | number>;
}

/** 计算过程快照：公式 + 输入 + 结果，报告可复算（SKILL.md 回执=计算过程快照） */
export interface CalculationSnapshot {
  formula: string;
  inputs: Record<string, number | string>;
  result: number | string;
}

/** 估算挽回金额（禁止把估算说成确定值——confidence 必填） */
export interface EstimatedImpact {
  amount: number;
  currency: string;
  period: ImpactPeriod;
  confidence: Confidence;
  /** 计算口径说明（如"近30天该渠道间夜 × 每间夜价差"） */
  basis: string;
}

export interface Finding {
  /** 引擎内唯一编号：FND-<线>-<序号> */
  id: string;
  line: AuditLine;
  severity: Severity;
  hotelId: string;
  title: string;
  /** 问题描述 + 建议动作 */
  description: string;
  suggestion: string;
  evidence: EvidenceRef[];
  calculation: CalculationSnapshot;
  estimatedImpact?: EstimatedImpact;
}

// ---------- 报告（输出） ----------

/** 单条线的覆盖度：covered=已扫描；partial=部分子项因数据缺失降级；not-covered=数据源缺失/超时未扫 */
export type LineCoverage = "covered" | "partial" | "not-covered";

/** 一店一份 */
export interface HotelReport {
  hotelId: string;
  hotelName: string;
  currency: string;
  findings: Finding[];
  /** 按严重度计数 */
  counts: Record<Severity, number>;
  /** 该店估算挽回合计（同币种相加；跨置信度并列展示，不混合口径到分） */
  totalRecoverable: number;
}

/** 集团总览 */
export interface GroupOverview {
  hotelCount: number;
  findingCount: number;
  counts: Record<Severity, number>;
  /** 按币种分桶的估算挽回合计（跨币种不强行折算，报告层再按汇率口径处理） */
  totalRecoverableByCurrency: Record<string, number>;
}

export interface AuditReport {
  reportId: string;
  generatedAt: string;
  /** 快照引用（审计留痕） */
  snapshotId: string;
  /** 各线覆盖度（未覆盖的线在此标注，报告仍为有效部分报告） */
  coverage: Record<AuditLine, LineCoverage>;
  /** 覆盖度备注（如"节假日期历缺失，远期日历子项降级"） */
  coverageNotes: string[];
  hotels: HotelReport[];
  overview: GroupOverview;
  /** 按年化挽回金额降序的 Top10 行动清单（集团视角） */
  top10: Finding[];
  /** 实际耗时（毫秒）与软预算（分钟），时间纪律留痕 */
  elapsedMs: number;
  timeBudgetMinutes: number;
}

/** runFastScan 选项 */
export interface FastScanOptions {
  /** 软时间预算（分钟），默认 30；超时后剩余线标注 not-covered 出部分报告 */
  timeBudgetMinutes?: number;
  /** 报告锚定时间（默认取 snapshot.generatedAt；测试可注入固定钟） */
  now?: Date;
  /** 默认保底价（一店一档缺失时回退，默认 380，R2 口径） */
  floorPriceDefault?: number;
}
