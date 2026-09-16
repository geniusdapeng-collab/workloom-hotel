/**
 * P14 渠道运营（B2：6–8 渠道价格/库存/活动/图评一屏巡检 + 内容营销）
 * 数据源：twin.archive（inspection 巡检快照/channels）+ twin.events（content.publish/competitor.fetch/price.publish）
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { Bridge } from "../../../shell/Bridge";
import { Skeleton, SystemDivider } from "../../../components/hud";
import { Ev, fmtTime, HBar, HotelStatusTag, Note, PageHead, Row } from "../components/Twin";
import { clientValueText } from "../labels";

interface ArchiveShape {
  channels?: Array<{ name: string; kind: string; channel_new?: boolean }>;
  inspection?: { channels?: Array<{ channel: string; price: number; parity: boolean; status: string }> };
}

const rightPanel = (
  <>
    <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">渠道治理</div>
    <div className="rounded-lg border border-gline bg-card p-3 text-body leading-relaxed text-ink3">倒挂与超售处置见价格健康；活动与图评整改由渠道运营数字员工产出。渠道「三失」（失控、失时、失准）在此收口。</div>
  </>
);

export default function P14() {
  const [ready, setReady] = useState(false);
  const [archive, setArchive] = useState<ArchiveShape | null>(null);
  const [contents, setContents] = useState<Ev[]>([]);
  const [competitor, setCompetitor] = useState<Ev[]>([]);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      await ensureDemoLogin();
      const result = await trpc.twin.channelOverview.query() as unknown as {
        archive: ArchiveShape;
        events: Ev[];
      };
      if (stop) return;
      setArchive(result.archive);
      setContents(result.events.filter((e) => e.decision.action === "content.publish"));
      setCompetitor(result.events.filter((e) => e.decision.action === "competitor.fetch"));
      setReady(true);
    };
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  const snap = archive?.inspection?.channels ?? [];
  const chanDefs = archive?.channels ?? [];

  return (
    <Bridge right={rightPanel}>
      <PageHead title="渠道运营" tag="渠道巡检与内容营销" extra={<HotelStatusTag tone="holo">每 30 分钟自动巡检</HotelStatusTag>} />
      {!ready ? (<><Skeleton count={2} height={44} variant="card" /><Skeleton count={4} /></>) : (
        <div className="space-y-3">
          <SystemDivider time="渠道巡检快照" summary="价格一致性 / 库存同步 / 在线状态（由门店档案中的巡检配置提供）" />
          {snap.length === 0 ? (
            <div className="rounded-lg border border-line bg-card p-3 text-body text-ink3">暂无巡检快照（档案中的巡检配置尚未完成）。</div>
          ) : snap.map((c) => (
            <Row key={c.channel} right={<>
              <HotelStatusTag tone={c.parity ? "go" : "warn"}>{c.parity ? "价格一致" : "价差异常"}</HotelStatusTag>
              <HotelStatusTag tone={c.status === "online" ? "holo" : "warn"}>{clientValueText(c.status)}</HotelStatusTag>
            </>}>
              <b className="break-words text-ink2">{clientValueText(c.channel, "经营渠道")}</b>
              <span className="ml-2 font-mono text-gold">¥{c.price}</span>
              {!c.parity ? <span className="ml-2 break-words text-warn">· 低于其他渠道，渠道价差保护正在复核</span> : null}
            </Row>
          ))}

          <SystemDivider time="渠道清单" summary={`${chanDefs.length} 个已接入渠道（在线旅行平台、直播与内容渠道）`} />
          <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
            {chanDefs.map((c) => (
              <div key={c.name} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-line bg-card px-3 py-2.5 text-body">
                <b className="min-w-0 break-words text-ink2">{clientValueText(c.name, "经营渠道")}</b>
                <span className="text-ink3">{clientValueText(c.kind, "渠道")}</span>
                <span className="flex-1" />
                {c.channel_new ? <HotelStatusTag tone="gold">新渠道 · 首次发布须审批</HotelStatusTag> : <HotelStatusTag tone="ink">成熟渠道</HotelStatusTag>}
              </div>
            ))}
          </div>

          <SystemDivider time="内容营销" summary="小红书与抖音发布全程留痕；新渠道和直播首次发布必须审批" />
          {contents.slice(0, 8).map((ev) => (
            <Row key={ev.event_id} time={fmtTime(ev.context.time)} right={<HotelStatusTag tone="go">已发布</HotelStatusTag>}>
              <b className="break-words text-ink2">{clientValueText(ev.decision.after?.title, "内容发布")}</b>
              <span className="break-words text-ink3"> · {clientValueText(ev.context.channel ?? ev.decision.params?.platform, "经营渠道")}</span>
            </Row>
          ))}
          <HBar label="竞对价格卡采集（30 天）" pct={Math.min(100, competitor.length * 3)} value={`${competitor.length} 次`} tone="bg-gold" />
          <Note>渠道「三失」治理：价格倒挂保护与超售下架见价格健康；活动报名与图片卖点整改建议由渠道运营技能产出。</Note>
        </div>
      )}
    </Bridge>
  );
}
