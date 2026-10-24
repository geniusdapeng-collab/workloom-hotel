import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredHotelResearchProvider, hotelSearchEndpoint, searchHotelPublicFacts } from "./research.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("酒店公开资料检索", () => {
  it("只允许官方与回环网关，拒绝把凭据送给其他站点", () => {
    expect(hotelSearchEndpoint("https://api.deepseek.com")).toBe("https://api.deepseek.com/v1/tools/search");
    expect(hotelSearchEndpoint("http://127.0.0.1:18555/v1")).toBe("http://127.0.0.1:18555/v1/tools/search");
    for (const base of ["https://example.com", "https://api.deepseek.com.evil.example", "https://key@api.deepseek.com", "https://api.deepseek.com/x", "https://api.deepseek.com?key=x"]) {
      expect(() => hotelSearchEndpoint(base)).toThrow();
    }
  });

  it("按官方接口提交限定查询并返回带来源与时间的资料", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [
      { title: "杭州文旅", url: "https://example.org/hotel", summary: "公开酒店服务说明", date: "2026-10-23" },
      { title: "重复", url: "https://example.org/hotel", summary: "重复内容" },
      { title: "无效", url: "javascript:alert(1)", summary: "无效链接" },
    ] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const facts = await searchHotelPublicFacts("杭州酒店公开政策", { baseUrl: "http://127.0.0.1:18555/v1", apiKey: "fixture-only", now: new Date("2026-10-24T00:00:00Z") });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.id).toMatch(/^web:[0-9a-f]{20}$/);
    expect(facts[0]?.text).toContain("不证明酒店实时房价或库存");
    expect(facts[0]?.text).toContain("2026-10-24T00:00:00.000Z");
    const [, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({ query: "杭州酒店公开政策", count: 3, need_content: false });
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeDefined();
    expect(options.body).not.toContain("fixture-only");
  });

  it.each([401, 402, 429, 500])("HTTP %s 不得生成虚假检索来源", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
    await expect(searchHotelPublicFacts("杭州酒店", { baseUrl: "https://api.deepseek.com", apiKey: "fixture-only" })).rejects.toThrow(`HTTP ${status}`);
  });

  it.each([{}, { results: [] }, { results: [{ title: "空摘要", url: "https://example.org" }] }])("空/错误回执保持未核实", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    await expect(searchHotelPublicFacts("杭州酒店", { baseUrl: "https://api.deepseek.com", apiKey: "fixture-only" })).rejects.toThrow();
  });

  it("检索显式开启，仅市场侦察或明确查询目标触发", async () => {
    expect(configuredHotelResearchProvider()).toBeUndefined();
    vi.stubEnv("DEEPSEEK_SEARCH_ENABLED", "1");
    vi.stubEnv("LLM_API_KEY", "fixture-only");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [{ title: "酒店", url: "https://example.org", summary: "酒店资料" }] })));
    vi.stubGlobal("fetch", fetcher);
    expect(await configuredHotelResearchProvider()!("起草交接清单", "frontdesk-agent")).toEqual([]);
    await configuredHotelResearchProvider()!("酒店市场分析", "competitor-agent");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
