// src/pages/compliance.jsx
//
// The governance calendar, from GET /governance/obligations.
//
// Two registers, not one list. An obligation with no anchor_date has no
// next_due_at either — it is real and owned, but it has no place on a calendar.
// Sorting those to the bottom of the schedule would make them look like the
// most distant deadlines instead of the undated work they are.
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { CalendarClock, CalendarOff, ArrowUpRight } from 'lucide-react';
import MainLayout from '../components/layout/MainLayout';
import { fetchObligations, formatWhen, OBLIGATIONS_CAP } from '../lib/api';
import { useControlIndex, monitoringUrlForControl, reportsUrlForControl } from '../lib/complianceLinks';

/**
 * ISO timestamp -> "Jul 19, 2026". Due dates are dates, not moments.
 *
 * Read in UTC, never the browser's zone. next_due_at is midnight UTC derived
 * from a plain `anchor_date` — rendering it locally moves it across a day
 * boundary anywhere west of UTC, so an obligation anchored to 2026-01-01
 * displays as "Dec 31, 2025" and files under the wrong month.
 */
function formatDue(iso) {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "2026-07" and "July 2026" for the month an obligation falls in — UTC, per above. */
function monthOf(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return {
    key: `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`,
    label: at.toLocaleDateString([], { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

export default function Compliance() {
  const router = useRouter();
  // The control catalogue, for linking an obligation's control_uid to the
  // control's monitoring surface and its recorded decisions in Reports.
  const { index } = useControlIndex();
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // Arrived from a control in Monitoring (?control_uid=bsa:BSA-01): that
  // control's obligation rows get ringed and the first is scrolled into view.
  const focusUid = typeof router.query.control_uid === 'string' ? router.query.control_uid : null;

  useEffect(() => {
    async function loadData() {
      try {
        setData(await fetchObligations());
      } catch (err) {
        console.error('Error loading obligations:', err);
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    }

    loadData();
  }, []);

  // Once the focused control's rows are on the page, bring the first into view.
  // A control can own several obligations (different triggers), so match on the
  // data attribute in JS rather than a selector — first in DOM order wins, and
  // a control_uid from the URL never reaches a CSS query.
  useEffect(() => {
    if (!focusUid) return;
    const rows = document.querySelectorAll('[data-oblig-control]');
    const el = Array.from(rows).find((r) => r.getAttribute('data-oblig-control') === focusUid);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusUid, data]);

  const rows = data?.obligations ?? [];
  // Split on anchor_date, the same field the core counts on.
  const scheduled = rows.filter((o) => o.anchor_date && o.next_due_at);
  const unscheduled = rows.filter((o) => !o.anchor_date || !o.next_due_at);

  // The endpoint has no limit param and no cursor: it returns at most 500 rows
  // and cannot say whether there were more. A register sitting exactly at the
  // ceiling looks complete, so name the ceiling.
  const atCap = rows.length >= OBLIGATIONS_CAP;

  const now = Date.now();
  const months = [];
  for (const o of scheduled) {
    const month = monthOf(o.next_due_at);
    if (!month) continue;
    let bucket = months.find((m) => m.key === month.key);
    if (!bucket) {
      bucket = { ...month, obligations: [] };
      months.push(bucket);
    }
    bucket.obligations.push(o);
  }

  return (
    <MainLayout
      title="Compliance Calendar"
      subtitle="Recurring governance obligations and what they are anchored to"
    >
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-6">
          <h3 className="font-medium text-red-800">Could not load the obligation register</h3>
          <p className="text-sm text-red-600 mt-0.5">{error}</p>
        </div>
      )}

      {focusUid && (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm">
          <span className="text-blue-800">
            Opened from Monitoring — focused on obligations for{' '}
            <span className="font-mono font-medium">{focusUid}</span>
          </span>
          <Link href="/compliance" className="text-blue-600 hover:underline shrink-0">Clear</Link>
        </div>
      )}

      {isLoading ? (
        <div className="p-6 text-center bg-white rounded-lg border border-slate-200">
          <div className="animate-spin inline-block w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full mb-2"></div>
          <div>Loading obligations...</div>
        </div>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <Stat label="Obligations" value={data.total} />
            <Stat label="Scheduled" value={data.scheduled} />
            <Stat label="Unscheduled" value={data.unscheduled} />
          </div>

          {atCap && (
            <div className="bg-slate-100 border border-slate-200 rounded-md p-3 mb-6 text-sm text-slate-700">
              Showing {OBLIGATIONS_CAP}, the maximum this endpoint returns. The register may hold
              more obligations than are listed here.
            </div>
          )}

          {/* ---------------------------------------------------- scheduled */}
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-4 flex items-center">
              <CalendarClock size={18} className="mr-2 text-slate-400" />
              Scheduled
            </h2>

            {months.length === 0 ? (
              <div className="p-6 text-center bg-white rounded-lg border border-slate-200 text-slate-500">
                No obligation has a due date.
              </div>
            ) : (
              months.map((month) => (
                <div
                  key={month.key}
                  className="bg-white rounded-lg border border-slate-200 overflow-hidden mb-4"
                >
                  <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                    <span className="font-medium text-sm">{month.label}</span>
                    <span className="text-xs text-slate-500">
                      {month.obligations.length} due
                    </span>
                  </div>
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="text-left py-2 px-4 text-sm font-medium text-slate-500">Due</th>
                        <th className="text-left py-2 px-4 text-sm font-medium text-slate-500">Obligation</th>
                        <th className="text-left py-2 px-4 text-sm font-medium text-slate-500">Owner</th>
                        <th className="text-left py-2 px-4 text-sm font-medium text-slate-500">Cadence</th>
                        <th className="text-left py-2 px-4 text-sm font-medium text-slate-500">Last completed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {month.obligations.map((o) => {
                        const overdue = new Date(o.next_due_at).getTime() < now;
                        return (
                          <tr
                            key={o.id}
                            data-oblig-control={o.control_uid ?? undefined}
                            className={`border-b border-slate-200 last:border-b-0 hover:bg-slate-50 ${focusUid && o.control_uid === focusUid ? 'bg-blue-50 ring-2 ring-inset ring-blue-300' : ''}`}
                          >
                            <td className="py-3 px-4 text-sm whitespace-nowrap">
                              <span className={overdue ? 'text-red-700 font-medium' : ''}>
                                {formatDue(o.next_due_at)}
                              </span>
                              {overdue && (
                                <span className="ml-2 text-xs font-medium bg-red-100 text-red-800 py-0.5 px-1.5 rounded">
                                  overdue
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-medium text-sm">{o.title ?? o.trigger_code}</div>
                              <ObligationControl o={o} index={index} />
                            </td>
                            <td className="py-3 px-4 text-sm text-slate-600">
                              {o.owner_role ?? '—'}
                            </td>
                            <td className="py-3 px-4 text-sm text-slate-600">{o.cadence ?? '—'}</td>
                            <td className="py-3 px-4 text-sm text-slate-500 whitespace-nowrap">
                              {o.last_completed_at ? formatWhen(o.last_completed_at) : 'never'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </div>

          {/* -------------------------------------------------- unscheduled */}
          <div>
            <h2 className="text-lg font-semibold mb-2 flex items-center">
              <CalendarOff size={18} className="mr-2 text-slate-400" />
              Unscheduled
            </h2>
            <p className="text-sm text-slate-500 mb-4">
              No anchor date, so no next due date was computed. These are owned obligations with
              no position on the calendar — not obligations due far in the future.
            </p>

            <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
              {unscheduled.length === 0 ? (
                <div className="p-6 text-center text-slate-500">
                  Every obligation is anchored to a date.
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50">
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-500">Obligation</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-500">Owner</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-500">Cadence</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-500">Last completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unscheduled.map((o) => (
                      <tr
                        key={o.id}
                        data-oblig-control={o.control_uid ?? undefined}
                        className={`border-b border-slate-200 last:border-b-0 hover:bg-slate-50 ${focusUid && o.control_uid === focusUid ? 'bg-blue-50 ring-2 ring-inset ring-blue-300' : ''}`}
                      >
                        <td className="py-3 px-4">
                          <div className="font-medium text-sm">{o.title ?? o.trigger_code}</div>
                          <ObligationControl o={o} index={index} />
                        </td>
                        <td className="py-3 px-4 text-sm text-slate-600">{o.owner_role ?? '—'}</td>
                        <td className="py-3 px-4 text-sm text-slate-600">{o.cadence ?? '—'}</td>
                        <td className="py-3 px-4 text-sm text-slate-500 whitespace-nowrap">
                          {o.last_completed_at ? formatWhen(o.last_completed_at) : 'never'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </MainLayout>
  );
}

/**
 * An obligation's control line: the policy-qualified control_uid, its trigger,
 * and a jump to its recorded decisions in Reports.
 *
 * The uid is policy-qualified, so it is unambiguous — but it is only a link when
 * the control is actually in the catalogue. An obligation whose control the
 * manifest has never heard of keeps the id as plain text rather than linking to
 * a monitoring page that would just say "not in the catalogue".
 */
function ObligationControl({ o, index }) {
  const entry = o.control_uid ? index?.resolve(o.control_uid) : null;
  return (
    <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
      {entry ? (
        <Link
          href={monitoringUrlForControl(entry)}
          title={`Open ${entry.id}${entry.title ? ` — ${entry.title}` : ''} in Monitoring`}
          className="inline-flex items-center gap-0.5 font-mono text-blue-600 hover:underline"
        >
          {o.control_uid}
          <ArrowUpRight size={10} className="opacity-70" />
        </Link>
      ) : (
        <span className="font-mono">{o.control_uid ?? '—'}</span>
      )}
      {o.trigger_code ? <span>· {o.trigger_code}</span> : null}
      {entry && (
        <Link
          href={reportsUrlForControl(entry.id)}
          title={`See ${entry.id}'s recorded decisions in Reports`}
          className="text-blue-600 hover:underline"
        >
          results →
        </Link>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="font-semibold text-2xl mt-1 tabular-nums">{value}</div>
    </div>
  );
}
