/**
 * P13 订单全流程穿透（B1：下单→确认→排房→入住→服务→退房→发票 全链可视）
 * 数据源：twin.events(order.confirm/reconcile/refund) + twin.objectTrail（单订单正序回放）
 */
import { useEffect, useState } from "react";
import { actionText } from "../../../lib/display";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { Bridge } from "../../../shell/Bridge";
import { EmptyState, Skeleton, SystemDivider } from "../../../components/hud";
import { Ev, fmtTime, HotelStatusTag, Note, PageHead, Row, Stat } from "../components/Twin";
import { actorText, clientIdentifierText, clientValueText } from "../labels";

const rightPanel = (
  <>
    <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">订单穿透</div>
    <div className="rounded-lg border border-gline bg-card p-3 text-body leading-relaxed text-ink3">每环含执行者（人或数字员工）、耗时、围栏判定与依据。异常环节一眼定位——订单状态再不用打电话问技术。</div>
  </>
);

export default function P13() {
  const [ready, setReady] = useState(false);
  const [orders, setOrders] = useState<Ev[]>([]);
  const [trail, setTrail] = useState<{ id: string; evs: Ev[] } | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let stop = false;
    const load = async () => {
      await ensureDemoLogin();
      const r = (await trpc.twin.orderEvents.query()) as unknown as Ev[];
      if (stop) return;
      setOrders(r); setReady(true);
    };
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  const openTrail = async (id: string) => {
    const evs = (await trpc.twin.objectTrail.query({ objectId: id })) as unknown as Ev[];
    setTrail({ id, evs });
  };

  const confirms = orders.filter((e) => e.decision.action === "order.confirm");
  const refunds = orders.filter((e) => e.decision.action === "order.refund");

  return (
    <Bridge right={rightPanel}>
      <PageHead title="订单全流程穿透" tag="订单事件链" extra={
        <form className="flex min-w-0 flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim()) void openTrail(q.trim()); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="输入订单号"
            className="min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-1.5 text-body text-ink2 outline-none focus:border-gline" />
          <button type="submit" className="whitespace-normal break-words rounded-lg border border-gline bg-card px-3 py-1.5 text-body text-gold">穿透</button>
        </form>
      } />
      {!ready ? (<><Skeleton count={2} height={44} variant="card" /><Skeleton count={4} /></>) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <Stat label="订单确认（样本窗口）" value={confirms.length} hint="信息完整校验后自动确认" />
            <Stat label="对账三轮一致" value={orders.filter((e) => e.decision.action === "order.reconcile").length} tone="text-go" hint="订单×渠道×担保" />
            <Stat label="大额退款须审批" value={refunds.length} tone="text-warn" hint="达到 ¥500 时挂起审批" />
          </div>

          {trail && (
            <div className="rounded-lg border border-gline bg-card p-3">
              <div className="mb-2 flex items-center gap-2">
                <b className="break-words text-body text-gold">{clientIdentifierText(trail.id, "订单编号未记录")}</b>
                <span className="text-body text-ink3">全链 {trail.evs.length} 环（正序回放，哈希链可验）</span>
                <span className="flex-1" />
                <button type="button" onClick={() => setTrail(null)} className="whitespace-normal break-words text-body text-ink3 hover:text-ink2">收起</button>
              </div>
              {trail.evs.length === 0 ? <div className="text-body text-ink3">未找到该对象事件（检查订单号）。</div> : trail.evs.map((ev) => (
                <div key={ev.event_id} className="flex items-start gap-2.5 py-1.5">
                  <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-go" />
                  <div className="text-body">
                    <span className="font-mono text-ink3">{fmtTime(ev.context.time)}</span>
                    <span className="mx-2 font-semibold text-ink2">{actionText(ev.decision.action)}</span>
                    <span className="break-words text-ink3">{actorText(ev.who)}</span>
                    {ev.rule_impact?.[0] ? <span className="ml-2"><HotelStatusTag tone="holo">{clientValueText(ev.rule_impact[0].rule_id, "围栏规则")} · {clientValueText(ev.rule_impact[0].result, "已判定")}</HotelStatusTag></span> : null}
                    {ev.decision.basis?.[0] ? <div className="mt-0.5 break-words text-body text-ink3">{clientValueText(ev.decision.basis[0], "已记录决策依据")}</div> : null}
                  </div>
                </div>
              ))}
            </div>
          )}

          <SystemDivider time="订单流" summary="每单可点「穿透」查看全链：执行者/耗时/围栏判定/依据 逐环可溯" />
          {orders.slice(0, 25).map((ev) => (
            <Row key={ev.event_id} time={fmtTime(ev.context.time)}
              right={<button type="button" onClick={() => void openTrail(String(ev.object.id))} className="rounded border border-line px-2 py-0.5 font-mono text-body text-holo hover:border-gline">穿透</button>}>
              <b className="text-ink2">{clientIdentifierText(ev.object.id, "订单编号未记录")}</b>
              <span className="break-words text-ink3"> · {clientValueText(ev.context.channel, "直连")} · {ev.decision.action === "order.confirm" ? "已确认（可售校验通过）" : ev.decision.action === "order.reconcile" ? "对账一致" : "退款审批"}</span>
              {ev.decision.params?.amount ? <span className="ml-2 font-mono text-gold">¥{String(ev.decision.params.amount)}</span> : null}
            </Row>
          ))}
          {orders.length === 0 ? <EmptyState title="暂无订单事件" hint="订单产生后在此汇聚，支持全链穿透。" /> : null}
          <Note>穿透能力来自五元事件：每环含执行者、耗时、围栏判定与依据。异常环节一眼定位，不用再打电话问技术。</Note>
        </div>
      )}
    </Bridge>
  );
}
