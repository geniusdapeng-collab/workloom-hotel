/**
 * P20 门店档案全景（槽①：五类 21 字段组——Agent 生成内容前必读三要素之一 L3.7）
 * 数据源：twin.archive（profiles.archive 全量 + forbidden 硬约束独立列）
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { Bridge } from "../../../shell/Bridge";
import { EmptyState, Skeleton } from "../../../components/hud";
import { HotelStatusTag, Note, PageHead } from "../components/Twin";
import { fieldLabel, clientValueText } from "../labels";

type Archive = Record<string, unknown>;

/** 字段组展示分节（五类口径与 schemas/archive.schema.json 对齐） */
const SECTIONS: Array<{ title: string; keys: string[] }> = [
  { title: "基础类", keys: ["property", "brand_guideline"] },
  { title: "业务类", keys: ["business", "competitors", "channels", "price_calendar", "goals", "audience", "history_curve"] },
  { title: "运营类", keys: ["operations", "staffing", "suppliers", "linen", "incident_profile", "faq_kb", "inspection"] },
  { title: "治理类", keys: ["sop", "forbidden", "approval_matrix", "compensation_policy"] },
  { title: "记忆类", keys: ["memory"] },
];

function renderValue(v: unknown, depth = 0): React.ReactNode {
  if (v === null || v === undefined) return <span className="text-ink3">—</span>;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return <span className="text-ink2">{clientValueText(v)}</span>;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== "object")) return <span className="break-words text-ink2">{v.map((item) => clientValueText(item)).join("、")}</span>;
    return (
      <div className="mt-1 space-y-1">
        {v.slice(0, 6).map((x, i) => (
          <div key={i} className="rounded border border-line bg-bg950 px-2 py-1">{renderValue(x, depth + 1)}</div>
        ))}
        {v.length > 6 ? <div className="text-body text-ink3">…共 {v.length} 项</div> : null}
      </div>
    );
  }
  const entries = Object.entries(v as Record<string, unknown>);
  return (
    <div className="grid min-w-0 grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-body">
      {entries.slice(0, 12).map(([k, val]) => (
        <div key={k} className="contents">
          <span className="text-ink3">{fieldLabel(k)}</span>
          <span className="min-w-0 break-words">{renderValue(val, depth + 1)}</span>
        </div>
      ))}
      {entries.length > 12 ? <div className="col-span-2 text-body text-ink3">…共 {entries.length} 字段</div> : null}
    </div>
  );
}

const rightPanel = (
  <>
    <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">档案即配置</div>
    <div className="rounded-lg border border-gline bg-card p-3 text-body leading-relaxed text-ink3">改档案即改系统行为边界：保底价、审批矩阵、损耗基线分别与对应围栏共用同一事实源。</div>
  </>
);

export default function P20() {
  const [ready, setReady] = useState(false);
  const [archive, setArchive] = useState<Archive | null>(null);

  useEffect(() => {
    void (async () => {
      await ensureDemoLogin();
      const r = (await trpc.twin.archive.query()) as unknown as { archive: Archive } | null;
      setArchive(r?.archive ?? null);
      setReady(true);
    })();
  }, []);

  return (
    <Bridge right={rightPanel}>
      <PageHead title="门店档案" tag="门店事实源" extra={<HotelStatusTag tone="gold">全景档案</HotelStatusTag>} />
      {!ready ? (<><Skeleton count={2} height={44} variant="card" /><Skeleton count={4} /></>) : !archive ? (
        <EmptyState title="档案未建立" hint="门店档案是数字员工生成内容前必须读取的事实源。" />
      ) : (
        <div className="space-y-3">
          {SECTIONS.map((sec) => {
            const present = sec.keys.filter((k) => archive[k] !== undefined);
            if (present.length === 0) return null;
            return (
              <div key={sec.title} className="rounded-lg border border-line bg-card p-3">
                <div className="mb-2 text-body tracking-[.15em] text-gold">{sec.title}</div>
                <div className="space-y-2.5">
                  {present.map((k) => (
                    <div key={k}>
                      <div className="mb-0.5 flex items-center gap-2">
                        <span className="text-body text-holo">{fieldLabel(k)}</span>
                        {k === "forbidden" ? <HotelStatusTag tone="warn">硬约束 · 双重校验</HotelStatusTag> : null}
                        {k === "goals" ? <HotelStatusTag tone="gold">经营目标数据源</HotelStatusTag> : null}
                        {k === "faq_kb" ? <HotelStatusTag tone="go">语音前台数据源</HotelStatusTag> : null}
                      </div>
                      {renderValue(archive[k])}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          <Note>档案即配置：保底价、审批矩阵与损耗基线分别和对应围栏共用同一事实源。改档案即改系统行为边界，所有数字员工读取同一事实源。</Note>
        </div>
      )}
    </Bridge>
  );
}
