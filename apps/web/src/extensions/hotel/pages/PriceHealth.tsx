/**
 * P11 价格健康页（overbooking-parity-guard 数据投影）
 *  - 倒挂熔断（R17）/ 超售·同步失败防护（R18）/ 修复留痕（检出→处置→结果三段式）
 *  - 连续调价事件流（R1 白班 / R7 夜班微调，含 before/after/依据）
 *  - 数据源：twin.priceHealth（五元事件库 price.publish / inventory.sync / channel.parity.fixed / price.adjust）
 * 轮询：15s（D6 其余口径）
 */
import { useEffect, useMemo, useState } from "react";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { Bridge } from "../../../shell/Bridge";
import { EmptyState, Skeleton, SystemDivider } from "../../../components/hud";
import { clientIdentifierText, clientValueText } from "../labels";

interface Ev {
  event_id: string;
  context: { time: string; channel?: string; night_shift?: boolean };
  object: { type: string; id?: string; label?: string };
  decision: {
    action: string;
    before?: { price?: number };
    after?: { price?: number; blocked?: boolean; gap_pct?: number; auto_offshelf?: boolean; restored_price?: number; onshelf?: boolean; reason?: string };
    params?: { channel_price?: number; other_channel_min?: number; available?: number; sync_failed?: boolean };
    basis?: string[];
  };
  rule_impact: Array<{ rule_id: string; result: string }>;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
const ruleOf = (ev: Ev) => ev.rule_impact?.[0]?.rule_id ?? "";

export default function P11() {
  const [ready, setReady] = useState(false);
  const [blocks, setBlocks] = useState<Ev[]>([]);
  const [fixes, setFixes] = useState<Ev[]>([]);
  const [adjusts, setAdjusts] = useState<Ev[]>([]);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      await ensureDemoLogin();
      const r = (await trpc.twin.priceHealth.query()) as unknown as { blocks: Ev[]; fixes: Ev[]; adjusts: Ev[] };
      if (stop) return;
      setBlocks(r.blocks); setFixes(r.fixes); setAdjusts(r.adjusts);
      setReady(true);
    };
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  const parityBlocks = useMemo(() => blocks.filter((b) => ruleOf(b) === "R17"), [blocks]);
  const syncBlocks = useMemo(() => blocks.filter((b) => ruleOf(b) === "R18"), [blocks]);

  const right = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">30 天价格防护</div>
      {[
        { label: "渠道价差保护", n: parityBlocks.length, cls: "text-warn" },
        { label: "超售与同步防护", n: syncBlocks.length, cls: "text-warn" },
        { label: "自动修复回架", n: fixes.length, cls: "text-go" },
        { label: "连续调价动作", n: adjusts.length, cls: "text-holo" },
      ].map((s) => (
        <div key={s.label} className="mb-2 flex items-center justify-between rounded-lg border border-line bg-card px-3 py-2.5 text-body">
          <span className="text-ink2">{s.label}</span>
          <b className={`font-mono ${s.cls}`}>{s.n}</b>
        </div>
      ))}
      <div className="mt-3 rounded-lg border border-gline bg-card p-3 text-body leading-relaxed text-ink3">
        倒挂发布物理熔断；库存同步失败自动下架保护（防超售/漏售），人工核验后回架。检出→处置→结果三段留痕，全链可溯。
      </div>
    </>
  );

  return (
    <Bridge right={right}>
      <div className="mb-3 flex min-w-0 flex-wrap items-center gap-3">
        <h2 className="text-h1 font-black tracking-wider">价格健康</h2>
        <span className="text-body tracking-[.2em] text-ink3">价格健康</span>
      </div>

      {!ready ? (
        <><Skeleton count={2} height={44} variant="card" /><Skeleton count={4} /></>
      ) : blocks.length === 0 && adjusts.length === 0 ? (
        <EmptyState title="全渠道健康" hint="倒挂与超售零告警。系统每 15 分钟巡检一次。" />
      ) : (
        <div className="space-y-3">
          <SystemDivider time="防护留痕" summary="倒挂熔断 / 超售防护 / 修复回架（检出→处置→结果）" />
          {[...blocks, ...fixes]
            .sort((a, b) => +new Date(b.context.time) - +new Date(a.context.time))
            .map((ev) => {
              const rule = ruleOf(ev);
              const a = ev.decision.after ?? {};
              const p = ev.decision.params ?? {};
              const isFix = ev.decision.action.includes("fixed") || ev.decision.action.includes("restore");
              return (
                <div key={ev.event_id} className="rounded-lg border border-line bg-card p-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-body text-ink3">{fmtTime(ev.context.time)}</span>
                    <span className={`rounded border px-1.5 py-0.5 font-mono text-body ${isFix ? "border-go/40 text-go" : "border-warn/40 text-warn"}`}>
                      {isFix ? "已修复" : clientValueText(rule, "巡检")}
                    </span>
                    <span className="text-body font-semibold text-ink2">
                      {clientValueText(ev.context.channel, clientIdentifierText(ev.object.id, "经营渠道"))}
                    </span>
                  </div>
                  <div className="mt-1.5 text-body leading-relaxed text-ink3">
                    {ev.decision.action === "price.publish" && (
                      <>发布价 <b className="text-warn">¥{p.channel_price}</b> 低于其他渠道最低价的九成 → 倒挂熔断{a.gap_pct ? `（${a.gap_pct}%）` : ""}</>
                    )}
                    {ev.decision.action === "inventory.sync" && (
                      <>同步失败或可售异常 → <b className="text-warn">自动下架保护</b>{a.reason ? `（${clientValueText(a.reason, "原因已记录")}）` : ""}</>
                    )}
                    {ev.decision.action === "channel.parity.fixed" && (
                      <>一致性定价恢复 <b className="text-go">¥{a.restored_price}</b>（{clientValueText((a as { approved_by?: string }).approved_by, "人工")}审批）</>
                    )}
                    {ev.decision.action === "inventory.sync.restore" && <>直连恢复，人工核验后<b className="text-go">重新上架</b></>}
                    {ev.decision.basis?.[0] ? <div className="mt-1 break-words text-body">{clientValueText(ev.decision.basis[0], "已记录决策依据")}</div> : null}
                  </div>
                </div>
              );
            })}
          <SystemDivider time="连续调价流" summary="价格在围栏内连续调整：白班单次不超过 8%，夜班单次不超过 3%，符合条件时自动执行" />
          {adjusts.slice(0, 10).map((ev) => {
            const b = ev.decision.before?.price;
            const a = ev.decision.after?.price;
            const pct = b && a ? (((a - b) / b) * 100).toFixed(1) : null;
            return (
              <div key={ev.event_id} className="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5">
                <span className="font-mono text-body text-ink3">{fmtTime(ev.context.time)}</span>
                <span className="min-w-0 break-words text-body text-ink2">{clientValueText(ev.object.label, clientIdentifierText(ev.object.id, "房型"))}</span>
                <span className="font-mono text-body text-ink3">¥{b} → <b className="text-gold">¥{a}</b></span>
                {pct ? <span className="text-body text-go">+{pct}%</span> : null}
                <span className="flex-1" />
                <span className="rounded border border-line px-1.5 py-0.5 font-mono text-body text-ink3">
                  {clientValueText(ruleOf(ev), "围栏已判定")}{ev.context.night_shift ? " · 夜班" : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Bridge>
  );
}
