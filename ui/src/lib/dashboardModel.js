// The compliance dashboard's heartbeat model — ported verbatim in behaviour
// from the standalone dashboard (compliance/dashboard/assets/app.js) so the
// in-app monitoring surface and the GitHub-Pages one read the same evidence
// the same way.
//
// A transaction-monitoring surface, not a scoreboard: every control has a
// HEARTBEAT (its event codes bucketed over time, from
// /compliance/dashboard/heartbeat), and buildModel() lays every code and gate
// control onto one shared time grid so every sparkline on the page is
// comparable at a glance. pulseOf() then reads one control's series off that
// grid. Pure functions, no DOM, no React — the pages own the rendering.

export const fmtT = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

/** "2m ago" / "3h ago" / "never" — human elapsed time since an ISO instant. */
export function ago(iso) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return Math.max(1, Math.round(s)) + "s ago";
  if (s < 5400) return Math.round(s / 60) + "m ago";
  if (s < 129600) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

/**
 * Build the shared model from a heartbeat payload + the live data blob.
 *
 * `prev` is the previous model, if any. last_seen is the all-time census — the
 * heaviest, slowest-moving block — so refresh polls request the heartbeat
 * WITHOUT it (?last_seen=0 -> hb.last_seen === null) and the model keeps the
 * census from the initial load. null means "not requested"; [] would mean a
 * genuinely empty history.
 */
export function buildModel(hb, data, prev) {
  const step = hb.bucket_seconds;
  const t0 = Math.floor(new Date(hb.since).getTime() / 1000 / step) * step;
  const B = Math.max(1, Math.floor((Date.now() / 1000 - t0) / step) + 1);
  const idx = (iso) => {
    const i = Math.floor((new Date(iso).getTime() / 1000 - t0) / step);
    return i < 0 ? 0 : i >= B ? B - 1 : i;
  };

  const byCode = new Map(); // code -> {core:[], sim:[], total}
  for (const r of hb.events || []) {
    let e = byCode.get(r.code);
    if (!e) byCode.set(r.code, (e = { core: new Array(B).fill(0), sim: new Array(B).fill(0), total: 0 }));
    e[r.src === "sim" ? "sim" : "core"][idx(r.bucket)] += r.n;
    e.total += r.n;
  }

  const gateById = new Map(); // control_id -> {core:[], sim:[], total, decisions:{}}
  for (const r of hb.gate || []) {
    let g = gateById.get(r.control_id);
    if (!g) {
      gateById.set(r.control_id, (g = {
        core: new Array(B).fill(0), sim: new Array(B).fill(0), total: 0, decisions: {},
      }));
    }
    g[r.src === "sim" ? "sim" : "core"][idx(r.bucket)] += r.n;
    g.total += r.n;
    g.decisions[r.decision] = (g.decisions[r.decision] || 0) + r.n;
  }

  // code -> {last_at, total}, all-time. Carried from the previous model on a
  // slim refresh (hb.last_seen === null).
  let seen;
  if (hb.last_seen === null && prev) {
    seen = prev.seen;
  } else {
    seen = new Map();
    for (const r of hb.last_seen || []) {
      const s = seen.get(r.code);
      if (!s) seen.set(r.code, { last_at: r.last_at, total: r.total });
      else {
        s.total += r.total;
        if (r.last_at > s.last_at) s.last_at = r.last_at;
      }
    }
  }

  // gate recency: control_id -> {last_at, total}, all-time, both worlds folded,
  // so a gate that was quiet all week still shows its last evidence, not "never".
  const gateSeen = new Map();
  for (const r of hb.gate_last_seen || []) {
    const s = gateSeen.get(r.control_id);
    if (!s) gateSeen.set(r.control_id, { last_at: r.last_at, total: r.total });
    else {
      s.total += r.total;
      if (r.last_at > s.last_at) s.last_at = r.last_at;
    }
  }

  return { grid: { t0, step, B }, byCode, gateById, gateSeen, seen, data, hb };
}

/** An empty pulse on the current grid. */
export function emptyPulse(B) {
  return { core: new Array(B).fill(0), sim: new Array(B).fill(0), total: 0, last_at: null, everTotal: 0 };
}

/**
 * The pulse of one control: sum its watch codes (or its gate series) onto the
 * grid, plus its all-time last-evidence and total.
 */
export function pulseOf(model, ctl) {
  const B = model.grid.B;
  const out = emptyPulse(B);

  if ((ctl.watch || []).length === 0 && (model.gateById.has(ctl.id) || model.gateSeen.has(ctl.id))) {
    // gateById only holds controls with in-window pulses; a gate quiet all week
    // but with history must still show its last evidence, not "never".
    const g = model.gateById.get(ctl.id);
    const gs = model.gateSeen.get(ctl.id);
    return {
      core: g ? g.core : out.core,
      sim: g ? g.sim : out.sim,
      total: g ? g.total : 0,
      last_at: gs ? gs.last_at : null,
      everTotal: gs ? gs.total : g ? g.total : 0,
      decisions: g ? g.decisions : {},
    };
  }

  for (const code of ctl.watch || []) {
    const e = model.byCode.get(code);
    if (e) {
      for (let i = 0; i < B; i++) {
        out.core[i] += e.core[i];
        out.sim[i] += e.sim[i];
      }
      out.total += e.total;
    }
    const s = model.seen.get(code);
    if (s) {
      out.everTotal += s.total;
      if (!out.last_at || s.last_at > out.last_at) out.last_at = s.last_at;
    }
  }
  return out;
}

/** Sum a set of pulses onto one grid — used for policy cards and the index. */
export function sumPulses(pulses, B) {
  const out = { core: new Array(B).fill(0), sim: new Array(B).fill(0), total: 0 };
  for (const p of pulses) {
    for (let i = 0; i < B; i++) {
      out.core[i] += p.core[i];
      out.sim[i] += p.sim[i];
    }
    out.total += p.total;
  }
  return out;
}
