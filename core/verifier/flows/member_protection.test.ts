// flow-runner: serial — changes or reads instance-wide state (see scripts/flow.sh)
// Member protection + resolution safe mode — MP-06, MP-07, RS-03.
//
// Credit-union staff (cu_admin) handle a member's death and estate, expel a
// member through the board's due process, and put the whole institution into
// resolution safe mode and back out. Each journey asserts that the control
// ENFORCES — locked accounts refuse movement, an unverified claimant is not
// paid, safe mode refuses over-cap transactions — and leaves the evidence an
// examiner reads. Ported from the user-observable behaviour of
// core/supabase/functions/api/member_protection.test.ts
// (see ledger/member_protection.md).
//
// Every route here declares x-actors [cu_admin, pynthia_ops], so a partner
// token is refused with 403 by the auth layer.
//
// SHARED INSTANCE: safe mode is a single, core-wide flag (uq_safe_mode_single_active).
// While the safe-mode flow holds it active, every book transfer on the demo
// core is decided by it. The cap is set above anything other flows send
// ($22,000 vs their ≤ $20,000), the window is a few seconds, and the flow
// deactivates in a finally block.
import { actor, type Any, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);

async function rowById(table: string, id: string) {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data as Any;
}

/** every event written about one resource, keyed by code (last wins) */
async function eventsFor(resourceType: string, id: string): Promise<Map<string, Any>> {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("resource_id", `${resourceType}:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  const m = new Map<string, Any>();
  for (const e of r.data ?? []) m.set(String(e.code), e);
  return m;
}

async function entity(partner: string, o: Record<string, unknown> = {}): Promise<string> {
  const e = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1948-02-14", ...o,
  }, { key: partner });
  assertEq(e.status, 201, `create entity (${body(e)})`);
  return String(e.body.id);
}

async function openAccount(partner: string, entityId: string, cents: number, type = "checking"): Promise<string> {
  const a = await api("POST", "/accounts", {
    entity_id: entityId, account_type: type, opening_deposit_cents: cents,
  }, { key: partner });
  assertEq(a.status, 201, `open account (${body(a)})`);
  return String(a.body.id);
}

async function balanceOf(partner: string, accountId: string): Promise<number> {
  const r = await api("GET", `/accounts/${accountId}`, undefined, { key: partner });
  assertEq(r.status, 200, `account read (${body(r)})`);
  return r.body.balance;
}

function transfer(partner: string, from: string, to: string, cents: number) {
  return api("POST", "/transfers", {
    source_account_id: from, destination_account_id: to, amount_cents: cents,
    description: "flow: member protection",
  }, { key: partner });
}

// ------------------------------------------------- MP-07 death and estate

flow("member_protection: death reported from a certificate → every account locked deceased → movement refused → estate claim → unverified payout refused → verified claimant paid net of amounts owed, once", async (t) => {
  const partner = await actor("partner");
  const staff = await actor("cu_admin");
  const CHECKING = 100_000;
  const SAVINGS = 50_000;
  const OWED = 30_000;
  let member = "";
  let checking = "";
  let savings = "";
  let other = "";
  let claimId = "";
  let verificationId = "";

  await t.step("the partner onboards the member (checking $1,000 + savings $500) and a second member", async () => {
    member = await entity(partner, { address: "9 Oak Ln, Springfield, IL 62701" });
    checking = await openAccount(partner, member, CHECKING);
    savings = await openAccount(partner, member, SAVINGS, "savings");
    other = await openAccount(partner, await entity(partner, { date_of_birth: "1990-01-01" }), 1_000);
    assertEq(await balanceOf(partner, checking), CHECKING, "checking funded");
    assertEq(await balanceOf(partner, savings), SAVINGS, "savings funded");
  });

  await t.step("a partner cannot report a death (403: route restricted to CU staff)", async () => {
    const r = await api("POST", `/members/${member}/death-report`,
      { date_of_death: "2026-09-20", death_certificate_ref: "doc_dc_partner" }, { key: partner });
    assertEq(r.status, 403, `partner death report (${body(r)})`);
    assertEq((await rowById("account", checking)).lock_type, "none", "nothing locked");
  });

  await t.step("a death is flagged from a DOCUMENT, not a rumor: no certificate → 400, nothing locked", async () => {
    const r = await api("POST", `/members/${member}/death-report`, { date_of_death: "2026-09-20" }, { key: staff });
    assertEq(r.status, 400, `no certificate (${body(r)})`);
    assertEq((await rowById("account", checking)).lock_type, "none", "checking not locked");
    assertEq((await rowById("account", savings)).lock_type, "none", "savings not locked");
  });

  await t.step("a death report for an unknown member is a 404", async () => {
    const r = await api("POST", `/members/ent_${crypto.randomUUID()}/death-report`,
      { date_of_death: "2026-09-20", death_certificate_ref: "doc_dc_x" }, { key: staff });
    assertEq(r.status, 404, `unknown member (${body(r)})`);
  });

  await t.step("staff report the death with the certificate: EVERY account locked deceased, one event per account", async () => {
    const r = await api("POST", `/members/${member}/death-report`,
      { date_of_death: "2026-09-20", death_certificate_ref: "doc_dc_flow" }, { key: staff });
    assertEq(r.status, 201, `death report (${body(r)})`);
    assertEq(r.body.data.accounts_flagged, 2, "both accounts flagged");
    for (const a of [checking, savings]) {
      assertEq((await rowById("account", a)).lock_type, "deceased", `${a} locked deceased`);
      const ev = await rowById("event", `ev_death_${a}`);
      assertEq(ev?.code, "account.death_flag.applied", `death flag event for ${a}`);
      assertEq(ev?.payload["estate.death_certificate_ref"], "doc_dc_flow", "event cites the certificate");
      assertEq(ev?.payload.previous_lock, "none", "event records the lock it replaced");
      assertEq(ev?.provenance, "demo", "labelled demo");
    }
    const rep = (await eventsFor("entity", member)).get("member.death.reported");
    assert(rep, "member.death.reported emitted");
    assertEq(rep.payload.accounts_flagged, 2, "the report counts the flagged accounts");
  });

  await t.step("the lock ENFORCES: a transfer out of the deceased member's account is refused, no money moves", async () => {
    const r = await transfer(partner, checking, other, 5_000);
    assertEq(r.status, 422, `transfer from deceased account (${body(r)})`);
    assertEq(r.body.type, "account_locked", "refused as locked");
    assertEq(await balanceOf(partner, checking), CHECKING, "checking untouched");
  });

  await t.step("an estate claim needs claimant, date of death and certificate (400)", async () => {
    const r = await api("POST", `/members/${member}/estate-claims`,
      { claimant: "A. Heir", date_of_death: "2026-09-20" }, { key: staff });
    assertEq(r.status, 400, `incomplete claim (${body(r)})`);
    const rows = await core().from("estate_claim").select("id").eq("entity_id", member);
    assertEq((rows.data ?? []).length, 0, "no claim row written");
  });

  await t.step("document the estate claim: claim row + a PENDING claimant verification (the payout gate)", async () => {
    const r = await api("POST", `/members/${member}/estate-claims`, {
      claimant: "A. Heir", date_of_death: "2026-09-20", death_certificate_ref: "doc_dc_flow",
      authority_document_ref: "doc_letters_testamentary_flow",
    }, { key: staff });
    assertEq(r.status, 201, `estate claim (${body(r)})`);
    claimId = String(r.body.data.id);
    verificationId = String(r.body.data.verification_id);
    const c = await rowById("estate_claim", claimId);
    assertEq(c.status, "documented", "claim documented, not paid");
    assertEq(c.entity_id, member, "claim names the member");
    assertEq(c.verification_id, verificationId, "claim points at its verification");
    assertEq(c.authority_document_ref, "doc_letters_testamentary_flow", "authority document kept");
    assertEq(c.provenance, "demo", "labelled demo");
    const v = await rowById("verification", verificationId);
    assertEq(v.type, "estate_claimant", "a real verification row of type estate_claimant");
    assertEq(v.status, "pending", "born pending");
    assert((await eventsFor("estate_claim", claimId)).has("estate.claim.documented"), "estate.claim.documented");
    assert((await eventsFor("verification", verificationId)).has("verification.created"), "verification.created");
  });

  await t.step("a partner cannot pay out an estate (403)", async () => {
    const r = await api("POST", `/estate-claims/${claimId}/payout`, {}, { key: partner });
    assertEq(r.status, 403, `partner payout (${body(r)})`);
  });

  await t.step("THE GATE: payout to an UNVERIFIED claimant is refused (409), claim stays documented", async () => {
    const r = await api("POST", `/estate-claims/${claimId}/payout`, {}, { key: staff });
    assertEq(r.status, 409, `unverified payout (${body(r)})`);
    assertEq(r.body.type, "claimant_not_verified", "typed refusal");
    assertEq((await rowById("estate_claim", claimId)).status, "documented", "not paid");
    assert(!(await eventsFor("estate_claim", claimId)).has("estate.payout.sent"), "no payout event");
  });

  await t.step("the claimant's identity is verified (out of band) and the account mirror is left stale", async () => {
    // No routed API approves an estate_claimant verification:
    // POST /verifications/{id}/transition sits in x-proposed-paths. The flow
    // stands in for that out-of-band identity check by writing the approval
    // the way the missing route would.
    const v = await core().from("verification").update({ status: "approved" }).eq("id", verificationId);
    assert(!v.error, `verification approve: ${v.error?.message}`);
    // the payout must be sized from the LEDGER, so poison the mirror of our
    // own fixture: if the handler read core.account.balance it would pay 999,999
    const m = await core().from("account").update({ balance: 999_999 }).eq("id", checking);
    assert(!m.error, `mirror poison: ${m.error?.message}`);
  });

  await t.step("the verified claimant is paid the LEDGER balance net of amounts owed; the mirror is refreshed", async () => {
    const r = await api("POST", `/estate-claims/${claimId}/payout`, { amounts_owed_cents: OWED }, { key: staff });
    assertEq(r.status, 200, `payout (${body(r)})`);
    assertEq(r.body.data.payout_cents, CHECKING + SAVINGS - OWED, "ledger $1,500 less $300 owed");
    const c = await rowById("estate_claim", claimId);
    assertEq(c.status, "paid", "claim paid");
    assertEq(Number(c.payout_cents), CHECKING + SAVINGS - OWED, "payout recorded on the claim");
    const ev = (await eventsFor("estate_claim", claimId)).get("estate.payout.sent");
    assert(ev, "estate.payout.sent emitted");
    assertEq(ev.payload["account.balance"], CHECKING + SAVINGS, "event records the ledger balance");
    assertEq(ev.payload["member.amounts_owed"], OWED, "event records the amounts owed");
    assertEq(ev.payload["verification.status"], "approved", "event records the verified claimant");
    // the poisoned mirror was overwritten from the ledger; since the payout now
    // really moves money, the refreshed value is the post-payout balance
    const mirrored = Number((await rowById("account", checking)).balance) + Number((await rowById("account", savings)).balance);
    assertEq(mirrored, OWED, "the mirrors were refreshed from the ledger, and only the amount owed remains");
  });

  await t.step("an estate is not paid twice (409)", async () => {
    const r = await api("POST", `/estate-claims/${claimId}/payout`, {}, { key: staff });
    assertEq(r.status, 409, `second payout (${body(r)})`);
    assertEq(r.body.type, "estate_already_paid", "typed refusal");
  });

  await t.step("the payout actually left the deceased member's accounts", async () => {
    // Regression guard (bug found by this flow, fixed 2026-10-05): the payout was recorded as sent while no money left the member's accounts; it now debits them in the ledger.
    const left = await balanceOf(partner, checking) + await balanceOf(partner, savings);
    assert(left <= OWED, `after paying ${CHECKING + SAVINGS - OWED} the member's accounts should hold at most the ${OWED} owed; they hold ${left}`);
  });
});

// ------------------------------------------------------- MP-06 expulsion

flow("member_protection: expulsion needs a deliverable contact → noticed → hearing requested + held → closed: payout net of owed, accounts locked expelled", async (t) => {
  const partner = await actor("partner");
  const staff = await actor("cu_admin");
  const OPENING = 100_000;
  const OWED = 40_000;
  let unreachable = "";
  let member = "";
  let account = "";
  let other = "";
  let expulsionId = "";
  const email = `expel+${uid()}@example.test`;

  await t.step("the partner onboards a member with no email or address, and one with an email and a $1,000 account", async () => {
    unreachable = await entity(partner);
    member = await entity(partner, { email });
    account = await openAccount(partner, member, OPENING);
    other = await openAccount(partner, await entity(partner, { date_of_birth: "1991-05-05" }), 1_000);
  });

  await t.step("a partner cannot expel a member (403)", async () => {
    const r = await api("POST", `/members/${member}/expulsion`,
      { grounds: "abuse of services", decided_by: "board_flow", meeting_date: "2026-09-15" }, { key: partner });
    assertEq(r.status, 403, `partner expulsion (${body(r)})`);
  });

  await t.step("expulsion is a board act: grounds, decided_by and meeting_date are required (400)", async () => {
    const r = await api("POST", `/members/${member}/expulsion`, { grounds: "abuse of services" }, { key: staff });
    assertEq(r.status, 400, `incomplete expulsion (${body(r)})`);
    const rows = await core().from("expulsion").select("id").eq("entity_id", member);
    assertEq((rows.data ?? []).length, 0, "no expulsion row");
  });

  await t.step("a member who cannot be told cannot be noticed: 422 no_deliverable_contact, nothing recorded", async () => {
    const r = await api("POST", `/members/${unreachable}/expulsion`,
      { grounds: "abuse of services", decided_by: "board_flow", meeting_date: "2026-09-15" }, { key: staff });
    assertEq(r.status, 422, `no contact (${body(r)})`);
    assertEq(r.body.type, "no_deliverable_contact", "typed refusal");
    const rows = await core().from("expulsion").select("id").eq("entity_id", unreachable);
    assertEq((rows.data ?? []).length, 0, "no expulsion row for the unreachable member");
  });

  await t.step("expel the reachable member: noticed by email, with the decision/notice/meeting evidence", async () => {
    const r = await api("POST", `/members/${member}/expulsion`, {
      grounds: "abuse of services", decided_by: "board_flow", meeting_date: "2026-09-15",
      amounts_owed_cents: OWED,
    }, { key: staff });
    assertEq(r.status, 201, `expulsion (${body(r)})`);
    assertEq(r.body.data.notice_channel, "email", "noticed on the member's email");
    expulsionId = String(r.body.data.id);
    const x = await rowById("expulsion", expulsionId);
    assertEq(x.status, "noticed", "status noticed");
    assert(x.notice_sent_at, "notice_sent_at stamped");
    assertEq(Number(x.amounts_owed_cents), OWED, "amounts owed recorded");
    assertEq(x.provenance, "demo", "labelled demo");
    const ev = await eventsFor("expulsion", expulsionId);
    for (const code of [
      "member.expulsion.decided", "member.expulsion_notice", "member.expulsion_notice.sent", "expulsion.meeting_date",
    ]) assert(ev.has(code), `${code} emitted (got ${[...ev.keys()]})`);
    assertEq(ev.get("member.expulsion.decided").payload["expulsion.decided_by"], "board_flow", "who decided");
    assertEq(ev.get("member.expulsion_notice.sent").payload["entity.contact"], "email", "notice channel on the event");
  });

  await t.step("the hearing: an unknown kind is refused; requested moves to hearing; held is stamped", async () => {
    const bad = await api("POST", `/expulsions/${expulsionId}/hearing`, { kind: "maybe" }, { key: staff });
    assertEq(bad.status, 400, `bad kind (${body(bad)})`);
    const req = await api("POST", `/expulsions/${expulsionId}/hearing`, { kind: "requested" }, { key: staff });
    assertEq(req.status, 200, `hearing requested (${body(req)})`);
    let x = await rowById("expulsion", expulsionId);
    assertEq(x.status, "hearing", "status hearing");
    assert(x.hearing_requested_at, "hearing_requested_at stamped");
    const held = await api("POST", `/expulsions/${expulsionId}/hearing`, { kind: "held" }, { key: staff });
    assertEq(held.status, 200, `hearing held (${body(held)})`);
    x = await rowById("expulsion", expulsionId);
    assert(x.hearing_held_at, "hearing_held_at stamped");
    const ev = await eventsFor("expulsion", expulsionId);
    assert(ev.has("member.expulsion_hearing.requested"), "hearing requested event");
    assert(ev.has("member.expulsion_hearing.held"), "hearing held event");
  });

  await t.step("a partner cannot close an expulsion (403)", async () => {
    const r = await api("POST", `/expulsions/${expulsionId}/close`, {}, { key: partner });
    assertEq(r.status, 403, `partner close (${body(r)})`);
  });

  await t.step("close: board report filed, payout = ledger balance net of owed, accounts locked expelled", async () => {
    const r = await api("POST", `/expulsions/${expulsionId}/close`, {}, { key: staff });
    assertEq(r.status, 200, `close (${body(r)})`);
    assertEq(r.body.data.payout_cents, OPENING - OWED, "$1,000 less $400 owed");
    const x = await rowById("expulsion", expulsionId);
    assertEq(x.status, "final", "status final");
    assert(x.board_report_filed_at, "board report filed");
    assert(x.payout_sent_at, "payout_sent_at stamped");
    assertEq(Number(x.payout_cents), OPENING - OWED, "payout recorded");
    assertEq((await rowById("account", account)).lock_type, "expelled", "account locked expelled");
    const ev = await eventsFor("expulsion", expulsionId);
    assertEq(ev.get("expulsion.board_report.filed")?.payload.accounts_locked, 1, "board report counts the locked account");
    const pay = ev.get("member.expulsion_payout.sent");
    assertEq(pay?.payload["account.balance"], OPENING, "payout event records the ledger balance");
    assertEq(pay?.payload["member.amounts_owed"], OWED, "payout event records the amount owed");
  });

  await t.step("the lock ENFORCES: the expelled member's account cannot move money", async () => {
    const r = await transfer(partner, account, other, 1_000);
    assertEq(r.status, 422, `transfer from expelled account (${body(r)})`);
    assertEq(r.body.type, "account_locked", "refused as locked");
  });

  await t.step("a closed expulsion cannot be closed again (409)", async () => {
    const r = await api("POST", `/expulsions/${expulsionId}/close`, {}, { key: staff });
    assertEq(r.status, 409, `re-close (${body(r)})`);
    assertEq(r.body.type, "expulsion_final", "typed refusal");
  });

  await t.step("the payout actually left the expelled member's account", async () => {
    // Regression guard (bug found by this flow, fixed 2026-10-05): the payout was recorded as sent while the share balance stayed put; it now debits the account in the ledger.
    const left = await balanceOf(partner, account);
    assert(left <= OWED, `after paying ${OPENING - OWED} the account should hold at most the ${OWED} owed; it holds ${left}`);
  });
});

// ------------------------------------------------------- RS-03 safe mode

const CAP = 2_200_000; // $22,000 — above anything the other flows send

async function activeSafeMode(): Promise<Any | null> {
  const r = await core().from("safe_mode").select("*").eq("status", "active").maybeSingle();
  assert(!r.error, `safe_mode read: ${r.error?.message}`);
  return r.data;
}

flow("member_protection: safe mode activated → every transfer decided with evidence (under cap allowed, over cap refused) → dual-authorized deactivation → gate off", async (t) => {
  const partner = await actor("partner");
  const staff = await actor("cu_admin");
  const OPENING = 3_000_000; // $30,000
  let from = "";
  let to = "";
  let safeModeId = "";

  try {
    await t.step("preflight: no safe mode is active (a stale one left by a crashed run of THIS flow is retired)", async () => {
      const sm = await activeSafeMode();
      if (sm && String(sm.trigger_basis).startsWith("flow:") && sm.provenance === "demo") {
        const r = await api("POST", `/resolution/safe-mode/${sm.id}/deactivate`,
          { authorized_by: "cco_flow_cleanup", second_authorizer: "cro_flow_cleanup" }, { key: staff });
        assertEq(r.status, 200, `retire stale flow safe mode (${body(r)})`);
      }
      const now = await activeSafeMode();
      assert(!now, `a non-flow safe mode is active (${now?.id}); refusing to touch it`);
    });

    await t.step("the partner onboards two members ($30,000 sender)", async () => {
      from = await openAccount(partner, await entity(partner, { date_of_birth: "1970-03-03" }), OPENING);
      to = await openAccount(partner, await entity(partner, { date_of_birth: "1972-04-04" }), 1_000);
    });

    await t.step("a partner cannot activate safe mode (403); activation needs a basis, an activator and a positive cap (400)", async () => {
      const p = await api("POST", "/resolution/safe-mode",
        { trigger_basis: "flow: partner", per_txn_cap_cents: CAP, activated_by: "x" }, { key: partner });
      assertEq(p.status, 403, `partner activation (${body(p)})`);
      for (const bad of [
        { trigger_basis: "flow: no cap", activated_by: "cco_flow" },
        { trigger_basis: "flow: zero cap", activated_by: "cco_flow", per_txn_cap_cents: 0 },
        { per_txn_cap_cents: CAP, activated_by: "cco_flow" },
      ]) {
        const r = await api("POST", "/resolution/safe-mode", bad, { key: staff });
        assertEq(r.status, 400, `refused activation ${JSON.stringify(bad)} (${body(r)})`);
      }
      assert(!(await activeSafeMode()), "nothing activated");
    });

    await t.step("the CCO activates safe mode: row active with its cap profile, safe_mode.activated evidence", async () => {
      const r = await api("POST", "/resolution/safe-mode", {
        trigger_basis: "flow: liquidity stress drill", per_txn_cap_cents: CAP,
        // A type no real rail uses: restricting "wire" instance-wide would refuse
        // every other session's wires for the length of this flow. Wire
        // coverage is proven by the cap below instead.
        restricted_types: ["flow_probe"], activated_by: "cco_flow",
      }, { key: staff });
      assertEq(r.status, 201, `activate (${body(r)})`);
      safeModeId = String(r.body.data.id);
      const sm = await rowById("safe_mode", safeModeId);
      assertEq(sm.status, "active", "active");
      assertEq(Number(sm.per_txn_cap_cents), CAP, "cap recorded");
      assertEq((sm.restricted_types ?? []).join(","), "flow_probe", "restricted types recorded");
      assertEq(sm.provenance, "demo", "labelled demo");
      const ev = (await eventsFor("safe_mode", safeModeId)).get("safe_mode.activated");
      assertEq(ev?.payload["resolution_posture.current"], "safe_mode", "posture on the event");
      assertEq(ev?.payload.per_txn_cap_cents, CAP, "cap on the event");
    });

    await t.step("at most one safe mode: a second activation is refused by the database (409)", async () => {
      const r = await api("POST", "/resolution/safe-mode",
        { trigger_basis: "flow: second", per_txn_cap_cents: CAP, activated_by: "cco_flow" }, { key: staff });
      assertEq(r.status, 409, `double activation (${body(r)})`);
      assertEq(r.body.type, "safe_mode_already_active", "typed refusal");
      assertEq((await activeSafeMode())?.id, safeModeId, "ours is still the one active");
    });

    await t.step("the processor confirms propagation — a separate fact, separately recorded", async () => {
      const r = await api("POST", `/resolution/safe-mode/${safeModeId}/processor-confirm`,
        { processor_ref: "proc_flow_1" }, { key: staff });
      assertEq(r.status, 200, `processor confirm (${body(r)})`);
      assert((await rowById("safe_mode", safeModeId)).processor_confirmed_at, "processor_confirmed_at stamped");
      assertEq((await eventsFor("safe_mode", safeModeId)).get("safe_mode.processor.confirmed")?.payload.processor_ref,
        "proc_flow_1", "processor ref on the event");
    });

    await t.step("a $100 transfer under the cap is ALLOWED — and the decision is recorded", async () => {
      const r = await transfer(partner, from, to, 10_000);
      assertEq(r.status, 201, `under-cap transfer (${body(r)})`);
      assertEq(r.body.status, "settled", "settled");
      const ev = await rowById("event", `ev_smdec_${r.body.id}`);
      assertEq(ev?.code, "safe_mode.transaction.decided", "decision evidence for an allowed transfer");
      assertEq(ev?.payload.decision, "allowed", "allowed");
      assertEq(ev?.payload["transaction.amount"], 10_000, "amount on the decision");
      assertEq(ev?.resource_id, `safe_mode:${safeModeId}`, "decision attributed to our safe mode");
    });

    await t.step("a $22,000.01 transfer over the cap is REFUSED (423), recorded rejected, no money moves", async () => {
      const r = await transfer(partner, from, to, CAP + 1);
      assertEq(r.status, 423, `over-cap transfer (${body(r)})`);
      assertEq(r.body.type, "safe_mode_restricted", "typed refusal");
      const transferId = String(r.body.resource_id);
      assertEq((await rowById("transfer", transferId))?.status, "rejected", "transfer row rejected");
      const ev = await rowById("event", `ev_smdec_${transferId}`);
      assertEq(ev?.payload.decision, "refused", "refusal recorded");
      assert(String(ev?.payload.reason).includes("cap"), `reason names the cap (${ev?.payload.reason})`);
      assertEq(await balanceOf(partner, from), OPENING - 10_000, "sender only lost the allowed $100");
    });

    await t.step("RS-03 covers every outbound channel: a wire over the safe-mode cap is refused 423", async () => {
      const w = await api("POST", "/payments/wire/prepare", {
        source_account_id: from, amount_cents: CAP + 100_000, purpose: "flow: wire under safe mode",
        beneficiary: { name: "Acme Corp", country: "US", routing_number: "021000021" },
      }, { key: partner });
      if (w.status === 201) {
        // release the hold so the fixture strands nothing
        await api("POST", `/payments/wire/${w.body.id}/cancel`, {}, { key: partner });
      }
      // Regression guard (bug found by this flow, fixed 2026-10-03): safe mode was
      // checked only by book transfers; runGate now applies it to every rail.
      assertEq(w.status, 423, `wire under safe mode (${body(w)})`);
    });

    await t.step("deactivation on ONE person's judgment is refused (422); safe mode stays active", async () => {
      const r = await api("POST", `/resolution/safe-mode/${safeModeId}/deactivate`,
        { authorized_by: "cco_flow", second_authorizer: "cco_flow" }, { key: staff });
      assertEq(r.status, 422, `solo deactivation (${body(r)})`);
      assertEq(r.body.type, "dual_authorization_required", "typed refusal");
      assertEq((await rowById("safe_mode", safeModeId)).status, "active", "still active");
    });

    await t.step("two DIFFERENT authorizers deactivate it: row deactivated with both names, event emitted", async () => {
      const r = await api("POST", `/resolution/safe-mode/${safeModeId}/deactivate`,
        { authorized_by: "cco_flow", second_authorizer: "cro_flow" }, { key: staff });
      assertEq(r.status, 200, `dual deactivation (${body(r)})`);
      const sm = await rowById("safe_mode", safeModeId);
      assertEq(sm.status, "deactivated", "deactivated");
      assert(sm.deactivated_at, "deactivated_at stamped");
      assertEq(sm.deactivated_by, "cco_flow", "first authorizer");
      assertEq(sm.deactivation_second_authorizer, "cro_flow", "second authorizer");
      const ev = (await eventsFor("safe_mode", safeModeId)).get("safe_mode.deactivated");
      assertEq(ev?.payload.second_authorizer, "cro_flow", "safe_mode.deactivated names both");
    });

    await t.step("deactivating again is refused (409 not active)", async () => {
      const r = await api("POST", `/resolution/safe-mode/${safeModeId}/deactivate`,
        { authorized_by: "cco_flow", second_authorizer: "cro_flow" }, { key: staff });
      assertEq(r.status, 409, `re-deactivate (${body(r)})`);
      assertEq(r.body.type, "safe_mode_not_active", "typed refusal");
    });

    await t.step("with safe mode off the gate restricts nothing: a transfer settles and no decision is recorded", async () => {
      const r = await transfer(partner, from, to, 10_000);
      assertEq(r.status, 201, `post-deactivation transfer (${body(r)})`);
      assertEq(r.body.status, "settled", "settled");
      assertEq(await rowById("event", `ev_smdec_${r.body.id}`), null, "no safe-mode decision once deactivated");
    });
  } finally {
    // never leave the shared core in safe mode
    if (safeModeId && (await rowById("safe_mode", safeModeId))?.status === "active") {
      await api("POST", `/resolution/safe-mode/${safeModeId}/deactivate`,
        { authorized_by: "cco_flow_cleanup", second_authorizer: "cro_flow_cleanup" }, { key: staff });
    }
  }
});
