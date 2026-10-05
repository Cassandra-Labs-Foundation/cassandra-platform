// Deadline flows: every regulatory clock the core starts, pinned to its ANCHOR
// with absolute dates, walked end to end against the DEPLOYED core.
//
// Ported from the deadlines.ts unit stubs (see ledger/deadlines.md). Those
// stubs exist because an interval assertion (`due - anchor == 30d`) cannot see
// a clock that silently re-anchors on `now`; these flows therefore post records
// whose anchor is far in the past wherever the API allows it, so anchoring on
// the write time and anchoring on the true anchor give different dates.
//
// deadlines.ts has no routes of its own. The clocks live in:
//   incidents.ts   72h NCUA notice from the reportability determination (+ sweep)
//   capital.ts     45-day NWRP from the undercapitalized classification
//   investment.ts  credit-file re-analysis a year from approval
//   records_admin  CDD refresh, risk-based, from the last refresh
//   cash.ts        CTR filing 15 days from the business date (+ sweep, filing)
//   retention.ts   the CTR record's retention clock (5 years)
// ECOA (lending.ts) is deliberately unrouted — see the ledger.
import { actor, type Any, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function tokenIdOf(plaintext: string, actorType: string): string {
  return `tok_test_${actorType}_${plaintext.slice("cass_test_".length, "cass_test_".length + 12)}`;
}

async function rowById(table: string, id: string) {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data as Any;
}

const ms = (s: string | null | undefined) => Date.parse(String(s));
const isoZ = (s: string | null | undefined) => new Date(ms(s)).toISOString();

/** a random 20th-century calendar date (YYYY-MM-DD) */
function oldDate(): string {
  const year = 1901 + Math.floor(Math.random() * 98);
  return new Date(Date.UTC(year, 0, 1) + Math.floor(Math.random() * 360) * DAY_MS).toISOString().slice(0, 10);
}

async function declare(ops: string, severity = "sev1"): Promise<string> {
  const id = `inc_flow_${uid()}`;
  const r = await api("POST", "/incidents",
    { id, title: "flow: suspected member-data exposure", severity, source: "siem" }, { key: ops });
  assertEq(r.status, 201, `declare (${body(r)})`);
  return id;
}

// ------------------------------------------------------------------ NCUA 72h

flow("deadlines: incident sat since 2020 → Compliance determines reportable → 72h NCUA clock runs from the DETERMINATION → notified on time", async (t) => {
  const ops = await actor("pynthia_ops");
  const compliance = await actor("cu_admin", ["bsa_compliance"]);
  const partner = await actor("partner");
  let id = "";
  let determinedFloor = 0;

  await t.step("operations declares a sev1: an internal 24h determination deadline, but NO NCUA clock yet", async () => {
    const t0 = Date.now();
    id = await declare(ops);
    const inc = await rowById("incident", id);
    assertEq(inc.ncua_notice_due_at, null, "the 72h clock has not started");
    assertEq(ms(inc.determination_due_at) - ms(inc.declared_at), 24 * HOUR_MS, "determination due 24h from declaration");
    assert(ms(inc.declared_at) >= t0 - 60_000, "declared now");
    assertEq(inc.ic_assigned_to, tokenIdOf(ops, "pynthia_ops"), "the declarer is the incident commander");
  });

  await t.step("a partner is refused the incident sweep (403, actor gate)", async () => {
    const r = await api("POST", "/incidents/sweep", {}, { key: partner });
    assertEq(r.status, 403, `partner sweep (${body(r)})`);
  });

  await t.step("the sweep reports it UNDETERMINED — neither overdue nor compliant", async () => {
    const r = await api("POST", "/incidents/sweep", {}, { key: ops });
    assertEq(r.status, 200, `sweep (${body(r)})`);
    assert(r.body.undetermined >= 1, "undetermined counted");
    const ev = await rowById("event", `evt_${id}_undetermined`);
    assertEq(ev?.code, "incident.reportability_undetermined", "undetermined event for this incident");
  });

  await t.step("fixture: the incident actually sat unopened since 2020 (declaration backdated)", async () => {
    const u = await core().from("incident")
      .update({ declared_at: "2020-01-01T00:00:00.000Z", detected_at: "2020-01-01T00:00:00.000Z" }).eq("id", id);
    assert(!u.error, `backdate: ${u.error?.message}`);
  });

  await t.step("operations without a Compliance/Legal role cannot determine (403); no rationale is refused (400)", async () => {
    const r = await api("POST", `/incidents/${id}/determine`,
      { is_reportable: true, rationale: "member data likely misused" }, { key: ops });
    assertEq(r.status, 403, `ops determination (${body(r)})`);
    assertEq(r.body.type, "insufficient_role", "typed refusal");
    const n = await api("POST", `/incidents/${id}/determine`, { is_reportable: true }, { key: compliance });
    assertEq(n.status, 400, `no rationale (${body(n)})`);
    assertEq((await rowById("incident", id)).reportability_determined_at, null, "still undetermined");
  });

  await t.step("determining before the assessment is refused as a client error (the assessment feeds the determination)", async () => {
    const r = await api("POST", `/incidents/${id}/determine`,
      { is_reportable: true, rationale: "member data likely misused" }, { key: compliance });
    // DEFECT: postDetermineReportability never checks assessment_completed_at; the DB CHECK ck_incident_assessment_before_determination rejects the update and the caller gets a 500 internal_error instead of a typed 409
    assert(r.status >= 400 && r.status < 500, `determination before assessment must be a 4xx, got ${r.status} (${body(r)})`);
    assertEq((await rowById("incident", id)).reportability_determined_at, null, "still undetermined");
  });

  await t.step("the incident commander records the assessment: data scope + member impact", async () => {
    const bad = await api("POST", `/incidents/${id}/assessment`, { facts: {} }, { key: ops });
    assertEq(bad.status, 400, `empty assessment (${body(bad)})`);
    const r = await api("POST", `/incidents/${id}/assessment`, {
      data_scope: { tables: ["member_contact"] }, member_impact: "~1,200 members' emails exposed",
    }, { key: ops });
    assertEq(r.status, 200, `assess (${body(r)})`);
    assert((await rowById("incident", id)).assessment_completed_at, "assessment recorded");
    assertEq((await rowById("event", `evt_${id}_assessed`))?.code, "incident.assessment.completed", "assessment event");
  });

  await t.step("Compliance determines reportable: due = determination + 72h, NOT declaration + 72h", async () => {
    determinedFloor = Date.now() - 60_000;
    const r = await api("POST", `/incidents/${id}/determine`,
      { is_reportable: true, rationale: "member data likely misused" }, { key: compliance });
    assertEq(r.status, 200, `determine (${body(r)})`);
    const inc = await rowById("incident", id);
    const determined = ms(inc.reportability_determined_at);
    assert(determined >= determinedFloor, "the determination time is when it was determined");
    assertEq(ms(inc.ncua_notice_due_at) - determined, 72 * HOUR_MS, "72 hours from the determination");
    assert(ms(inc.ncua_notice_due_at) > Date.parse("2020-01-05T00:00:00Z"),
      "anchoring on the 2020 declaration would put the deadline in 2020");
    assertEq(inc.reportability_determined_by, tokenIdOf(compliance, "cu_admin"), "determiner recorded");
    const ev = await rowById("event", `evt_${id}_ncua_timer`);
    assertEq(ev?.code, "incident.ncua.notice.due_at", "timer event");
    assertEq(isoZ(ev?.payload?.due_at), isoZ(inc.ncua_notice_due_at), "timer event carries the same due date");
    assertEq(ev?.payload?.hours, 72, "72h");
  });

  await t.step("re-determining replays and does not re-anchor the clock", async () => {
    const before = (await rowById("incident", id)).ncua_notice_due_at;
    const r = await api("POST", `/incidents/${id}/determine`,
      { is_reportable: true, rationale: "second look" }, { key: compliance });
    assertEq(r.status, 200, `re-determine (${body(r)})`);
    assertEq(r.headers.get("Idempotent-Replayed"), "true", "replay header");
    assertEq((await rowById("incident", id)).ncua_notice_due_at, before, "due date unchanged");
  });

  await t.step("NCUA notified inside the window: not late; the sweep does not flag it overdue", async () => {
    const r = await api("POST", `/incidents/${id}/notify-ncua`, { reference: `ncua_${uid()}` }, { key: ops });
    assertEq(r.status, 200, `notify (${body(r)})`);
    assertEq(r.body.notified_late, false, "on time");
    const ev = await rowById("event", `evt_${id}_ncua`);
    assertEq(ev?.code, "incident.ncua.notified", "notified event");
    assertEq(ev?.payload?.late, false, "event: not late");
    const s = await api("POST", "/incidents/sweep", {}, { key: ops });
    assertEq(s.status, 200, `sweep (${body(s)})`);
    assertEq(await rowById("event", `evt_${id}_ncua_overdue`), null, "never flagged overdue");
  });
});

flow("deadlines: a NON-reportable incident starts no NCUA clock and cannot be notified", async (t) => {
  const ops = await actor("pynthia_ops");
  const counsel = await actor("cu_admin", ["bsa_counsel"]);
  let id = "";

  await t.step("declare a sev2; notifying NCUA before any determination is 409 not_determined", async () => {
    id = await declare(ops, "sev2");
    const r = await api("POST", `/incidents/${id}/notify-ncua`, {}, { key: ops });
    assertEq(r.status, 409, `early notify (${body(r)})`);
    assertEq(r.body.type, "not_determined", "typed refusal");
  });

  await t.step("the assessment: no member data in scope", async () => {
    const r = await api("POST", `/incidents/${id}/assessment`,
      { data_scope: { tables: [] }, member_impact: "none — internal build server only" }, { key: ops });
    assertEq(r.status, 200, `assess (${body(r)})`);
  });

  await t.step("Legal determines NOT reportable, with rationale: no clock at all", async () => {
    const r = await api("POST", `/incidents/${id}/determine`,
      { is_reportable: false, rationale: "no member data involved" }, { key: counsel });
    assertEq(r.status, 200, `determine (${body(r)})`);
    const inc = await rowById("incident", id);
    assertEq(inc.is_reportable, false, "not reportable");
    assertEq(inc.ncua_notice_due_at, null, "no NCUA clock");
    assertEq(inc.reportability_rationale, "no member data involved", "the decision NOT to report is documented");
    assertEq(await rowById("event", `evt_${id}_ncua_timer`), null, "no timer event");
    assertEq((await rowById("event", `evt_${id}_determined`))?.payload?.is_reportable, false, "determination event");
  });

  await t.step("notifying NCUA now would contradict the determination: 409 not_reportable", async () => {
    const r = await api("POST", `/incidents/${id}/notify-ncua`, {}, { key: ops });
    assertEq(r.status, 409, `notify (${body(r)})`);
    assertEq(r.body.type, "not_reportable", "typed refusal");
    assertEq((await rowById("incident", id)).ncua_notified_at, null, "nothing notified");
  });
});

// ---------------------------------------------------------------------- NWRP

flow("deadlines: an old quarter classified undercapitalized → NWRP due 45 days from the CLASSIFICATION → plan filed; well-capitalized starts no clock", async (t) => {
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  const asOf = oldDate();
  const id = `cap_${asOf.replace(/-/g, "")}`;
  let classifiedFloor = 0;
  let due = "";

  await t.step("a partner cannot post a capital position (404)", async () => {
    const r = await api("POST", "/capital/positions",
      { as_of_date: asOf, net_worth_cents: 5_000_000_00, total_assets_cents: 100_000_000_00 }, { key: partner });
    assertEq(r.status, 404, `partner (${body(r)})`);
    assertEq(await rowById("capital_position", id), null, "nothing written");
  });

  await t.step(`5% net worth for quarter ${asOf}: undercapitalized, restricted, plan due 45 days from NOW`, async () => {
    classifiedFloor = Date.now() - 60_000;
    const r = await api("POST", "/capital/positions",
      { as_of_date: asOf, net_worth_cents: 5_000_000_00, total_assets_cents: 100_000_000_00 }, { key: ops });
    assertEq(r.status, 201, `post (${body(r)})`);
    const p = await rowById("capital_position", id);
    assertEq(p.pca_category, "undercapitalized", "PCA category");
    assertEq(p.distribution_restricted, true, "distributions restricted in the same write");
    due = p.nwrp_due_at;
    assertEq(Math.round((ms(due) - ms(p.created_at)) / DAY_MS), 45, "45 days from the classification");
    assert(ms(due) >= classifiedFloor + 45 * DAY_MS, "anchored on the classification, not the quarter end");
    assert(ms(due) > Date.parse(`${asOf}T00:00:00Z`) + 46 * DAY_MS, "the quarter end is not the anchor");
    const ev = await rowById("event", `ev_${id}_mand`);
    assertEq(isoZ(ev?.payload?.nwrp_due_at), isoZ(due), "mandatory-actions event carries the due date");
  });

  await t.step("re-posting the same quarter (a restatement, still undercapitalized) does not restart the clock", async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await api("POST", "/capital/positions",
      { as_of_date: asOf, net_worth_cents: 5_100_000_00, total_assets_cents: 100_000_000_00 }, { key: ops });
    assertEq(r.status, 201, `restate (${body(r)})`);
    const p = await rowById("capital_position", id);
    assertEq(p.pca_category, "undercapitalized", "still undercapitalized");
    // DEFECT: postCapitalPosition upserts nwrp_due_at = now + 45d on every write, so re-posting a quarter silently pushes the restoration-plan deadline out
    assertEq(isoZ(p.nwrp_due_at), isoZ(due), "the deadline stays anchored on the first classification");
  });

  await t.step("the restoration plan is filed: needs a filer; then recorded", async () => {
    const bad = await api("POST", `/capital/positions/${id}/nwrp`, {}, { key: ops });
    assertEq(bad.status, 400, `no filer (${body(bad)})`);
    const r = await api("POST", `/capital/positions/${id}/nwrp`, { filed_by: "cfo_flow" }, { key: ops });
    assertEq(r.status, 200, `file (${body(r)})`);
    const p = await rowById("capital_position", id);
    assertEq(p.nwrp_filed_by, "cfo_flow", "filer");
    assert(ms(p.nwrp_filed_at) <= ms(p.nwrp_due_at), "filed before it was due");
    assertEq((await rowById("event", `ev_${id}_nwrp`))?.code, "capital.restoration_plan.filed", "filed event");
  });

  await t.step("a well-capitalized quarter (10%) starts no clock and a plan is not required", async () => {
    let wellAsOf = oldDate();
    while (wellAsOf === asOf) wellAsOf = oldDate();
    const wid = `cap_${wellAsOf.replace(/-/g, "")}`;
    const r = await api("POST", "/capital/positions",
      { as_of_date: wellAsOf, net_worth_cents: 10_000_000_00, total_assets_cents: 100_000_000_00 }, { key: ops });
    assertEq(r.status, 201, `post (${body(r)})`);
    const p = await rowById("capital_position", wid);
    assertEq(p.pca_category, "well_capitalized", "PCA category");
    assertEq(p.nwrp_due_at, null, "no restoration clock");
    assertEq(p.distribution_restricted, false, "no restriction");
    const n = await api("POST", `/capital/positions/${wid}/nwrp`, { filed_by: "cfo_flow" }, { key: ops });
    assertEq(n.status, 409, `plan not required (${body(n)})`);
    assertEq(n.body.type, "nwrp_not_required", "typed refusal");
  });
});

// --------------------------------------------------------------- credit file

flow("deadlines: issuer credit file approved → re-analysis due a year from APPROVAL → re-analysis restarts it", async (t) => {
  const ops = await actor("pynthia_ops");
  const issuer = `flow_issuer_${uid()}`;
  const id = `cfile_${issuer}`;

  await t.step("a file with only an external rating (no own analysis) is refused", async () => {
    const r = await api("POST", "/investment/credit-files",
      { issuer_ref: issuer, internal_rating: "AA", external_rating: "AA+", approved_by: "cio" }, { key: ops });
    assertEq(r.status, 400, `no own analysis (${body(r)})`);
    assertEq(await rowById("credit_file", id), null, "nothing written");
  });

  await t.step("approve the file: re-analysis due exactly 365 days from approval", async () => {
    const r = await api("POST", "/investment/credit-files", {
      issuer_ref: issuer, internal_rating: "AA", external_rating: "AA+",
      analysis_ref: `memo_${uid()}`, approved_by: "cio",
    }, { key: ops });
    assertEq(r.status, 201, `approve (${body(r)})`);
    const f = await rowById("credit_file", id);
    assertEq(ms(f.reanalysis_due_at) - ms(f.approved_at), 365 * DAY_MS, "365 days from approval");
    const ev = await rowById("event", `ev_${id}_due`);
    assertEq(ev?.code, "credit_file.reanalysis_due_at", "due event");
    assertEq(isoZ(ev?.payload?.reanalysis_due_at), isoZ(f.reanalysis_due_at), "event carries the due date");
  });

  await t.step("re-analysis without the analysis is a date change: refused; with it, the clock restarts from the re-analysis", async () => {
    const before = await rowById("credit_file", id);
    const bad = await api("POST", `/investment/credit-files/${id}/reanalyse`, { internal_rating: "A" }, { key: ops });
    assertEq(bad.status, 400, `no analysis (${body(bad)})`);
    assertEq((await rowById("credit_file", id)).reanalysis_due_at, before.reanalysis_due_at, "due unchanged");
    const r = await api("POST", `/investment/credit-files/${id}/reanalyse`,
      { internal_rating: "A", analysis_ref: `memo_${uid()}` }, { key: ops });
    assertEq(r.status, 200, `reanalyse (${body(r)})`);
    const f = await rowById("credit_file", id);
    assertEq(f.internal_rating, "A", "new rating");
    assertEq(ms(f.reanalysis_due_at) - ms(f.reanalysed_at), 365 * DAY_MS, "365 days from the re-analysis");
  });
});

// ----------------------------------------------------------------------- CDD

flow("deadlines: CDD profile last refreshed in 2020 → risk-based refresh due anchored on that date → refreshed now", async (t) => {
  const ops = await actor("pynthia_ops");
  const high = `cdd_flow_${uid()}`;
  const low = `cdd_flow_${uid()}`;

  await t.step("an unknown risk tier is refused", async () => {
    const r = await api("POST", "/records/cdd-profiles", { id: high, risk_tier: "extreme" }, { key: ops });
    assertEq(r.status, 400, `bad tier (${body(r)})`);
  });

  await t.step("high risk, last refreshed 2020-01-01: due 2021-01-01 — already years overdue", async () => {
    const r = await api("POST", "/records/cdd-profiles",
      { id: high, risk_tier: "high", last_refreshed_at: "2020-01-01T00:00:00.000Z" }, { key: ops });
    assertEq(r.status, 201, `post (${body(r)})`);
    const p = await rowById("cdd_profile", high);
    assertEq(isoZ(p.last_refreshed_at), "2020-01-01T00:00:00.000Z", "anchor kept");
    assertEq(isoZ(p.refresh_due_at), "2021-01-01T00:00:00.000Z", "12-month cycle from the last refresh");
    const ev = await rowById("event", `ev_${high}_due`);
    assertEq(ev?.payload?.cycle_months, 12, "event names the cycle");
  });

  await t.step("low risk on the same anchor runs a 60-month cycle", async () => {
    const r = await api("POST", "/records/cdd-profiles",
      { id: low, risk_tier: "low", last_refreshed_at: "2020-01-01T00:00:00.000Z" }, { key: ops });
    assertEq(r.status, 201, `post (${body(r)})`);
    assertEq(isoZ((await rowById("cdd_profile", low)).refresh_due_at), "2025-01-01T00:00:00.000Z", "5 years");
  });

  await t.step("the refresh needs a refresher; done, the next refresh is due 12 months from now", async () => {
    const bad = await api("POST", `/records/cdd-profiles/${high}/refresh`, {}, { key: ops });
    assertEq(bad.status, 400, `no refresher (${body(bad)})`);
    const r = await api("POST", `/records/cdd-profiles/${high}/refresh`, { refreshed_by: "bsa_analyst_flow" }, { key: ops });
    assertEq(r.status, 200, `refresh (${body(r)})`);
    const p = await rowById("cdd_profile", high);
    assertEq(p.refreshed_by, "bsa_analyst_flow", "refresher");
    const last = new Date(ms(p.last_refreshed_at));
    assert(last.getTime() > Date.now() - 5 * 60_000, "refreshed now");
    last.setUTCMonth(last.getUTCMonth() + 12);
    assertEq(isoZ(p.refresh_due_at), last.toISOString(), "12 months from the refresh");
  });
});

// ----------------------------------------------------------------------- CTR

flow("deadlines: $12k cash in on an old business date → CTR due 15 days from the BUSINESS DATE → sweep flags it overdue → filed late", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  const businessDate = `2019-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`;
  const want = new Date(Date.parse(`${businessDate}T00:00:00Z`) + 15 * DAY_MS).toISOString();
  let entity = "";
  let ctrId = "";

  await t.step("a member exists", async () => {
    const e = await api("POST", "/entities", {
      type: "person", name: personaName(), date_of_birth: "1980-04-04",
      address: "200 Market St, Springfield, IL 62701",
    }, { key: partner });
    assertEq(e.status, 201, `entity (${body(e)})`);
    entity = String(e.body.id);
  });

  await t.step("$12,000 cash in: a CTR whose due date is pinned to the business date, absolutely", async () => {
    const r = await api("POST", "/cash/transactions",
      { direction: "cash_in", amount_cents: 1_200_000, business_date: businessDate, entity_id: entity }, { key: ops });
    assertEq(r.status, 201, `cash (${body(r)})`);
    assert(r.body.ctr, `a CTR was opened (${body(r)})`);
    ctrId = String(r.body.ctr.id);
    const c = await rowById("ctr_filing", ctrId);
    assertEq(isoZ(c.filing_due_at), want, `due ${want}: 15 days from ${businessDate}, not from today`);
    const ev = await rowById("event", `evt_${ctrId}_timer`);
    assertEq(ev?.code, "ctr.filing.timer", "timer event");
    assertEq(isoZ(ev?.payload?.due_at), want, "timer event due date");
  });

  await t.step("the CTR's retention clock runs 5 years from its anchor", async () => {
    const rec = await rowById("record", `rec_${ctrId}_ctr`);
    assert(rec, "retention record started for the CTR");
    assertEq(rec.retention_anchor_kind, "report_date", "anchor kind");
    const anchor = new Date(ms(rec.retention_anchor));
    anchor.setUTCFullYear(anchor.getUTCFullYear() + 5);
    assertEq(isoZ(rec.retention_expires_at), anchor.toISOString(), "expires 5 years from the record's own anchor");
  });

  await t.step("the CTR sweep flags it overdue", async () => {
    const r = await api("POST", "/cash/ctr/sweep", {}, { key: ops });
    assertEq(r.status, 200, `sweep (${body(r)})`);
    assert((r.body.overdue_filings ?? []).some((o: Any) => o.id === ctrId), "this CTR is in the overdue list");
    assertEq((await rowById("event", `evt_${ctrId}_overdue`))?.code, "ctr.filing.overdue", "overdue event");
  });

  await t.step("filed: needs a FinCEN reference; once filed the lateness is recorded and the sweep stops flagging it", async () => {
    const bad = await api("POST", `/cash/ctr/${ctrId}/file`, { filed_by: "bsa_officer_flow" }, { key: ops });
    assertEq(bad.status, 400, `no fincen ref (${body(bad)})`);
    const r = await api("POST", `/cash/ctr/${ctrId}/file`,
      { filed_by: "bsa_officer_flow", fincen_ref: `BSA-${uid()}` }, { key: ops });
    assertEq(r.status, 200, `file (${body(r)})`);
    assertEq(r.body.filed_late, true, "late, and said so");
    assertEq((await rowById("event", `evt_${ctrId}_filed`))?.payload?.late, true, "filed event records lateness");
    const s = await api("POST", "/cash/ctr/sweep", {}, { key: ops });
    assert(!(s.body.overdue_filings ?? []).some((o: Any) => o.id === ctrId), "no longer overdue");
  });
});
