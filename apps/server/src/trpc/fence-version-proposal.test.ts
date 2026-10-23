import { realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "@workloom/base/tenancy";

const state = vi.hoisted(() => ({
  app: null as unknown as pg.Pool,
  gateway: null as unknown as pg.Pool,
  owner: null as unknown as pg.Pool,
  failProposalAppend: false,
  failActivation: false,
}));

vi.mock("@workloom/db", async (original) => {
  const actual = await original<typeof import("@workloom/db")>();
  return { ...actual, getAppPool: () => state.app, getGatewayPool: () => state.gateway, getOwnerPool: () => state.owner };
});

vi.mock("@workloom/base/fence-engine", async (original) => {
  const actual = await original<typeof import("@workloom/base/fence-engine")>();
  return {
    ...actual,
    activateRuleVersion: async (...args: Parameters<typeof actual.activateRuleVersion>) => {
      if (state.failActivation) throw new Error("injected activation failure");
      return actual.activateRuleVersion(...args);
    },
  };
});

vi.mock("@workloom/base/workdata", async (original) => {
  const actual = await original<typeof import("@workloom/base/workdata")>();
  return {
    ...actual,
    gatewayAppendOnClient: async (...args: Parameters<typeof actual.gatewayAppendOnClient>) => {
      if (state.failProposalAppend && args[2].decision.action === "fence.rule.propose") {
        throw new Error("injected proposal event failure");
      }
      return actual.gatewayAppendOnClient(...args);
    },
  };
});

import { appRouter } from "./router.js";
import { fenceActivationFromProposal } from "@workloom/base/fence-engine";

describe("fence proposal activation identity", () => {
  it("requires an exact row identity or a version instead of guessing v-next", () => {
    expect(fenceActivationFromProposal({ decision: { action: "fence.rule.propose", after: { ruleId: "R801", dryRunId: "fdr-801" } } }, "ws-one")).toBeNull();
    expect(fenceActivationFromProposal({ decision: { action: "fence.rule.propose", after: { ruleId: "R801", dryRunId: "fdr-801", version: "v3" } } }, "ws-one"))
      .toEqual({ ruleRowId: "fr-r801-v3-ws-one", dryRunId: "fdr-801" });
  });
});

/** Explicit disposable target and ownership proof are mandatory; ordinary unit CI never touches a database. */
const databaseUrl = process.env.FENCE_TEST_DATABASE_URL;
const expectedPgdata = process.env.FENCE_TEST_EXPECTED_PGDATA;
const runPg = process.env.RUN_FENCE_DB_TESTS === "1";
const pgSuite = runPg ? describe : describe.skip;

pgSuite("fence proposal version lifecycle with real PostgreSQL/RLS", () => {
  const stamp = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const a = { tenantId: `tenant-fence-${stamp}-a`, workspaceId: `ws-fence-${stamp}-a` };
  const b = { tenantId: `tenant-fence-${stamp}-b`, workspaceId: `ws-fence-${stamp}-b` };
  let ruleNumber = 98000;
  const nextRule = () => `R${++ruleNumber}`;
  const inputRule = (ruleId: string, level: "review" | "block" | "auto" = "review") => ({
    ruleId, name: "评测隔离规则", level, objectTypes: ["evaluation_record"], actions: ["evaluation.write"], when: "true",
  });
  const identity = (scope = a, role: Identity["role"] = "owner"): Identity => ({
    kind: "member", memberId: `${scope.workspaceId}-${role}`, memberNo: role === "owner" ? "MEM-001" : "MEM-003",
    name: "隔离评测成员", role, ...scope, plan: "pro",
  });
  const caller = (scope = a, role: Identity["role"] = "owner") => {
    const member = identity(scope, role);
    return appRouter.createCaller({ identity: member, session: member, partnerIdentity: null, headers: new Headers() });
  };
  const scalar = async (sql: string, args: unknown[]) => (await state.owner.query(sql, args)).rows[0];
  const dryRun = (rule: ReturnType<typeof inputRule>, scope = a) => caller(scope).fence.dryRun(rule);
  const confirm = (id: string, rule: ReturnType<typeof inputRule>, scope = a) => caller(scope).fence.confirmDryRun({ dryRunId: id, rule });
  const proposal = async (eventId: string) => (await scalar("SELECT payload FROM biz_events WHERE event_id=$1", [eventId]))?.payload;
  const approve = (eventId: string) => caller().approvals.decide({ approvalId: `apr-${eventId.toLowerCase()}`, gesture: "approve" });

  beforeAll(async () => {
    if (!databaseUrl || !expectedPgdata) throw new Error("Explicit FENCE_TEST_DATABASE_URL and FENCE_TEST_EXPECTED_PGDATA are required");
    const url = new URL(databaseUrl);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.port) throw new Error("Fence regression requires an explicit loopback database port");
    state.owner = new pg.Pool({ connectionString: databaseUrl });
    const actual = await scalar("SELECT current_setting('data_directory') AS pgdata, current_database() AS db", []);
    if (realpathSync(actual.pgdata) !== realpathSync(expectedPgdata)) throw new Error("Database target ownership mismatch");
    // SET ROLE at connection startup retains production role grants and RLS without reading or persisting passwords.
    state.app = new pg.Pool({ connectionString: databaseUrl, options: "-c role=workloom_app" });
    state.gateway = new pg.Pool({ connectionString: databaseUrl, options: "-c role=workloom_gateway" });
    expect((await state.app.query("SELECT current_user AS role")).rows[0]?.role).toBe("workloom_app");
    expect((await state.app.query("SELECT count(*)::int AS n FROM fence_dry_runs")).rows[0]?.n).toBe(0);
    for (const scope of [a, b]) {
      await state.owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'围栏隔离测试','pro')", [scope.tenantId]);
      await state.owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'围栏隔离测试',$1,'hotel')", [scope.workspaceId, scope.tenantId]);
      for (const role of ["owner", "readonly"] as const) {
        const member = identity(scope, role);
        await state.owner.query("INSERT INTO members(id,workspace_id,member_no,name,role) VALUES($1,$2,$3,$4,$5)", [member.memberId, scope.workspaceId, member.memberNo, member.name, role]);
      }
    }
  }, 30_000);

  afterAll(async () => {
    state.failProposalAppend = false;
    state.failActivation = false;
    // Append-only evidence and its isolated workspace remain available for independent review.
    await Promise.all([state.app?.end(), state.gateway?.end(), state.owner?.end()]);
  });

  it("confirms, records and activates exact successive versions, rolling back only the prior overlay", async () => {
    const rule = inputRule(nextRule());
    const firstDry = await dryRun(rule);
    const first = await confirm(firstDry.dryRunId, rule);
    const after1 = (await proposal(first.eventId)).decision.after;
    expect(after1).toMatchObject({ ruleId: rule.ruleId, version: "v1", dryRunId: firstDry.dryRunId, ruleRowId: `fr-${rule.ruleId.toLowerCase()}-v1-${a.workspaceId}` });
    expect(await scalar("SELECT status,version FROM fence_rules WHERE id=$1", [after1.ruleRowId])).toEqual({ status: "pending_approval", version: "v1" });
    const gesture = await approve(first.eventId);
    expect(gesture.status).toBe("approved");
    expect(await scalar("SELECT status,version,approved_event_id FROM fence_rules WHERE id=$1", [after1.ruleRowId])).toEqual({ status: "active", version: "v1", approved_event_id: gesture.gestureEventId });
    const tightened = { ...rule, level: "block" as const };
    const secondDry = await dryRun(tightened);
    const second = await confirm(secondDry.dryRunId, tightened);
    const after2 = (await proposal(second.eventId)).decision.after;
    expect(after2).toMatchObject({ version: "v2", ruleRowId: `fr-${rule.ruleId.toLowerCase()}-v2-${a.workspaceId}` });
    await approve(second.eventId);
    expect(await scalar("SELECT status FROM fence_rules WHERE id=$1", [after1.ruleRowId])).toEqual({ status: "rolled_back" });
    expect(await scalar("SELECT status,version FROM fence_rules WHERE id=$1", [after2.ruleRowId])).toEqual({ status: "active", version: "v2" });
  });

  it("rolls back dry-run confirmation and proposal rows when event append fails", async () => {
    const rule = inputRule(nextRule());
    const dr = await dryRun(rule);
    state.failProposalAppend = true;
    try {
      await expect(confirm(dr.dryRunId, rule)).rejects.toThrow("injected proposal event failure");
    } finally { state.failProposalAppend = false; }
    expect(await scalar("SELECT status FROM fence_dry_runs WHERE id=$1", [dr.dryRunId])).toEqual({ status: "pending" });
    expect(await scalar("SELECT count(*)::int AS n FROM fence_rules WHERE workspace_id=$1 AND rule_id=$2", [a.workspaceId, rule.ruleId])).toEqual({ n: 0 });
    expect(await scalar("SELECT count(*)::int AS n FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->'after'->>'ruleId'=$2", [a.workspaceId, rule.ruleId])).toEqual({ n: 0 });
  });

  it("keeps another tenant's dry-run pending and rejects readonly operators", async () => {
    const rule = inputRule(nextRule());
    const dr = await dryRun(rule, b);
    await expect(confirm(dr.dryRunId, rule, a)).rejects.toThrow();
    expect(await scalar("SELECT status FROM fence_dry_runs WHERE id=$1", [dr.dryRunId])).toEqual({ status: "pending" });
    await expect(caller(b, "readonly").fence.confirmDryRun({ dryRunId: dr.dryRunId, rule })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await scalar("SELECT status FROM fence_dry_runs WHERE id=$1", [dr.dryRunId])).toEqual({ status: "pending" });
  });

  it("rejects duplicate confirmation without generating a second proposal or version", async () => {
    const rule = inputRule(nextRule());
    const dr = await dryRun(rule);
    await confirm(dr.dryRunId, rule);
    await expect(confirm(dr.dryRunId, rule)).rejects.toThrow(/非 pending|已确认/);
    expect(await scalar("SELECT count(*)::int AS n FROM fence_rules WHERE workspace_id=$1 AND rule_id=$2", [a.workspaceId, rule.ruleId])).toEqual({ n: 1 });
  });

  it("serializes simultaneous proposals for one rule into unique increasing versions", async () => {
    const rule = inputRule(nextRule());
    const dr1 = await dryRun(rule);
    // Verify distinct persisted reports before exercising concurrent confirmations.
    const other = { ...rule, level: "block" as const };
    const dr2 = await dryRun(other);
    expect(dr1.dryRunId).not.toBe(dr2.dryRunId);
    const results = await Promise.all([confirm(dr1.dryRunId, rule), confirm(dr2.dryRunId, other)]);
    const versions = await Promise.all(results.map(async (r) => (await proposal(r.eventId)).decision.after.version));
    expect(versions.sort()).toEqual(["v1", "v2"]);
  });

  it("creates distinct dry-run reports for the same rule in the same clock tick", async () => {
    const rule = inputRule(nextRule());
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
    try {
      const reports = await Promise.all([dryRun(rule), dryRun(rule)]);
      expect(new Set(reports.map((r) => r.dryRunId)).size).toBe(2);
    } finally { clock.mockRestore(); }
  });

  it("rejects a substituted rule or a changed candidate without consuming the report", async () => {
    const rule = inputRule(nextRule());
    const dr = await dryRun(rule);
    await expect(confirm(dr.dryRunId, { ...rule, ruleId: nextRule() })).rejects.toThrow(/预演报告|候选快照/);
    await expect(confirm(dr.dryRunId, { ...rule, when: "false" })).rejects.toThrow(/预演报告|候选快照/);
    expect(await scalar("SELECT status FROM fence_dry_runs WHERE id=$1", [dr.dryRunId])).toEqual({ status: "pending" });
    const p = await confirm(dr.dryRunId, rule);
    expect((await proposal(p.eventId)).decision.after.ruleId).toBe(rule.ruleId);
  });

  it("requires a fresh dry-run when a legacy report has no candidate snapshot", async () => {
    const rule = inputRule(nextRule());
    const dr = await dryRun(rule);
    await state.owner.query("UPDATE fence_dry_runs SET report=report-'candidateRules' WHERE id=$1", [dr.dryRunId]);
    await expect(confirm(dr.dryRunId, rule)).rejects.toThrow(/重新预演/);
    expect(await scalar("SELECT status FROM fence_dry_runs WHERE id=$1", [dr.dryRunId])).toEqual({ status: "pending" });
  });

  it("retries a durable approval after activation failed without recording a second gesture", async () => {
    const rule = inputRule(nextRule());
    const dr = await dryRun(rule);
    const p = await confirm(dr.dryRunId, rule);
    const after = (await proposal(p.eventId)).decision.after;
    state.failActivation = true;
    try { await expect(approve(p.eventId)).rejects.toThrow("injected activation failure"); }
    finally { state.failActivation = false; }
    expect(await scalar("SELECT status FROM approvals WHERE event_id=$1", [p.eventId])).toEqual({ status: "approved" });
    expect(await scalar("SELECT status FROM fence_rules WHERE id=$1", [after.ruleRowId])).toEqual({ status: "pending_approval" });
    const retry = await approve(p.eventId);
    expect(retry).toMatchObject({ deduped: true, status: "approved" });
    expect(await scalar("SELECT status,version FROM fence_rules WHERE id=$1", [after.ruleRowId])).toEqual({ status: "active", version: "v1" });
    expect(await scalar("SELECT count(*)::int AS n FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='approval.gesture' AND payload->'decision'->'after'->>'approvalId'=$2", [a.workspaceId, `apr-${p.eventId.toLowerCase()}`])).toEqual({ n: 1 });
  });

  it("retains baseline anchors and refuses a candidate that loosens active protection", async () => {
    const rule = inputRule(nextRule());
    const baselineId = `fr-${rule.ruleId.toLowerCase()}-baseline-${a.workspaceId}`;
    await state.owner.query("INSERT INTO fence_rules(id,rule_id,version,workspace_id,name,level,match_spec,action,is_baseline,status,created_by) VALUES($1,$2,'v1',$3,$4,'review',$5,$6,true,'active','evaluation')", [baselineId, rule.ruleId, a.workspaceId, rule.name, JSON.stringify({object_types:rule.objectTypes,actions:rule.actions,when:rule.when}), JSON.stringify({result:"review"})]);
    const blocked = { ...rule, level: "block" as const };
    const dr = await dryRun(blocked);
    const p = await confirm(dr.dryRunId, blocked);
    await approve(p.eventId);
    expect(await scalar("SELECT status FROM fence_rules WHERE id=$1", [baselineId])).toEqual({ status: "active" });
    const loose = { ...rule, level: "auto" as const };
    const looseDry = await dryRun(loose);
    await expect(confirm(looseDry.dryRunId, loose)).rejects.toThrow(/只可加严|放宽/);
    expect(await scalar("SELECT status FROM fence_dry_runs WHERE id=$1", [looseDry.dryRunId])).toEqual({ status: "pending" });
  });

  it("carries explicit condition-change confirmation through proposal and activation", async () => {
    const rule = inputRule(nextRule());
    const baselineId = `fr-${rule.ruleId.toLowerCase()}-baseline-${a.workspaceId}`;
    await state.owner.query("INSERT INTO fence_rules(id,rule_id,version,workspace_id,name,level,match_spec,action,is_baseline,status,created_by) VALUES($1,$2,'v1',$3,$4,'review',$5,$6,true,'active','evaluation')", [baselineId, rule.ruleId, a.workspaceId, rule.name, JSON.stringify({object_types:rule.objectTypes,actions:rule.actions,when:rule.when}), JSON.stringify({result:"review"})]);
    const changed = { ...rule, when: "true and true" };
    const dr = await dryRun(changed);
    await expect(confirm(dr.dryRunId, changed)).rejects.toThrow(/when 被改写/);
    const p = await caller().fence.confirmDryRun({ dryRunId: dr.dryRunId, rule: changed, allowWhenChange: true });
    const after = (await proposal(p.eventId)).decision.after;
    expect(after).toMatchObject({ allowWhenChange: true, inheritedBaseline: true, version: "v2" });
    await approve(p.eventId);
    expect(await scalar("SELECT status FROM fence_rules WHERE id=$1", [after.ruleRowId])).toEqual({ status: "active" });
    expect(await scalar("SELECT status FROM fence_rules WHERE id=$1", [baselineId])).toEqual({ status: "active" });
  });
});
