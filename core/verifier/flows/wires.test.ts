// Wire flows: a partner sends outbound Fedwire transfers for its members, and
// operations supplies the second pair of eyes (EPS-06). Ported from
// core/supabase/tests/e2e/compliance_e2e.sh sections 5, 6, 7 (wire half), 15,
// 17, 20, 21, 22 (wire half) and 33, plus the user-observable behaviour of the
// wires.ts unit stubs (see ledger/wires.md).
//
// Corrections against the bash script:
//   * a wire over $10k raises CG-LGTXN-01 (electronic large transaction), not
//     CG-CTR-01 — CTR-01 is the CASH control (transfers.ts runGate).
//   * accounts need an entity_id; every fixture is a fresh person + account.
//   * the partner acts as a real partner token, never the ops bootstrap key.
import { actor, type Any, api, assert, assertEq, core, flow, personaName } from "./helpers.ts";

const OPENING = 5_000_000; // $50,000
const US_BENEFICIARY = { name: "Acme Corp", country: "US", routing_number: "021000021" };

/** the api_token id helpers.actor() derives from the plaintext it returns */
function tokenIdOf(plaintext: string, actorType: string): string {
  return `tok_test_${actorType}_${plaintext.slice("cass_test_".length, "cass_test_".length + 12)}`;
}

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);

/** a fresh member with a funded checking account, created by the partner */
async function onboard(partner: string, openingCents = OPENING): Promise<string> {
  const e = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1985-06-02",
    address: "200 Market St, Springfield, IL 62701",
  }, { key: partner });
  assertEq(e.status, 201, `create entity (${body(e)})`);
  const a = await api("POST", "/accounts", {
    entity_id: e.body.id, account_type: "checking", opening_deposit_cents: openingCents,
  }, { key: partner });
  assertEq(a.status, 201, `open account (${body(a)})`);
  const got = await api("GET", `/accounts/${a.body.id}`, undefined, { key: partner });
  assertEq(got.body.balance, openingCents, "opening deposit landed");
  return String(a.body.id);
}

async function balanceOf(partner: string, accountId: string): Promise<number> {
  const r = await api("GET", `/accounts/${accountId}`, undefined, { key: partner });
  assertEq(r.status, 200, `account read (${body(r)})`);
  return r.body.balance;
}

/**
 * The balance a member sees once the ledger has applied a wire. Committing (or
 * reversing) an inflight hold is applied by Blnk asynchronously — measured at
 * ~1-3s on the demo core — while a book transfer skips the queue. So a wire's
 * effect on GET /accounts is eventually consistent: poll, bounded, and fail
 * with the last value seen if the money never moves.
 */
async function settledBalance(partner: string, accountId: string, expected: number, msg: string): Promise<void> {
  let seen = await balanceOf(partner, accountId);
  for (let i = 0; i < 20 && seen !== expected; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    seen = await balanceOf(partner, accountId);
  }
  assertEq(seen, expected, msg);
}

function prepare(partner: string, source: string, amount: number, beneficiary: Any = US_BENEFICIARY, base = "/payments/wire") {
  return api("POST", `${base}/prepare`, {
    source_account_id: source, amount_cents: amount, beneficiary, purpose: "flow: wire",
  }, { key: partner });
}

const controls = (r: { body: Any }): string[] =>
  (r.body.control_results ?? []).map((c: { control_id: string }) => c.control_id);

async function wireRow(id: string) {
  const r = await core().from("wire_transfer")
    .select("id, status, amount, originator, return_reason, dual_control_status, created_by, blnk_transaction_id, partner_id")
    .eq("id", id).maybeSingle();
  assert(!r.error, `wire_transfer read: ${r.error?.message}`);
  return r.data as Any;
}

async function rowById(table: string, id: string) {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data as Any;
}

async function wiresFrom(accountId: string) {
  const r = await core().from("wire_transfer").select("id, status").contains("originator", { account_id: accountId });
  assert(!r.error, `wire_transfer read: ${r.error?.message}`);
  return r.data ?? [];
}

/** prepare → ops approves → partner confirms; returns the completed wire id */
async function sendWire(partner: string, approver: string, source: string, amount: number): Promise<string> {
  const p = await prepare(partner, source, amount);
  assertEq(p.status, 201, `prepare (${body(p)})`);
  const ap = await api("POST", `/payments/wire/${p.body.id}/approve`, {}, { key: approver });
  assertEq(ap.status, 200, `second approval (${body(ap)})`);
  const c = await api("POST", `/payments/wire/${p.body.id}/confirm`, {}, { key: partner });
  assertEq(c.status, 200, `confirm (${body(c)})`);
  assertEq(c.body.status, "completed", "wire completed");
  return String(p.body.id);
}

// ------------------------------------------------------------------ §5 + EPS-06

flow("wires: $11k wire → held under dual control → CG-LGTXN-01 flagged → second approver → completed", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  let source = "";
  let wireId = "";
  const AMOUNT = 1_100_000;

  await t.step("onboard a member with a $50k checking account", async () => {
    source = await onboard(partner);
  });

  await t.step("prepare an $11,000 wire: HELD (submitted), CG-LGTXN-01 on the response", async () => {
    const r = await prepare(partner, source, AMOUNT);
    assertEq(r.status, 201, `prepare (${body(r)})`);
    assertEq(r.body.status, "submitted", "prepare holds rather than sends");
    assert(r.body.blnk_transaction_id, "an inflight hold exists in the ledger");
    assert(controls(r).includes("CG-LGTXN-01"), `CG-LGTXN-01 on response (got ${controls(r)})`);
    assert(!controls(r).includes("CG-CTR-01"), "CG-CTR-01 is the cash control — a wire is not currency");
    wireId = String(r.body.id);
  });

  await t.step("evidence: CG-LGTXN-01 control_result + ctr_threshold bsa_alert naming the wire", async () => {
    const cr = await core().from("control_result").select("control_id, decision, subject_ref")
      .eq("event", wireId).eq("control_id", "CG-LGTXN-01");
    assert(!cr.error, `control_result read: ${cr.error?.message}`);
    assertEq((cr.data ?? []).length, 1, "CG-LGTXN-01 persisted for the wire");
    assertEq(cr.data![0].subject_ref, source, "subject is the sending account");
    const al = await core().from("bsa_alert").select("id")
      .eq("alert_type", "ctr_threshold").like("details", `%${wireId}%`);
    assert(!al.error, `bsa_alert read: ${al.error?.message}`);
    assert((al.data ?? []).length > 0, "ctr_threshold bsa_alert raised naming the wire");
  });

  await t.step("the row records its originator and that dual control is REQUIRED", async () => {
    const w = await wireRow(wireId);
    assertEq(w.status, "submitted", "row status");
    assertEq(w.originator?.account_id, source, "originator account captured");
    assertEq(w.dual_control_status, "required", "EPS-06 dual control required");
    assertEq(w.created_by, tokenIdOf(partner, "partner"), "preparer captured at origination");
    const appr = await rowById("payment_approval", `appr_wire_transfer_${wireId}`);
    assert(appr, "maker-checker record opened at prepare");
    assertEq(appr.created_by, tokenIdOf(partner, "partner"), "approval record names the preparer");
    const ev = await rowById("event", `evt_${wireId}_submitted`);
    assertEq(ev?.code, "wire_transfer.submitted", "wire_transfer.submitted event emitted");
  });

  await t.step("the partner reads its wire back: awaiting the second approver", async () => {
    const r = await api("GET", `/wire-transfers/${wireId}`, undefined, { key: partner });
    assertEq(r.status, 200, `read wire (${body(r)})`);
    assertEq(r.body.status, "submitted", "status on read");
    assertEq(r.body.dual_control_status, "required", "dual control visible to the reader");
    assertEq(r.body.amount_cents, AMOUNT, "amount on read");
  });

  await t.step("confirm before approval is refused: dual_control_required, no money moves", async () => {
    const r = await api("POST", `/payments/wire/${wireId}/confirm`, {}, { key: partner });
    assertEq(r.status, 409, `early confirm (${body(r)})`);
    assertEq(r.body.type, "dual_control_required", "typed refusal");
    assert(String(r.body.detail).includes("/approve"), "the refusal says how to resolve it");
    assertEq((await wireRow(wireId)).status, "submitted", "wire still held");
    await settledBalance(partner, source, OPENING, "no money moved");
  });

  await t.step("the preparer cannot approve their own wire (two calls is not two people)", async () => {
    const r = await api("POST", `/payments/wire/${wireId}/approve`, {}, { key: partner });
    assertEq(r.status, 409, `self-approval (${body(r)})`);
    assertEq(r.body.type, "dual_control_violation", "typed refusal");
    assertEq((await wireRow(wireId)).dual_control_status, "required", "still unapproved");
  });

  await t.step("operations approves as the second pair of eyes", async () => {
    const r = await api("POST", `/payments/wire/${wireId}/approve`, {}, { key: ops });
    assertEq(r.status, 200, `approve (${body(r)})`);
    assertEq(r.body.outcome, "approve", "approval outcome");
    const appr = await rowById("payment_approval", `appr_wire_transfer_${wireId}`);
    assertEq(appr.approved_by, tokenIdOf(ops, "pynthia_ops"), "approver recorded");
    assertEq((await wireRow(wireId)).dual_control_status, "approved", "rail row approved");
  });

  await t.step("confirm commits the hold: completed, money left, evidence pair written", async () => {
    const r = await api("POST", `/payments/wire/${wireId}/confirm`, {}, { key: partner });
    assertEq(r.status, 200, `confirm (${body(r)})`);
    assertEq(r.body.status, "completed", "wire completed");
    await settledBalance(partner, source, OPENING - AMOUNT, "sender debited the full amount");
    const bke = await rowById("bookkeeping_entry", `bke_${wireId}_completed`);
    assertEq(bke?.amount, AMOUNT, "bookkeeping entry for the moved amount");
    const ev = await rowById("event", `evt_${wireId}_completed`);
    assertEq(ev?.code, "wire_transfer.completed", "wire_transfer.completed event");
    assertEq(ev?.resource_id, wireId, "event names the wire");
    assertEq(ev?.payload?.amount_cents, AMOUNT, "event payload carries the moved amount");
  });

  await t.step("re-confirming replays instead of double-committing", async () => {
    const r = await api("POST", `/payments/wire/${wireId}/confirm`, {}, { key: partner });
    assertEq(r.status, 200, `re-confirm (${body(r)})`);
    assertEq(r.headers.get("Idempotent-Replayed"), "true", "replay header");
    await settledBalance(partner, source, OPENING - AMOUNT, "no second debit");
  });
});

// ------------------------------------------------------------------------- §6

flow("wires: a wire the member cannot fund is refused by CG-NSF-01 before any hold", async (t) => {
  const partner = await actor("partner");
  let broke = "";
  let wireId = "";

  await t.step("onboard a member with $100", async () => {
    broke = await onboard(partner, 10_000);
  });

  await t.step("prepare a $5,000 wire: 422 insufficient_funds naming the wire", async () => {
    const r = await prepare(partner, broke, 500_000);
    assertEq(r.status, 422, `NSF wire (${body(r)})`);
    assertEq(r.body.type, "insufficient_funds", "typed refusal");
    assertEq(r.body.resource_type, "wire_transfer", "resource_type");
    assert(r.body.resource_id, "the refusal names the wire row");
    wireId = String(r.body.resource_id);
  });

  await t.step("evidence: CG-NSF-01 reject persisted; the row is rejected with no ledger hold", async () => {
    const cr = await core().from("control_result").select("decision, subject_ref")
      .eq("event", wireId).eq("control_id", "CG-NSF-01");
    assert(!cr.error, `control_result read: ${cr.error?.message}`);
    assertEq(cr.data?.[0]?.decision, "reject", "CG-NSF-01 reject persisted");
    assertEq(cr.data?.[0]?.subject_ref, broke, "subject is the sending account");
    const w = await wireRow(wireId);
    assertEq(w?.status, "rejected", "row marked rejected");
    assertEq(w?.blnk_transaction_id, null, "the gate ran before Blnk: no inflight hold");
    await settledBalance(partner, broke, 10_000, "balance untouched");
  });

  await t.step("funds already HELD by a pending wire are not available: a second wire is refused NSF", async () => {
    const m = await onboard(partner, 100_000); // $1,000
    const first = await prepare(partner, m, 90_000);
    assertEq(first.status, 201, `first $900 wire (${body(first)})`);
    const second = await prepare(partner, m, 90_000);
    // Regression guard (bug found by this flow, fixed 2026-10-03): runGate checks Blnk `balance`, ignoring inflight_debit_balance, so a second hold passes CG-NSF-01 and Blnk refuses it (502, no NSF evidence)
    assertEq(second.status, 422, `second $900 wire against $100 available (${body(second)})`);
    assertEq(second.body.type, "insufficient_funds", "typed NSF refusal");
    const cr = await core().from("control_result").select("decision")
      .eq("event", String(second.body.resource_id)).eq("control_id", "CG-NSF-01");
    assertEq(cr.data?.[0]?.decision, "reject", "CG-NSF-01 reject persisted for the second wire");
  });
});

// --------------------------------------------------------------- §7 wire half

flow("wires: the $25k daily velocity cap spans rails (wire-only and wire + book)", async (t) => {
  const partner = await actor("partner");
  let xr = "";
  let mix = "";
  let dest = "";

  await t.step("onboard three members", async () => {
    xr = await onboard(partner);
    mix = await onboard(partner);
    dest = await onboard(partner);
  });

  await t.step("four $6k wires pass; the fifth ($30k day) is blocked by CG-VEL-01", async () => {
    for (let i = 1; i <= 4; i++) {
      const r = await prepare(partner, xr, 600_000);
      assertEq(r.status, 201, `wire ${i} (${body(r)})`);
    }
    const r = await prepare(partner, xr, 600_000);
    assertEq(r.status, 422, `fifth wire (${body(r)})`);
    assertEq(r.body.type, "velocity_limit_exceeded", "typed velocity refusal");
    const blockedId = String(r.body.resource_id);
    const cr = await core().from("control_result").select("decision, subject_ref")
      .eq("event", blockedId).eq("control_id", "CG-VEL-01");
    assertEq(cr.data?.[0]?.decision, "block", "CG-VEL-01 block persisted for the wire");
    assertEq(cr.data?.[0]?.subject_ref, xr, "subject is the sending account");
    assertEq((await wireRow(blockedId))?.status, "rejected", "blocked wire row rejected");
  });

  await t.step("a $20k wire, then a $6k BOOK transfer: the book transfer sees the wire volume", async () => {
    const w = await prepare(partner, mix, 2_000_000);
    assertEq(w.status, 201, `$20k wire (${body(w)})`);
    const r = await api("POST", "/transfers", {
      source_account_id: mix, destination_account_id: dest, amount_cents: 600_000,
      description: "flow: mixed-rail book transfer",
    }, { key: partner });
    assertEq(r.status, 422, `book transfer after the wire (${body(r)})`);
    assertEq(r.body.type, "velocity_limit_exceeded", "mixed-rail block is typed velocity_limit_exceeded");
    const cr = await core().from("control_result").select("decision")
      .eq("event", String(r.body.resource_id)).eq("control_id", "CG-VEL-01");
    assertEq(cr.data?.[0]?.decision, "block", "CG-VEL-01 block persisted for the book transfer");
    await settledBalance(partner, dest, OPENING, "nothing reached the destination");
  });
});

// ------------------------------------------------------------------------ §15

flow("wires: three $4k wires in a day → outbound structuring CG-STR-02 on the third", async (t) => {
  const partner = await actor("partner");
  let ob = "";
  let thirdId = "";

  await t.step("onboard a member", async () => {
    ob = await onboard(partner);
  });

  await t.step("two $4k wires: under the line, no structuring control", async () => {
    for (let i = 1; i <= 2; i++) {
      const r = await prepare(partner, ob, 400_000);
      assertEq(r.status, 201, `wire ${i} (${body(r)})`);
      assert(!controls(r).includes("CG-STR-02"), `wire ${i} ($${4 * i}k day) must not fire CG-STR-02`);
    }
  });

  await t.step("the third takes the day to $12k: settles (alert-only), CG-STR-02 fires, CG-LGTXN-01 silent", async () => {
    const r = await prepare(partner, ob, 400_000);
    assertEq(r.status, 201, `third wire (${body(r)})`);
    assert(controls(r).includes("CG-STR-02"), `CG-STR-02 on response (got ${controls(r)})`);
    assert(!controls(r).includes("CG-LGTXN-01"), "no single wire is over $10k");
    thirdId = String(r.body.id);
  });

  await t.step("evidence: CG-STR-02 control_result + OUTBOUND structuring alert naming the account", async () => {
    const cr = await core().from("control_result").select("decision")
      .eq("event", thirdId).eq("control_id", "CG-STR-02");
    assertEq((cr.data ?? []).length, 1, "CG-STR-02 persisted for the third wire");
    const al = await core().from("bsa_alert").select("id, details")
      .eq("alert_type", "structuring").like("details", "%OUTBOUND%").like("details", `%${ob}%`);
    assert(!al.error, `bsa_alert read: ${al.error?.message}`);
    assert((al.data ?? []).length > 0, "structuring bsa_alert names the sending account");
    assert(al.data!.some((a: Any) => String(a.details).includes(thirdId)), "alert names the triggering wire");
  });
});

// ------------------------------------------------------------- §17 + §33 tail

flow("wires: domestic only — SWIFT/BIC or a non-US country is refused before a row exists", async (t) => {
  const partner = await actor("partner");
  let dom = "";

  await t.step("onboard a member", async () => {
    dom = await onboard(partner);
  });

  await t.step("SWIFT, BIC and a DE beneficiary are each refused 422 international_wire_not_supported", async () => {
    for (const beneficiary of [
      { name: "Acme GmbH", swift_code: "DEUTDEFF" },
      { name: "Acme GmbH", bic: "DEUTDEFF" },
      { name: "Acme GmbH", country: "DE" },
    ]) {
      const r = await prepare(partner, dom, 100_000, beneficiary);
      assertEq(r.status, 422, `${JSON.stringify(beneficiary)} (${body(r)})`);
      assertEq(r.body.type, "international_wire_not_supported", "typed refusal");
    }
  });

  await t.step("the same refusal holds through the sandbox simulator (same writer)", async () => {
    for (const beneficiary of [
      { name: "Banco Foreign", swift_code: "BCFRESMMXXX" },
      { name: "Foreign Co", country: "MX" },
    ]) {
      const r = await prepare(partner, dom, 100_000, beneficiary, "/sandbox/simulate/wire");
      assertEq(r.status, 422, `simulated ${JSON.stringify(beneficiary)} (${body(r)})`);
      assertEq(r.body.type, "international_wire_not_supported", "typed refusal");
    }
  });

  await t.step("malformed prepares are refused with the field named, and confirm on an unknown wire is 404", async () => {
    const ok = { source_account_id: dom, amount_cents: 100_000, beneficiary: US_BENEFICIARY, purpose: "flow: bad" };
    const noKey = await api("POST", "/payments/wire/prepare", ok, { key: partner, idem: null });
    assertEq(noKey.status, 400, `no Idempotency-Key (${body(noKey)})`);
    assertEq(noKey.body.type, "idempotency_key_required", "typed refusal");
    const bad: [string, Record<string, unknown>][] = [
      ["source_account_id", { ...ok, source_account_id: undefined }],
      ["amount_cents", { ...ok, amount_cents: 0 }],
      ["amount_cents", { ...ok, amount_cents: -5 }],
      ["amount_cents", { ...ok, amount_cents: 10.5 }],
      ["beneficiary", { ...ok, beneficiary: "Acme Corp" }],
      ["beneficiary", { ...ok, beneficiary: [US_BENEFICIARY] }],
    ];
    for (const [field, b] of bad) {
      const r = await api("POST", "/payments/wire/prepare", b, { key: partner });
      assertEq(r.status, 400, `${JSON.stringify(b).slice(0, 120)} (${body(r)})`);
      assert((r.body.errors ?? []).some((e: { field: string }) => e.field === field), `error names ${field} (${body(r)})`);
    }
    const missing = await api("POST", `/payments/wire/${crypto.randomUUID()}/confirm`, {}, { key: partner });
    assertEq(missing.status, 404, `confirm unknown wire (${body(missing)})`);
  });

  await t.step("refused wires strand nothing: no row, balance untouched", async () => {
    assertEq((await wiresFrom(dom)).length, 0, "no wire_transfer row for any refused wire");
    await settledBalance(partner, dom, OPENING, "no funds held or moved");
  });

  await t.step("an explicit US beneficiary (any case) is accepted", async () => {
    for (const country of ["US", "us"]) {
      const r = await prepare(partner, dom, 100_000, { ...US_BENEFICIARY, country });
      assertEq(r.status, 201, `country ${country} (${body(r)})`);
      assertEq(r.body.status, "submitted", "held for approval");
    }
  });
});

// ------------------------------------------------------------- §20 + §22 wire

flow("wires: completed wire → return requested → ACCEPTED → returned, funds credited back", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  let wr = "";
  let wid = "";
  const AMOUNT = 200_000;

  await t.step("onboard a member and send a $2,000 wire to completion", async () => {
    wr = await onboard(partner);
    wid = await sendWire(partner, ops, wr, AMOUNT);
    await settledBalance(partner, wr, OPENING - AMOUNT, "debited on completion");
  });

  await t.step("a completed wire with no pending claim cannot be resolved", async () => {
    const r = await api("POST", `/payments/wire/${wid}/return/resolve`, { outcome: "accepted" }, { key: partner });
    assertEq(r.status, 409, `resolve before request (${body(r)})`);
    assertEq(r.body.type, "invalid_state", "typed refusal");
  });

  await t.step("a return request needs a reason", async () => {
    const r = await api("POST", `/payments/wire/${wid}/return`, {}, { key: partner });
    assertEq(r.status, 400, `reasonless return (${body(r)})`);
    assertEq((await wireRow(wid)).status, "completed", "state unchanged");
  });

  await t.step("request the return: return_requested, reason recorded; re-request replays", async () => {
    const r = await api("POST", `/payments/wire/${wid}/return`, { reason: "beneficiary fraud claim" }, { key: partner });
    assertEq(r.status, 200, `return request (${body(r)})`);
    assertEq(r.body.status, "return_requested", "status");
    const again = await api("POST", `/payments/wire/${wid}/return`, { reason: "beneficiary fraud claim" }, { key: partner });
    assertEq(again.status, 200, `re-request (${body(again)})`);
    assertEq(again.headers.get("Idempotent-Replayed"), "true", "replay header");
    const w = await wireRow(wid);
    assertEq(w.status, "return_requested", "DB status");
    assertEq(w.return_reason, "beneficiary fraud claim", "reason recorded");
  });

  await t.step("an unknown outcome is refused", async () => {
    const r = await api("POST", `/payments/wire/${wid}/return/resolve`, { outcome: "maybe" }, { key: partner });
    assertEq(r.status, 400, `bad outcome (${body(r)})`);
    assertEq((await wireRow(wid)).status, "return_requested", "state unchanged");
  });

  await t.step("ACCEPT: returned, reason retained, money credited back by a compensating entry", async () => {
    const r = await api("POST", `/payments/wire/${wid}/return/resolve`, { outcome: "accepted" }, { key: partner });
    assertEq(r.status, 200, `accept (${body(r)})`);
    assertEq(r.body.status, "returned", "status");
    const w = await wireRow(wid);
    assertEq(w.status, "returned", "DB status");
    assertEq(w.return_reason, "beneficiary fraud claim", "reason retained");
    await settledBalance(partner, wr, OPENING, "member made whole");
  });

  await t.step("evidence (§22): completion AND reversal each left a bookkeeping + event pair", async () => {
    const done = await rowById("bookkeeping_entry", `bke_${wid}_completed`);
    assertEq(done?.amount, AMOUNT, "completion bookkeeping entry");
    assertEq((await rowById("event", `evt_${wid}_completed`))?.code, "wire_transfer.completed", "completion event");
    const back = await rowById("bookkeeping_entry", `bke_${wid}_returned`);
    assertEq(back?.amount, AMOUNT, "reversal bookkeeping entry");
    const ev = await rowById("event", `evt_${wid}_returned`);
    assertEq(ev?.code, "wire_transfer.returned", "reversal event");
    assertEq(ev?.payload?.reason, "beneficiary fraud claim", "reversal event carries the reason");
  });

  await t.step("resolving an already-returned wire replays — no second credit", async () => {
    const r = await api("POST", `/payments/wire/${wid}/return/resolve`, { outcome: "accepted" }, { key: partner });
    assertEq(r.status, 200, `re-resolve (${body(r)})`);
    assertEq(r.headers.get("Idempotent-Replayed"), "true", "replay header");
    await settledBalance(partner, wr, OPENING, "no double credit");
  });
});

// ------------------------------------------------------------------------ §21

flow("wires: return request REJECTED → wire stays completed with the reason trail", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  let src = "";
  let wid = "";
  const AMOUNT = 150_000;

  await t.step("onboard a member, complete a $1,500 wire, request its return", async () => {
    src = await onboard(partner);
    wid = await sendWire(partner, ops, src, AMOUNT);
    const r = await api("POST", `/payments/wire/${wid}/return`, { reason: "suspected duplicate" }, { key: partner });
    assertEq(r.status, 200, `return request (${body(r)})`);
  });

  await t.step("REJECT the claim: completed again, trail records both reasons, no money moves", async () => {
    const r = await api("POST", `/payments/wire/${wid}/return/resolve`,
      { outcome: "rejected", reason: "funds already withdrawn" }, { key: partner });
    assertEq(r.status, 200, `reject claim (${body(r)})`);
    assertEq(r.body.status, "completed", "status restored");
    const w = await wireRow(wid);
    assertEq(w.status, "completed", "DB status");
    assert(String(w.return_reason).includes("suspected duplicate"), `trail keeps the request reason (${w.return_reason})`);
    assert(String(w.return_reason).includes("rejected: funds already withdrawn"), `trail records the rejection (${w.return_reason})`);
    assertEq(await rowById("bookkeeping_entry", `bke_${wid}_returned`), null, "no reversal entry");
    await settledBalance(partner, src, OPENING - AMOUNT, "money stays sent");
  });
});

// ------------------------------------------- added: cancel, partial, rejection

flow("wires: cancel releases a hold; partial confirm settles for less; an approver can refuse", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  let src = "";

  await t.step("onboard a member", async () => {
    src = await onboard(partner);
  });

  await t.step("a held wire cannot be returned — cancel is the verb; cancel moves no money", async () => {
    const p = await prepare(partner, src, 300_000);
    assertEq(p.status, 201, `prepare (${body(p)})`);
    const id = String(p.body.id);
    const ret = await api("POST", `/payments/wire/${id}/return`, { reason: "changed mind" }, { key: partner });
    assertEq(ret.status, 409, `return on held wire (${body(ret)})`);
    assertEq(ret.body.type, "invalid_state", "typed refusal");
    const c = await api("POST", `/payments/wire/${id}/cancel`, {}, { key: partner });
    assertEq(c.status, 200, `cancel (${body(c)})`);
    assertEq(c.body.status, "canceled", "status");
    assertEq((await wireRow(id)).status, "canceled", "DB status");
    assertEq(await rowById("bookkeeping_entry", `bke_${id}_completed`), null, "no movement artifacts");
    assertEq(await rowById("event", `evt_${id}_completed`), null, "no completion event");
    await settledBalance(partner, src, OPENING, "balance untouched");
    const again = await api("POST", `/payments/wire/${id}/cancel`, {}, { key: partner });
    assertEq(again.headers.get("Idempotent-Replayed"), "true", "re-cancel replays");
    const conf = await api("POST", `/payments/wire/${id}/confirm`, {}, { key: partner });
    assertEq(conf.status, 409, `confirm after cancel (${body(conf)})`);
  });

  await t.step("partial confirm: over-the-hold refused; $2,000 of a $5,000 hold settles for $2,000", async () => {
    const p = await prepare(partner, src, 500_000);
    assertEq(p.status, 201, `prepare (${body(p)})`);
    const id = String(p.body.id);
    assertEq((await api("POST", `/payments/wire/${id}/approve`, {}, { key: ops })).status, 200, "approved");
    const over = await api("POST", `/payments/wire/${id}/confirm`, { amount_cents: 600_000 }, { key: partner });
    assertEq(over.status, 400, `over-hold confirm (${body(over)})`);
    assertEq((await wireRow(id)).status, "submitted", "still held after the refusal");
    const c = await api("POST", `/payments/wire/${id}/confirm`, { amount_cents: 200_000 }, { key: partner });
    assertEq(c.status, 200, `partial confirm (${body(c)})`);
    assertEq(c.body.status, "completed", "a partial confirm is terminal");
    const bke = await rowById("bookkeeping_entry", `bke_${id}_completed`);
    assertEq(bke?.amount, 200_000, "bookkeeping records what actually moved");
    const ev = await rowById("event", `evt_${id}_completed`);
    assertEq(ev?.payload?.amount_cents, 200_000, "event: moved amount");
    assertEq(ev?.payload?.held_cents, 500_000, "event: held amount");
    await settledBalance(partner, src, OPENING - 200_000, "only the confirmed amount left");
  });

  await t.step("the second approver REJECTS: the wire can never be confirmed", async () => {
    const p = await prepare(partner, src, 100_000);
    assertEq(p.status, 201, `prepare (${body(p)})`);
    const id = String(p.body.id);
    const ap = await api("POST", `/payments/wire/${id}/approve`, { outcome: "reject", note: "flow: unknown beneficiary" }, { key: ops });
    assertEq(ap.status, 200, `approver rejects (${body(ap)})`);
    assertEq(ap.body.outcome, "reject", "decision");
    const appr = await rowById("payment_approval", `appr_wire_transfer_${id}`);
    assertEq(appr.rejected_by, tokenIdOf(ops, "pynthia_ops"), "rejecter recorded");
    assertEq((await wireRow(id)).dual_control_status, "rejected", "rail row rejected");
    const c = await api("POST", `/payments/wire/${id}/confirm`, {}, { key: partner });
    assertEq(c.status, 409, `confirm after rejection (${body(c)})`);
    assertEq(c.body.type, "dual_control_rejected", "typed refusal");
    await settledBalance(partner, src, OPENING - 200_000, "no money moved");
  });
});

// ------------------------------------------------------------------------ §33

flow("wires: sandbox simulator — network accepts one wire, rejects another", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  const SIM = "/sandbox/simulate/wire";
  let src = "";
  let acc = "";
  let rej = "";

  await t.step("onboard a member", async () => {
    src = await onboard(partner);
  });

  await t.step("simulated prepare holds; after the second approval the network accepts", async () => {
    const p = await prepare(partner, src, 250_000, { name: "Acme Corp", country: "US" }, SIM);
    assertEq(p.status, 201, `simulated prepare (${body(p)})`);
    assertEq(p.body.status, "submitted", "prepare holds rather than sends");
    acc = String(p.body.id);
    // EPS-06 applies through the simulator too — same writer
    const early = await api("POST", `${SIM}/${acc}/confirm`, {}, { key: partner });
    assertEq(early.status, 409, `simulated confirm before approval (${body(early)})`);
    assertEq((await api("POST", `/payments/wire/${acc}/approve`, {}, { key: ops })).status, 200, "approved");
    const c = await api("POST", `${SIM}/${acc}/confirm`, {}, { key: partner });
    assertEq(c.status, 200, `simulated confirm (${body(c)})`);
    assertEq(c.body.status, "completed", "accepted wire completes");
    await settledBalance(partner, src, OPENING - 250_000, "accepted wire debited");
  });

  await t.step("the network rejects a held wire: reason required, then rejected and the hold released", async () => {
    const p = await prepare(partner, src, 150_000, { name: "Closed Bank", country: "US" }, SIM);
    assertEq(p.status, 201, `simulated prepare 2 (${body(p)})`);
    rej = String(p.body.id);
    const noReason = await api("POST", `${SIM}/${rej}/reject`, {}, { key: partner });
    assertEq(noReason.status, 400, `reasonless rejection (${body(noReason)})`);
    assertEq((await wireRow(rej)).status, "submitted", "still held");
    const r = await api("POST", `${SIM}/${rej}/reject`, { reason: "beneficiary account closed" }, { key: partner });
    assertEq(r.status, 200, `simulated rejection (${body(r)})`);
    assertEq(r.body.status, "rejected", "status");
    const w = await wireRow(rej);
    assertEq(w.status, "rejected", "DB status");
    assertEq(w.return_reason, "beneficiary account closed", "rejection reason retained");
    await settledBalance(partner, src, OPENING - 250_000, "no money moved for the rejected wire");
  });

  await t.step("evidence: zero-amount bookkeeping + wire_transfer.rejected event naming the wire", async () => {
    const bke = await rowById("bookkeeping_entry", `bke_${rej}_rejected`);
    assertEq(bke?.amount, 0, "rejection books no money");
    const ev = await core().from("event").select("code, payload")
      .eq("code", "wire_transfer.rejected").eq("resource_id", rej);
    assertEq((ev.data ?? []).length, 1, "downstream learns the wire is dead");
    assertEq((ev.data![0] as Any).payload?.reason, "beneficiary account closed", "event carries the reason");
    assertEq((ev.data![0] as Any).payload?.released_cents, 150_000, "event carries the released hold");
  });

  await t.step("re-rejecting replays; a COMPLETED wire cannot be rejected — it must be returned", async () => {
    const again = await api("POST", `${SIM}/${rej}/reject`, { reason: "dup notice" }, { key: partner });
    assertEq(again.status, 200, `re-reject (${body(again)})`);
    assertEq(again.headers.get("Idempotent-Replayed"), "true", "replay header");
    const late = await api("POST", `${SIM}/${acc}/reject`, { reason: "too late" }, { key: partner });
    assertEq(late.status, 409, `reject a completed wire (${body(late)})`);
    assertEq(late.body.type, "invalid_state", "typed refusal");
    assert(String(late.body.detail).includes("returned"), "the refusal points at the return path");
    assertEq((await wireRow(acc)).status, "completed", "completed wire untouched");
  });
});
