// Liquidity flows: the treasury / ALCO team runs the institution's liquidity
// risk book (LQ-02..LQ-17) against the DEPLOYED core. Ported from the
// user-observable behaviour of the liquidity.ts unit stubs (see
// ledger/liquidity.md), plus the ops tail those stubs never reached (NCUA
// notification → acknowledgment, regulator requests, tie-out, concentration,
// wholesale pricing, model and ALCO reviews).
//
// Shared-state notes — this is the live demo institution:
//   * positions are keyed by as_of_date, so every run posts on a random date in
//     the 20th century: its own rows, and never the institution's "latest"
//     position (the pack and the daily LAR keep reading the real one).
//   * the LAR band config, the stress assumption set and the FHLB facility are
//     institution-wide singletons. Flows that write them snapshot the rows first
//     and restore them byte-for-byte in a `finally`.
import { actor, type Any, api, assert, assertEq, core, flow, uid } from "./helpers.ts";

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const HAIRCUTS = { treasury: 0, agency: 200 };
const DAY_MS = 86_400_000;

/** the api_token id helpers.actor() derives from the plaintext it returns */
function tokenIdOf(plaintext: string, actorType: string): string {
  return `tok_test_${actorType}_${plaintext.slice("cass_test_".length, "cass_test_".length + 12)}`;
}

async function rowById(table: string, id: string) {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data as Any;
}

async function eventById(id: string) {
  return await rowById("event", id);
}

/** events of `code` written for one liquidity resource */
async function eventsFor(resourceType: string, id: string, code: string) {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("resource_id", `${resourceType}:${id}`).eq("code", code);
  assert(!r.error, `event read: ${r.error?.message}`);
  return (r.data ?? []) as Any[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
function addDays(date: string, n: number): string {
  return iso(new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS));
}

/** a random 20th-century date with `span` free consecutive days of liquidity positions */
async function freeDate(span: number): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const year = 1901 + Math.floor(Math.random() * 98);
    const d = iso(new Date(Date.UTC(year, 0, 1) + Math.floor(Math.random() * 360) * DAY_MS));
    const ids = Array.from({ length: span }, (_, k) => `liqpos_${addDays(d, k)}`);
    const r = await core().from("liquidity_position").select("id").in("id", ids);
    assert(!r.error, `liquidity_position read: ${r.error?.message}`);
    if ((r.data ?? []).length === 0) return d;
  }
  throw new Error("no free liquidity date found in 20 tries");
}

function position(asOf: string, liquid: number, over: Record<string, unknown> = {}) {
  return {
    as_of_date: asOf, liquid_assets_cents: liquid, total_assets_cents: 400_000_000_00,
    haircut_table: HAIRCUTS, gl_balances: { cash: liquid }, ...over,
  };
}

async function snapshot(table: string): Promise<Any[]> {
  const r = await core().from(table).select("*");
  assert(!r.error, `${table} snapshot: ${r.error?.message}`);
  return (r.data ?? []) as Any[];
}

/**
 * Put an institution-wide singleton table back exactly as it was: rows a flow
 * created are removed (or, if something now references them, superseded), and
 * every snapshot row is rewritten with its original values.
 */
async function restore(table: string, before: Any[], supersedes = true): Promise<void> {
  const known = new Set(before.map((r) => r.id));
  const now = await snapshot(table);
  for (const row of now.filter((r) => !known.has(r.id))) {
    const del = await core().from(table).delete().eq("id", row.id);
    if (del.error && supersedes) {
      await core().from(table).update({ superseded_at: new Date().toISOString() }).eq("id", row.id);
    }
  }
  if (before.length) {
    const up = await core().from(table).upsert(before, { onConflict: "id" });
    if (up.error) console.error(`RESTORE FAILED for ${table}: ${up.error.message}`);
  }
  const after = await snapshot(table);
  const key = (rows: Any[]) => JSON.stringify([...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))));
  if (key(after) !== key(before)) console.error(`RESTORE MISMATCH for ${table}`);
}

/** the institution's current (unsuperseded) LAR band config */
async function currentBands(): Promise<Any> {
  const r = await core().from("lar_band_config").select("*").is("superseded_at", null);
  assert(!r.error, `lar_band_config read: ${r.error?.message}`);
  assertEq((r.data ?? []).length, 1, "exactly one current LAR band config");
  return r.data![0];
}

function bandOf(bp: number, cfg: Any): string {
  if (bp < cfg.critical_bp) return "critical";
  if (bp < cfg.warning_bp) return "warning";
  if (bp < cfg.target_bp) return "adequate";
  return "target";
}

// ------------------------------------------------------------ LQ-03 / LQ-02

flow("liquidity: daily LAR positions → band verdict → critical breach + band-change alert → mismatch breach dispositioned by its owner", async (t) => {
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  let day1 = "";
  let day2 = "";
  let cfg: Any;
  const pos1 = () => `liqpos_${day1}`;
  const pos2 = () => `liqpos_${day2}`;

  await t.step("setup: two free consecutive dates; the bands in force are read, not assumed", async () => {
    day1 = await freeDate(2);
    day2 = addDays(day1, 1);
    cfg = await currentBands();
    assert(cfg.critical_bp < 1000 && 1000 < cfg.target_bp, `10% must sit inside the bands (got ${JSON.stringify(cfg)})`);
    assert(300 < cfg.critical_bp, "3% must be critical under the bands in force");
  });

  await t.step("a partner cannot reach the liquidity book: 404, nothing written", async () => {
    const r = await api("POST", "/liquidity/positions", position(day1, 40_000_000_00), { key: partner });
    assertEq(r.status, 404, `partner position (${body(r)})`);
    assertEq(await rowById("liquidity_position", pos1()), null, "no position row");
  });

  await t.step("a ratio with no haircut table is refused: nobody could reproduce it", async () => {
    const r = await api("POST", "/liquidity/positions", {
      as_of_date: day1, liquid_assets_cents: 1, total_assets_cents: 100,
    }, { key: ops });
    assertEq(r.status, 400, `no haircut table (${body(r)})`);
    assertEq(await rowById("liquidity_position", pos1()), null, "no position row");
  });

  await t.step("day 1 at 10%: banded verdict with the config that made it; the §741.12 tier is derived, not asserted", async () => {
    const r = await api("POST", "/liquidity/positions",
      position(day1, 40_000_000_00, { asset_tier: "under_50m" }), { key: ops });
    assertEq(r.status, 201, `post position (${body(r)})`);
    const want = bandOf(1000, cfg);
    assertEq(r.body.data.lar_value_bp, 1000, "LAR in bp");
    assertEq(r.body.data.band, want, "band on the response");
    assertEq(r.body.data.asset_tier, "over_250m", "caller-supplied tier ignored");
    const p = await rowById("liquidity_position", pos1());
    assertEq(p.lar_value_bp, 1000, "row LAR");
    assertEq(p.lar_current_band, want, "row band");
    assertEq(p.band_config_id, cfg.id, "the verdict and the config that made it, together");
    assertEq(p.asset_tier, "over_250m", "STATUTORY tier derived from total assets");
    assertEq(p.liquidity_haircut_table?.agency, 200, "haircut table stored with the ratio");
    assertEq(p.provenance, "demo", "test-actor evidence is labelled demo");
    const ev = await eventById(`ev_${pos1()}_lar`);
    assertEq(ev?.code, "lar.computed", "lar.computed event");
    assertEq(ev?.payload?.verdict, want, "event verdict");
    assertEq(ev?.payload?.asset_tier, "over_250m", "event carries the derived tier");
    assertEq((await eventById(`ev_${pos1()}_bandalert`))?.code, "lar.band_alert.issued", "band alert issued");
    assertEq(await eventById(`ev_${pos1()}_crit`), null, "no critical breach at 10%");
  });

  await t.step("day 2 at 3%: critical breach fires, and the band CHANGE is its own alert", async () => {
    const r = await api("POST", "/liquidity/positions", position(day2, 12_000_000_00), { key: ops });
    assertEq(r.status, 201, `post position (${body(r)})`);
    assertEq(r.body.data.band, "critical", "critical band");
    const p = await rowById("liquidity_position", pos2());
    assertEq(p.lar_value_bp, 300, "row LAR");
    assertEq(p.lar_prior_band, bandOf(1000, cfg), "prior band is yesterday's");
    assertEq((await eventById(`ev_${pos2()}_crit`))?.code, "lar.critical.breached", "critical breach event");
    const chg = await eventById(`ev_${pos2()}_bandchg`);
    assertEq(chg?.code, "alert.lar_band_change", "band-change alert");
    assertEq(chg?.payload?.from, bandOf(1000, cfg), "from band");
    assertEq(chg?.payload?.to, "critical", "to band");
  });

  await t.step("statutory tier boundaries: $49.99m is under_50m, $50m is mid", async () => {
    const lo = addDays(day1, 40);
    const hi = addDays(day1, 41);
    const a = await api("POST", "/liquidity/positions",
      position(lo, 1_000_000_00, { total_assets_cents: 50_000_000_00 - 1 }), { key: ops });
    assertEq(a.status, 201, `post (${body(a)})`);
    assertEq((await rowById("liquidity_position", `liqpos_${lo}`))?.asset_tier, "under_50m", "just under the CFP line");
    const b = await api("POST", "/liquidity/positions",
      position(hi, 1_000_000_00, { total_assets_cents: 50_000_000_00, asset_tier: "under_50m" }), { key: ops });
    assertEq(b.status, 201, `post (${body(b)})`);
    assertEq((await rowById("liquidity_position", `liqpos_${hi}`))?.asset_tier, "mid", "at the CFP line: mid, whatever the caller says");
  });

  await t.step("mismatch with no limit: gaps recorded, NO verdict (unassessed), no breach alert", async () => {
    const r = await api("POST", `/liquidity/positions/${pos1()}/mismatch`,
      { gaps: { "0_30d": -90_000_000_00 } }, { key: ops });
    assertEq(r.status, 201, `mismatch (${body(r)})`);
    const m = await rowById("maturity_mismatch", `mism_${pos1()}`);
    assertEq(m.mismatch_current_gaps?.["0_30d"], -90_000_000_00, "gap stored");
    assertEq(m.mismatch_limit, null, "no limit");
    assertEq(m.mismatch_breached_bucket, null, "no breach verdict without a limit");
    assertEq(m.mismatch_breach_magnitude_cents, null, "no magnitude without a limit");
    assertEq((await eventById(`ev_mism_${pos1()}_gap`))?.payload?.verdict, "unassessed", "verdict unassessed");
    assertEq(await eventById(`ev_mism_${pos1()}_alert`), null, "no breach alert");
  });

  await t.step("a mismatch on an unknown position is 404; a partner gets 404", async () => {
    const r = await api("POST", `/liquidity/positions/liqpos_nope_${uid()}/mismatch`, { gaps: {} }, { key: ops });
    assertEq(r.status, 404, `unknown position (${body(r)})`);
    const p = await api("POST", `/liquidity/positions/${pos2()}/mismatch`, { gaps: {} }, { key: partner });
    assertEq(p.status, 404, `partner mismatch (${body(p)})`);
  });

  const breach = {
    gaps: { "0_30d": -90_000_000_00, "31_90d": -10_000_000_00 },
    limit: { "0_30d": -50_000_000_00, "31_90d": -50_000_000_00 },
    disposition: "drew on the FHLB line and re-laddered",
  };

  await t.step("a breach disposition with no owner is refused, and nothing is written", async () => {
    const r = await api("POST", `/liquidity/positions/${pos2()}/mismatch`, breach, { key: ops });
    assertEq(r.status, 400, `ownerless disposition (${body(r)})`);
    assertEq(await rowById("maturity_mismatch", `mism_${pos2()}`), null, "no mismatch row");
  });

  await t.step("the breach with an owner: bucket + magnitude recorded, alert + disposition events", async () => {
    const r = await api("POST", `/liquidity/positions/${pos2()}/mismatch`,
      { ...breach, dispositioned_by: "treasurer_flow", intraday: true, draw_amount_cents: 20_000_000_00 },
      { key: ops });
    assertEq(r.status, 201, `mismatch (${body(r)})`);
    assertEq(r.body.data.breached_bucket, "0_30d", "breached bucket on response");
    const m = await rowById("maturity_mismatch", `mism_${pos2()}`);
    assertEq(m.mismatch_breached_bucket, "0_30d", "breached bucket");
    assertEq(m.mismatch_breach_magnitude_cents, 40_000_000_00, "magnitude: a $90m gap against a $50m cap is $40m over");
    assertEq(m.dispositioned_by, "treasurer_flow", "disposition owner");
    assert(m.dispositioned_at, "disposition time");
    assert(m.intraday_recomputed_at, "intraday recompute stamped");
    assertEq(m.funding_draw_amount_cents, 20_000_000_00, "draw recorded");
    assertEq((await eventById(`ev_mism_${pos2()}_alert`))?.code, "alert.mismatch_breach", "breach alert");
    const d = await eventById(`ev_mism_${pos2()}_disp`);
    assertEq(d?.code, "mismatch.breach.dispositioned", "disposition event");
    assertEq(d?.payload?.by, "treasurer_flow", "disposition event names the owner");
    assertEq((await eventById(`ev_mism_${pos2()}_intra`))?.code, "mismatch.intraday_recomputed", "intraday event");
  });
});

// ------------------------------------------------------------ LQ-03 governance

flow("liquidity: ALCO re-approves the LAR bands → crossing or unapproved bands refused → the prior version is kept", async (t) => {
  const admin = await actor("cu_admin");
  const before = await snapshot("lar_band_config");
  let cfg: Any;
  try {
    await t.step("read the bands in force", async () => {
      cfg = await currentBands();
    });

    await t.step("bands that cross are refused and nothing changes", async () => {
      const r = await api("POST", "/liquidity/lar-bands",
        { critical_bp: 900, warning_bp: 500, target_bp: 1200, approved_by: "alco_chair" }, { key: admin });
      assertEq(r.status, 400, `crossing bands (${body(r)})`);
      assertEq(JSON.stringify(await snapshot("lar_band_config")), JSON.stringify(before), "config untouched");
    });

    await t.step("an unapproved band is a suggestion: refused", async () => {
      const r = await api("POST", "/liquidity/lar-bands",
        { critical_bp: cfg.critical_bp, warning_bp: cfg.warning_bp, target_bp: cfg.target_bp }, { key: admin });
      assertEq(r.status, 400, `unapproved bands (${body(r)})`);
      assertEq((await currentBands()).id, cfg.id, "config in force unchanged");
    });

    await t.step("annual re-approval (same values): a NEW version; the prior one is superseded, not overwritten", async () => {
      const r = await api("POST", "/liquidity/lar-bands", {
        critical_bp: cfg.critical_bp, warning_bp: cfg.warning_bp, target_bp: cfg.target_bp,
        approved_by: `alco_chair_${uid()}`,
      }, { key: admin });
      assertEq(r.status, 201, `re-approve (${body(r)})`);
      const now = await currentBands();
      assertEq(now.critical_bp, cfg.critical_bp, "same bands in force");
      // DEFECT: lar_band_config id is `larcfg_v${unsuperseded+1}` — always v2 once one exists — so a re-approval upserts over the config in force; the history positions cite (band_config_id) is destroyed
      assert(now.id !== cfg.id, `re-approval must create a new version, not overwrite ${cfg.id}`);
      const prior = await rowById("lar_band_config", cfg.id);
      assertEq(prior?.approved_by, cfg.approved_by, "the prior approval is still on file");
      assert(prior?.superseded_at, "the prior version is superseded");
    });
  } finally {
    await restore("lar_band_config", before);
  }
});

// ------------------------------------------------------------ LQ-04 / LQ-05

flow("liquidity: stress runs under the assumption set → survival below threshold → assumptions changed with rationale → old runs stay reproducible", async (t) => {
  const ops = await actor("pynthia_ops");
  const admin = await actor("cu_admin");
  const before = await snapshot("stress_assumption_set");
  const period = `flow_${uid()}`;
  let set: Any;
  try {
    await t.step("read the assumption set in force", async () => {
      const r = await core().from("stress_assumption_set").select("*").is("superseded_at", null);
      assert(!r.error, `read: ${r.error?.message}`);
      assertEq((r.data ?? []).length, 1, "exactly one current assumption set");
      set = r.data![0];
    });

    await t.step("scheduled run above its threshold: verdict above, no below-threshold alert, pack issued", async () => {
      const r = await api("POST", "/liquidity/stress-runs",
        { period, kind: "scheduled", survival_days: 90, threshold_days: 60 }, { key: ops });
      assertEq(r.status, 201, `run (${body(r)})`);
      assertEq(r.body.data.below_threshold, false, "not below");
      const id = `stressrun_${period}_sched`;
      const run = await rowById("liquidity_stress_run", id);
      assertEq(run.assumption_set_id, set.id, "the run cites the assumption set it ran under");
      assertEq(run.survival_days_combined, 90, "survival days");
      assertEq(run.survival_below_threshold, false, "paired verdict");
      assertEq((await eventById(`ev_${id}_surv`))?.payload?.verdict, "above", "survival.computed verdict");
      assertEq(await eventById(`ev_${id}_below`), null, "no below-threshold alert");
      assertEq((await eventById(`ev_${id}_pack`))?.code, "stress.pack.issued", "stress pack issued");
    });

    await t.step("a run with no threshold has days but NO verdict (unassessed)", async () => {
      const p2 = `${period}_nothr`;
      const r = await api("POST", "/liquidity/stress-runs",
        { period: p2, kind: "scheduled", survival_days: 3 }, { key: ops });
      assertEq(r.status, 201, `run (${body(r)})`);
      const run = await rowById("liquidity_stress_run", `stressrun_${p2}_sched`);
      assertEq(run.survival_threshold_days, null, "no threshold");
      assertEq(run.survival_below_threshold, null, "3 days with no threshold is still no verdict");
      assertEq((await eventById(`ev_stressrun_${p2}_sched_surv`))?.payload?.verdict, "unassessed", "verdict unassessed");
      assertEq(await eventById(`ev_stressrun_${p2}_sched_below`), null, "no alert");
    });

    await t.step("an ad-hoc rerun must say what triggered it", async () => {
      const r = await api("POST", "/liquidity/stress-runs",
        { period, kind: "adhoc", survival_days: 45, threshold_days: 60 }, { key: ops });
      assertEq(r.status, 400, `unexplained rerun (${body(r)})`);
      assertEq(await rowById("liquidity_stress_run", `stressrun_${period}_adhoc`), null, "no run written");
    });

    await t.step("ad-hoc rerun on an EWI spike: 45 days < 60 fires survival.below_threshold with the trigger", async () => {
      const r = await api("POST", "/liquidity/stress-runs", {
        period, kind: "adhoc", survival_days: 45, threshold_days: 60,
        trigger_reason: "EWI spike: 3% single-day deposit outflow",
      }, { key: ops });
      assertEq(r.status, 201, `rerun (${body(r)})`);
      assertEq(r.body.data.below_threshold, true, "below");
      const id = `stressrun_${period}_adhoc`;
      const run = await rowById("liquidity_stress_run", id);
      assertEq(run.kind, "adhoc", "kind");
      assertEq(run.trigger_reason, "EWI spike: 3% single-day deposit outflow", "trigger recorded");
      assertEq((await eventById(`ev_${id}_below`))?.code, "survival.below_threshold", "below-threshold alert");
      assertEq((await eventById(`ev_${id}_rerun`))?.payload?.trigger, run.trigger_reason, "rerun event carries the trigger");
    });

    await t.step("changing an assumption without a rationale and approver is refused; the set in force is untouched", async () => {
      const r = await api("POST", "/liquidity/stress-assumptions",
        { set: "severe", behavioral_assumptions: { runoff_bp: 2500 } }, { key: admin });
      assertEq(r.status, 400, `silent change (${body(r)})`);
      assertEq(JSON.stringify(await rowById("stress_assumption_set", set.id)),
        JSON.stringify(before.find((x) => x.id === set.id)), "set in force unchanged");
    });

    const rationale = `flow ${uid()}: partner exit showed 25% runoff`;
    await t.step("the change with rationale + approver: a NEW version, the old one superseded and kept", async () => {
      const r = await api("POST", "/liquidity/stress-assumptions", {
        set: "severe", behavioral_assumptions: { runoff_bp: 2500 },
        rationale, approver_id: "alco_chair",
      }, { key: admin });
      assertEq(r.status, 201, `change (${body(r)})`);
      // DEFECT: stress_assumption_set id is `stressassm_v${unsuperseded+1}` — always v2 once one exists — so a change upserts over the set in force instead of versioning it
      assert(r.body.data.version > set.version, `version advances past ${set.version} (got ${r.body.data.version})`);
      assert(r.body.data.id !== set.id, `the change must not overwrite ${set.id}`);
      const old = await rowById("stress_assumption_set", set.id);
      assertEq(JSON.stringify(old?.stress_behavioral_assumptions), JSON.stringify(set.stress_behavioral_assumptions),
        "the superseded set still holds its assumptions");
      assert(old?.superseded_at, "the old set is superseded");
    });

    await t.step("evidence: stress.assumption_versioned records THIS change's rationale", async () => {
      const evs = await core().from("event").select("id, payload").eq("code", "stress.assumption_versioned")
        .contains("payload", { "stress.change_rationale": rationale });
      assert(!evs.error, `event read: ${evs.error?.message}`);
      // DEFECT: the event id `ev_stressassm_v2_ver` already exists and is written ignoreDuplicates, so an assumption change emits no event at all
      assertEq((evs.data ?? []).length, 1, "one versioning event for the change");
    });

    await t.step("the earlier run is still reproducible: the set it cites holds the assumptions it ran under", async () => {
      const run = await rowById("liquidity_stress_run", `stressrun_${period}_sched`);
      const cited = await rowById("stress_assumption_set", run.assumption_set_id);
      // DEFECT: same root cause — the cited set was overwritten in place, so last quarter's number now points at this quarter's assumptions
      assertEq(JSON.stringify(cited?.stress_behavioral_assumptions), JSON.stringify(set.stress_behavioral_assumptions),
        "the run's provenance is intact");
    });
  } finally {
    await restore("stress_assumption_set", before);
  }
});

// ---------------------------------------------------------------------- LQ-09

flow("liquidity: FHLB line tested from a script → collateral pledged → headroom below floor alerts → recheck", async (t) => {
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  const before = await snapshot("liquidity_facility");
  const script = `flow ${uid()}: draw $1m, confirm settlement, repay same day`;
  const asOf = await freeDate(1);
  try {
    await t.step("an unknown facility kind is refused", async () => {
      const r = await api("POST", "/liquidity/facilities", { name: "Bank of Nowhere", kind: "payday" }, { key: ops });
      assertEq(r.status, 400, `bad kind (${body(r)})`);
    });

    await t.step("a test outcome with no script is refused: nobody could repeat it", async () => {
      const r = await api("POST", "/liquidity/facilities",
        { name: "FHLB Atlanta", kind: "fhlb", tested: true }, { key: ops });
      assertEq(r.status, 400, `scriptless test (${body(r)})`);
      assertEq(JSON.stringify(await rowById("liquidity_facility", "fac_fhlb")),
        JSON.stringify(before.find((x) => x.id === "fac_fhlb") ?? null), "facility untouched");
    });

    await t.step("a partner cannot touch the contingency facilities (404)", async () => {
      const r = await api("POST", "/liquidity/facilities",
        { name: "FHLB Atlanta", kind: "fhlb", tested: true, test_script: script }, { key: partner });
      assertEq(r.status, 404, `partner facility (${body(r)})`);
    });

    await t.step("the annual draw test, from a script: tested now, next test due a year out", async () => {
      const t0 = Date.now();
      const r = await api("POST", "/liquidity/facilities", {
        name: "FHLB Atlanta", kind: "fhlb", tested: true, test_script: script,
        contacts: { desk: "555-0199" }, collateral_schedule: { mortgages: "blanket lien" },
      }, { key: ops });
      assertEq(r.status, 201, `facility test (${body(r)})`);
      const f = await rowById("liquidity_facility", "fac_fhlb");
      assertEq(f.facility_test_script, script, "script recorded");
      const tested = Date.parse(f.last_tested_at);
      assert(tested >= t0 - 60_000, "tested at the time of the test");
      assertEq(Date.parse(f.test_due_at) - tested, 365 * DAY_MS, "next test due 365 days from this test");
    });

    await t.step("evidence: facility.test.completed carries THIS test's script", async () => {
      const evs = await eventsFor("liquidity_facility", "fac_fhlb", "facility.test.completed");
      // DEFECT: the event id `ev_fac_fhlb_test` is fixed per facility and written ignoreDuplicates, so every test after the first leaves no event
      assert(evs.some((e) => e.payload?.["facility.test_script"] === script),
        `a facility.test.completed event for this test (have ${evs.length}, none with this script)`);
    });

    await t.step("headroom without eligibility rules is refused; an unknown facility is 404", async () => {
      const r = await api("POST", "/liquidity/facilities/fac_fhlb/collateral",
        { unencumbered_cents: 1, pledged_cents: 0, as_of_date: asOf }, { key: ops });
      assertEq(r.status, 400, `no eligibility rules (${body(r)})`);
      assertEq(await rowById("collateral_position", `coll_fac_fhlb_${asOf}`), null, "nothing written");
      const u = await api("POST", `/liquidity/facilities/fac_nope_${uid()}/collateral`,
        { unencumbered_cents: 1, eligibility_rules: { m: "x" } }, { key: ops });
      assertEq(u.status, 404, `unknown facility (${body(u)})`);
    });

    await t.step("headroom with no floor: computed, but NO verdict and no alert", async () => {
      const r = await api("POST", "/liquidity/facilities/fac_fhlb/collateral", {
        as_of_date: asOf, unencumbered_cents: 30_000_000_00, pledged_cents: 28_000_000_00,
        eligibility_rules: { mortgages: "1-4 family, current" },
      }, { key: ops });
      assertEq(r.status, 201, `collateral (${body(r)})`);
      const id = `coll_fac_fhlb_${asOf}`;
      const c = await rowById("collateral_position", id);
      assertEq(c.headroom_cents, 2_000_000_00, "headroom = unencumbered − pledged");
      assertEq(c.headroom_floor_cents, null, "no floor");
      assertEq(c.headroom_low, null, "no verdict without a floor");
      assertEq((await eventById(`ev_${id}_hr`))?.payload?.verdict, "unassessed", "verdict unassessed");
      assertEq(await eventById(`ev_${id}_low`), null, "no low-headroom alert");
    });

    await t.step("pledged paper moved: recheck against the $50m floor → headroom_low + alert", async () => {
      const d2 = addDays(asOf, 1);
      const r = await api("POST", "/liquidity/facilities/fac_fhlb/collateral", {
        as_of_date: d2, unencumbered_cents: 30_000_000_00, pledged_cents: 28_000_000_00,
        floor_cents: 5_000_000_00, eligibility_rules: { mortgages: "1-4 family, current" },
        move_detail: { out: "sold $20m of pledged paper" }, recompute: true,
      }, { key: ops });
      assertEq(r.status, 201, `recheck (${body(r)})`);
      assertEq(r.body.data.low, true, "low on response");
      const id = `coll_fac_fhlb_${d2}`;
      const c = await rowById("collateral_position", id);
      assertEq(c.headroom_low, true, "headroom below floor");
      assertEq(c.headroom_floor_cents, 5_000_000_00, "floor recorded with the verdict");
      assert(c.recomputed_at, "recheck stamped");
      assertEq((await eventById(`ev_${id}_low`))?.code, "alert.headroom_low", "low-headroom alert");
      assertEq((await eventById(`ev_${id}_re`))?.code, "collateral.headroom_rechecked", "recheck event");
    });
  } finally {
    await restore("liquidity_facility", before, false);
  }
});

// ---------------------------------------------------------------------- LQ-07

flow("liquidity: the board pack is assembled from the latest position, never re-entered", async (t) => {
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  const period = `flow_${uid()}`;
  let latest: Any;

  await t.step("read the institution's latest liquidity position", async () => {
    const r = await core().from("liquidity_position").select("*").order("as_of_date", { ascending: false }).limit(1);
    assert(!r.error, `read: ${r.error?.message}`);
    latest = r.data?.[0];
    assert(latest, "the institution has a liquidity position");
  });

  await t.step("an unknown cadence is refused; a partner gets 404", async () => {
    const r = await api("POST", "/liquidity/packs", { cadence: "hourly", period }, { key: ops });
    assertEq(r.status, 400, `bad cadence (${body(r)})`);
    const p = await api("POST", "/liquidity/packs", { cadence: "board", period }, { key: partner });
    assertEq(p.status, 404, `partner pack (${body(p)})`);
    assertEq(await rowById("liquidity_pack", `liqpack_board_${period}`), null, "no pack written");
  });

  await t.step("publish the board deck — a typed-in LAR is ignored; the numbers come from the position", async () => {
    const r = await api("POST", "/liquidity/packs", {
      cadence: "board", period, "lar.value": 9999, lar_value_bp: 9999,
      ceo_summary: "flow: LAR reviewed", limit_registry: ["LAR", "mismatch"],
    }, { key: ops });
    assertEq(r.status, 201, `pack (${body(r)})`);
    const pack = await rowById("liquidity_pack", `liqpack_board_${period}`);
    assertEq(pack.position_id, latest.id, "pack anchored on the latest position");
    assertEq(pack.contents?.["lar.value"], latest.lar_value_bp, "LAR assembled, not re-entered");
    assertEq(pack.contents?.["lar.current_band"], latest.lar_current_band, "band assembled");
    assertEq(pack.contents?.["ewi.ceo_summary"], "flow: LAR reviewed", "narrative carried");
    assertEq(pack.published_by, tokenIdOf(ops, "pynthia_ops"), "publisher recorded");
    const ev = await eventById(`ev_liqpack_board_${period}_pub`);
    assertEq(ev?.code, "report.board_deck.published", "board deck event");
    assertEq(ev?.payload?.["lar.value"], latest.lar_value_bp, "event carries the assembled numbers");
  });

  await t.step("the pack's maturity gaps are the latest position's own mismatch", async () => {
    const m = await rowById("maturity_mismatch", `mism_${latest.id}`);
    const pack = await rowById("liquidity_pack", `liqpack_board_${period}`);
    if (m) {
      // DEFECT: postLiquidityPack takes maturity_mismatch / collateral_position / liquidity_stress_run row [0] with no ordering or filter, so the deck shows an arbitrary day's gaps, headroom and survival
      assertEq(JSON.stringify(pack.contents?.["mismatch.current_gaps"]), JSON.stringify(m.mismatch_current_gaps),
        `pack gaps are ${latest.id}'s`);
    }
  });

  await t.step("daily and weekly cadences publish their own report events", async () => {
    for (const [cadence, code] of [["daily", "report.daily_pack.published"], ["weekly", "report.weekly_digest.published"]]) {
      const r = await api("POST", "/liquidity/packs", { cadence, period }, { key: ops });
      assertEq(r.status, 201, `${cadence} pack (${body(r)})`);
      assertEq((await eventById(`ev_liqpack_${cadence}_${period}_pub`))?.code, code, `${cadence} event`);
    }
  });
});

// ---------------------------------------------------------------------- LQ-11 / LQ-13

flow("liquidity: NCUA notified of a liquidity event → acknowledgment logged; regulator request → contacts verified → response sent", async (t) => {
  const admin = await actor("cu_admin");
  const partner = await actor("partner");
  let notif = "";
  let reqId = "";

  await t.step("a partner is refused the regulator channel (403 by actor gate)", async () => {
    const r = await api("POST", "/liquidity/ncua-notifications", { kind: "liquidity_event" }, { key: partner });
    assertEq(r.status, 403, `partner notification (${body(r)})`);
    const q = await api("POST", "/liquidity/regulator-requests", { regulator: "NCUA" }, { key: partner });
    assertEq(q.status, 403, `partner regulator request (${body(q)})`);
  });

  await t.step("a notification needs a kind", async () => {
    const r = await api("POST", "/liquidity/ncua-notifications", {}, { key: admin });
    assertEq(r.status, 400, `no kind (${body(r)})`);
  });

  await t.step("notify NCUA: the notification is a record with its send time and an event", async () => {
    const r = await api("POST", "/liquidity/ncua-notifications", { kind: "liquidity_event" }, { key: admin });
    assertEq(r.status, 201, `notify (${body(r)})`);
    notif = String(r.body.data.id);
    const n = await rowById("ncua_notification", notif);
    assertEq(n.kind, "liquidity_event", "kind");
    assert(n.sent_at, "sent_at");
    assertEq(n.ack_received_at, null, "not yet acknowledged");
    assertEq(n.provenance, "demo", "demo evidence");
    assertEq((await eventById(`ev_${notif}_sent`))?.code, "ncua.notification.sent", "sent event");
  });

  await t.step("an acknowledgment with no reference is refused; acking an unknown notification is 404", async () => {
    const r = await api("POST", `/liquidity/ncua-notifications/${notif}/ack`, {}, { key: admin });
    assertEq(r.status, 400, `refless ack (${body(r)})`);
    assertEq((await rowById("ncua_notification", notif)).ack_received_at, null, "still unacknowledged");
    const u = await api("POST", `/liquidity/ncua-notifications/ncua_nope_${uid()}/ack`, { ack_ref: "x" }, { key: admin });
    assertEq(u.status, 404, `unknown notification (${body(u)})`);
  });

  await t.step("NCUA acknowledges: ack time + reference recorded, the gap is measurable", async () => {
    const ref = `ncua_ack_${uid()}`;
    const r = await api("POST", `/liquidity/ncua-notifications/${notif}/ack`, { ack_ref: ref }, { key: admin });
    assertEq(r.status, 200, `ack (${body(r)})`);
    const n = await rowById("ncua_notification", notif);
    assertEq(n.ack_ref, ref, "ack reference");
    assert(Date.parse(n.ack_received_at) >= Date.parse(n.sent_at) - 5_000, "ack after send");
    const ev = await eventById(`ev_${notif}_ack`);
    assertEq(ev?.code, "ncua.ack.logged", "ack event");
    assertEq(ev?.payload?.ack_ref, ref, "ack event carries the reference");
  });

  await t.step("a regulator request needs the regulator named; then it is logged with its receipt time", async () => {
    const bad = await api("POST", "/liquidity/regulator-requests", {}, { key: admin });
    assertEq(bad.status, 400, `no regulator (${body(bad)})`);
    const r = await api("POST", "/liquidity/regulator-requests", { regulator: "NCUA" }, { key: admin });
    assertEq(r.status, 201, `request (${body(r)})`);
    reqId = String(r.body.data.id);
    const q = await rowById("regulator_request", reqId);
    assert(q.received_at, "received_at");
    assertEq(q.responded_at, null, "not yet answered");
  });

  await t.step("verify the regulator contacts before answering", async () => {
    const r = await api("POST", `/liquidity/regulator-requests/${reqId}/verify-contacts`,
      { verified_by: "treasurer_flow" }, { key: admin });
    assertEq(r.status, 200, `verify (${body(r)})`);
    assert((await rowById("regulator_request", reqId)).contacts_verified_at, "contacts verified time");
    const ev = await eventById(`ev_${reqId}_contacts`);
    assertEq(ev?.code, "regulator.contacts.verified", "verify event");
    assertEq(ev?.payload?.verified_by, "treasurer_flow", "verifier named");
  });

  await t.step("respond: an unreferenced response is refused; a referenced one is recorded", async () => {
    const bad = await api("POST", `/liquidity/regulator-requests/${reqId}/respond`, {}, { key: admin });
    assertEq(bad.status, 400, `refless response (${body(bad)})`);
    assertEq((await rowById("regulator_request", reqId)).responded_at, null, "still unanswered");
    const ref = `resp_${uid()}`;
    const r = await api("POST", `/liquidity/regulator-requests/${reqId}/respond`, { response_ref: ref }, { key: admin });
    assertEq(r.status, 200, `respond (${body(r)})`);
    const q = await rowById("regulator_request", reqId);
    assertEq(q.response_ref, ref, "response reference");
    assert(Date.parse(q.responded_at) >= Date.parse(q.received_at) - 5_000, "responded after receipt");
    const ev = await eventById(`ev_${reqId}_resp`);
    assertEq(ev?.code, "regulator.response.sent", "response event");
    assertEq(ev?.payload?.response_ref, ref, "event carries the reference");
    const u = await api("POST", `/liquidity/regulator-requests/regreq_nope_${uid()}/respond`, { response_ref: ref }, { key: admin });
    assertEq(u.status, 404, `unknown request (${body(u)})`);
  });
});

// ---------------------------------------------------------------- LQ-06/08/17

flow("liquidity: ALCO ops tail — EOD tie-out variance, depositor concentration waiver, wholesale pricing, model + ratio reviews", async (t) => {
  const ops = await actor("pynthia_ops");
  const admin = await actor("cu_admin");
  const partner = await actor("partner");

  await t.step("EOD tie-out: a GL/subledger variance is DETECTED; a clean tie-out completes without one", async () => {
    const bad = await api("POST", "/liquidity/eod-tieout", { gl_total_cents: 1 }, { key: ops });
    assertEq(bad.status, 400, `missing subledger (${body(bad)})`);
    const r = await api("POST", "/liquidity/eod-tieout",
      { gl_total_cents: 100_000_00, subledger_total_cents: 99_950_00 }, { key: ops });
    assertEq(r.status, 201, `tieout (${body(r)})`);
    assertEq(r.body.data.variance_cents, 50_00, "variance on response");
    const id = String(r.body.data.id);
    assertEq((await rowById("dq_tieout", id)).variance_cents, 50_00, "variance stored");
    assertEq((await eventById(`ev_${id}_var`))?.code, "dq.variance.detected", "variance event");
    assertEq((await eventById(`ev_${id}_done`))?.code, "dq.tieout.completed", "completed event");
    const ok = await api("POST", "/liquidity/eod-tieout",
      { gl_total_cents: 100_000_00, subledger_total_cents: 100_000_00 }, { key: ops });
    assertEq(ok.status, 201, `clean tieout (${body(ok)})`);
    assertEq(await eventById(`ev_${ok.body.data.id}_var`), null, "no variance event when it ties");
  });

  await t.step("depositor concentration: no limit is unassessed; a breach without a waiver decision is 409; with one it is recorded", async () => {
    const un = await api("POST", "/liquidity/concentration", { top_depositor_pct_bp: 900 }, { key: ops });
    assertEq(un.status, 201, `unassessed (${body(un)})`);
    const unId = String(un.body.data.id);
    assertEq((await eventById(`ev_${unId}_unassessed`))?.payload?.verdict, "unassessed", "no limit: unassessed");
    assertEq((await rowById("liquidity_concentration", unId)).breached, false, "row");

    const silent = await api("POST", "/liquidity/concentration",
      { top_depositor_pct_bp: 900, limit_pct_bp: 500 }, { key: ops });
    assertEq(silent.status, 409, `breach without waiver (${body(silent)})`);
    assertEq(silent.body.type, "waiver_decision_required", "typed refusal");

    const w = await api("POST", "/liquidity/concentration", {
      top_depositor_pct_bp: 900, limit_pct_bp: 500,
      waiver_decision: "granted through quarter end", waiver_decided_by: "alco_chair",
    }, { key: admin });
    assertEq(w.status, 201, `breach with waiver (${body(w)})`);
    assertEq(w.body.data.breached, true, "breached");
    const id = String(w.body.data.id);
    const row = await rowById("liquidity_concentration", id);
    assertEq(row.waiver_decided_by, "alco_chair", "waiver decider");
    assertEq((await eventById(`ev_${id}_breach`))?.code, "liquidity.concentration.breached", "breach event");
    assertEq((await eventById(`ev_${id}_waiver`))?.payload?.decided_by, "alco_chair", "waiver event");
  });

  await t.step("wholesale funding above market raises a pricing violation; at market does not", async () => {
    const r = await api("POST", "/liquidity/wholesale", {
      amount_cents: 25_000_000_00, rate_bp: 540, market_rate_bp: 500, listing_decision: "do not list",
    }, { key: ops });
    assertEq(r.status, 201, `wholesale (${body(r)})`);
    assertEq(r.body.data.pricing_violation, true, "violation");
    const id = String(r.body.data.id);
    assertEq((await rowById("wholesale_exposure", id)).pricing_violation, true, "row");
    assertEq((await eventById(`ev_${id}_viol`))?.code, "alert.wholesale_pricing_violation", "violation alert");
    assertEq((await eventById(`ev_${id}_listing`))?.payload?.decision, "do not list", "listing decision");
    const ok = await api("POST", "/liquidity/wholesale",
      { amount_cents: 25_000_000_00, rate_bp: 500, market_rate_bp: 500 }, { key: ops });
    assertEq(ok.status, 201, `at market (${body(ok)})`);
    assertEq(ok.body.data.pricing_violation, false, "no violation at market");
    assertEq(await eventById(`ev_${ok.body.data.id}_viol`), null, "no alert");
  });

  await t.step("model review: incomplete is refused; complete is recorded with its outcome", async () => {
    const bad = await api("POST", "/liquidity/model-reviews", { model: "survival_horizon" }, { key: admin });
    assertEq(bad.status, 400, `incomplete (${body(bad)})`);
    const r = await api("POST", "/liquidity/model-reviews",
      { model: "survival_horizon", reviewer: "model_risk_flow", outcome: "approved with findings" }, { key: admin });
    assertEq(r.status, 201, `review (${body(r)})`);
    const id = String(r.body.data.id);
    assertEq((await rowById("model_review", id)).reviewer, "model_risk_flow", "reviewer");
    assertEq((await eventById(`ev_${id}_done`))?.payload?.outcome, "approved with findings", "review event");
  });

  await t.step("ALCO ratio review: needs a reviewer; logs the ratios it looked at", async () => {
    const bad = await api("POST", "/liquidity/alco-review", { ratios: { lar_bp: 1000 } }, { key: admin });
    assertEq(bad.status, 400, `no reviewer (${body(bad)})`);
    const r = await api("POST", "/liquidity/alco-review",
      { ratios: { lar_bp: 1000 }, reviewed_by: "alco_chair" }, { key: admin });
    assertEq(r.status, 201, `review (${body(r)})`);
    const ev = await eventById(`ev_${r.body.data.id}_rev`);
    assertEq(ev?.code, "alco.ratio_review.logged", "review event");
    assertEq(ev?.payload?.ratios?.lar_bp, 1000, "ratios on record");
  });

  await t.step("a partner is refused the ALCO tail (403)", async () => {
    const r = await api("POST", "/liquidity/eod-tieout",
      { gl_total_cents: 1, subledger_total_cents: 1 }, { key: partner });
    assertEq(r.status, 403, `partner tieout (${body(r)})`);
  });
});
