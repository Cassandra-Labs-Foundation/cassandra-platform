// BSA case-management flows (BSA-06/07, OQ-08/09) and record retention
// (BSA-21 / SC-02), as the credit union's staff live them: real money movement
// raises a real alert, an investigator triages it, a DIFFERENT officer decides
// the SAR, and the evidence an examiner reads is checked on the rows themselves.
//
// Ported from core/supabase/tests/e2e/compliance_e2e.sh sections 35 and 36,
// plus the user-observable behaviour of the bsa.ts unit stubs
// (core/supabase/functions/api/bsa.test.ts — see ledger/bsa.md).
// onboard_transfer_large_txn.test.ts already proves the first escalation; these
// flows carry the chain on from there to the decision and its negatives.
//
// Corrections against the bash script:
//   * the partner acts with a real partner token, not the ops bootstrap key.
//   * the stale-alert and late-case negatives are produced by back-dating the
//     fixture's OWN rows through the service role (bash used psql), never by
//     touching anyone else's data.
//   * a record clocked by a test actor must be `demo`, not `production` (bash
//     expected production because it predates per-actor provenance).
import { actor, type Any, api, assert, assertEq, core, flow, personaName } from "./helpers.ts";

const OPENING = 5_000_000; // $50,000
const DAY = 86_400_000;

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);

/** the api_token id helpers.actor() derives from the plaintext it returns */
function tokenIdOf(plaintext: string, actorType: string): string {
  return `tok_test_${actorType}_${plaintext.slice("cass_test_".length, "cass_test_".length + 12)}`;
}

/** BSA-06's clock: N business days, weekends skipped (mirror of the spec rule) */
function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

/** a fresh member with a funded checking account, created by the partner */
async function onboard(partner: string, openingCents = OPENING): Promise<string> {
  const e = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1984-09-14",
    address: "400 Elm St, Springfield, IL 62701",
  }, { key: partner });
  assertEq(e.status, 201, `create entity (${body(e)})`);
  const a = await api("POST", "/accounts", {
    entity_id: e.body.id, account_type: "checking", opening_deposit_cents: openingCents,
  }, { key: partner });
  assertEq(a.status, 201, `open account (${body(a)})`);
  return String(a.body.id);
}

/** a book transfer over $10k → CG-LGTXN-01 → ctr_threshold alert; returns the alert id */
async function largeTransfer(partner: string, src: string, dst: string, cents: number): Promise<string> {
  const r = await api("POST", "/transfers", {
    source_account_id: src, destination_account_id: dst, amount_cents: cents,
    description: "flow: bsa trigger",
  }, { key: partner });
  assertEq(r.status, 201, `transfer (${body(r)})`);
  assertEq(r.body.status, "settled", "alert-only: the transfer still settles");
  return `alert_${r.body.id}_ctr_threshold`;
}

async function alertRow(id: string): Promise<Any> {
  const r = await core().from("bsa_alert")
    .select("id, status, event_id, triage_due_at, triaged_at, triage_outcome, case_id, provenance, created_at")
    .eq("id", id).maybeSingle();
  assert(!r.error, `bsa_alert read: ${r.error?.message}`);
  return r.data;
}

async function caseRow(id: string): Promise<Any> {
  const r = await core().from("case")
    .select("id, alert_id, status, opened_by, decided_by, decided_at, sar_decision, decision_rationale, " +
      "concurred_by, sar_decision_due_at, provenance, created_at")
    .eq("id", id).maybeSingle();
  assert(!r.error, `case read: ${r.error?.message}`);
  return r.data;
}

async function eventsFor(resourceId: string): Promise<Any[]> {
  const r = await core().from("event").select("id, code, payload, provenance, created_at")
    .eq("resource_id", resourceId);
  assert(!r.error, `event read: ${r.error?.message}`);
  return r.data ?? [];
}

async function eventById(id: string): Promise<Any> {
  const r = await core().from("event").select("id, code, resource_id, payload, provenance, created_at")
    .eq("id", id).maybeSingle();
  assert(!r.error, `event read: ${r.error?.message}`);
  return r.data;
}

// ---------------------------------------------------------------- flow 1

flow("bsa: alert → triage → case → SAR filed by a second officer (four-eyes, committee)", async (t) => {
  let partner = "";
  let src = "";
  let dst = "";
  let alertId = "";
  let caseId = "";
  // the opener holds BOTH duty roles: what must stop them is having opened it
  let opener = "";
  let officer = "";
  let investigatorOnly = "";
  let compliance = "";
  let counsel = "";

  await t.step("fixtures: a partner onboards two members; staff are minted per duty", async () => {
    partner = await actor("partner");
    src = await onboard(partner);
    dst = await onboard(partner);
    opener = await actor("cu_admin", ["bsa_investigator", "bsa_officer"]);
    officer = await actor("cu_admin", ["bsa_officer"]);
    investigatorOnly = await actor("cu_admin", ["bsa_investigator"]);
    compliance = await actor("cu_admin", ["bsa_compliance"]);
    counsel = await actor("cu_admin", ["bsa_counsel"]);
  });

  await t.step("a $12k transfer raises an alert whose causing event was written first (OQ-05)", async () => {
    alertId = await largeTransfer(partner, src, dst, 1_200_000);
    const a = await alertRow(alertId);
    assert(a, `alert ${alertId} raised with a deterministic id`);
    assertEq(a.status, "open", "alert status");
    assertEq(a.event_id, `evt_${alertId}`, "event_id populated, pointing at the causing event");
    const ev = await eventById(a.event_id);
    assert(ev, "the causing event row exists (the FK target)");
    assertEq(ev.code, "bsa_alert.created", "the causing event is BSA-06's declared trigger");
    assert(Date.parse(ev.created_at) <= Date.parse(a.created_at), "event written BEFORE the alert");
    const timer = await eventById(`evt_${alertId}_triage_timer`);
    assertEq(timer?.code, "bsa_alert.triage.timer", "the triage clock starting is its own event");
    assertEq(a.provenance, "demo", "alert raised under a test partner is stamped demo, never unknown");
  });

  await t.step("the 2-business-day triage clock started at creation and never lands on a weekend", async () => {
    const a = await alertRow(alertId);
    assert(a.triage_due_at, "triage_due_at set");
    const due = new Date(a.triage_due_at);
    const expected = addBusinessDays(new Date(a.created_at), 2);
    assert(Math.abs(due.getTime() - expected.getTime()) < 60_000,
      `due ${a.triage_due_at} is 2 business days after ${a.created_at}`);
    assert(due.getUTCDay() !== 0 && due.getUTCDay() !== 6, "deadline is a weekday");
  });

  await t.step("a partner reaching case management gets 404, never 403, and writes nothing", async () => {
    const tri = await api("POST", `/bsa/alerts/${alertId}/triage`, { outcome: "escalated" }, { key: partner });
    assertEq(tri.status, 404, `partner triage (${body(tri)})`);
    const sw = await api("POST", "/bsa/timers/sweep", {}, { key: partner });
    assertEq(sw.status, 404, `partner sweep (${body(sw)})`);
    const a = await alertRow(alertId);
    assertEq(a.triaged_at, null, "alert untouched");
  });

  await t.step("triage needs the Investigations role: ops and an officer are 403 insufficient_role", async () => {
    const ops = await api("POST", `/bsa/alerts/${alertId}/triage`, { outcome: "escalated" });
    assertEq(ops.status, 403, `ops triage (${body(ops)})`);
    assertEq(ops.body.type, "insufficient_role", "typed");
    const off = await api("POST", `/bsa/alerts/${alertId}/triage`, { outcome: "escalated" }, { key: officer });
    assertEq(off.status, 403, `officer triage (${body(off)})`);
    assertEq(off.body.type, "insufficient_role", "typed");
    assertEq((await alertRow(alertId)).triaged_at, null, "alert untouched");
  });

  await t.step("resolving without a documented rationale is refused; a bad outcome too; nothing written", async () => {
    const r = await api("POST", `/bsa/alerts/${alertId}/triage`, { outcome: "resolved" }, { key: opener });
    assertEq(r.status, 400, `undocumented resolve (${body(r)})`);
    assertEq(r.body.errors?.[0]?.field, "note", "names `note`");
    const bad = await api("POST", `/bsa/alerts/${alertId}/triage`, { outcome: "ignored" }, { key: opener });
    assertEq(bad.status, 400, `bad outcome (${body(bad)})`);
    assertEq(bad.body.errors?.[0]?.field, "outcome", "names `outcome`");
    const a = await alertRow(alertId);
    assertEq(a.triaged_at, null, "not triaged");
    assertEq(a.status, "open", "still open");
    assert(!(await eventById(`evt_${alertId}_triaged`)), "no bsa_alert.triaged event");
  });

  await t.step("escalating opens a case; the SAR clock runs 30 days from DETECTION", async () => {
    const r = await api("POST", `/bsa/alerts/${alertId}/triage`,
      { outcome: "escalated", note: "flow: aggregate pattern" }, { key: opener });
    assertEq(r.status, 200, `escalate (${body(r)})`);
    caseId = String(r.body.case?.id);
    assert(caseId.startsWith("case_"), `a case came back (${caseId})`);

    const a = await alertRow(alertId);
    assertEq(a.status, "escalated", "alert escalated");
    assertEq(a.triage_outcome, "escalated", "outcome recorded");
    assertEq(a.case_id, caseId, "alert points at its case");

    const c = await caseRow(caseId);
    assertEq(c.status, "opened", "case opened");
    assertEq(c.alert_id, alertId, "case links back to its alert");
    assertEq(c.opened_by, tokenIdOf(opener, "cu_admin"), "the case records WHO opened it");
    const due = Date.parse(c.sar_decision_due_at);
    assert(Math.abs(due - (Date.parse(a.created_at) + 30 * DAY)) < 1_000,
      `SAR due ${c.sar_decision_due_at} = alert creation ${a.created_at} + 30d`);

    const evs = await eventsFor(`case:${caseId}`);
    const codes = evs.map((e) => e.code);
    assert(codes.includes("case.opened"), `case.opened emitted (${codes})`);
    assert(codes.includes("case.sar.decision.timer"), `SAR clock event emitted (${codes})`);
    const triaged = await eventById(`evt_${alertId}_triaged`);
    assertEq(triaged?.code, "bsa_alert.triaged", "bsa_alert.triaged emitted");
  });

  await t.step("re-triaging replays instead of overwriting the first decision", async () => {
    const r = await api("POST", `/bsa/alerts/${alertId}/triage`,
      { outcome: "resolved", note: "changed my mind" }, { key: opener });
    assertEq(r.status, 200, `re-triage (${body(r)})`);
    assertEq(r.headers.get("Idempotent-Replayed"), "true", "marked as a replay");
    const a = await alertRow(alertId);
    assertEq(a.triage_outcome, "escalated", "the original outcome survived");
    assertEq(a.case_id, caseId, "same case");
    const cases = await core().from("case").select("id").eq("alert_id", alertId);
    assertEq((cases.data ?? []).length, 1, "no second case");
  });

  await t.step("staff read the case; a partner gets 404 for it", async () => {
    const ops = await api("GET", `/bsa/cases/${caseId}`);
    assertEq(ops.status, 200, `ops reads the case (${body(ops)})`);
    assertEq(ops.body.id, caseId, "the case");
    assertEq(ops.body.status, "opened", "status on read");
    const p = await api("GET", `/bsa/cases/${caseId}`, undefined, { key: partner });
    assertEq(p.status, 404, `partner case read (${body(p)})`);
  });

  await t.step("the SAR decision needs the Officer role: investigator and ops 403, partner 404", async () => {
    const d = { decision: "file", rationale: "x" };
    const inv = await api("POST", `/bsa/cases/${caseId}/decision`, d, { key: investigatorOnly });
    assertEq(inv.status, 403, `investigator decides (${body(inv)})`);
    assertEq(inv.body.type, "insufficient_role", "typed");
    const ops = await api("POST", `/bsa/cases/${caseId}/decision`, d);
    assertEq(ops.status, 403, `ops decides (${body(ops)})`);
    assertEq(ops.body.type, "insufficient_role", "typed");
    const p = await api("POST", `/bsa/cases/${caseId}/decision`, d, { key: partner });
    assertEq(p.status, 404, `partner decides (${body(p)})`);
    assertEq((await caseRow(caseId)).decided_at, null, "nothing decided");
  });

  await t.step("the investigator who opened the case cannot decide it, even holding bsa_officer", async () => {
    const r = await api("POST", `/bsa/cases/${caseId}/decision`,
      { decision: "file", rationale: "self-approved" }, { key: opener });
    assertEq(r.status, 409, `self-decision (${body(r)})`);
    assertEq(r.body.type, "segregation_of_duties", "typed");
    const c = await caseRow(caseId);
    assertEq(c.decided_at, null, "nothing decided");
    assertEq(c.status, "opened", "still open");
  });

  await t.step("the database itself refuses a self-decided case (ck_case_four_eyes)", async () => {
    const c = await caseRow(caseId);
    const r = await core().from("case").update({ decided_by: c.opened_by }).eq("id", caseId);
    assert(r.error, "service-role write of decided_by = opened_by must be refused by the schema");
    assert(/ck_case_four_eyes/.test(r.error!.message), `the four-eyes constraint refused it (${r.error!.message})`);
    assertEq((await caseRow(caseId)).decided_by, null, "nothing decided");
  });

  await t.step("an undocumented decision is refused (BSA-07) and decides nothing", async () => {
    const r = await api("POST", `/bsa/cases/${caseId}/decision`, { decision: "no_file" }, { key: officer });
    assertEq(r.status, 400, `undocumented no_file (${body(r)})`);
    assertEq(r.body.errors?.[0]?.field, "rationale", "names `rationale`");
    assertEq((await caseRow(caseId)).decided_at, null, "nothing decided");
  });

  await t.step("a second officer files the SAR with committee concurrence recorded", async () => {
    const concurred = [tokenIdOf(compliance, "cu_admin"), tokenIdOf(counsel, "cu_admin")];
    const r = await api("POST", `/bsa/cases/${caseId}/decision`, {
      decision: "file", rationale: "structuring pattern confirmed", concurred_by: concurred,
    }, { key: officer });
    assertEq(r.status, 200, `file (${body(r)})`);
    assertEq(r.body.decision_was_late, false, "decided inside the clock");

    const c = await caseRow(caseId);
    assertEq(c.status, "closed", "case closed");
    assertEq(c.sar_decision, "file", "decision persisted");
    assertEq(c.decision_rationale, "structuring pattern confirmed", "rationale persisted");
    assertEq(c.decided_by, tokenIdOf(officer, "cu_admin"), "the case records WHO decided");
    assert(c.decided_by !== c.opened_by, "opener and decider provably differ on the row");
    assertEq(JSON.stringify(c.concurred_by), JSON.stringify(concurred), "committee concurrence recorded");

    const codes = (await eventsFor(`case:${caseId}`)).map((e) => e.code);
    assert(codes.includes("sar.filed"), `sar.filed emitted (${codes})`);
    assert(codes.includes("case.investigation_complete"), `case.investigation_complete emitted (${codes})`);
    assert(!codes.includes("sar.decision_no_file"), "no no-file event for a filing");
    const filed = await eventById(`evt_${caseId}_decided`);
    assertEq(filed?.payload?.late, false, "sar.filed carries late=false");

    const rec = await core().from("record").select("id, record_class, retention_expires_at")
      .eq("id", `rec_${caseId}_sar`).maybeSingle();
    assertEq(rec.data?.record_class, "sar", "BSA-21: the SAR retention clock started at filing");
  });

  await t.step("re-deciding replays the first decision", async () => {
    const r = await api("POST", `/bsa/cases/${caseId}/decision`,
      { decision: "no_file", rationale: "second thoughts" }, { key: officer });
    assertEq(r.status, 200, `re-decide (${body(r)})`);
    assertEq(r.headers.get("Idempotent-Replayed"), "true", "marked as a replay");
    assertEq((await caseRow(caseId)).sar_decision, "file", "the first decision stands");
  });

  // DEFECT: case/decision events are stamped production under a test actor — emitBsaEvent is never passed ctx (bsa.ts postAlertTriage/postCaseDecision)
  await t.step("everything a test actor wrote along the chain is labelled demo", async () => {
    assertEq((await caseRow(caseId)).provenance, "demo", "case");
    for (const e of await eventsFor(`case:${caseId}`)) {
      assertEq(e.provenance, "demo", `event ${e.code}`);
    }
    assertEq((await eventById(`evt_${alertId}_triaged`))?.provenance, "demo", "bsa_alert.triaged event");
  });
});

// ---------------------------------------------------------------- flow 2

flow("bsa: resolve-with-rationale opens no case; no-suspect case gets 60 days; a no-file decision", async (t) => {
  let partner = "";
  let src = "";
  let dst = "";
  let resolvedAlert = "";
  let noSuspectAlert = "";
  let caseId = "";
  let investigator = "";
  let dual = "";

  await t.step("fixtures: two members, two $11k transfers, an investigator and a dual-role officer", async () => {
    partner = await actor("partner");
    src = await onboard(partner);
    dst = await onboard(partner);
    investigator = await actor("cu_admin", ["bsa_investigator"]);
    dual = await actor("cu_admin", ["bsa_investigator", "bsa_officer"]);
    resolvedAlert = await largeTransfer(partner, src, dst, 1_100_000);
    noSuspectAlert = await largeTransfer(partner, src, dst, 1_100_000);
    assert(await alertRow(resolvedAlert), "first alert raised");
    assert(await alertRow(noSuspectAlert), "second alert raised");
  });

  await t.step("resolving WITH a rationale closes the alert and opens no case", async () => {
    const r = await api("POST", `/bsa/alerts/${resolvedAlert}/triage`,
      { outcome: "resolved", note: "known payroll counterparty" }, { key: investigator });
    assertEq(r.status, 200, `resolve (${body(r)})`);
    assertEq(r.body.case, null, "no case in the response");
    const a = await alertRow(resolvedAlert);
    assertEq(a.status, "closed", "alert closed");
    assertEq(a.triage_outcome, "resolved", "outcome recorded");
    assertEq(a.case_id, null, "no case pointer");
    const cases = await core().from("case").select("id").eq("alert_id", resolvedAlert);
    assertEq((cases.data ?? []).length, 0, "no case row");
    const ev = await eventById(`evt_${resolvedAlert}_triaged`);
    assertEq(ev?.payload?.note, "known payroll counterparty", "the rationale is retained on the event");
  });

  await t.step("a resolved alert cannot be re-triaged into a case", async () => {
    const r = await api("POST", `/bsa/alerts/${resolvedAlert}/triage`,
      { outcome: "escalated", note: "actually escalate" }, { key: investigator });
    assertEq(r.status, 200, `re-triage (${body(r)})`);
    assertEq(r.headers.get("Idempotent-Replayed"), "true", "replay");
    assertEq((await alertRow(resolvedAlert)).status, "closed", "still closed");
    const cases = await core().from("case").select("id").eq("alert_id", resolvedAlert);
    assertEq((cases.data ?? []).length, 0, "still no case");
  });

  await t.step("no_suspect extends the SAR clock to 60 days from detection", async () => {
    const r = await api("POST", `/bsa/alerts/${noSuspectAlert}/triage`,
      { outcome: "escalated", note: "no identified suspect", no_suspect: true }, { key: investigator });
    assertEq(r.status, 200, `escalate (${body(r)})`);
    caseId = String(r.body.case?.id);
    const a = await alertRow(noSuspectAlert);
    const c = await caseRow(caseId);
    assert(Math.abs(Date.parse(c.sar_decision_due_at) - (Date.parse(a.created_at) + 60 * DAY)) < 1_000,
      `SAR due ${c.sar_decision_due_at} = detection ${a.created_at} + 60d`);
    const timer = await eventById(`evt_${caseId}_decision_timer`);
    assertEq(timer?.payload?.days, 60, "the timer event says 60 days");
    assertEq(timer?.payload?.no_suspect, true, "and why");
  });

  await t.step("holding both roles still lets an officer decide a case someone ELSE opened: no-file", async () => {
    const r = await api("POST", `/bsa/cases/${caseId}/decision`,
      { decision: "no_file", rationale: "verified payroll" }, { key: dual });
    assertEq(r.status, 200, `dual-role no_file (${body(r)})`);
    const c = await caseRow(caseId);
    assertEq(c.status, "closed", "case closed");
    assertEq(c.sar_decision, "no_file", "decision persisted");
    assertEq(c.decision_rationale, "verified payroll", "rationale retained");
    assertEq(c.opened_by, tokenIdOf(investigator, "cu_admin"), "opened by the investigator");
    assertEq(c.decided_by, tokenIdOf(dual, "cu_admin"), "decided by the dual-role officer");
    assertEq(JSON.stringify(c.concurred_by), "[]", "no committee: still allowed (OQ-09 not enforced)");
  });

  await t.step("a no-file decision emits its own distinct event, never sar.filed", async () => {
    const codes = (await eventsFor(`case:${caseId}`)).map((e) => e.code);
    assert(codes.includes("sar.decision_no_file"), `sar.decision_no_file emitted (${codes})`);
    assert(!codes.includes("sar.filed"), "no sar.filed for a no-file decision");
    assert(codes.includes("case.investigation_complete"), "investigation completes either way");
    const rec = await core().from("record").select("id").eq("id", `rec_${caseId}_sar`).maybeSingle();
    assertEq(rec.data, null, "no SAR retention record without a filing");
  });
});

// ---------------------------------------------------------------- flow 3

flow("bsa: the timer sweep surfaces what nobody did; a late SAR is filed AND recorded late", async (t) => {
  let partner = "";
  let src = "";
  let dst = "";
  let staleAlert = "";
  let lateAlert = "";
  let caseId = "";
  let investigator = "";
  let officer = "";

  await t.step("fixtures: two alerts from real transfers", async () => {
    partner = await actor("partner");
    src = await onboard(partner);
    dst = await onboard(partner);
    investigator = await actor("cu_admin", ["bsa_investigator"]);
    officer = await actor("cu_admin", ["bsa_officer"]);
    staleAlert = await largeTransfer(partner, src, dst, 1_100_000);
    lateAlert = await largeTransfer(partner, src, dst, 1_150_000);
  });

  await t.step("an alert nobody triaged in time is surfaced as a breach, once", async () => {
    // back-date OUR alert's deadline (bash: psql); oldest-first sweep sees it first
    const aged = await core().from("bsa_alert").update({ triage_due_at: "2000-01-01T00:00:00Z" }).eq("id", staleAlert);
    assert(!aged.error, `age alert: ${aged.error?.message}`);

    const r = await api("POST", "/bsa/timers/sweep", {});
    assertEq(r.status, 200, `sweep (${body(r)})`);
    const hit = (r.body.breaches ?? []).find((b: Any) => b.id === staleAlert);
    assertEq(hit?.kind, "triage_overdue", "the untriaged alert is a triage_overdue breach");
    assertEq(r.body.breach_count, r.body.breaches.length, "breach_count agrees with the list");
    assertEq(typeof r.body.truncated, "boolean", "the sweep says whether it was capped");
    const ev = await eventById(`evt_${staleAlert}_triage_overdue`);
    assertEq(ev?.code, "bsa_alert.triage.overdue", "a durable breach event exists");

    const again = await api("POST", "/bsa/timers/sweep", {});
    assertEq(again.status, 200, "re-sweep");
    const n = await core().from("event").select("id", { count: "exact", head: true })
      .eq("id", `evt_${staleAlert}_triage_overdue`);
    assertEq(n.count, 1, "re-sweeping does not duplicate the breach event");
  });

  await t.step("triaging late does not buy time: the SAR clock still runs from detection", async () => {
    // the alert was detected 10 days ago; escalating today leaves 20 days, not 30
    const detected = new Date(Date.now() - 10 * DAY).toISOString();
    const aged = await core().from("bsa_alert").update({ created_at: detected }).eq("id", lateAlert);
    assert(!aged.error, `back-date detection: ${aged.error?.message}`);
    const r = await api("POST", `/bsa/alerts/${lateAlert}/triage`,
      { outcome: "escalated", note: "late triage" }, { key: investigator });
    assertEq(r.status, 200, `escalate (${body(r)})`);
    caseId = String(r.body.case?.id);
    const c = await caseRow(caseId);
    const a = await alertRow(lateAlert);
    assert(Math.abs(Date.parse(c.sar_decision_due_at) - (Date.parse(a.created_at) + 30 * DAY)) < 1_000,
      `SAR due ${c.sar_decision_due_at} = detection ${a.created_at} + 30d`);
    assert(Date.parse(c.sar_decision_due_at) < Date.now() + 21 * DAY, "only ~20 days remain");
  });

  await t.step("a case nobody decided in time is surfaced as a breach", async () => {
    const aged = await core().from("case").update({ sar_decision_due_at: "2000-01-01T00:00:00Z" }).eq("id", caseId);
    assert(!aged.error, `age case: ${aged.error?.message}`);
    const r = await api("POST", "/bsa/timers/sweep", {});
    assertEq(r.status, 200, `sweep (${body(r)})`);
    const hit = (r.body.breaches ?? []).find((b: Any) => b.id === caseId);
    assertEq(hit?.kind, "sar_decision_overdue", "the undecided case is a sar_decision_overdue breach");
    const ev = await eventById(`evt_${caseId}_decision_overdue`);
    assertEq(ev?.code, "case.sar_decision.overdue", "a durable breach event exists");
  });

  await t.step("a LATE decision still files, and the lateness survives on the response and event", async () => {
    const r = await api("POST", `/bsa/cases/${caseId}/decision`,
      { decision: "file", rationale: "late but filed" }, { key: officer });
    assertEq(r.status, 200, `late file (${body(r)})`);
    assertEq(r.body.decision_was_late, true, "decision_was_late on the response");
    assertEq((await caseRow(caseId)).status, "closed", "filed and closed");
    const filed = await eventById(`evt_${caseId}_decided`);
    assertEq(filed?.code, "sar.filed", "sar.filed");
    assertEq(filed?.payload?.late, true, "the event records late=true");
  });

  await t.step("a decided case drops out of the overdue sweep", async () => {
    const r = await api("POST", "/bsa/timers/sweep", {});
    assertEq(r.status, 200, "sweep");
    assert(!(r.body.breaches ?? []).some((b: Any) => b.id === caseId), "decided case not re-reported");
  });
});

// ---------------------------------------------------------------- flow 4

flow("bsa: retention — closure starts a 5-year clock; schema refuses early destruction; hold + release", async (t) => {
  let partner = "";
  let acct = "";
  let recId = "";
  let holdId = "";
  const matter = `m-flow-${crypto.randomUUID().slice(0, 8)}`;

  await t.step("closing an account starts BSA-21's CIP retention clock: 5 years from closure", async () => {
    partner = await actor("partner");
    acct = await onboard(partner, 100_000);
    const r = await api("POST", `/accounts/${acct}/transition`, { to: "closed" }, { key: partner });
    assertEq(r.status, 200, `close (${body(r)})`);
    recId = `rec_${acct}_cip_identity`;
    const rec = await core().from("record")
      .select("id, retention_anchor, retention_expires_at, legal_hold_flag, provenance").eq("id", recId).maybeSingle();
    assert(rec.data, "CIP identity retention record created");
    const anchor = new Date(rec.data!.retention_anchor);
    const exp = new Date(rec.data!.retention_expires_at);
    assertEq(exp.getUTCFullYear() - anchor.getUTCFullYear(), 5, "retention runs 5 years");
    assert(Math.abs(anchor.getTime() - Date.now()) < 5 * 60_000, "anchored at closure");
    const ev = await eventById(`evt_${recId}_clock_set`);
    assertEq(ev?.code, "record.retention_clock_set", "BSA-21's produced event fired");
    assertEq(ev?.resource_id, `record:${recId}`, "naming the record");
  });

  // DEFECT: setRetentionClocks never receives ctx, so a test actor's closure clocks a `production` record (retention.ts setRetentionClocks / accounts.ts postAccountTransition)
  await t.step("the record a test actor clocked is labelled demo, not production", async () => {
    const rec = await core().from("record").select("provenance").eq("id", recId).single();
    assertEq(rec.data?.provenance, "demo", "record provenance");
  });

  await t.step("premature destruction is refused by the API and by the schema itself", async () => {
    const noApproval = await api("POST", `/retention/records/${recId}/dispose`, {});
    assertEq(noApproval.status, 400, `unapproved dispose (${body(noApproval)})`);
    const early = await api("POST", `/retention/records/${recId}/dispose`,
      { approved_by: "records-manager", certificate: "cert-flow" });
    assertEq(early.status, 409, `early dispose (${body(early)})`);
    assertEq(early.body.type, "retention_not_expired", "typed");

    const now = new Date().toISOString();
    const direct = await core().from("record").update({
      disposal_approved_by: "x", disposal_approved_at: now, disposed_at: now,
    }).eq("id", recId);
    assert(direct.error, "service-role destruction inside retention must be refused by the schema");
    assert(/ck_record_disposal/.test(direct.error!.message), `a disposal constraint refused it (${direct.error!.message})`);
    const rec = await core().from("record").select("disposed_at").eq("id", recId).single();
    assertEq(rec.data?.disposed_at, null, "record intact");
  });

  // The spec's x-actors route gate (cu_admin, pynthia_ops) refuses a partner
  // with 403 insufficient_scope before retention.ts's own 404 gate is reached.
  await t.step("a partner cannot place a legal hold, and nothing is held", async () => {
    const r = await api("POST", "/retention/holds",
      { matter_id: matter, scope_subject_ref: acct, reason: "subpoena" }, { key: partner });
    assertEq(r.status, 403, `partner hold (${body(r)})`);
    assertEq(r.body.type, "insufficient_scope", "refused at the route's actor gate");
    const h = await core().from("legal_hold").select("id").eq("id", `hold_${matter}_${acct}`).maybeSingle();
    assertEq(h.data, null, "no hold row");
    const rec = await core().from("record").select("legal_hold_flag").eq("id", recId).single();
    assertEq(rec.data?.legal_hold_flag, false, "record not flagged");
  });

  await t.step("a legal hold flags in-scope records in the same request and takes precedence", async () => {
    const r = await api("POST", "/retention/holds",
      { matter_id: matter, scope_subject_ref: acct, reason: "subpoena" });
    assertEq(r.status, 201, `hold (${body(r)})`);
    holdId = `hold_${matter}_${acct}`;
    const rec = await core().from("record").select("legal_hold_flag, legal_hold_id").eq("id", recId).single();
    assertEq(rec.data?.legal_hold_flag, true, "in-scope record flagged");
    assertEq(rec.data?.legal_hold_id, holdId, "pointing at the hold");
    const ev = await eventById(`evt_${holdId}_disposal_held`);
    assertEq(ev?.code, "disposal.held", "disposal.held emitted (SC-02)");
    assertEq(ev?.resource_id, `record:${holdId}`, "naming the hold");

    const d = await api("POST", `/retention/records/${recId}/dispose`,
      { approved_by: "records-manager", certificate: "cert-flow" });
    assertEq(d.status, 409, `dispose under hold (${body(d)})`);
    assertEq(d.body.type, "legal_hold_in_force", "the hold is reported first");
  });

  await t.step("release needs written authorization; an authorized release clears the flag", async () => {
    const bad = await api("POST", `/retention/holds/${holdId}/release`, {});
    assertEq(bad.status, 400, `unauthorized release (${body(bad)})`);
    assertEq(bad.body.errors?.[0]?.field, "approved_by", "names approved_by");
    let rec = await core().from("record").select("legal_hold_flag").eq("id", recId).single();
    assertEq(rec.data?.legal_hold_flag, true, "the hold is still in force");

    const ok = await api("POST", `/retention/holds/${holdId}/release`, { approved_by: "general-counsel" });
    assertEq(ok.status, 200, `release (${body(ok)})`);
    rec = await core().from("record").select("legal_hold_flag").eq("id", recId).single();
    assertEq(rec.data?.legal_hold_flag, false, "the flag cleared");
    const ev = await eventById(`evt_${holdId}_released`);
    assertEq(ev?.payload?.release_approved_by, "general-counsel", "who authorized it is recorded");
  });

  await t.step("no simulated evidence exists in core", async () => {
    for (const table of ["record", "control_result", "bsa_alert", "case"]) {
      const n = await core().from(table).select("*", { count: "exact", head: true }).eq("provenance", "simulated");
      assert(!n.error, `${table} count: ${n.error?.message}`);
      assertEq(n.count, 0, `simulated rows in core.${table}`);
    }
  });
});
