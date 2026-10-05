// EVERY REGULATORY DEADLINE, PINNED TO ITS ANCHOR.
//
// WHY THIS FILE EXISTS. A test that asserts a DURATION cannot see a clock that
// silently re-anchors: if `due_at - anchor` is asserted to be 30 days, code that
// computed `now + 30 days` and ignored the anchor entirely passes. The interval
// is 30 days either way. Only an ABSOLUTE assertion distinguishes them.
//
// Found in the complaints artifact: the acknowledgement test compared
// `ack_due_at - received_at` and would have passed against a writer that reset
// the deadline of a complaint which had sat unopened in an inbox for a week.
// A sweep of the rest of the corpus then found the same weakness in the CDA and
// cash POLICY-LAPSE clocks, where it is worse — a policy adopted eleven months
// ago would record an expiry twelve months from today and could never lapse,
// so the control fails open.
//
// This corpus is full of deadline-driven controls (SAR, ECOA, NCUA, NWRP,
// Reg E, CTR, retention, CDD) and they share one failure mode, so they are
// pinned in one place with absolute dates rather than scattered as intervals.
//
// SECOND THING THIS FILE COVERS: `capital.ts`, `incidents.ts`, `audit.ts` and
// `eps_controls.ts` have NO dedicated unit tests — they were built in an earlier
// session and are green through the control-test harness alone. Their deadline
// anchors were unprotected entirely, which is how three of these mutations
// survived the first sweep.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { makeDrillDb } from "../drill/fake_db.ts";
import { OPS_CTX, req } from "./test_helpers.ts";
import { ECOA_NOTICE_DAYS, ecoaNoticeDueAt } from "./lending.ts";
import { expiresAt } from "./retention.ts";
import { CTR_FILING_DAYS, ctrDueAt } from "./cash.ts";
import { NCUA_NOTICE_HOURS, postDetermineReportability, postIncident } from "./incidents.ts";
import { NWRP_DAYS, postCapitalPosition } from "./capital.ts";
import { CREDIT_REANALYSIS_DAYS, postCreditFile } from "./investment.ts";
import { CDD_REFRESH_MONTHS, postCddProfile } from "./records_admin.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const CTX = OPS_CTX;
const COMPLIANCE: typeof OPS_CTX = { ...OPS_CTX, tokenId: "tok_c", roles: ["bsa_compliance"] };

// ------------------------------------------------------- pure anchor functions

Deno.test("ECOA: the notice clock is anchored on COMPLETION of the application", () => {
  // Reg B runs 30 days from the completed application, not from the decision
  // and not from when the notice was drafted.
  assertEquals(ecoaNoticeDueAt("2026-06-01T00:00:00.000Z"), "2026-07-01T00:00:00.000Z");
  assertEquals(ecoaNoticeDueAt("2020-01-01T00:00:00.000Z"), "2020-01-31T00:00:00.000Z");
  assertEquals(ECOA_NOTICE_DAYS, 30);
});

Deno.test("CTR: the filing clock is anchored on the BUSINESS DATE of the currency", () => {
  // 31 CFR 1010.306: 15 days from the transaction, not from when it was noticed.
  assertEquals(ctrDueAt("2026-07-10"), "2026-07-25T00:00:00.000Z");
  assertEquals(ctrDueAt("2019-01-01"), "2019-01-16T00:00:00.000Z");
  assertEquals(CTR_FILING_DAYS, 15);
});

Deno.test("retention: expiry is anchored on the record's own anchor date", () => {
  // A record whose anchor is 2014 expires on the 2014 schedule, whatever year
  // the calculation is run in.
  assertEquals(
    expiresAt("cip_identity", new Date("2014-01-01T00:00:00.000Z")),
    "2019-01-01T00:00:00.000Z",
  );
});

// ------------------------------------------------------------- writer clocks

Deno.test("NCUA: the 72h clock runs from the REPORTABILITY DETERMINATION", async () => {
  const dbx = makeDrillDb();
  const res = await postIncident(
    req({ title: "t", severity: "sev1", source: "siem" }), dbx.client, "d", CTX,
  );
  const id = String((await res.clone().json()).id);
  // backdate the DECLARATION — the clock must not run from it
  dbx.rows["core.incident"][0].declared_at = "2020-01-01T00:00:00.000Z";
  // determination requires a completed assessment (ck_incident_assessment_before_determination)
  dbx.rows["core.incident"][0].assessment_completed_at = new Date().toISOString();

  const before = Date.now();
  await postDetermineReportability(
    req({ is_reportable: true, rationale: "member data likely misused" }),
    id, dbx.client, "d", COMPLIANCE,
  );
  const due = new Date(String(dbx.rows["core.incident"][0].ncua_notice_due_at)).getTime();
  const determined = new Date(
    String(dbx.rows["core.incident"][0].reportability_determined_at),
  ).getTime();

  assertEquals(due - determined, NCUA_NOTICE_HOURS * 3_600_000);
  // and the anchor is the DETERMINATION, not the declaration six years earlier
  assert(determined >= before, "the determination time must be when it was determined");
  assert(
    due > new Date("2020-01-05T00:00:00.000Z").getTime(),
    "anchoring on declaration would put the deadline in 2020",
  );
});

Deno.test("NCUA: a NON-reportable determination sets no clock at all", async () => {
  const dbx = makeDrillDb();
  const res = await postIncident(
    req({ title: "t", severity: "sev2", source: "siem" }), dbx.client, "d", CTX,
  );
  const id = String((await res.clone().json()).id);
  dbx.rows["core.incident"][0].assessment_completed_at = new Date().toISOString();
  await postDetermineReportability(
    req({ is_reportable: false, rationale: "no member data involved" }),
    id, dbx.client, "d", COMPLIANCE,
  );
  assertEquals(dbx.rows["core.incident"][0].ncua_notice_due_at, null);
});

Deno.test("NWRP: the 45-day clock runs from the CLASSIFICATION, not the quarter end", async () => {
  const dbx = makeDrillDb();
  // as_of_date is six months in the past; the plan is still due 45 days from
  // the moment the institution was classified undercapitalized
  await postCapitalPosition(
    req({
      as_of_date: "2026-01-31", net_worth_cents: 5_000_000_00,
      total_assets_cents: 100_000_000_00,
    }),
    dbx.client, "d", CTX,
  );
  const p = dbx.rows["core.capital_position"][0];
  assertEquals(p.pca_category, "undercapitalized");
  const due = new Date(String(p.nwrp_due_at)).getTime();
  const created = new Date(String(p.created_at)).getTime();
  assertEquals(Math.round((due - created) / 86_400_000), NWRP_DAYS);
  // anchoring on as_of_date would have put it in March 2026
  assert(
    due > new Date("2026-06-01T00:00:00.000Z").getTime(),
    "the quarter-end date must not be the anchor",
  );
});

Deno.test("NWRP: a well-capitalized position starts no clock", async () => {
  const dbx = makeDrillDb();
  await postCapitalPosition(
    req({
      as_of_date: "2026-03-31", net_worth_cents: 10_000_000_00,
      total_assets_cents: 100_000_000_00,
    }),
    dbx.client, "d", CTX,
  );
  assertEquals(dbx.rows["core.capital_position"][0].nwrp_due_at, null);
});

Deno.test("credit file: re-analysis is due a year from APPROVAL", async () => {
  const dbx = makeDrillDb();
  await postCreditFile(
    req({
      issuer_ref: "us_gov", internal_rating: "AAA", analysis_ref: "a1", approved_by: "cio",
    }),
    dbx.client, "t", CTX,
  );
  const f = dbx.rows["core.credit_file"][0];
  const gap = new Date(String(f.reanalysis_due_at)).getTime() -
    new Date(String(f.approved_at)).getTime();
  assertEquals(Math.round(gap / 86_400_000), CREDIT_REANALYSIS_DAYS);
});

Deno.test("CDD: the refresh clock is anchored on the LAST REFRESH, not on the write", async () => {
  const dbx = makeDrillDb();
  await postCddProfile(
    req({
      id: "p1", entity_id: "e1", risk_tier: "high",
      last_refreshed_at: "2020-01-01T00:00:00.000Z",
    }),
    dbx.client, "t", CTX,
  );
  const p = dbx.rows["core.cdd_profile"][0];
  assertEquals(String(p.last_refreshed_at), "2020-01-01T00:00:00.000Z");
  // absolute: high risk is a 12-month cycle from 2020-01-01, so it is already
  // years overdue. Re-anchoring to `now` would make it due next year and the
  // profile would never read as stale.
  assertEquals(String(p.refresh_due_at), "2021-01-01T00:00:00.000Z");
  assertEquals(CDD_REFRESH_MONTHS.high, 12);
});
