// Compliance monitoring — the overview. Every control in the catalogue has a
// heartbeat; this page sums them into one pulse, a coverage count (live /
// silent / never), ledger + delivery health, and a card per policy that drills
// into that policy's control list.
//
// Ported from the standalone dashboard's index view. Data via the UI's core
// proxy + the static manifest (see lib/useDashboard).
import React from "react";
import Link from "next/link";
import { CalendarClock, CheckSquare, Book } from "lucide-react";
import MainLayout from "../../../components/layout/MainLayout";
import { useDashboard } from "../../../lib/useDashboard";
import { pulseOf, sumPulses, fmtT } from "../../../lib/dashboardModel";
import { Sparkline, Panel, BigStat, KvTable, Swatch, n, CORE_FILL, SIM_FILL } from "../../../components/compliance/atoms";

export default function ComplianceMonitoring() {
  const { manifest, model, loading, error } = useDashboard();

  return (
    <MainLayout
      title="Compliance Monitoring"
      subtitle="Every control's heartbeat — click a policy, then a control, for its full event history"
      actions={
        <div className="flex items-center gap-2">
          <Link href="/compliance" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
            <CalendarClock size={15} className="text-blue-600" /> Governance calendar
          </Link>
          <Link href="/reports" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
            <Book size={15} className="text-slate-600" /> Control results
          </Link>
          <Link href="/approvals" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
            <CheckSquare size={15} className="text-indigo-600" /> Approvals
          </Link>
        </div>
      }
    >
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-6">
          <h3 className="font-medium text-red-800">Could not load the monitoring data</h3>
          <p className="text-sm text-red-600 mt-0.5">{error}</p>
        </div>
      )}

      {loading || !model || !manifest ? (
        <div className="p-6 text-center bg-white rounded-lg border border-slate-200">
          <div className="animate-spin inline-block w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full mb-2" />
          <div>Loading heartbeat…</div>
        </div>
      ) : (
        <Overview manifest={manifest} model={model} />
      )}
    </MainLayout>
  );
}

function Overview({ manifest, model }) {
  const B = model.grid.B;
  const hb = model.hb;
  const ops = model.data.ops;

  // All-events pulse: every code, summed on the grid.
  const all = sumPulses([...model.byCode.values()].map((e) => ({ core: e.core, sim: e.sim, total: e.total })), B);

  // Coverage + per-policy cards.
  let live = 0, silent = 0, never = 0, totalCtl = 0;
  const cards = manifest.policies.map((p) => {
    const pulses = p.controls.map((c) => pulseOf(model, c));
    let pl = 0, ps = 0, pn = 0;
    for (const cp of pulses) {
      totalCtl++;
      if (cp.total > 0) { pl++; live++; }
      else if (cp.everTotal > 0) { ps++; silent++; }
      else { pn++; never++; }
    }
    const pp = sumPulses(pulses, B);
    return { p, pl, ps, pn, pp };
  });

  return (
    <>
      <div className="text-xs text-slate-400 mb-4">
        window {hb.window_hours / 24}d · bucket {hb.bucket_seconds / 3600}h · generated {fmtT(hb.generated_at)}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Panel title="All-events heartbeat — every control, one pulse">
          <Sparkline pulse={all} width={640} height={56} className="mb-2.5" />
          <BigStat value={n(all.total)}>
            events in window ·{" "}
            <Swatch fill={CORE_FILL} /> production · <Swatch fill={SIM_FILL} /> simulated drills
          </BigStat>
        </Panel>

        <Panel title="Control coverage">
          <BigStat value={n(live)}>of {n(totalCtl)} controls produced evidence in window</BigStat>
          <div className="text-sm mt-1.5">
            <span className="text-amber-600">{n(silent)} silent</span> ·{" "}
            <span className="text-slate-400">{n(never)} never fired</span>
          </div>
          <div className="text-xs text-slate-400 mt-2">click any policy, then any control, for its full event history</div>
        </Panel>

        <Panel title="Ledger & delivery health">
          <KvTable obj={ops.events_7d} headA="reconciliation event — 7d" headB="count" />
          {ops.events_7d_capped && (
            <div className="text-[11px] text-amber-600 border-l-2 border-amber-400 pl-2 mt-2">
              reconciliation counts hit the {n(model.data.caps.aggregate_rows)}-row read cap — treat as a floor
            </div>
          )}
          <div className="mt-3">
            <BigStat value={n(ops.outbox_undelivered)} tone={ops.outbox_undelivered ? "warn" : ""}>
              events awaiting delivery
            </BigStat>
          </div>
          {ops.last_reconcile_at && (
            <div className="text-xs text-slate-400 mt-1.5">last heartbeat {fmtT(ops.last_reconcile_at)}</div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map(({ p, pl, ps, pn, pp }) => (
          <Link
            key={p.slug}
            href={`/compliance/dashboard/${p.slug}`}
            className="block bg-white rounded-xl border border-slate-200 p-4 shadow-sm hover:border-blue-400 transition-colors"
          >
            <div className="font-semibold text-slate-800 mb-1">{p.title}</div>
            <div className="text-xs text-slate-500">
              {n(p.controls.length)} controls · <span className="text-emerald-600">{pl} live</span> ·{" "}
              <span className="text-amber-600">{ps} silent</span> · <span className="text-slate-400">{pn} never</span>
            </div>
            <div className="my-2">
              <Sparkline pulse={pp} width={232} height={26} />
            </div>
            <div className="text-xs text-slate-500">{n(pp.total)} events in window</div>
          </Link>
        ))}
      </div>

      <div className="text-xs text-slate-400 mt-6">
        {n(manifest.policy_count)} policies · {n(manifest.control_count)} catalogued controls · every pulse reads
        core.event / core.control_result; simulated drill evidence is labeled, never mixed.
      </div>
    </>
  );
}
