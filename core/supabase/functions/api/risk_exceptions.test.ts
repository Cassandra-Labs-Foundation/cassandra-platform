// Risk breaches, acceptances and control overrides — ERM-06, ERM-07, IC-06.
//
// The load-bearing negatives: a KRI inside appetite (which must still record
// that the check ran), a risk with no owner, an acceptance with no expiry or
// one whose warning window has already passed, an owner granting their own
// acceptance, and an exception that expires without the control coming back on.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { makeDrillDb } from "../drill/fake_db.ts";
import { OPS_CTX, req } from "./test_helpers.ts";
import {
  ACCEPTANCE_DECISION_DAYS,
  EXPIRY_ALERT_DAYS,
  postControlException,
  postControlExceptionSweep,
  postControlOverride,
  postOverrideAnalytics,
  postRiskAcceptance,
  postRiskAcceptanceDecision,
  postRiskAcceptanceSweep,
  postRiskBreachPresentation,
  postRiskObservation,
  putRisk,
  putRiskAppetite,
  severityFor,
} from "./risk_exceptions.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const CTX = OPS_CTX;
const codes = (rows: Record<string, Any[]>) =>
  (rows["core.event"] ?? []).map((e) => String(e.code));

async function seedAppetite() {
  const dbx = makeDrillDb();
  const db = dbx.client;
  await putRisk(
    req({
      title: "Consumer credit deterioration", taxonomy_category_code: "credit",
      owner_id: "cro_1", residual_rating: "moderate",
      remediation_evidence: "tightening-2026",
    }),
    "risk_1", db, "t", CTX,
  );
  await putRiskAppetite(
    req({
      risk_id: "risk_1", taxonomy_category_code: "credit", kri_name: "delinquency_pct",
      tolerance_value: 300, direction: "above", owner_id: "cro_1",
      document_ref: "appetite-2026", approved_by: "board-1",
    }),
    "rapp_1", db, "t", CTX,
  );
  return { dbx, db };
}

// ------------------------------------------------------------ ERM-06 breaches

Deno.test("ERM-06: a risk with no OWNER is refused — the register exists to prevent that", async () => {
  const dbx = makeDrillDb();
  const res = await putRisk(
    req({ title: "Unowned", taxonomy_category_code: "ops" }), "r_x", dbx.client, "t", CTX,
  );
  assertEquals(res.status, 400);
  assertEquals((dbx.rows["core.risk"] ?? []).length, 0);
});

Deno.test("ERM-06: a KRI INSIDE appetite records that the check ran and opens nothing", async () => {
  const { dbx, db } = await seedAppetite();
  await postRiskObservation(req({ appetite_id: "rapp_1", kri_value: 180 }), db, "t", CTX);
  assertEquals((dbx.rows["core.risk_breach"] ?? []).length, 0);
  assert(!codes(dbx.rows).includes("risk_breach.opened"));
  // "measured and within tolerance" must not look like "never measured"
  assert(codes(dbx.rows).includes("risk.within_appetite"));
});

Deno.test("ERM-06: direction matters — 'below' tolerance breaches on a LOW value", async () => {
  const { db, dbx } = await seedAppetite();
  await putRiskAppetite(
    req({
      taxonomy_category_code: "liquidity", kri_name: "coverage", tolerance_value: 100,
      direction: "below", owner_id: "cro_1", document_ref: "d", approved_by: "b",
    }),
    "rapp_liq", db, "t", CTX,
  );
  await postRiskObservation(req({ appetite_id: "rapp_liq", kri_value: 50 }), db, "t", CTX);
  assertEquals(dbx.rows["core.risk_breach"].length, 1);
  // and a HIGH value on a 'below' appetite is fine
  await postRiskObservation(req({ appetite_id: "rapp_liq", kri_value: 150 }), db, "t", CTX);
  assertEquals(dbx.rows["core.risk_breach"].length, 1);
});

Deno.test("ERM-06: severity comes from the SIZE of the excursion", () => {
  assertEquals(severityFor(10, 300), "low");
  assertEquals(severityFor(70, 300), "moderate");
  assertEquals(severityFor(160, 300), "high");
  assertEquals(severityFor(400, 300), "critical");
});

Deno.test("ERM-06: only a high or critical excursion notifies the CRO", async () => {
  const { dbx, db } = await seedAppetite();
  // 310 against a 300 tolerance is a 10/300 excursion — low
  await postRiskObservation(req({ appetite_id: "rapp_1", kri_value: 310 }), db, "t", CTX);
  assert(codes(dbx.rows).includes("risk_breach.opened"));
  assert(
    !codes(dbx.rows).includes("risk_breach.cro.notified"),
    "notifying on every breach makes the notification meaningless",
  );

  const s2 = await seedAppetite();
  await postRiskObservation(req({ appetite_id: "rapp_1", kri_value: 700 }), s2.db, "t", CTX);
  assertEquals(s2.dbx.rows["core.risk_breach"][0].severity, "critical");
  assert(codes(s2.dbx.rows).includes("risk_breach.cro.notified"));
});

Deno.test("ERM-06: a breach presented with no remediation plan is refused", async () => {
  const { dbx, db } = await seedAppetite();
  await postRiskObservation(req({ appetite_id: "rapp_1", kri_value: 700 }), db, "t", CTX);
  const id = String(dbx.rows["core.risk_breach"][0].id);
  assertEquals((await postRiskBreachPresentation(req({}), id, db, "t", CTX)).status, 400);
  assertEquals(dbx.rows["core.risk_breach"][0].committee_presented_at, null);
});

Deno.test("ERM-06: late presentation is recorded as late", async () => {
  const { dbx, db } = await seedAppetite();
  await postRiskObservation(req({ appetite_id: "rapp_1", kri_value: 700 }), db, "t", CTX);
  const id = String(dbx.rows["core.risk_breach"][0].id);
  dbx.rows["core.risk_breach"][0].committee_due_at = "2020-01-01T00:00:00.000Z";
  await postRiskBreachPresentation(req({ remediation_plan: "p" }), id, db, "t", CTX);
  const ev = (dbx.rows["core.event"] ?? []).find((e) =>
    e.code === "risk_breach.committee.presented"
  );
  assertEquals((ev!.payload as Any).presented_late, true);
});

// --------------------------------------------------------- ERM-07 acceptances

Deno.test("ERM-07: an acceptance with NO EXPIRY is refused", async () => {
  const { dbx, db } = await seedAppetite();
  const res = await postRiskAcceptance(
    req({ risk_id: "risk_1", owner_id: "cro_1", rationale: "seasonal" }), db, "t", CTX,
  );
  assertEquals(res.status, 400);
  assertEquals((dbx.rows["core.risk_acceptance"] ?? []).length, 0);
});

Deno.test("ERM-07: an expiry too soon to be revisited is refused", async () => {
  const { db } = await seedAppetite();
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const res = await postRiskAcceptance(
    req({ risk_id: "risk_1", owner_id: "cro_1", rationale: "r", expiry_date: soon }),
    db, "t", CTX,
  );
  assertEquals(res.status, 409);
  assertEquals(EXPIRY_ALERT_DAYS, 30);
});

// Updated 2026-10-06: decisions are role-gated to the CCO and attributed to
// the credential. This stub used to decide with a role-less ops token and read
// the typed decided_by as the decider — the defect itself.
const CCO_CTX = { ...CTX, tokenId: "tok_cco_test", roles: ["cco" as const] };

Deno.test("ERM-07: only a CCO credential decides; the owner cannot grant their own acceptance", async () => {
  const { dbx, db } = await seedAppetite();
  const far = new Date(Date.now() + 200 * 86_400_000).toISOString();
  await postRiskAcceptance(
    req({ risk_id: "risk_1", owner_id: "cro_1", rationale: "r", expiry_date: far }),
    db, "t", CTX,
  );
  const id = String(dbx.rows["core.risk_acceptance"][0].id);
  const noRole = await postRiskAcceptanceDecision(
    req({ decision: "accepted", decided_by: "board_chair" }), id, db, "t", CTX,
  );
  assertEquals(noRole.status, 403);
  assertEquals((await noRole.json()).type, "insufficient_role");
  assertEquals(
    (await postRiskAcceptanceDecision(
      req({ decision: "accepted", decided_by: "cro_1" }), id, db, "t", CCO_CTX,
    )).status,
    409,
  );
  assertEquals(dbx.rows["core.risk_acceptance"][0].decision, null);
  assertEquals(
    (await postRiskAcceptanceDecision(
      req({ decision: "accepted", decided_by: "board_chair" }), id, db, "t", CCO_CTX,
    )).status,
    200,
  );
  const a = dbx.rows["core.risk_acceptance"][0];
  assertEquals(a.decided_by, "tok_cco_test", "the decider is the credential");
  assertEquals(a.decided_by_label, "board_chair", "the typed name is only a label");
  assertEquals(dbx.violations, []);
});

Deno.test("ERM-07: the credential that requested an acceptance cannot decide it, even as CCO", async () => {
  const { dbx, db } = await seedAppetite();
  const far = new Date(Date.now() + 200 * 86_400_000).toISOString();
  await postRiskAcceptance(
    req({ risk_id: "risk_1", owner_id: "cro_1", rationale: "r", expiry_date: far }),
    db, "t", CCO_CTX,
  );
  const id = String(dbx.rows["core.risk_acceptance"][0].id);
  const res = await postRiskAcceptanceDecision(
    req({ decision: "accepted", decided_by: "someone_else" }), id, db, "t", CCO_CTX,
  );
  assertEquals(res.status, 409);
  assertEquals(dbx.rows["core.risk_acceptance"][0].decision, null);
});

Deno.test("ERM-07: the sweep WARNS before expiry, then EXPIRES and re-opens the breach", async () => {
  const { dbx, db } = await seedAppetite();
  const far = new Date(Date.now() + 200 * 86_400_000).toISOString();
  await postRiskAcceptance(
    req({ risk_id: "risk_1", owner_id: "cro_1", rationale: "r", expiry_date: far }),
    db, "t", CTX,
  );
  const a = dbx.rows["core.risk_acceptance"][0];

  // nothing yet — the warning window has not opened
  await postRiskAcceptanceSweep(req({}), db, "t", CTX);
  assert(!codes(dbx.rows).includes("risk_acceptance.expiry_alerted"));

  a.expiry_alert_at = "2020-01-01T00:00:00.000Z";
  await postRiskAcceptanceSweep(req({}), db, "t", CTX);
  assert(codes(dbx.rows).includes("risk_acceptance.expiry_alerted"));
  assertEquals(dbx.rows["core.risk_acceptance"][0].expired_at, null);

  a.expiry_date = "2020-01-02T00:00:00.000Z";
  await postRiskAcceptanceSweep(req({}), db, "t", CTX);
  assert(dbx.rows["core.risk_acceptance"][0].expired_at);
  // the risk did not go away when the paperwork did
  assert(codes(dbx.rows).includes("risk_breach.opened"));
});

Deno.test("ERM-07: the sweep touches every row it examines", async () => {
  const { dbx, db } = await seedAppetite();
  const far = new Date(Date.now() + 200 * 86_400_000).toISOString();
  for (const n of [1, 2]) {
    await postRiskAcceptance(
      req({ risk_id: `risk_${n}`, owner_id: "cro_1", rationale: "r", expiry_date: far }),
      db, "t", CTX,
    );
  }
  dbx.rows["core.risk_acceptance"][0].expiry_alert_at = "2020-01-01T00:00:00.000Z";
  const SENTINEL = "1999-01-01T00:00:00.000Z";
  for (const r of dbx.rows["core.risk_acceptance"]) r.updated_at = SENTINEL;

  await postRiskAcceptanceSweep(req({}), db, "t", CTX);
  assertEquals(
    dbx.rows["core.risk_acceptance"].filter((r) => r.updated_at === SENTINEL).length,
    0,
    "a bounded sweep that skips rows starves its tail",
  );
});

Deno.test("ERM-07: the decision is due 30 calendar days from the request", async () => {
  const { dbx, db } = await seedAppetite();
  const far = new Date(Date.now() + 200 * 86_400_000).toISOString();
  await postRiskAcceptance(
    req({ risk_id: "risk_1", owner_id: "cro_1", rationale: "r", expiry_date: far }),
    db, "t", CTX,
  );
  const a = dbx.rows["core.risk_acceptance"][0];
  const days = Math.round(
    (Date.parse(a.decision_due_at) - Date.parse(a.requested_at)) / 86_400_000,
  );
  assertEquals(days, ACCEPTANCE_DECISION_DAYS);
  assertEquals(days, 30);
});

Deno.test("ERM-07: the 30-day alert and the 7-day warning fire at their OWN thresholds, each once", async () => {
  const { dbx, db } = await seedAppetite();
  const far = new Date(Date.now() + 200 * 86_400_000).toISOString();
  await postRiskAcceptance(
    req({ risk_id: "risk_1", owner_id: "cro_1", rationale: "r", expiry_date: far }),
    db, "t", CTX,
  );
  const a = dbx.rows["core.risk_acceptance"][0];
  const count = (c: string) => codes(dbx.rows).filter((x) => x === c).length;

  // 20 days out: the 30-day alert, and NOT the 7-day warning
  a.expiry_alert_at = "2020-01-01T00:00:00.000Z";
  a.expiry_date = new Date(Date.now() + 20 * 86_400_000).toISOString();
  await postRiskAcceptanceSweep(req({}), db, "t", CTX);
  await postRiskAcceptanceSweep(req({}), db, "t", CTX);
  assertEquals(count("risk_acceptance.expiry_alerted"), 1);
  assertEquals(count("risk_acceptance.expiry.warning"), 0, "the 7-day warning is not due 20 days out");

  // 5 days out: the 7-day warning and its escalation, once
  a.expiry_date = new Date(Date.now() + 5 * 86_400_000).toISOString();
  await postRiskAcceptanceSweep(req({}), db, "t", CTX);
  await postRiskAcceptanceSweep(req({}), db, "t", CTX);
  assertEquals(count("risk_acceptance.expiry.warning"), 1);
  assertEquals(count("risk_acceptance.expiry_alerted"), 2, "the 30-day alert plus the 7-day escalation");
  assert(dbx.rows["core.risk_acceptance"][0].expiry_warned_at, "expiry_warned_at stamped");
  assertEquals(dbx.violations, []);
});

Deno.test("ERM-07: a lapsed acceptance creates ONE breach RECORD for its risk, copying the covered breach", async () => {
  const { dbx, db } = await seedAppetite();
  await postRiskObservation(req({ appetite_id: "rapp_1", kri_value: 500 }), db, "t", CTX);
  const prior = dbx.rows["core.risk_breach"][0];
  const far = new Date(Date.now() + 200 * 86_400_000).toISOString();
  await postRiskAcceptance(
    req({ risk_id: "risk_1", breach_id: prior.id, owner_id: "cro_1", rationale: "r", expiry_date: far }),
    db, "t", CTX,
  );
  const a = dbx.rows["core.risk_acceptance"][0];
  a.expiry_alert_at = "2020-01-01T00:00:00.000Z";
  a.expiry_date = "2020-01-02T00:00:00.000Z";
  await postRiskAcceptanceSweep(req({}), db, "t", CTX);
  a.expired_at = null; // even a re-run over the same lapse must not open a second breach
  await postRiskAcceptanceSweep(req({}), db, "t", CTX);
  const lapses = dbx.rows["core.risk_breach"].filter((b) => b.risk_acceptance_id === a.id);
  assertEquals(lapses.length, 1, "one breach record per lapsed acceptance");
  assertEquals(lapses[0].appetite_id, "rapp_1");
  assertEquals(lapses[0].risk_id, "risk_1");
  assertEquals(lapses[0].severity, prior.severity);
  assertEquals(lapses[0].current_excursion, prior.current_excursion);
  const opened = (dbx.rows["core.event"] ?? []).find((e) => e.code === "risk_breach.opened" &&
    (e.payload as Any).reason === "risk_acceptance_expired");
  assertEquals((opened!.payload as Any)["risk_breach.id"], lapses[0].id, "the event names the record");
  assertEquals(dbx.violations, []);
});

// ------------------------------------------------------------ IC-06 overrides

/** IC-06 exceptions need a risk acceptance behind them. */
async function withAcceptance() {
  const { dbx, db } = await seedAppetite();
  const far = new Date(Date.now() + 200 * 86_400_000).toISOString();
  await postRiskAcceptance(
    req({ risk_id: "risk_1", owner_id: "cro_1", rationale: "r", expiry_date: far }),
    db, "t", CTX,
  );
  return { dbx, acc: String(dbx.rows["core.risk_acceptance"][0].id) };
}

Deno.test("IC-06: an override with no rationale is refused", async () => {
  const dbx = makeDrillDb();
  const res = await postControlOverride(
    req({ control_id: "CG-VEL-01", subject_ref: "t1", actor_ref: "ops_1" }),
    dbx.client, "t", CTX,
  );
  assertEquals(res.status, 400);
  assertEquals((dbx.rows["core.control_override"] ?? []).length, 0);
});

Deno.test("IC-06: an override registers its actor as a system principal", async () => {
  const dbx = makeDrillDb();
  await postControlOverride(
    req({ control_id: "C1", subject_ref: "t1", actor_ref: "ops_1", rationale: "verified" }),
    dbx.client, "t", CTX,
  );
  assertEquals(dbx.rows["core.user"][0].id, "ops_1");
  assert(codes(dbx.rows).includes("override.recorded"));
});

Deno.test("IC-06: an exception cannot be self-approved and must be time-boxed", async () => {
  const { dbx, acc } = await withAcceptance();
  const far = new Date(Date.now() + 100 * 86_400_000).toISOString();
  assertEquals(
    (await postControlException(
      req({
        control_id: "C1", scope: "s", rationale: "r",
        approver_id: "a", registered_by: "a", expires_at: far, risk_acceptance_id: acc,
      }),
      dbx.client, "t", CTX,
    )).status,
    409,
  );
  assertEquals(
    (await postControlException(
      req({ control_id: "C1", scope: "s", rationale: "r", approver_id: "a", registered_by: "b", risk_acceptance_id: acc }),
      dbx.client, "t", CTX,
    )).status,
    400,
  );
  assertEquals((dbx.rows["core.control_exception"] ?? []).length, 0);
});

Deno.test("IC-06: an expired exception REVERTS — the control comes back on", async () => {
  const { dbx, acc } = await withAcceptance();
  const far = new Date(Date.now() + 100 * 86_400_000).toISOString();
  await postControlException(
    req({
      control_id: "C1", scope: "s", rationale: "r",
      approver_id: "cco", registered_by: "ops_1", expires_at: far, risk_acceptance_id: acc,
    }),
    dbx.client, "t", CTX,
  );
  await postControlExceptionSweep(req({}), dbx.client, "t", CTX);
  assertEquals(dbx.rows["core.control_exception"][0].reverted_at, null);

  dbx.rows["core.control_exception"][0].expires_at = "2020-01-01T00:00:00.000Z";
  await postControlExceptionSweep(req({}), dbx.client, "t", CTX);
  assert(
    dbx.rows["core.control_exception"][0].reverted_at,
    "an expiry that only alerts leaves the control off indefinitely",
  );
  assert(codes(dbx.rows).includes("exception.reverted"));
});

Deno.test("IC-06: an exception inside the warning window is flagged as expiring", async () => {
  const { dbx, acc } = await withAcceptance();
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
  await postControlException(
    req({
      control_id: "C1", scope: "s", rationale: "r",
      approver_id: "cco", registered_by: "ops_1", expires_at: soon, risk_acceptance_id: acc,
    }),
    dbx.client, "t", CTX,
  );
  await postControlExceptionSweep(req({}), dbx.client, "t", CTX);
  assert(codes(dbx.rows).includes("exception.expiring"));
});

Deno.test("IC-06: a standing exception must reference a risk acceptance (400), and a real one (404)", async () => {
  const { dbx, acc } = await withAcceptance();
  const far = new Date(Date.now() + 100 * 86_400_000).toISOString();
  const base = { control_id: "C1", scope: "s", rationale: "r", approver_id: "cco", registered_by: "ops_1", expires_at: far };
  const none = await postControlException(req(base), dbx.client, "t", CTX);
  assertEquals(none.status, 400);
  assert(JSON.stringify(await none.json()).includes("risk_acceptance_id"));
  const unknown = await postControlException(
    req({ ...base, risk_acceptance_id: "racc_nope" }), dbx.client, "t", CTX,
  );
  assertEquals(unknown.status, 404);
  assertEquals((dbx.rows["core.control_exception"] ?? []).length, 0);
  const ok = await postControlException(req({ ...base, risk_acceptance_id: acc }), dbx.client, "t", CTX);
  assertEquals(ok.status, 201);
  assertEquals(dbx.rows["core.control_exception"][0].risk_acceptance_id, acc);
});

Deno.test("IC-06: the analytics NAME the repeatedly-overridden control", async () => {
  const dbx = makeDrillDb();
  for (const n of [1, 2, 3]) {
    await postControlOverride(
      req({ control_id: "CG-VEL-01", subject_ref: `t${n}`, actor_ref: "ops_1", rationale: "r" }),
      dbx.client, "t", CTX,
    );
  }
  await postControlOverride(
    req({ control_id: "CG-NSF-01", subject_ref: "t9", actor_ref: "ops_2", rationale: "r" }),
    dbx.client, "t", CTX,
  );
  await postOverrideAnalytics(req({ period: "q" }), dbx.client, "t", CTX);
  const ev = (dbx.rows["core.event"] ?? []).find((e) =>
    e.code === "override.analytics.published"
  );
  const repeated = (ev!.payload as Any).repeatedly_overridden as Any[];
  // the finding is REPETITION, named rather than left in a frequency table
  assertEquals(repeated.length, 1);
  assertEquals(repeated[0].control_id, "CG-VEL-01");
  assertEquals(repeated[0].count, 3);
});
