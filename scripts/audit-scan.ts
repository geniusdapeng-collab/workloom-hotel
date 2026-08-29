/**
 * audit-scan · 酒店快速体检 CLI（pnpm audit:scan）
 * 流程：mock 连接器只读拉取（合成快照，含演示埋点）→ 组装 AuditSnapshot → runFastScan →
 *       控制台输出《酒店快速体检报告》摘要 → 写事件库（五元事件，actor=audit-engine，只读动作）。
 * 纪律：
 *  - 全程只读：不写任何 PMS/OTA/IoT；唯一写入是系统事件库（gateway 通道，F1.2）；
 *  - 确定性：合成快照全部硬编码（禁止 Math.random），同环境多次运行结果一致；
 *  - DB 不可用时降级为「仅控制台报告」（事件写失败不阻塞报告交付，打印告警）。
 */
import { appendEvent } from "@workloom/base/workdata";
import { closeAllPools, getGatewayPool } from "@workloom/db";
import { runFastScan, type AuditReport, type AuditSnapshot, type Finding } from "@workloom/audit-engine";

/** 报告锚定时间（演示口径同日） */
const NOW = new Date("2026-08-27T10:30:00+08:00");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/**
 * 合成演示快照：云栖酒店（演示租户 tenant-demo / ws-yunqi，与 seed.ts 同源口径）。
 * 含已知演示问题：跨渠道倒挂 / 破保底价 / 超售 / 漏售 / 佣金多提 / 差评超时未回 / 担保未预授权 / 断点高频。
 */
function buildMockSnapshot(): AuditSnapshot {
  return {
    snapshotId: `SNAP-${NOW.toISOString().slice(0, 10)}`,
    generatedAt: NOW.toISOString(),
    hotels: [
      {
        hotelId: "H-YUNQI-001",
        hotelName: "云栖酒店",
        currency: "CNY",
        timezone: "Asia/Shanghai",
        floorPrice: 380,
        roomCount: 60,
        rating: 4.1,
        ratingDelta30d: -0.4,
        channels: [
          { channel: "ctrip", commissionRate: 0.15 },
          { channel: "meituan", commissionRate: 0.12 },
          { channel: "fliggy", commissionRate: 0.1 },
        ],
      },
    ],
    roomTypes: [
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", name: "豪华大床房", basePrice: 550, currency: "CNY" },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-STD-TWIN", name: "高级双床房", basePrice: 420, currency: "CNY" },
    ],
    channelPrices: [
      // 倒挂 12%：携程 528 vs 美团 600
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: "2026-09-01", channel: "ctrip", price: 528, currency: "CNY" },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: "2026-09-01", channel: "meituan", price: 600, currency: "CNY" },
      // 破保底价：飞猪 360 < 380（3 天）
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-STD-TWIN", date: "2026-09-01", channel: "fliggy", price: 360, currency: "CNY" },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-STD-TWIN", date: "2026-09-02", channel: "fliggy", price: 360, currency: "CNY" },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-STD-TWIN", date: "2026-09-03", channel: "fliggy", price: 360, currency: "CNY" },
      // 远期日历：平日 500 基准，国庆未调价
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: "2026-09-10", channel: "ctrip", price: 500, currency: "CNY" },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: "2026-09-11", channel: "ctrip", price: 500, currency: "CNY" },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: "2026-09-12", channel: "ctrip", price: 500, currency: "CNY" },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: "2026-10-01", channel: "ctrip", price: 500, currency: "CNY" },
    ],
    roomDays: [
      // 超售：已售 21 > 实盘 20
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: "2026-09-05", channel: "ctrip", totalRooms: 20, sold: 21, maintenanceRooms: 0, available: 0, closed: false },
      // 漏售：美团关房 2 天但 PMS 有净房
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-STD-TWIN", date: "2026-09-06", channel: "meituan", totalRooms: 25, sold: 15, maintenanceRooms: 0, available: 0, closed: true },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-STD-TWIN", date: "2026-09-07", channel: "meituan", totalRooms: 25, sold: 15, maintenanceRooms: 0, available: 0, closed: true },
      // 健康对照行
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: "2026-09-06", channel: "ctrip", totalRooms: 20, sold: 12, maintenanceRooms: 1, available: 7, closed: false },
    ],
    orders: [
      { hotelId: "H-YUNQI-001", orderId: "O-9001", channel: "ctrip", roomTypeId: "RT-DELUXE-KING", amount: 20000, currency: "CNY", nights: 2, status: "completed", checkIn: "2026-09-01", createdAt: daysAgo(12) },
      { hotelId: "H-YUNQI-001", orderId: "O-9002", channel: "meituan", roomTypeId: "RT-STD-TWIN", amount: 2500, currency: "CNY", nights: 5, status: "completed", checkIn: "2026-09-02", createdAt: daysAgo(10) },
      { hotelId: "H-YUNQI-001", orderId: "O-9003", channel: "fliggy", roomTypeId: "RT-STD-TWIN", amount: 1500, currency: "CNY", nights: 3, status: "completed", checkIn: "2026-09-03", createdAt: daysAgo(8) },
      // 担保未预授权（首晚敞口 600）
      { hotelId: "H-YUNQI-001", orderId: "O-9004", channel: "ctrip", roomTypeId: "RT-DELUXE-KING", amount: 1200, currency: "CNY", nights: 2, status: "confirmed", checkIn: "2026-09-10", createdAt: daysAgo(5), guarantee: { type: "credit-card", preauthorized: false } },
    ],
    channelBills: [
      // 佣金多提 0.6pp：应提 20000×15%=3000，实提 3120
      {
        hotelId: "H-YUNQI-001",
        channel: "ctrip",
        billId: "BILL-202608",
        period: "2026-08",
        lines: [
          { lineId: "BL-1", type: "order", refId: "O-9001", amount: 20000, currency: "CNY" },
          { lineId: "BL-2", type: "commission", refId: "O-9001", amount: 3120, currency: "CNY" },
        ],
      },
    ],
    reviews: [
      // 差评 36h 未回（>24h SLA）
      { hotelId: "H-YUNQI-001", reviewId: "RV-BAD-001", channel: "ctrip", roomTypeId: "RT-DELUXE-KING", rating: 2, createdAt: hoursAgo(36), content: "空调坏了没人修，卫生也一般" },
      { hotelId: "H-YUNQI-001", reviewId: "RV-101", channel: "ctrip", rating: 2, createdAt: hoursAgo(50), content: "隔音太差，半夜被吵醒" },
      { hotelId: "H-YUNQI-001", reviewId: "RV-102", channel: "meituan", rating: 1, createdAt: hoursAgo(60), repliedAt: hoursAgo(59), content: "隔音差到离谱" },
      { hotelId: "H-YUNQI-001", reviewId: "RV-103", channel: "fliggy", rating: 3, createdAt: hoursAgo(70), repliedAt: hoursAgo(68), content: "房间隔音不好" },
      { hotelId: "H-YUNQI-001", reviewId: "RV-GOOD-001", channel: "meituan", rating: 5, createdAt: hoursAgo(10), repliedAt: hoursAgo(9), content: "服务很好" },
    ],
    breakpoints: [
      // 断点高频：ota-sync-failed 7 天 3 次（2 条已沉淀根因）
      { hotelId: "H-YUNQI-001", breakpointId: "BP-1001", category: "ota-sync-failed", occurredAt: hoursAgo(20), rootCause: "渠道直连凭证过期" },
      { hotelId: "H-YUNQI-001", breakpointId: "BP-1002", category: "ota-sync-failed", occurredAt: hoursAgo(50), rootCause: "渠道直连凭证过期" },
      { hotelId: "H-YUNQI-001", breakpointId: "BP-1003", category: "ota-sync-failed", occurredAt: hoursAgo(90) },
    ],
    holidays: ["2026-10-01", "2026-10-02"],
  };
}

/** 控制台报告摘要 */
function printReport(snapshot: AuditSnapshot, report: AuditReport, eventId?: string): void {
  const line = "─".repeat(64);
  console.log(line);
  console.log(`《酒店快速体检报告》 ${report.reportId} · 生成于 ${report.generatedAt}`);
  console.log(`快照 ${snapshot.snapshotId} · 门店 ${report.overview.hotelCount} 家 · 数据源覆盖：${
    Object.entries(report.coverage).map(([k, v]) => `${k}=${v === "covered" ? "✓" : v === "partial" ? "△" : "✗"}`).join(" ")
  }`);
  if (report.coverageNotes.length > 0) console.log(`降级说明：${report.coverageNotes.join("；")}`);
  console.log(line);
  const { counts, findingCount, totalRecoverableByCurrency } = report.overview;
  console.log(`发现 ${findingCount} 条（P0=${counts.P0} / P1=${counts.P1} / P2=${counts.P2}）`);
  const totals = Object.entries(totalRecoverableByCurrency).map(([c, a]) => `${a.toLocaleString()} ${c}`).join(" + ");
  console.log(`估算挽回空间：${totals || "—"}（分币种口径，详见各发现 confidence/basis 标注）`);
  console.log(line);
  console.log("Top 行动清单（按年化挽回金额降序，最多 10 条）：");
  report.top10.forEach((f: Finding, i: number) => {
    const impact = f.estimatedImpact ? `${f.estimatedImpact.amount.toLocaleString()} ${f.estimatedImpact.currency}/${f.estimatedImpact.period} [${f.estimatedImpact.confidence}]` : "—";
    const owner = report.hotels.find((h) => h.findings.some((x) => x.id === f.id));
    console.log(` ${String(i + 1).padStart(2)}. [${f.severity}] ${f.title}`);
    console.log(`     店=${owner?.hotelName ?? f.hotelId} · 挽回≈${impact}`);
    console.log(`     建议：${f.suggestion}`);
  });
  console.log(line);
  console.log(`耗时 ${report.elapsedMs}ms（软预算 ${report.timeBudgetMinutes} 分钟）· 全程只读`);
  if (eventId) console.log(`报告事件已入库：${eventId}（actor=audit-engine，action=audit.fast-scan.report）`);
}

async function main(): Promise<void> {
  const snapshot = buildMockSnapshot();
  console.log(`[audit-scan] mock 快照就绪：hotels=${snapshot.hotels.length} channelPrices=${snapshot.channelPrices.length} roomDays=${snapshot.roomDays.length} orders=${snapshot.orders.length} bills=${snapshot.channelBills.length} reviews=${snapshot.reviews.length} breakpoints=${snapshot.breakpoints.length}`);

  const report = runFastScan(snapshot, { now: NOW, timeBudgetMinutes: 30 });

  // 写事件库（五元事件；DB 不可达时降级为仅控制台报告，不阻塞交付）
  let eventId: string | undefined;
  try {
    const gateway = getGatewayPool();
    const r = await appendEvent(
      gateway,
      { tenantId: "tenant-demo", workspaceId: "ws-yunqi" },
      {
        event: {
          who: { type: "agent", id: "audit-engine", version: "0.1.0" },
          context: { tenant_id: "tenant-demo", workspace_id: "ws-yunqi", time: NOW.toISOString(), channel: "cli", stage: "audit" },
          object: { type: "audit-report", id: report.reportId },
          decision: {
            action: "audit.fast-scan.report",
            after: {
              findingCount: report.overview.findingCount,
              counts: report.overview.counts,
              totalRecoverableByCurrency: report.overview.totalRecoverableByCurrency,
              coverage: report.coverage,
              top10: report.top10.map((f) => ({ id: f.id, line: f.line, severity: f.severity, title: f.title, impact: f.estimatedImpact })),
            },
            basis: ["fast-scan 五线扫描（bundles/hotel/skills/fast-scan）", "全程只读：未调用任何 PMS/OTA/IoT 写接口"],
          },
          rule_impact: [{ rule_id: "audit-only-readonly", version: "v1", result: "pass" }],
        },
      },
    );
    eventId = r.eventId;
    await closeAllPools();
  } catch (err) {
    console.warn(`[audit-scan] 事件库写入失败（降级为仅控制台报告）：${err instanceof Error ? err.message : String(err)}`);
  }

  printReport(snapshot, report, eventId);
}

await main();
