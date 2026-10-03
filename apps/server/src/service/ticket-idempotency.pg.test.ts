/**
 * MC-011：C 端建单幂等的真实 PostgreSQL 回归。
 * HTTP 走真实会话、网关和应用角色；owner 只建合成 fixture、注入故障和直查证据。
 * 不计算被测摘要作为预期值，依据响应、唯一实体及实际事件/通知数量判断结果。
 * 运行器必须提供隔离数据库；所有数据均为带随机前缀的 test-only fixture。
 */
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, getAppPool, getGatewayPool } from "@workloom/db";
import { serviceTx } from "./events.js";
import { advanceTicket, completeTicket, type Ticket } from "./ticket.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1"
  && Boolean(process.env.DATABASE_URL)
  && Boolean(process.env.DATABASE_APP_URL)
  && Boolean(process.env.DATABASE_GATEWAY_URL);

interface CreateBody {
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  conversationId?: string;
}
interface Reply {
  ticket?: Ticket;
  conversationId?: string;
  idempotentReplay?: boolean;
  deduped?: boolean;
  requestId?: string;
  error?: string;
  receipt?: { eventId?: string; delivery?: unknown; idempotentReplay?: boolean; resourceId?: string };
}
interface ResponseEvidence { status: number; body: Reply }
interface Effects {
  tickets: number; creates: number; assignments: number; businessCreates: number; notifications: number;
}

describe.runIf(RUN_DB)("MC-011 C 工单幂等 PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const tenantA = `it-tid-tenant-a-${suffix}`;
  const tenantB = `it-tid-tenant-b-${suffix}`;
  const workspaceA = `it-tid-ws-a-${suffix}`;
  const workspaceB = `it-tid-ws-b-${suffix}`;
  const siteA = `ticket-a-${suffix}`;
  const siteB = `ticket-b-${suffix}`;
  const envKeys = ["SERVICE_C_WORKSPACE_ID", "SERVICE_C_WORKSPACE_MAP", "SERVICE_C_DEMO_AUTH"] as const;
  const previousEnv = new Map(envKeys.map((name) => [name, process.env[name]]));
  let owner: pg.Pool;
  let gateway: Hono;

  function evidence(name: string, value: unknown): void {
    // 工单及响应仅含本文件生成的合成业务数据；会话 token 永不进入取证输出。
    console.info(`MC-011 evidence ${JSON.stringify({ name, value })}`);
  }

  async function request(path: string, token?: string, body?: unknown): Promise<ResponseEvidence> {
    const response = await gateway.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "198.51.100.119", // TEST-NET-2
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Reply };
  }

  async function session(label: string, workspaceKey = siteA): Promise<{ token: string; userId: string }> {
    const response = await gateway.request("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.119" },
      body: JSON.stringify({ channel: "h5", openid: `it-tid-${suffix}-${label}`, workspaceKey }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { token: string; user: { id: string } };
    expect(typeof body.token).toBe("string");
    expect(typeof body.user.id).toBe("string");
    return { token: body.token, userId: body.user.id };
  }

  function input(label: string): CreateBody {
    return {
      kind: "repair", title: `test-only 工单 ${suffix} ${label}`,
      payload: { room: "test-only-8808", details: { a: 1, b: ["甲", "乙"] } },
      idempotencyKey: `it-tid-${suffix}-${label}`,
    };
  }

  function accepted(response: ResponseEvidence): Ticket {
    expect(response.status).toBe(200);
    expect(response.body.ticket?.id).toEqual(expect.any(String));
    return response.body.ticket!;
  }

  function conflict(response: ResponseEvidence, original: Pick<Ticket, "id" | "cUserId" | "title">): void {
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "工单幂等键已被占用，请使用新键重试", requestId: expect.any(String),
    });
    const serialized = JSON.stringify(response.body);
    for (const privateValue of [original.id, original.cUserId, original.title, "test-only-8808"]) {
      if (privateValue) expect(serialized).not.toContain(privateValue);
    }
  }

  async function effects(body: CreateBody, workspaceId = workspaceA): Promise<Effects> {
    const result = await owner.query<Effects>(
      `SELECT
         (SELECT count(*)::int FROM c_tickets WHERE workspace_id=$1 AND idempotency_key=$2) AS tickets,
         (SELECT count(*)::int FROM c_ticket_events e JOIN c_tickets t ON t.id=e.ticket_id
          WHERE e.workspace_id=$1 AND t.workspace_id=$1 AND t.idempotency_key=$2
            AND e.action IN ('create','created')) AS creates,
         (SELECT count(*)::int FROM c_ticket_events e JOIN c_tickets t ON t.id=e.ticket_id
          WHERE e.workspace_id=$1 AND t.workspace_id=$1 AND t.idempotency_key=$2
            AND e.action='assign') AS assignments,
         (SELECT count(*)::int FROM biz_events
          WHERE workspace_id=$1 AND payload#>>'{decision,action}'='service.ticket.create'
            AND payload#>>'{decision,after,title}'=$3) AS "businessCreates",
         (SELECT count(*)::int FROM c_notifications
          WHERE workspace_id=$1 AND kind='ticket.accepted' AND payload->>'title'=$3) AS notifications`,
      [workspaceId, body.idempotencyKey, body.title],
    );
    return result.rows[0]!;
  }

  const once: Effects = { tickets: 1, creates: 1, assignments: 1, businessCreates: 1, notifications: 1 };
  const none: Effects = { tickets: 0, creates: 0, assignments: 0, businessCreates: 0, notifications: 0 };

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO tenants (id,name,plan) VALUES ($1,'test-only ticket A','pro'),($2,'test-only ticket B','pro')", [tenantA, tenantB]);
      await client.query(
        `INSERT INTO workspaces (id,tenant_id,name,slug,industry,is_example)
         VALUES ($1,$2,'test-only ticket A',$3,'general',true),($4,$5,'test-only ticket B',$6,'general',true)`,
        [workspaceA, tenantA, siteA, workspaceB, tenantB, siteB],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    delete process.env.SERVICE_C_WORKSPACE_ID;
    process.env.SERVICE_C_WORKSPACE_MAP = JSON.stringify({ [siteA]: workspaceA, [siteB]: workspaceB });
    process.env.SERVICE_C_DEMO_AUTH = "true";
    ({ serviceGateway: gateway } = await import("./gateway.js"));
    for (const [pool, expectedRole] of [[getAppPool(), "workloom_app"], [getGatewayPool(), "workloom_gateway"]] as const) {
      const role = await pool.query<{ role: string; superuser: boolean; bypassrls: boolean }>(
        "SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypassrls FROM pg_roles WHERE rolname=current_user",
      );
      expect(role.rows).toEqual([{ role: expectedRole, superuser: false, bypassrls: false }]);
      evidence("database-role", role.rows[0]);
    }
  });

  afterAll(async () => {
    for (const name of envKeys) {
      const value = previousEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // 追加账本不删改；runner 在取证后销毁自己创建的整个隔离集群。
    try {
      await closeAllPools();
    } finally {
      await owner?.end();
    }
  });

  it("跨 C 用户同键返回 409、不泄露原单且无任何工单副作用", async () => {
    const a = await session("cross-user-owner");
    const b = await session("cross-user-other");
    const body = input("cross-user");
    const original = accepted(await request("/tickets", a.token, body));
    const replay = await request("/tickets", b.token, body);
    evidence("cross-user-http", replay);
    conflict(replay, original);
    const deniedRead = await request(`/tickets/${original.id}`, b.token);
    expect(deniedRead.status).toBe(404);
    expect(JSON.stringify(deniedRead.body)).not.toContain(original.title);
    expect(accepted(await request("/tickets", a.token, body)).id).toBe(original.id);
    expect(await effects(body)).toEqual(once);
    evidence("cross-user-db", await effects(body));
  });

  it.each([
    ["kind", (body: CreateBody) => ({ ...body, kind: "delivery" })],
    ["title", (body: CreateBody) => ({ ...body, title: `${body.title} changed` })],
    ["nested-value", (body: CreateBody) => ({ ...body, payload: { ...body.payload, details: { a: 2, b: ["甲", "乙"] } } })],
    ["array-order", (body: CreateBody) => ({ ...body, payload: { ...body.payload, details: { a: 1, b: ["乙", "甲"] } } })],
    ["added-field", (body: CreateBody) => ({ ...body, payload: { ...body.payload, extra: "new" } })],
    ["removed-field", (body: CreateBody) => ({ ...body, payload: {} })],
  ] as const)("同用户同键内容改变 %s 返回 409 且原始建单不变", async (label, change) => {
    const a = await session(`content-${label}`);
    const body = input(`content-${label}`);
    const original = accepted(await request("/tickets", a.token, body));
    const replay = await request("/tickets", a.token, change(body));
    evidence(`content-${label}-http`, replay);
    conflict(replay, original);
    expect(accepted(await request("/tickets", a.token, body)).id).toBe(original.id);
    expect(await effects(body)).toEqual(once);
  });

  it("嵌套对象键序、特殊字符和空对象正确重放；新键建立另一张单", async () => {
    const a = await session("canonical");
    const body = {
      ...input("canonical"),
      payload: { empty: {}, text: "引号\" 换行\n 反斜线\\ Unicode😀", detail: { z: [1, { b: 2, a: 3 }], a: null } },
    };
    const original = accepted(await request("/tickets", a.token, body));
    const reordered = {
      ...body,
      payload: { detail: { a: null, z: [1, { a: 3, b: 2 }] }, text: body.payload.text, empty: {} },
    };
    const replay = await request("/tickets", a.token, reordered);
    expect(accepted(replay).id).toBe(original.id);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.receipt).not.toHaveProperty("eventId");
    expect(replay.body.receipt).not.toHaveProperty("delivery");
    expect(await effects(body)).toEqual(once);
    const distinct = { ...reordered, idempotencyKey: `${body.idempotencyKey}-new` };
    expect(accepted(await request("/tickets", a.token, distinct)).id).not.toBe(original.id);
    expect(await effects(distinct)).toEqual({ ...once, businessCreates: 2, notifications: 2 });
    const empty = { ...input("empty"), payload: {} };
    const emptyOriginal = accepted(await request("/tickets", a.token, empty));
    expect(accepted(await request("/tickets", a.token, empty)).id).toBe(emptyOriginal.id);
    expect(await effects(empty)).toEqual(once);
  });

  it("同一幂等键在另一个租户工作区可建单，RLS 与 C 端详情仍隔离", async () => {
    const a = await session("workspace-a");
    const b = await session("workspace-b", siteB);
    const body = input("workspace-key");
    const first = accepted(await request("/tickets", a.token, body));
    const second = accepted(await request("/tickets", b.token, body));
    expect(second.id).not.toBe(first.id);
    expect(second.workspaceId).toBe(workspaceB);
    expect(second.cUserId).toBe(b.userId);
    expect((await request(`/tickets/${first.id}`, b.token)).status).toBe(404);
    const hidden = await serviceTx(workspaceB, (client) => client.query(
      "SELECT id FROM c_tickets WHERE workspace_id=$1 AND id=$2", [workspaceA, first.id],
    ));
    expect(hidden.rows).toEqual([]);
    expect(await effects(body, workspaceA)).toEqual(once);
    expect(await effects(body, workspaceB)).toEqual(once);
    evidence("workspace-isolation", { workspaceA: await effects(body), workspaceB: await effects(body, workspaceB), rlsRows: hidden.rows });
  });

  it("聊天确认重试产生新会话仍重放原单，跨用户或异内容仍拒绝", async () => {
    const a = await session("chat-owner");
    const b = await session("chat-other");
    const body = input("chat");
    const chat = { text: "好的确认提交", confirmTicket: true, idempotencyKey: body.idempotencyKey, ticketDraft: { kind: body.kind, title: body.title, payload: body.payload } };
    const first = await request("/chat", a.token, chat);
    const original = accepted(first);
    expect(first.body.conversationId).toEqual(expect.any(String));
    const replay = await request("/chat", a.token, chat);
    expect(accepted(replay).id).toBe(original.id);
    expect(replay.body.conversationId).not.toBe(first.body.conversationId);
    expect(replay.body.deduped).toBe(true);
    expect(replay.body.ticket?.conversationId).toBe(first.body.conversationId);
    const crossUser = await request("/chat", b.token, chat);
    evidence("chat-cross-user-http", crossUser);
    conflict(crossUser, original);
    const changed = await request("/chat", a.token, { ...chat, ticketDraft: { ...chat.ticketDraft, payload: { changed: true } } });
    conflict(changed, original);
    expect(await effects(body)).toEqual(once);
    evidence("chat-db", await effects(body));
  });

  it("完成与评分改变当前 payload 后，原请求仍可安全重放且建单摘要不改写", async () => {
    const a = await session("rating");
    const body = input("rating");
    const original = accepted(await request("/tickets", a.token, body));
    const creationBefore = await owner.query("SELECT detail FROM c_ticket_events WHERE workspace_id=$1 AND ticket_id=$2 AND action='create'", [workspaceA, original.id]);
    await advanceTicket({ workspaceId: workspaceA, ticketId: original.id, action: "start", actorType: "staff", actorId: "test-only-worker" });
    await completeTicket({ workspaceId: workspaceA, ticketId: original.id, result: "test-only completed", actorId: "test-only-worker" });
    const rating = await request(`/tickets/${original.id}/rate`, a.token, { score: 5, comment: "test-only rating" });
    expect(accepted(rating).payload).toMatchObject({ rating: { score: 5, comment: "test-only rating" } });
    const replay = await request("/tickets", a.token, body);
    expect(accepted(replay)).toMatchObject({ id: original.id, status: "done", ratingScore: 5 });
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.receipt).not.toHaveProperty("eventId");
    expect(replay.body.receipt).not.toHaveProperty("delivery");
    const creationAfter = await owner.query("SELECT detail FROM c_ticket_events WHERE workspace_id=$1 AND ticket_id=$2 AND action='create'", [workspaceA, original.id]);
    expect(creationAfter.rows).toEqual(creationBefore.rows);
    expect(creationAfter.rows[0]?.detail.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await effects(body)).toEqual(once);
    evidence("rating-replay-db", { effects: await effects(body), creationUnchanged: true });
  });

  it.each(["missing-summary", "missing-event", "different-actor"] as const)("历史建单 %s 无法核验时 409 失败关闭", async (variant) => {
    const a = await session(`legacy-${variant}`);
    const body = input(`legacy-${variant}`);
    const id = `it-tid-legacy-${suffix}-${variant}`;
    let detail: Record<string, unknown> = { kind: body.kind, title: body.title };
    if (variant === "different-actor") {
      // 复制另一张合法建单的原始摘要（请求相同、键不同），只把合成事件的操作者换掉。
      // 这样 actor 检查与摘要检查有独立的失败信号，无需在测试里复刻摘要算法。
      const sample = accepted(await request("/tickets", a.token, { ...body, idempotencyKey: `${body.idempotencyKey}-sample` }));
      const creation = await owner.query<{ detail: Record<string, unknown> }>(
        "SELECT detail FROM c_ticket_events WHERE workspace_id=$1 AND ticket_id=$2 AND action='create'", [workspaceA, sample.id],
      );
      detail = creation.rows[0]!.detail;
    }
    const fixture = await owner.query(
      `INSERT INTO c_tickets (id,workspace_id,c_user_id,kind,title,payload,idempotency_key,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'assigned') RETURNING *`,
      [id, workspaceA, a.userId, body.kind, body.title, JSON.stringify(body.payload), body.idempotencyKey],
    );
    expect(fixture.rows).toHaveLength(1);
    if (variant !== "missing-event") {
      await owner.query(
        `INSERT INTO c_ticket_events (workspace_id,ticket_id,action,actor_type,actor_id,detail)
         VALUES ($1,$2,'create','c_user',$3,$4)`,
        [workspaceA, id, variant === "different-actor" ? "test-only-other-actor" : a.userId,
          JSON.stringify(detail)],
      );
    }
    const before = await effects(body);
    const denied = await request("/tickets", a.token, body);
    evidence(`legacy-${variant}-http`, denied);
    conflict(denied, { id, cUserId: a.userId, title: body.title });
    expect(await effects(body)).toEqual(before);
  });

  it("24 路并发同用户同键只生成一单、一组事件和一条通知", async () => {
    const a = await session("parallel");
    const body = input("parallel");
    const replies = await Promise.all(Array.from({ length: 24 }, () => request("/tickets", a.token, body)));
    const tickets = replies.map(accepted);
    expect(new Set(tickets.map((ticket) => ticket.id)).size).toBe(1);
    expect(replies.filter((reply) => reply.body.idempotentReplay)).toHaveLength(23);
    expect(replies.filter((reply) => reply.body.receipt?.eventId)).toHaveLength(1);
    expect(replies.filter((reply) => reply.body.receipt?.delivery)).toHaveLength(1);
    expect(await effects(body)).toEqual(once);
    evidence("parallel-24", { statuses: replies.map((reply) => reply.status), uniqueTickets: 1, replayCount: 23, effects: await effects(body) });
  });

  it.each(["creation-event", "business-event"] as const)("%s 写入失败回滚全部工单副作用，去掉故障后同键可重新建单", async (point) => {
    const a = await session(`rollback-${point}`);
    const body = input(`rollback-${point}`);
    const name = `it_tid_${suffix}_${point.replaceAll("-", "_")}`;
    const table = point === "creation-event" ? "c_ticket_events" : "biz_events";
    const predicate = point === "creation-event"
      ? `NEW.workspace_id='${workspaceA}' AND NEW.action='create' AND NEW.detail->>'title'='${body.title}'`
      : `NEW.workspace_id='${workspaceA}' AND NEW.payload#>>'{decision,action}'='service.ticket.create' AND NEW.payload#>>'{decision,after,title}'='${body.title}'`;
    // 名称、条件只由 UUID/固定 test-only 标签生成；不使用任何客户输入。
    await owner.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${predicate} THEN RAISE EXCEPTION 'test-only ticket idempotency injected failure'; END IF; RETURN NEW; END $$`);
    try {
      await owner.query(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      try {
        const failed = await request("/tickets", a.token, body);
        evidence(`rollback-${point}-http`, failed);
        expect(failed).toEqual({ status: 500, body: { error: "服务内部错误", requestId: expect.any(String) } });
        expect(await effects(body)).toEqual(none);
        evidence(`rollback-${point}-db`, await effects(body));
      } finally {
        await owner.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
      }
    } finally {
      await owner.query(`DROP FUNCTION IF EXISTS ${name}()`);
    }
    const retry = await request("/tickets", a.token, body);
    accepted(retry);
    expect(retry.body.receipt?.idempotentReplay).toBe(false);
    expect(await effects(body)).toEqual(once);
  });

  it("缺少或无效 C 令牌不触发建单，合法身份在标题边界仍可重放", async () => {
    const body = { ...input("auth-boundary"), title: "测".repeat(120), payload: {} };
    expect((await request("/tickets", undefined, body)).status).toBe(401);
    expect((await request("/tickets", "test-only-invalid-token", body)).status).toBe(401);
    expect(await effects(body)).toEqual(none);
    const a = await session("auth-boundary");
    const original = accepted(await request("/tickets", a.token, body));
    expect(accepted(await request("/tickets", a.token, body)).id).toBe(original.id);
    expect(await effects(body)).toEqual(once);
  });
});
