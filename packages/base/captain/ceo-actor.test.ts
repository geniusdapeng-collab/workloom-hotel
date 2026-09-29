/**
 * CEO 节拍 actor 同源测试（F2.10 复查位）。
 *
 * 口径：`ceoActor()` 必须把「本工作区 company-ceo 岗位声明的 fence_bindings」原样交给网关；
 * 岗位缺编时留空绑定，让网关按「未声明围栏」拒写（fail-closed，不偷放）。
 * 断言直接复用网关的纯函数 `checkPermission`，避免测试与门禁两套口径各自成立。
 */
import { beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { checkPermission, isWriteAction, registerWriteActions, type EventDraft } from "@workloom/base/workdata";
import { ceoActor } from "./loop.js";

const scope = { tenantId: "t-1", workspaceId: "ws-1" };

beforeAll(() => {
  // 生产口径：围栏包装载与岗位装配期会把声明过的写类动作登记进网关（gateway.ts#registerWriteActions）。
  // 单测进程没有装配步骤，这里显式复刻酒店基线 R24 与本岗位写工具的登记结果，
  // 否则 ceo.briefing 会被当读类动作直接放行，用例退化成假绿。
  registerWriteActions(["ceo.briefing"]);
  expect(isWriteAction("ceo.briefing")).toBe(true);
});

/** 只登记真实发出的 SQL 形状的最小假客户端（不引入 PG 依赖） */
function fakeClient(rows: Array<{ readonly: boolean; fence_bindings: string[] }>): pg.PoolClient {
  return {
    query: async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("FROM agents");
      expect(params).toEqual([scope.workspaceId, "company-ceo"]);
      return { rows, rowCount: rows.length };
    },
  } as unknown as pg.PoolClient;
}

function writeDraft(action: string, actorId: string): EventDraft {
  return {
    who: { type: "agent", id: actorId },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
    object: { type: "company_ceo", id: scope.workspaceId },
    decision: { action, basis: ["单测"] },
    rule_impact: [],
  } as EventDraft;
}

describe("CEO 节拍 actor 同源（F2.10）", () => {
  it("在编：绑定与只读位取自名册行", async () => {
    const actor = await ceoActor(fakeClient([{ readonly: false, fence_bindings: ["R17", "R18", "R19", "R24"] }]), scope);
    expect(actor).toEqual({ id: "company-ceo", type: "agent", readonly: false, fenceBindings: ["R17", "R18", "R19", "R24"] });
  });

  it("在编且声明了围栏：ceo.briefing 写动作通过网关段①", async () => {
    const actor = await ceoActor(fakeClient([{ readonly: false, fence_bindings: ["R17", "R24"] }]), scope);
    expect(() => checkPermission(actor, writeDraft("ceo.briefing", actor.id))).not.toThrow();
  });

  it("岗位缺编：留空绑定 → 网关拒写（fail-closed，不偷放）", async () => {
    const actor = await ceoActor(fakeClient([]), scope);
    expect(actor.fenceBindings).toEqual([]);
    expect(() => checkPermission(actor, writeDraft("ceo.briefing", actor.id))).toThrow(/未声明 fence_bindings/);
  });

  it("岗位被声明为只读：只读位透传，写动作按 L9.1 拒", async () => {
    const actor = await ceoActor(fakeClient([{ readonly: true, fence_bindings: ["R17"] }]), scope);
    expect(actor.readonly).toBe(true);
    expect(() => checkPermission(actor, writeDraft("ceo.briefing", actor.id))).toThrow(/只读 preset/);
  });

  it("身份一致性：actor 与 who 必须同主体（防伪造留痕）", async () => {
    const actor = await ceoActor(fakeClient([{ readonly: false, fence_bindings: ["R17"] }]), scope);
    expect(() => checkPermission(actor, writeDraft("ceo.briefing", "someone-else"))).toThrow(/身份不一致/);
  });
});
