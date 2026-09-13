// Compliance monitoring — one policy. Two views behind one route:
//
//   /compliance/dashboard/<slug>         the policy's control list + its
//                                         operational clocks (BSA alert triage,
//                                         CTR filings, dual-control queue)
//   /compliance/dashboard/<slug>?c=<id>   one control's audit surface: spec,
//                                         test verdicts, heartbeat, and the raw
//                                         event stream (ControlStream)
//
// Ported from the standalone dashboard's policy + control views. `?c=` matches
// a control by its short id OR its full uid, so a deep link from the Approvals
// queue (which links by short id) lands on the control, not the policy list.
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import MainLayout from "../../../components/layout/MainLayout";
import { useDashboard } from "../../../lib/useDashboard";
import { fetchObligations } from "../../../lib/api";
import { pulseOf, ago, fmtT } from "../../../lib/dashboardModel";
import { md } from "../../../lib/miniMarkdown";
import { approvalsQueueUrl, reportsUrlForControl, calendarUrlForControl } from "../../../lib/complianceLinks";
import {
  Sparkline, StatusDot, TestBadges, EventCode, Panel, BigStat, KvTable, Markdown, Swatch, n, CORE_FILL, SIM_FILL,
} from "../../../components/compliance/atoms";
import ControlStream from "../../../components/compliance/ControlStream";

export default function PolicyPage() {
  const router = useRouter();
  const slug = typeof router.query.policy === "string" ? router.query.policy : null;
  const selected = typeof router.query.c === "string" ? router.query.c : null;
  const provenance = typeof router.query.provenance === "string" ? router.query.provenance : "all";

  const { manifest, model, loading, error } = useDashboard(provenance);

  const policy = manifest && slug ? manifest.policies.find((p) => p.slug === slug) : null;
  const control =
    policy && selected ? policy.controls.find((c) => c.id === selected || c.uid === selected) : null;

  return (
    <MainLayout
      title={policy ? policy.title : "Compliance Monitoring"}
      subtitle={
        control
          ? "Control audit surface — spec, verdicts, heartbeat and raw event history"
          : "Controls in this policy — click one for its full event history"
      }
    >
      <div className="mb-4 text-sm">
        <Link href="/compliance/dashboard" className="inline-flex items-center gap-1 text-blue-600 hover:underline">
          <ArrowLeft size={14} /> all policies
        </Link>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-6">
          <h3 className="font-medium text-red-800">Could not load the monitoring data</h3>
          <p className="text-sm text-red-600 mt-0.5">{error}</p>
        </div>
      )}

      {loading || !model || !manifest ? (
        <div className="p-6 text-center bg-white rounded-lg border border-slate-200">
          <div className="animate-spin inline-block w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full mb-2" />
          <div>Loading…</div>
        </div>
      ) : !policy ? (
        <div className="text-slate-500">
          <span className="font-mono">{slug}</span> is not in the catalogue.
        </div>
      ) : control ? (
        <ControlView policy={policy} control={control} model={model} />
      ) : (
        <PolicyView policy={policy} model={model} slug={slug} provenance={provenance} router={router} />
      )}
    </MainLayout>
  );
}

// ───────────────────────────────────────────────────────── policy view
function PolicyView({ policy, model, slug, provenance, router }) {
  const meta = [
    policy.owner && <>owned by <strong className="text-slate-700">{policy.owner}</strong></>,
    policy.version && <>version {policy.version}</>,
    policy.effective && <>effective {policy.effective}</>,
    policy.next_review && <>next review {policy.next_review}</>,
  ].filter(Boolean);

  return (
    <>
      {policy.statement && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm mb-4">
          <h2 className="text-sm font-semibold text-slate-800 mb-1.5">General Policy Statement</h2>
          {meta.length > 0 && (
            <div className="text-xs text-slate-500 mb-2.5">
              {meta.map((m, i) => (
                <React.Fragment key={i}>{i > 0 && " · "}{m}</React.Fragment>
              ))}
            </div>
          )}
          <Markdown html={md(policy.statement)} />
        </div>
      )}

      <PolicyPanels slug={slug} data={model.data} provenance={provenance} router={router} />

      <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm mt-4">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-slate-500 mb-3">
          Controls — click one for its event history
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-slate-500">
                <th className="py-1.5 w-6" />
                <th className="text-left font-medium py-1.5">id</th>
                <th className="text-left font-medium py-1.5">control</th>
                <th className="text-left font-medium py-1.5">heartbeat — {model.hb.window_hours / 24}d</th>
                <th className="text-right font-medium py-1.5">events</th>
                <th className="text-right font-medium py-1.5">last evidence</th>
              </tr>
            </thead>
            <tbody>
              {policy.controls.map((c) => {
                const cp = pulseOf(model, c);
                return (
                  <tr key={c.uid} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="py-2"><StatusDot pulse={cp} /></td>
                    <td className="py-2 font-mono text-xs whitespace-nowrap">
                      <Link href={{ pathname: `/compliance/dashboard/${slug}`, query: { c: c.id } }} className="text-blue-700 hover:underline">
                        {c.id}
                      </Link>
                    </td>
                    <td className="py-2">
                      <Link href={{ pathname: `/compliance/dashboard/${slug}`, query: { c: c.id } }} className="text-slate-700 hover:text-blue-700">
                        {c.title}
                      </Link>
                      <div className="mt-0.5"><TestBadges tests={c.tests} /></div>
                    </td>
                    <td className="py-2" style={{ width: 190 }}><Sparkline pulse={cp} width={180} height={22} /></td>
                    <td className="py-2 text-right tabular-nums">{n(cp.total)}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {cp.total || cp.everTotal ? (
                        <>
                          {ago(cp.last_at)}
                          {cp.last_at && <div className="text-[11px] text-slate-400">{fmtT(cp.last_at)}</div>}
                        </>
                      ) : (
                        <span className="text-slate-400">never</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="text-xs text-slate-400 mt-3">
          Heartbeats sum each control’s trigger + produced event codes from its own spec; the gate controls read
          core.control_result.
        </div>
      </div>
    </>
  );
}

// The policy-specific operational clocks, read straight from the live data blob.
function PolicyPanels({ slug, data, provenance, router }) {
  const panels = [];

  if (slug === "bsa") {
    panels.push(
      <Panel key="alerts" title="Open BSA alerts">
        <BigStat value={n(data.alerts.open)} tone={data.alerts.overdue_triage ? "bad" : ""}>
          {n(data.alerts.overdue_triage)} past the 2-business-day triage clock
        </BigStat>
        <ProvenanceBar data={data} provenance={provenance} router={router} />
        <div className="mt-2"><KvTable obj={data.alerts.by_type} headA="type" headB="open" /></div>
        {data.alerts.by_type_capped && (
          <div className="text-[11px] text-amber-600 border-l-2 border-amber-400 pl-2 mt-2">
            by-type counts cover the {n(data.alerts.listed)} most-urgent alerts, not all {n(data.alerts.open)}
          </div>
        )}
      </Panel>,
    );
    panels.push(
      <Panel key="cases" title="Case / SAR pipeline">
        <KvTable obj={data.cases.by_status} headA="status" headB="cases" />
        <div className="mt-2.5"><KvTable obj={data.cases.sar_decisions} headA="SAR decision" headB="count" /></div>
        {data.cases.capped && (
          <div className="text-[11px] text-amber-600 border-l-2 border-amber-400 pl-2 mt-2">
            list shows {n(data.cases.listed)} of {n(data.cases.total)} — a sample; the number above is the full set
          </div>
        )}
      </Panel>,
    );
  }

  if (slug === "bsa" || slug === "cash") {
    panels.push(
      <Panel key="ctr" title="CTR filings — 15-day FinCEN clock">
        <BigStat value={n(data.ctr.unfiled)} tone={data.ctr.overdue ? "bad" : ""}>
          unfiled · {n(data.ctr.overdue)} overdue
        </BigStat>
      </Panel>,
    );
  }

  if (slug === "electronic-payment-systems" || slug === "shared-controls") {
    panels.push(
      <Panel key="eps" title="Awaiting second approver (EPS-06)">
        <BigStat value={n(data.pending_approvals.count)} tone={data.pending_approvals.count ? "warn" : ""}>
          payments held for dual control
        </BigStat>
      </Panel>,
    );
  }

  if (!panels.length) return null;
  return <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{panels}</div>;
}

// The evidence-origin filter. `unknown` is neither confirmed-real nor
// confirmed-test, so it is a caution, never a clean slice. Always shows the
// UNFILTERED composition — an officer narrowed to production still needs to see
// how much of the table is demo or unattributed.
function ProvenanceBar({ data, provenance, router }) {
  const bp = (data.alerts && data.alerts.by_provenance) || {};
  const active = (data.provenance && data.provenance.filter) || provenance || "all";
  const opts = ["all"].concat((data.provenance && data.provenance.available) || []);

  const pick = (p) => {
    const query = { ...router.query };
    if (p === "all") delete query.provenance;
    else query.provenance = p;
    router.push({ pathname: router.pathname, query }, undefined, { shallow: true });
  };

  return (
    <div className="mt-3">
      <span className="text-[11px] uppercase tracking-wide text-slate-500 mr-2">evidence origin</span>
      {opts.map((p) => {
        const cnt = p === "all" ? Object.values(bp).reduce((a, b) => a + b, 0) : bp[p] || 0;
        const on = p === active;
        return (
          <button
            key={p}
            onClick={() => pick(p)}
            className={`mr-1.5 mb-1.5 rounded-full border px-2 py-0.5 text-[11px] ${on ? "border-blue-400 bg-blue-50 text-slate-700" : "border-slate-200 text-slate-500 hover:border-slate-400 hover:text-slate-700"}`}
          >
            {p} <span className={on ? "text-slate-600" : "text-slate-400"}>{n(cnt)}</span>
          </button>
        );
      })}
      <div className="text-[11px] text-slate-400 mt-1">
        open alerts by origin — <code className="font-mono">unknown</code> is evidence written before provenance was
        stamped; it is neither confirmed real nor confirmed test.
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────── control view
function ControlView({ policy, control, model }) {
  const cp = pulseOf(model, control);
  const isGate = (control.watch || []).length === 0;
  const queueUrl = approvalsQueueUrl(control);
  const slug = policy.slug;

  // Does this control own any governance obligations? Only then does the
  // "calendar" link go somewhere — a link to an empty calendar filter is the
  // dead-button problem, so it is gated on a real match, not shown by default.
  const [hasObligations, setHasObligations] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchObligations()
      .then((d) => {
        if (!cancelled) setHasObligations((d.obligations ?? []).some((o) => o.control_uid === control.uid));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [control.uid]);

  const cits = (control.citations || []).map((r, i) =>
    r.url ? (
      <a key={i} href={r.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{r.text}</a>
    ) : (
      <span key={i} className="text-slate-500">{r.text}</span>
    ),
  );

  return (
    <>
      <div className="mb-4 text-sm">
        <Link href={`/compliance/dashboard/${slug}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline">
          <ArrowLeft size={14} /> {policy.title}
        </Link>
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-1">
        <StatusDot pulse={cp} />
        <h2 className="text-xl font-semibold text-slate-900">
          <span className="font-mono">{control.id}</span> — {control.title}
        </h2>
      </div>
      <div className="flex items-center gap-3 flex-wrap mb-3 text-xs">
        <span><TestBadges tests={control.tests} /></span>
        {cits.length > 0 && <span className="text-slate-500">{cits.reduce((acc, c, i) => (i ? [...acc, ", ", c] : [c]), [])}</span>}
      </div>

      {/* This control across the other surfaces — its recorded decisions in
          Reports, its obligations on the calendar (when it has any), and its
          actionable queue in Approvals (gate/EPS controls only). */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link href={reportsUrlForControl(control.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
          Recorded decisions in Reports <ArrowUpRight size={14} className="opacity-60" />
        </Link>
        {hasObligations && (
          <Link href={calendarUrlForControl(control.uid)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
            On the compliance calendar <ArrowUpRight size={14} className="opacity-60" />
          </Link>
        )}
        {queueUrl && (
          <Link href={queueUrl} className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100">
            Review queue in Approvals <ArrowUpRight size={14} />
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title={`Heartbeat — ${model.hb.window_hours / 24}d`}>
          <Sparkline pulse={cp} width={640} height={56} className="mb-2.5" />
          <BigStat value={n(cp.total)}>
            events in window · last evidence {ago(cp.last_at)}
            {!isGate && <> · {n(cp.everTotal)} all-time</>}
          </BigStat>
          <div className="mt-1 text-xs text-slate-400">
            <Swatch fill={CORE_FILL} /> production · <Swatch fill={SIM_FILL} /> simulated drills
          </div>
          {cp.decisions && Object.keys(cp.decisions).length > 0 && (
            <div className="mt-3"><KvTable obj={cp.decisions} headA="gate decision — window" headB="count" /></div>
          )}
          {control.why ? (
            <div className="mt-3.5 pt-3 border-t border-slate-100">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Why this control exists</h3>
              <Markdown html={md(control.why)} />
            </div>
          ) : isGate ? (
            <div className="mt-3.5 pt-3 border-t border-slate-100 text-xs text-slate-400">
              Runtime gate — its behaviour is the decision census above; there is no policy prose behind it.
            </div>
          ) : null}
        </Panel>

        <Panel title="What this control watches">
          {isGate ? (
            <div className="text-slate-500 text-sm">
              Runtime gate: its evidence is core.control_result rows (decisions at left). Trace any transaction to see
              this gate’s decision about it.
            </div>
          ) : (control.rules || []).length ? (
            <div className="space-y-2.5">
              {control.rules.map((r, i) => (
                <div key={i} className="leading-relaxed">
                  <EventCode kind="trigger">{r.trigger || "?"}</EventCode>
                  <span className="mx-1.5 text-slate-400">→</span>
                  {(r.produced || []).map((x, j) => <EventCode key={j} kind="produced" className="mr-1">{x}</EventCode>)}
                  {(r.inputs || []).length > 0 && (
                    <div className="text-[11px] text-slate-400 mt-0.5">requires: {r.inputs.join(", ")}</div>
                  )}
                  {r.timer ? (
                    <div className="text-[11px] text-slate-400 mt-0.5">deadline: <span className="font-mono">{r.timer}</span> — {r.deadline_text || ""}</div>
                  ) : r.deadline_text ? (
                    <div className="text-[11px] text-slate-400 mt-0.5">cadence: {r.deadline_text}</div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-slate-400 text-sm">no machine rules declared</div>
          )}
        </Panel>
      </div>

      {control.system_behavior && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm mt-4">
          <h2 className="text-[11px] font-medium uppercase tracking-wide text-slate-500 mb-2.5">How the system behaves</h2>
          <Markdown html={md(control.system_behavior)} />
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm mt-4">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-slate-500 mb-3">
          Event history — newest first, payloads inspectable
        </h2>
        <ControlStream control={control} isGate={isGate} queueUrl={queueUrl} />
        <div className="text-xs text-slate-400 mt-3">
          Every row is a core.event / sim.event record; payloads are PII-redacted at the API boundary. Click a row for
          its payload, “trace” for the resource’s full transaction cycle, “flag” to escalate it.
        </div>
      </div>
    </>
  );
}
