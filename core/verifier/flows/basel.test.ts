// Basel II standardized approach (BA-03..BA-08) and business continuity
// (BC-05, BC-11, BC-13): the CFO's risk-weighting and buffer work, the
// liquidity contingency plan, the Pillar 3 disclosure, and the incident
// commander's comms tree → post-incident review → corrective actions.
// Replaces the stubbed unit tests in core/supabase/functions/api/basel.test.ts
// (see ledger/basel.md).
//
// SHARED-STATE DISCIPLINE. Two things here are institution-wide singletons:
// the active risk-weight schedule (core.rwa_schedule, superseded_at IS NULL)
// and the comms tree (core.comms_tree id 'commstree'). The flows that change
// them snapshot every row first and write the snapshot back in a `finally`.
// Everything else is keyed by a run-unique date, period or incident id.
import { actor, type Any, api, assert, assertEq, core, flow } from "./helpers.ts";

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const DAY = 86_400_000;
const TRADING_BOOK_THRESHOLD_CENTS = 10_000_000_00;
const BASIC_INDICATOR_ALPHA_BP = 1500;

function randomOldDate(): string {
  const y = 1900 + Math.floor(Math.random() * 100);
  return `${y}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`;
}

/** a 1900s date for which `table` has no row with id `${prefix}${fmt(date)}` */
async function freshDate(table: string, idOf: (d: string) => string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const d = randomOldDate();
    const r = await core().from(table).select("id").eq("id", idOf(d)).maybeSingle();
    assert(!r.error, `${table} read: ${r.error?.message}`);
    if (!r.data) return d;
  }
  throw new Error(`no free date in ${table}`);
}

async function row(table: string, id: string) {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data as Any;
}

/** events written against `${type}:${id}`, keyed by code */
async function events(type: string, id: string): Promise<Map<string, Any[]>> {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("resource_id", `${type}:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  const m = new Map<string, Any[]>();
  for (const e of r.data ?? []) m.set(e.code, [...(m.get(e.code) ?? []), e]);
  return m;
}

function near(iso: string | null, expectedMs: number, msg: string, slackMs = 120_000) {
  assert(iso, `${msg}: no timestamp`);
  const delta = Math.abs(new Date(iso!).getTime() - expectedMs);
  assert(delta < slackMs, `${msg}: ${iso} is ${Math.round(delta / 1000)}s from expected`);
}

/** a fresh, well-capitalized 1900s capital position (never the latest) */
async function freshPosition(key: string): Promise<string> {
  const date = await freshDate("capital_position", (d) => `cap_${d.replace(/-/g, "")}`);
  const r = await api("POST", "/capital/positions", {
    as_of_date: date, net_worth_cents: 750_000_000, total_assets_cents: 5_000_000_000,
  }, { key });
  assertEq(r.status, 201, `position (${body(r)})`);
  return String(r.body.data.id);
}

async function deletePositions(ids: string[]) {
  if (!ids.length) return;
  const r = await core().from("capital_position").delete().in("id", ids);
  if (r.error) console.error(`cleanup capital_position ${ids.join(",")}: ${r.error.message}`);
}

async function activeSchedule(): Promise<Any | null> {
  const r = await core().from("rwa_schedule").select("*").is("superseded_at", null)
    .order("rwa_schedule_version", { ascending: false });
  assert(!r.error, `rwa_schedule read: ${r.error?.message}`);
  return (r.data ?? [])[0] ?? null;
}

// ------------------------------------------------------- BA-04 schedule

flow("basel: the CFO adopts a risk-weight schedule change under stated authority → the RWA run reads the new version → the prior version is retained", async (t) => {
  const cfo = await actor("pynthia_ops");
  const partner = await actor("partner");
  const snap = await core().from("rwa_schedule").select("*");
  assert(!snap.error, `snapshot: ${snap.error?.message}`);
  const before: Any[] = snap.data ?? [];
  const created: string[] = [];
  try {
    const prior = await activeSchedule();
    const maxVersion = Math.max(0, ...before.map((r) => r.rwa_schedule_version));
    const changed = { ...(prior?.rwa_risk_weight_map ?? {}), consumer: 50 };
    let newId = "";

    await t.step("a partner cannot reach the schedule (404); no schedule changes", async () => {
      const r = await api("POST", "/basel/rwa-schedules", { risk_weight_map: changed, approved_by: "cfo_flow", change_authority: "x" }, { key: partner });
      assertEq(r.status, 404, `partner (${body(r)})`);
      assertEq((await activeSchedule())?.id, prior?.id, "active schedule unchanged");
    });

    await t.step("a schedule without weights or an approver is refused", async () => {
      const r = await api("POST", "/basel/rwa-schedules", { risk_weight_map: changed }, { key: cfo });
      assertEq(r.status, 400, `no approver (${body(r)})`);
    });

    await t.step("BA-04: a reweighting without the authority for the change is refused; the schedule is untouched", async () => {
      const r = await api("POST", "/basel/rwa-schedules", { risk_weight_map: changed, approved_by: "cfo_flow" }, { key: cfo });
      assertEq(r.status, 400, `no change_authority (${body(r)})`);
      assert(JSON.stringify(r.body).includes("change_authority"), "the missing authority is named");
      const now = await activeSchedule();
      assertEq(now?.id, prior?.id, "same active schedule");
      assertEq(JSON.stringify(now?.rwa_risk_weight_map), JSON.stringify(prior?.rwa_risk_weight_map), "weights untouched");
      assertEq(now?.superseded_at, null, "not superseded");
    });

    await t.step("BA-04: with the authority the change is a NEW version; the prior version is superseded, not overwritten", async () => {
      // DEFECT: postRwaSchedule numbers the new version as (count of
      // UNSUPERSEDED rows)+1 — always 2 once v1 is superseded — so it upserts
      // over rwasched_v2 in place: the prior weights are lost and its
      // rwa.schedule_version event id already exists (the new one is dropped).
      const r = await api("POST", "/basel/rwa-schedules", {
        risk_weight_map: changed, approved_by: "cfo_flow",
        change_authority: "flow: NCUA final rule (test)",
      }, { key: cfo });
      assertEq(r.status, 201, `adopt (${body(r)})`);
      newId = String(r.body.data.id);
      if (!before.some((b) => b.id === newId)) created.push(newId);
      assertEq(r.body.data.version, maxVersion + 1, "next version number");
      const fresh = await row("rwa_schedule", newId);
      assertEq(fresh.rwa_risk_weight_map?.consumer, 50, "new weights stored");
      assertEq(fresh.rwa_change_authority, "flow: NCUA final rule (test)", "authority recorded");
      assertEq(fresh.superseded_at, null, "new version active");
      if (prior) {
        const old = await row("rwa_schedule", prior.id);
        assert(old.superseded_at, "prior version superseded");
        assertEq(JSON.stringify(old.rwa_risk_weight_map), JSON.stringify(prior.rwa_risk_weight_map), "prior weights retained — last quarter stays reproducible");
      }
      const ev = await events("rwa_schedule", newId);
      assertEq(ev.get("rwa.schedule_version")?.[0]?.payload?.["rwa.change_authority"], "flow: NCUA final rule (test)", "schedule_version event for THIS change");
    });

    await t.step("BA-03: the RWA run reads the VERSIONED schedule — consumer at 50%, and the run names the schedule", async () => {
      const pos = await freshPosition(cfo);
      try {
        const r = await api("POST", `/capital/positions/${pos}/rwa`, { exposures: [{ class: "consumer", amount_cents: 100_000_000 }] }, { key: cfo });
        assertEq(r.status, 200, `rwa (${body(r)})`);
        assertEq(r.body.data.risk_weighted_assets_cents, 50_000_000, "weighted from the schedule, not the hardcoded 100%");
        const p = await row("capital_position", pos);
        assertEq(p.risk_weighted_assets_cents, 50_000_000, "stored on the position");
        assertEq(p.rwa_schedule_id, newId, "position names the schedule version it used");
      } finally {
        await deletePositions([pos]);
      }
    });
  } finally {
    // restore every row exactly as it was; remove any version this flow added
    for (const b of before) {
      const u = await core().from("rwa_schedule").upsert(b, { onConflict: "id" });
      if (u.error) console.error(`restore rwa_schedule ${b.id}: ${u.error.message}`);
    }
    const keep = new Set(before.map((b) => b.id));
    const after = await core().from("rwa_schedule").select("id");
    const extra = (after.data ?? []).map((r: Any) => r.id).filter((id: string) => !keep.has(id));
    if (extra.length) {
      const d = await core().from("rwa_schedule").delete().in("id", extra);
      if (d.error) console.error(`remove added rwa_schedule ${extra}: ${d.error.message}`);
    }
  }
});

// -------------------------------------------------------- BA-03 three legs

flow("basel: RWA run on a quarter — unmapped classes surfaced, market charge only above the trading threshold, total is all three legs", async (t) => {
  const cfo = await actor("pynthia_ops");
  const partner = await actor("partner");
  const sched = await activeSchedule();
  const weights: Record<string, number> = sched?.rwa_risk_weight_map ?? {
    cash: 0, sovereign: 0, gse: 20, municipal: 50, residential_mortgage: 50,
    consumer: 100, commercial: 100, past_due: 150, equity: 300,
  };
  let pos = "";
  try {
    await t.step("record the quarter; a partner cannot run RWA on it; an unknown position is 404", async () => {
      pos = await freshPosition(cfo);
      const p = await api("POST", `/capital/positions/${pos}/rwa`, { exposures: [] }, { key: partner });
      assertEq(p.status, 404, `partner (${body(p)})`);
      const u = await api("POST", `/capital/positions/cap_00010101/rwa`, { exposures: [] }, { key: cfo });
      assertEq(u.status, 404, `unknown position (${body(u)})`);
      assertEq((await row("capital_position", pos)).risk_weighted_assets_cents, null, "no RWA written");
    });

    await t.step("BA-03/04: a class with no published weight is SURFACED, never weighted at zero; below the threshold there is no market charge", async () => {
      const exposures = [
        { class: "consumer", amount_cents: 1_000_000 },
        { class: "gse", amount_cents: 1_000_000 },
        { class: "crypto_flow", amount_cents: 5_000_000 },
      ];
      const credit = exposures.reduce((n, e) => weights[e.class] === undefined ? n : n + Math.floor(e.amount_cents * weights[e.class] / 100), 0);
      const r = await api("POST", `/capital/positions/${pos}/rwa`, {
        exposures, trading_book_cents: TRADING_BOOK_THRESHOLD_CENTS - 1,
      }, { key: cfo });
      assertEq(r.status, 200, `rwa (${body(r)})`);
      const d = r.body.data;
      assertEq(d.risk_weighted_assets_cents, credit, "credit RWA from the active schedule");
      assertEq(JSON.stringify(d.unmapped_exposure_classes), JSON.stringify(["crypto_flow"]), "unmapped class named");
      assertEq(d.rwa_complete, false, "RWA marked incomplete");
      assertEq(d.trading_threshold_crossed, false, "below the threshold");
      const p = await row("capital_position", pos);
      assertEq(p.rwa_market_cents, 0, "no market charge");
      assertEq(p.trading_threshold_crossed, false, "verdict recorded");
      assertEq(p.trading_threshold_cents, TRADING_BOOK_THRESHOLD_CENTS, "threshold recorded beside it");
      assertEq(JSON.stringify(p.unmapped_exposures), JSON.stringify(["crypto_flow"]), "unmapped stored on the position");
      assertEq(p.rwa_schedule_id, sched?.id ?? null, "schedule version named");
      const ce = await core().from("event").select("code").eq("resource_id", `capital:${pos}`);
      const codes = (ce.data ?? []).map((e: Any) => e.code);
      for (const c of ["rwa.mapping_run.started", "rwa.weights.applied", "rwa.credit_calculated", "rwa.market_calculated", "rwa.operational_calculated", "capital.rwa_total"]) {
        assert(codes.includes(c), `${c}`);
      }
      assert(!codes.includes("rwa.trading_threshold_crossed"), "no threshold-crossed event");
    });

    await t.step("BA-03: at the trading threshold the market charge applies; operational risk at alpha 15%; total = all three legs", async () => {
      const w = weights.consumer;
      const credit = w === undefined ? 0 : Math.floor(100_000_000 * w / 100);
      const op = Math.floor(20_000_000 * BASIC_INDICATOR_ALPHA_BP / 10000);
      const r = await api("POST", `/capital/positions/${pos}/rwa`, {
        exposures: [{ class: "consumer", amount_cents: 100_000_000 }],
        trading_book_cents: TRADING_BOOK_THRESHOLD_CENTS, gross_income_cents: 20_000_000,
      }, { key: cfo });
      assertEq(r.status, 200, `rwa (${body(r)})`);
      assertEq(r.body.data.trading_threshold_crossed, true, "crossed at exactly the threshold");
      assertEq(r.body.data.rwa_complete, w !== undefined, "complete when every class is mapped");
      const p = await row("capital_position", pos);
      assertEq(p.rwa_market_cents, TRADING_BOOK_THRESHOLD_CENTS, "market leg");
      assertEq(p.rwa_operational_cents, op, "operational leg");
      assertEq(p.capital_rwa_total_cents, credit + TRADING_BOOK_THRESHOLD_CENTS + op, "total of three legs");
      assertEq(r.body.data.rwa_total_cents, p.capital_rwa_total_cents, "response agrees with the row");
      const ce = await core().from("event").select("code, payload").eq("resource_id", `capital:${pos}`)
        .eq("code", "rwa.trading_threshold_crossed");
      assertEq((ce.data ?? []).length, 1, "rwa.trading_threshold_crossed emitted");
    });
  } finally {
    await deletePositions(pos ? [pos] : []);
  }
});

// ------------------------------------------------------------- BA-06 buffers

flow("basel: capital buffer — no CCyB means no payout verdict; with a CCyB the payout ladder tightens as the shortfall deepens", async (t) => {
  const cfo = await actor("pynthia_ops");
  const partner = await actor("partner");
  const bufId = (d: string) => `capbuf_${d}`;
  const post = (key: string, o: Record<string, unknown>) => api("POST", "/basel/buffers", o, { key });

  await t.step("a partner gets 404; a buffer with no requirement is refused", async () => {
    const d = await freshDate("capital_buffer", bufId);
    const p = await post(partner, { as_of_date: d, cet1_ratio_bp: 900, requirement_bp: 1050 });
    assertEq(p.status, 404, `partner (${body(p)})`);
    const m = await post(cfo, { as_of_date: d, cet1_ratio_bp: 900 });
    assertEq(m.status, 400, `no requirement (${body(m)})`);
    assertEq(await row("capital_buffer", bufId(d)), null, "nothing stored");
  });

  await t.step("breached with NO configured CCyB: no payout cap and no distribution verdict — not 'unrestricted'", async () => {
    const d = await freshDate("capital_buffer", bufId);
    const r = await post(cfo, { as_of_date: d, cet1_ratio_bp: 900, requirement_bp: 1050 });
    assertEq(r.status, 201, `buffer (${body(r)})`);
    const b = await row("capital_buffer", bufId(d));
    assertEq(b.capital_buffer_status, "breached", "breached");
    assertEq(b.capital_buffer_shortfall_bp, 150, "shortfall");
    assertEq(b.capital_max_payout_ratio_bp, null, "no payout cap");
    assertEq(b.distribution_permitted, null, "no verdict");
    const ev = await events("capital_buffer", bufId(d));
    assertEq(ev.get("capital.buffer_status.recorded")?.[0]?.payload?.verdict, "unassessed", "verdict unassessed");
    assert(ev.has("capital.buffer.breached"), "buffer.breached");
    assert(!ev.has("capital.distribution_restriction.applied"), "no restriction claimed");
    assert(!ev.has("capital.max_payout_ratio"), "no payout ratio claimed");
  });

  await t.step("with a 1% CCyB, 150bp short of 1050: payout capped at 60%, restriction applied, credit growth flagged", async () => {
    const d = await freshDate("capital_buffer", bufId);
    const r = await post(cfo, {
      as_of_date: d, cet1_ratio_bp: 900, requirement_bp: 1050, ccyb_level_bp: 100,
      proposed_distribution_amount_cents: 500_000, loan_growth_yoy_bp: 1800,
    });
    assertEq(r.status, 201, `buffer (${body(r)})`);
    assertEq(r.body.data.max_payout_ratio_bp, 6000, "first quartile → 60%");
    const b = await row("capital_buffer", bufId(d));
    assertEq(b.capital_max_payout_ratio_bp, 6000, "cap stored");
    assertEq(b.distribution_permitted, true, "a 60% cap still permits the proposed distribution");
    const ev = await events("capital_buffer", bufId(d));
    for (const c of ["capital.ccyb_level", "capital.ccyb.activated", "capital.max_payout_ratio", "capital.buffer.breached", "capital.distribution_restriction.applied", "capital.credit_growth_threshold_crossed"]) {
      assert(ev.has(c), `${c}`);
    }
  });

  await t.step("the ladder tightens: 450bp short → 40%; 750bp short → 20%; fully through the buffer → 0% and the distribution is NOT permitted; met → 100%", async () => {
    for (const [cet1, cap, permitted, status] of [[600, 4000, true, "breached"], [300, 2000, true, "breached"], [0, 0, false, "breached"], [1100, 10000, true, "met"]] as const) {
      const d = await freshDate("capital_buffer", bufId);
      const r = await post(cfo, {
        as_of_date: d, cet1_ratio_bp: cet1, requirement_bp: 1050, ccyb_level_bp: 100,
        proposed_distribution_amount_cents: 500_000,
      });
      assertEq(r.status, 201, `buffer cet1=${cet1} (${body(r)})`);
      const b = await row("capital_buffer", bufId(d));
      assertEq(b.capital_max_payout_ratio_bp, cap, `cap at cet1=${cet1}`);
      assertEq(b.distribution_permitted, permitted, `permitted at cet1=${cet1}`);
      assertEq(b.capital_buffer_status, status, `status at cet1=${cet1}`);
      const ev = await events("capital_buffer", bufId(d));
      assertEq(ev.has("capital.distribution_restriction.applied"), status === "breached", `restriction event at cet1=${cet1}`);
    }
  });
});

// ------------------------------------------------------------- BA-05 CFP

flow("basel: contingency funding plan — a level above normal must already name its liquidation hierarchy", async (t) => {
  const cfo = await actor("pynthia_ops");
  const partner = await actor("partner");
  const cfpId = (d: string) => `cfpprof_${d}`;

  await t.step("a partner gets 404; 'stress' with no liquidation hierarchy is refused and nothing is stored", async () => {
    const d = await freshDate("cfp_liquidity_profile", cfpId);
    const p = await api("POST", "/basel/cfp-profiles", { as_of_date: d, cfp_level: "normal", gl_total_shares_cents: 1, hqla_cents: 1 }, { key: partner });
    assertEq(p.status, 404, `partner (${body(p)})`);
    const r = await api("POST", "/basel/cfp-profiles", { as_of_date: d, cfp_level: "stress", gl_total_shares_cents: 1, hqla_cents: 1 }, { key: cfo });
    assertEq(r.status, 400, `no hierarchy (${body(r)})`);
    assert(JSON.stringify(r.body).includes("liquidation_hierarchy"), "the missing hierarchy is named");
    assertEq(await row("cfp_liquidity_profile", cfpId(d)), null, "nothing stored");
  });

  await t.step("'normal' needs no hierarchy: profile logged with HQLA/shares at 10%, no transition", async () => {
    const d = await freshDate("cfp_liquidity_profile", cfpId);
    const r = await api("POST", "/basel/cfp-profiles", {
      as_of_date: d, cfp_level: "normal", gl_total_shares_cents: 35_000_000_000, hqla_cents: 3_500_000_000,
    }, { key: cfo });
    assertEq(r.status, 201, `normal (${body(r)})`);
    const c = await row("cfp_liquidity_profile", cfpId(d));
    assertEq(c.liquidity_ratio_to_shares_bp, 1000, "ratio");
    assertEq(c.cfp_level, "normal", "level");
    near(c.cfp_investment_test_due_at, Date.now() + 365 * DAY, "annual investment test clock", 300_000);
    const ev = await events("cfp_liquidity_profile", cfpId(d));
    assert(ev.has("liquidity.report") && ev.has("cfp.level"), "liquidity.report + cfp.level");
    assert(!ev.has("cfp.transition.started"), "no transition at normal");
  });

  await t.step("moving to 'stress' WITH a pre-decided hierarchy: stored, and the transition is recorded", async () => {
    const d = await freshDate("cfp_liquidity_profile", cfpId);
    const hierarchy = ["treasuries", "agency", "loan participations"];
    const r = await api("POST", "/basel/cfp-profiles", {
      as_of_date: d, cfp_level: "stress", gl_total_shares_cents: 35_000_000_000, hqla_cents: 2_000_000_000,
      liquidation_hierarchy: hierarchy, investment_test_completed: true,
    }, { key: cfo });
    assertEq(r.status, 201, `stress (${body(r)})`);
    const c = await row("cfp_liquidity_profile", cfpId(d));
    assertEq(JSON.stringify(c.cfp_liquidation_hierarchy), JSON.stringify(hierarchy), "hierarchy stored");
    assert(c.cfp_investment_test_completed_at, "investment test completion stamped");
    const ev = await events("cfp_liquidity_profile", cfpId(d));
    assertEq(ev.get("cfp.transition.started")?.[0]?.payload?.["cfp.level"], "stress", "transition to stress");
    assert(ev.has("cfp.investment_test.completed"), "investment test completed");
  });
});

// ------------------------------------------------------------- BA-08 Pillar 3

flow("basel: Pillar 3 disclosure — published only with board minutes; a shortfall period escalates to the board", async (t) => {
  const admin = await actor("cu_admin");
  const partner = await actor("partner");
  const period = `flow${Date.now().toString(36)}`;

  await t.step("a partner cannot publish; a disclosure without board minutes is refused", async () => {
    const p = await api("POST", "/basel/pillar3", { period, board_minutes_ref: "bm_1" }, { key: partner });
    assert([403, 404].includes(p.status), `partner refused (${p.status} ${body(p)})`);
    const r = await api("POST", "/basel/pillar3", { period }, { key: admin });
    assertEq(r.status, 400, `no minutes (${body(r)})`);
    assertEq(await row("pillar3_disclosure", `pillar3_${period}`), null, "nothing published");
  });

  await t.step("published with minutes: the due clock, the publication and the minutes are one record", async () => {
    const at = Date.now();
    const r = await api("POST", "/basel/pillar3", { period, board_minutes_ref: "bm_flow_q" }, { key: admin });
    assertEq(r.status, 201, `publish (${body(r)})`);
    const d = await row("pillar3_disclosure", `pillar3_${period}`);
    assertEq(d.board_minutes_ref, "bm_flow_q", "minutes ref");
    assert(d.published_at, "published");
    near(d.due_at, at + 45 * DAY, "45-day due clock");
    const ev = await events("pillar3_disclosure", `pillar3_${period}`);
    for (const c of ["disclosure.pillar3_due_at", "disclosure.pillar3.published", "board.minutes.recorded"]) assert(ev.has(c), c);
    assert(!ev.has("board.shortfall.notified"), "no shortfall claimed");
  });

  await t.step("a shortfall period: the board is notified and the capital escalation is issued", async () => {
    const sp = `${period}s`;
    const r = await api("POST", "/basel/pillar3", { period: sp, board_minutes_ref: "bm_flow_s", shortfall: true }, { key: admin });
    assertEq(r.status, 201, `publish (${body(r)})`);
    const ev = await events("pillar3_disclosure", `pillar3_${sp}`);
    assert(ev.has("board.shortfall.notified"), "board.shortfall.notified");
    assertEq(ev.get("capital.board_escalation.issued")?.[0]?.payload?.cause, "capital_shortfall", "escalation issued");
  });
});

// ------------------------------------------------------- BC-05/11/13 BCP

flow("bcp: sev1 incident → IC clock → comms on the primary → platform fails, backup activated → media needs the CEO → PIR → close → corrective actions retested", async (t) => {
  const ic = await actor("pynthia_ops");
  const partner = await actor("partner");
  const snap = await core().from("comms_tree").select("*").eq("id", "commstree").maybeSingle();
  assert(!snap.error, `comms_tree snapshot: ${snap.error?.message}`);
  const tree = { ic: ["ceo_flow", "cfo_flow"], tier2: ["ops_flow"] };
  let inc = "";
  let firstIssued = "";
  const pir = () => `pir_${inc}`;
  try {
    await t.step("BC-05: declare a sev1 on the secondary rotation — the IC assignment carries a 15-minute CLOCK", async () => {
      const at = Date.now();
      const r = await api("POST", "/incidents", { title: "flow: core API outage", severity: "sev1", source: "siem", ic_rotation: "secondary" }, { key: ic });
      assertEq(r.status, 201, `declare (${body(r)})`);
      inc = String(r.body.id);
      const i = await row("incident", inc);
      near(i.ic_assignment_due_at, at + 15 * 60_000, "IC assignment due in 15 minutes");
      assertEq(i.oncall_ic_rotation, "secondary", "rotation recorded");
      const ev = await events("incident", inc);
      assertEq(ev.get("incident.ic_assignment_timer")?.[0]?.payload?.["oncall.ic_rotation"], "secondary", "timer names the rotation");
      assert(ev.has("incident.sev1.detected"), "sev1 detected");
    });

    await t.step("a partner cannot reach the BCP routes (404)", async () => {
      const a = await api("POST", "/bcp/comms-tree", { contact_tree: tree, primary: "email", backup: "sms" }, { key: partner });
      assertEq(a.status, 404, `partner comms-tree (${body(a)})`);
      const b = await api("POST", `/bcp/incidents/${inc}/comms`, {}, { key: partner });
      assertEq(b.status, 404, `partner comms (${body(b)})`);
    });

    await t.step("BC-11: a backup channel identical to the primary is refused; the tree is untouched", async () => {
      const r = await api("POST", "/bcp/comms-tree", { contact_tree: tree, primary: "email", backup: "email" }, { key: ic });
      assertEq(r.status, 400, `same backup (${body(r)})`);
      const now = await row("comms_tree", "commstree");
      assertEq(JSON.stringify(now?.comms_contact_tree), JSON.stringify(snap.data?.comms_contact_tree), "tree unchanged");
    });

    await t.step("configure the tree: email primary, SMS backup", async () => {
      const r = await api("POST", "/bcp/comms-tree", { contact_tree: tree, stakeholder_matrix: { members: "website" }, primary: "email", backup: "sms" }, { key: ic });
      assertEq(r.status, 201, `tree (${body(r)})`);
      const now = await row("comms_tree", "commstree");
      assertEq(JSON.stringify(now.comms_contact_tree), JSON.stringify(tree), "tree stored");
      assertEq(now.backup_channel, "sms", "backup");
    });

    await t.step("comms for an incident that does not exist is 404, not a silent success", async () => {
      // DEFECT: postIncidentComms never checks the incident exists — it
      // updates zero rows, emits comms events against the unknown id, and 201s.
      const ghost = `inc_flow_ghost_${crypto.randomUUID()}`;
      const r = await api("POST", `/bcp/incidents/${ghost}/comms`, {}, { key: ic });
      assertEq(r.status, 404, `comms on unknown incident (${body(r)})`);
      assertEq((await events("incident", ghost)).size, 0, "no evidence against a nonexistent incident");
    });

    await t.step("initial comms go out on the PRIMARY: alert + initial issued, the tree in the evidence", async () => {
      const r = await api("POST", `/bcp/incidents/${inc}/comms`, { holding_statement: "We are investigating." }, { key: ic });
      assertEq(r.status, 201, `comms (${body(r)})`);
      assertEq(r.body.data.channel, "email", "primary channel");
      const i = await row("incident", inc);
      assert(i.comms_initial_issued_at, "initial issuance stamped");
      firstIssued = i.comms_initial_issued_at;
      const ev = await events("incident", inc);
      assertEq(JSON.stringify(ev.get("comms.initial.issued")?.[0]?.payload?.["comms.contact_tree"]), JSON.stringify(tree), "evidence carries the tree used");
      assert(ev.has("comms.internal_alert.issued"), "internal alert");
      assert(!ev.has("comms.backup.activated"), "no failover yet");
    });

    await t.step("BC-11: the comms platform fails — the next message goes on the BACKUP and the failover is its own fact", async () => {
      const r = await api("POST", `/bcp/incidents/${inc}/comms`, { platform_failed: true }, { key: ic });
      assertEq(r.status, 201, `failover (${body(r)})`);
      assertEq(r.body.data.channel, "sms", "backup channel");
      const ev = await events("incident", inc);
      const b = ev.get("comms.backup.activated")?.[0];
      assert(b, "comms.backup.activated");
      assertEq(b.payload?.primary, "email", "names the primary that failed");
      assertEq(b.payload?.channel, "sms", "and the backup used");
    });

    await t.step("BC-11: a media response without CEO approval is refused — 409, no media response logged", async () => {
      const r = await api("POST", `/bcp/incidents/${inc}/comms`, { media_inquiry: true }, { key: ic });
      assertEq(r.status, 409, `unapproved media (${body(r)})`);
      assertEq(r.body.type, "media_response_unapproved", "typed refusal");
      assert(!(await events("incident", inc)).has("comms.media_response.logged"), "no media response");
    });

    await t.step("the initial-issuance time is the FIRST issuance — later messages and a refused request do not rewrite it", async () => {
      // DEFECT: postIncidentComms sets comms_initial_issued_at = now() on EVERY
      // call (before the media 409, too), so the BC-05 first-comms clock reads
      // the latest message, never the first.
      const i = await row("incident", inc);
      assertEq(new Date(i.comms_initial_issued_at).getTime(), new Date(firstIssued).getTime(), "initial issuance unchanged");
    });

    await t.step("with the CEO's approval the media response is logged", async () => {
      const r = await api("POST", `/bcp/incidents/${inc}/comms`, { media_inquiry: true, ceo_approval: "ceo_flow" }, { key: ic });
      assertEq(r.status, 201, `approved media (${body(r)})`);
      assertEq((await events("incident", inc)).get("comms.media_response.logged")?.[0]?.payload?.["comms.ceo_approval"], "ceo_flow", "media response names the approver");
    });

    await t.step("BC-13: a PIR with no root cause is refused; a PIR for a nonexistent incident is 404", async () => {
      const r = await api("POST", `/bcp/incidents/${inc}/pir`, { impact_summary: "1,400 members" }, { key: ic });
      assertEq(r.status, 400, `no root cause (${body(r)})`);
      assertEq(await row("pir", pir()), null, "no PIR stored");
      // DEFECT: postPir never checks the incident exists (pir.incident_id has
      // no FK) — a review of an incident nobody declared is stored and 201s.
      const ghost = `inc_flow_ghost_${crypto.randomUUID()}`;
      const g = await api("POST", `/bcp/incidents/${ghost}/pir`, { root_cause: "x", timeline: [{ at: "11:00Z" }] }, { key: ic });
      assertEq(g.status, 404, `PIR for unknown incident (${body(g)})`);
      assertEq(await row("pir", `pir_${ghost}`), null, "no orphan PIR");
    });

    await t.step("the PIR is drafted with root cause and timeline: 5-day draft clock, pir.drafted", async () => {
      const at = Date.now();
      const r = await api("POST", `/bcp/incidents/${inc}/pir`, {
        root_cause: "unrate-limited login endpoint", timeline: [{ at: "11:00Z", what: "first failed logins" }],
        impact_summary: "1,400 members",
      }, { key: ic });
      assertEq(r.status, 201, `PIR (${body(r)})`);
      const p = await row("pir", pir());
      assertEq(p.incident_id, inc, "PIR names the incident");
      assert(p.drafted_at, "drafted");
      near(p.draft_due_at, at + 5 * DAY, "5-day draft clock");
      const ev = await events("pir", pir());
      assert(ev.has("pir.draft_timer") && ev.has("pir.drafted"), "pir.draft_timer + pir.drafted");
    });

    await t.step("closing the incident with a drafted PIR records the postmortem as completed", async () => {
      const r = await api("POST", `/incidents/${inc}/close`, {}, { key: ic });
      assertEq(r.status, 200, `close (${body(r)})`);
      assertEq((await row("incident", inc)).status, "closed", "closed");
      const ev = await events("incident", inc);
      assertEq(ev.get("incident.postmortem.completed")?.[0]?.payload?.["incident.root_cause"], "unrate-limited login endpoint", "postmortem carries the root cause");
    });

    await t.step("corrective actions: unknown PIR 404; an action needs an owner", async () => {
      const u = await api("POST", `/bcp/pirs/pir_flow_nope_${crypto.randomUUID()}/actions`, { description: "x", owner: "y" }, { key: ic });
      assertEq(u.status, 404, `unknown PIR (${body(u)})`);
      const o = await api("POST", `/bcp/pirs/${pir()}/actions`, { key: "noowner", description: "require MFA" }, { key: ic });
      assertEq(o.status, 400, `no owner (${body(o)})`);
      assertEq(await row("corrective_action", `cap_${pir()}_noowner`), null, "nothing stored");
    });

    await t.step("BC-13: 'completed' is the owner's opinion — approved and marked done, but NOT retested", async () => {
      const at = Date.now();
      const r = await api("POST", `/bcp/pirs/${pir()}/actions`, {
        key: "mfa", description: "require MFA on password reset", owner: "eng_2", approved_by: "ciso_flow", completed: true,
      }, { key: ic });
      assertEq(r.status, 201, `action (${body(r)})`);
      assertEq(r.body.data.retested, false, "not retested");
      const a = await row("corrective_action", `cap_${pir()}_mfa`);
      assert(a.completed_at, "marked complete");
      assertEq(a.retest_verified_at, null, "nobody knows whether it worked");
      assertEq(a.approved_by, "ciso_flow", "approver");
      near(a.approval_due_at, at + 10 * DAY, "10-day approval clock");
      const ev = await events("corrective_action", `cap_${pir()}_mfa`);
      for (const c of ["cap.item.created", "cap.approval.timer", "cap.approved", "cap.item.completed"]) assert(ev.has(c), c);
      assert(!ev.has("cap.retest.verified"), "no retest claimed");
    });

    await t.step("BC-13: the RETEST is the evidence — a retested action is verified with its result", async () => {
      const r = await api("POST", `/bcp/pirs/${pir()}/actions`, {
        key: "ratelimit", description: "rate-limit the login endpoint", owner: "eng_1",
        approved_by: "ciso_flow", retest_result: "429 after 5 attempts",
      }, { key: ic });
      assertEq(r.status, 201, `retested action (${body(r)})`);
      const a = await row("corrective_action", `cap_${pir()}_ratelimit`);
      assert(a.retest_verified_at && a.completed_at, "retested implies completed");
      assertEq(a.retest_result, "429 after 5 attempts", "result kept");
      const ev = await events("corrective_action", `cap_${pir()}_ratelimit`);
      assertEq(ev.get("cap.retest.verified")?.[0]?.payload?.result, "429 after 5 attempts", "cap.retest.verified");
    });
  } finally {
    // the ghost-incident PIR exists only while the DEFECT above stands
    await core().from("pir").delete().like("id", "pir_inc_flow_ghost_%");
    if (snap.data) {
      const u = await core().from("comms_tree").upsert(snap.data, { onConflict: "id" });
      if (u.error) console.error(`restore comms_tree: ${u.error.message}`);
    }
  }
});
