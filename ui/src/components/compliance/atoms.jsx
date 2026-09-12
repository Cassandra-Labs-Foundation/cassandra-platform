// Small presentational atoms shared across the compliance monitoring surface.
//
// The standalone dashboard is dark; this is the banking UI, which is light, so
// these carry the same meaning in the app's own palette: production evidence
// is blue, simulated-drill evidence is violet, and the ok/silent/never traffic
// light is emerald / amber / slate. Behaviour (the stacked sparkline, the
// three-state dot, the hermetic/live test badges) is ported from app.js.
import React from "react";

// Evidence worlds, in the app's palette. Kept as hex so the inline SVG bars can
// reference them directly without a CSS-var round trip.
export const CORE_FILL = "#2563eb"; // blue-600 — production
export const SIM_FILL = "#8b5cf6"; // violet-500 — simulated drills
const NIL_FILL = "#e2e8f0"; // slate-200 — an empty bucket

/** Integer with thousands separators, nulls as 0. */
export const n = (x) => (x ?? 0).toLocaleString();

/**
 * A stacked sparkline: production on the bottom, simulated drills stacked on
 * top, one bar per time bucket. Empty buckets draw a 1px slate floor so a
 * silent stretch reads as measured-and-quiet, not missing.
 */
export function Sparkline({ pulse, width = 180, height = 22, className = "" }) {
  const B = pulse.core.length;
  let max = 1;
  for (let i = 0; i < B; i++) max = Math.max(max, pulse.core[i] + pulse.sim[i]);
  const bw = width / B;
  const bars = [];
  for (let i = 0; i < B; i++) {
    const hc = Math.round((pulse.core[i] / max) * (height - 2));
    const hs = Math.round((pulse.sim[i] / max) * (height - 2));
    if (hc) bars.push(<rect key={`c${i}`} x={i * bw + 0.5} y={height - hc} width={bw - 1} height={hc} fill={CORE_FILL} />);
    if (hs) bars.push(<rect key={`s${i}`} x={i * bw + 0.5} y={height - hc - hs} width={bw - 1} height={hs} fill={SIM_FILL} />);
    if (!hc && !hs) bars.push(<rect key={`n${i}`} x={i * bw + 0.5} y={height - 1} width={bw - 1} height={1} fill={NIL_FILL} />);
  }
  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      style={{ display: "block", maxWidth: "100%" }}
    >
      {bars}
    </svg>
  );
}

/** Legend swatch — a small square in an evidence world's colour. */
export function Swatch({ fill }) {
  return <span className="inline-block w-2.5 h-2.5 rounded-sm align-[-1px]" style={{ background: fill }} />;
}

/**
 * The three-state evidence dot: green = evidence in the window, amber = has
 * history but silent this window, slate = no evidence ever (a finding).
 */
export function StatusDot({ pulse }) {
  if (pulse.total > 0) {
    return <span title="evidence in window" className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_6px_#10b981]" />;
  }
  if (pulse.everTotal > 0) {
    return <span title="has history, silent in this window" className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500" />;
  }
  return <span title="no evidence ever" className="inline-block w-2.5 h-2.5 rounded-full bg-slate-300" />;
}

/** hermetic / live control-test verdicts, or a "scoped out" note. */
export function TestBadges({ tests }) {
  const t = tests;
  if (!t || (!t.hermetic && !t.live)) return null;
  if (t.scoped_out) {
    return (
      <span
        title={t.scope_reason || "organisational control"}
        className="inline-block rounded-full border border-slate-200 px-1.5 py-0 text-[10px] uppercase tracking-wide text-slate-400"
      >
        scoped out
      </span>
    );
  }
  const Badge = ({ tier, v }) => (
    <span
      title={`${tier} control test`}
      className={`inline-block rounded-full border px-1.5 py-0 text-[10px] uppercase tracking-wide mr-1 ${
        v === "green" ? "border-emerald-300 text-emerald-700" : "border-rose-300 text-rose-700"
      }`}
    >
      {tier} {v}
    </span>
  );
  return (
    <>
      {t.hermetic && <Badge tier="hermetic" v={t.hermetic} />}
      {t.live && <Badge tier="live" v={t.live} />}
    </>
  );
}

/** A monospaced event-code chip — neutral, trigger (amber), or produced (emerald). */
export function EventCode({ children, kind = "neutral", className = "" }) {
  const tone = {
    neutral: "bg-blue-50 text-blue-700",
    trigger: "bg-amber-50 text-amber-700",
    produced: "bg-emerald-50 text-emerald-700",
  }[kind];
  return <span className={`font-mono text-[11px] rounded px-1.5 py-0.5 ${tone} ${className}`}>{children}</span>;
}

/** A world badge on an event row: production (blue) or simulated (violet). */
export function WorldBadge({ src }) {
  const sim = src === "sim";
  return (
    <span
      className={`inline-block rounded-full border px-1.5 py-0 text-[10px] uppercase tracking-wide ${
        sim ? "border-violet-300 text-violet-700" : "border-blue-300 text-blue-700"
      }`}
    >
      {src}
    </span>
  );
}

/** A titled white card, the light-theme equivalent of the dashboard's .panel. */
export function Panel({ title, children, className = "" }) {
  return (
    <div className={`bg-white rounded-xl border border-slate-200 p-4 shadow-sm ${className}`}>
      {title && <h2 className="text-[11px] font-medium uppercase tracking-wide text-slate-500 mb-2.5">{title}</h2>}
      {children}
    </div>
  );
}

/** A big headline number with a small caption, the dashboard's .big. */
export function BigStat({ value, children, tone = "" }) {
  const toneCls = { warn: "text-amber-600", bad: "text-rose-600" }[tone] ?? "text-slate-900";
  return (
    <div className={`text-3xl font-semibold tabular-nums ${toneCls}`}>
      {value}
      {children && <span className="text-xs font-normal text-slate-500 ml-1.5">{children}</span>}
    </div>
  );
}

/** A key/value count table, sorted desc. Renders "none in window" when empty. */
export function KvTable({ obj, headA, headB }) {
  const rows = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return <div className="text-slate-400 text-sm">none in window</div>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-[11px] uppercase tracking-wide text-slate-500">
          <th className="text-left font-medium py-1">{headA}</th>
          <th className="text-right font-medium py-1">{headB}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-t border-slate-100">
            <td className="py-1 pr-2">{k}</td>
            <td className="py-1 text-right tabular-nums">{n(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Rendered policy markdown, styled for the light theme. */
export function Markdown({ html, className = "" }) {
  return <div className={`dash-md text-[13.5px] leading-relaxed text-slate-700 ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
