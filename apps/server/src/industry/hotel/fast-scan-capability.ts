/** 酒店快速体检的服务端能力边界：用户快照进、确定性报告出、事件回执留痕。 */
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { runFastScan, type AuditReport, type AuditSnapshot } from "@workloom/audit-engine";
import { gatewayAppendIdempotent, canonicalJson } from "@workloom/base/workdata";
import { getAppPool, getGatewayPool, withWorkspace } from "@workloom/db";
import type { Identity } from "@workloom/base/tenancy";
import type { BusinessEvent } from "@workloom/shared";

const id = z.string().trim().min(1).max(128);
const date = z.iso.date();
const timestamp = z.iso.datetime({ offset: true });
const amount = z.number().finite().nonnegative();
const nonnegativeInt = z.number().int().nonnegative();

const hotel = z.object({
  hotelId: id, hotelName: z.string().trim().min(1).max(200),
  currency: z.string().regex(/^[A-Z]{3}$/), timezone: z.string().min(1).max(100),
  floorPrice: amount.optional(), roomCount: nonnegativeInt.optional(),
  rating: z.number().finite().min(0).max(5).optional(),
  ratingDelta30d: z.number().finite().min(-5).max(5).optional(),
  channels: z.array(z.object({ channel: id, commissionRate: z.number().finite().min(0).max(1).optional() })).max(100),
});
const roomType = z.object({ hotelId: id, roomTypeId: id, name: z.string().trim().min(1).max(200), basePrice: amount.optional(), currency: z.string().regex(/^[A-Z]{3}$/) });
const channelPrice = z.object({ hotelId: id, roomTypeId: id, date, channel: id, price: amount, currency: z.string().regex(/^[A-Z]{3}$/) });
const roomDay = z.object({ hotelId: id, roomTypeId: id, date, channel: id, totalRooms: nonnegativeInt, sold: nonnegativeInt, maintenanceRooms: nonnegativeInt.optional(), available: z.number().int().finite(), closed: z.boolean() });
const order = z.object({
  hotelId: id, orderId: id, channel: id, roomTypeId: id.optional(), amount, currency: z.string().regex(/^[A-Z]{3}$/),
  nights: z.number().int().positive(), status: z.enum(["confirmed", "completed", "cancelled", "no-show", "refunded"]),
  checkIn: date, createdAt: timestamp,
  guarantee: z.object({ type: id, preauthorized: z.boolean().optional(), preauthAmount: amount.optional(), settled: z.boolean().optional() }).optional(),
});
const bill = z.object({
  hotelId: id, channel: id, billId: id, period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  lines: z.array(z.object({ lineId: id, type: z.enum(["order", "commission", "refund", "no-show-charge"]), refId: id, amount, currency: z.string().regex(/^[A-Z]{3}$/) })).max(2_000),
});
const review = z.object({ hotelId: id, reviewId: id, channel: id.optional(), roomTypeId: id.optional(), rating: z.number().finite().min(1).max(5), createdAt: timestamp, repliedAt: timestamp.optional(), content: z.string().max(4_000).optional() });
const breakpoint = z.object({ hotelId: id, breakpointId: id, category: id, occurredAt: timestamp, resolvedAt: timestamp.optional(), rootCause: z.string().max(4_000).optional() });

export const hotelAuditSnapshotSchema = z.object({
  snapshotId: id, generatedAt: timestamp,
  hotels: z.array(hotel).max(100), roomTypes: z.array(roomType).max(1_000),
  channelPrices: z.array(channelPrice).max(10_000), roomDays: z.array(roomDay).max(10_000),
  orders: z.array(order).max(10_000), channelBills: z.array(bill).max(1_000),
  reviews: z.array(review).max(10_000), breakpoints: z.array(breakpoint).max(10_000),
  holidays: z.array(date).max(1_000),
}).superRefine((snapshot, ctx) => {
  const hotels = new Set<string>();
  for (const [i, h] of snapshot.hotels.entries()) {
    if (hotels.has(h.hotelId)) ctx.addIssue({ code: "custom", path: ["hotels", i, "hotelId"], message: "门店 ID 重复" });
    hotels.add(h.hotelId);
  }
  const datasets = ["roomTypes", "channelPrices", "roomDays", "orders", "channelBills", "reviews", "breakpoints"] as const;
  for (const name of datasets) {
    for (const [i, row] of snapshot[name].entries()) {
      if (!hotels.has(row.hotelId)) ctx.addIssue({ code: "custom", path: [name, i, "hotelId"], message: "记录归属的门店不在 hotels 中" });
    }
  }
});

export const fastScanInputSchema = z.object({
  snapshot: hotelAuditSnapshotSchema,
  timeBudgetMinutes: z.number().int().min(1).max(30),
});
export const fastScanExecuteInputSchema = fastScanInputSchema.extend({
  idempotencyKey: z.string().trim().min(8).max(128),
});
export const fastScanReceiptInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128),
});

type FastScanInput = z.infer<typeof fastScanInputSchema>;
type ExecuteInput = z.infer<typeof fastScanExecuteInputSchema>;
type ReceiptInput = z.infer<typeof fastScanReceiptInputSchema>;
type Scope = { tenantId: string; workspaceId: string };
type StoredReport = { inputDigest: string; report: AuditReport };

const CAPABILITY = "hotel.fast_scan";
const DATA_MODE = "provided-unverified" as const;

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function scopeOf(identity: Identity): Scope { return { tenantId: identity.tenantId, workspaceId: identity.workspaceId }; }
function eventIdFor(scope: Scope, key: string): string {
  return `E-RPL-HFS-${sha256(`${scope.tenantId}\0${scope.workspaceId}\0${key}`).slice(0, 48)}`;
}
function inputDigest(input: FastScanInput): string {
  return sha256(canonicalJson({ snapshot: input.snapshot, timeBudgetMinutes: input.timeBudgetMinutes }));
}
function analyze(input: FastScanInput): AuditReport {
  return runFastScan(input.snapshot as AuditSnapshot, {
    now: new Date(input.snapshot.generatedAt), timeBudgetMinutes: input.timeBudgetMinutes,
  });
}
function envelope(operation: "preview" | "execute" | "receipt", status: "succeeded" | "pending", result: unknown, eventId?: string) {
  return {
    schemaVersion: "workloom.capability-result/v1" as const,
    capabilityId: `${CAPABILITY}.${operation}`,
    operation, status, dataMode: DATA_MODE, result,
    ...(eventId ? { receipt: { eventId, synced: false, sourceVerified: false } } : {}),
  };
}

async function readStored(scope: Scope, eventId: string): Promise<StoredReport | null> {
  return withWorkspace(getAppPool(), scope, async (_db, client) => {
    const found = await client.query<{ payload: BusinessEvent }>(
      `SELECT payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND event_id=$3
       AND payload->'decision'->>'action'='audit.fast-scan.report'`,
      [scope.tenantId, scope.workspaceId, eventId],
    );
    const after = found.rows[0]?.payload.decision.after;
    if (!after || typeof after !== "object") return null;
    const stored = after as Record<string, unknown>;
    if (stored.capabilityId !== CAPABILITY || stored.dataMode !== DATA_MODE || typeof stored.inputDigest !== "string" || !stored.report) return null;
    return { inputDigest: stored.inputDigest, report: stored.report as AuditReport };
  });
}

function assertSameInput(stored: StoredReport, digest: string): void {
  if (stored.inputDigest !== digest) {
    throw new TRPCError({ code: "CONFLICT", message: "幂等键已用于另一份快照或预算，请换新键" });
  }
}

export function fastScanPreview(input: FastScanInput) {
  const report = analyze(input);
  return envelope("preview", "succeeded", { report, sourceVerified: false });
}

export async function fastScanExecute(identity: Identity, input: ExecuteInput) {
  const scope = scopeOf(identity);
  const eventId = eventIdFor(scope, input.idempotencyKey);
  const digest = inputDigest(input);
  const existing = await readStored(scope, eventId);
  if (existing) {
    assertSameInput(existing, digest);
    return envelope("execute", "succeeded", { report: existing.report, sourceVerified: false, deduped: true }, eventId);
  }
  const report = analyze(input);
  const event: BusinessEvent = {
    event_id: eventId,
    who: { type: "human", id: identity.memberNo },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "agent-capability", stage: "audit", data_mode: DATA_MODE, snapshot_time: input.snapshot.generatedAt },
    object: { type: "audit-report", id: report.reportId },
    decision: {
      action: "audit.fast-scan.report",
      after: { capabilityId: CAPABILITY, dataMode: DATA_MODE, inputDigest: digest, report },
      basis: ["调用方提供的酒店快照，数据源未核验", "只生成体检报告并留痕，未向 PMS、OTA 或 IoT 写入"],
    },
    rule_impact: [{ rule_id: "audit-only-readonly", version: "v1", result: "pass" }],
    receipt: { synced: false },
  };
  try {
    await gatewayAppendIdempotent(getGatewayPool(), { ...scope, actor: { type: "human", id: identity.memberNo } }, event);
  } catch (error) {
    // 同键并发时两次计算的耗时可能不同；以已提交的首份回执为准。
    const winner = await readStored(scope, eventId).catch(() => null);
    if (!winner) throw error;
    assertSameInput(winner, digest);
    return envelope("execute", "succeeded", { report: winner.report, sourceVerified: false, deduped: true }, eventId);
  }
  const stored = await readStored(scope, eventId);
  if (!stored) throw new Error("体检事件写入后无法读取回执");
  assertSameInput(stored, digest);
  return envelope("execute", "succeeded", { report: stored.report, sourceVerified: false, deduped: false }, eventId);
}

export async function fastScanReceipt(identity: Identity, input: ReceiptInput) {
  const scope = scopeOf(identity);
  const eventId = eventIdFor(scope, input.idempotencyKey);
  const stored = await readStored(scope, eventId);
  return stored
    ? envelope("receipt", "succeeded", { report: stored.report, sourceVerified: false }, eventId)
    : envelope("receipt", "pending", { report: null, sourceVerified: false });
}
