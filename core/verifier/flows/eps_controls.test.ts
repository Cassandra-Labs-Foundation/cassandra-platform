// EPS controls flows: the electronic-payment-systems programme as operations
// runs it — EPS-05 authentication lockout, EPS-07 card controls and positive
// pay with the fraud-trend review, and the EPS lifecycle from tail.ts: EPS-01
// new-service proposals gated on ERM, EPS-03 control reviews that open
// remediation, EPS-10 deployments with rollback and emergency approval, and
// EPS-06 wire release / ACH check results / client limit changes / positive-pay
// items. Ports core/supabase/functions/api/eps_controls.test.ts and the EPS
// half of tail.test.ts (see ledger/eps_controls.md and ledger/tail.md). The
// EPS-06 dual-control half (client limit, ACH/wire approvals) is eps.test.ts's.
//
// SHARED-STATE DISCIPLINE. Every authentication subject, card, check item,
// service, wire and partner reference here is run-unique; lockouts are applied
// only to subjects this flow invents, never to a real member. The fraud-trend
// review reads the whole positive-pay register (oldest cutoff first, 200 rows),
// so this flow's exceptions use 1900s cutoffs to sit inside that window and are
// deleted when the flow ends. No institution-wide setting is changed.
import { actor, type Any, api, assert, assertEq, core, flow } from "./helpers.ts";

const RUN = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
let seq = 0;
const rid = (p: string) => `${p}_flow_${RUN}_${++seq}`;

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const DAY = 86_400_000;
const ms = (s: unknown) => Date.parse(String(s));

async function rowById(table: string, id: string): Promise<Any> {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data;
}
async function rowsWhere(table: string, col: string, val: string): Promise<Any[]> {
  const r = await core().from(table).select("*").eq(col, val);
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data ?? [];
}
async function eventsFor(resourceType: string, id: string): Promise<Any[]> {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("resource_id", `${resourceType}:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  return r.data ?? [];
}
const codesFor = async (resourceType: string, id: string) =>
  (await eventsFor(resourceType, id)).map((e) => String(e.code));

/** the api_token id helpers.actor() derives from the plaintext it returns */
const tokenIdOf = (plaintext: string, actorType: string) =>
  `tok_test_${actorType}_${plaintext.slice("cass_test_".length, "cass_test_".length + 12)}`;

function refusedToPartner(r: { status: number; body: Any }, what: string) {
  assert(r.status === 404 || r.status === 403, `${what}: partner refused (got ${r.status} ${body(r)})`);
}

// ============================================================ EPS-05

flow("eps_controls: EPS-05 — online-banking logins: the third consecutive failure locks the member out in the same write, a success resets the chain, and a challenge records how", async (t) => {
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  const alice = rid("mbr_auth_alice"); // will be locked out
  const bob = rid("mbr_auth_bob"); // fail, fail, success, fail
  const cara = rid("mbr_auth_cara"); // challenged
  const dan = rid("mbr_auth_dan"); // succeeds
  const attempt = (subject: string, outcome: string, o: Record<string, unknown> = {}, key = ops) =>
    api("POST", "/eps/auth", { subject_ref: subject, channel: "online", outcome, ...o }, { key });

  await t.step("a partner cannot post authentication decisions; an attempt with no usable outcome is refused and writes nothing", async () => {
    refusedToPartner(await attempt(alice, "failure", {}, partner), "auth event");
    const r = await attempt(alice, "maybe");
    assertEq(r.status, 400, `bad outcome (${body(r)})`);
    assertEq((await rowsWhere("eps_auth_event", "subject_ref", alice)).length, 0, "no auth rows");
  });

  await t.step("a success is allowed and carries a zero failure count", async () => {
    const r = await attempt(dan, "success");
    assertEq(r.status, 201, `success (${body(r)})`);
    assertEq(r.body.data.decision, "allowed", "allowed");
    assertEq(r.body.data.failure_count, 0, "zero failures");
    assert(!(await codesFor("eps_auth", r.body.data.id)).includes("eps.auth_lockout.applied"), "no lockout");
  });

  await t.step("three consecutive failures: denied, denied, LOCKED OUT — the lockout is stamped in the same write", async () => {
    const decisions: string[] = [];
    let last: Any = null;
    for (let i = 0; i < 3; i++) {
      const r = await attempt(alice, "failure");
      assertEq(r.status, 201, `failure ${i + 1} (${body(r)})`);
      decisions.push(r.body.data.decision);
      last = r.body.data;
    }
    assertEq(decisions.join(","), "denied,denied,locked_out", "the third failure locks out");
    const row = await rowById("eps_auth_event", last.id);
    assertEq(row.failure_count, 3, "three consecutive failures");
    assert(row.locked_out_at, "lockout stamped on the row that crossed the threshold");
    const codes = await codesFor("eps_auth", last.id);
    assert(codes.includes("eps.auth_lockout.applied"), "lockout event");
    assert(codes.includes("eps.auth.failure_count"), "failure count event");
  });

  await t.step("a success RESETS the chain: fail, fail, success, fail is denied with one failure — not locked", async () => {
    const outs = ["failure", "failure", "success", "failure"];
    let last: Any = null;
    for (const o of outs) {
      const r = await attempt(bob, o);
      assertEq(r.status, 201, `${o} (${body(r)})`);
      last = r.body.data;
    }
    assertEq(last.decision, "denied", "denied, not locked out");
    assertEq(last.failure_count, 1, "the chain restarted at the success");
    for (const row of await rowsWhere("eps_auth_event", "subject_ref", bob)) {
      assert(!row.locked_out_at, `no lockout on ${row.id}`);
      assert(!(await codesFor("eps_auth", row.id)).includes("eps.auth_lockout.applied"), `no lockout event on ${row.id}`);
    }
  });

  await t.step("every attempt is its own record: Bob's four attempts leave four auth rows in order", async () => {
    const rows = (await rowsWhere("eps_auth_event", "subject_ref", bob)).sort((a, b) => a.chain_seq - b.chain_seq);
    // DEFECT: eps_auth_event ids are epsauth_<subject>_<failure_count>_<outcome>; Bob's fourth attempt (count 1) upserts over his first, so the audit trail keeps 3 rows and the denial emits no new events.
    assertEq(rows.length, 4, `four attempts recorded (got ${rows.map((r) => `${r.chain_seq}:${r.decision}`).join(",")})`);
  });

  await t.step("a lockout is not forever: Alice's next success is allowed and a later failure starts a fresh chain", async () => {
    const ok = await attempt(alice, "success");
    assertEq(ok.status, 201, `success after lockout (${body(ok)})`);
    assertEq(ok.body.data.decision, "allowed", "allowed after lockout");
    const f = await attempt(alice, "failure");
    assertEq(f.body.data.decision, "denied", "denied, not locked out");
    assertEq(f.body.data.failure_count, 1, "fresh chain");
  });

  await t.step("a challenged failure records HOW the member was challenged, on the row and the event", async () => {
    const r = await attempt(cara, "failure", { challenge_method: "otp_sms" });
    assertEq(r.status, 201, `challenge (${body(r)})`);
    assertEq(r.body.data.decision, "challenged", "challenged");
    const row = await rowById("eps_auth_event", r.body.data.id);
    assertEq(row.challenge_method, "otp_sms", "method on the row");
    const ev = (await eventsFor("eps_auth", r.body.data.id)).find((e) => e.code === "eps.auth.challenged");
    assertEq(ev?.payload?.challenge_method, "otp_sms", "method on the event");
    assertEq(ev?.provenance, "demo", "demo evidence");
  });
});

// ============================================================ EPS-07 card controls

flow("eps_controls: EPS-07 — a member's card controls: the first application is not a 'change', and every later change carries the value it replaced", async (t) => {
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  const card = rid("card");
  const apply = (value: string, key = ops) =>
    api("POST", "/eps/card-controls", { card_ref: card, control_type: "travel", new_value: value, applied_by: "ops_flow" }, { key });

  await t.step("a partner cannot apply card controls; a control with missing fields is refused", async () => {
    refusedToPartner(await apply("on", partner), "card control");
    const r = await api("POST", "/eps/card-controls", { card_ref: card, control_type: "travel" }, { key: ops });
    assertEq(r.status, 400, `missing fields (${body(r)})`);
    assertEq((await rowsWhere("eps_card_control", "card_ref", card)).length, 0, "nothing stored");
  });

  await t.step("the FIRST application of travel mode has no previous value and is not reported as a change", async () => {
    const r = await apply("on");
    assertEq(r.status, 201, `apply (${body(r)})`);
    assertEq(r.body.data.previous_value, null, "no previous value");
    const codes = await codesFor("eps_card_control", r.body.data.id);
    assert(codes.includes("eps.card_control.applied"), "applied event");
    assert(!codes.includes("eps.card_control.changed"), "not a change");
  });

  await t.step("turning it off is a change that carries the value it replaced", async () => {
    const r = await apply("off");
    assertEq(r.status, 201, `change (${body(r)})`);
    assertEq(r.body.data.previous_value, "on", "previous on the row");
    const ev = (await eventsFor("eps_card_control", r.body.data.id)).find((e) => e.code === "eps.card_control.changed");
    assertEq(ev?.payload?.previous_value, "on", "previous on the event");
    assertEq(ev?.payload?.new_value, "off", "new on the event");
  });

  await t.step("toggling back and forth: on again replaces off, and off again replaces on", async () => {
    const on = await apply("on");
    assertEq(on.body.data.previous_value, "off", "on again replaced off");
    const off = await apply("off");
    // DEFECT: card-control rows are keyed epscc_<card>_<type>_<value> and the prior value is read by created_at, which an upsert never advances; the second 'off' reads itself as the prior value ("off") and reports no change.
    assertEq(off.body.data.previous_value, "on", `off again replaced on (${body(off)})`);
  });
});

// ============================================================ EPS-07 positive pay

flow("eps_controls: EPS-07 — positive-pay exceptions are decided once, completely, by someone; a late decision is marked late; the fraud review names every undecided exception that paid by default", async (t) => {
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  const account = rid("acct");
  const items = { timely: rid("chk_timely"), late: rid("chk_late"), old: rid("chk_old"), done: rid("chk_done"), open: rid("chk_open") };
  const exId = (item: string) => `epspp_${item}`;
  const present = (item: string, cutoff: string, key = ops) =>
    api("POST", "/eps/pospay", { account_ref: account, item_ref: item, amount_cents: 125_000, reason: "payee mismatch", cutoff_at: cutoff }, { key });
  const decide = (item: string, decision: string, by = "ops_flow") =>
    api("POST", `/eps/pospay/${exId(item)}/decide`, { decision, decided_by: by }, { key: ops });

  try {
    await t.step("a partner cannot present exceptions; an exception missing its cutoff is refused", async () => {
      refusedToPartner(await present(items.timely, "2099-01-01T00:00:00Z", partner), "pospay exception");
      const r = await api("POST", "/eps/pospay", { account_ref: account, item_ref: items.timely, amount_cents: 1, reason: "r" }, { key: ops });
      assertEq(r.status, 400, `no cutoff (${body(r)})`);
      assertEq(await rowById("eps_pospay_exception", exId(items.timely)), null, "nothing stored");
    });

    await t.step("a $1,250 payee-mismatch exception is presented with its cutoff", async () => {
      const r = await present(items.timely, "2099-01-01T00:00:00Z");
      assertEq(r.status, 201, `present (${body(r)})`);
      const row = await rowById("eps_pospay_exception", exId(items.timely));
      assertEq(row.decision, null, "undecided");
      assertEq(ms(row.decision_cutoff_at), ms("2099-01-01T00:00:00Z"), "cutoff stored");
      assert((await codesFor("eps_pospay", exId(items.timely))).includes("eps.pospay_exception.presented"), "presented event");
    });

    await t.step("a decision must be pay or return and name the decider; deciding a nonexistent exception is 404 with no phantom event", async () => {
      const bad = await decide(items.timely, "shrug");
      assertEq(bad.status, 400, `bad decision (${body(bad)})`);
      const anon = await api("POST", `/eps/pospay/${exId(items.timely)}/decide`, { decision: "return" }, { key: ops });
      assertEq(anon.status, 400, `no decider (${body(anon)})`);
      const ghostItem = rid("chk_ghost");
      const ghost = await decide(ghostItem, "return");
      assertEq(ghost.status, 404, `ghost (${body(ghost)})`);
      assertEq((await codesFor("eps_pospay", exId(ghostItem))).length, 0, "no event about nothing");
    });

    await t.step("operations returns the item: decision, decider and timestamp land together, on time", async () => {
      const r = await decide(items.timely, "return");
      assertEq(r.status, 200, `decide (${body(r)})`);
      assertEq(r.body.data.past_cutoff, false, "on time");
      const row = await rowById("eps_pospay_exception", exId(items.timely));
      assertEq(row.decision, "return", "decision");
      assertEq(row.decided_by, "ops_flow", "decider");
      assert(row.decided_at, "decided_at");
      assert((await codesFor("eps_pospay", exId(items.timely))).includes("eps.pospay_exception.decided"), "decided event");
    });

    await t.step("a decision is decided ONCE: a second attempt is 409 and the first survives untouched", async () => {
      const r = await decide(items.timely, "pay", "ops_other");
      assertEq(r.status, 409, `second decision (${body(r)})`);
      assertEq(r.body.type, "already_decided", "typed refusal");
      const row = await rowById("eps_pospay_exception", exId(items.timely));
      assertEq(row.decision, "return", "first decision kept");
      assertEq(row.decided_by, "ops_flow", "first decider kept");
    });

    await t.step("a decision past the cutoff is recorded as LATE — the default-pay already happened", async () => {
      assertEq((await present(items.late, "1900-01-02T00:00:00Z")).status, 201, "present late item");
      const r = await decide(items.late, "return");
      assertEq(r.status, 200, `late decision (${body(r)})`);
      assertEq(r.body.data.past_cutoff, true, "marked past cutoff");
      const ev = (await eventsFor("eps_pospay", exId(items.late))).find((e) => e.code === "eps.pospay_exception.decided");
      assertEq(ev?.payload?.past_cutoff, true, "the evidence says late");
    });

    await t.step("the fraud-trend review names the undecided exception past its cutoff — and not the decided or still-open ones", async () => {
      assertEq((await present(items.old, "1900-01-01T00:00:00Z")).status, 201, "old undecided");
      assertEq((await present(items.done, "1900-01-01T00:00:00Z")).status, 201, "old decided");
      assertEq((await decide(items.done, "pay")).status, 200, "decide in time (recorded)");
      assertEq((await present(items.open, "2099-01-01T00:00:00Z")).status, 201, "future undecided");
      const p = await api("POST", "/eps/fraud-review", {}, { key: partner });
      refusedToPartner(p, "fraud review");
      const r = await api("POST", "/eps/fraud-review", {}, { key: ops });
      assertEq(r.status, 200, `review (${body(r)})`);
      const ids: string[] = r.body.data.undecided_past_cutoff_ids;
      assert(ids.includes(exId(items.old)), `paid-by-default item named (${ids.join(",")})`);
      for (const k of ["done", "late", "timely"] as const) assert(!ids.includes(exId(items[k])), `${k} is decided, not listed`);
      assert(!ids.includes(exId(items.open)), "an exception still inside its window is not listed");
      assertEq(r.body.data.undecided_past_cutoff, ids.length, "the count is the named list");
      assert(r.body.data.note, "paid-by-default is reported by name with a note");
      const today = new Date().toISOString().slice(0, 10);
      assertEq((await rowById("event", `ev_fraudrev_${today}`))?.code, "eps.fraud_trend_review.completed", "the review is evidence");
    });
  } finally {
    const d = await core().from("eps_pospay_exception").delete().eq("account_ref", account);
    if (d.error) console.error(`cleanup eps_pospay_exception: ${d.error.message}`);
  }
});

// ============================================================ EPS-01

flow("eps_controls: EPS-01 — a sponsor proposes a new payment service; its inherent risk joins the enterprise register, and it cannot go live until ERM approves", async (t) => {
  const ops = await actor("cu_admin");
  const partner = await actor("partner");
  const svc = rid("svc_rtp");
  const id = `epsprop_${svc}`;
  const propose = (o: Record<string, unknown>, key = ops) =>
    api("POST", "/eps/proposals", { service_id: svc, sponsor: "vp_payments", ...o }, { key });

  await t.step("a partner cannot propose services; a proposal with no sponsor is refused", async () => {
    refusedToPartner(await propose({}, partner), "proposal");
    const r = await api("POST", "/eps/proposals", { service_id: svc }, { key: ops });
    assertEq(r.status, 400, `no sponsor (${body(r)})`);
  });

  await t.step("activation before ERM approval is refused — the gate is the ACTIVATION", async () => {
    const r = await propose({ activate: true });
    assertEq(r.status, 409, `activate unapproved (${body(r)})`);
    assertEq(r.body.type, "activation_before_erm", "typed refusal");
    assertEq(await rowById("eps_proposal", id), null, "nothing stored");
  });

  await t.step("the proposal with an inherent score of 7 is submitted: the score lands in the ENTERPRISE risk register as high", async () => {
    const r = await propose({ inherent_score: 7, study_doc: "rtp-study-v1" });
    assertEq(r.status, 201, `propose (${body(r)})`);
    const row = await rowById("eps_proposal", id);
    assertEq(row.activated_at, null, "not live");
    assertEq(row.erm_review_decision, null, "no ERM decision yet");
    const risk = await rowById("risk", `risk_eps_${svc}`);
    assertEq(risk?.inherent_score, 7, "score in the register");
    assertEq(risk?.inherent_rating, "high", "rated high");
    const codes = await codesFor("eps_proposal", id);
    for (const c of ["eps.proposal.submitted", "eps.product_risk_analysis.drafted", "eps.risk_assessment_service.added"]) assert(codes.includes(c), `${c} emitted`);
  });

  await t.step("an ERM decision names its reviewer; a rejected service still cannot activate", async () => {
    const anon = await propose({ inherent_score: 7, erm_decision: "approved" });
    assertEq(anon.status, 400, `no reviewer (${body(anon)})`);
    const rej = await propose({ inherent_score: 7, erm_decision: "rejected", erm_reviewed_by: "erm_flow", activate: true });
    assertEq(rej.status, 409, `activate rejected (${body(rej)})`);
    assertEq((await rowById("eps_proposal", id)).activated_at, null, "still not live");
  });

  await t.step("ERM approves and the service activates: decision, reviewer and activation recorded", async () => {
    const r = await propose({ inherent_score: 7, erm_decision: "approved", erm_reviewed_by: "erm_flow", activate: true });
    assertEq(r.status, 201, `approve + activate (${body(r)})`);
    const row = await rowById("eps_proposal", id);
    assertEq(row.erm_review_decision, "approved", "approved");
    assertEq(row.erm_reviewed_by, "erm_flow", "reviewer");
    assert(row.activated_at, "live");
    const codes = await codesFor("eps_proposal", id);
    assert(codes.includes("eps.erm_review.decided") && codes.includes("eps.service.activated"), "decision + activation events");
  });
});

// ============================================================ EPS-03

flow("eps_controls: EPS-03 — the annual control review: a found deficiency must be described and rated, and opens remediation in the same write", async (t) => {
  const ops = await actor("cu_admin");
  const partner = await actor("partner");
  const svc = rid("svc_ach");
  const clean = rid("svc_wire");
  const review = (service: string, o: Record<string, unknown>, key = ops) =>
    api("POST", "/eps/control-reviews", { service_id: service, ...o }, { key });

  await t.step("a partner cannot file reviews; a review with no checklist is an opinion and is refused", async () => {
    refusedToPartner(await review(svc, { checklist: {} }, partner), "control review");
    const r = await review(svc, { deficiency_found: false });
    assertEq(r.status, 400, `no checklist (${body(r)})`);
  });

  await t.step("a found deficiency with no rating cannot be prioritised — 400, nothing stored", async () => {
    const r = await review(svc, { checklist: { dual_control: false }, deficiency_found: true, description: "no dual control on limit changes" });
    assertEq(r.status, 400, `no rating (${body(r)})`);
    assertEq(await rowById("eps_control_review", `epsrev_${svc}`), null, "nothing stored");
  });

  await t.step("a high deficiency opens remediation due in 30 days, with the open list and due-date evidence", async () => {
    const r = await review(svc, { checklist: { dual_control: false }, deficiency_found: true, description: "no dual control on limit changes", rating: "high" });
    assertEq(r.status, 201, `review (${body(r)})`);
    const row = await rowById("eps_control_review", `epsrev_${svc}`);
    assertEq(row.eps_deficiency_rating, "high", "rating");
    assert(row.remediation_opened_at, "remediation opened");
    assert(Math.abs(ms(row.remediation_due_at) - ms(row.opened_at) - 30 * DAY) < 60_000, "due in 30 days");
    assert(Math.abs(ms(row.review_due_at) - ms(row.opened_at) - 365 * DAY) < 60_000, "next review in a year");
    const codes = await codesFor("eps_control_review", `epsrev_${svc}`);
    for (const c of ["eps.control_review.completed", "eps.deficiency.open_list", "eps.deficiency.remediation.due_at", "eps.deficiency_remediation.opened"]) {
      assert(codes.includes(c), `${c} emitted`);
    }
  });

  await t.step("a clean review completes with no remediation", async () => {
    const r = await review(clean, { checklist: { dual_control: true } });
    assertEq(r.status, 201, `clean (${body(r)})`);
    const row = await rowById("eps_control_review", `epsrev_${clean}`);
    assertEq(row.remediation_due_at, null, "no remediation");
    assert(row.completed_at, "completed");
    assert(!(await codesFor("eps_control_review", `epsrev_${clean}`)).includes("eps.deficiency_remediation.opened"), "no remediation event");
  });
});

// ============================================================ EPS-10

flow("eps_controls: EPS-10 — a payment-system change is deployed only with a rollback plan; the emergency path needs an owned exception; known defects need a recorded risk acceptance", async (t) => {
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  const normal = rid("svc_rtp");
  const urgent = rid("svc_rtp_hotfix");
  const deploy = (service: string, o: Record<string, unknown>, key = ops) =>
    api("POST", "/eps/deployments", { service_id: service, ...o }, { key });

  await t.step("a partner cannot deploy; with no rollback plan there is no deployment", async () => {
    refusedToPartner(await deploy(normal, { rollback_plan: "revert" }, partner), "deployment");
    const r = await deploy(normal, { test_plan: "regression" });
    assertEq(r.status, 400, `no rollback (${body(r)})`);
    assertEq(await rowById("eps_deployment", `epsdep_${normal}`), null, "nothing stored");
  });

  await t.step("the emergency path needs MORE: no exception approval is a 409; known defects without acceptance are a 400", async () => {
    const em = await deploy(urgent, { rollback_plan: "revert to v3.2", emergency: true });
    assertEq(em.status, 409, `unapproved emergency (${body(em)})`);
    assertEq(em.body.type, "emergency_exception_unapproved", "typed refusal");
    const def = await deploy(normal, { rollback_plan: "revert", defects: ["timeout on resend"] });
    assertEq(def.status, 400, `unaccepted defects (${body(def)})`);
    assertEq(await rowById("eps_deployment", `epsdep_${urgent}`), null, "no emergency row");
    assertEq(await rowById("eps_deployment", `epsdep_${normal}`), null, "no defect row");
  });

  await t.step("a planned deployment with an accepted defect is scheduled with a 14-day retro", async () => {
    const r = await deploy(normal, { rollback_plan: "revert to v3.2", test_plan: "regression + interop", defects: ["timeout on resend"], risk_acceptance: "cto_flow accepts until v3.4" });
    assertEq(r.status, 201, `deploy (${body(r)})`);
    const row = await rowById("eps_deployment", `epsdep_${normal}`);
    assertEq(row.eps_test_risk_acceptance, "cto_flow accepts until v3.4", "acceptance recorded");
    assertEq(row.emergency_exception, false, "not an emergency");
    assert(Math.abs(ms(row.retro_due_at) - ms(row.scheduled_at) - 14 * DAY) < 60_000, "retro in 14 days");
    const codes = await codesFor("eps_deployment", `epsdep_${normal}`);
    for (const c of ["eps.deployment.scheduled", "eps.test_results.recorded", "eps.test.retro_due_at"]) assert(codes.includes(c), `${c} emitted`);
  });

  await t.step("an approved emergency deployment records who owned the exception", async () => {
    const r = await deploy(urgent, { rollback_plan: "revert to v3.2", emergency: true, exception_approval: "cio_flow" });
    assertEq(r.status, 201, `emergency (${body(r)})`);
    const row = await rowById("eps_deployment", `epsdep_${urgent}`);
    assertEq(row.emergency_exception, true, "emergency");
    assertEq(row.eps_change_exception_approval, "cio_flow", "owner");
    assert((await codesFor("eps_deployment", `epsdep_${urgent}`)).includes("eps.deployment.emergency_exception"), "emergency event");
  });
});

// ============================================================ EPS-06

flow("eps_controls: EPS-06 — wire release needs PIN, an allowlisted IP and a second approver; ACH verdicts derive from their checks; a limit change needs someone else's approval; positive-pay items carry their deadline", async (t) => {
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  const opsTok = tokenIdOf(ops, "pynthia_ops");
  const release = (wire: string, o: Record<string, unknown>, key = ops) =>
    api("POST", "/eps/wire-releases", { wire_ref: wire, originator_id: "ops_alice", pin_verified: true, ip: "203.0.113.9", ...o }, { key });

  await t.step("a partner cannot release wires; a release that names no originator is refused", async () => {
    refusedToPartner(await release(rid("w"), { ip_allowlist: ["203.0.113.9"], second_approval: "ops_bob" }, partner), "wire release");
    const r = await api("POST", "/eps/wire-releases", { wire_ref: rid("w") }, { key: ops });
    assertEq(r.status, 400, `no originator (${body(r)})`);
  });

  await t.step("an UNCONFIGURED allowlist is unknown, and unknown is not permission: recorded, not released", async () => {
    const w = rid("w");
    const r = await release(w, { second_approval: "ops_bob" });
    assertEq(r.status, 201, `request (${body(r)})`);
    const row = await rowById("wire_release", `wrel_${w}`);
    assertEq(row.eps_wire_ip_allowlisted, null, "allowlist verdict unknown");
    assertEq(row.released_at, null, "not released");
    assert(!(await codesFor("wire_release", `wrel_${w}`)).includes("eps.wire_ip.verified"), "no IP verification event");
  });

  await t.step("an IP off the allowlist is not released; PIN + allowlisted IP + a second approver releases", async () => {
    const off = rid("w");
    await release(off, { ip: "198.51.100.4", ip_allowlist: ["203.0.113.9"], second_approval: "ops_bob" });
    const offRow = await rowById("wire_release", `wrel_${off}`);
    assertEq(offRow.eps_wire_ip_allowlisted, false, "off the list");
    assertEq(offRow.released_at, null, "not released");
    const ok = rid("w");
    const r = await release(ok, { ip_allowlist: ["203.0.113.9"], second_approval: "ops_bob" });
    assertEq(r.body.data.released, true, `released (${body(r)})`);
    assert((await rowById("wire_release", `wrel_${ok}`)).released_at, "released_at");
    assert((await codesFor("wire_release", `wrel_${ok}`)).includes("eps.wire_ip.verified"), "IP verified event");
  });

  await t.step("the originator cannot be their own second approver", async () => {
    const w = rid("w");
    const r = await release(w, { ip_allowlist: ["203.0.113.9"], second_approval: "ops_alice" });
    // DEFECT: postWireRelease only checks second_approval is non-empty; the originator naming themselves as second approver releases the wire (released_at set).
    assertEq((await rowById("wire_release", `wrel_${w}`))?.released_at ?? null, null, `self-approved release (${body(r)})`);
  });

  await t.step("ACH control results: a verdict with no individual checks is refused; the pass verdict is DERIVED — one failed check fails it", async () => {
    const none = await api("POST", "/eps/ach-control-results", { transfer_ref: rid("ach"), amount_cents: 1, passed: true }, { key: ops });
    assertEq(none.status, 400, `no checks (${body(none)})`);
    const failRef = rid("ach");
    const f = await api("POST", "/eps/ach-control-results", {
      transfer_ref: failRef, amount_cents: 1, passed: true,
      checks: { within_limit: true, template_matched: false, dual_control: true },
    }, { key: ops });
    assertEq(f.status, 201, `results (${body(f)})`);
    assertEq((await rowById("ach_control_result", `achres_${failRef}`)).passed, false, "a caller's 'passed' is ignored");
    const passRef = rid("ach");
    await api("POST", "/eps/ach-control-results", { transfer_ref: passRef, amount_cents: 1, checks: { within_limit: true, template_matched: true } }, { key: ops });
    const row = await rowById("ach_control_result", `achres_${passRef}`);
    assertEq(row.passed, true, "all checks true passes");
    assertEq(row.control_results.template_matched, true, "the individual results are the evidence");
  });

  await t.step("a client limit change needs a justification and someone else's approval; self-approval is 409 and writes nothing", async () => {
    const p = rid("ptnr");
    const noWhy = await api("POST", "/eps/limit-changes", { partner_id: p }, { key: ops });
    assertEq(noWhy.status, 400, `no justification (${body(noWhy)})`);
    const self = await api("POST", "/eps/limit-changes", { partner_id: p, justification: "seasonal volume", approver_id: opsTok, wire_daily_limit_cents: 5_000_000 }, { key: ops });
    assertEq(self.status, 409, `self approval (${body(self)})`);
    assertEq(self.body.type, "self_approved_limit_change", "typed refusal");
    assertEq(await rowById("eps_limit_change", `limchg_${p}`), null, "nothing stored");
    const ok = await api("POST", "/eps/limit-changes", { partner_id: p, justification: "seasonal volume", approver_id: "cro_flow", wire_daily_limit_cents: 5_000_000 }, { key: ops });
    assertEq(ok.status, 201, `approved change (${body(ok)})`);
    const row = await rowById("eps_limit_change", `limchg_${p}`);
    assertEq(row.requested_by, opsTok, "requester is the caller's token");
    assertEq(row.eps_limit_change_approver_id, "cro_flow", "approver");
    assert(row.decided_at, "decided");
    const pending = rid("ptnr");
    await api("POST", "/eps/limit-changes", { partner_id: pending, justification: "new corridor" }, { key: ops });
    assertEq((await rowById("eps_limit_change", `limchg_${pending}`)).decided_at, null, "unapproved stays a request");
  });

  await t.step("a positive-pay item is presented with a 24-hour decision deadline and no decision", async () => {
    const item = rid("chk");
    const r = await api("POST", "/eps/pospay-items", { issue_file: rid("if"), item_ref: item, item: { check_no: 1 } }, { key: ops });
    assertEq(r.status, 201, `item (${body(r)})`);
    const row = await rowById("pospay_item", `pospay_${item}`);
    assertEq(row.decision, null, "undecided");
    assert(Math.abs(ms(row.eps_pospay_decision_due_at) - ms(row.created_at) - DAY) < 60_000, "due in 24 hours");
  });
});
