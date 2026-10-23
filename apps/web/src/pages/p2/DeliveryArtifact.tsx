import { AgentActionMessage, type ReceiptState } from "../../components/hud";
import { actorText } from "../../lib/display";
import { clientNaturalText } from "../../lib/clientText";

interface SourceFact { id: string; text: string; url?: string; mode?: string }
export interface DeliveryArtifactData {
  kind: "worker" | "summary";
  text: string;
  title?: string;
  digest?: string;
  sources: SourceFact[];
  links: string[];
  simulated: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Only explicit versioned internal-delivery events receive the document view. */
export function deliveryArtifactData(after: unknown, links: string[] = []): DeliveryArtifactData | null {
  if (!record(after) || !record(after.delivery) || after.delivery.schema !== "workloom.hotel-delivery/v1"
    || !["worker", "summary"].includes(String(after.delivery.kind)) || typeof after.text !== "string") return null;
  const artifact = record(after.artifact) ? after.artifact : {};
  const sources = Array.isArray(after.sourceFacts) ? after.sourceFacts.filter((source): source is SourceFact =>
    record(source) && typeof source.id === "string" && typeof source.text === "string"
    && (source.url === undefined || typeof source.url === "string")) : [];
  return {
    kind: after.delivery.kind as "worker" | "summary", text: after.text,
    ...(typeof artifact.title === "string" ? { title: artifact.title } : {}),
    ...(typeof artifact.digest === "string" && /^[a-f0-9]{64}$/.test(artifact.digest) ? { digest: artifact.digest } : {}),
    sources, links: links.filter((id) => /^E-\d+$/.test(id)),
    simulated: after.businessDataMode === "simulated" || sources.some((source) => source.mode === "simulated"),
  };
}

function publicUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function sourceLabel(source: SourceFact, index: number): string {
  if (source.url) return `公开网页参考 ${index + 1}`;
  if (source.id.startsWith("archive:")) return "酒店档案快照";
  if (source.id.startsWith("workspace:")) return "酒店经营阶段与工作区";
  return `经营事件资料 ${index + 1}`;
}

export function DeliveryArtifact({
  data, eventId, senderId, version, receipt, credits,
}: {
  data: DeliveryArtifactData; eventId: string; senderId: string; version: string; receipt: ReceiptState; credits?: number;
}) {
  const text = data.text.replace(/^## ([a-z][a-z0-9-]+) · [A-Za-z0-9_-]+$/gm,
    (_line, presetKey: string) => `## ${actorText(presetKey)}的岗位成果`);
  return (
    <article id={`event-${eventId}`} data-delivery-kind={data.kind} data-delivery-digest={data.digest} className="min-w-0 scroll-mt-8">
      <AgentActionMessage sender={actorText(senderId)} version={version}
        action={data.kind === "summary" ? "多岗位成果汇总" : "岗位分析与草稿"}
        eventId={eventId} receipt={receipt} credits={credits}>
        <div className="min-w-0 space-y-3" data-delivery-document="complete">
          <div className="flex flex-wrap gap-1.5 text-body">
            <span className="rounded border border-holo/40 bg-holo/5 px-2 py-0.5 text-holo">内部成果已入账</span>
            <span className="rounded border border-warn/40 bg-warn/5 px-2 py-0.5 text-warn">经营动作待另行决策</span>
            {data.simulated && <span className="rounded border border-warn/40 bg-warn/5 px-2 py-0.5 text-warn">采用模拟经营资料</span>}
          </div>
          {data.title && <h3 className="break-words font-bold text-ink">{clientNaturalText(data.title, "岗位交付成果")}</h3>}
          <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]" data-delivery-body="full">
            {clientNaturalText(text, "产物正文暂时无法显示，请通过本条账本凭证复核。")}
          </div>
          {data.links.length > 0 && (
            <nav aria-label="协作产物交接链" className="flex flex-wrap gap-2 border-t border-line pt-2">
              {data.links.map((id, index) => <a key={id} href={`#event-${id}`}
                className="rounded border border-holo/40 px-2 py-1 text-holo underline decoration-holo/40 hover:bg-holo/10 focus-visible:outline-2 focus-visible:outline-holo">查看岗位交接成果 {index + 1}</a>)}
            </nav>
          )}
          {data.sources.length > 0 && (
            <details className="min-w-0 rounded border border-line p-2">
              <summary className="cursor-pointer text-holo">依据资料与公开引用（{data.sources.length} 项）</summary>
              <ol className="mt-2 list-decimal space-y-2 pl-5 text-ink3">
                {data.sources.map((source, index) => {
                  const url = publicUrl(source.url);
                  return <li key={source.id} className="break-words [overflow-wrap:anywhere]">
                    {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-holo underline hover:text-gold">{sourceLabel(source, index)}</a>
                      : /^E-\d+$/.test(source.id) ? <a href={`#event-${source.id}`} className="text-holo underline">{sourceLabel(source, index)}</a>
                        : <span>{sourceLabel(source, index)}</span>}
                    {url && <div className="mt-0.5 whitespace-pre-wrap">{clientNaturalText(source.text, "公开资料已留档，点击链接核对原文。")}</div>}
                    <div className="mt-0.5 text-body">{source.mode === "simulated" ? "模拟资料，不代表酒店实时经营结果。"
                      : url ? "公开网页资料，需结合原文日期与酒店实际情况复核。" : "依据范围为本次保存的档案或事件快照。"}</div>
                  </li>;
                })}
              </ol>
            </details>
          )}
        </div>
      </AgentActionMessage>
    </article>
  );
}
