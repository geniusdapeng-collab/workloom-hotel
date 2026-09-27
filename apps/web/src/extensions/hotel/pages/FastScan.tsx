/** 酒店快速体检：调用方快照预览、授权留痕与幂等回执。 */
import { useEffect, useState, type ChangeEvent } from "react";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { Bridge } from "../../../shell/Bridge";
import { EmptyState } from "../../../components/hud";
import { clientIdentifierText, clientValueText } from "../labels";

type SnapshotInput = Parameters<typeof trpc.twin.fastScanPreview.mutate>[0]["snapshot"];
type Finding = {
  id: string; line: string; severity: string; title: string; description: string; suggestion: string;
  calculation?: { formula: string; result: number | string };
  evidence?: Array<{ kind: string; id: string; note?: string }>;
  estimatedImpact?: { amount: number; currency: string; confidence: string };
};
type Report = {
  reportId: string; snapshotId: string; generatedAt: string;
  coverage: Record<string, string>; coverageNotes: string[];
  overview: { hotelCount: number; findingCount: number; counts: Record<string, number>; totalRecoverableByCurrency: Record<string, number> };
  hotels: Array<{ hotelId: string; hotelName: string; findings: Finding[] }>;
};
type Result = { report: Report | null; sourceVerified: boolean; deduped?: boolean };
type CapabilityResponse = { status: string; dataMode: string; result: Result; receipt?: { eventId: string; synced: boolean; sourceVerified: boolean } };
type Busy = "preview" | "execute" | "receipt" | null;

const LAST_KEY = "workloom-hotel-fast-scan-last-key";
const button = "rounded-lg border border-gold/40 bg-gold/10 px-4 py-2 text-body font-semibold text-gold transition hover:bg-gold/20 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50";
const quietButton = "rounded-lg border border-line px-4 py-2 text-body text-ink2 transition hover:border-gold/40 hover:text-gold active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50";
const lineNames: Record<string, string> = { price: "价格", inventory: "房态库存", channel: "渠道", reputation: "口碑", safety: "安全与断点" };
const coverageNames: Record<string, string> = { covered: "已覆盖", partial: "部分覆盖", "not-covered": "未覆盖" };
const confidenceNames: Record<string, string> = { exact: "精确值", baseline: "基准估算", estimate: "经验估计" };

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|network|unexpected end of json|fetch failed/i.test(message)
    ? "服务暂时不可达，请检查 WorkLoom 服务连接后重试"
    : message;
}

function parseSnapshot(raw: string): SnapshotInput {
  if (new TextEncoder().encode(raw).length > 2_000_000) throw new Error("快照超过 2 MB；请按门店与时间窗口分批体检。");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || !("snapshotId" in value)) {
    throw new Error("请输入 AuditSnapshot JSON，根对象须包含 snapshotId 与五线数据集。");
  }
  return value as SnapshotInput;
}

function reportFrom(response: unknown): { report: Report | null; receipt?: CapabilityResponse["receipt"]; deduped?: boolean } {
  const value = response as CapabilityResponse;
  return { report: value.result.report, receipt: value.receipt, deduped: value.result.deduped };
}

export default function FastScan() {
  const [raw, setRaw] = useState("");
  const [snapshot, setSnapshot] = useState<SnapshotInput | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const last = localStorage.getItem(LAST_KEY);
    if (!last) return;
    setKey(last);
    let cancelled = false;
    const recover = async () => {
      setBusy("receipt");
      try {
        await ensureDemoLogin();
        const response = await trpc.twin.fastScanReceipt.query({ idempotencyKey: last });
        if (cancelled) return;
        const value = reportFrom(response);
        if (value.report) {
          setReport(value.report);
          setEventId(value.receipt?.eventId ?? null);
          setNotice("已找回上次体检回执。数据来源仍未核验。");
        } else setNotice("上次提交尚无回执，可再次查询。 ");
      } catch (cause) {
        if (!cancelled) setError(`回执查询失败：${errorText(cause)}`);
      } finally {
        if (!cancelled) setBusy(null);
      }
    };
    void recover();
    return () => { cancelled = true; };
  }, []);

  const edit = (value: string) => {
    setRaw(value); setSnapshot(null); setReport(null); setEventId(null); setKey(null);
    setError(null); setNotice(null);
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) { setError("文件超过 2 MB；请按门店与时间窗口分批体检。"); return; }
    try { edit(await file.text()); } catch (cause) { setError(`文件读取失败：${errorText(cause)}`); }
    event.target.value = "";
  };
  const preview = async () => {
    setBusy("preview"); setError(null); setNotice(null);
    try {
      const parsed = parseSnapshot(raw);
      await ensureDemoLogin();
      const response = await trpc.twin.fastScanPreview.mutate({ snapshot: parsed, timeBudgetMinutes: 30 });
      const value = reportFrom(response);
      setSnapshot(parsed);
      setReport(value.report);
      setEventId(null);
      setKey(null);
      setNotice("预览完成。报告只依据您提交的快照，尚未保存回执。");
    } catch (cause) {
      setError(`预览失败：${errorText(cause)}`);
    } finally { setBusy(null); }
  };
  const execute = async () => {
    if (!snapshot) return;
    const currentKey = key ?? crypto.randomUUID();
    setKey(currentKey);
    localStorage.setItem(LAST_KEY, currentKey);
    setBusy("execute"); setError(null); setNotice(null);
    try {
      await ensureDemoLogin();
      const response = await trpc.twin.fastScanExecute.mutate({ snapshot, timeBudgetMinutes: 30, idempotencyKey: currentKey });
      const value = reportFrom(response);
      setReport(value.report);
      setEventId(value.receipt?.eventId ?? null);
      setNotice(value.deduped ? "已读取同一幂等键的既有回执。" : "报告已写入工作区事件库；外部数据源未核验。");
    } catch (cause) {
      setError(`留痕失败：${errorText(cause)}。可用同一幂等键查询回执或重试。`);
    } finally { setBusy(null); }
  };
  const checkReceipt = async () => {
    if (!key) return;
    setBusy("receipt"); setError(null); setNotice(null);
    try {
      await ensureDemoLogin();
      const response = await trpc.twin.fastScanReceipt.query({ idempotencyKey: key });
      const value = reportFrom(response);
      setReport(value.report);
      setEventId(value.receipt?.eventId ?? null);
      setNotice(value.report ? "回执已找到；快照来源仍未核验。" : "当前尚无已保存的回执。");
    } catch (cause) { setError(`回执查询失败：${errorText(cause)}`); }
    finally { setBusy(null); }
  };
  const downloadReport = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${report.reportId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const right = (
    <div className="rounded-lg border border-gline bg-card p-4 text-body leading-relaxed text-ink3">
      <b className="text-ink2">数据口径</b>
      <p className="mt-2">快照由操作者提交。报告会检查价格、房态、渠道、口碑、安全与断点五线；空数据集会在覆盖度里标出。</p>
      <p className="mt-2">预览不写库；“保存报告”只写入 WorkLoom 事件库，不修改客房管理系统、渠道平台或物联网设备。</p>
      <p className="mt-2 text-warn">来源未核验；估算金额不是已实现收益。</p>
    </div>
  );

  return (
    <Bridge right={right}>
      <div className="space-y-4">
        <div>
          <h2 className="text-h1 font-black tracking-wider">酒店快速体检</h2>
          <p className="mt-1 text-body text-ink3">导入酒店快照，先预览五线发现，再以幂等回执保存报告。</p>
        </div>
        <section className="rounded-xl border border-line bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="hotel-snapshot" className="text-body font-semibold text-ink2">酒店快照数据</label>
            <label className={`${quietButton} cursor-pointer`}>
              上传数据文件
              <input className="sr-only" type="file" accept=".json,application/json" onChange={(event) => void upload(event)} disabled={busy !== null} />
            </label>
          </div>
          <textarea id="hotel-snapshot" value={raw} onChange={(event) => edit(event.target.value)}
            spellCheck={false} placeholder={"在此粘贴酒店快照数据，或点击上方按钮上传由门店系统导出的文件"}
            className="mt-3 min-h-48 w-full resize-y rounded-lg border border-line bg-bg950 px-3 py-2 font-mono text-body text-ink2 outline-none focus:border-gold/60 disabled:opacity-50"
            disabled={busy !== null} />
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={button} onClick={() => void preview()} disabled={busy !== null || raw.trim().length === 0}>
              {busy === "preview" ? "正在体检…" : "预览体检"}
            </button>
            <button type="button" className={quietButton} onClick={() => void execute()} disabled={busy !== null || !snapshot || Boolean(eventId)}>
              {busy === "execute" ? "正在保存…" : "保存报告并生成回执"}
            </button>
            {key ? <button type="button" className={quietButton} onClick={() => void checkReceipt()} disabled={busy !== null}>
              {busy === "receipt" ? "正在查询…" : "查询回执"}
            </button> : null}
          </div>
          {error ? <p role="alert" className="mt-3 rounded-lg border border-warn/50 bg-warn/10 p-3 text-body text-warn">{error}</p> : null}
          {notice ? <p role="status" className="mt-3 rounded-lg border border-gline bg-go/10 p-3 text-body text-ink2">{notice}</p> : null}
        </section>
        {report ? (
          <section className="space-y-4 rounded-xl border border-gline bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0"><h3 className="break-all text-lg font-bold text-ink2">{report.reportId}</h3><p className="break-words text-body text-ink3">快照 {report.snapshotId} · {new Date(report.generatedAt).toLocaleString("zh-CN")}</p></div>
              <div className="flex flex-wrap items-center gap-2"><span className="rounded border border-warn/50 px-2 py-1 text-body text-warn">来源未核验</span><button type="button" className={quietButton} onClick={downloadReport}>下载完整报告</button></div>
            </div>
            {eventId ? <p className="break-all text-body text-go">事件回执：{clientIdentifierText(eventId)}</p> : null}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {[["门店", report.overview.hotelCount], ["发现", report.overview.findingCount], ["P0", report.overview.counts.P0 ?? 0], ["P1", report.overview.counts.P1 ?? 0]].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-line p-3"><div className="text-body text-ink3">{label}</div><b className="text-xl text-ink2">{value}</b></div>
              ))}
            </div>
            <div><h4 className="text-body font-semibold text-ink2">检线覆盖度</h4><div className="mt-2 flex flex-wrap gap-2">{Object.entries(report.coverage).map(([line, status]) => <span key={line} className="rounded border border-line px-2 py-1 text-body text-ink3">{clientValueText(lineNames[line] ?? line, "其他检线")}：{clientValueText(coverageNames[status] ?? status, "未覆盖")}</span>)}</div></div>
            {report.coverageNotes.length ? <ul className="list-inside list-disc space-y-1 text-body text-ink3">{report.coverageNotes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
            {report.hotels.flatMap((hotel) => hotel.findings.map((finding) => ({ hotel, finding }))).map(({ hotel, finding }) => (
              <article key={`${hotel.hotelId}-${finding.id}`} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap gap-2 text-body"><span className="font-mono text-warn">{finding.severity}</span><b className="text-ink2">{finding.title}</b><span className="text-ink3">{hotel.hotelName} · {lineNames[finding.line] ?? finding.line}</span></div>
                <p className="mt-1 text-body text-ink3">{finding.description}</p>
                <p className="mt-1 text-body text-ink2">建议：{finding.suggestion}</p>
                {finding.calculation ? <p className="mt-1 text-body text-ink3">计算：{finding.calculation.formula}；结果 {finding.calculation.result}</p> : null}
                {finding.evidence?.length ? <p className="mt-1 break-words text-body text-ink3">证据：{clientValueText(finding.evidence.map((item) => `${item.kind} #${item.id}${item.note ? `（${item.note}）` : ""}`).join("、"), "已记录证据")}</p> : null}
                {finding.estimatedImpact ? <p className="mt-1 text-body text-gold">估算挽回 {finding.estimatedImpact.amount} {finding.estimatedImpact.currency} · 置信度 {confidenceNames[finding.estimatedImpact.confidence] ?? finding.estimatedImpact.confidence}</p> : null}
              </article>
            ))}
            {report.overview.findingCount === 0 ? <EmptyState title="当前快照无体检发现" hint="请结合上方覆盖度确认各数据源是否齐全。" /> : null}
          </section>
        ) : null}
      </div>
    </Bridge>
  );
}
