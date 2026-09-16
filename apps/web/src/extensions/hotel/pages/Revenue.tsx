/**
 * P19 收益分析（A3：从「做报表」到「问问题」——预设问数真实聚合自事件库）
 * 数据源：twin.report（channel_revenue / occ_trend / price_attribution 三预设）
 * 说明：自然语言自由查询在 LLM 取数接线后开放；当前预设问题已是真实聚合，非写死数字。
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { Bridge } from "../../../shell/Bridge";
import { Skeleton, SystemDivider } from "../../../components/hud";
import { HBar, HotelStatusTag, Note, PageHead } from "../components/Twin";
import { clientIdentifierText, clientValueText } from "../labels";

type Q = "channel_revenue" | "occ_trend" | "price_attribution";
const QUESTIONS: Array<{ key: Q; label: string }> = [
  { key: "channel_revenue", label: "本月各渠道收入与订单量" },
  { key: "occ_trend", label: "近 30 天入住率、平均房价与每间可售房收入走势" },
  { key: "price_attribution", label: "调价动作与依据归因" },
];

interface ReportResult { kind: string; rows: Array<Record<string, unknown>> }

const rightPanel = (
  <>
    <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">收益分析</div>
    <div className="rounded-lg border border-gline bg-card p-3 text-body leading-relaxed text-ink3">从做报表到问问题：数据已在事件库，报表是提问的即时答案。自由问答将在智能取数能力接通后开放。</div>
  </>
);

export default function P19() {
  const [ready, setReady] = useState(false);
  const [q, setQ] = useState<Q>("channel_revenue");
  const [result, setResult] = useState<ReportResult | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      await ensureDemoLogin();
      const r = (await trpc.twin.report.query({ question: q })) as unknown as ReportResult;
      if (stop) return;
      setResult(r); setReady(true);
    };
    setReady(false);
    void load();
    return () => { stop = true; };
  }, [q]);

  const maxRevenue = Math.max(1, ...(result?.rows.map((r) => Number(r.revenue ?? 0)) ?? [1]));

  return (
    <Bridge right={rightPanel}>
      <PageHead title="收益分析" tag="经营问数" extra={<HotelStatusTag tone="holo">问数即答</HotelStatusTag>} />
      <div className="mb-3 flex flex-wrap gap-2">
        {QUESTIONS.map((x) => (
          <button key={x.key} type="button" onClick={() => setQ(x.key)}
            className={`max-w-full whitespace-normal break-words rounded-lg border px-3 py-1.5 text-body transition-colors ${q === x.key ? "border-gline bg-card text-gold" : "border-line bg-card text-ink3 hover:border-gline"}`}>
            {x.label}
          </button>
        ))}
      </div>
      {!ready || !result ? (<><Skeleton count={2} height={44} variant="card" /><Skeleton count={4} /></>) : (
        <div className="space-y-3">
          {q === "channel_revenue" && (
            <>
              <SystemDivider time="渠道收入" summary="订单确认事件实时聚合（订单量 × 金额）" />
              {result.rows.map((r) => (
                <HBar key={String(r.channel)} label={clientValueText(r.channel, "经营渠道")} pct={Math.round((Number(r.revenue) / maxRevenue) * 100)}
                  value={`¥${Number(r.revenue).toLocaleString()} · ${r.orders} 单`} tone="bg-gold" />
              ))}
              <Note>直连渠道零佣金，净贡献率最高。提升直连占比是客户留存经理的持续建议方向，业主月报可一键导出。</Note>
            </>
          )}
          {q === "occ_trend" && (
            <>
              <SystemDivider time="30 天走势" summary="门店经营日报每日快照（由夜班班组生成）" />
              {[...result.rows].reverse().map((r) => (
                <HBar key={String(r.date)} label={String(r.date).slice(5)} pct={Math.round(Number(r.occ ?? 0) * 100)}
                  value={`入住率 ${(Number(r.occ ?? 0) * 100).toFixed(0)}% · 平均房价 ¥${r.adr ?? "—"}`} tone="bg-holo" />
              ))}
            </>
          )}
          {q === "price_attribution" && (
            <>
              <SystemDivider time="调价归因" summary="每次调价都记录调整前价格、调整后价格、依据与围栏判定；调价与订单同库，效果可归因" />
              {result.rows.slice(0, 20).map((r, i) => (
                <div key={i} className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5 text-body">
                  <span className="font-mono text-body text-ink3">{String(r.time).slice(5, 16)}</span>
                  <span className="break-words text-ink2">{clientIdentifierText(r.object, "房型")}</span>
                  <span className="font-mono text-ink3">¥{String(r.before)} → <b className="text-gold">¥{String(r.after)}</b></span>
                  <HotelStatusTag tone="holo">{clientValueText(r.rule, "围栏已判定")}</HotelStatusTag>
                  <span className="min-w-0 flex-[1_1_16rem] break-words text-right text-body text-ink3">{Array.isArray(r.basis) ? clientValueText((r.basis as string[])[0], "已记录调价依据") : ""}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </Bridge>
  );
}
