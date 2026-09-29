#!/usr/bin/env node
/**
 * M3 联动探针（T-2026-0929-0007）：在编 company-ceo 之后，派活路由把任务交给谁？
 *
 * 联动风险（本次修复的推演）：新增指挥岗位会影响 `resolveDispatchPresetKey` 的候选命中
 * ——INDUSTRY_DEFAULTS.hotel = ["company-ceo", "growth-lead"]，此前两岗都未在编，
 * 未命中语义规则的目标会落到"第一个就绪员工"；在编后应落到 company-ceo。
 *
 * 用法（需先起服务）：
 *   SERVER_PORT=8807 tsx --env-file=.env apps/server/src/index.ts &
 *   node outputs/mine-clear/T-2026-0929-0007/evidence/m3-dispatch-routing-probe.mjs http://127.0.0.1:8807
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:8807";

async function trpc(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}/trpc/${path}`, {
    method: method === "GET" && body ? "POST" : method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const login = async (memberNo) => {
  const { data } = await trpc("auth.loginAs", { method: "POST", body: { workspaceSlug: "yunqi-hotel", memberNo } });
  return data?.result?.data?.token;
};

const token = await login("MEM-001");
if (!token) throw new Error("登录失败：拿不到 owner token");

const goals = [
  ["语义命中·定价", "把雅致大床房调价到 510 元"],
  ["语义命中·工单", "把 305 房的送物工单派下去"],
  ["未命中语义（指挥层兜底）", "帮我把昨天的经营情况整理一下"],
];

for (const [label, goal] of goals) {
  const { status, data } = await trpc("threads.dispatch", { method: "POST", token, body: { title: goal } });
  const d = data?.result?.data ?? {};
  console.log(JSON.stringify({ label, goal, status, mode: d.mode, threadId: d.id ?? d.threadId, agent: d.agentId ?? d.agent, answer: (d.answer ?? "").slice(0, 60) }, null, 0));
}
