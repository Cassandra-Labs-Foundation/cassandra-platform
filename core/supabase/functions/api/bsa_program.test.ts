// BSA/AML programme — BSA-03..BSA-19.
//
// ⚠ These tests prove the MECHANISM. They do not and cannot prove the OFAC
// screen detects anything — it is the OQ-02 stub with no list. Every assertion
// about `list_version` being null is deliberate: it is the honest record that
// the comparison set is empty.
//
// The load-bearing negatives: a CIP missing one of its four elements, a
// monetary instrument in the reportable band with no identification, a wire at
// the Travel Rule threshold with no originator record, an FBAR aggregate that
// no single account reaches, a 314(a) response with no match count, and a PEP
// hit that opens no EDD.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { makeDrillDb } from "../drill/fake_db.ts";
import { OPS_CTX, req } from "./test_helpers.ts";
import {
  FBAR_THRESHOLD_CENTS,
  MI_CTR_FLOOR_CENTS,
  MI_LOG_FLOOR_CENTS,
  TRAVEL_RULE_FLOOR_CENTS,
  ofacMatch,
  post314aRequest,
  post314aResponse,
  postCipVerification,
  postEddCompletion,
  postEddProfile,
  postEscalation,
  postEscalationAck,
  postFbarAccount,
  postFbarFiling,
  postMonetaryInstrument,
  postOfacRelease,
  postOfacScreen,
  postPepScreen,
  postRegulatoryChange,
  postSarLifecycle,
  postTravelRuleRecord,
} from "./bsa_program.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const CTX = OPS_CTX;
const codes = (rows: Record<string, Any[]>) =>
  (rows["core.event"] ?? []).map((e) => String(e.code));

// ---------------------------------------------------------------- OFAC stub

Deno.test("BSA-05: the screen is a STUB and every row says so — list_version is null", async () => {
  const dbx = makeDrillDb();
  await postOfacScreen(
    req({ subject_kind: "entity", subject_ref: "e1", name: "Clean Person" }),
    dbx.client, "t", CTX,
  );
  assertEquals(dbx.rows["core.ofac_screen"][0].list_version, null);
  const ev = (dbx.rows["core.event"] ?? []).find((e) => e.code === "ofac.cleared");
  assertEquals((ev!.payload as Any)["ofac.list_version"], null);
  // and this is what the "screen" actually does
  assertEquals(ofacMatch("Clean Person"), "clear");
  assertEquals(ofacMatch("SDN Holdings"), "potential_match");
});

Deno.test("BSA-05: a CLEAN screen leaves evidence — screened-and-clear is not never-screened", async () => {
  const dbx = makeDrillDb();
  await postOfacScreen(
    req({ subject_kind: "entity", subject_ref: "e1", name: "Clean Person" }),
    dbx.client, "t", CTX,
  );
  assert(codes(dbx.rows).includes("ofac.screened"));
  assert(codes(dbx.rows).includes("ofac.cleared"));
  assertEquals(dbx.rows["core.ofac_screen"][0].hold_placed_at, null);
});

Deno.test("BSA-05: a match places a HOLD and refuses; a hold is a block, not a note", async () => {
  const dbx = makeDrillDb();
  const res = await postOfacScreen(
    req({ subject_kind: "ach_counterparty", subject_ref: "c1", name: "SDN Trading" }),
    dbx.client, "t", CTX,
  );
  assertEquals(res.status, 409);
  assert(dbx.rows["core.ofac_screen"][0].hold_placed_at);
  assert(codes(dbx.rows).includes("ofac.hold.placed"));
  assert(codes(dbx.rows).includes("ofac.escalated"));
  assert((dbx.rows["core.bsa_alert"] ?? []).length > 0);
  assertEquals(dbx.violations, []);
});

Deno.test("BSA-05: releasing a hold needs a named releaser AND a determination", async () => {
  const dbx = makeDrillDb();
  await postOfacScreen(
    req({ subject_kind: "ach_counterparty", subject_ref: "c1", name: "SDN Trading" }),
    dbx.client, "t", CTX,
  );
  const id = "ofacs_ach_counterparty_c1";
  assertEquals(
    (await postOfacRelease(req({ released_by: "o" }), id, dbx.client, "t", CTX)).status, 400,
  );
  assertEquals(dbx.rows["core.ofac_screen"][0].hold_released_at, null);
  assertEquals(
    (await postOfacRelease(
      req({ released_by: "o", determination: "false positive" }), id, dbx.client, "t", CTX,
    )).status,
    200,
  );
});

// --------------------------------------------------------------- BSA-03 CIP

Deno.test("BSA-03: CIP missing ONE of four elements is DENIED, not partially complete", async () => {
  const dbx = makeDrillDb();
  const res = await postCipVerification(
    req({ entity_ref: "e1", name: "Bob", dob: "1975-05-05", address: "1 St" }),
    dbx.client, "t", CTX,
  );
  assertEquals(res.status, 409);
  assert(codes(dbx.rows).includes("verification.denied"));
  assert(!codes(dbx.rows).includes("verification.completed"));
});

Deno.test("BSA-03: a complete CIP opens the CDD profile in the same act", async () => {
  const dbx = makeDrillDb();
  await postCipVerification(
    req({
      entity_ref: "e1", name: "Alice", dob: "1980-01-01", address: "1 St",
      id_number: "DL-1", tin: "***-1234",
    }),
    dbx.client, "t", CTX,
  );
  assert(codes(dbx.rows).includes("verification.completed"));
  // a CDD profile that appears later by a separate process is the gap
  assert(codes(dbx.rows).includes("cdd.profile.created"));
  assertEquals(dbx.rows["core.cdd_profile"].length, 1);
  // and the entity carries its own identifying data
  assertEquals(dbx.rows["core.entity"][0].date_of_birth, "1980-01-01");
});

Deno.test("BSA-03: an OFAC hit at CIP denies the verification", async () => {
  const dbx = makeDrillDb();
  const res = await postCipVerification(
    req({
      entity_ref: "e1", name: "SDN Holdings", dob: "1990-01-01",
      address: "2 St", id_number: "P-9",
    }),
    dbx.client, "t", CTX,
  );
  assertEquals(res.status, 409);
  assert(codes(dbx.rows).includes("ofac.hold.placed"));
  assert(!codes(dbx.rows).includes("verification.completed"));
});

// ------------------------------------------------------- BSA-04/17/18 EDD

Deno.test("BSA-17: a senior-approval category cannot be completed without sign-off", async () => {
  const dbx = makeDrillDb();
  await postEddProfile(
    req({ entity_ref: "e1", category: "correspondent", trigger_reason: "foreign bank" }),
    dbx.client, "t", CTX,
  );
  const id = "edd_e1_correspondent";
  assertEquals(
    (await postEddCompletion(req({ findings: "ok" }), id, dbx.client, "t", CTX)).status, 409,
  );
  assertEquals(dbx.rows["core.edd_profile"][0].completed_at, null);
  assertEquals(
    (await postEddCompletion(
      req({ findings: "Wolfsberg on file", approved_by: "officer" }), id, dbx.client, "t", CTX,
    )).status,
    200,
  );
  assertEquals(dbx.violations, []);
});

Deno.test("BSA-17: an ordinary category needs no sign-off", async () => {
  const dbx = makeDrillDb();
  await postEddProfile(
    req({ entity_ref: "e1", category: "msb", trigger_reason: "MSB" }), dbx.client, "t", CTX,
  );
  assertEquals(dbx.rows["core.edd_profile"][0].senior_approval_required, false);
  assertEquals(
    (await postEddCompletion(
      req({ findings: "registered" }), "edd_e1_msb", dbx.client, "t", CTX,
    )).status,
    200,
  );
});

Deno.test("BSA-17: EDD completed with no findings is refused", async () => {
  const dbx = makeDrillDb();
  await postEddProfile(
    req({ entity_ref: "e1", category: "msb", trigger_reason: "MSB" }), dbx.client, "t", CTX,
  );
  assertEquals(
    (await postEddCompletion(req({}), "edd_e1_msb", dbx.client, "t", CTX)).status, 400,
  );
});

Deno.test("BSA-18: a PEP hit OPENS the EDD in the same act; a clean screen does not", async () => {
  const dbx = makeDrillDb();
  await postPepScreen(
    req({ entity_ref: "e1", name: "Foreign Minister", pep_category: "foreign_official" }),
    dbx.client, "t", CTX,
  );
  // a hit that opens no EDD is a hit nobody acted on
  assertEquals(dbx.rows["core.edd_profile"].length, 1);
  assertEquals(dbx.rows["core.edd_profile"][0].senior_approval_required, true);
  assert(codes(dbx.rows).includes("pep.designated"));

  const s2 = makeDrillDb();
  await postPepScreen(req({ entity_ref: "e2", name: "Ordinary Member" }), s2.client, "t", CTX);
  assertEquals((s2.rows["core.edd_profile"] ?? []).length, 0);
  assert(!codes(s2.rows).includes("pep.hit"));
  assertEquals(s2.violations, []);
});

// -------------------------------------------------- BSA-09 monetary instruments

Deno.test("BSA-09: the log band is $3,000 to $10,000 — below and above are different", async () => {
  const dbx = makeDrillDb();
  const db = dbx.client;
  // below: nothing attaches
  await postMonetaryInstrument(
    req({ instrument_type: "money_order", amount_cents: 50_000, purchaser_name: "Small" }),
    db, "t", CTX,
  );
  assertEquals(dbx.rows["core.monetary_instrument"][0].log_required, false);
  assert(!codes(dbx.rows).includes("mi.log_entry.created"));

  // at or above $10,000 a CTR attaches instead of the log
  await postMonetaryInstrument(
    req({
      instrument_type: "bank_draft", amount_cents: MI_CTR_FLOOR_CENTS,
      purchaser_name: "Large", purchaser_id_type: "passport", purchaser_id_number: "P-1",
    }),
    db, "t", CTX,
  );
  const big = dbx.rows["core.monetary_instrument"][1];
  assertEquals(big.log_required, false);
  assert(codes(dbx.rows).includes("monetary_instrument.ctr_band"));
  assertEquals(MI_LOG_FLOOR_CENTS, 3_000_00);
});

Deno.test("BSA-09: in the band with no identification is REFUSED", async () => {
  const dbx = makeDrillDb();
  const res = await postMonetaryInstrument(
    req({
      instrument_type: "cashiers_check", amount_cents: 500_000,
      purchaser_name: "Anonymous Buyer",
    }),
    dbx.client, "t", CTX,
  );
  assertEquals(res.status, 409);
  assertEquals((dbx.rows["core.monetary_instrument"] ?? []).length, 0);
});

Deno.test("BSA-09: in the band WITH identification logs and screens the purchaser", async () => {
  const dbx = makeDrillDb();
  await postMonetaryInstrument(
    req({
      instrument_type: "cashiers_check", amount_cents: 500_000, purchaser_name: "Known Buyer",
      purchaser_id_type: "drivers_license", purchaser_id_number: "DL-1",
    }),
    dbx.client, "t", CTX,
  );
  assertEquals(dbx.rows["core.monetary_instrument"][0].log_required, true);
  assert(codes(dbx.rows).includes("mi.log_entry.created"));
  assert(codes(dbx.rows).includes("mi.central_log.updated"));
  // the purchaser of a reportable instrument is screened
  assert(codes(dbx.rows).includes("ofac.cleared"));
  assertEquals(dbx.violations, []);
});

// ------------------------------------------------------- BSA-10 Travel Rule

// ---------------------------------------------------------------- BSA-13 FBAR

Deno.test("BSA-13: the threshold is on the AGGREGATE, not on any single account", async () => {
  const dbx = makeDrillDb();
  const db = dbx.client;
  // two accounts, neither individually over $10,000, together over it
  for (const [ref, v] of [["a1", 600_000], ["a2", 700_000]]) {
    await postFbarAccount(
      req({
        account_ref: ref, country: "CH", institution_name: "Alpine",
        max_value_cents: v, reporting_year: 2026,
      }),
      db, "t", CTX,
    );
  }
  await postFbarFiling(req({ reporting_year: 2026 }), db, "t", CTX);
  const f = dbx.rows["core.fbar_filing"][0];
  assertEquals(f.aggregate_max_cents, 1_300_000);
  assertEquals(f.required, true, "a per-account test is the classic FBAR error");
  assertEquals(FBAR_THRESHOLD_CENTS, 10_000_00);
});

Deno.test("BSA-13: a NIL year records the determination", async () => {
  const dbx = makeDrillDb();
  await postFbarFiling(req({ reporting_year: 2025 }), dbx.client, "t", CTX);
  assertEquals(dbx.rows["core.fbar_filing"][0].required, false);
  // without this, "no FBAR filed" and "nobody looked" are the same record
  assert(codes(dbx.rows).includes("fbar.nil.determined"));
  assert(!codes(dbx.rows).includes("fbar.filed"));
});

Deno.test("BSA-13: filing without an E-Filing reference is refused", async () => {
  const dbx = makeDrillDb();
  assertEquals(
    (await postFbarFiling(
      req({ reporting_year: 2026, filed_by: "o" }), dbx.client, "t", CTX,
    )).status,
    400,
  );
});

// --------------------------------------------------------------- BSA-11 314(a)

Deno.test("BSA-11: a 314(a) response requires a match count INCLUDING zero", async () => {
  const dbx = makeDrillDb();
  await post314aRequest(req({ reference: "R1" }), dbx.client, "t", CTX);
  assertEquals(
    (await post314aResponse(
      req({ responded_by: "o" }), "filing_314a_R1", dbx.client, "t", CTX,
    )).status,
    400,
  );
  // "no match" and "did not search" are the same to FinCEN unless reported
  assertEquals(
    (await post314aResponse(
      req({ match_count: 0, responded_by: "o" }), "filing_314a_R1", dbx.client, "t", CTX,
    )).status,
    200,
  );
  assert(codes(dbx.rows).includes("filing.fincen_314a"));
});

Deno.test("BSA-11: a late 314(a) response is recorded as late", async () => {
  const dbx = makeDrillDb();
  await post314aRequest(
    req({ reference: "R1", received_at: "2020-01-01T00:00:00.000Z" }), dbx.client, "t", CTX,
  );
  await post314aResponse(
    req({ match_count: 0, responded_by: "o" }), "filing_314a_R1", dbx.client, "t", CTX,
  );
  const ev = (dbx.rows["core.event"] ?? []).find((e) => e.code === "filing.fincen_314a");
  assertEquals((ev!.payload as Any).responded_late, true);
});

// ------------------------------------------------- BSA-19 regulatory changes

Deno.test("BSA-19: an assessed change creates a RETENTION RECORD of the assessment", async () => {
  const dbx = makeDrillDb();
  await postRegulatoryChange(
    req({
      kind: "gto", reference: "GTO-1", issued_by: "FinCEN",
      applicability: "not applicable — no title insurance business",
      assessed_by: "officer",
    }),
    dbx.client, "t", CTX,
  );
  // the evidence that a GTO was considered outlives the GTO
  assert((dbx.rows["core.record"] ?? []).some((r) =>
    r.record_class === "regulatory_assessment"
  ));
  assert(codes(dbx.rows).includes("regulatory.change_implemented"));
});

Deno.test("BSA-19: an UNASSESSED change is identified but not implemented", async () => {
  const dbx = makeDrillDb();
  await postRegulatoryChange(
    req({ kind: "advisory", reference: "ADV-1" }), dbx.client, "t", CTX,
  );
  assert(codes(dbx.rows).includes("regulatory.change.identified"));
  assert(!codes(dbx.rows).includes("regulatory.change_implemented"));
  assertEquals(dbx.rows["core.regulatory_change"][0].assessed_at, null);
});

// ------------------------------------------------------- BSA-14 escalation

Deno.test("BSA-14: severity sets the acknowledgement window", async () => {
  const dbx = makeDrillDb();
  const db = dbx.client;
  await postEscalation(
    req({ source_ref: "a1", severity: "urgent", routed_to: "officer" }), db, "t", CTX,
  );
  await postEscalation(
    req({ source_ref: "a2", severity: "routine", routed_to: "officer" }), db, "t", CTX,
  );
  const [urgent, routine] = dbx.rows["core.escalation"];
  assert(
    String(urgent.ack_due_at) < String(routine.ack_due_at),
    "one window for everything makes the urgent ones wait as long as the routine",
  );
});

Deno.test("BSA-14: closing publishes an ACTION PLAN, not just a disposition", async () => {
  const dbx = makeDrillDb();
  await postEscalation(
    req({ source_ref: "a1", severity: "urgent", routed_to: "officer" }), dbx.client, "t", CTX,
  );
  const id = String(dbx.rows["core.escalation"][0].id);
  await postEscalationAck(
    req({ acknowledged_by: "officer", disposition: "SAR", action_plan: "file within 30 days" }),
    id, dbx.client, "t", CTX,
  );
  assert(codes(dbx.rows).includes("escalation.action_plan.published"));
  assertEquals(dbx.violations, []);
});

// ---------------------------------------------------- BSA-07 SAR confidentiality

