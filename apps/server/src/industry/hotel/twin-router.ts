import { z } from "zod";
import { getAppPool } from "@workloom/db";
import { navigationPermissionProcedure, router, scopeOf } from "../../trpc/context.js";

async function queryEventsByActions(
  scope: { tenantId: string; workspaceId: string },
  actions: string[],
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const app = getAppPool();
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM biz_events
       WHERE workspace_id=$1 AND payload->'decision'->>'action' = ANY($2::text[])
       ORDER BY seq DESC LIMIT $3`,
      [scope.workspaceId, actions, limit],
    );
    await client.query("COMMIT");
    return r.rows.map((x) => x.payload);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function readArchive(
  scope: { tenantId: string; workspaceId: string },
): Promise<{ archive: Record<string, unknown>; forbidden: unknown } | null> {
  const client = await getAppPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const result = await client.query<{ archive: Record<string, unknown>; forbidden: unknown }>(
      `SELECT archive, forbidden FROM profiles WHERE workspace_id=$1`,
      [scope.workspaceId],
    );
    await client.query("COMMIT");
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const hotelTwinRouter = router({
  /** P10 断点看板：断点闭环事件（根因四分类）+ 周频断点率周报 */
  incidents: navigationPermissionProcedure("hotel.incidents.read").query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const [incidents, weekly] = await Promise.all([
      queryEventsByActions(scope, ["incident.postmortem"], 50),
      queryEventsByActions(scope, ["incident.weekly.report"], 12),
    ]);
    return { incidents, weekly };
  }),

  /** P11 价格健康：倒挂熔断 / 超售防护 / 修复留痕 / 调价事件流 */
  priceHealth: navigationPermissionProcedure("hotel.price-health.read").query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const [blocks, fixes, adjusts] = await Promise.all([
      queryEventsByActions(scope, ["price.publish", "inventory.sync"], 50),
      queryEventsByActions(scope, ["channel.parity.fixed", "inventory.sync.restore"], 20),
      queryEventsByActions(scope, ["price.adjust"], 30),
    ]);
    return { blocks, fixes, adjusts };
  }),

  /** P12 经营目标：一店一档 goals 字段组 + 周频 goal.tracking 达成追踪 */
  goals: navigationPermissionProcedure("hotel.goals.read").query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const app = getAppPool();
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const prof = await client.query<{ archive: { goals?: unknown } }>(
        `SELECT archive FROM profiles WHERE workspace_id=$1`,
        [scope.workspaceId],
      );
      await client.query("COMMIT");
      const trackings = await queryEventsByActions(scope, ["goal.tracking"], 16);
      return { goals: prof.rows[0]?.archive?.goals ?? null, trackings };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }),

  /** 各能力只暴露自己的固定事件集，客户端不能通过自选 action 横向读取。 */
  orderEvents: navigationPermissionProcedure("hotel.orders.read").query(({ ctx }) => (
    queryEventsByActions(scopeOf(ctx.identity), ["order.confirm", "order.reconcile", "order.refund"], 80)
  )),

  channelOverview: navigationPermissionProcedure("hotel.channels.read").query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const [profile, events] = await Promise.all([
      readArchive(scope),
      queryEventsByActions(scope, ["content.publish", "competitor.fetch"], 40),
    ]);
    return {
      archive: {
        channels: profile?.archive.channels ?? [],
        inspection: profile?.archive.inspection ?? null,
      },
      events,
    };
  }),

  reputationEvents: navigationPermissionProcedure("hotel.reputation.read").query(({ ctx }) => (
    queryEventsByActions(scopeOf(ctx.identity), ["review.reply", "alert.escalate"], 100)
  )),

  voiceFrontOverview: navigationPermissionProcedure("hotel.voice-front.read").query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const [profile, events] = await Promise.all([
      readArchive(scope),
      queryEventsByActions(scope, ["call.summary", "faq.mine"], 100),
    ]);
    return { faqKb: profile?.archive.faq_kb ?? null, events };
  }),

  frontdeskHousekeepingOverview: navigationPermissionProcedure("hotel.frontdesk-housekeeping.read").query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const [profile, events] = await Promise.all([
      readArchive(scope),
      queryEventsByActions(scope, ["pms.checkin", "pms.checkout", "task.complete", "inventory.loss"], 100),
    ]);
    return { linen: profile?.archive.linen ?? null, events };
  }),

  /** 单对象全链穿透（P13 订单/房间时间线：按 object.id 正序回放） */
  objectTrail: navigationPermissionProcedure("hotel.orders.read")
    .input(z.object({ objectId: z.string().min(1).max(64), limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        const r = await client.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM biz_events
           WHERE workspace_id=$1 AND payload->'object'->>'id' = $2
           ORDER BY seq ASC LIMIT $3`,
          [scope.workspaceId, input.objectId, input.limit],
        );
        await client.query("COMMIT");
        return r.rows.map((x) => x.payload);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }),

  /** P20 一店一档全景（21 字段组） */
  archive: navigationPermissionProcedure("hotel.archive.read").query(({ ctx }) => (
    readArchive(scopeOf(ctx.identity))
  )),

  /** P18 多店驾驶舱：同租户各工作区最新经营快照 + 昨夜决策包（逐工作区 RLS 上下文轮询） */
  stores: navigationPermissionProcedure("hotel.stores.read").query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const app = getAppPool();
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const wss = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM workspaces WHERE tenant_id=$1 ORDER BY created_at`,
        [scope.tenantId],
      );
      const out: Array<Record<string, unknown>> = [];
      for (const ws of wss.rows) {
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [ws.id]);
        const daily = await client.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM biz_events
           WHERE workspace_id=$1 AND payload->'decision'->>'action'='store.daily.summary'
           ORDER BY seq DESC LIMIT 1`,
          [ws.id],
        );
        const pkg = await client.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM biz_events
           WHERE workspace_id=$1 AND payload->'decision'->>'action'='night.package.deliver'
           ORDER BY seq DESC LIMIT 1`,
          [ws.id],
        );
        const counts = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM biz_events WHERE workspace_id=$1`,
          [ws.id],
        );
        out.push({
          workspaceId: ws.id, name: ws.name,
          daily: daily.rows[0]?.payload ?? null,
          nightPackage: pkg.rows[0]?.payload ?? null,
          eventCount: Number(counts.rows[0]?.n ?? 0),
        });
      }
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }),

  /** P19 收益分析：预设问数（真实聚合自事件库；自然语言自由查询在 LLM 接线后开放） */
  report: navigationPermissionProcedure("hotel.revenue.read")
    .input(z.object({ question: z.enum(["channel_revenue", "occ_trend", "price_attribution"]) }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      if (input.question === "channel_revenue") {
        const evs = await queryEventsByActions(scope, ["order.confirm"], 200);
        const byChannel = new Map<string, { orders: number; revenue: number }>();
        for (const ev of evs) {
          const ch = String((ev.context as Record<string, unknown>)?.channel ?? "直连");
          const amount = Number(((ev.decision as Record<string, unknown>)?.params as Record<string, unknown>)?.amount ?? 0);
          const cur = byChannel.get(ch) ?? { orders: 0, revenue: 0 };
          cur.orders += 1; cur.revenue += amount;
          byChannel.set(ch, cur);
        }
        return { kind: input.question, rows: [...byChannel.entries()].map(([channel, v]) => ({ channel, ...v })) };
      }
      if (input.question === "occ_trend") {
        const evs = await queryEventsByActions(scope, ["store.daily.summary"], 30);
        const rows = evs
          .map((ev) => ({
            date: String((ev.context as Record<string, unknown>)?.time ?? "").slice(0, 10),
            occ: ((ev.decision as Record<string, unknown>)?.after as Record<string, unknown>)?.occ ?? null,
            adr: ((ev.decision as Record<string, unknown>)?.after as Record<string, unknown>)?.adr ?? null,
            revpar: ((ev.decision as Record<string, unknown>)?.after as Record<string, unknown>)?.revpar ?? null,
          }))
          .reverse();
        return { kind: input.question, rows };
      }
      const evs = await queryEventsByActions(scope, ["price.adjust"], 60);
      const rows = evs.map((ev) => {
        const d = ev.decision as Record<string, unknown>;
        return {
          time: String((ev.context as Record<string, unknown>)?.time ?? ""),
          object: String((ev.object as Record<string, unknown>)?.label ?? (ev.object as Record<string, unknown>)?.id ?? ""),
          before: (d.before as Record<string, unknown>)?.price ?? null,
          after: (d.after as Record<string, unknown>)?.price ?? null,
          rule: (ev.rule_impact as Array<{ rule_id?: string }>)?.[0]?.rule_id ?? "",
          basis: (d.basis as string[]) ?? [],
        };
      });
      return { kind: input.question, rows };
    }),
});
