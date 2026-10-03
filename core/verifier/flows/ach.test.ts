// ACH flows — a partner originates outbound ACH debits for its members and the
// network later settles, returns or corrects them. Ported from
// core/supabase/tests/e2e/compliance_e2e.sh sections 9, 10, 11, 18, the ACH
// half of 22, and 32, plus the user-observable behaviours pinned by the stubbed
// unit file core/supabase/functions/api/ach.test.ts (see ledger/ach.md).
//
// Every journey acts as a real partner token (POST /payments/ach is
// partner-audience) on fresh, run-unique members. Compliance claims are
// asserted on the rows an examiner reads — ach_transfer, control_result,
// bsa_alert, bookkeeping_entry, event — not only on the HTTP answer.
//
// Stale expectations in the bash script that this port corrects:
//   * CG-CTR-01 is the CASH control. An electronic ACH over $10k raises
//     CG-LGTXN-01 (alert-only) + a ctr_threshold bsa_alert (transfers.ts runGate).
//   * accounts require entity_id; the script's new_account omitted it.
import { actor, type Any, api, assert, assertEq, core, flow, personaName } from "./helpers.ts";

const COUNTERPARTY = { name: "Acme Vendor" };

/** A fresh member with a funded checking account, opened by `key`. */
async function member(key: string, openingCents: number): Promise<string> {
  const e = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1987-06-03",
    address: "200 Elm St, Springfield, IL 62701",
  }, { key });
  assertEq(e.status, 201, `create entity (${JSON.stringify(e.body).slice(0, 200)})`);
  const a = await api("POST", "/accounts", {
    entity_id: e.body.id, account_type: "checking", opening_deposit_cents: openingCents,
  }, { key });
  assertEq(a.status, 201, `open account (${JSON.stringify(a.body).slice(0, 200)})`);
  return String(a.body.id);
}

async function balance(key: string, accountId: string): Promise<number> {
  const r = await api("GET", `/accounts/${accountId}`, undefined, { key });
  assertEq(r.status, 200, "account readable");
  return r.body.balance;
}

// The account balance a partner reads is a MIRROR of Blnk. Book transfers
// refresh it inline (transfers.ts), but the ACH writer does not: the
// blnk-webhook refreshes it after Blnk applies the movement, so it is
// eventually consistent. Poll for the expected value rather than racing it.
async function expectBalance(key: string, accountId: string, expected: number, msg: string): Promise<void> {
  let last = NaN;
  for (let i = 0; i < 20; i++) {
    last = await balance(key, accountId);
    if (last === expected) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  assertEq(last, expected, `${msg} (after 20s of webhook mirror refresh)`);
}

/** For "nothing moved" claims: give the mirror time to catch up, then read once. */
async function expectBalanceStays(key: string, accountId: string, expected: number, msg: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 6_000));
  assertEq(await balance(key, accountId), expected, msg);
}

const hasControl = (body: Any, id: string, decision: string) =>
  (body?.control_results ?? []).some((c: Any) => c.control_id === id && c.decision === decision);

async function achRow(id: string) {
  const r = await core().from("ach_transfer")
    .select("status, amount, window, return_reason, noc, blnk_transaction_id").eq("id", id).maybeSingle();
  assert(!r.error, `ach_transfer read: ${r.error?.message}`);
  return r.data;
}

async function countRows(table: string, filter: Record<string, string>): Promise<number> {
  let q = core().from(table).select("id", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const r = await q;
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.count ?? 0;
}

async function controlResults(event: string, controlId: string) {
  const r = await core().from("control_result").select("decision").eq("event", event).eq("control_id", controlId);
  assert(!r.error, `control_result read: ${r.error?.message}`);
  return r.data ?? [];
}

const unauthorizedAlerts = (achId: string) =>
  countRows("bsa_alert", { alert_type: "unauthorized_ach_return", id: `alert_${achId}_unauthorized_ach_return` });

// ---------------------------------------------------------------- §9a, §10, §22
flow("ach: $11k debit → CG-LGTXN-01 + CTR alert → settle commits the hold → evidence pair", async (t) => {
  const OPENING = 5_000_000;
  const AMOUNT = 1_100_000;
  const partner = await actor("partner");
  let acct = "";
  let achId = "";
  const idem = `flow-ach-${crypto.randomUUID()}`;
  const body = {
    source_account_id: "", amount_cents: AMOUNT, counterparty: COUNTERPARTY, window: "next_day",
  };

  await t.step("partner onboards a member with $50,000", async () => {
    acct = await member(partner, OPENING);
    body.source_account_id = acct;
  });

  await t.step("submit a $11,000 ACH: held as submitted, CG-LGTXN-01 on the response", async () => {
    const r = await api("POST", "/payments/ach", body, { key: partner, idem });
    assertEq(r.status, 201, `submit (${JSON.stringify(r.body).slice(0, 300)})`);
    assertEq(r.body.status, "submitted", "alert-only: the entry is still submitted to the network");
    assertEq(r.body.amount_cents, AMOUNT, "amount echoed");
    assertEq(r.body.window, "next_day", "settlement window echoed");
    assert(r.body.blnk_transaction_id, "an inflight hold was placed");
    assert(hasControl(r.body, "CG-LGTXN-01", "pass"),
      `CG-LGTXN-01 on the response (got ${JSON.stringify(r.body.control_results)})`);
    assert(!hasControl(r.body, "CG-CTR-01", "pass"), "CG-CTR-01 is the cash control; an ACH is not currency");
    achId = String(r.body.id);
  });

  await t.step("a retried submission replays the same entry, never double-holds", async () => {
    const r = await api("POST", "/payments/ach", body, { key: partner, idem });
    assertEq(r.status, 201, `replay (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.headers.get("Idempotent-Replayed"), "true", "replay header");
    assertEq(String(r.body.id), achId, "same entry id");
    const n = await core().from("ach_transfer").select("id", { count: "exact", head: true })
      .contains("originator", { account_id: acct });
    assertEq(n.count, 1, "exactly one ach_transfer row for the member");
  });

  await t.step("the examiner's evidence exists: row, control_result, ctr_threshold alert, created event", async () => {
    const row = await achRow(achId);
    assertEq(row?.status, "submitted", "row status");
    assert(row?.blnk_transaction_id, "row carries the hold's Blnk id");
    assertEq((await controlResults(achId, "CG-LGTXN-01")).length, 1, "one CG-LGTXN-01 control_result for the entry");
    const alert = await core().from("bsa_alert").select("alert_type, status, details")
      .eq("id", `alert_${achId}_ctr_threshold`).maybeSingle();
    assertEq(alert.data?.alert_type, "ctr_threshold", "ctr_threshold bsa_alert raised");
    assert(String(alert.data?.details).includes(achId), "alert names the ACH entry");
    assertEq(await countRows("event", { id: `evt_${achId}_created`, code: "ach_transfer.created" }), 1,
      "ach_transfer.created event");
  });

  await t.step("the partner reads the entry back with its control results", async () => {
    // Regression guard (bug found by this flow, fixed 2026-10-03): GET /ach-transfers/{id} serves ach_transfer.control_results, a column postAch never writes — reads back [] although CG-LGTXN-01 fired
    const r = await api("GET", `/ach-transfers/${achId}`, undefined, { key: partner });
    assertEq(r.status, 200, `read (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.status, "submitted", "status on read");
    assert(hasControl(r.body, "CG-LGTXN-01", "pass"),
      `CG-LGTXN-01 persisted on the entry (got ${JSON.stringify(r.body.control_results)})`);
  });

  await t.step("the batch clears: settle commits the hold and the member is debited", async () => {
    const r = await api("POST", `/payments/ach/${achId}/settle`, {}, { key: partner });
    assertEq(r.status, 200, `settle (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.status, "settled", "settled");
    assertEq((await achRow(achId))?.status, "settled", "row settled in the database");
    await expectBalance(partner, acct, OPENING - AMOUNT, "member debited by the settled amount");
  });

  await t.step("settlement left its evidence pair: bookkeeping entry + ach_transfer.settled", async () => {
    const bke = await core().from("bookkeeping_entry").select("amount").eq("id", `bke_${achId}_settled`).maybeSingle();
    assertEq(bke.data?.amount, AMOUNT, "bookkeeping entry for the settled amount");
    assertEq(await countRows("event", { id: `evt_${achId}_settled`, code: "ach_transfer.settled" }), 1,
      "ach_transfer.settled event");
  });

  await t.step("a duplicate settlement notice replays — no second commit, no second debit", async () => {
    const r = await api("POST", `/payments/ach/${achId}/settle`, {}, { key: partner });
    assertEq(r.status, 200, "re-settle");
    assertEq(r.headers.get("Idempotent-Replayed"), "true", "replay header");
    await expectBalanceStays(partner, acct, OPENING - AMOUNT, "balance unchanged by the duplicate");
    assertEq(await countRows("bookkeeping_entry", { id: `bke_${achId}_settled` }), 1, "still one bookkeeping entry");
  });
});

// ---------------------------------------------------------------- §9b
flow("ach: malformed submissions refused; NSF blocks before any hold (CG-NSF-01)", async (t) => {
  const partner = await actor("partner");
  let broke = "";
  let nsfId = "";

  await t.step("partner onboards a member with $100", async () => {
    broke = await member(partner, 10_000);
  });

  await t.step("malformed submissions are refused with field-level errors", async () => {
    const good = { source_account_id: broke, amount_cents: 1_000, counterparty: COUNTERPARTY };

    const noKey = await api("POST", "/payments/ach", good, { key: partner, idem: null });
    assertEq(noKey.status, 400, "no Idempotency-Key");
    assertEq(noKey.body.type, "idempotency_key_required", "error type");

    const cases: [string, Record<string, unknown>, string][] = [
      ["missing source", { amount_cents: 1_000, counterparty: COUNTERPARTY }, "source_account_id"],
      ["zero amount", { ...good, amount_cents: 0 }, "amount_cents"],
      ["negative amount", { ...good, amount_cents: -5 }, "amount_cents"],
      ["fractional cents", { ...good, amount_cents: 10.5 }, "amount_cents"],
      ["unknown window", { ...good, window: "whenever" }, "window"],
      ["scalar counterparty", { ...good, counterparty: "Acme" }, "counterparty"],
      ["numeric counterparty", { ...good, counterparty: 7 }, "counterparty"],
      ["array counterparty", { ...good, counterparty: ["a"] }, "counterparty"],
    ];
    for (const [label, body, field] of cases) {
      const r = await api("POST", "/payments/ach", body, { key: partner });
      assertEq(r.status, 400, `${label}: status (${JSON.stringify(r.body).slice(0, 200)})`);
      assertEq(r.body.type, "validation_error", `${label}: type`);
      assert((r.body.errors ?? []).some((e: Any) => e.field === field), `${label}: names ${field}`);
    }
    const n = await core().from("ach_transfer").select("id", { count: "exact", head: true })
      .contains("originator", { account_id: broke });
    assertEq(n.count, 0, "no refused submission left an ach_transfer row");
  });

  await t.step("a $5,000 ACH from $100 is refused 422 insufficient_funds", async () => {
    const r = await api("POST", "/payments/ach",
      { source_account_id: broke, amount_cents: 500_000, counterparty: COUNTERPARTY }, { key: partner });
    assertEq(r.status, 422, `NSF (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.type, "insufficient_funds", "error type");
    assertEq(r.body.resource_type, "ach_transfer", "resource_type");
    assert(r.body.resource_id, "names the refused entry");
    nsfId = String(r.body.resource_id);
  });

  await t.step("the refusal is evidenced: rejected row with no hold, CG-NSF-01 reject", async () => {
    const row = await achRow(nsfId);
    assertEq(row?.status, "rejected", "row rejected");
    assertEq(row?.blnk_transaction_id ?? null, null, "no inflight hold — the gate ran before Blnk");
    const cr = await controlResults(nsfId, "CG-NSF-01");
    assertEq(cr.length, 1, "one CG-NSF-01 control_result");
    assertEq(cr[0].decision, "reject", "decision");
    await expectBalanceStays(partner, broke, 10_000, "member balance untouched");
  });

  await t.step("a rejected entry cannot be settled, and a NOC for it is refused", async () => {
    const s = await api("POST", `/payments/ach/${nsfId}/settle`, {}, { key: partner });
    assertEq(s.status, 409, `settle rejected (${JSON.stringify(s.body).slice(0, 200)})`);
    assertEq(s.body.type, "invalid_state", "error type");
    const n = await api("POST", `/payments/ach/${nsfId}/noc`, { code: "C01" }, { key: partner });
    assertEq(n.status, 409, `NOC on rejected (${JSON.stringify(n.body).slice(0, 200)})`);
    assertEq(n.body.type, "invalid_state", "error type");
  });

  await t.step("resolving an entry that does not exist is a 404", async () => {
    const r = await api("POST", `/payments/ach/${crypto.randomUUID()}/settle`, {}, { key: partner });
    assertEq(r.status, 404, `unknown entry (${JSON.stringify(r.body).slice(0, 200)})`);
  });
});

// ---------------------------------------------------------------- §11
flow("ach: ACH-only volume past $25k/day is blocked by CG-VEL-01", async (t) => {
  const partner = await actor("partner");
  let acct = "";
  let blockedId = "";

  await t.step("partner onboards a member with $50,000", async () => {
    acct = await member(partner, 5_000_000);
  });

  await t.step("four $6,000 ACH debits are accepted ($24,000 today)", async () => {
    for (let i = 1; i <= 4; i++) {
      const r = await api("POST", "/payments/ach",
        { source_account_id: acct, amount_cents: 600_000, counterparty: COUNTERPARTY }, { key: partner });
      assertEq(r.status, 201, `ACH #${i} (${JSON.stringify(r.body).slice(0, 200)})`);
      assertEq(r.body.status, "submitted", `ACH #${i} status`);
    }
  });

  await t.step("the fifth ($30,000 today) is blocked 422 velocity_limit_exceeded", async () => {
    const r = await api("POST", "/payments/ach",
      { source_account_id: acct, amount_cents: 600_000, counterparty: COUNTERPARTY }, { key: partner });
    assertEq(r.status, 422, `fifth ACH (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.type, "velocity_limit_exceeded", "error type");
    assertEq(r.body.resource_type, "ach_transfer", "resource_type");
    blockedId = String(r.body.resource_id);
  });

  await t.step("the block is evidenced: CG-VEL-01 block, row rejected, no hold", async () => {
    const cr = await controlResults(blockedId, "CG-VEL-01");
    assertEq(cr.length, 1, "one CG-VEL-01 control_result");
    assertEq(cr[0].decision, "block", "decision");
    const row = await achRow(blockedId);
    assertEq(row?.status, "rejected", "row rejected");
    assertEq(row?.blnk_transaction_id ?? null, null, "no inflight hold");
  });
});

// ---------------------------------------------------------------- §18, §22
flow("ach: settled entry returned late (R01) → compensating reversal + evidence", async (t) => {
  const OPENING = 5_000_000;
  const AMOUNT = 150_000;
  const partner = await actor("partner");
  let acct = "";
  let achId = "";

  await t.step("partner onboards a member and submits a $1,500 ACH", async () => {
    acct = await member(partner, OPENING);
    const r = await api("POST", "/payments/ach",
      { source_account_id: acct, amount_cents: AMOUNT, counterparty: COUNTERPARTY, window: "next_day" },
      { key: partner });
    assertEq(r.status, 201, `submit (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.status, "submitted", "submitted");
    achId = String(r.body.id);
  });

  await t.step("the batch settles and the member is debited", async () => {
    const r = await api("POST", `/payments/ach/${achId}/settle`, {}, { key: partner });
    assertEq(r.status, 200, `settle (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.status, "settled", "settled");
    await expectBalance(partner, acct, OPENING - AMOUNT, "debited");
  });

  await t.step("an R01 arrives after settlement: returned, money comes back", async () => {
    const r = await api("POST", `/payments/ach/${achId}/return`, { return_reason: "R01" }, { key: partner });
    assertEq(r.status, 200, `late return (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.status, "returned", "returned");
    assertEq(r.body.return_reason, "R01", "reason on the response");
    await expectBalance(partner, acct, OPENING, "compensating reversal credited the member back");
  });

  await t.step("the row keeps the code in its own column and the window intact", async () => {
    const row = await achRow(achId);
    assertEq(row?.status, "returned", "row returned");
    assertEq(row?.return_reason, "R01", "return_reason column");
    assertEq(row?.window, "next_day", "settlement window not mangled by the return");
  });

  await t.step("the reversal left its evidence pair; R01 raises no unauthorized alert", async () => {
    const bke = await core().from("bookkeeping_entry").select("amount").eq("id", `bke_${achId}_returned`).maybeSingle();
    assertEq(bke.data?.amount, AMOUNT, "reversal bookkeeping entry");
    const evt = await core().from("event").select("code, payload").eq("id", `evt_${achId}_returned`).maybeSingle();
    assertEq(evt.data?.code, "ach_transfer.returned", "ach_transfer.returned event");
    assertEq((evt.data?.payload as Any)?.reason, "R01", "event carries the reason");
    assertEq(await unauthorizedAlerts(achId), 0, "R01 is not an unauthorized claim");
  });

  await t.step("once returned, a settle is refused and a duplicate return replays", async () => {
    const s = await api("POST", `/payments/ach/${achId}/settle`, {}, { key: partner });
    assertEq(s.status, 409, "settle after return");
    assertEq(s.body.type, "invalid_state", "error type");
    const again = await api("POST", `/payments/ach/${achId}/return`, { return_reason: "R01" }, { key: partner });
    assertEq(again.status, 200, "duplicate return");
    assertEq(again.headers.get("Idempotent-Replayed"), "true", "replay header");
    await expectBalanceStays(partner, acct, OPENING, "no second credit");
  });
});

// ------------------------------------------------- pre-settlement returns (added)
flow("ach: pre-settlement return voids the hold; every NACHA code accepted, unauthorized ones alerted", async (t) => {
  const OPENING = 5_000_000;
  const partner = await actor("partner");
  let acct = "";
  let achId = "";

  const submit = async (amount: number) => {
    const r = await api("POST", "/payments/ach",
      { source_account_id: acct, amount_cents: amount, counterparty: COUNTERPARTY, window: "same_day" },
      { key: partner });
    assertEq(r.status, 201, `submit (${JSON.stringify(r.body).slice(0, 200)})`);
    return String(r.body.id);
  };

  await t.step("partner onboards a member and submits a $2,500 ACH", async () => {
    acct = await member(partner, OPENING);
    achId = await submit(250_000);
  });

  await t.step("a blank or unknown return code is refused and nothing is stored", async () => {
    const blank = await api("POST", `/payments/ach/${achId}/return`, { return_reason: "" }, { key: partner });
    assertEq(blank.status, 400, "blank reason");
    const bogus = await api("POST", `/payments/ach/${achId}/return`, { return_reason: "R99" }, { key: partner });
    assertEq(bogus.status, 400, "R99");
    assertEq(bogus.body.errors?.[0]?.field, "return_reason", "names return_reason");
    const row = await achRow(achId);
    assertEq(row?.status, "submitted", "still submitted");
    assertEq(row?.return_reason ?? null, null, "nothing written to return_reason");
  });

  await t.step("an R02 before settlement voids the hold: returned, nothing booked, no debit", async () => {
    const r = await api("POST", `/payments/ach/${achId}/return`, { return_reason: "R02" }, { key: partner });
    assertEq(r.status, 200, `return (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.status, "returned", "returned");
    const row = await achRow(achId);
    assertEq(row?.return_reason, "R02", "return_reason column");
    assertEq(row?.window, "same_day", "window untouched");
    assertEq(await countRows("bookkeeping_entry", { id: `bke_${achId}_returned` }), 0, "no money moved, nothing booked");
    assertEq(await countRows("event", { id: `evt_${achId}_returned` }), 0, "no returned movement event");
    await expectBalanceStays(partner, acct, OPENING, "member never debited");
    const s = await api("POST", `/payments/ach/${achId}/settle`, {}, { key: partner });
    assertEq(s.status, 409, "money must not move after a return");
  });

  await t.step("every recognised NACHA code is accepted; only R05/R07/R10/R29 raise an alert", async () => {
    const UNAUTH = new Set(["R05", "R07", "R10", "R29"]);
    for (const code of ["R01", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10", "R16", "R20", "R29"]) {
      const id = await submit(1_000);
      const r = await api("POST", `/payments/ach/${id}/return`, { return_reason: code }, { key: partner });
      assertEq(r.status, 200, `${code} accepted (${JSON.stringify(r.body).slice(0, 200)})`);
      assertEq((await achRow(id))?.return_reason, code, `${code} stored`);
      assertEq(await unauthorizedAlerts(id), UNAUTH.has(code) ? 1 : 0, `${code} unauthorized alert`);
    }
  });
});

// ---------------------------------------------------------------- §32
flow("ach: sandbox simulations run the real writer — gate, return codes, NOC", async (t) => {
  const partner = await actor("partner");
  let acct = "";
  let simId = "";
  let nocId = "";
  const sim = (path: string, body: unknown) => api("POST", `/sandbox/simulate/ach${path}`, body, { key: partner });

  await t.step("partner onboards a member with $50,000", async () => {
    acct = await member(partner, 5_000_000);
  });

  await t.step("a simulated $15,000 ACH still runs the gate: CG-LGTXN-01 + CTR alert", async () => {
    const r = await sim("", { source_account_id: acct, amount_cents: 1_500_000, counterparty: { name: "Sim Vendor" }, window: "next_day" });
    assertEq(r.status, 201, `simulate (${JSON.stringify(r.body).slice(0, 200)})`);
    assert(hasControl(r.body, "CG-LGTXN-01", "pass"), `CG-LGTXN-01 on the response (got ${JSON.stringify(r.body.control_results)})`);
    simId = String(r.body.id);
    assertEq((await controlResults(simId, "CG-LGTXN-01")).length, 1, "durable control_result for the simulated entry");
    assertEq(await countRows("bsa_alert", { id: `alert_${simId}_ctr_threshold`, alert_type: "ctr_threshold" }), 1,
      "durable CTR alert raised by the simulation");
  });

  await t.step("a bogus return code R99 is refused and not stored", async () => {
    const r = await sim(`/${simId}/return`, { return_reason: "R99" });
    assertEq(r.status, 400, "R99");
    assertEq((await achRow(simId))?.return_reason ?? null, null, "R99 not written");
  });

  await t.step("simulated settle, then an R10 after settlement", async () => {
    const s = await sim(`/${simId}/settle`, {});
    assertEq(s.status, 200, "settle");
    assertEq(s.body.status, "settled", "settled");
    const r = await sim(`/${simId}/return`, { return_reason: "R10" });
    assertEq(r.status, 200, `return (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.status, "returned", "returned");
    const row = await achRow(simId);
    assertEq(row?.return_reason, "R10", "R10 in its own column");
    assertEq(row?.window, "next_day", "window survived");
  });

  await t.step("R10 is an unauthorized claim: alert raised, reversal booked", async () => {
    const a = await core().from("bsa_alert").select("status, details")
      .eq("id", `alert_${simId}_unauthorized_ach_return`).maybeSingle();
    assertEq(a.data?.status, "open", "unauthorized_ach_return alert open");
    assert(String(a.data?.details).includes(simId), "alert names the entry");
    assertEq(await countRows("bookkeeping_entry", { id: `bke_${simId}_returned` }), 1, "compensating entry booked");
  });

  await t.step("an ordinary R01 return raises no unauthorized alert", async () => {
    const r = await sim("", { source_account_id: acct, amount_cents: 5_000, counterparty: { name: "Sim Vendor" }, window: "next_day" });
    assertEq(r.status, 201, "simulate");
    const id = String(r.body.id);
    const ret = await sim(`/${id}/return`, { return_reason: "R01" });
    assertEq(ret.status, 200, "return");
    assertEq(await unauthorizedAlerts(id), 0, "no unauthorized alert for R01");
  });

  await t.step("a NOC on a settled entry records the correction without changing status", async () => {
    const r = await sim("", { source_account_id: acct, amount_cents: 7_500, counterparty: { name: "NOC Vendor" }, window: "next_day" });
    assertEq(r.status, 201, "simulate");
    nocId = String(r.body.id);
    assertEq((await sim(`/${nocId}/settle`, {})).status, 200, "settle");
    const n = await sim(`/${nocId}/noc`, { code: "C01", corrections: { account_number: "9876543210" } });
    assertEq(n.status, 200, `NOC (${JSON.stringify(n.body).slice(0, 200)})`);
    assertEq(n.body.status, "settled", "a NOC does not change status");
    assertEq(n.body.noc?.code, "C01", "noc on the response");
    assertEq(n.body.noc?.corrections?.account_number, "9876543210", "correction on the response");
    const row = await achRow(nocId);
    assertEq(row?.status, "settled", "row still settled");
    assertEq((row?.noc as Any)?.code, "C01", "correction stored for future entries");
  });

  await t.step("the NOC left a durable event", async () => {
    assertEq(await countRows("event", { id: `evt_${nocId}_noc_C01`, code: "ach_transfer.noc.received" }), 1,
      "ach_transfer.noc.received event");
  });

  await t.step("a NOC whose corrections contradict its code, or an unknown code, is refused", async () => {
    const bad = await sim(`/${nocId}/noc`, { code: "C01", corrections: { routing_number: "021000021" } });
    assertEq(bad.status, 400, "C01 with routing_number");
    assertEq(bad.body.errors?.[0]?.field, "corrections", "names corrections");
    const unknown = await sim(`/${nocId}/noc`, { code: "C99" });
    assertEq(unknown.status, 400, "C99");
  });

  await t.step("a C02 routing correction is accepted with its own event", async () => {
    const n = await sim(`/${nocId}/noc`, { code: "C02", corrections: { routing_number: "021000021" } });
    assertEq(n.status, 200, "C02");
    assertEq(await countRows("event", { id: `evt_${nocId}_noc_C02`, code: "ach_transfer.noc.received" }), 1,
      "C02 event keyed on its code");
  });
});
