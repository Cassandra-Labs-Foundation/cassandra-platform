// Basel II and business continuity.
//
// The RWA tests are about ONE thing: the direction an error goes. Every mistake
// available in a risk-weight engine — an unmapped exposure defaulted to zero, a
// market charge skipped, an editable weight map — understates RWA, which
// overstates the capital ratio. There is no symmetric error. That is why the
// unmapped case refuses instead of warning.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { makeDrillDb } from "../drill/fake_db.ts";
import { OPS_CTX, req } from "./test_helpers.ts";
import {
  maxPayoutRatioBp, postCapitalBuffer, postCfpProfile, postCommsTree,
  postCorrectiveAction, postIncidentComms, postPir, postRwaSchedule,
} from "./basel.ts";
import { BASIC_INDICATOR_ALPHA_BP, postRwaRun, TRADING_BOOK_THRESHOLD_CENTS } from "./capital.ts";
import { postIncident } from "./incidents.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const CTX = OPS_CTX;
const codes = (rows: Record<string, Any[]>) =>
  (rows["core.event"] ?? []).map((e) => String(e.code));

function withPosition(dbx: Any) {
  dbx.rows["core.capital_position"] = [{
    id: "cap_1", as_of_date: "2026-03-31", net_worth_cents: 750_000_000,
    total_assets_cents: 5_000_000_000, net_worth_ratio_bp: 1500,
    pca_category: "well_capitalized", provenance: "production",
  }];
}

// ------------------------------------------------------------------ BA-04

Deno.test("BA-04: changing a statutory schedule needs the authority for the change", async () => {
  const dbx = makeDrillDb();
  await postRwaSchedule(
    req({ risk_weight_map: { sovereign: 0, consumer: 100 }, approved_by: "cfo" }),
    dbx.client, "t", CTX,
  );
  const res = await postRwaSchedule(
    req({ risk_weight_map: { sovereign: 0, consumer: 50 }, approved_by: "cfo" }),
    dbx.client, "t", CTX,
  );
  // A convenient reweighting improves every ratio at once, and without the
  // authority nobody can tell it from a rule change.
  assertEquals(res.status, 400);
  assertEquals(dbx.rows["core.rwa_schedule"].length, 1);
});

Deno.test("BA-04: schedules supersede rather than overwrite", async () => {
  const dbx = makeDrillDb();
  await postRwaSchedule(
    req({ risk_weight_map: { consumer: 100 }, approved_by: "cfo" }), dbx.client, "t", CTX,
  );
  await postRwaSchedule(
    req({
      risk_weight_map: { consumer: 75 }, approved_by: "cfo",
      change_authority: "NCUA final rule 2026-14",
    }),
    dbx.client, "t", CTX,
  );
  const rows = dbx.rows["core.rwa_schedule"];
  assertEquals(rows.length, 2, "a ratio computed last quarter has to stay reproducible");
  assert(rows.find((r) => r.rwa_schedule_version === 1)!.superseded_at !== null);
});

// ------------------------------------------------------------------ BA-03

Deno.test("BA-03: an unmapped exposure is surfaced, never weighted at zero", async () => {
  const dbx = makeDrillDb();
  withPosition(dbx);
  const res = await postRwaRun(
    req({
      exposures: [
        { class: "cash", amount_cents: 1_000_000 },
        { class: "crypto_exposure", amount_cents: 90_000_000 },
      ],
    }),
    "cap_1", dbx.client, "t", CTX,
  );
  const body = await res.json();
  // Zero is the direction that flatters the institution, and it is the only
  // direction this error goes.
  assertEquals(body.data.rwa_complete, false);
  assertEquals(body.data.unmapped_exposure_classes, ["crypto_exposure"]);
});

Deno.test("BA-03: the run reads the VERSIONED schedule when one is on file", async () => {
  const dbx = makeDrillDb();
  withPosition(dbx);
  await postRwaSchedule(
    req({ risk_weight_map: { consumer: 50 }, approved_by: "cfo" }), dbx.client, "t", CTX,
  );
  await postRwaRun(
    req({ exposures: [{ class: "consumer", amount_cents: 100_000_000 }] }),
    "cap_1", dbx.client, "t", CTX,
  );
  // 50 from the schedule, not the hardcoded 100.
  assertEquals(dbx.rows["core.capital_position"][0].risk_weighted_assets_cents, 50_000_000);
  assert(dbx.rows["core.capital_position"][0].rwa_schedule_id !== null);
});

Deno.test("BA-03: below the trading threshold the market charge does NOT apply", async () => {
  const dbx = makeDrillDb();
  withPosition(dbx);
  await postRwaRun(
    req({
      exposures: [{ class: "cash", amount_cents: 1 }],
      trading_book_cents: TRADING_BOOK_THRESHOLD_CENTS - 1,
    }),
    "cap_1", dbx.client, "t", CTX,
  );
  const p = dbx.rows["core.capital_position"][0];
  assertEquals(p.rwa_market_cents, 0);
  // "Zero because it does not apply" and "zero because nobody computed it" are
  // different facts, and the threshold on the row is what separates them.
  assertEquals(p.trading_threshold_crossed, false);
  assertEquals(p.trading_threshold_cents, TRADING_BOOK_THRESHOLD_CENTS);
  assert(!codes(dbx.rows).includes("rwa.trading_threshold_crossed"));
});

Deno.test("BA-03: above the threshold it applies, and the total is all three legs", async () => {
  const dbx = makeDrillDb();
  withPosition(dbx);
  await postRwaRun(
    req({
      exposures: [{ class: "consumer", amount_cents: 100_000_000 }],
      trading_book_cents: TRADING_BOOK_THRESHOLD_CENTS + 1,
      gross_income_cents: 20_000_000,
    }),
    "cap_1", dbx.client, "t", CTX,
  );
  const p = dbx.rows["core.capital_position"][0];
  const opRwa = Math.floor(20_000_000 * BASIC_INDICATOR_ALPHA_BP / 10000);
  assertEquals(p.rwa_operational_cents, opRwa);
  assertEquals(
    p.capital_rwa_total_cents,
    p.risk_weighted_assets_cents + p.rwa_market_cents + opRwa,
  );
  assert(codes(dbx.rows).includes("rwa.trading_threshold_crossed"));
});

// ------------------------------------------------------------------ BA-06

Deno.test("BA-06: no configured CCyB means NO payout cap and NO verdict", async () => {
  const dbx = makeDrillDb();
  await postCapitalBuffer(
    req({ as_of_date: "2026-06-30", cet1_ratio_bp: 900, requirement_bp: 1050 }),
    dbx.client, "t", CTX,
  );
  const b = dbx.rows["core.capital_buffer"][0];
  assertEquals(b.capital_buffer_status, "breached");
  // §5k: institutional threshold, nullable, paired. An unset CCyB must not
  // read as "distributions unrestricted".
  assertEquals(b.capital_max_payout_ratio_bp, null);
  assertEquals(b.distribution_permitted, null);
  assert(!codes(dbx.rows).includes("capital.distribution_restriction.applied"));
});

Deno.test("BA-06: the payout ladder tightens as the shortfall deepens", () => {
  assertEquals(maxPayoutRatioBp(0, 1000), 10000, "no shortfall, no cap");
  assertEquals(maxPayoutRatioBp(200, 1000), 6000);
  assertEquals(maxPayoutRatioBp(450, 1000), 4000);
  assertEquals(maxPayoutRatioBp(700, 1000), 2000);
  assertEquals(maxPayoutRatioBp(900, 1000), 0, "deep in the buffer, nothing goes out");
});

Deno.test("BA-06: with a CCyB the restriction is applied and recorded", async () => {
  const dbx = makeDrillDb();
  await postCapitalBuffer(
    req({
      as_of_date: "2026-06-30", cet1_ratio_bp: 900, requirement_bp: 1050,
      ccyb_level_bp: 100, proposed_distribution_amount_cents: 500_000,
      loan_growth_yoy_bp: 1800,
    }),
    dbx.client, "t", CTX,
  );
  const c = codes(dbx.rows);
  assert(c.includes("capital.ccyb.activated"));
  assert(c.includes("capital.max_payout_ratio"));
  assert(c.includes("capital.distribution_restriction.applied"));
  assert(c.includes("capital.credit_growth_threshold_crossed"));
});

// ------------------------------------------------------------------ BA-05

Deno.test("BA-05: a CFP above normal with no liquidation hierarchy is refused", async () => {
  const dbx = makeDrillDb();
  const res = await postCfpProfile(
    req({ as_of_date: "2026-06-30", cfp_level: "stress", gl_total_shares_cents: 1, hqla_cents: 1 }),
    dbx.client, "t", CTX,
  );
  // Deciding what to sell DURING the crisis is when the decision is worst.
  assertEquals(res.status, 400);
});

Deno.test("BA-05: normal needs no hierarchy and still logs the profile", async () => {
  const dbx = makeDrillDb();
  await postCfpProfile(
    req({
      as_of_date: "2026-06-30", cfp_level: "normal",
      gl_total_shares_cents: 350_000_000_00, hqla_cents: 35_000_000_00,
    }),
    dbx.client, "t", CTX,
  );
  assertEquals(dbx.rows["core.cfp_liquidity_profile"][0].liquidity_ratio_to_shares_bp, 1000);
  assert(codes(dbx.rows).includes("liquidity.report"));
  assert(!codes(dbx.rows).includes("cfp.transition.started"));
});

// ------------------------------------------------------------------ BC-11

Deno.test("BC-11: a backup channel identical to the primary is not a backup", async () => {
  const dbx = makeDrillDb();
  const res = await postCommsTree(
    req({ contact_tree: { ic: ["ceo"] }, primary: "email", backup: "email" }),
    dbx.client, "t", CTX,
  );
  // The comms platform fails during exactly the incidents that need it.
  assertEquals(res.status, 400);
});

Deno.test("BC-11: a platform failure activates the backup and says so", async () => {
  const dbx = makeDrillDb();
  const inc = await postIncident(
    req({ title: "t", severity: "sev1", source: "siem" }), dbx.client, "t", CTX,
  );
  const id = String((await inc.json()).id);
  await postCommsTree(
    req({ contact_tree: { ic: ["ceo"] }, primary: "email", backup: "sms" }),
    dbx.client, "t", CTX,
  );
  await postIncidentComms(req({ platform_failed: true }), id, dbx.client, "t", CTX);
  // "We communicated" and "we communicated on the backup because the primary
  // was down" are different facts; the PIR needs the second.
  assert(codes(dbx.rows).includes("comms.backup.activated"));
});

Deno.test("BC-11: a media response with no CEO approval is refused", async () => {
  const dbx = makeDrillDb();
  const inc = await postIncident(
    req({ title: "t", severity: "sev1" }), dbx.client, "t", CTX,
  );
  const id = String((await inc.json()).id);
  await postCommsTree(
    req({ contact_tree: { ic: ["ceo"] }, primary: "email", backup: "sms" }),
    dbx.client, "t", CTX,
  );
  const res = await postIncidentComms(req({ media_inquiry: true }), id, dbx.client, "t", CTX);
  assertEquals(res.status, 409, "the institution speaking without deciding to");
  assert(!codes(dbx.rows).includes("comms.media_response.logged"));
});

// ------------------------------------------------------------------ BC-05

Deno.test("BC-05: the IC assignment carries a CLOCK, not just a name", async () => {
  const dbx = makeDrillDb();
  const res = await postIncident(
    req({ title: "t", severity: "sev1", ic_rotation: "secondary" }), dbx.client, "t", CTX,
  );
  const id = String((await res.json()).id);
  const ev = (dbx.rows["core.event"] ?? [])
    .find((e) => e.code === "incident.ic_assignment_timer");
  // An incident whose commander was named four hours late was uncommanded for
  // four hours; only the timer makes that visible afterwards.
  assert(ev, "assignment without a deadline is not a control");
  assertEquals((ev!.payload as Any)["oncall.ic_rotation"], "secondary");
  assert(dbx.rows["core.incident"].find((i) => i.id === id)!.ic_assignment_due_at !== null);
});

// ------------------------------------------------------------------ BC-13

Deno.test("BC-13: a PIR drafted with no root cause is refused", async () => {
  const dbx = makeDrillDb();
  const res = await postPir(req({ impact_summary: "1400 members" }), "inc_1", dbx.client, "t", CTX);
  // A summary of what everyone already saw is not a review.
  assertEquals(res.status, 400);
});

Deno.test("BC-13: a PIR for an incident nobody declared is 404, and nothing is stored", async () => {
  const dbx = makeDrillDb();
  const res = await postPir(
    req({ root_cause: "x", timeline: [{ at: "11:00Z" }] }), "inc_ghost", dbx.client, "t", CTX,
  );
  assertEquals(res.status, 404);
  assertEquals((dbx.rows["core.pir"] ?? []).length, 0);
});

Deno.test("BC-11: comms on an unknown incident is 404; the initial issuance is the FIRST one", async () => {
  const dbx = makeDrillDb();
  await postCommsTree(
    req({ contact_tree: { ic: ["ceo"] }, primary: "email", backup: "sms" }),
    dbx.client, "t", CTX,
  );
  const ghost = await postIncidentComms(req({}), "inc_ghost", dbx.client, "t", CTX);
  assertEquals(ghost.status, 404);
  assertEquals(codes(dbx.rows).filter((c) => c.startsWith("comms.")).length, 0);

  const inc = await postIncident(req({ title: "t", severity: "sev1" }), dbx.client, "t", CTX);
  const id = String((await inc.json()).id);
  await postIncidentComms(req({}), id, dbx.client, "t", CTX);
  const first = dbx.rows["core.incident"].find((i) => i.id === id)!.comms_initial_issued_at;
  assert(first);
  await new Promise((r) => setTimeout(r, 5));
  const refused = await postIncidentComms(req({ media_inquiry: true }), id, dbx.client, "t", CTX);
  assertEquals(refused.status, 409);
  await postIncidentComms(req({ platform_failed: true }), id, dbx.client, "t", CTX);
  assertEquals(dbx.rows["core.incident"].find((i) => i.id === id)!.comms_initial_issued_at, first);
});

Deno.test("BA-04: a third version numbers past the superseded ones and never overwrites", async () => {
  const dbx = makeDrillDb();
  for (const [w, auth] of [[100, undefined], [75, "rule a"], [50, "rule b"]] as const) {
    const r = await postRwaSchedule(
      req({ risk_weight_map: { consumer: w }, approved_by: "cfo", change_authority: auth }),
      dbx.client, "t", CTX,
    );
    assertEquals(r.status, 201);
  }
  const rows = dbx.rows["core.rwa_schedule"];
  assertEquals(rows.map((r) => r.rwa_schedule_version).sort(), [1, 2, 3]);
  assertEquals(rows.find((r) => r.rwa_schedule_version === 2)!.rwa_risk_weight_map.consumer, 75);
  assertEquals(rows.filter((r) => r.superseded_at == null).map((r) => r.rwa_schedule_version), [3]);
});

Deno.test("BC-13: 'completed' is the owner's opinion; the RETEST is the evidence", async () => {
  const dbx = makeDrillDb();
  // a PIR reviews a DECLARED incident
  dbx.rows["core.incident"] = [{ id: "inc_1", title: "t", severity: "sev1", status: "open" }];
  await postPir(
    req({
      root_cause: "unrate-limited endpoint", timeline: [{ at: "11:00Z" }],
      impact_summary: "1400 members",
    }),
    "inc_1", dbx.client, "t", CTX,
  );
  // approved and marked complete, but never retested
  await postCorrectiveAction(
    req({ key: "mfa", description: "require MFA", owner: "eng_2", approved_by: "ciso", completed: true }),
    "pir_inc_1", dbx.client, "t", CTX,
  );
  const a = dbx.rows["core.corrective_action"][0];
  assert(a.completed_at !== null);
  assertEquals(a.retest_verified_at, null, "nobody knows whether it worked");
  assert(!codes(dbx.rows).includes("cap.retest.verified"));

  await postCorrectiveAction(
    req({
      key: "ratelimit", description: "rate-limit login", owner: "eng_1",
      approved_by: "ciso", retest_result: "429 after 5 attempts",
    }),
    "pir_inc_1", dbx.client, "t", CTX,
  );
  assert(codes(dbx.rows).includes("cap.retest.verified"));
});

Deno.test("a partner token cannot reach the basel routes", async () => {
  const dbx = makeDrillDb();
  const res = await postRwaSchedule(
    req({ risk_weight_map: {}, approved_by: "x" }), dbx.client, "t",
    { ...CTX, actorType: "partner" } as Any,
  );
  assertEquals(res.status, 404);
});
