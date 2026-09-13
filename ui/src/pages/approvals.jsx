// src/pages/approvals.jsx
//
// The compliance review queue — everything two of the dashboard's controls
// actually acted on, in one place you can work from.
//
// Three lists, kept apart on purpose:
//   Held for dual control  — payments EPS-06 held for a second pair of eyes.
//   Flagged by the gate    — the money-movement gate's non-pass decisions
//                            (OFAC / velocity / NSF / structuring / CTR), each
//                            traceable to the member or account it hit AND to
//                            the control on the compliance dashboard.
//   Never assessed         — payments no threshold ever tested. NOT held and
//                            NOT found exempt: a policy gap, kept visible so it
//                            cannot be cleared away by approving everything.
//
// The point of the middle list is the connection: the dashboard says a control
// fired; this says what it fired ON and lets you go look. Read-only — approving
// or clearing is a write, recorded through the core, not from here.
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  AlertTriangle, ShieldCheck, ShieldAlert, ArrowUpRight, Ban, XCircle, PauseCircle,
} from 'lucide-react';
import MainLayout from '../components/layout/MainLayout';
import {
  APPROVALS_CAP, GATE_FLAG_DECISIONS,
  fetchPendingApprovals, fetchComplianceFlags, formatCents, formatWhen,
} from '../lib/api';
import {
  CONTROL_LABEL, controlCodeFromBasis, dashboardControlUrl, dashboardHomeUrl, subjectHref,
  reportsUrlForControl,
} from '../lib/complianceLinks';

const RAIL_LABEL = { ach_transfer: 'ACH', wire_transfer: 'Wire' };
const railLabel = (rail) => RAIL_LABEL[rail] ?? rail;

const FLAG_CAP = 50; // fetchComplianceFlags default perDecision

// ─────────────────────────────────────────────────────────── small atoms

/** A control, linked to its evidence in Compliance Monitoring. */
function ControlChip({ controlId, className = '' }) {
  if (!controlId) return <span className="text-slate-400">—</span>;
  const label = CONTROL_LABEL[controlId];
  return (
    <Link
      href={dashboardControlUrl(controlId)}
      title={`Open ${controlId}${label ? ` — ${label}` : ''} in Compliance Monitoring`}
      className={`inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 transition-colors ${className}`}
    >
      <span className="font-mono">{controlId}</span>
      <ArrowUpRight size={11} className="opacity-70" />
    </Link>
  );
}

function DecisionBadge({ decision }) {
  const map = {
    reject: ['bg-rose-50 text-rose-700 border-rose-200', XCircle],
    block: ['bg-red-50 text-red-700 border-red-200', Ban],
    hold: ['bg-amber-50 text-amber-800 border-amber-200', PauseCircle],
  };
  const [cls, Icon] = map[decision] ?? ['bg-slate-100 text-slate-600 border-slate-200', ShieldAlert];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      <Icon size={12} /> {decision}
    </span>
  );
}

/** A flagged subject, linked into this app when it resolves to a page here. */
function SubjectCell({ subjectRef }) {
  const href = subjectHref(subjectRef);
  if (!href) {
    return <span className="font-mono text-xs text-slate-500 break-all">{subjectRef ?? '—'}</span>;
  }
  const kind = subjectRef.startsWith('acct_') ? 'account' : 'member';
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 font-mono text-xs text-blue-600 hover:underline break-all"
      title={`Open this ${kind}`}
    >
      {subjectRef}
      <ArrowUpRight size={12} className="shrink-0 opacity-70" />
    </Link>
  );
}

// ────────────────────────────────────────────────────────────── the page

export default function Approvals() {
  const [data, setData] = useState(null);
  const [flags, setFlags] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [flagError, setFlagError] = useState('');

  // Arrived from a control on the compliance dashboard (?control=CG-VEL-01):
  // that control's rows get scrolled into view and ringed once they exist.
  const router = useRouter();
  const focusControl = typeof router.query.control === 'string' ? router.query.control : null;

  useEffect(() => {
    // Two independent sources: one slow or failed does not blank the other.
    fetchPendingApprovals()
      .then(setData)
      .catch((err) => { console.error('Error loading pending approvals:', err); setError(err.message); })
      .finally(() => setIsLoading(false));

    fetchComplianceFlags()
      .then(setFlags)
      .catch((err) => { console.error('Error loading compliance flags:', err); setFlagError(err.message); });
  }, []);

  // Once the target control's rows are on the page, bring them into view.
  useEffect(() => {
    if (!focusControl) return;
    const el = document.getElementById(`ctl-${focusControl}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusControl, flags, data]);

  const pendingAtCap = (data?.pendingCount ?? 0) >= APPROVALS_CAP;

  const unassessedByRail = (data?.unassessed ?? []).reduce((acc, u) => {
    acc[u.rail] = (acc[u.rail] ?? 0) + 1;
    return acc;
  }, {});
  const railsAtCap = Object.entries(unassessedByRail)
    .filter(([, n]) => n >= APPROVALS_CAP)
    .map(([rail]) => railLabel(rail));

  // Group gate flags by control, busiest first — mirrors the dashboard's
  // control view, and puts OFAC/velocity holds where an eye lands first.
  const flagGroups = useMemo(() => {
    const m = new Map();
    for (const f of (flags ?? [])) {
      if (!m.has(f.control_id)) m.set(f.control_id, []);
      m.get(f.control_id).push(f);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [flags]);

  const flagsAtCap = GATE_FLAG_DECISIONS.some(
    (d) => (flags ?? []).filter((f) => f.decision === d).length >= FLAG_CAP,
  );

  return (
    <MainLayout
      title="Payment Approvals"
      subtitle="The compliance review queue — what the gate held, blocked or rejected, and what nobody assessed"
      actions={
        <Link
          href={dashboardHomeUrl()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
        >
          <ShieldCheck size={15} className="text-indigo-600" />
          Compliance Monitoring
          <ArrowUpRight size={13} className="opacity-60" />
        </Link>
      }
    >
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-6">
          <h3 className="font-medium text-red-800">Could not load the approval queue</h3>
          <p className="text-sm text-red-600 mt-0.5">{error}</p>
        </div>
      )}

      {/* ── Connection band: three queues at a glance ─────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <SummaryTile
          label="Held for dual control"
          value={data?.pendingCount}
          hint="EPS-06 · second pair of eyes"
          tone="indigo"
        />
        <SummaryTile
          label="Flagged by the gate"
          value={flags?.length}
          hint={flagError ? 'could not load' : 'OFAC · velocity · NSF · structuring'}
          tone="rose"
        />
        <SummaryTile
          label="Never assessed"
          value={data?.unassessedCount}
          hint="no threshold tested — policy gap"
          tone="amber"
        />
      </div>

      {focusControl && (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm">
          <span className="text-indigo-800">
            Opened from the compliance dashboard — focused on{' '}
            <span className="font-mono font-medium">{focusControl}</span>
            {CONTROL_LABEL[focusControl] ? ` · ${CONTROL_LABEL[focusControl]}` : ''}
          </span>
          <Link href="/approvals" className="text-indigo-600 hover:underline shrink-0">Clear</Link>
        </div>
      )}

      {isLoading ? (
        <div className="p-6 text-center bg-white rounded-lg border border-slate-200">
          <div className="animate-spin inline-block w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full mb-2" />
          <div>Loading approval queue…</div>
        </div>
      ) : !data ? null : (
        <>
          {/* ── Flagged by the money-movement gate (the connection) ───── */}
          <section className="mb-8">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-semibold flex items-center">
                <ShieldAlert size={18} className="mr-2 text-rose-500" />
                Flagged by the money-movement gate
              </h2>
              <span className="text-sm text-slate-500">{(flags ?? []).length} flag(s)</span>
            </div>
            <p className="text-sm text-slate-500 mb-4">
              Non-pass decisions the gate recorded — each links to the affected member or account here,
              and to the control on the compliance dashboard.
            </p>

            {flagError && (
              <div className="bg-red-50 border border-red-200 rounded-md p-3 mb-3 text-sm text-red-700">
                Could not load compliance flags: {flagError}
              </div>
            )}
            {flagsAtCap && (
              <div className="bg-slate-100 border border-slate-200 rounded-md p-3 mb-3 text-sm text-slate-700">
                Showing the most recent {FLAG_CAP} per decision. There may be more flags than are listed here.
              </div>
            )}

            {flags === null ? (
              <div className="p-6 text-center bg-white rounded-lg border border-slate-200 text-slate-500">
                Loading compliance flags…
              </div>
            ) : flags.length === 0 ? (
              <div className="p-6 text-center bg-white rounded-lg border border-slate-200 text-slate-500">
                The gate passed everything in the window — nothing to review.
              </div>
            ) : (
              <div className="space-y-4">
                {flagGroups.map(([controlId, rows]) => (
                  <div
                    key={controlId}
                    id={`ctl-${controlId}`}
                    className={`bg-white rounded-lg border overflow-hidden transition-shadow ${focusControl === controlId ? 'border-indigo-400 ring-2 ring-indigo-300' : 'border-slate-200'}`}
                  >
                    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100 bg-slate-50">
                      <div className="flex items-center gap-2 min-w-0">
                        <ControlChip controlId={controlId} />
                        <span className="text-sm font-medium text-slate-700 truncate">
                          {CONTROL_LABEL[controlId] ?? 'Control'}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 whitespace-nowrap">
                        {/* Every decision this control recorded, not just the flagged ones. */}
                        <Link
                          href={reportsUrlForControl(controlId)}
                          title={`See all of ${controlId}'s recorded decisions in Reports`}
                          className="inline-flex items-center gap-0.5 text-xs text-blue-600 hover:underline"
                        >
                          Reports <ArrowUpRight size={11} className="opacity-70" />
                        </Link>
                        <span className="text-xs text-slate-500">{rows.length} flagged</span>
                      </div>
                    </div>
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-slate-100 text-xs font-medium text-slate-500">
                          <th className="text-left py-2 px-4 w-32">Decision</th>
                          <th className="text-left py-2 px-4">Subject</th>
                          <th className="text-left py-2 px-4">Event</th>
                          <th className="text-right py-2 px-4 w-28">Score</th>
                          <th className="text-left py-2 px-4 w-40">When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((f) => (
                          <tr key={f.id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
                            <td className="py-2.5 px-4"><DecisionBadge decision={f.decision} /></td>
                            <td className="py-2.5 px-4"><SubjectCell subjectRef={f.subject_ref} /></td>
                            <td className="py-2.5 px-4 font-mono text-xs text-slate-500 break-all">{f.event ?? '—'}</td>
                            <td className="py-2.5 px-4 text-right text-sm tabular-nums text-slate-600">
                              {f.score === null || f.score === undefined ? <span className="text-slate-300">—</span> : f.score}
                            </td>
                            <td className="py-2.5 px-4 text-sm text-slate-500 whitespace-nowrap">{formatWhen(f.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Held for dual control (EPS-06) ────────────────────────── */}
          <section className="mb-8">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-semibold flex items-center">
                <ShieldCheck size={18} className="mr-2 text-slate-400" />
                Held for dual control
              </h2>
              <span className="text-sm text-slate-500">{data.pendingCount} pending</span>
            </div>
            <p className="text-sm text-slate-500 mb-4">
              Payments a control held for a second pair of eyes. The control links to its evidence on the
              compliance dashboard.
            </p>

            {pendingAtCap && (
              <div className="bg-slate-100 border border-slate-200 rounded-md p-3 mb-3 text-sm text-slate-700">
                Showing {APPROVALS_CAP}, the maximum this endpoint returns. There may be more pending approvals.
              </div>
            )}

            <div
              id="ctl-EPS-06"
              className={`bg-white rounded-lg border overflow-hidden transition-shadow ${focusControl === 'EPS-06' ? 'border-indigo-400 ring-2 ring-indigo-300' : 'border-slate-200'}`}
            >
              {data.pending.length === 0 ? (
                <div className="p-6 text-center text-slate-500">No payments are awaiting approval.</div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-sm font-medium text-slate-500">
                      <th className="text-left py-3 px-4">Rail</th>
                      <th className="text-left py-3 px-4">Resource</th>
                      <th className="text-left py-3 px-4">Held by</th>
                      <th className="text-left py-3 px-4">Requested by</th>
                      <th className="text-left py-3 px-4">Requested</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pending.map((row) => {
                      const code = controlCodeFromBasis(row.basis);
                      return (
                        <tr key={row.id} className="border-b border-slate-200 last:border-b-0 hover:bg-slate-50">
                          <td className="py-3 px-4 text-sm font-medium">{railLabel(row.resource_type)}</td>
                          {/* resource_id points into ach_transfer/wire_transfer, which have no GET
                              route — the amount and parties are not resolvable from here. */}
                          <td className="py-3 px-4">
                            <div className="font-mono text-xs text-slate-700 break-all">{row.resource_id}</div>
                            <div className="text-xs text-slate-400 mt-0.5">{row.resource_type} id — not resolvable from this UI</div>
                          </td>
                          <td className="py-3 px-4">
                            {code ? <ControlChip controlId={code} /> : <span className="text-sm text-slate-500">{row.basis ?? '—'}</span>}
                            {code && CONTROL_LABEL[code] && (
                              <div className="text-xs text-slate-400 mt-0.5">{CONTROL_LABEL[code]}</div>
                            )}
                          </td>
                          <td className="py-3 px-4 text-sm text-slate-600 break-all">{row.created_by ?? '—'}</td>
                          <td className="py-3 px-4 text-sm text-slate-500 whitespace-nowrap">{formatWhen(row.created_at)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {data.pending.length > 0 && (
                <div className="bg-slate-50 px-4 py-2 border-t border-slate-200 text-xs text-slate-500">
                  Approving a payment is a write. This proxy is read-only, so approvals are recorded through
                  the core API, not from here.
                </div>
              )}
            </div>
          </section>

          {/* ── Never assessed ───────────────────────────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-semibold flex items-center">
                <AlertTriangle size={18} className="mr-2 text-slate-400" />
                Never assessed
              </h2>
              <span className="text-sm text-slate-500">{data.unassessedCount} payment(s)</span>
            </div>
            <p className="text-sm text-slate-500 mb-4">
              Payments no configured threshold ever tested — neither held nor found exempt.
            </p>

            {data.warning && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3 flex items-start">
                <AlertTriangle size={18} className="text-amber-600 mr-2 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-amber-800">{data.warning}</p>
              </div>
            )}
            {railsAtCap.length > 0 && (
              <div className="bg-slate-100 border border-slate-200 rounded-md p-3 mb-3 text-sm text-slate-700">
                {railsAtCap.join(' and ')} {railsAtCap.length === 1 ? 'is' : 'are'} at {APPROVALS_CAP}, the
                per-rail maximum this endpoint returns. There may be more unassessed payments.
              </div>
            )}

            <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
              {data.unassessed.length === 0 ? (
                <div className="p-6 text-center text-slate-500">Every payment was assessed against a configured limit.</div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-sm font-medium text-slate-500">
                      <th className="text-left py-3 px-4">Rail</th>
                      <th className="text-left py-3 px-4">Resource</th>
                      <th className="text-right py-3 px-4">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.unassessed.map((row) => (
                      <tr key={`${row.rail}:${row.id}`} className="border-b border-slate-200 last:border-b-0 hover:bg-slate-50">
                        <td className="py-3 px-4 text-sm font-medium">{railLabel(row.rail)}</td>
                        <td className="py-3 px-4">
                          <div className="font-mono text-xs text-slate-700 break-all">{row.id}</div>
                          <div className="text-xs text-slate-400 mt-0.5">{row.rail} id — not resolvable from this UI</div>
                        </td>
                        <td className="py-3 px-4 text-sm text-right tabular-nums">{formatCents(row.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      )}
    </MainLayout>
  );
}

function SummaryTile({ label, value, hint, tone }) {
  const toneCls = {
    indigo: 'text-indigo-700',
    rose: 'text-rose-700',
    amber: 'text-amber-700',
  }[tone] ?? 'text-slate-900';
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneCls}`}>
        {value === null || value === undefined ? <span className="text-slate-300 text-lg">—</span> : value}
      </div>
      <div className="mt-0.5 text-xs text-slate-400">{hint}</div>
    </div>
  );
}
