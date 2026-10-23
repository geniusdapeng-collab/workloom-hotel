import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_CATALOG, poolFromEnv } from "./pool.js";
import { MockProvider } from "./providers.js";
import { resetCircuit, route, routeSmart, type EventSink } from "./router.js";

const envKeys = [
  "LLM_PROVIDER", "LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY",
  "DEEPSEEK_BASE_URL", "ZHIPU_BASE_URL", "DASHSCOPE_BASE_URL",
  "MOONSHOT_BASE_URL", "MINIMAX_BASE_URL",
];

function sink() {
  const traces: Parameters<EventSink["recordModelTrace"]>[0][] = [];
  const degradations: Parameters<EventSink["recordDegradation"]>[0][] = [];
  const events: EventSink = {
    recordModelTrace: async (trace) => { traces.push(trace); },
    recordDegradation: async (degradation) => { degradations.push(degradation); },
    recordCircuitBreak: async () => {},
  };
  return { events, traces, degradations };
}

function explicitModel() {
  vi.stubEnv("LLM_PROVIDER", "deepseek");
  vi.stubEnv("LLM_MODEL", "deepseek-flash");
  vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:19001");
  vi.stubEnv("LLM_API_KEY", "loopback-fixture");
}

function providerStub(status = 200) {
  const calls: Array<{ url: string; body: { model: string }; authorization: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) return Response.json({ data: [] });
    calls.push({
      url, body: JSON.parse(String(init?.body)),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Response.json(status === 200
      ? { choices: [{ message: { content: "酒店任务完成" } }], usage: { prompt_tokens: 13, completion_tokens: 7 } }
      : { error: { message: "fixture unavailable" } }, { status });
  }));
  return calls;
}

beforeEach(() => {
  for (const key of envKeys) vi.stubEnv(key, undefined);
  resetCircuit();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetCircuit();
});

describe("显式单模型部署（MC-001）", () => {
  it("LLM_MODEL 绑定所有逻辑档位，物理提供方只有一个", () => {
    explicitModel();
    const pool = poolFromEnv();
    expect(pool.size).toBe(MODEL_CATALOG.length);
    expect(new Set(pool.values()).size).toBe(1);
    expect([...pool.values()].every((provider) => provider.modelId === "deepseek-flash")).toBe(true);
  });

  it.each(["L1", "L2", "L3"] as const)("%s 发出配置模型 ID 并写入真实 model_trace", async (tier) => {
    explicitModel();
    const calls = providerStub();
    const { events, traces } = sink();
    const result = await routeSmart({
      action: "hotel.test", scene: "generic", forceTier: tier,
      messages: [{ role: "user", content: "核对当日房态" }],
    }, poolFromEnv(), events);
    expect(result.kind).toBe("answered");
    expect(result.tier).toBe(tier);
    expect(result.modelTrace?.model_id).toBe("deepseek-flash");
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ model_id: "deepseek-flash", tier });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:19001/chat/completions",
      body: { model: "deepseek-flash" }, authorization: "Bearer loopback-fixture",
    });
  });

  it("noDowngrade L3 场景仍可执行，同一模型不伪装为目录旗舰", async () => {
    explicitModel();
    const calls = providerStub();
    const { events } = sink();
    const result = await routeSmart({
      action: "ceo-deep-analysis", scene: "ceo-deep-analysis", plan: "lite",
      messages: [{ role: "user", content: "分析入住率下滑" }],
    }, poolFromEnv(), events);
    expect(result).toMatchObject({ kind: "answered", tier: "L3", modelTrace: { model_id: "deepseek-flash" } });
    expect(calls.map((call) => call.body.model)).toEqual(["deepseek-flash"]);
  });

  it("显式单模型只使用 LLM_BASE_URL，不把该 key 送到其他 vendor endpoint", async () => {
    explicitModel();
    vi.stubEnv("ZHIPU_BASE_URL", "http://127.0.0.1:19002");
    vi.stubEnv("DEEPSEEK_BASE_URL", "http://127.0.0.1:19003");
    const calls = providerStub();
    await routeSmart({
      action: "ceo-deep-analysis", scene: "ceo-deep-analysis",
      messages: [{ role: "user", content: "分析经营表现" }],
    }, poolFromEnv(), sink().events);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:19001/chat/completions");
  });

  it("显式模型缺少统一 endpoint 时拒绝装配，不借用其他 vendor 地址", () => {
    explicitModel();
    vi.stubEnv("LLM_BASE_URL", "  ");
    vi.stubEnv("ZHIPU_BASE_URL", "http://127.0.0.1:19002");
    expect(() => poolFromEnv()).toThrow(/LLM_BASE_URL/);
  });

  it("去掉模型与 endpoint 两端空白", async () => {
    explicitModel();
    vi.stubEnv("LLM_MODEL", "  deepseek-flash  ");
    vi.stubEnv("LLM_BASE_URL", "  http://127.0.0.1:19001  ");
    const calls = providerStub();
    await routeSmart({ action: "cs-answer", scene: "cs-answer", messages: [{ role: "user", content: "房态" }] }, poolFromEnv(), sink().events);
    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:19001/chat/completions", body: { model: "deepseek-flash" } });
  });

  it.each([401, 402, 429, 503])("HTTP %i 只尝试一次物理提供方，不通过别名重复调用或假报完成", async (status) => {
    explicitModel();
    vi.stubEnv("ZHIPU_BASE_URL", "http://127.0.0.1:19002");
    const calls = providerStub(status);
    const { events, traces, degradations } = sink();
    const result = await routeSmart({ action: "quest-plan", scene: "quest-plan", messages: [{ role: "user", content: "规划夜班" }] }, poolFromEnv(), events);
    expect(result.kind).toBe("unavailable");
    expect(traces).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.model).toBe("deepseek-flash");
    expect(degradations).toEqual([{
      from: "deepseek-flash", to: null,
      reason: `模型调用失败：HTTP ${status}`, action: "quest-plan",
    }]);
  });

  it.each([200, 503])("旧 route 入口同样按物理模型记账且不因别名重复调用（HTTP %i）", async (status) => {
    explicitModel();
    const calls = providerStub(status);
    const { events, traces } = sink();
    const result = await route({
      action: "price.adjust", messages: [{ role: "user", content: "房价建议" }],
    }, poolFromEnv(), events, {
      chains: { standard: ["deepseek-v4-flash", "glm-5.3-flash"], flagship: ["glm-5.3"] },
      taskCreditLimit: 500,
    });
    expect(calls).toHaveLength(1);
    if (status === 200) {
      expect(result.kind).toBe("answered");
      expect(traces[0]?.model_id).toBe("deepseek-flash");
    } else {
      expect(result.kind).toBe("unavailable");
      expect(traces).toHaveLength(0);
    }
  });
});

describe("原有配置兼容", () => {
  it.each([undefined, "", "  \t "])("未指定有效 LLM_MODEL（%j）时保留多提供方目录", (model) => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("LLM_MODEL", model);
    vi.stubEnv("DEEPSEEK_BASE_URL", "http://127.0.0.1:19001");
    vi.stubEnv("ZHIPU_BASE_URL", "http://127.0.0.1:19002");
    const pool = poolFromEnv();
    expect([...pool.keys()]).toEqual(["deepseek-v4-flash", "glm-5.3-flash", "deepseek-v4-pro", "glm-5.2", "glm-5.3"]);
    expect([...pool].every(([id, provider]) => provider.modelId === id)).toBe(true);
  });

  it("mock 优先，忽略显式真实模型与网络地址并保留故障注入", async () => {
    explicitModel();
    vi.stubEnv("LLM_PROVIDER", "mock");
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    const pool = poolFromEnv({ mockOpts: { "deepseek-v4-flash": { down: true } } });
    expect([...pool.values()].every((provider) => provider instanceof MockProvider)).toBe(true);
    expect(await pool.get("deepseek-v4-flash")!.healthy()).toBe(false);
    const result = await routeSmart({ action: "cs-answer", scene: "cs-answer", messages: [{ role: "user", content: "房态" }] }, pool, sink().events);
    expect(result.kind).toBe("answered");
    expect(result.modelTrace?.model_id).toBe("glm-5.3-flash");
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
