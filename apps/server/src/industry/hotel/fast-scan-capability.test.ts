import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@workloom/base/tenancy";

const fake = vi.hoisted(() => ({
  events: new Map<string, Record<string, unknown>>(),
  writes: 0,
  failWrite: false,
}));

vi.mock("@workloom/db", () => ({
  getAppPool: () => ({}), getGatewayPool: () => ({}),
  withWorkspace: async (_pool: unknown, _scope: unknown, callback: (db: unknown, client: unknown) => Promise<unknown>) =>
    callback({}, {
      query: async (_sql: string, params: string[]) => ({ rows: fake.events.has(params[2]!) ? [{ payload: fake.events.get(params[2]!) }] : [] }),
    }),
}));
vi.mock("@workloom/base/workdata", () => ({
  canonicalJson: (value: unknown) => JSON.stringify(value),
  gatewayAppendIdempotent: async (_pool: unknown, _ctx: unknown, event: Record<string, unknown>) => {
    if (fake.failWrite) throw new Error("database unavailable");
    fake.writes += 1;
    fake.events.set(event.event_id as string, event);
    return { eventId: event.event_id, deduped: false };
  },
}));

import {
  fastScanExecute, fastScanExecuteInputSchema, fastScanPreview, fastScanReceipt,
  hotelAuditSnapshotSchema,
} from "./fast-scan-capability.js";

const actor = { tenantId: "tenant-a", workspaceId: "workspace-a", memberNo: "MEM-001" } as Identity;
const snapshot = {
  snapshotId: "SNAP-1", generatedAt: "2026-09-27T12:00:00+08:00",
  hotels: [{ hotelId: "H-1", hotelName: "甲店", currency: "CNY", timezone: "Asia/Shanghai", floorPrice: 380, channels: [] }],
  roomTypes: [], channelPrices: [], roomDays: [], orders: [], channelBills: [], reviews: [], breakpoints: [], holidays: [],
};

beforeEach(() => { fake.events.clear(); fake.writes = 0; fake.failWrite = false; });

describe("酒店快速体检原子能力", () => {
  it("校验快照归属与幂等键；空源报告明确标注未覆盖、未核验", () => {
    expect(hotelAuditSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(hotelAuditSnapshotSchema.safeParse({ ...snapshot, orders: [{ hotelId: "H-other" }] }).success).toBe(false);
    expect(fastScanExecuteInputSchema.safeParse({ snapshot, idempotencyKey: "short" }).success).toBe(false);
    const response = fastScanPreview({ snapshot, timeBudgetMinutes: 30 });
    expect(response.status).toBe("succeeded");
    expect(response.dataMode).toBe("provided-unverified");
    expect((response.result as { report: { coverage: Record<string, string> } }).report.coverage.price).toBe("not-covered");
    expect(response.receipt).toBeUndefined();
    expect(fake.writes).toBe(0);
  });

  it("执行写一条事件，同键同输入复用回执，同键不同输入拒绝", async () => {
    const input = { snapshot, timeBudgetMinutes: 30, idempotencyKey: "request-001" };
    const first = await fastScanExecute(actor, input);
    expect(first.receipt?.eventId).toMatch(/^E-RPL-HFS-/);
    expect(first.receipt).toMatchObject({ synced: false, sourceVerified: false });
    expect(fake.writes).toBe(1);
    const second = await fastScanExecute(actor, input);
    expect(second.receipt?.eventId).toBe(first.receipt?.eventId);
    expect((second.result as { deduped: boolean }).deduped).toBe(true);
    expect(fake.writes).toBe(1);
    await expect(fastScanExecute(actor, { ...input, snapshot: { ...snapshot, snapshotId: "SNAP-2" } }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(fake.writes).toBe(1);
  });

  it("回执查询区分尚未写入与已保存；写库失败不会伪造成功", async () => {
    const key = "request-002";
    const pending = await fastScanReceipt(actor, { idempotencyKey: key });
    expect(pending.status).toBe("pending");
    expect(pending.receipt).toBeUndefined();
    fake.failWrite = true;
    await expect(fastScanExecute(actor, { snapshot, timeBudgetMinutes: 30, idempotencyKey: key })).rejects.toThrow("database unavailable");
    expect((await fastScanReceipt(actor, { idempotencyKey: key })).status).toBe("pending");
    fake.failWrite = false;
    await fastScanExecute(actor, { snapshot, timeBudgetMinutes: 30, idempotencyKey: key });
    const found = await fastScanReceipt(actor, { idempotencyKey: key });
    expect(found.status).toBe("succeeded");
    expect(found.receipt?.sourceVerified).toBe(false);
    expect((found.result as { report: { snapshotId: string } }).report.snapshotId).toBe("SNAP-1");
  });
});
