/** Hotel composition seam: ordinary business execution keeps its existing Quest/tool path. */
import { getAppPool, getGatewayPool } from "@workloom/db";
import type { Scope, ThreadQuestInput, ThreadQuestOutcome } from "../../runtime/thread-runner.js";
import { routedLlmCall } from "../../service/llm.js";
import { resolveWorkspaceActiveBundle } from "../../service/active-bundle.js";
import { isHotelDeliveryPlan, isHotelDraftGoal, runHotelDelivery } from "./delivery-runtime.js";
import { configuredHotelResearchProvider } from "./research.js";

/** Explicit per-step human confirmation must keep the existing Agent approval workflow. */
function internalGoal(goal: string): boolean {
  return isHotelDraftGoal(goal) && !/逐步确认|一步步|每一步.{0,12}(?:确认|审批)|商量/.test(goal);
}

function configuredWorkerLimit(): number {
  const limit = Number(process.env.HOTEL_DELIVERY_MAX_WORKERS_PER_RUN ?? 5);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error("酒店内部交付单轮岗位上限须为1至5的整数，未开始模型调用");
  return limit;
}

export async function isHotelInternalDeliveryGoal(scope: Scope, goal: string): Promise<boolean> {
  if (!internalGoal(goal)) return false;
  const client = await getAppPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [scope.tenantId, scope.workspaceId]);
    const row = await client.query<{ industry: string }>("SELECT industry FROM workspaces WHERE tenant_id=$1 AND id=$2", [scope.tenantId, scope.workspaceId]);
    await client.query("COMMIT");
    if (row.rows[0]?.industry !== "hotel") return false;
    configuredWorkerLimit();
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function tryRunHotelDeliveryForThread(scope: Scope, input: ThreadQuestInput): Promise<ThreadQuestOutcome | undefined> {
  const client = await getAppPool().connect();
  let thread: { industry: string; plan: unknown; title: string; goal_text: unknown; agent_id: string | null } | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [scope.tenantId, scope.workspaceId]);
    const found = await client.query<NonNullable<typeof thread>>(
      `SELECT w.industry,t.plan,t.title,t.agent_id,
        (SELECT e.payload->'decision'->'after'->>'goal_text' FROM biz_events e
          WHERE e.tenant_id=t.tenant_id AND e.workspace_id=t.workspace_id AND e.session_id=t.id
            AND e.payload->'decision'->>'action'='thread.dispatch' ORDER BY e.seq ASC LIMIT 1) AS goal_text
       FROM threads t JOIN workspaces w ON w.id=t.workspace_id AND w.tenant_id=t.tenant_id
       WHERE t.tenant_id=$1 AND t.workspace_id=$2 AND t.id=$3`,
      [scope.tenantId, scope.workspaceId, input.threadId],
    );
    thread = found.rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
  if (!thread || thread.industry !== "hotel") return undefined;
  const plan = isHotelDeliveryPlan(thread.plan) ? thread.plan : undefined;
  if (!plan && thread.plan && typeof thread.plan === "object"
    && (thread.plan as { schema?: unknown }).schema === "workloom.hotel-delivery/v1") {
    throw new Error("酒店交付计划快照损坏，拒绝转入其他执行链或覆盖原计划");
  }
  // Never replace a legacy Quest plan, including an empty array that has already been persisted.
  if (!plan && thread.plan !== null && thread.plan !== undefined) return undefined;
  const goal = plan?.goal ?? (typeof thread.goal_text === "string" ? thread.goal_text : thread.title);
  if (!plan && (input.mode === "agent" || !internalGoal(goal))) return undefined;
  const requested = plan?.leadPresetKey ?? input.presetRef ?? thread.agent_id;
  let presetKey: string | null | undefined = requested;
  if (!plan) {
    const agent = await getAppPool().connect();
    try {
      await agent.query("BEGIN");
      await agent.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [scope.tenantId, scope.workspaceId]);
      const found = await agent.query<{ preset_key: string }>("SELECT preset_key FROM agents WHERE workspace_id=$1 AND (id=$2 OR preset_key=$2) AND status='ready' LIMIT 1", [scope.workspaceId, requested]);
      presetKey = found.rows[0]?.preset_key;
      await agent.query("COMMIT");
    } catch (error) {
      await agent.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { agent.release(); }
  }
  if (!presetKey) throw new Error("酒店内部交付缺少可运行的责任岗位");
  const maxWorkersPerRun = configuredWorkerLimit();
  const result = await runHotelDelivery({
    app: getAppPool(), gateway: getGatewayPool(), scope, threadId: input.threadId, goal, presetKey,
    maxWorkersPerRun,
    ...(input.skipClaim ? { claimedByScheduler: true } : {}),
    llmCallFor: (scene, sessionId) => routedLlmCall({
      gateway: getGatewayPool(), scope, scene, sessionId,
      industryResolver: async () => {
        const active = await resolveWorkspaceActiveBundle(scope.workspaceId);
        return active.state === "ready" ? active.bundleId : null;
      },
    }),
    researchProvider: configuredHotelResearchProvider(),
  });
  return { ...result, unverified: [], presetKey, warnings: ["本任务交付内部分析与草稿；经营执行由授权人另行决定。"] };
}
