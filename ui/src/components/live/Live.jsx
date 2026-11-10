// The visual vocabulary of "this number is live".
//
// Three pieces, and the third is the one that matters most:
//
//   LiveBadge  — the heartbeat. Says whether events are flowing, and when the
//                last real one landed.
//   LiveValue  — a figure that visibly changes when it changes.
//   DeltaChip  — movement since the page was opened.
//
// The design constraint throughout: a live dashboard must be able to say "this
// feed is not moving". A pulsing green dot over a figure whose source died
// last Tuesday is worse than no dot at all, because it converts an absence of
// information into a false positive.
import React, { useEffect, useRef, useState } from 'react';
import { IDLE_AFTER_MS, ago, useNow } from '../../lib/useLiveCore';

/**
 * The heartbeat.
 *
 * Three states, deliberately distinct rather than a boolean:
 *   live    — the sequence advanced recently. Green, pulsing.
 *   idle    — polling fine, nothing happening. Slate, still. This is the
 *             honest state for a quiet book, and for seed data that stopped.
 *   no beat — the poll itself is failing. Amber. Different problem entirely.
 */
export function LiveBadge({ live, polledAt, lastAdvanceAt, error, compact = false, className = '' }) {
  const now = useNow();

  if (error) {
    return (
      <span className={`inline-flex items-center text-xs text-[#93370d] ${className}`} title="heartbeat failing, showing last known figures">
        <span className="w-2 h-2 rounded-full bg-silent mr-1.5 shrink-0" aria-hidden="true" />
        {compact ? 'no beat' : 'heartbeat failing, showing last known figures'}
      </span>
    );
  }

  // The ledger clock, not the poll clock: how long since the core's position
  // last moved. Labeled "ledger" because other surfaces (e.g. drill events in
  // the monitoring feed) run on their own clocks.
  const eventMs = live?.eventAt ? now - new Date(live.eventAt).getTime() : null;
  const isLive = lastAdvanceAt !== null && now - lastAdvanceAt < IDLE_AFTER_MS;
  const state = isLive ? `live · ledger moved ${ago(now - lastAdvanceAt)}` : `idle · ledger last moved ${ago(eventMs)}`;
  const seq = live?.seq !== null && live?.seq !== undefined ? Number(live.seq).toLocaleString() : null;

  return (
    <span
      className={`inline-flex items-center text-xs ${className}`}
      title={compact ? `${state}${seq ? ` · seq ${seq}` : ''}` : undefined}
      aria-label={compact ? `Core ${state}` : undefined}
    >
      <span className="relative flex w-2 h-2 mr-1.5 shrink-0" aria-hidden="true">
        {isLive && (
          <span className="motion-safe:animate-ping absolute inline-flex w-full h-full rounded-full bg-live opacity-75" />
        )}
        <span className={`relative inline-flex w-2 h-2 rounded-full ${isLive ? 'bg-live' : 'bg-never'}`} />
      </span>
      {compact ? (
        <span className={isLive ? 'text-[#067647]' : 'text-ink-muted'}>{isLive ? 'live' : 'idle'}</span>
      ) : (
        <>
          <span className={isLive ? 'text-[#067647]' : 'text-ink-muted'}>{state}</span>
          {polledAt && <span className="text-ink-soft ml-1.5">· checked {ago(now - polledAt)}</span>}
          {seq && <span className="text-ink-soft ml-1.5">· seq {seq}</span>}
        </>
      )}
    </span>
  );
}

/**
 * A figure that flashes when it moves.
 *
 * The flash is the whole point: on a dashboard someone leaves open on a wall,
 * a number that changes silently between glances is a number nobody saw
 * change. Keyed on the formatted text rather than the raw cents so a
 * re-render with an identical value does not fire it.
 */
export function LiveValue({ children, value, className = '' }) {
  const [flash, setFlash] = useState(false);
  const prev = useRef(value);

  useEffect(() => {
    if (prev.current !== undefined && prev.current !== value) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1200);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);

  return (
    <span
      className={`inline-block transition-colors duration-700 rounded px-1 -mx-1 ${
        flash ? 'bg-green-100 text-green-900' : ''
      } ${className}`}
    >
      {children}
    </span>
  );
}

/** Movement since the page was opened. Null baseline renders nothing. */
export function DeltaChip({ cents, format }) {
  if (typeof cents !== 'number' || cents === 0) return null;
  const up = cents > 0;
  return (
    <span
      className={`ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
        up ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
      }`}
    >
      {up ? '▲' : '▼'} {format(Math.abs(cents))} since open
    </span>
  );
}
