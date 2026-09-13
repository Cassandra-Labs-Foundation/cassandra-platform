// Small, dependency-free SVG charts for the live accounting dashboard.
//
// Each is a single-series view (the title names the series, so no legend), built
// to the house data-viz specs: 2px lines, a soft area fill, 4px-rounded bar
// ends anchored to the baseline, recessive axes, values in ink (never the
// series colour), and a hover crosshair/tooltip because an SVG chart is
// interactive by default. Colours are passed in by the caller.
import React, { useMemo, useRef, useState } from 'react';

const AXIS = '#e2e8f0';
const INK = '#0f172a';
const MUTED = '#64748b';

function useHoverX(ref, count) {
  const [i, setI] = useState(null);
  const onMove = (e) => {
    const el = ref.current;
    if (!el || count === 0) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    setI(Math.max(0, Math.min(count - 1, Math.round(x * (count - 1)))));
  };
  return [i, onMove, () => setI(null)];
}

/**
 * Change-over-time, one series. `data` is [{ t, v }] oldest→newest; `t` is a ms
 * timestamp used only for the tooltip. The value axis floats to the data with a
 * little headroom so a nearly-flat live line still shows its wiggle.
 */
export function AreaTrend({ data, height = 120, color = '#2563eb', formatV, formatT, className = '' }) {
  const ref = useRef(null);
  const W = 640;
  const H = height;
  const pad = { t: 8, r: 8, b: 8, l: 8 };
  const [hi, onMove, onLeave] = useHoverX(ref, data.length);

  const { line, area, pts, lo, span } = useMemo(() => {
    if (data.length === 0) return { line: '', area: '', pts: [], lo: 0, span: 1 };
    const vs = data.map((d) => d.v);
    let min = Math.min(...vs);
    let max = Math.max(...vs);
    if (min === max) { min -= 1; max += 1; } // flat line: give it a band
    const headroom = (max - min) * 0.15;
    const lo = min - headroom;
    const span = max - min + headroom * 2;
    const x = (i) => pad.l + (i / Math.max(1, data.length - 1)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - lo) / span) * (H - pad.t - pad.b);
    const pts = data.map((d, i) => ({ x: x(i), y: y(d.v), ...d }));
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const area = `${line} L${pts[pts.length - 1].x.toFixed(1)} ${H - pad.b} L${pts[0].x.toFixed(1)} ${H - pad.b} Z`;
    return { line, area, pts, lo, span };
  }, [data, H]);

  const hp = hi != null && pts[hi] ? pts[hi] : null;
  const gid = useMemo(() => 'g' + Math.random().toString(36).slice(2, 8), []);

  return (
    <div className={`relative ${className}`} ref={ref} onMouseMove={onMove} onMouseLeave={onLeave}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }}>
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {data.length > 0 && <path d={area} fill={`url(#${gid})`} />}
        {data.length > 0 && <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
        {hp && <line x1={hp.x} x2={hp.x} y1={pad.t} y2={H - pad.b} stroke={AXIS} strokeWidth="1" vectorEffect="non-scaling-stroke" />}
        {pts.length > 0 && (
          <circle cx={(hp ?? pts[pts.length - 1]).x} cy={(hp ?? pts[pts.length - 1]).y} r="3.5" fill={color} stroke="#fff" strokeWidth="1.5" />
        )}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs shadow-sm"
          style={{ left: `${(hp.x / W) * 100}%`, top: 0, transform: 'translateX(-50%)' }}
        >
          <div className="font-semibold tabular-nums" style={{ color: INK }}>{formatV ? formatV(hp.v) : hp.v}</div>
          {formatT && <div style={{ color: MUTED }}>{formatT(hp.t)}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * Magnitude over time, one series of buckets. `data` is [{ label, v }].
 */
export function BarSeries({ data, height = 120, color = '#0891b2', formatV, emptyNote, className = '' }) {
  const ref = useRef(null);
  const [hi, onMove, onLeave] = useHoverX(ref, data.length);
  const max = Math.max(1, ...data.map((d) => d.v));
  const H = height;

  if (data.length === 0) {
    return <div className={`flex items-center justify-center text-xs text-slate-400 ${className}`} style={{ height: H }}>{emptyNote ?? 'no activity in range'}</div>;
  }

  return (
    <div className={`relative ${className}`} ref={ref} onMouseMove={onMove} onMouseLeave={onLeave}>
      <div className="flex items-end gap-[2px]" style={{ height: H }}>
        {data.map((d, i) => {
          const h = (d.v / max) * (H - 4);
          const active = hi === i;
          return (
            <div key={i} className="flex-1 flex items-end" style={{ height: H }} title={`${d.label}: ${formatV ? formatV(d.v) : d.v}`}>
              <div
                className="w-full rounded-t-[3px] transition-colors"
                style={{ height: Math.max(d.v > 0 ? 2 : 0, h), background: color, opacity: active ? 1 : 0.82 }}
              />
            </div>
          );
        })}
      </div>
      {hi != null && data[hi] && (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-y-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs shadow-sm"
          style={{ left: `${((hi + 0.5) / data.length) * 100}%`, transform: 'translate(-50%, -100%)' }}
        >
          <div className="font-semibold tabular-nums" style={{ color: INK }}>{formatV ? formatV(data[hi].v) : data[hi].v}</div>
          <div style={{ color: MUTED }}>{data[hi].label}</div>
        </div>
      )}
    </div>
  );
}

/** A glanceable trend glyph for a table cell — tiny line, no axis, no hover. */
export function MiniSpark({ data, width = 96, height = 26, color = '#2563eb' }) {
  if (!data || data.length < 2) {
    return <svg width={width} height={height} aria-hidden />;
  }
  let min = Math.min(...data);
  let max = Math.max(...data);
  if (min === max) { min -= 1; max += 1; }
  const x = (i) => (i / (data.length - 1)) * (width - 2) + 1;
  const y = (v) => (1 - (v - min) / (max - min)) * (height - 4) + 2;
  const dd = data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const last = data[data.length - 1];
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <path d={dd} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(data.length - 1)} cy={y(last)} r="2" fill={color} />
    </svg>
  );
}
