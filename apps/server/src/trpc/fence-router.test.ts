import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@workloom/base/tenancy";
import { fenceActivationFromProposal } from "@workloom/base/fence-engine";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  currentMemberAuthority: vi.fn(),
  gatewayAppendOnClient: vi.fn(),
}));

vi.mock("@workloom/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workloom/db")>();
  return {
    ...actual,
    getAppPool: () => ({ connect: mocks.connect }),
  };
});
vi.mock("../service/access-authority.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../service/access-authority.js")>();
  return { ...actual, currentMemberAuthority: mocks.currentMemberAuthority };
});
vi.mock("@workloom/base/workdata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workloom/base/workdata")>();
  return { ...actual, gatewayAppendOnClient: mocks.gatewayAppendOnClient };
});

import { appRouter } from "./router.js";
import type { TrpcContext } from "./context.js";

interface RuleRow {
  id: string;
  ruleId: string;
  workspaceId: string;
  version: string;
  baseline: boolean;
}
interface QueryCall {
  clientId: number;
  sql: string;
  params: unknown[];
}
interface PendingTransaction {
  rules: RuleRow[];
  dryRunStatus: string;
  events: number;
  approvals: number;
}

const identity: Identity = {
  kind: "member", memberId: "mem-owner", memberNo: "MEM-001", name: "负责人",
  role: "owner", plan: "pro", tenantId: "tenant-1", workspaceId: "ws-yunqi",
};
const input = {
  dryRunId: "DR-001",
  rule: {
    ruleId: "R7", name: "返佣上限", level: "review" as const,
    objectTypes: ["order"], actions: ["rebate.write"], when: "rebate > 20",
  },
};
const context: TrpcContext = { session: identity, identity, partnerIdentity: null, headers: new Headers() };
const state = {
  rules: [] as RuleRow[],
  calls: [] as QueryCall[],
  released: [] as number[],
  dryRunStatus: "pending",
  collisions: 0,
  events: 0,
  approvals: 0,
  transactions: new Map<unknown, PendingTransaction>(),
  failure: "" as "" | "confirm" | "history" | "insert" | "event" | "approval" | "commit",
};

function queryStage(sql: string): typeof state.failure {
  if (sql === "COMMIT") return "commit";
  if (sql.startsWith("UPDATE fence_dry_runs")) return "confirm";
  if (sql.startsWith("SELECT version, is_baseline FROM fence_rules")) return "history";
  if (sql.startsWith("INSERT INTO fence_rules")) return "insert";
  if (sql.startsWith("INSERT INTO approvals")) return "approval";
  return "";
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rules = [
    { id: "fr-r7-v1-global", ruleId: "R7", workspaceId: "*", version: "hotel-baseline/v1", baseline: true },
    { id: "fr-r7-v3-ws-yunqi", ruleId: "R7", workspaceId: identity.workspaceId, version: "v3", baseline: false },
    { id: "fr-r7-v99-other", ruleId: "R7", workspaceId: "ws-other", version: "v99", baseline: false },
  ];
  state.calls = [];
  state.released = [];
  state.dryRunStatus = "pending";
  state.collisions = 0;
  state.events = 0;
  state.approvals = 0;
  state.transactions.clear();
  state.failure = "";
  mocks.currentMemberAuthority.mockResolvedValue({ identity, permissions: {} });
  let clientId = 0;
  mocks.connect.mockImplementation(async () => {
    const id = ++clientId;
    const client = {
      query: async (rawSql: string, params: unknown[] = []) => {
        const sql = rawSql.replace(/\s+/g, " ").trim();
        state.calls.push({ clientId: id, sql, params });
        const stage = queryStage(sql);
        if (stage && state.failure === stage && (stage !== "commit" || state.transactions.get(client)?.events)) {
          throw new Error(`database unavailable: ${stage}`);
        }
        if (sql === "BEGIN") {
          state.transactions.set(client, { rules: [], dryRunStatus: state.dryRunStatus, events: 0, approvals: 0 });
          return { rows: [], rowCount: 0 };
        }
        const transaction = state.transactions.get(client);
        if (sql === "COMMIT") {
          if (!transaction) throw new Error("COMMIT without transaction in fence-router test");
          state.dryRunStatus = transaction.dryRunStatus;
          state.rules.push(...transaction.rules);
          state.events += transaction.events;
          state.approvals += transaction.approvals;
          state.transactions.delete(client);
          return { rows: [], rowCount: 0 };
        }
        if (sql === "ROLLBACK") {
          state.transactions.delete(client);
          return { rows: [], rowCount: 0 };
        }
        if (!transaction) throw new Error(`query without transaction in fence-router test: ${sql}`);
        if (sql.startsWith("SELECT set_config")) {
          return { rows: [], rowCount: 0 };
        }
        if (stage === "confirm") {
          if (params[0] !== input.dryRunId || params[1] !== identity.workspaceId || transaction.dryRunStatus !== "pending") {
            return { rows: [], rowCount: 0 };
          }
          transaction.dryRunStatus = "confirmed";
          return { rows: [], rowCount: 1 };
        }
        if (stage === "history") {
          const rows = [...state.rules, ...transaction.rules].filter((row) => (row.workspaceId === params[0] || row.workspaceId === "*")
            && row.ruleId.toLowerCase() === String(params[1]).toLowerCase());
          return { rows: rows.map((row) => ({ version: row.version, is_baseline: row.baseline })), rowCount: rows.length };
        }
        if (stage === "insert") {
          const row: RuleRow = {
            id: String(params[0]), ruleId: String(params[1]), version: String(params[2]),
            workspaceId: String(params[3]), baseline: false,
          };
          if (state.collisions > 0) {
            state.collisions -= 1;
            state.rules.push(row);
            return { rows: [], rowCount: 0 };
          }
          if ([...state.rules, ...transaction.rules].some((stored) => stored.id === row.id)) return { rows: [], rowCount: 0 };
          transaction.rules.push(row);
          return { rows: [], rowCount: 1 };
        }
        if (stage === "approval") {
          transaction.approvals += 1;
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unhandled query in fence-router test: ${sql}`);
      },
      release: () => { state.released.push(id); },
    };
    return client;
  });
  mocks.gatewayAppendOnClient.mockImplementation(async (client) => {
    if (state.failure === "event") throw new Error("database unavailable: event");
    const transaction = state.transactions.get(client);
    if (!transaction) throw new Error("event outside proposal transaction in fence-router test");
    transaction.events += 1;
    return { eventId: "E-PROPOSAL-001" };
  });
});

function proposalAfter(): Record<string, unknown> {
  const event = mocks.gatewayAppendOnClient.mock.calls[0]?.[2] as { decision: { after: Record<string, unknown> } };
  return event.decision.after;
}

describe("酒店围栏提案的版本化契约", () => {
  it("从当前工作区真实历史分配版本，规则行、提案和审批快照共用同一身份", async () => {
    await expect(appRouter.createCaller(context).fence.confirmDryRun(input)).resolves.toEqual({
      proposed: true, eventId: "E-PROPOSAL-001",
    });
    const inserted = state.calls.find((call) => call.sql.startsWith("INSERT INTO fence_rules"));
    expect(inserted?.params).toEqual([
      "fr-r7-v4-ws-yunqi", "R7", "v4", identity.workspaceId, input.rule.name, input.rule.level,
      JSON.stringify({ object_types: input.rule.objectTypes, actions: input.rule.actions, when: input.rule.when }),
      JSON.stringify({ result: input.rule.level }), identity.memberNo,
    ]);
    expect(proposalAfter()).toMatchObject({ ruleRowId: "fr-r7-v4-ws-yunqi", version: "v4", dryRunId: input.dryRunId });
    expect(fenceActivationFromProposal({ decision: { action: "fence.rule.propose", after: proposalAfter() } }, identity.workspaceId))
      .toEqual({ ruleRowId: "fr-r7-v4-ws-yunqi", dryRunId: input.dryRunId });
    const approval = state.calls.find((call) => call.sql.startsWith("INSERT INTO approvals"));
    expect(JSON.parse(String(approval?.params[4]))).toMatchObject({
      ruleRowId: "fr-r7-v4-ws-yunqi", version: "v4", high_risk: true,
    });
    expect(state.released).toEqual([1]);
    expect(state.dryRunStatus).toBe("confirmed");
    expect(state.events).toBe(1);
    expect(state.approvals).toBe(1);
  });

  it("无历史版本时从 v1 开始，不接受客户端伪造的版本或行 ID", async () => {
    state.rules = [];
    await appRouter.createCaller(context).fence.confirmDryRun({
      ...input, rule: { ...input.rule, version: "v99", ruleRowId: "fr-forged" },
    } as typeof input);
    expect(proposalAfter()).toMatchObject({ version: "v1", ruleRowId: "fr-r7-v1-ws-yunqi" });
  });

  it("中文、引号和换行保留在参数载荷中，不拼接进 SQL", async () => {
    const rule = { ...input.rule, name: "返佣 'VIP' \"客户\"\n复核", when: "note == \"O'Reilly\\n\"" };
    await appRouter.createCaller(context).fence.confirmDryRun({ ...input, rule });
    const inserted = state.calls.find((call) => call.sql.startsWith("INSERT INTO fence_rules"));
    expect(inserted?.sql).not.toContain(rule.name);
    expect(inserted?.params[4]).toBe(rule.name);
    expect(JSON.parse(String(inserted?.params[6]))).toMatchObject({ when: rule.when });
    expect(proposalAfter()).toMatchObject({ name: rule.name, when: rule.when });
  });

  it("并发占用候选版本时重读历史，生成下一版本后再留痕", async () => {
    state.collisions = 1;
    await appRouter.createCaller(context).fence.confirmDryRun(input);
    expect(state.calls.filter((call) => call.sql.startsWith("INSERT INTO fence_rules"))).toHaveLength(2);
    expect(proposalAfter()).toMatchObject({ version: "v5", ruleRowId: "fr-r7-v5-ws-yunqi" });
    expect(mocks.gatewayAppendOnClient).toHaveBeenCalledTimes(1);
  });

  it("候选版本连续冲突时回滚并返回 CONFLICT，不产生审批成功假象", async () => {
    state.collisions = 5;
    await expect(appRouter.createCaller(context).fence.confirmDryRun(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.calls.filter((call) => call.sql.startsWith("INSERT INTO fence_rules"))).toHaveLength(5);
    expect(mocks.gatewayAppendOnClient).not.toHaveBeenCalled();
    expect(state.calls.filter((call) => call.clientId === 1).map((call) => call.sql)).toContain("ROLLBACK");
    expect(state.calls.filter((call) => call.clientId === 1).map((call) => call.sql)).not.toContain("COMMIT");
    expect(state.released).toEqual([1]);
    expect(state.dryRunStatus).toBe("pending");
  });

  it.each(["history", "insert", "event", "approval"] as const)("%s 写入链路异常时回滚提案事务并释放连接", async (failure) => {
    state.failure = failure;
    await expect(appRouter.createCaller(context).fence.confirmDryRun(input)).rejects.toThrow(`database unavailable: ${failure}`);
    const queries = state.calls.filter((call) => call.clientId === 1).map((call) => call.sql);
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(state.released).toEqual([1]);
  });

  it("dry-run 非 pending 时拒绝，不继续分配规则版本", async () => {
    state.dryRunStatus = "confirmed";
    await expect(appRouter.createCaller(context).fence.confirmDryRun(input)).rejects.toThrow("非 pending");
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayAppendOnClient).not.toHaveBeenCalled();
    expect(state.released).toEqual([1]);
  });

  it("确认连接不可用时传播错误，不尝试提案或生成事件", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("pool unavailable"));
    await expect(appRouter.createCaller(context).fence.confirmDryRun(input)).rejects.toThrow("pool unavailable");
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayAppendOnClient).not.toHaveBeenCalled();
    expect(state.released).toEqual([]);
  });

  it("未认证调用在接触数据库之前拒绝", async () => {
    await expect(appRouter.createCaller({ ...context, identity: null, session: null }).fence.confirmDryRun(input))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["readonly", {}],
    ["owner", { deny: ["guardrail.manage"] }],
  ] as const)("%s 或显式 deny 在接触数据库之前拒绝", async (role, permissions) => {
    mocks.currentMemberAuthority.mockResolvedValue({ identity: { ...identity, role }, permissions });
    await expect(appRouter.createCaller(context).fence.confirmDryRun(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("非法级别在规则或事件写入之前拒绝", async () => {
    await expect(appRouter.createCaller(context).fence.confirmDryRun({ ...input, rule: { ...input.rule, level: "unsafe" } } as never))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

describe("MC-009/109 酒店 dry-run 与规则、事件、审批原子提交", () => {
  it("确认、取号、规则插入、网关事件和审批只有一次 COMMIT，全部使用同一连接", async () => {
    await appRouter.createCaller(context).fence.confirmDryRun(input);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(new Set(state.calls.map((call) => call.clientId))).toEqual(new Set([1]));
    const queries = state.calls.map((call) => call.sql);
    expect(queries.filter((sql) => sql === "BEGIN")).toHaveLength(1);
    expect(queries.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    const confirmation = queries.findIndex((sql) => sql.startsWith("UPDATE fence_dry_runs"));
    expect(queries.slice(0, confirmation)).toEqual([
      "BEGIN",
      "SELECT set_config('app.workspace_id', $1, true)",
      "SELECT set_config('app.tenant_id', $1, true)",
    ]);
    expect(queries[confirmation + 1]).toMatch(/^SELECT version, is_baseline/);
    expect(queries.at(-1)).toBe("COMMIT");
    expect(state.transactions.size).toBe(0);
  });

  it.each(["history", "insert", "event", "approval", "commit"] as const)(
    "%s 失败后报告仍 pending 且无孤儿，解除故障可按同一 dryRunId 成功重试",
    async (failure) => {
      const rulesBefore = [...state.rules];
      state.failure = failure;
      await expect(appRouter.createCaller(context).fence.confirmDryRun(input))
        .rejects.toThrow(`database unavailable: ${failure}`);
      expect(state.dryRunStatus).toBe("pending");
      expect(state.rules).toEqual(rulesBefore);
      expect(state.events).toBe(0);
      expect(state.approvals).toBe(0);
      expect(state.transactions.size).toBe(0);

      state.failure = "";
      await expect(appRouter.createCaller(context).fence.confirmDryRun(input)).resolves.toMatchObject({ proposed: true });
      expect(state.dryRunStatus).toBe("confirmed");
      expect(state.rules).toHaveLength(rulesBefore.length + 1);
      expect(state.events).toBe(1);
      expect(state.approvals).toBe(1);
      const inserted = state.rules.at(-1);
      expect(inserted).toMatchObject({ id: "fr-r7-v4-ws-yunqi", version: "v4" });
      expect(state.released).toEqual([1, 2]);
    },
  );

  it("确认 UPDATE 本身失败时回滚，不创建规则、事件或审批", async () => {
    state.failure = "confirm";
    await expect(appRouter.createCaller(context).fence.confirmDryRun(input)).rejects.toThrow("database unavailable: confirm");
    expect(state.dryRunStatus).toBe("pending");
    expect(state.calls.map((call) => call.sql)).toContain("ROLLBACK");
    expect(state.calls.some((call) => call.sql.startsWith("SELECT version, is_baseline"))).toBe(false);
    expect(state.events).toBe(0);
    expect(state.approvals).toBe(0);
    expect(state.released).toEqual([1]);
  });

  it("已经提交的报告重复确认仍被拒绝，不产生第二套规则或审批", async () => {
    await appRouter.createCaller(context).fence.confirmDryRun(input);
    await expect(appRouter.createCaller(context).fence.confirmDryRun(input)).rejects.toThrow("非 pending");
    expect(state.dryRunStatus).toBe("confirmed");
    expect(state.rules).toHaveLength(4);
    expect(state.events).toBe(1);
    expect(state.approvals).toBe(1);
    expect(state.released).toEqual([1, 2]);
  });
});
