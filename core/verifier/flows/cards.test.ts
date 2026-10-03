// Flows: card authorizations, as an integrating fintech drives them.
//
// A card hold is not a single commit-or-void like a wire: it is drawn down
// across several captures (tips, split shipments), so the running total, the
// remainder and the terminal state must all agree — and each capture is its own
// money movement with its own bookkeeping entry + event. Every flow acts as a
// real partner (the card rail is partner-audience), on fresh members, and checks
// the rows an examiner reads, not just the HTTP answer: the capture evidence is
// written in a try/catch in cards.ts, so a missing row would otherwise be silent.
//
// Ported from compliance_e2e.sh sections 12, 13, 14, 23 and 34. Coverage of the
// card writer's unit tests is mapped in ledger/cards.md.
import { actor, api, assert, assertEq, core, flow, personaName } from "./helpers.ts";

type Any = Record<string, unknown> & { [k: string]: Any };

const brief = (b: unknown) => JSON.stringify(b).slice(0, 300);

/** Onboard a fresh member as the partner: person → KYC → funded checking. */
async function member(partner: string, openingCents: number): Promise<{ entity: string; account: string }> {
  const e = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1987-06-03",
    address: "12 Elm St, Springfield, IL 62701", tin: "900-00-0000",
  }, { key: partner });
  assertEq(e.status, 201, `create entity (${brief(e.body)})`);
  const v = await api("POST", `/entities/${e.body.id}/verifications`, { simulate: "approve" }, { key: partner });
  assertEq(v.status, 201, `verification (${brief(v.body)})`);
  assertEq(v.body.status, "approved", "KYC decision");
  const a = await api("POST", "/accounts", {
    entity_id: e.body.id, account_type: "checking", opening_deposit_cents: openingCents,
  }, { key: partner });
  assertEq(a.status, 201, `open account (${brief(a.body)})`);
  return { entity: String(e.body.id), account: String(a.body.id) };
}

async function bookkeeping(prefix: string): Promise<{ id: string; amount: number }[]> {
  const r = await core().from("bookkeeping_entry").select("id, amount").like("id", `${prefix}%`);
  assert(!r.error, `bookkeeping_entry read: ${r.error?.message}`);
  return (r.data ?? []) as { id: string; amount: number }[];
}

async function authRow(id: string): Promise<Any> {
  const r = await core().from("card_authorization")
    .select("id, status, amount, blnk_committed_amount, blnk_inflight_id, decline_reason, partner_id, synced_at")
    .eq("id", id).maybeSingle();
  assert(!r.error, `card_authorization read: ${r.error?.message}`);
  return r.data as Any;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the ledger's asynchronous confirmation of the last move on a card.
 * Blnk posts transaction.applied to the blnk-webhook function ~1s after a
 * capture commits, and that handler patches the card_authorization row. A real
 * merchant's next capture (a tip adjustment, a split shipment) arrives long
 * after that, so the flow must not race ahead of it: capturing twice inside one
 * second only proves the API works when the webhook has not landed yet.
 */
async function ledgerSettles(id: string): Promise<void> {
  const first = (await authRow(id))?.synced_at;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if ((await authRow(id))?.synced_at !== first) break;
  }
  await sleep(1000); // let any trailing delivery for the same move land
}

/** Poll the member's balance mirror (refreshed by the same webhook) until it converges. */
async function balanceEventually(partner: string, acct: string, expected: number): Promise<number> {
  let got = -1;
  for (let i = 0; i < 30; i++) {
    const r = await api("GET", `/accounts/${acct}`, undefined, { key: partner });
    assertEq(r.status, 200, `account (${brief(r.body)})`);
    got = r.body.balance;
    if (got === expected) return got;
    await sleep(1000);
  }
  return got;
}

// ---------------------------------------------------------------- 12 + 23
flow("cards: authorize → partial capture → over-capture refused → incremental capture → evidence per delta", async (t) => {
  const partner = await actor("partner");
  let acct = "";
  let card = "";
  let hold = "";

  await t.step("onboard a member with $50,000", async () => {
    acct = (await member(partner, 5_000_000)).account;
  });

  await t.step("authorize $1,000 at Acme Coffee: a hold, nothing captured", async () => {
    const r = await api("POST", "/payments/card/authorize",
      { source_account_id: acct, amount_cents: 100_000, merchant: "Acme Coffee" }, { key: partner });
    assertEq(r.status, 201, `authorize (${brief(r.body)})`);
    assertEq(r.body.status, "authorized", "status");
    assertEq(r.body.captured_cents, 0, "nothing captured yet");
    assertEq(r.body.remaining_cents, 100_000, "the whole hold is capturable");
    assert(r.body.blnk_inflight_id, "an inflight hold was placed in the ledger");
    card = String(r.body.id);
    hold = String(r.body.blnk_inflight_id);

    const row = await authRow(card);
    assertEq(row?.status, "authorized", "row status");
    assert(row?.partner_id, "the authorization is owned by the partner that placed it");
  });

  await t.step("authorize alone books nothing (a hold, not a movement)", async () => {
    assertEq((await bookkeeping(`bke_${card}`)).length, 0, "no bookkeeping entry for a hold");
  });

  await t.step("capture is refused for zero, negative and fractional amounts", async () => {
    for (const amount of [0, -1, 12.5]) {
      const r = await api("POST", `/payments/card/${card}/capture`, { amount_cents: amount }, { key: partner });
      assertEq(r.status, 400, `amount ${amount} (${brief(r.body)})`);
    }
    const row = await authRow(card);
    assertEq(row?.blnk_committed_amount, 0, "a refused capture committed nothing");
  });

  await t.step("capture $300: partially_captured, remainder tracked", async () => {
    const r = await api("POST", `/payments/card/${card}/capture`, { amount_cents: 30_000 }, { key: partner });
    assertEq(r.status, 200, `capture (${brief(r.body)})`);
    assertEq(r.body.status, "partially_captured", "status");
    assertEq(r.body.captured_cents, 30_000, "captured_cents");
    assertEq(r.body.remaining_cents, 70_000, "remaining_cents");
  });

  await t.step("once the ledger confirms the capture, the remaining hold is still the one we placed", async () => {
    await ledgerSettles(card);
    const row = await authRow(card);
    assertEq(row?.blnk_committed_amount, 30_000, "running total after the ledger's confirmation");
    // Regression guard (bug found by this flow, fixed 2026-10-03): blnk-webhook overwrites card_authorization.blnk_inflight_id with the APPLIED child txn id (handlers.ts:144, ID_COLUMN card_authorization → blnk_inflight_id), so the remaining hold can no longer be captured, reversed or expired
    assertEq(row?.blnk_inflight_id, hold, "the inflight hold id is unchanged by the capture's confirmation");
  });

  await t.step("the first capture books its own $300 entry + a captured event", async () => {
    const bke = await bookkeeping(`bke_${card}_captured_c30000`);
    assertEq(bke.length, 1, "bookkeeping entry for the first capture");
    assertEq(bke[0].amount, 30_000, "the entry books the delta");
    const ev = await core().from("event").select("code, payload").eq("id", `evt_${card}_captured_c30000`).maybeSingle();
    assert(!ev.error, `event read: ${ev.error?.message}`);
    assertEq(ev.data?.code, "card_authorization.captured", "event code");
    assertEq(ev.data?.payload?.captured_cents, 30_000, "payload: this capture");
    assertEq(ev.data?.payload?.captured_total_cents, 30_000, "payload: running total");
    assertEq(ev.data?.payload?.remaining_cents, 70_000, "payload: remainder");
  });

  await t.step("over-capture is refused, not clamped — even by a single cent", async () => {
    for (const amount of [80_000, 70_001]) {
      const r = await api("POST", `/payments/card/${card}/capture`, { amount_cents: amount }, { key: partner });
      assertEq(r.status, 422, `over-capture ${amount} (${brief(r.body)})`);
      assertEq(r.body.type, "capture_exceeds_authorization", "typed refusal");
    }
    const row = await authRow(card);
    assertEq(row?.blnk_committed_amount, 30_000, "an over-capture committed nothing");
    assertEq(row?.status, "partially_captured", "still partially captured");
  });

  await t.step("capture the exact $700 remainder: terminal captured", async () => {
    const r = await api("POST", `/payments/card/${card}/capture`, { amount_cents: 70_000 }, { key: partner });
    // Regression guard (bug found by this flow, fixed 2026-10-03): 502 bank_error — the capture commits against the child txn id the webhook wrote into blnk_inflight_id (blnk-webhook/handlers.ts:144)
    assertEq(r.status, 200, `capture (${brief(r.body)})`);
    assertEq(r.body.status, "captured", "exact-boundary capture is terminal");
    assertEq(r.body.captured_cents, 100_000, "full amount captured");
    assertEq(r.body.remaining_cents, 0, "nothing left held");
  });

  await t.step("the incremental capture got its own $700 evidence pair; entries sum to $1,000", async () => {
    const bke = await bookkeeping(`bke_${card}_captured_c100000`);
    assertEq(bke.length, 1, "second bookkeeping entry");
    assertEq(bke[0].amount, 70_000, "the second entry books the $700 delta, not the total");
    const ev = await core().from("event").select("code, payload")
      .eq("id", `evt_${card}_captured_c100000`).eq("code", "card_authorization.captured");
    assertEq((ev.data ?? []).length, 1, "a distinct captured event for the second capture");
    assertEq(ev.data![0].payload?.captured_total_cents, 100_000, "event carries the running total");
    const all = await bookkeeping(`bke_${card}_captured`);
    assertEq(all.reduce((s, e) => s + e.amount, 0), 100_000, "entries sum to what actually moved");
  });

  await t.step("re-capturing a captured authorization replays and commits nothing", async () => {
    const r = await api("POST", `/payments/card/${card}/capture`, {}, { key: partner });
    assertEq(r.status, 200, `re-capture (${brief(r.body)})`);
    assertEq(r.headers.get("Idempotent-Replayed"), "true", "marked as a replay");
    assertEq(r.body.captured_cents, 100_000, "running total unchanged");
    assertEq((await bookkeeping(`bke_${card}_captured`)).length, 2, "no third entry");
  });

  await t.step("a captured authorization cannot be reversed or expired — nothing is held", async () => {
    const rev = await api("POST", `/payments/card/${card}/reverse`, {}, { key: partner });
    assertEq(rev.status, 409, `reverse (${brief(rev.body)})`);
    const exp = await api("POST", `/payments/card/${card}/expire`, {}, { key: partner });
    assertEq(exp.status, 409, `expire (${brief(exp.body)})`);
    assertEq(exp.body.type, "invalid_state", "typed refusal");
    assertEq((await authRow(card))?.status, "captured", "still captured");
  });

  await t.step("after the ledger confirms, the partner reads the card back with the same arithmetic", async () => {
    await ledgerSettles(card);
    // Regression guard (bug found by this flow, fixed 2026-10-03): blnk-webhook sets blnk_committed_amount to the APPLIED child's precise_amount (this increment) instead of the running total (handlers.ts:151-153), so a $300+$700 card reads back as $700 captured
    assertEq((await authRow(card))?.blnk_committed_amount, 100_000, "row running total survives the confirmation");
    const r = await api("GET", `/cards/${card}`, undefined, { key: partner });
    assertEq(r.status, 200, `get card (${brief(r.body)})`);
    assertEq(r.body.status, "captured", "status");
    assertEq(r.body.captured_cents, 100_000, "captured_cents");
    assertEq(r.body.remaining_cents, 0, "remaining_cents");
  });

  await t.step("capture with no amount takes the whole remaining hold", async () => {
    const a = await api("POST", "/payments/card/authorize",
      { source_account_id: acct, amount_cents: 25_000, merchant: "Acme Coffee" }, { key: partner });
    assertEq(a.status, 201, `authorize (${brief(a.body)})`);
    const id = String(a.body.id);
    const r = await api("POST", `/payments/card/${id}/capture`, {}, { key: partner });
    assertEq(r.status, 200, `capture (${brief(r.body)})`);
    assertEq(r.body.status, "captured", "status");
    assertEq(r.body.captured_cents, 25_000, "the whole hold captured");
    assertEq(r.body.remaining_cents, 0, "nothing left");
    const bke = await bookkeeping(`bke_${id}_captured_c25000`);
    assertEq(bke[0]?.amount, 25_000, "one entry for the whole hold");
  });
});

// ---------------------------------------------------------------------- 13
flow("cards: reverse an under-captured hold → remainder released, capture retained, nothing booked", async (t) => {
  const partner = await actor("partner");
  const OPENING = 5_000_000;
  let acct = "";
  let card = "";

  await t.step("onboard a member with $50,000", async () => {
    acct = (await member(partner, OPENING)).account;
  });

  await t.step("authorize $500 and capture $200 of it", async () => {
    const a = await api("POST", "/payments/card/authorize",
      { source_account_id: acct, amount_cents: 50_000, merchant: "Acme Coffee" }, { key: partner });
    assertEq(a.status, 201, `authorize (${brief(a.body)})`);
    card = String(a.body.id);
    const c = await api("POST", `/payments/card/${card}/capture`, { amount_cents: 20_000 }, { key: partner });
    assertEq(c.status, 200, `capture (${brief(c.body)})`);
    assertEq(c.body.status, "partially_captured", "status");
    await ledgerSettles(card); // the cancellation comes later, after the ledger confirmed the capture
  });

  await t.step("the merchant cancels: reversed, the $200 already captured stays captured", async () => {
    const r = await api("POST", `/payments/card/${card}/reverse`, { reason: "merchant cancelled" }, { key: partner });
    // Regression guard (bug found by this flow, fixed 2026-10-03): 502 bank_error — the void targets the APPLIED child txn id the webhook wrote into blnk_inflight_id (blnk-webhook/handlers.ts:144)
    assertEq(r.status, 200, `reverse (${brief(r.body)})`);
    assertEq(r.body.status, "reversed", "status");
    assertEq(r.body.captured_cents, 20_000, "reversal never claws back a completed capture");
    assertEq(r.body.remaining_cents, 0, "nothing still advertised as capturable");
    const row = await authRow(card);
    assertEq(row?.status, "reversed", "row status");
    assertEq(row?.decline_reason, "merchant cancelled", "the reason is kept on the record");
  });

  await t.step("reversal books nothing — only the capture moved money", async () => {
    const bke = await bookkeeping(`bke_${card}`);
    assertEq(bke.length, 1, `only the capture's entry exists (got ${bke.map((b) => b.id).join(",")})`);
    assertEq(bke[0].id, `bke_${card}_captured_c20000`, "the capture's entry");
  });

  await t.step("the member's balance reflects only the $200 that was captured", async () => {
    assertEq(await balanceEventually(partner, acct, OPENING - 20_000), OPENING - 20_000,
      "the $300 remainder was released back to the member");
  });

  await t.step("re-reversing replays instead of voiding twice", async () => {
    const r = await api("POST", `/payments/card/${card}/reverse`, {}, { key: partner });
    assertEq(r.status, 200, `re-reverse (${brief(r.body)})`);
    assertEq(r.headers.get("Idempotent-Replayed"), "true", "marked as a replay");
    assertEq(r.body.status, "reversed", "still reversed");
  });

  await t.step("capturing a reversed authorization is a 409, not a silent no-op", async () => {
    const r = await api("POST", `/payments/card/${card}/capture`, { amount_cents: 1_000 }, { key: partner });
    assertEq(r.status, 409, `capture after reverse (${brief(r.body)})`);
    assertEq(r.body.type, "invalid_state", "typed refusal");
    assertEq((await authRow(card))?.blnk_committed_amount, 20_000, "nothing further committed");
  });
});

// ---------------------------------------------------------------------- 14
flow("cards: NSF declines before any hold → CG-NSF-01 evidence, declined row is dead", async (t) => {
  const partner = await actor("partner");
  let acct = "";
  let card = "";

  await t.step("onboard a member with $100", async () => {
    acct = (await member(partner, 10_000)).account;
  });

  await t.step("a $5,000 authorization is declined with insufficient_funds", async () => {
    const r = await api("POST", "/payments/card/authorize",
      { source_account_id: acct, amount_cents: 500_000, merchant: "Acme Coffee" }, { key: partner });
    assertEq(r.status, 422, `authorize (${brief(r.body)})`);
    assertEq(r.body.type, "insufficient_funds", "typed decline");
    assertEq(r.body.resource_type, "card_authorization", "names the resource");
    assert(r.body.resource_id, "names the declined authorization");
    card = String(r.body.resource_id);
  });

  await t.step("the decline is recorded: row declined, no hold placed, CG-NSF-01 reject", async () => {
    const row = await authRow(card);
    assertEq(row?.status, "declined", "row marked declined");
    assertEq(row?.blnk_inflight_id ?? null, null, "no hold placed — the gate ran before the ledger");
    assertEq(row?.decline_reason, "insufficient_funds", "decline reason kept");
    const cr = await core().from("control_result").select("control_id, decision").eq("event", card);
    assert(!cr.error, `control_result read: ${cr.error?.message}`);
    assert(
      (cr.data ?? []).some((c) => c.control_id === "CG-NSF-01" && c.decision === "reject"),
      `CG-NSF-01 reject persisted (got ${JSON.stringify(cr.data)})`,
    );
  });

  await t.step("a declined authorization cannot be captured", async () => {
    const r = await api("POST", `/payments/card/${card}/capture`, {}, { key: partner });
    assertEq(r.status, 409, `capture declined (${brief(r.body)})`);
    assertEq((await bookkeeping(`bke_${card}`)).length, 0, "nothing booked");
  });

  await t.step("capturing an authorization that does not exist is a 404", async () => {
    const r = await api("POST", `/payments/card/cauth_${crypto.randomUUID()}/capture`, {}, { key: partner });
    assertEq(r.status, 404, `capture unknown (${brief(r.body)})`);
  });
});

// ---------------------------------------------------------------------- 34
flow("cards: sandbox simulate → partial + incremental capture → expiry releases the remainder", async (t) => {
  const partner = await actor("partner");
  let acct = "";
  let partial = "";
  let untouched = "";

  await t.step("onboard a member with $50,000", async () => {
    acct = (await member(partner, 5_000_000)).account;
  });

  await t.step("simulated authorize places a $1,000 hold", async () => {
    const r = await api("POST", "/sandbox/simulate/card/authorize",
      { source_account_id: acct, amount_cents: 100_000, merchant: "Sim Coffee" }, { key: partner });
    assertEq(r.status, 201, `simulate authorize (${brief(r.body)})`);
    assertEq(r.body.status, "authorized", "hold placed");
    partial = String(r.body.id);
  });

  await t.step("simulated partial then incremental capture accumulate", async () => {
    const c1 = await api("POST", `/sandbox/simulate/card/${partial}/capture`, { amount_cents: 30_000 }, { key: partner });
    assertEq(c1.status, 200, `capture 1 (${brief(c1.body)})`);
    assertEq(c1.body.status, "partially_captured", "status");
    assertEq(c1.body.remaining_cents, 70_000, "remainder tracks the undrawn hold");
    // Regression guard (bug found by this flow, fixed 2026-10-03): if the first capture's webhook lands before this call (~1s), blnk_inflight_id already points at the child txn and this 502s (blnk-webhook/handlers.ts:144)
    const c2 = await api("POST", `/sandbox/simulate/card/${partial}/capture`, { amount_cents: 20_000 }, { key: partner });
    assertEq(c2.status, 200, `capture 2 (${brief(c2.body)})`);
    assertEq(c2.body.captured_cents, 50_000, "running total accumulates");
    const bke = await bookkeeping(`bke_${partial}_captured_c50000`);
    assertEq(bke[0]?.amount, 20_000, "each capture books its own delta, not the total");
  });

  await t.step("after the ledger confirms, the running total is still $500", async () => {
    await ledgerSettles(partial);
    // Regression guard (bug found by this flow, fixed 2026-10-03): blnk-webhook regresses blnk_committed_amount to the last increment (20000) instead of the running total (handlers.ts:151-153)
    assertEq((await authRow(partial))?.blnk_committed_amount, 50_000, "row running total");
  });

  await t.step("over-capture beyond the hold is refused", async () => {
    const r = await api("POST", `/sandbox/simulate/card/${partial}/capture`, { amount_cents: 60_000 }, { key: partner });
    // Regression guard (bug found by this flow, fixed 2026-10-03): with the regressed running total cards.ts computes remaining=80000, so the 422 guard is bypassed and the over-capture reaches Blnk (502)
    assertEq(r.status, 422, `over-capture (${brief(r.body)})`);
    assertEq(r.body.type, "capture_exceeds_authorization", "typed refusal");
  });

  await t.step("the partially-captured auth expires: captured stays captured, remainder released", async () => {
    const r = await api("POST", `/sandbox/simulate/card/${partial}/expire`, {}, { key: partner });
    // Regression guard (bug found by this flow, fixed 2026-10-03): 502 bank_error — the void targets the APPLIED child txn id the webhook wrote into blnk_inflight_id (blnk-webhook/handlers.ts:144)
    assertEq(r.status, 200, `expire (${brief(r.body)})`);
    assertEq(r.body.status, "expired", "status");
    assertEq(r.body.captured_cents, 50_000, "what was captured stays captured");
    assertEq(r.body.remaining_cents, 0, "nothing still advertised as capturable");
  });

  await t.step("expiry books no money but leaves a card_authorization.expired event", async () => {
    const bke = await bookkeeping(`bke_${partial}_expired`);
    assertEq(bke.length, 1, "expiry entry written");
    assertEq(bke[0].amount, 0, "expiry moves no money — the remainder never left");
    const ev = await core().from("event").select("code, payload").eq("id", `evt_${partial}_expired`).maybeSingle();
    assertEq(ev.data?.code, "card_authorization.expired", "expiry event");
    assertEq(ev.data?.payload?.released_cents, 50_000, "event says how much was released");
    const row = await authRow(partial);
    assertEq(row?.status, "expired", "its own terminal state, distinct from reversed");
    assertEq(row?.decline_reason, "authorization_expired", "the cause is recorded");
  });

  await t.step("re-expiring replays rather than double-voiding", async () => {
    const r = await api("POST", `/sandbox/simulate/card/${partial}/expire`, {}, { key: partner });
    assertEq(r.status, 200, `re-expire (${brief(r.body)})`);
    assertEq(r.headers.get("Idempotent-Replayed"), "true", "marked as a replay");
  });

  await t.step("a wholly uncaptured auth expires and releases the entire hold", async () => {
    const a = await api("POST", "/sandbox/simulate/card/authorize",
      { source_account_id: acct, amount_cents: 40_000, merchant: "Never Captures Inc" }, { key: partner });
    assertEq(a.status, 201, `authorize (${brief(a.body)})`);
    untouched = String(a.body.id);
    const r = await api("POST", `/sandbox/simulate/card/${untouched}/expire`, {}, { key: partner });
    assertEq(r.status, 200, `expire (${brief(r.body)})`);
    assertEq(r.body.remaining_cents, 0, "full hold released");
    assertEq(r.body.captured_cents, 0, "captured nothing");
  });

  await t.step("capturing an expired auth is refused", async () => {
    const r = await api("POST", `/sandbox/simulate/card/${untouched}/capture`, { amount_cents: 1_000 }, { key: partner });
    assertEq(r.status, 409, `capture after expiry (${brief(r.body)})`);
  });

  await t.step("the member was charged only the $500 actually captured", async () => {
    assertEq(await balanceEventually(partner, acct, 5_000_000 - 50_000), 5_000_000 - 50_000,
      "expired remainders came back to the member");
  });

  await t.step("an unsimulated rail returns the typed 501 naming what IS simulated", async () => {
    const r = await api("POST", "/sandbox/simulate/check/deposit", {}, { key: partner });
    assertEq(r.status, 501, `unsimulated rail (${brief(r.body)})`);
    assert(String(r.body.detail ?? "").includes("POST /payments/ach"), `501 lists the simulated routes (${brief(r.body)})`);
  });
});
