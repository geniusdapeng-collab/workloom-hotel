/**
 * P18 多店驾驶舱（A4：owner-cockpit —— 一屏管多店，管理半径 3→5–8 家）
 * 数据源：twin.stores（同租户各工作区最新 store.daily.summary + night.package.deliver，逐工作区 RLS 轮询）
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { Bridge } from "../../../shell/Bridge";
import { Skeleton, SystemDivider } from "../../../components/hud";
import { HBar, HotelStatusTag, Note, PageHead } from "../components/Twin";
import { clientValueText } from "../labels";

interface StoreRow {
  workspaceId: string; name: string; eventCount: number;
  daily: { context?: { time?: string }; decision?: { after?: { occ?: number; adr?: number; revpar?: number; rooms?: number } } } | null;
  nightPackage: { decision?: { after?: { done?: number; pending?: number; escalate?: number; fence_snapshot?: string } } } | null;
}

export default function P18() {
  const [ready, setReady] = useState(false);
  const [stores, setStores] = useState<StoreRow[]>([]);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      await ensureDemoLogin();
      const r = (await trpc.twin.stores.query()) as unknown as StoreRow[];
      if (stop) return;
      setStores(r); setReady(true);
    };
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  return (
    <Bridge>
      <PageHead title="多店驾驶舱" tag="多店经营" extra={<HotelStatusTag tone="gold">管理半径 3 → 5–8 家</HotelStatusTag>} />
      {!ready ? (<><Skeleton count={2} height={44} variant="card" /><Skeleton count={4} /></>) : (
        <div className="space-y-3">
          <SystemDivider time="全店经营快照" summary="各店最新日报（入住率、平均房价、每间可售房收入）+ 昨夜决策包三栏 + 事件规模" />
          {stores.map((s) => {
            const a = s.daily?.decision?.after ?? {};
            const pkg = s.nightPackage?.decision?.after ?? {};
            return (
              <div key={s.workspaceId} className="rounded-lg border border-line bg-card p-3.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                  <b className="min-w-0 break-words text-body text-ink2">{clientValueText(s.name, "未命名门店")}</b>
                  <span className="flex-1" />
                  <HotelStatusTag tone="holo">事件 {s.eventCount.toLocaleString()} 条</HotelStatusTag>
                </div>
                <div className="mt-2.5 grid grid-cols-1 gap-3 lg:grid-cols-3">
                  <HBar label="入住率" pct={Math.round(Number(a.occ ?? 0) * 100)} tone="bg-holo" />
                  <HBar label="平均房价" pct={Math.min(100, Math.round((Number(a.adr ?? 0) / 600) * 100))} value={`¥${a.adr ?? "—"}`} tone="bg-gold" />
                  <HBar label="每间可售房收入" pct={Math.min(100, Math.round((Number(a.revpar ?? 0) / 500) * 100))} value={`¥${a.revpar ?? "—"}`} tone="bg-go" />
                </div>
                <div className="mt-2 flex items-center gap-2 text-body">
                  <span className="text-ink3">昨夜决策包：</span>
                  <HotelStatusTag tone="go">已完成 {pkg.done ?? "—"}</HotelStatusTag>
                  <HotelStatusTag tone={pkg.pending ? "warn" : "ink"}>待审批 {pkg.pending ?? 0}</HotelStatusTag>
                  <HotelStatusTag tone={pkg.escalate ? "warn" : "ink"}>需介入 {pkg.escalate ?? 0}</HotelStatusTag>
                  <span className="flex-1" />
                  <span className="break-words font-mono text-body text-ink3">围栏快照 {clientValueText(pkg.fence_snapshot, "未记录")}</span>
                </div>
              </div>
            );
          })}
          <Note>告警收敛 + 跨店待审批收件箱 + 断点率排名：业主每天 5 分钟看完全部门店。三种业态（单体/民宿/无人）一套系统，扩张零边际系统成本。</Note>
        </div>
      )}
    </Bridge>
  );
}
