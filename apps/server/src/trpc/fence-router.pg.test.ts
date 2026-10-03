/**
 * MC-009/109：实际酒店 router + 成员权威 + 安全网关的 PostgreSQL 原子性回归。
 * 只能由 work/fence-atomicity-pg-run.py 创建的隔离 Unix fixture 启用；普通 test 不接库。
 * 测试故障使用真实 DB 权限错误、触发器异常和延迟约束触发器 COMMIT 异常。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import pg from "pg";
import type { Identity } from "@workloom/base/tenancy";
import type { TrpcContext } from "./context.js";
import type { AppRouter } from "./router.js";
import type { inferRouterInputs } from "@trpc/server";

const RUN = process.env.RUN_FENCE_ATOMICITY_DB_TESTS === "1";
type ProposalInput = inferRouterInputs<AppRouter>["fence"]["confirmDryRun"];
type Caller = ReturnType<AppRouter["createCaller"]>;
type FailureStage = "confirm" | "history" | "insert" | "event" | "approval" | "commit";
interface EvidenceCase {
  id: string;
  preconditions: string[];
  steps: string[];
  expected: string[];
  actual: unknown;
  evidence_grade: "B";
}
interface ProposalState {
  status: string | null;
  rules: Array<{ id: string; version: string; status: string; is_baseline: boolean }>;
  events: Array<{ event_id: string; payload: { decision: { after: Record<string, unknown> } } }>;
  approvals: Array<{ event_id: string; status: string; snapshot: Record<string, unknown> }>;
}

const scopeA = { tenantId: "tenant-fence-a", workspaceId: "ws-fence-a" };
const scopeB = { tenantId: "tenant-fence-b", workspaceId: "ws-fence-b" };
const identityA: Identity = {
  kind: "member", memberId: "mem-fence-a-owner", memberNo: "MEM-901", name: "合成负责人甲",
  role: "owner", plan: "pro", ...scopeA,
};
const identityB: Identity = {
  kind: "member", memberId: "mem-fence-b-owner", memberNo: "MEM-902", name: "合成负责人乙",
  role: "owner", plan: "pro", ...scopeB,
};
const context = (identity: Identity): TrpcContext => ({ session: identity, identity, partnerIdentity: null, headers: new Headers() });

describe.skipIf(!RUN)("MC-009/109 PostgreSQL：dry-run / 规则 / 事件 / 审批同生同灭", () => {
  let owner: pg.Pool | undefined;
  let app: pg.Pool;
  let callerA: Caller;
  let callerB: Caller;
  let appRouter: AppRouter;
  let closeAllPools: () => Promise<void>;
  let eventHash: (previous: string, payload: unknown) => string;
  const cases: EvidenceCase[] = [];
  let reportNo = 0;

  function record(entry: Omit<EvidenceCase, "evidence_grade">): void {
    const evidence: EvidenceCase = { ...entry, evidence_grade: "B" };
    cases.push(evidence);
    console.log(JSON.stringify(evidence));
  }

  function errorInfo(error: unknown): { code: string | null; message: string; causeCode: string | null } {
    const value = error as { code?: string; message?: string; cause?: { code?: string } };
    return { code: value?.code ?? null, message: value?.message ?? String(error), causeCode: value?.cause?.code ?? null };
  }

  async function attempt(caller: Caller, input: ProposalInput) {
    try {
      return { ok: true as const, value: await caller.fence.confirmDryRun(input) };
    } catch (error) {
      return { ok: false as const, error: errorInfo(error) };
    }
  }

  async function pending(ruleId: string, scope = scopeA): Promise<ProposalInput> {
    const dryRunId = `fdr-fixture-${ruleId.toLowerCase()}-${++reportNo}`;
    await owner!.query(
      `INSERT INTO fence_dry_runs (id, workspace_id, rule_id, rule_version, report, status, created_by)
       VALUES ($1,$2,$3,'v-next',$4,'pending','fixture-owner')`,
      [dryRunId, scope.workspaceId, ruleId, JSON.stringify({ replayed: 0, wouldBlock: [], wouldReview: [], unchanged: 0 })],
    );
    return {
      dryRunId,
      rule: { ruleId, name: `合成规则 ${ruleId}`, level: "review", objectTypes: ["order"], actions: ["rebate.write"], when: "params.amount > 0" },
    };
  }

  async function snapshot(input: ProposalInput, scope = scopeA): Promise<ProposalState> {
    const report = await owner!.query<{ status: string }>("SELECT status FROM fence_dry_runs WHERE id=$1", [input.dryRunId]);
    const rules = await owner!.query<ProposalState["rules"][number]>(
      "SELECT id,version,status,is_baseline FROM fence_rules WHERE workspace_id=$1 AND rule_id=$2 ORDER BY version,id",
      [scope.workspaceId, input.rule.ruleId],
    );
    const events = await owner!.query<ProposalState["events"][number]>(
      `SELECT event_id,payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2
        AND payload->'decision'->'after'->>'dryRunId'=$3 ORDER BY seq`,
      [scope.tenantId, scope.workspaceId, input.dryRunId],
    );
    const approvals = await owner!.query<ProposalState["approvals"][number]>(
      `SELECT a.event_id,a.status,a.snapshot FROM approvals a
       JOIN biz_events e ON e.event_id=a.event_id AND e.tenant_id=a.tenant_id AND e.workspace_id=a.workspace_id
       WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND e.payload->'decision'->'after'->>'dryRunId'=$3 ORDER BY a.approval_id`,
      [scope.tenantId, scope.workspaceId, input.dryRunId],
    );
    return { status: report.rows[0]?.status ?? null, rules: rules.rows, events: events.rows, approvals: approvals.rows };
  }

  function assertCommitted(state: ProposalState, version = "v1"): void {
    expect(state.status).toBe("confirmed");
    expect(state.rules).toHaveLength(1);
    expect(state.rules[0]).toMatchObject({ version, status: "pending_approval", is_baseline: false });
    expect(state.events).toHaveLength(1);
    expect(state.approvals).toHaveLength(1);
    expect(state.events[0]!.payload.decision.after).toMatchObject({ ruleRowId: state.rules[0]!.id, version });
    expect(state.approvals[0]).toMatchObject({
      event_id: state.events[0]!.event_id, status: "pending",
      snapshot: { ruleRowId: state.rules[0]!.id, version, high_risk: true },
    });
  }

  async function enableFault(stage: FailureStage, ruleId: string): Promise<void> {
    if (stage === "history") {
      await owner!.query("REVOKE SELECT ON fence_rules FROM workloom_app");
    } else {
      await owner!.query("INSERT INTO fence_atomicity_faults (stage,rule_id) VALUES ($1,$2)", [stage, ruleId]);
    }
  }

  async function clearFault(stage: FailureStage): Promise<void> {
    if (stage === "history") await owner!.query("GRANT SELECT ON fence_rules TO workloom_app");
    else await owner!.query("DELETE FROM fence_atomicity_faults WHERE stage=$1", [stage]);
  }

  beforeAll(async () => {
    // 双护栏：URL 必须指向本角色独立 Unix socket 和固定合成库，且 nonce 必须匹配引导器。
    const socket = process.env.FENCE_ATOMICITY_SOCKET;
    const port = process.env.FENCE_ATOMICITY_PORT;
    const nonce = process.env.FENCE_ATOMICITY_NONCE;
    if (!socket?.startsWith("/tmp/wl-fence-pg-") || !/^\d+$/.test(port ?? "") || !nonce) {
      throw new Error("Refusing fence PG tests outside an isolated Unix fixture");
    }
    for (const key of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"] as const) {
      const value = process.env[key];
      if (!value) throw new Error(`Missing fixture ${key}`);
      const parsed = new URL(value);
      if (parsed.searchParams.get("host") !== socket || parsed.searchParams.get("port") !== port || parsed.pathname !== "/fence_atomicity") {
        throw new Error(`Refusing non-fixture connection: ${key}`);
      }
    }
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const sentinel = await owner.query<{ nonce: string; listen_addresses: string }>(
      "SELECT nonce,current_setting('listen_addresses') AS listen_addresses FROM fence_atomicity_fixture_owner",
    );
    if (sentinel.rows.length !== 1 || sentinel.rows[0]!.nonce !== nonce || sentinel.rows[0]!.listen_addresses !== "") {
      throw new Error("Refusing fixture without matching owner nonce and disabled TCP listener");
    }
    const db = await import("@workloom/db");
    closeAllPools = db.closeAllPools;
    app = db.getAppPool();
    appRouter = (await import("./router.js")).appRouter;
    eventHash = (await import("@workloom/base/workdata")).eventHash;
    callerA = appRouter.createCaller(context(identityA));
    callerB = appRouter.createCaller(context(identityB));

    for (const identity of [identityA, identityB]) {
      await owner.query("INSERT INTO tenants (id,name,plan) VALUES ($1,$2,'pro')", [identity.tenantId, identity.name]);
      await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,$3,$1,'hotel')", [identity.workspaceId, identity.tenantId, identity.name]);
      await owner.query(
        "INSERT INTO members (id,workspace_id,member_no,name,role,status,permissions) VALUES ($1,$2,$3,$4,'owner','active','{}')",
        [identity.memberId, identity.workspaceId, identity.memberNo, identity.name],
      );
    }
    await owner.query(`
      CREATE TABLE fence_atomicity_faults (stage text PRIMARY KEY, rule_id text NOT NULL);
      CREATE FUNCTION fence_atomicity_inject_fault() RETURNS trigger LANGUAGE plpgsql
        SECURITY DEFINER SET search_path=pg_catalog,public AS $fixture$
      DECLARE target_rule text; actual_rule text;
      BEGIN
        SELECT rule_id INTO target_rule FROM public.fence_atomicity_faults WHERE stage=TG_ARGV[0];
        IF NOT FOUND THEN RETURN NEW; END IF;
        IF TG_TABLE_NAME IN ('fence_rules','fence_dry_runs') THEN actual_rule=NEW.rule_id;
        ELSIF TG_TABLE_NAME='biz_events' THEN actual_rule=NEW.payload->'decision'->'after'->>'ruleId';
        ELSIF TG_TABLE_NAME='approvals' THEN actual_rule=NEW.snapshot->'after'->>'ruleId';
        END IF;
        IF actual_rule=target_rule THEN RAISE EXCEPTION 'fence_atomicity injected failure at %',TG_ARGV[0]; END IF;
        RETURN NEW;
      END;
      $fixture$;
      CREATE TRIGGER fence_atomicity_confirm BEFORE UPDATE ON fence_dry_runs FOR EACH ROW EXECUTE FUNCTION fence_atomicity_inject_fault('confirm');
      CREATE TRIGGER fence_atomicity_insert BEFORE INSERT ON fence_rules FOR EACH ROW EXECUTE FUNCTION fence_atomicity_inject_fault('insert');
      CREATE TRIGGER fence_atomicity_event BEFORE INSERT ON biz_events FOR EACH ROW EXECUTE FUNCTION fence_atomicity_inject_fault('event');
      CREATE TRIGGER fence_atomicity_approval BEFORE INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION fence_atomicity_inject_fault('approval');
      CREATE CONSTRAINT TRIGGER fence_atomicity_commit AFTER INSERT ON approvals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fence_atomicity_inject_fault('commit');
    `);
  }, 60_000);

  afterAll(async () => {
    const results = process.env.FENCE_ATOMICITY_RESULTS;
    if (results) writeFileSync(results, JSON.stringify({ schema: "workloom.fence-atomicity-pg@1", cases, caller: "actual hotel appRouter", member_authority: "actual DB query", gateway: "actual gatewayAppendOnClient", synthetic_scopes: [scopeA, scopeB] }, null, 2) + "\n");
    try {
      if (closeAllPools) await closeAllPools();
    } finally {
      if (owner) await owner.end();
    }
  });

  it("真实 app 角色无超级权限且空 GUC 看不到工作区数据，biz_events 旁路直写被拒", async () => {
    const role = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user",
    );
    const reports = await app.query("SELECT id FROM fence_dry_runs");
    let insertError: unknown;
    try {
      await app.query("INSERT INTO biz_events (event_id,tenant_id,workspace_id,payload,prev_hash,hash) VALUES ('E-RPL-fixture-bypass','fixture','fixture','{}','GENESIS','x')");
    } catch (error) { insertError = error; }
    record({ id: "pg-role-rls", preconditions: ["fresh Unix fixture", "real workloom_app connection"], steps: ["query role flags and no-GUC visibility", "try direct biz_events insert"], expected: ["no SUPERUSER or BYPASSRLS", "no visible reports", "direct INSERT permission denied"], actual: { role: role.rows, visibleReports: reports.rowCount, insertError: errorInfo(insertError) } });
    expect(role.rows[0]).toMatchObject({ current_user: "workloom_app", rolsuper: false, rolbypassrls: false });
    expect(reports.rows).toHaveLength(0);
    expect(errorInfo(insertError).code).toBe("42501");
  });

  it("正常确认保留 pending_approval 与 high_risk 审批语义，四份状态一起提交", async () => {
    const input = await pending("R901");
    const result = await attempt(callerA, input);
    const state = await snapshot(input);
    record({ id: "pg-normal", preconditions: ["owner member active", "report pending"], steps: ["invoke actual fence.confirmDryRun", "read four tables as fixture owner"], expected: ["report confirmed", "one pending_approval rule, one event, one pending high_risk approval"], actual: { result, state } });
    expect(result.ok).toBe(true);
    assertCommitted(state);
  });

  it.each(["confirm", "history", "insert", "event", "approval", "commit"] as const)(
    "%s 真实数据库失败同滚回，解除故障后同一报告成功重试",
    async (stage) => {
      const input = await pending(`R${910 + ["confirm", "history", "insert", "event", "approval", "commit"].indexOf(stage)}`);
      const before = await snapshot(input);
      await enableFault(stage, input.rule.ruleId);
      let failedAttempt;
      let afterFailure;
      try {
        failedAttempt = await attempt(callerA, input);
        afterFailure = await snapshot(input);
      } finally {
        await clearFault(stage);
      }
      // 即使旧实现已留下半态也执行重试，RED 证据同时包含“报告消耗”与“重试被拒”。
      const retry = await attempt(callerA, input);
      const afterRetry = await snapshot(input);
      record({ id: `pg-fault-${stage}`, preconditions: ["report pending", "no rule/event/approval for this report"], steps: [`enable actual PostgreSQL ${stage} failure`, "confirm report", "inspect committed state", "clear failure", "retry same dryRunId"], expected: ["first request fails", "all four tables equal pre-state after failure", "same ID retry creates exactly one complete proposal"], actual: { before, failedAttempt, afterFailure, retry, afterRetry } });
      expect(failedAttempt!.ok).toBe(false);
      if (!failedAttempt!.ok) {
        expect(failedAttempt!.error.causeCode).toBe(stage === "history" ? "42501" : "P0001");
        expect(failedAttempt!.error.message).toMatch(stage === "history" ? /permission denied/ : new RegExp(`failure at ${stage}`));
      }
      expect(afterFailure).toEqual(before);
      expect(retry.ok).toBe(true);
      assertCommitted(afterRetry);
    },
  );

  it("成功后的重复确认仍按 pending 条件拒绝，规则和审批不重复", async () => {
    const input = await pending("R920");
    const first = await attempt(callerA, input);
    const before = await snapshot(input);
    const repeated = await attempt(callerA, input);
    const after = await snapshot(input);
    record({ id: "pg-repeat-confirmed", preconditions: ["report pending"], steps: ["confirm", "confirm same ID again"], expected: ["first succeeds", "repeat rejected as nonpending", "four-table state unchanged on repeat"], actual: { first, before, repeated, after } });
    expect(first.ok).toBe(true);
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.error.message).toContain("非 pending");
    expect(after).toEqual(before);
    assertCommitted(after);
  });

  it("rejected 报告仍被拒绝，状态不被改回 confirmed", async () => {
    const input = await pending("R921");
    await owner!.query("UPDATE fence_dry_runs SET status='rejected' WHERE id=$1", [input.dryRunId]);
    const before = await snapshot(input);
    const result = await attempt(callerA, input);
    const after = await snapshot(input);
    record({ id: "pg-rejected", preconditions: ["report rejected"], steps: ["confirm rejected ID", "inspect state"], expected: ["nonpending error", "rejected status retained, no writes"], actual: { result, before, after } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("非 pending");
    expect(after).toEqual(before);
  });

  it.each(["", "fdr-fixture-missing"])("空或不存在报告 %s 返回错误且不创建任何业务行", async (dryRunId) => {
    const input: ProposalInput = { ...(await pending(dryRunId ? "R923" : "R922")), dryRunId };
    const before = await snapshot(input);
    const result = await attempt(callerA, input);
    const after = await snapshot(input);
    record({ id: dryRunId ? "pg-missing" : "pg-empty", preconditions: ["requested report ID does not exist"], steps: ["confirm missing ID"], expected: ["nonpending error", "no rule/event/approval writes"], actual: { result, before, after } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("非 pending");
    expect(after).toEqual(before);
  });

  it("另一工作区的合法 owner 不能消费本工作区报告", async () => {
    const input = await pending("R924");
    const before = await snapshot(input);
    const result = await attempt(callerB, input);
    const after = await snapshot(input);
    const otherWorkspace = await snapshot(input, scopeB);
    record({ id: "pg-cross-workspace", preconditions: ["report in tenant A workspace A", "owner B valid in tenant B workspace B"], steps: ["caller B confirms caller A report"], expected: ["report unseen/nonpending error", "report A remains pending", "neither workspace has new rule/event/approval"], actual: { result, before, after, otherWorkspace } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("非 pending");
    expect(after).toEqual(before);
    expect(otherWorkspace.rules).toHaveLength(0);
    expect(otherWorkspace.events).toHaveLength(0);
    expect(otherWorkspace.approvals).toHaveLength(0);
  });

  it("伪造会话租户与成员实际归属不匹配时，实时成员权威在写入前拒绝", async () => {
    const input = await pending("R925");
    const before = await snapshot(input);
    const forged = appRouter.createCaller(context({ ...identityA, tenantId: scopeB.tenantId }));
    const result = await attempt(forged, input);
    const after = await snapshot(input);
    record({ id: "pg-forged-tenant", preconditions: ["member belongs to tenant A", "session claims tenant B"], steps: ["confirm report with mismatching tenant claim"], expected: ["UNAUTHORIZED", "four-table state unchanged"], actual: { result, before, after } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED");
    expect(after).toEqual(before);
  });

  it.each(["readonly", "explicit-deny"] as const)("实时 %s 权限拒绝不消耗报告，旧 owner 声明不能越权", async (kind) => {
    const input = await pending(kind === "readonly" ? "R926" : "R927");
    const before = await snapshot(input);
    await owner!.query("UPDATE members SET role=$2,permissions=$3 WHERE id=$1", [identityA.memberId, kind === "readonly" ? "readonly" : "owner", JSON.stringify(kind === "explicit-deny" ? { deny: ["guardrail.manage"] } : {})]);
    let result;
    let after;
    try {
      result = await attempt(callerA, input);
      after = await snapshot(input);
    } finally {
      await owner!.query("UPDATE members SET role='owner',permissions='{}' WHERE id=$1", [identityA.memberId]);
    }
    record({ id: `pg-permission-${kind}`, preconditions: ["session claims owner", `actual DB authority ${kind}`, "report pending"], steps: ["confirm with stale owner claim"], expected: ["FORBIDDEN", "report pending and no writes"], actual: { result, before, after } });
    expect(result!.ok).toBe(false);
    if (!result!.ok) expect(result!.error.code).toBe("FORBIDDEN");
    expect(after).toEqual(before);
  });

  it("中文、引号与换行经过参数绑定写入并保留在提案内容", async () => {
    const input = await pending("R928");
    input.rule.name = "返佣 'VIP' \"客户\"\n复核";
    input.rule.when = "note == \"O'Reilly\\n\"";
    const result = await attempt(callerA, input);
    const state = await snapshot(input);
    const stored = await owner!.query<{ name: string; match_spec: { when: string } }>("SELECT name,match_spec FROM fence_rules WHERE id=$1", [state.rules[0]?.id]);
    record({ id: "pg-special-characters", preconditions: ["report pending", "candidate contains Chinese, quotes, newline"], steps: ["confirm", "inspect rule and event payload"], expected: ["complete proposal", "name and when retained"], actual: { result, state, stored: stored.rows } });
    expect(result.ok).toBe(true);
    assertCommitted(state);
    expect(stored.rows[0]).toMatchObject({ name: input.rule.name, match_spec: { when: input.rule.when } });
    expect(state.events[0]!.payload.decision.after).toMatchObject({ name: input.rule.name, when: input.rule.when });
  });

  it("非法级别在实际 router 输入校验阶段拒绝，不消耗报告", async () => {
    const input = await pending("R929");
    const before = await snapshot(input);
    const result = await attempt(callerA, { ...input, rule: { ...input.rule, level: "unsafe" } } as never);
    const after = await snapshot(input);
    record({ id: "pg-invalid-input", preconditions: ["report pending", "invalid level unsafe"], steps: ["confirm invalid candidate"], expected: ["BAD_REQUEST", "four-table state unchanged"], actual: { result, before, after } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BAD_REQUEST");
    expect(after).toEqual(before);
  });

  it("同一报告并发确认只有一次完整提交，另一次仍被 pending 守卫拒绝", async () => {
    const input = await pending("R930");
    const results = await Promise.all([attempt(callerA, input), attempt(callerA, input)]);
    const state = await snapshot(input);
    record({ id: "pg-concurrent-same-report", preconditions: ["single pending report"], steps: ["run two actual router calls concurrently"], expected: ["one successful proposal", "one nonpending error", "one rule/event/approval"], actual: { results, state } });
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const failure = results.find((result) => !result.ok);
    expect(failure?.ok).toBe(false);
    if (failure && !failure.ok) expect(failure.error.message).toContain("非 pending");
    assertCommitted(state);
  });

  it("同一规则的不同报告并发提案重算版本，两个报告各自完整提交", async () => {
    const first = await pending("R931");
    const second = await pending("R931");
    const results = await Promise.all([attempt(callerA, first), attempt(callerA, second)]);
    const states = await Promise.all([snapshot(first), snapshot(second)]);
    record({ id: "pg-concurrent-rule-versions", preconditions: ["two pending reports for one rule", "no existing local rule"], steps: ["run two actual router calls concurrently"], expected: ["both reports confirmed", "versions v1/v2 distinct", "one event/approval per report"], actual: { results, states } });
    expect(results.every((result) => result.ok)).toBe(true);
    expect(states[0]!.rules.map((row) => row.version).sort()).toEqual(["v1", "v2"]);
    for (const state of states) {
      expect(state.status).toBe("confirmed");
      expect(state.events).toHaveLength(1);
      expect(state.approvals).toHaveLength(1);
      expect(state.approvals[0]!.snapshot.high_risk).toBe(true);
      expect(state.approvals[0]!.snapshot.ruleRowId).toBe(state.events[0]!.payload.decision.after.ruleRowId);
    }
  });

  it("保留真实历史取号：本区 v3 与全局基线生成 v4，其他工作区 v99 不影响", async () => {
    const input = await pending("R932");
    for (const [id, workspace, version, baseline] of [
      ["fr-r932-v1-global", "*", "hotel-baseline/v1", true],
      ["fr-r932-v3-ws-fence-a", scopeA.workspaceId, "v3", false],
      ["fr-r932-v99-ws-fence-b", scopeB.workspaceId, "v99", false],
    ] as const) {
      await owner!.query(
        `INSERT INTO fence_rules (id,rule_id,version,workspace_id,name,level,match_spec,action,is_baseline,status,created_by)
         VALUES ($1,'R932',$2,$3,'fixture history','review','{}','{}',$4,'active','fixture-owner')`,
        [id, version, workspace, baseline],
      );
    }
    const result = await attempt(callerA, input);
    const state = await snapshot(input);
    record({ id: "pg-version-history", preconditions: ["global baseline v1", "local history v3", "other workspace v99", "report pending"], steps: ["confirm actual proposal"], expected: ["new local v4", "event and approval reference that exact row", "global baseline retained"], actual: { result, state } });
    expect(result.ok).toBe(true);
    const candidate = state.rules.find((row) => row.version === "v4");
    expect(candidate).toMatchObject({ id: "fr-r932-v4-ws-fence-a", status: "pending_approval" });
    expect(state.events[0]!.payload.decision.after).toMatchObject({ version: "v4", ruleRowId: candidate!.id, inheritedBaseline: true });
    expect(state.approvals[0]!.snapshot).toMatchObject({ version: "v4", ruleRowId: candidate!.id, high_risk: true });
    const global = await owner!.query("SELECT status,is_baseline FROM fence_rules WHERE id='fr-r932-v1-global'");
    expect(global.rows[0]).toMatchObject({ status: "active", is_baseline: true });
  });

  it("所有合成工作区提交事件仍形成完整哈希链，没有故障时的孤儿提案事件", async () => {
    const rows = await owner!.query<{ workspace_id: string; event_id: string; payload: unknown; prev_hash: string; hash: string }>(
      "SELECT workspace_id,event_id,payload,prev_hash,hash FROM biz_events WHERE workspace_id=ANY($1) ORDER BY workspace_id,seq",
      [[scopeA.workspaceId, scopeB.workspaceId]],
    );
    const tails = new Map<string, string>();
    const mismatches = rows.rows.filter((row) => {
      const previous = tails.get(row.workspace_id) ?? "GENESIS";
      tails.set(row.workspace_id, row.hash);
      return row.prev_hash !== previous || row.hash !== eventHash(previous, row.payload);
    });
    record({ id: "pg-chain-regression", preconditions: ["all prior proposal/failure/retry/concurrency scenarios executed"], steps: ["recompute every fixture event hash and predecessor"], expected: ["zero chain mismatches"], actual: { eventCount: rows.rowCount, mismatches, chainWorkspaces: [...tails.keys()] } });
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(mismatches).toHaveLength(0);
  });
});
