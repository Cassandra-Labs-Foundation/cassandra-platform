// Complaint and Reg E dispute flows — CO-06, FL-13, MP-04, PR-10.
//
// The credit union's staff (cu_admin: Member Services and Compliance) log a
// member's complaint, work it through acknowledgement, initial and final
// responses to a root-caused resolution, open a Reg E dispute on the member's
// account, and report the register to the Board. Every clock is asserted on the
// complaint/dispute row an examiner reads, and every step's event trail on
// core.event. Ported from the user-observable behaviour of
// core/supabase/functions/api/complaints.test.ts (see ledger/complaints.md).
//
// The complaint register is internal: these routes self-gate with
// requireInternalActor, so a partner (fintech) token gets a 404, not a 403.
import { actor, type Any, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const ms = (s: unknown) => new Date(String(s)).getTime();
const daysBetween = (a: unknown, b: unknown) => (ms(b) - ms(a)) / DAY_MS;
const utcDate = (t: number) => new Date(t).toISOString().slice(0, 10);
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString();

async function complaintRow(id: string) {
  const r = await core().from("complaint").select("*").eq("id", id).maybeSingle();
  assert(!r.error, `complaint read: ${r.error?.message}`);
  return r.data as Any;
}

async function disputeRow(id: string) {
  const r = await core().from("dispute").select("*").eq("id", id).maybeSingle();
  assert(!r.error, `dispute read: ${r.error?.message}`);
  return r.data as Any;
}

/** every event written about one resource, keyed by code */
async function eventsFor(resourceType: string, id: string): Promise<Map<string, Any>> {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("resource_id", `${resourceType}:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  const m = new Map<string, Any>();
  for (const e of r.data ?? []) m.set(String(e.code), e);
  return m;
}

/** how many complaint rows carry this narrative marker (refusals must write none) */
async function complaintsNarrated(marker: string): Promise<number> {
  const r = await core().from("complaint").select("id").like("narrative", `%${marker}%`);
  assert(!r.error, `complaint read: ${r.error?.message}`);
  return (r.data ?? []).length;
}

async function countComplaints(filter: (q: Any) => Any = (q) => q): Promise<number> {
  const r = await filter(core().from("complaint").select("id", { count: "exact", head: true }));
  assert(!r.error, `complaint count: ${r.error?.message}`);
  return r.count ?? 0;
}

/** a fresh member the partner onboarded, with a funded checking account */
async function onboardMember(partner: string, openingCents = 100_000) {
  const e = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1979-11-23",
    address: "41 Elm St, Springfield, IL 62701", email: `member+${uid()}@example.test`,
  }, { key: partner });
  assertEq(e.status, 201, `create entity (${body(e)})`);
  const a = await api("POST", "/accounts", {
    entity_id: e.body.id, account_type: "checking", opening_deposit_cents: openingCents,
  }, { key: partner });
  assertEq(a.status, 201, `open account (${body(a)})`);
  return { entity: String(e.body.id), account: String(a.body.id), email: String(e.body.email ?? "") };
}

async function balanceOf(partner: string, accountId: string): Promise<number> {
  const r = await api("GET", `/accounts/${accountId}`, undefined, { key: partner });
  assertEq(r.status, 200, `account read (${body(r)})`);
  return r.body.balance;
}

function logComplaint(staff: string, o: Record<string, unknown>) {
  return api("POST", "/complaints", {
    channel: "direct", category: "fees", narrative: `flow: charged twice ${uid()}`, ...o,
  }, { key: staff });
}

// ------------------------------------------------- CO-06 / MP-04 lifecycle

flow("complaints: direct fee complaint → clocks run from RECEIPT → acknowledged → initial + final responses → resolved with a root cause", async (t) => {
  const partner = await actor("partner");
  const staff = await actor("cu_admin");
  let member = { entity: "", account: "", email: "" };
  let id = "";
  let receivedAt = "";

  await t.step("the partner onboards the member who will complain", async () => {
    member = await onboardMember(partner);
  });

  await t.step("the complaint register is staff-only: a partner gets 404", async () => {
    const marker = `partner-${uid()}`;
    const r = await api("POST", "/complaints",
      { channel: "direct", category: "fees", narrative: `flow: ${marker}` }, { key: partner });
    assertEq(r.status, 404, `partner intake (${body(r)})`);
    assertEq(await complaintsNarrated(marker), 0, "no complaint row written for the partner");
  });

  await t.step("intake refuses a complaint with no valid category or no narrative — field named, nothing written", async () => {
    const marker = `refused-${uid()}`;
    const noCat = await api("POST", "/complaints",
      { channel: "phone", narrative: `flow: ${marker}` }, { key: staff });
    assertEq(noCat.status, 400, `no category (${body(noCat)})`);
    assert(JSON.stringify(noCat.body).includes("category"), "the refusal names category");
    const badCat = await api("POST", "/complaints",
      { channel: "phone", category: "not_a_category", narrative: `flow: ${marker}` }, { key: staff });
    assertEq(badCat.status, 400, `unknown category (${body(badCat)})`);
    const noNarr = await api("POST", "/complaints", { channel: "phone", category: "service" }, { key: staff });
    assertEq(noNarr.status, 400, `no narrative (${body(noNarr)})`);
    assert(JSON.stringify(noNarr.body).includes("narrative"), "the refusal names narrative");
    assertEq(await complaintsNarrated(marker), 0, "refused intakes wrote no complaint row");
  });

  await t.step("log a complaint that sat in the inbox for 3 days: every clock anchors on the SUPPLIED receipt time", async () => {
    receivedAt = new Date(Math.floor((Date.now() - 3 * DAY_MS) / 1000) * 1000).toISOString();
    const r = await logComplaint(staff, {
      member_id: member.entity, received_at: receivedAt, entity_contact: { email: member.email },
    });
    assertEq(r.status, 201, `intake (${body(r)})`);
    id = String(r.body.data.id);
    const c = await complaintRow(id);
    assert(c, "complaint row written");
    assertEq(ms(c.received_at), ms(receivedAt), "received_at is the supplied receipt time, not now");
    assertEq(daysBetween(c.received_at, c.ack_due_at), 5, "acknowledge within 5 days of receipt");
    assertEq(ms(r.body.data.ack_due_at), ms(c.ack_due_at), "the response carries the ack deadline");
    assertEq(daysBetween(c.received_at, c.initial_response_due_at), 15, "initial response within 15 days");
    assertEq(daysBetween(c.received_at, c.final_response_due_at), 30, "final response within 30 days");
    assert(ms(c.ack_due_at) < Date.now() + 5 * DAY_MS - DAY_MS, "three days of the ack window are already burned");
    assertEq(c.portal_due_date, null, "a direct complaint has no portal deadline");
    assertEq(c.member_id, member.entity, "the complaint names the member");
    assertEq(c.entity_contact?.email, member.email, "MP-04: the contact route is captured at intake");
    assertEq(c.provenance, "demo", "test-actor evidence is labelled demo");
  });

  await t.step("intake evidence: logged, received, both due-date events, direct-channel event — and no regulator/privacy events", async () => {
    const ev = await eventsFor("complaint", id);
    for (const code of [
      "complaint.logged", "complaint.received", "complaint.ack_due_at",
      "complaint.initial.response.due_at", "complaint.direct.received",
    ]) assert(ev.has(code), `${code} emitted (got ${[...ev.keys()]})`);
    assert(!ev.has("complaint.regulator.received"), "a direct complaint is not a regulator complaint");
    assert(!ev.has("complaint.privacy.received"), "a fees complaint raises no privacy event");
    assertEq(ev.get("complaint.received").payload["complaint.category"], "fees", "category on the event");
    assertEq(ev.get("complaint.logged").provenance, "demo", "event labelled demo");
  });

  await t.step("acknowledge inside the window: recorded, and the record says it was ON TIME", async () => {
    const r = await api("POST", `/complaints/${id}/acknowledge`, { acknowledged_by: "member_services_flow" }, { key: staff });
    assertEq(r.status, 200, `acknowledge (${body(r)})`);
    assert((await complaintRow(id)).acknowledged_at, "acknowledged_at stamped");
    const ev = (await eventsFor("complaint", id)).get("complaint.acknowledged");
    assert(ev, "complaint.acknowledged emitted");
    assertEq(ev.payload.acknowledged_late, false, "on-time acknowledgement is recorded as not late");
    assertEq(ev.payload.acknowledged_by, "member_services_flow", "who acknowledged it");
  });

  await t.step("it cannot be resolved before the member is told the outcome (409), and nothing changes", async () => {
    const r = await api("POST", `/complaints/${id}/resolve`, { root_cause_tag: "duplicate_fee" }, { key: staff });
    assertEq(r.status, 409, `early resolve (${body(r)})`);
    assertEq(r.body.type, "complaint_not_answered", "typed refusal");
    const c = await complaintRow(id);
    assertEq(c.resolved_at, null, "still unresolved");
    assertEq(c.root_cause_tag, null, "no root cause recorded by a refused resolve");
    assert(!(await eventsFor("complaint", id)).has("complaint.resolved"), "no resolved event");
  });

  await t.step("a response with no content is refused — it would only be a status change", async () => {
    const r = await api("POST", `/complaints/${id}/response`, { stage: "final" }, { key: staff });
    assertEq(r.status, 400, `empty response (${body(r)})`);
    assert(JSON.stringify(r.body).includes("body_ref"), "the refusal names body_ref");
    assertEq((await complaintRow(id)).final_response_sent_at, null, "no response recorded");
  });

  await t.step("the INITIAL response is its own obligation: it does not discharge the final one", async () => {
    const r = await api("POST", `/complaints/${id}/response`, { stage: "initial", body_ref: "doc_initial_flow" }, { key: staff });
    assertEq(r.status, 200, `initial response (${body(r)})`);
    assertEq(r.body.data.stage, "initial", "stage echoed");
    const c = await complaintRow(id);
    assert(c.initial_response_sent_at, "initial_response_sent_at stamped");
    assertEq(c.final_response_sent_at, null, "the final response is still owed");
    const ev = await eventsFor("complaint", id);
    assertEq(ev.get("complaint.initial_response.sent")?.payload.sent_late, false, "initial response on time");
    assertEq(ev.get("complaint.initial_response.sent")?.payload.body_ref, "doc_initial_flow", "content reference kept");
    assert(!ev.has("complaint.final_response.sent"), "no final-response event yet");
  });

  await t.step("the FINAL response tells the member the outcome", async () => {
    const r = await api("POST", `/complaints/${id}/response`, { stage: "final", body_ref: "doc_final_flow" }, { key: staff });
    assertEq(r.status, 200, `final response (${body(r)})`);
    assert((await complaintRow(id)).final_response_sent_at, "final_response_sent_at stamped");
    assertEq((await eventsFor("complaint", id)).get("complaint.final_response.sent")?.payload.sent_late, false,
      "final response on time");
  });

  await t.step("resolving with NO root cause is refused — it would empty the trend analysis", async () => {
    const r = await api("POST", `/complaints/${id}/resolve`, { investigation_notes: "looked into it" }, { key: staff });
    assertEq(r.status, 400, `no root cause (${body(r)})`);
    assert(JSON.stringify(r.body).includes("root_cause_tag"), "the refusal names root_cause_tag");
    assertEq((await complaintRow(id)).resolved_at, null, "still unresolved");
    assert(!(await eventsFor("complaint", id)).has("complaint.resolved"), "no resolved event");
  });

  await t.step("resolve with a root cause: resolved, root cause + notes on the row and the event trail", async () => {
    const r = await api("POST", `/complaints/${id}/resolve`,
      { root_cause_tag: "duplicate_fee", investigation_notes: "fee engine posted twice on retry" }, { key: staff });
    assertEq(r.status, 200, `resolve (${body(r)})`);
    const c = await complaintRow(id);
    assert(c.resolved_at, "resolved_at stamped");
    assertEq(c.root_cause_tag, "duplicate_fee", "root cause on the row");
    assertEq(c.investigation_notes, "fee engine posted twice on retry", "investigation notes kept");
    const ev = await eventsFor("complaint", id);
    assertEq(ev.get("complaint.investigation.completed")?.payload["complaint.root_cause_tag"], "duplicate_fee",
      "investigation.completed carries the root cause");
    assertEq(ev.get("complaint.resolved")?.payload["complaint.root_cause_tag"], "duplicate_fee",
      "resolved event carries the root cause");
    assertEq(ev.get("complaint.resolved")?.payload["complaint.udaap_flag"], false, "UDAAP flag on the resolution");
  });

  await t.step("acting on a complaint that does not exist is a 404", async () => {
    const r = await api("POST", `/complaints/cmpl_${crypto.randomUUID()}/acknowledge`, {}, { key: staff });
    assertEq(r.status, 404, `unknown complaint (${body(r)})`);
  });
});

// ------------------------------------------- regulator / portal / privacy

flow("complaints: a regulator complaint must name the regulator, gets the 60-day clock AND the portal's shorter deadline; privacy complaints raise their own event", async (t) => {
  const staff = await actor("cu_admin");

  await t.step("a regulator-channel complaint that does not name the regulator is refused", async () => {
    const marker = `noreg-${uid()}`;
    const r = await api("POST", "/complaints",
      { channel: "regulator", category: "other", narrative: `flow: ${marker}` }, { key: staff });
    assertEq(r.status, 400, `no regulator (${body(r)})`);
    assert(JSON.stringify(r.body).includes("regulator"), "the refusal names the regulator field");
    assertEq(await complaintsNarrated(marker), 0, "nothing written");
  });

  await t.step("a CFPB complaint: 60-day final clock, a 15-day portal deadline tracked separately, regulator event", async () => {
    const caseId = `CFPB-${uid()}`;
    const r = await logComplaint(staff, {
      channel: "regulator", category: "fair_lending", regulator: "CFPB", regulator_case_id: caseId,
      udaap_flag: true,
    });
    assertEq(r.status, 201, `intake (${body(r)})`);
    const id = String(r.body.data.id);
    const c = await complaintRow(id);
    assertEq(daysBetween(c.received_at, c.final_response_due_at), 60, "regulator complaints get the 60-day final clock");
    assert(c.portal_due_date, "the portal's own deadline is tracked");
    // the live column is a calendar DATE (core_schema.sql created it first), so
    // the portal deadline is the date 15 days after receipt, not an instant
    assertEq(String(c.portal_due_date).slice(0, 10), utcDate(ms(c.received_at) + 15 * DAY_MS), "portal deadline is 15 days");
    assert(ms(c.portal_due_date) < ms(c.final_response_due_at), "the portal deadline is the SHORTER one");
    assertEq(c.regulator, "CFPB", "regulator named");
    assertEq(c.regulator_case_id, caseId, "regulator case id kept");
    assertEq(c.udaap_flag, true, "UDAAP flag captured at intake");
    const ev = await eventsFor("complaint", id);
    const reg = ev.get("complaint.regulator.received");
    assert(reg, `complaint.regulator.received emitted (got ${[...ev.keys()]})`);
    assertEq(reg.payload["complaint.regulator_case_id"], caseId, "case id on the regulator event");
    assertEq(ms(reg.payload.final_response_due_at), ms(c.final_response_due_at), "regulator event carries the 60-day deadline");
    assert(!ev.has("complaint.direct.received"), "a regulator complaint is not a direct one");
  });

  await t.step("a portal-channel complaint carries the portal deadline but keeps the ordinary 30-day final clock", async () => {
    const r = await logComplaint(staff, { channel: "portal", category: "service" });
    assertEq(r.status, 201, `intake (${body(r)})`);
    const c = await complaintRow(String(r.body.data.id));
    assertEq(String(c.portal_due_date).slice(0, 10), utcDate(ms(c.received_at) + 15 * DAY_MS), "portal deadline 15 days");
    assertEq(daysBetween(c.received_at, c.final_response_due_at), 30, "ordinary final clock");
  });

  await t.step("PR-10: a privacy complaint raises complaint.privacy.received", async () => {
    const r = await logComplaint(staff, { channel: "phone", category: "privacy", narrative: `flow: shared my data ${uid()}` });
    assertEq(r.status, 201, `intake (${body(r)})`);
    const ev = await eventsFor("complaint", String(r.body.data.id));
    assert(ev.has("complaint.privacy.received"), `privacy event (got ${[...ev.keys()]})`);
    assertEq(ev.get("complaint.privacy.received").payload["complaint.category"], "privacy", "category on the event");
  });
});

// ------------------------------------------------------- late handling

flow("complaints: a complaint left past every deadline is acknowledged and answered LATE — and the record says so", async (t) => {
  const staff = await actor("cu_admin");
  let id = "";

  await t.step("log a complaint received 40 days ago (every deadline already passed)", async () => {
    const r = await logComplaint(staff, { channel: "branch", category: "service", received_at: iso(-40) });
    assertEq(r.status, 201, `intake (${body(r)})`);
    id = String(r.body.data.id);
    const c = await complaintRow(id);
    assert(ms(c.final_response_due_at) < Date.now(), "the final-response deadline has passed");
  });

  await t.step("the acknowledgement is recorded as LATE", async () => {
    const r = await api("POST", `/complaints/${id}/acknowledge`, { acknowledged_by: "member_services_flow" }, { key: staff });
    assertEq(r.status, 200, `acknowledge (${body(r)})`);
    assertEq((await eventsFor("complaint", id)).get("complaint.acknowledged")?.payload.acknowledged_late, true,
      "late acknowledgement is part of the record");
  });

  await t.step("initial and final responses are each recorded as LATE against their own deadline", async () => {
    for (const stage of ["initial", "final"]) {
      const r = await api("POST", `/complaints/${id}/response`, { stage, body_ref: `doc_${stage}_late` }, { key: staff });
      assertEq(r.status, 200, `${stage} response (${body(r)})`);
    }
    const ev = await eventsFor("complaint", id);
    assertEq(ev.get("complaint.initial_response.sent")?.payload.sent_late, true, "initial response late");
    assertEq(ev.get("complaint.final_response.sent")?.payload.sent_late, true, "final response late");
  });

  await t.step("it still resolves once answered and root-caused — lateness is recorded, not hidden", async () => {
    const r = await api("POST", `/complaints/${id}/resolve`, { root_cause_tag: "staffing_backlog" }, { key: staff });
    assertEq(r.status, 200, `resolve (${body(r)})`);
    assertEq((await complaintRow(id)).root_cause_tag, "staffing_backlog", "root cause recorded");
  });
});

// ------------------------------------------------------- Reg E disputes

flow("complaints: Reg E dispute on a member's account → its OWN clocks → provisional credit (late) → resolved with findings", async (t) => {
  const partner = await actor("partner");
  const staff = await actor("cu_admin");
  const OPENING = 100_000;
  const DISPUTED = 45_000;
  let member = { entity: "", account: "", email: "" };
  let complaintId = "";
  let disputeId = "";

  await t.step("the partner onboards the member with a $1,000 checking account", async () => {
    member = await onboardMember(partner, OPENING);
    assertEq(await balanceOf(partner, member.account), OPENING, "opening deposit landed");
  });

  await t.step("the member complains about an unauthorised debit (category: dispute)", async () => {
    const r = await logComplaint(staff, {
      category: "dispute", member_id: member.entity, narrative: `flow: card debit I never made ${uid()}`,
    });
    assertEq(r.status, 201, `intake (${body(r)})`);
    complaintId = String(r.body.data.id);
  });

  await t.step("a partner cannot open a dispute (404), and a dispute with no basis or a non-positive amount is refused", async () => {
    const p = await api("POST", "/disputes",
      { member_id: member.entity, account_id: member.account, basis: "unauthorised", amount_cents: 100 }, { key: partner });
    assertEq(p.status, 404, `partner dispute (${body(p)})`);
    for (const bad of [
      { member_id: member.entity, account_id: member.account, amount_cents: 100 },
      { member_id: member.entity, account_id: member.account, basis: "unauthorised", amount_cents: 0 },
      { member_id: member.entity, account_id: member.account, basis: "unauthorised", amount_cents: -5 },
    ]) {
      const r = await api("POST", "/disputes", bad, { key: staff });
      assertEq(r.status, 400, `refused dispute ${JSON.stringify(bad)} (${body(r)})`);
    }
    const rows = await core().from("dispute").select("id").eq("account_id", member.account);
    assertEq((rows.data ?? []).length, 0, "no dispute row written for the refusals");
  });

  await t.step("open the dispute, notified 12 days ago: 10-day provisional-credit and 45-day investigation clocks", async () => {
    const notifiedAt = iso(-12);
    const r = await api("POST", "/disputes", {
      complaint_id: complaintId, member_id: member.entity, account_id: member.account,
      basis: "unauthorised", amount_cents: DISPUTED, notified_at: notifiedAt,
      account_balance_cents: OPENING,
    }, { key: staff });
    assertEq(r.status, 201, `open dispute (${body(r)})`);
    disputeId = String(r.body.data.id);
    const d = await disputeRow(disputeId);
    assertEq(d.complaint_id, complaintId, "dispute linked to the complaint");
    assertEq(d.account_id, member.account, "dispute names the account");
    assertEq(Number(d.amount_cents), DISPUTED, "disputed amount");
    assertEq(ms(d.notified_at), ms(notifiedAt), "clocks anchor on notification");
    assertEq(daysBetween(d.notified_at, d.provisional_credit_due_at), 10, "provisional credit within 10 days");
    assertEq(daysBetween(d.notified_at, d.investigation_due_at), 45, "investigation within 45 days");
    const c = await complaintRow(complaintId);
    assert(ms(d.investigation_due_at) !== ms(c.final_response_due_at), "the dispute's clock is NOT the complaint's");
    assertEq(d.provenance, "demo", "labelled demo");
    const ev = await eventsFor("dispute", disputeId);
    assertEq(ev.get("dispute.opened")?.payload["dispute.basis"], "unauthorised", "dispute.opened with its basis");
    assertEq(ev.get("dispute.rege_clock.started")?.payload.days, 45, "Reg E clock started at 45 days");
    assertEq(ev.get("dispute.rege_clock.started")?.payload.extended, false, "not extended");
    assert(ev.has("dispute.provisional_credit_due_at"), "provisional-credit due event");
  });

  await t.step("a new-account / POS / foreign dispute gets the EXTENDED 90-day investigation window", async () => {
    const r = await api("POST", "/disputes", {
      member_id: member.entity, account_id: member.account, basis: "pos_foreign",
      amount_cents: 1_000, extended: true,
    }, { key: staff });
    assertEq(r.status, 201, `extended dispute (${body(r)})`);
    const d = await disputeRow(String(r.body.data.id));
    assertEq(daysBetween(d.notified_at, d.investigation_due_at), 90, "90 days, not 45");
    assertEq(daysBetween(d.notified_at, d.provisional_credit_due_at), 10, "provisional credit still 10 days");
    assertEq((await eventsFor("dispute", String(r.body.data.id))).get("dispute.rege_clock.started")?.payload.extended,
      true, "the clock event says extended");
  });

  await t.step("post provisional credit after the 10-day deadline: the amount is recorded and the posting is marked LATE", async () => {
    const r = await api("POST", `/disputes/${disputeId}/provisional-credit`, {}, { key: staff });
    assertEq(r.status, 200, `provisional credit (${body(r)})`);
    assertEq(r.body.data.amount_cents, DISPUTED, "defaults to the disputed amount");
    const d = await disputeRow(disputeId);
    assert(d.provisional_credit_posted_at, "posted_at stamped");
    assertEq(Number(d.provisional_credit_cents), DISPUTED, "provisional credit carries an amount");
    assertEq((await eventsFor("dispute", disputeId)).get("dispute.provisional_credit.posted")?.payload.posted_late, true,
      "late posting is part of the record");
  });

  await t.step("the provisional credit reaches the member's balance", async () => {
    // DEFECT: postProvisionalCredit records provisional_credit_cents but never credits the account in the ledger (complaints.ts postProvisionalCredit).
    assertEq(await balanceOf(partner, member.account), OPENING + DISPUTED,
      "Reg E provisional credit is money the member can use, not a column");
  });

  await t.step("a dispute cannot be closed without findings — the member must be told the basis", async () => {
    const r = await api("POST", `/disputes/${disputeId}/resolve`, { correction_amount_cents: DISPUTED }, { key: staff });
    assertEq(r.status, 400, `no findings (${body(r)})`);
    assert(JSON.stringify(r.body).includes("findings"), "the refusal names findings");
    const d = await disputeRow(disputeId);
    assertEq(d.resolved_at, null, "still open");
    assertEq(d.investigation_completed_at, null, "investigation not marked complete");
  });

  await t.step("resolve with findings: investigation complete, member told, resolved — with the correction amount", async () => {
    const r = await api("POST", `/disputes/${disputeId}/resolve`,
      { findings: "confirmed unauthorised: card-not-present fraud", correction_amount_cents: DISPUTED }, { key: staff });
    assertEq(r.status, 200, `resolve (${body(r)})`);
    const d = await disputeRow(disputeId);
    assert(d.investigation_completed_at, "investigation_completed_at");
    assert(d.response_sent_at, "the member was told");
    assert(d.resolved_at, "resolved_at");
    assertEq(d.findings, "confirmed unauthorised: card-not-present fraud", "findings kept");
    assertEq(Number(d.correction_amount_cents), DISPUTED, "correction amount kept");
    const ev = await eventsFor("dispute", disputeId);
    assertEq(ev.get("dispute.investigation.completed")?.payload.completed_late, false, "inside the 45-day window");
    assertEq(ev.get("dispute.response.sent")?.payload["dispute.findings"], "confirmed unauthorised: card-not-present fraud",
      "the response carries the findings");
    assertEq(ev.get("dispute.resolved")?.payload["dispute.correction_amount"], DISPUTED, "resolved with the correction");
  });

  await t.step("acting on a dispute that does not exist is a 404", async () => {
    const r = await api("POST", `/disputes/disp_${crypto.randomUUID()}/provisional-credit`, {}, { key: staff });
    assertEq(r.status, 404, `unknown dispute (${body(r)})`);
  });
});

// --------------------------------------------- FL-13 / PR-10 trends + Board

flow("complaints: the trend is COUNTED from the register by lens; a disparity over threshold opens a CAP; Board packs go ad hoc for a material privacy incident", async (t) => {
  const partner = await actor("partner");
  const staff = await actor("cu_admin");
  const period = `flow-${uid()}`;
  let overdueId = "";

  await t.step("trend reporting is staff-only: a partner gets 404", async () => {
    const r = await api("POST", "/complaints/trends", { period, lens: "enterprise" }, { key: partner });
    assertEq(r.status, 404, `partner trend (${body(r)})`);
  });

  await t.step("log fee, privacy, and one long-overdue unresolved complaint", async () => {
    for (const category of ["fees", "fees", "privacy"]) {
      assertEq((await logComplaint(staff, { category })).status, 201, `log ${category}`);
    }
    const old = await logComplaint(staff, { category: "service", received_at: iso(-90) });
    assertEq(old.status, 201, `log overdue (${body(old)})`);
    overdueId = String(old.body.data.id);
  });

  await t.step("enterprise trend: totals are counted from the register — a supplied total is ignored", async () => {
    const before = await countComplaints();
    const feesBefore = await countComplaints((q) => q.eq("category", "fees"));
    const now = new Date().toISOString();
    const overdueBefore = await countComplaints((q) => q.is("resolved_at", null).lt("final_response_due_at", now));
    const r = await api("POST", "/complaints/trends", { period, lens: "enterprise", total: 999 }, { key: staff });
    assertEq(r.status, 201, `trend (${body(r)})`);
    const after = await countComplaints();
    const tr = (await core().from("complaint_trend").select("*").eq("id", r.body.data.id).single()).data as Any;
    assert(tr, "complaint_trend row written");
    assert(tr.total >= before && tr.total <= after, `total ${tr.total} counted from the register (${before}..${after}), not supplied`);
    assertEq(r.body.data.total, tr.total, "response total matches the row");
    assert(tr.by_category.fees >= feesBefore, `fees counted (${tr.by_category.fees} >= ${feesBefore})`);
    assert(tr.overdue_count >= 1, "our unresolved 90-day-old complaint counts as overdue");
    assert(tr.overdue_count >= overdueBefore - 2 && tr.overdue_count <= overdueBefore + 2,
      `overdue ${tr.overdue_count} counted from the register (~${overdueBefore})`);
    assertEq(tr.breached, null, "no threshold, no verdict");
    assertEq(tr.provenance, "demo", "labelled demo");
    const ev = await eventsFor("complaint_trend", tr.id);
    assertEq(ev.get("complaint.trend.reported")?.payload["complaint.trend_summary"]?.total, tr.total,
      "trend.reported carries the counted total");
  });

  await t.step("the lens filters: a privacy trend counts privacy complaints only", async () => {
    const privacyBefore = await countComplaints((q) => q.eq("category", "privacy"));
    const r = await api("POST", "/complaints/trends", { period, lens: "privacy" }, { key: staff });
    assertEq(r.status, 201, `privacy trend (${body(r)})`);
    const privacyAfter = await countComplaints((q) => q.eq("category", "privacy"));
    const tr = (await core().from("complaint_trend").select("*").eq("id", r.body.data.id).single()).data as Any;
    assertEq(Object.keys(tr.by_category).join(","), "privacy", "only privacy complaints in a privacy lens");
    assert(tr.total >= privacyBefore && tr.total <= privacyAfter, `privacy total ${tr.total} (${privacyBefore}..${privacyAfter})`);
  });

  await t.step("FL-13: a cohort disparity above the threshold breaches, opens a CAP and a fair-lending remediation", async () => {
    const r = await api("POST", "/complaints/trends",
      { period, lens: "fair_lending", threshold_bp: 500, cohorts: { cohort_a: 200, cohort_b: 900 } }, { key: staff });
    assertEq(r.status, 201, `breach trend (${body(r)})`);
    assertEq(r.body.data.breached, true, "breached on the response");
    const tr = (await core().from("complaint_trend").select("*").eq("id", r.body.data.id).single()).data as Any;
    assertEq(tr.disparity_bp, 700, "disparity computed from the cohorts");
    assertEq(tr.threshold_bp, 500, "threshold recorded");
    assertEq(tr.breached, true, "breach recorded");
    assert(tr.cap_opened_at, "CAP opened_at stamped");
    const ev = await eventsFor("complaint_trend", tr.id);
    assertEq(ev.get("analytics.cap.opened")?.payload.disparity_bp, 700, "analytics.cap.opened");
    assertEq(ev.get("fair_lending.remediation.opened")?.payload.source, "complaint_disparity", "fair_lending.remediation.opened");
  });

  await t.step("FL-13: with NO threshold set, the same disparity yields no verdict and opens nothing", async () => {
    const p2 = `${period}-nothr`;
    const r = await api("POST", "/complaints/trends",
      { period: p2, lens: "fair_lending", cohorts: { cohort_a: 200, cohort_b: 900 } }, { key: staff });
    assertEq(r.status, 201, `unset-threshold trend (${body(r)})`);
    assertEq(r.body.data.breached, null, "no verdict rather than a pass");
    const tr = (await core().from("complaint_trend").select("*").eq("id", r.body.data.id).single()).data as Any;
    assertEq(tr.breached, null, "breached is null on the row");
    assertEq(tr.cap_opened_at, null, "no CAP");
    const ev = await eventsFor("complaint_trend", tr.id);
    assert(!ev.has("analytics.cap.opened"), "no analytics.cap.opened");
    assert(!ev.has("fair_lending.remediation.opened"), "no remediation");
  });

  await t.step("PR-10: the quarterly privacy Board pack is delivered — with no ad hoc report", async () => {
    const before = await countComplaints();
    const r = await api("POST", "/complaints/board-report", { period, audience: "privacy" }, { key: staff });
    assertEq(r.status, 201, `board report (${body(r)})`);
    const after = await countComplaints();
    assert(r.body.data.complaints >= before && r.body.data.complaints <= after, "pack counts the register");
    const id = String(r.body.data["privacy.metrics_package_id"]);
    const ev = await eventsFor("complaint_trend", id);
    assert(ev.has("privacy.board_report.delivered"), `privacy.board_report.delivered (got ${[...ev.keys()]})`);
    assert(!ev.has("privacy.board_adhoc.delivered"), "no ad hoc report without a material incident");
  });

  await t.step("PR-10: a MATERIAL privacy incident goes to the Board ad hoc, naming the incident", async () => {
    const incident = `inc_flow_${uid()}`;
    const r = await api("POST", "/complaints/board-report",
      { period: `${period}-adhoc`, audience: "privacy", adhoc: true, material_incident_id: incident }, { key: staff });
    assertEq(r.status, 201, `ad hoc board report (${body(r)})`);
    const ev = await eventsFor("complaint_trend", String(r.body.data["privacy.metrics_package_id"]));
    assertEq(ev.get("privacy.board_adhoc.delivered")?.payload.incident_id, incident, "ad hoc delivery names the incident");
  });

  await t.step("cleanup: the overdue complaint is answered and resolved, leaving the register clean", async () => {
    for (const stage of ["initial", "final"]) {
      assertEq((await api("POST", `/complaints/${overdueId}/response`, { stage, body_ref: "doc_flow" }, { key: staff })).status,
        200, `${stage} response`);
    }
    const r = await api("POST", `/complaints/${overdueId}/resolve`, { root_cause_tag: "flow_fixture" }, { key: staff });
    assertEq(r.status, 200, `resolve (${body(r)})`);
  });
});
