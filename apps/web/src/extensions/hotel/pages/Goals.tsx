/**
 * P12 经营目标页（目标设定与追踪：门店档案 goals 字段组 × goal.tracking 周频回写）
 *  - 年度/月度目标卡（OCC/ADR/RevPAR/营收）+ 渠道·房型分解
 *  - 周频达成追踪：目标 vs 时序进度（behind → 琥珀预警）+ 偏差自动归因
 *  - 数据源：twin.goals（profiles.archive.goals + biz_events goal.tracking）
 * 轮询：15s（D6 其余口径）
 */
import { useEffect, useMemo, useState } from "react";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { Bridge } from "../../../shell/Bridge";
import { EmptyState, Skeleton, SystemDivider } from "../../../components/hud";
import { clientValueText } from "../labels";

interface Tracking {
  event_id: string;
  context: { time: string };
  decision: {
    params?: { week?: number; month?: string };
    after?: {
      occ?: { target: number; actual: number; pace: string };
      revenue?: { target: number; actual: number };
      attribution?: string[];
    };
    basis?: string[];
  };
}
interface Goals {
  year?: { revenue?: number; occ?: number; adr?: number; revpar?: number; bad_review_rate?: number; repurchase_rate?: number };
  month_2026_08?: { revenue?: number; occ?: number; adr?: number; note?: string };
  breakdown?: { channels?: Record<string, number>; room_types?: Record<string, number> };
}

const pct = (n?: number) => (typeof n === "number" ? `${(n * 100).toFixed(1)}%` : "—");
const wan = (n?: number) => (typeof n === "number" ? `¥${(n / 10000).toFixed(1)}万` : "—");

export default function P12() {
  const [ready, setReady] = useState(false);
  const [goals, setGoals] = useState<Goals | null>(null);
  const [trackings, setTrackings] = useState<Tracking[]>([]);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      await ensureDemoLogin();
      const r = (await trpc.twin.goals.query()) as unknown as { goals: Goals | null; trackings: Tracking[] };
      if (stop) return;
      setGoals(r.goals); setTrackings(r.trackings);
      setReady(true);
    };
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  const latest = trackings[0];
  const occT = latest?.decision.after?.occ;
  const revT = latest?.decision.after?.revenue;
  const monthGoal = goals?.month_2026_08;
  const pacePct = useMemo(() => {
    if (!occT || !monthGoal?.occ) return 0;
    return Math.min(100, Math.round((occT.actual / monthGoal.occ) * 100));
  }, [occT, monthGoal]);

  const right = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">年度目标</div>
      <div className="min-w-0 break-words rounded-lg border border-line bg-card p-3 text-body leading-relaxed text-ink2">
        <div>营收 <b className="text-gold">{wan(goals?.year?.revenue)}</b></div>
        <div>入住率 <b className="text-gold">{pct(goals?.year?.occ)}</b> · 平均房价 <b className="text-gold">¥{goals?.year?.adr ?? "—"}</b> · 每间可售房收入 <b className="text-gold">¥{goals?.year?.revpar ?? "—"}</b></div>
        <div>差评率 ≤ <b>{pct(goals?.year?.bad_review_rate)}</b> · 复购率 <b>{pct(goals?.year?.repurchase_rate)}</b></div>
      </div>
      <div className="mb-2 mt-3 px-1 text-body tracking-[.2em] text-ink3">渠道分解</div>
      {Object.entries(goals?.breakdown?.channels ?? {}).map(([k, v]) => (
        <div key={k} className="mb-2">
          <div className="flex min-w-0 flex-wrap justify-between gap-2 text-body text-ink3"><span className="break-words">{clientValueText(k, "经营渠道")}</span><span className="font-mono">{pct(v)}</span></div>
          <div className="mt-1 h-1.5 overflow-hidden rounded bg-bg950"><div className="h-full rounded bg-holo" style={{ width: pct(v) }} /></div>
        </div>
      ))}
      <div className="mt-3 rounded-lg border border-gline bg-card p-3 text-body leading-relaxed text-ink3">
        目标从年初口号变成每周作战：达成偏离时序进度自动归因，并联动收益数字员工生成待复核的补救建议。
      </div>
    </>
  );

  return (
    <Bridge right={right}>
      <div className="mb-3 flex min-w-0 flex-wrap items-center gap-3">
        <h2 className="min-w-0 break-words text-h1 font-black tracking-wider">经营目标</h2>
        <span className="break-words text-body tracking-[.2em] text-ink3">目标追踪</span>
        <span className="flex-1" />
        {monthGoal?.note ? <span className="rounded-lg border border-line bg-card px-2.5 py-1 text-body text-gold">{monthGoal.note}</span> : null}
      </div>

      {!ready ? (
        <><Skeleton count={2} height={44} variant="card" /><Skeleton count={4} /></>
      ) : !goals ? (
        <EmptyState title="尚未设定经营目标" hint="使用目标设定向导：年度目标 → 自动分解到月、渠道与房型（可一键采用同档门店基准值）。" />
      ) : (
        <div className="space-y-3">
          {/* 月度目标卡 */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="rounded-lg border border-line bg-card p-3">
              <div className="text-body text-ink3">月营收目标</div>
              <div className="mt-1 text-h1 font-black text-gold">{wan(monthGoal?.revenue)}</div>
              <div className="mt-1 text-body text-ink3">当前 <b className="text-ink2">{wan(revT?.actual)}</b></div>
            </div>
            <div className="rounded-lg border border-line bg-card p-3">
              <div className="text-body text-ink3">入住率目标与实际</div>
              <div className="mt-1 break-words text-h1 font-black text-ink2">{pct(monthGoal?.occ)} <span className="text-body text-ink3">/ {pct(occT?.actual)}</span></div>
              <div className="mt-1 text-body">
                {occT?.pace === "on_track" ? <span className="text-go">进度正常</span> : <span className="text-warn">落后时序</span>}
              </div>
            </div>
            <div className="rounded-lg border border-line bg-card p-3">
              <div className="text-body text-ink3">平均房价目标</div>
              <div className="mt-1 text-h1 font-black text-ink2">¥{monthGoal?.adr ?? "—"}</div>
              <div className="mt-1 text-body text-ink3">每间可售房收入年目标 ¥{goals?.year?.revpar ?? "—"}</div>
            </div>
          </div>
          {/* 时序进度条 */}
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="flex justify-between text-body text-ink3"><span>入住率达成进度</span><span className="font-mono text-gold">{pacePct}%</span></div>
            <div className="mt-1.5 h-2 overflow-hidden rounded bg-bg950">
              <div className={`h-full rounded ${occT?.pace === "on_track" ? "bg-go" : "bg-warn"}`} style={{ width: `${pacePct}%` }} />
            </div>
          </div>
          {/* 周频追踪 */}
          <SystemDivider time="周频追踪" summary="目标追踪事件按周回写：达成率 + 时序比对 + 偏差归因（事件同库可溯源）" />
          {trackings.map((t) => {
            const a = t.decision.after ?? {};
            const behind = a.occ?.pace !== "on_track";
            return (
              <div key={t.event_id} className="rounded-lg border border-line bg-card p-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="rounded border border-line px-1.5 py-0.5 font-mono text-body text-ink3">第 {t.decision.params?.week ?? "—"} 周</span>
                  <span className="break-words text-body text-ink2">入住率 {pct(a.occ?.actual)}（目标 {pct(a.occ?.target)}）</span>
                  <span className={`text-body ${behind ? "text-warn" : "text-go"}`}>{behind ? "落后时序" : "进度正常"}</span>
                  <span className="flex-1" />
                  <span className="font-mono text-body text-ink3">营收 {wan(a.revenue?.actual)}</span>
                </div>
                {a.attribution && a.attribution.length > 0 ? (
                  <div className="mt-1.5 min-w-0 break-words text-body text-ink3">偏差归因：{a.attribution.map((x) => <span key={x} className="mr-2 inline-block max-w-full break-words rounded bg-bg950 px-1.5 py-0.5 text-warn">{clientValueText(x, "经营因素")}</span>)}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Bridge>
  );
}
