// Compliance monitoring — the overview. Every control in the catalogue has a
// heartbeat; this page sums them into one pulse, a coverage count (live /
// silent / never), ledger + delivery health, a card per policy that drills
// into that policy's control list, and the newest events across all controls.
//
// Data via the UI's core proxy + the static manifest (see lib/useDashboard).
// Design direction: .impeccable/surfaces/ui-src-pages-compliance-dashboard-index-jsx.md
import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import MainLayout from "../../../components/layout/MainLayout";
import { useDashboard } from "../../../lib/useDashboard";
import { useLiveCore } from "../../../lib/useLiveCore";
import { LiveBadge } from "../../../components/live/Live";
import { fetchDashboardEvents } from "../../../lib/api";
import { pulseOf, sumPulses, fmtT, ago } from "../../../lib/dashboardModel";
import { n, CORE_FILL, SIM_FILL } from "../../../components/compliance/atoms";

const card = "bg-white rounded-xl shadow-e1";

export default function ComplianceMonitoring() {
  const { manifest, model, loading, error } = useDashboard();
  const core = useLiveCore();

  return (
    <MainLayout
      title="Compliance Monitoring"
      subtitle="Every control's evidence over the last 7 days, read live from the core"
      status={
        <span className={`${card} inline-flex items-center rounded-full px-3 py-1`}>
          <LiveBadge live={core.live} polledAt={core.polledAt} lastAdvanceAt={core.lastAdvanceAt} error={core.error} />
        </span>
      }
      statusCompact={
        <span className={`${card} inline-flex items-center rounded-full px-2.5 py-1`}>
          <LiveBadge compact live={core.live} polledAt={core.polledAt} lastAdvanceAt={core.lastAdvanceAt} error={core.error} />
        </span>
      }
      actions={
        <>
          <Link href="/compliance" className={`${card} px-3 py-1.5 text-sm font-semibold text-ink hover:shadow-e2 transition-shadow`}>
            Obligations
          </Link>
          <Link href="/reports" className={`${card} px-3 py-1.5 text-sm font-semibold text-ink hover:shadow-e2 transition-shadow`}>
            Control results
          </Link>
        </>
      }
    >
      {error && (
        <div role="alert" className="mb-5 rounded-xl bg-[#fef3f2] px-4 py-3 shadow-[0_0_0_1px_#fecdca]">
          <div className="font-semibold text-[#912018]">Could not load the monitoring data</div>
          <div className="text-sm text-[#b42318] mt-0.5">{error}</div>
        </div>
      )}
      {loading || !model || !manifest ? <Skeleton /> : <Overview manifest={manifest} model={model} />}
    </MainLayout>
  );
}

/** Status of one policy from its control counts. */
function policyStatus({ total, live, never }) {
  if (total === 0) return { label: "No controls", tone: "neutral" };
  if (live === 0) return { label: "No evidence", tone: "bad" };
  const share = live / total;
  if (share < 0.25) return { label: "Mostly silent", tone: "bad" };
  if (share >= 0.75 && never === 0) return { label: "Healthy", tone: "ok" };
  return { label: "Gaps", tone: "warn" };
}

const PILL = {
  ok: "bg-[#dcfae6] text-[#067647]",
  warn: "bg-[#fef0c7] text-[#93370d]",
  bad: "bg-[#fee4e2] text-[#b42318]",
  neutral: "bg-canvas text-ink-muted",
};

const MOBILE_CAP = 6; // below xl, show this many policy cards before "Show all"

const RECON_LABELS = { "blnk.balance_drift": "Balance-drift" };
const reconLabel = (code) => RECON_LABELS[code] ?? code;

function Overview({ manifest, model }) {
  const [showAll, setShowAll] = useState(false);
  const B = model.grid.B;
  const hb = model.hb;
  const ops = model.data.ops;

  const all = sumPulses([...model.byCode.values()].map((e) => ({ core: e.core, sim: e.sim, total: e.total })), B);

  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const prodEvents = sum(all.core);
  const drillEvents = sum(all.sim);

  const { cards, live, liveProd, silent, never, totalCtl, codeToControl } = useMemo(() => {
    let live = 0, liveProd = 0, silent = 0, never = 0, totalCtl = 0;
    const codeToControl = new Map();
    const cards = manifest.policies.map((p) => {
      let pl = 0, ps = 0, pn = 0;
      const pulses = p.controls.map((c) => {
        for (const code of c.watch || []) if (!codeToControl.has(code)) codeToControl.set(code, { c, p });
        const cp = pulseOf(model, c);
        totalCtl++;
        if (cp.total > 0) { pl++; live++; if (cp.core.some((v) => v > 0)) liveProd++; }
        else if (cp.everTotal > 0) { ps++; silent++; }
        else { pn++; never++; }
        return cp;
      });
      const pp = sumPulses(pulses, B);
      const counts = { total: p.controls.length, live: pl, silent: ps, never: pn };
      return { p, ...counts, events: pp.total, status: policyStatus(counts) };
    });
    return { cards, live, liveProd, silent, never, totalCtl, codeToControl };
  }, [manifest, model, B]);

  // Attention first, then by share of controls live.
  const order = { bad: 0, warn: 1, neutral: 2, ok: 3 };
  const sorted = [...cards].sort(
    (a, b) => order[a.status.tone] - order[b.status.tone] || a.live / (a.total || 1) - b.live / (b.total || 1)
  );
  const attention = sorted.filter((c) => c.status.tone === "bad");

  const recon = Object.entries(ops.events_7d || {}).sort((a, b) => b[1] - a[1]);
  const reconTotal = recon.reduce((s, [, v]) => s + v, 0);
  const pct = (x) => `${totalCtl ? (x / totalCtl) * 100 : 0}%`;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-5">
      <section className="min-w-0">
        <div className="grid grid-cols-1 md:grid-cols-[1.35fr_1fr_1fr] gap-4 mb-4">
          <div className={`${card} p-4`}>
            <div className="text-[13px] font-semibold text-ink-muted">Events in window</div>
            <div className="text-[30px] font-bold tracking-tight leading-tight">{n(all.total)}</div>
            <div className="text-[13px] text-ink-muted">{n(prodEvents)} production · {n(drillEvents)} simulated drills</div>
            <PulseArea pulse={all} grid={model.grid} />
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-soft mt-1.5">
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><i className="w-2 h-2 rounded-sm" style={{ background: CORE_FILL }} />Production</span>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><i className="w-2 h-2 rounded-sm" style={{ background: SIM_FILL }} />Simulated drills</span>
            </div>
          </div>

          <div className={`${card} p-4`}>
            <div className="text-[13px] font-semibold text-ink-muted">Controls with evidence</div>
            <div className="text-[30px] font-bold tracking-tight leading-tight">
              {n(live)} <span className="text-[15px] font-medium text-ink-soft">of {n(totalCtl)}</span>
            </div>
            <div className="flex h-2.5 rounded-full overflow-hidden my-3 bg-canvas shadow-[inset_0_1px_2px_rgb(11_31_58/0.15)]" role="img"
              aria-label={`${live} live, ${silent} silent, ${never} never fired`}>
              <i className="bg-live" style={{ width: pct(live) }} />
              <i className="bg-silent" style={{ width: pct(silent) }} />
              <i className="bg-never" style={{ width: pct(never) }} />
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-ink-muted">
              <Legend cls="bg-live">{n(live)} live</Legend>
              <Legend cls="bg-silent">{n(silent)} silent</Legend>
              <Legend cls="bg-never">{n(never)} never fired</Legend>
            </div>
            <div className="text-xs text-ink-soft mt-1.5">
              {liveProd === live
                ? "All live controls have production evidence, not just drills."
                : `${n(liveProd)} have production evidence; ${n(live - liveProd)} only drills.`}
            </div>
          </div>

          <div className={`${card} p-4`}>
            <div className="text-[13px] font-semibold text-ink-muted">Ledger reconciliation</div>
            <div className="text-[30px] font-bold tracking-tight leading-tight">{n(reconTotal)}</div>
            <div className="text-[13px] text-ink-muted">
              {reconTotal === 0 ? "No reconciliation events this week" : recon.length === 1 ? `${reconLabel(recon[0][0])} events this week` : "reconciliation events this week"}
            </div>
            {recon.length > 1 && (
              <ul className="mt-2 space-y-0.5 text-[13px] text-ink-muted">
                {recon.slice(0, 3).map(([k, v]) => (
                  <li key={k} className="flex justify-between gap-2"><span className="truncate">{reconLabel(k)}</span><span>{n(v)}</span></li>
                ))}
              </ul>
            )}
            <div className="mt-3 pt-2.5 border-t border-line text-[13px] space-y-0.5">
              {recon.length === 1 && <div className="text-ink-soft">Code <span className="font-mono text-xs">{recon[0][0]}</span></div>}
              <div className={ops.outbox_undelivered ? "text-[#93370d] font-semibold" : "text-ink-muted"}>
                {ops.outbox_undelivered ? `${n(ops.outbox_undelivered)} awaiting delivery` : "Event delivery up to date"}
              </div>
              {ops.events_7d_capped && <div className="text-[#93370d]">Counts hit the read cap; treat as a floor</div>}
            </div>
          </div>
        </div>

        {attention.length > 0 && (
          <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-[#fff8ec] px-4 py-3 shadow-[0_0_0_1px_#f6dfb4,0_4px_12px_-4px_rgb(147_55_13/0.18)]">
            <span className="grid place-items-center w-7 h-7 rounded-lg bg-[#fdecc8] text-[#93370d]"><AlertTriangle size={16} aria-hidden="true" /></span>
            <p className="flex-1 min-w-[240px] max-w-[75ch] text-sm text-[#5c2a0a]">
              <b className="text-[#3d1a05]">{attention.length} {attention.length === 1 ? "policy needs" : "policies need"} attention.</b>{" "}
              {attention.slice(0, 3).map((c, i) => (
                <span key={c.p.slug}>
                  {i > 0 && "; "}
                  <Link href={`/compliance/dashboard/${c.p.slug}`} className="font-semibold underline underline-offset-2 decoration-[#e0b36b] hover:decoration-[#93370d]">{c.p.title}</Link>{" "}
                  {c.live === 0 ? "has no evidence this week" : `has ${c.silent + c.never} of ${c.total} controls without evidence`}
                </span>
              ))}
              {attention.length > 3 && `; and ${attention.length - 3} more below`}.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {sorted.map((c, i) => (
            <Link key={c.p.slug} href={`/compliance/dashboard/${c.p.slug}`} title={c.p.title}
              className={`${card} p-4 transition-[box-shadow,transform] duration-200 hover:shadow-e2 motion-safe:hover:-translate-y-0.5 ${
                i >= MOBILE_CAP && !showAll ? "hidden xl:block" : "block"}`}>
              <div className="flex items-start justify-between gap-2 min-h-[2.75rem]">
                <span className="font-semibold text-[15px] leading-snug line-clamp-2">{c.p.title}</span>
                <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${PILL[c.status.tone]}`}>{c.status.label}</span>
              </div>
              <div className="flex h-1.5 rounded-full overflow-hidden mt-3 mb-2 bg-canvas" aria-hidden="true">
                <i className="bg-live" style={{ width: `${(c.live / (c.total || 1)) * 100}%` }} />
                <i className="bg-silent" style={{ width: `${(c.silent / (c.total || 1)) * 100}%` }} />
                <i className="bg-never" style={{ width: `${(c.never / (c.total || 1)) * 100}%` }} />
              </div>
              <div className="text-[13px] text-ink-muted">
                {c.live} live · {c.silent} silent{c.never ? ` · ${c.never} never` : ""} · {c.total} controls
              </div>
              <div className="flex justify-between items-baseline mt-2.5 pt-2.5 border-t border-line text-[13px] text-ink-muted">
                Events · {hb.window_hours / 24}d <b className="text-base text-ink">{n(c.events)}</b>
              </div>
            </Link>
          ))}
        </div>

        {!showAll && sorted.length > MOBILE_CAP && (
          <button type="button" onClick={() => setShowAll(true)}
            className={`${card} xl:hidden mt-4 w-full py-2.5 text-sm font-semibold text-accent hover:shadow-e2`}>
            Show all {sorted.length} policies
          </button>
        )}

        <p className="text-xs text-ink-soft mt-5">
          {n(manifest.policy_count)} policies · {n(manifest.control_count)} catalogued controls · generated {fmtT(hb.generated_at)}.
          Every count reads core.event and core.control_result; totals include simulated drills, which are broken out and drawn in grey.
        </p>
      </section>

      <LiveEvents model={model} codeToControl={codeToControl} />
    </div>
  );
}

function Legend({ cls, children }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <i className={`w-2 h-2 rounded-sm ${cls}`} aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * The all-events pulse as a stacked area (production below, drills above),
 * with the busiest bucket marked so a spike says when it happened.
 */
function PulseArea({ pulse, grid }) {
  const W = 400, H = 48;
  const Bn = pulse.core.length;
  let max = 1, peak = 0;
  for (let i = 0; i < Bn; i++) {
    const t = pulse.core[i] + pulse.sim[i];
    if (t > max) { max = t; peak = i; }
  }
  const x = (i) => (Bn === 1 ? W / 2 : (i / (Bn - 1)) * W);
  const y = (v) => H - 2 - (v / max) * (H - 6);
  const line = (vals) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const tot = pulse.core.map((c, i) => c + pulse.sim[i]);
  const area = (top, bottom) =>
    `${line(top)} ${bottom.map((v, i) => `L${x(Bn - 1 - i).toFixed(1)} ${y(bottom[Bn - 1 - i]).toFixed(1)}`).join(" ")} Z`;
  const zero = new Array(Bn).fill(0);
  const peakAt = new Date((grid.t0 + peak * grid.step) * 1000);
  const drillPeak = pulse.sim[peak] > pulse.core[peak];
  const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const peakLabel = `${drillPeak ? "Drill burst" : "Busiest"} · ${fmt(peakAt)}, ${peakAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;

  return (
    <div className="mt-2">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full h-12" role="img"
        aria-label={`Events over the window, production in blue, simulated drills in grey. ${peakLabel}`}>
        <path d={area(tot, pulse.core)} fill={SIM_FILL} fillOpacity="0.28" />
        <path d={line(tot)} fill="none" stroke={SIM_FILL} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <path d={area(pulse.core, zero)} fill={CORE_FILL} fillOpacity="0.16" />
        <path d={line(pulse.core)} fill="none" stroke={CORE_FILL} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {max > 1 && <line x1={x(peak)} x2={x(peak)} y1="0" y2={H} stroke="#93370d" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="flex justify-between gap-2 text-xs text-ink-soft mt-0.5">
        <span>{fmt(new Date(grid.t0 * 1000))}</span>
        {max > 1 && <span className="text-[#93370d] truncate">{peakLabel}</span>}
        <span>Now</span>
      </div>
    </div>
  );
}

/** The newest events across every watched code, each linked to its control. */
function LiveEvents({ model, codeToControl }) {
  const [events, setEvents] = useState(null);
  const [err, setErr] = useState(null);

  // The most recently seen codes that a control watches (housekeeping codes
  // such as the ledger inbox heartbeat would otherwise flood the list).
  const codes = useMemo(
    () => [...model.seen.entries()]
      .filter(([c]) => codeToControl.has(c))
      .sort((a, b) => (a[1].last_at < b[1].last_at ? 1 : -1))
      .slice(0, 12)
      .map(([c]) => c),
    [model, codeToControl]
  );

  useEffect(() => {
    let off = false;
    if (!codes.length) { setEvents([]); return; }
    fetchDashboardEvents({ codes, limit: 40 })
      .then((d) => {
        if (off) return;
        // At most two per code, so one chatty control cannot fill the list.
        const per = new Map();
        const picked = [];
        for (const e of d.events || []) {
          const k = per.get(e.code) || 0;
          if (k < 2) { per.set(e.code, k + 1); picked.push(e); }
          if (picked.length === 8) break;
        }
        setEvents(picked);
      })
      .catch((e) => { if (!off) setErr(e.message); });
    return () => { off = true; };
  }, [codes]);

  return (
    <aside className={`${card} self-start overflow-hidden xl:sticky xl:top-4`} aria-label="Latest events">
      <div className="flex items-center justify-between px-4 py-3 shadow-[0_1px_0_var(--color-line)]">
        <h2 className="text-[15px] font-semibold">Latest events</h2>
        <span className="text-xs text-ink-soft">all controls</span>
      </div>
      {err ? (
        <div className="p-4 text-sm text-[#b42318]">Could not load events: {err}</div>
      ) : events === null ? (
        <ul aria-busy="true">{[0, 1, 2, 3, 4].map((i) => (
          <li key={i} className="px-4 py-3 border-b border-line last:border-0">
            <div className="h-3.5 w-2/3 rounded bg-canvas animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-canvas animate-pulse mt-2" />
          </li>
        ))}</ul>
      ) : events.length === 0 ? (
        <div className="p-4 text-sm text-ink-muted">No events recorded yet.</div>
      ) : (
        <ul>
          {events.map((e) => {
            const hit = codeToControl.get(e.code);
            const href = hit ? `/compliance/dashboard/${hit.p.slug}?c=${encodeURIComponent(hit.c.id)}` : null;
            return (
              <li key={e.id} className="px-4 py-3 border-b border-line last:border-0">
                <div className="flex items-start gap-2.5">
                  <i className={`mt-1.5 w-2 h-2 shrink-0 rounded-full ${e.src === "sim" ? "bg-sim" : "bg-accent"}`}
                    title={e.src === "sim" ? "simulated drill" : "production"} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[13px] font-medium text-ink truncate">{e.code}</div>
                    <div className="text-xs text-ink-muted truncate mt-0.5">
                      {hit ? `${hit.c.id} · ${hit.c.title}` : "not mapped to a control"}
                    </div>
                    <div className="flex justify-between text-xs text-ink-soft mt-1">
                      <span title={fmtT(e.created_at)}>{ago(e.created_at)}{e.src === "sim" ? " · drill" : ""}</span>
                      {href && <Link href={href} className="font-semibold text-accent hover:underline">Open control</Link>}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function Skeleton() {
  const block = `${card} p-4`;
  return (
    <div aria-busy="true" aria-label="Loading monitoring data" className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-5">
      <div>
        <div className="grid grid-cols-1 md:grid-cols-[1.35fr_1fr_1fr] gap-4 mb-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className={block}>
              <div className="h-3 w-24 rounded bg-canvas animate-pulse" />
              <div className="h-7 w-28 rounded bg-canvas animate-pulse mt-2" />
              <div className="h-12 rounded bg-canvas animate-pulse mt-3" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className={block}>
              <div className="h-4 w-32 rounded bg-canvas animate-pulse" />
              <div className="h-1.5 rounded bg-canvas animate-pulse mt-4" />
              <div className="h-3 w-40 rounded bg-canvas animate-pulse mt-3" />
            </div>
          ))}
        </div>
      </div>
      <div className={`${block} h-80`} />
    </div>
  );
}
