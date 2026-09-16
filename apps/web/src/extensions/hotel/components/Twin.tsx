/**
 * 酒店经营页专用展示套件：统计卡 / 列表行 / 标签 / 条形 / 事件类型
 * 视觉口径与 Bridge/tokens 一致（bg-card · border-line · text-ink2/3 · gold/go/warn/holo）
 */
import { Tag as SharedTag } from "@workloom/ui";
import type { ReactNode } from "react";

/** 五元事件通用形态（页面侧宽松视图；字段以 payload 实际为准） */
export interface Ev {
  event_id: string;
  who?: { type: string; id: string };
  context: { time: string; channel?: string; night_shift?: boolean };
  object: { type: string; id?: string; label?: string };
  decision: {
    action: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    params?: Record<string, unknown>;
    basis?: string[];
  };
  rule_impact?: Array<{ rule_id: string; result: string }>;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function PageHead({ title, tag, extra }: { title: string; tag: string; extra?: ReactNode }) {
  return (
    <div className="mb-3 flex min-w-0 flex-wrap items-center gap-3">
      <h2 className="min-w-0 break-words text-h1 font-black tracking-wider">{title}</h2>
      <span className="min-w-0 break-words text-body tracking-[.2em] text-ink3">{tag}</span>
      <span className="flex-1" />
      {extra}
    </div>
  );
}

export function Stat({ label, value, tone = "text-gold", hint }: { label: string; value: ReactNode; tone?: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-card p-3">
      <div className="break-words text-body text-ink3">{label}</div>
      <div className={`mt-1 min-w-0 break-words text-h1 font-black ${tone}`}>{value}</div>
      {hint ? <div className="mt-0.5 break-words text-body text-ink3">{hint}</div> : null}
    </div>
  );
}

export function Row({ time, children, right }: { time?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5">
      {time ? <span className="w-[76px] shrink-0 font-mono text-body text-ink3">{time}</span> : null}
      <div className="min-w-0 flex-[1_1_16rem] break-words text-body leading-relaxed text-ink2">{children}</div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{right}</div>
    </div>
  );
}

export function HotelStatusTag({ tone, children }: { tone: "go" | "warn" | "holo" | "gold" | "ink"; children: ReactNode }) {
  const sharedTone = tone === "go" ? "success" : tone === "warn" ? "warning" : tone === "holo" ? "info" : "neutral";
  return <SharedTag tone={sharedTone} className="max-w-full break-words">{children}</SharedTag>;
}

export function HBar({ label, pct, tone = "bg-holo", value }: { label: string; pct: number; tone?: string; value?: string }) {
  return (
    <div className="mb-2">
      <div className="flex min-w-0 flex-wrap justify-between gap-2 text-body text-ink3">
        <span className="min-w-0 break-words">{label}</span>
        <span className="break-words font-mono">{value ?? `${pct}%`}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-bg950">
        <div className={`h-full rounded ${tone}`} style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
      </div>
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <div className="min-w-0 break-words rounded-lg border border-gline bg-card p-3 text-body leading-relaxed text-ink3">{children}</div>;
}

export const num = (v: unknown, d = 0) => (typeof v === "number" ? v : Number(v ?? d));
export const pctText = (v: unknown) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—");
