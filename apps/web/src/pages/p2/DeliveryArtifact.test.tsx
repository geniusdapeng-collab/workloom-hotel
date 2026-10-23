import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeliveryArtifact, deliveryArtifactData } from "./DeliveryArtifact";

describe("task timeline preserves complete Hotel worker/final artifacts and safe provenance", () => {
  const worker = (text: string, url = "https://example.org/hotel-report") => ({
    text, delivery: { schema: "workloom.hotel-delivery/v1", kind: "worker" },
    artifact: { title: "完整经营分析报告", digest: "a".repeat(64) }, businessDataMode: "simulated",
    sourceFacts: [{ id: "web:official-report", text: "公开酒店资料来源，页面日期与经营口径需另行复核。", url, mode: "external-public-unverified" }],
  });
  it("does not truncate long documents, preserves paragraph boundaries and exposes provenance links", () => {
    const text = `完整岗位分析。${"这是完整交付正文。".repeat(150)}\n\n末尾成果标记`;
    const data = deliveryArtifactData(worker(text), ["E-123"]);
    const html = renderToStaticMarkup(<DeliveryArtifact data={data!} eventId="E-124" senderId="pricing-agent" version="v1" receipt="unverified" />);
    expect(html).toContain("末尾成果标记"); expect(html).toContain("\n\n");
    expect(html).toContain('data-delivery-document="complete"'); expect(html).toContain('data-delivery-body="full"');
    expect(html).toContain('href="https://example.org/hotel-report"'); expect(html).toContain('href="#event-E-123"');
    expect(html).toContain("采用模拟经营资料"); expect(html).toContain("经营动作待另行决策");
  });
  it("summary events expose all worker receipts and retain the final text", () => {
    const data = deliveryArtifactData({ text: "最终汇总报告，完整引用了前序岗位的分析成果。", delivery: { schema: "workloom.hotel-delivery/v1", kind: "summary" } }, ["E-1", "E-2", "not-an-event"]);
    const html = renderToStaticMarkup(<DeliveryArtifact data={data!} eventId="E-3" senderId="pricing-agent" version="v1" receipt="unverified" />);
    expect(html).toContain("多岗位成果汇总"); expect(html).toContain("最终汇总报告");
    expect(html).toContain('href="#event-E-1"'); expect(html).toContain('href="#event-E-2"'); expect(html).not.toContain("not-an-event");
  });
  it.each(["javascript:alert(1)", "data:text/html,hello", "https://user:password@example.org/"])("does not turn an unsafe citation into a link: %s", (url) => {
    const data = deliveryArtifactData(worker("公开资料引用仍须人工复核，正文不能执行任何页面内容。", url));
    const html = renderToStaticMarkup(<DeliveryArtifact data={data!} eventId="E-4" senderId="pricing-agent" version="v1" receipt="unverified" />);
    expect(html).not.toContain(`href="${url}`);
  });
  it("keeps arbitrary legacy answers on their existing display path", () => {
    for (const value of [null, {}, { text: "普通应答" }, { text: "普通应答", delivery: { schema: "other", kind: "worker" } }]) expect(deliveryArtifactData(value)).toBeNull();
  });
});
