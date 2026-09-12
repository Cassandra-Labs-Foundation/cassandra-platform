// One control's audit surface: the raw event stream, every row expandable to
// its (PII-redacted) payload, every resource traceable through its whole
// transaction cycle, and every event flaggable into a real escalation.
//
// Ported from the stream/trace/flag logic in the standalone dashboard's
// app.js, rebuilt as a self-contained React component with its own state. The
// reads go through the UI's core proxy; the flag is the one write, through
// pages/api/compliance/flag (see lib/api.js flagEvent).
import React, { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Flag, X } from "lucide-react";
import {
  fetchDashboardEvents, fetchDashboardTrace, flagEvent,
} from "../../lib/api";
import { fmtT } from "../../lib/dashboardModel";
import { EventCode, WorldBadge, n } from "./atoms";

const SEVERITIES = ["routine", "elevated", "urgent"];

function payloadText(e) {
  return JSON.stringify(
    { id: e.id, type: e.type, provenance: e.provenance, delivered_at: e.delivered_at, payload: e.payload },
    null,
    1,
  );
}

// ─────────────────────────────────────────────────────── resource trace
function TraceBlock({ trace, onClose }) {
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4 mb-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
          {trace.error ? "Trace failed" : `Transaction cycle — ${trace.resource_id}`}
        </h3>
        <button onClick={onClose} className="text-xs text-blue-700 hover:underline shrink-0">close trace</button>
      </div>
      {trace.error ? (
        <div className="text-sm text-rose-600 mt-2">cannot trace {trace.resource_id}: {trace.error}</div>
      ) : (
        <>
          <div className="text-xs text-slate-500 mt-1 mb-3">{n(trace.events.length)} events</div>
          <div className="space-y-1.5">
            {trace.events.map((e, i) => (
              <div key={i} className="border-l-2 border-slate-200 pl-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[11px] text-slate-500 whitespace-nowrap">{fmtT(e.created_at)}</span>
                  <EventCode>{e.code}</EventCode>
                  <WorldBadge src={e.src} />
                </div>
                <pre className="font-mono text-[11px] leading-relaxed text-slate-500 whitespace-pre-wrap break-all mt-1">
                  {JSON.stringify(e.payload, null, 1)}
                </pre>
              </div>
            ))}
          </div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600 mt-4 mb-2">
            Gate decisions about this resource
          </h3>
          {trace.control_results.length === 0 ? (
            <div className="text-sm text-slate-400">no gate decisions recorded for this resource</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-slate-500">
                    <th className="text-left font-medium py-1">when</th>
                    <th className="text-left font-medium py-1">control</th>
                    <th className="text-left font-medium py-1">decision</th>
                    <th className="text-left font-medium py-1">event</th>
                  </tr>
                </thead>
                <tbody>
                  {trace.control_results.map((g, i) => {
                    const ok = g.decision === "pass" || g.decision === "clear";
                    return (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="py-1 font-mono text-[11px] text-slate-500 whitespace-nowrap">{fmtT(g.created_at)}</td>
                        <td className="py-1 font-mono text-[11px]">{g.control_id}</td>
                        <td className="py-1">
                          <span className={`inline-block rounded-full border px-1.5 py-0 text-[10px] uppercase tracking-wide ${ok ? "border-emerald-300 text-emerald-700" : "border-rose-300 text-rose-700"}`}>
                            {g.decision}
                          </span>
                        </td>
                        <td className="py-1 text-slate-500">{g.event || ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────── inline flag form
function FlagForm({ event, control, onDone, onCancel }) {
  const [routedTo, setRoutedTo] = useState("");
  const [severity, setSeverity] = useState("elevated");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const people = [control.owner, "Patrick Wilson, Chief Compliance Officer", "BSA Officer", "Internal Audit"]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  const submit = async () => {
    if (!routedTo.trim()) {
      setError("Route to whom? Enter a name or role.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const esc = await flagEvent({
        resource_ref: event.resource_id || null,
        event_id: event.id,
        event_code: event.code,
        control_uid: control.uid,
        routed_to: routedTo.trim(),
        severity,
        note: note.trim(),
      });
      setResult(esc);
    } catch (e) {
      setError("could not flag: " + e.message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="bg-amber-50/60 border-t border-amber-200 px-4 py-3 text-sm text-emerald-700">
        <strong>Flagged.</strong> Escalation <code className="font-mono text-slate-700">{result.id}</code> routed to{" "}
        <strong>{routedTo.trim()}</strong>
        {result.ack_due_at ? `, acknowledgement due ${fmtT(result.ack_due_at)}` : ""}.
        <span className="text-slate-400 ml-1">escalation.routed emitted · demo/sim scope</span>
        <button onClick={onDone} className="ml-3 rounded-md border border-amber-300 px-2 py-0.5 text-xs text-amber-700 hover:bg-amber-100">
          close
        </button>
      </div>
    );
  }

  return (
    <div className="bg-amber-50/60 border-t border-amber-200 px-4 py-3">
      <div className="text-xs text-slate-500 mb-2.5">
        Flag <EventCode>{event.code}</EventCode>
        {event.resource_id && <> on <EventCode>{event.resource_id}</EventCode></>} — route an escalation to the right person
      </div>
      {error && <div className="text-sm text-rose-600 mb-2">{error}</div>}
      <div className="flex flex-wrap gap-4 mb-2.5">
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-slate-500">
          Route to
          <input
            list="flag-people"
            value={routedTo}
            onChange={(e) => setRoutedTo(e.target.value)}
            placeholder="name or role"
            autoComplete="off"
            className="min-w-[280px] rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 normal-case tracking-normal focus:outline-none focus:border-blue-500"
          />
          <datalist id="flag-people">
            {people.map((p) => <option key={p} value={p} />)}
          </datalist>
        </label>
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-slate-500">
          Severity
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 normal-case tracking-normal focus:outline-none focus:border-blue-500"
          >
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-slate-500">
        Note
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="what needs attention and why"
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 normal-case tracking-normal resize-y focus:outline-none focus:border-blue-500"
        />
      </label>
      <div className="flex gap-2 mt-2.5">
        <button
          onClick={submit}
          disabled={busy}
          className="rounded-md border border-amber-400 bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-200 disabled:opacity-55"
        >
          {busy ? "routing…" : "Flag & notify"}
        </button>
        <button onClick={onCancel} className="rounded-md border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">
          cancel
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────── the stream
export default function ControlStream({ control, isGate, queueUrl }) {
  const [events, setEvents] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(!isGate);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(() => new Set()); // expanded payload indices
  const [trace, setTrace] = useState(null);
  const [flagIdx, setFlagIdx] = useState(null); // which row's flag form is open

  const load = useCallback(
    async (before) => {
      setLoading(true);
      setError(null);
      try {
        const d = await fetchDashboardEvents({ codes: control.watch, before });
        setEvents((prev) => (before ? prev.concat(d.events) : d.events));
        setNextBefore(d.next_before);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [control.watch],
  );

  useEffect(() => {
    if (!isGate && control.watch.length) load(null);
  }, [isGate, control.watch, load]);

  const runTrace = async (resourceId) => {
    try {
      const t = await fetchDashboardTrace(resourceId);
      setTrace(t);
    } catch (e) {
      setTrace({ resource_id: resourceId, error: e.message });
    }
  };

  const togglePayload = (i) => {
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  if (isGate) {
    return (
      <div className="text-slate-500 text-sm">
        The gate writes decisions, not outbox events — its per-decision history is in the heartbeat panel, and
        per-transaction decisions appear in any resource trace.
        {queueUrl && (
          <div className="mt-3">
            <a href={queueUrl} className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100">
              Review this gate’s queue <ArrowUpRight size={14} />
            </a>
          </div>
        )}
      </div>
    );
  }

  if (loading && events.length === 0) return <div className="text-slate-400 text-sm">loading…</div>;
  if (error && events.length === 0) return <div className="text-rose-600 text-sm">cannot load event history: {error}</div>;
  if (events.length === 0) {
    return (
      <div className="text-slate-500 text-sm">
        no events recorded for this control’s codes — this control has never produced evidence. That is a finding, not a blank.
      </div>
    );
  }

  return (
    <div>
      {trace && <TraceBlock trace={trace} onClose={() => setTrace(null)} />}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-500">
              <th className="text-left font-medium py-1.5">when</th>
              <th className="text-left font-medium py-1.5">event</th>
              <th className="text-left font-medium py-1.5">world</th>
              <th className="text-left font-medium py-1.5">resource</th>
              <th className="py-1.5" />
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => {
              const isOpen = open.has(i);
              const flagging = flagIdx === i;
              return (
                <React.Fragment key={`${e.id}:${i}`}>
                  <tr
                    className={`border-t border-slate-100 cursor-pointer ${flagging ? "bg-amber-50/40" : "hover:bg-slate-50"}`}
                    onClick={() => togglePayload(i)}
                  >
                    <td className="py-2 font-mono text-[11px] text-slate-500 whitespace-nowrap">{fmtT(e.created_at)}</td>
                    <td className="py-2"><EventCode>{e.code}</EventCode></td>
                    <td className="py-2"><WorldBadge src={e.src} /></td>
                    <td className="py-2 font-mono text-[11px] text-slate-500 break-all">{e.resource_id || ""}</td>
                    <td className="py-2 text-right whitespace-nowrap" onClick={(ev) => ev.stopPropagation()}>
                      {e.resource_id && (
                        <button
                          onClick={() => runTrace(e.resource_id)}
                          className="ml-1.5 rounded-md border border-blue-300 px-2 py-0.5 text-[11px] text-blue-700 hover:bg-blue-50"
                        >
                          trace
                        </button>
                      )}
                      <button
                        onClick={() => setFlagIdx(flagging ? null : i)}
                        className={`ml-1.5 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${flagging ? "border-amber-400 bg-amber-100 text-amber-800" : "border-amber-300 text-amber-700 hover:bg-amber-50"}`}
                      >
                        {flagging ? <X size={11} /> : <Flag size={11} />} flag
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-slate-50">
                      <td colSpan={5} className="px-3 py-2">
                        <pre className="font-mono text-[11px] leading-relaxed text-slate-600 whitespace-pre-wrap break-all">
                          {payloadText(e)}
                        </pre>
                      </td>
                    </tr>
                  )}
                  {flagging && (
                    <tr>
                      <td colSpan={5} className="p-0">
                        <FlagForm
                          event={e}
                          control={control}
                          onDone={() => setFlagIdx(null)}
                          onCancel={() => setFlagIdx(null)}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {nextBefore ? (
        <button
          onClick={() => load(nextBefore)}
          disabled={loading}
          className="mt-3 rounded-md border border-blue-300 px-3.5 py-1.5 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-55"
        >
          {loading ? "loading…" : "load older history"}
        </button>
      ) : (
        <div className="text-slate-400 text-xs mt-2">end of history</div>
      )}
    </div>
  );
}
