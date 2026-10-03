// Book transfers + cross-rail: the money-movement journeys a partner runs every
// day, and the controls that ride on them. Ported from compliance_e2e.sh
// sections 1, 2, 4, 8, 16, 19, 24, 25 (and the runGate unit tests in
// core/supabase/functions/api/transfers.test.ts — see ledger/transfers.md).
//
// Every scenario acts as a REAL partner (the endpoints are partner-audience)
// on run-unique members, and every compliance claim is read back from the row
// an examiner would read: control_result, bsa_alert, bookkeeping_entry, event,
// the transfer row itself — and, for conservation, the Blnk ledger.
//
// Velocity (CG-VEL-01, $25k/day) and structuring are per-account daily
// aggregates, so every scenario gets fresh accounts; nothing here depends on
// what an earlier flow (or an earlier run) moved today.
import { actor, type Any, api, assert, assertEq, core, flow, personaName } from "./helpers.ts";

const $ = (dollars: number) => Math.round(dollars * 100);

// ------------------------------------------------------------ local helpers

/** A fresh member: a person entity + a checking account, owned by `key`'s partner. */
async function member(key: string, openingCents = 0): Promise<{ entity: string; account: string }> {
  const e = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1987-06-15",
    address: "200 Elm St, Springfield, IL 62701",
  }, { key });
  assertEq(e.status, 201, `create entity (${JSON.stringify(e.body).slice(0, 200)})`);
  const a = await api("POST", "/accounts", {
    entity_id: e.body.id, account_type: "checking",
    ...(openingCents > 0 ? { opening_deposit_cents: openingCents } : {}),
  }, { key });
  assertEq(a.status, 201, `open account (${JSON.stringify(a.body).slice(0, 200)})`);
  assertEq(a.body.balance, openingCents, "opening deposit landed");
  return { entity: String(e.body.id), account: String(a.body.id) };
}

const transfer = (key: string, src: string, dst: string, cents: number, description = "flow") =>
  api("POST", "/transfers", {
    source_account_id: src, destination_account_id: dst, amount_cents: cents, description,
  }, { key });

const inline = (r: { body: Any }): string[] =>
  ((r.body?.control_results ?? []) as { control_id: string }[]).map((c) => c.control_id).sort();

/** control_result rows the core persisted for one movement */
async function persisted(eventId: string): Promise<{ control_id: string; decision: string; subject_ref: string }[]> {
  const r = await core().from("control_result").select("control_id, decision, subject_ref").eq("event", eventId);
  assert(!r.error, `control_result read: ${r.error?.message}`);
  return r.data ?? [];
}

async function transferRow(id: string): Promise<Any> {
  const r = await core().from("transfer").select("id, status, amount, partner_id, blnk_transaction_id")
    .eq("id", id).maybeSingle();
  assert(!r.error, `transfer read: ${r.error?.message}`);
  return r.data;
}

async function balanceOf(key: string, account: string): Promise<number> {
  const r = await api("GET", `/accounts/${account}`, undefined, { key });
  assertEq(r.status, 200, `account ${account} readable`);
  return r.body.balance;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The partner a test token acts for. */
async function ownerOf(token: string): Promise<string> {
  const r = await core().from("api_token").select("partner_id").eq("token_hash", await sha256Hex(token)).single();
  assert(!r.error, `token lookup: ${r.error?.message}`);
  return String(r.data!.partner_id);
}

/** The Blnk balance behind a core account — the ledger, not the mirror. */
async function ledger(account: string): Promise<{ balance: number; inflight_debit: number }> {
  const url = Deno.env.get("BLNK_API_URL") ?? "";
  const key = Deno.env.get("BLNK_API_KEY") ?? "";
  assert(url && key, "conservation reads the ledger: BLNK_API_URL + BLNK_API_KEY must be set");
  const a = await core().from("account").select("blnk_balance_id").eq("id", account).single();
  assert(!a.error && a.data.blnk_balance_id, `blnk_balance_id for ${account}: ${a.error?.message}`);
  const res = await fetch(`${url.replace(/\/$/, "")}/balances/${a.data!.blnk_balance_id}`, {
    headers: { "X-blnk-key": key }, signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json();
  assertEq(res.status, 200, `blnk balance read (${JSON.stringify(body).slice(0, 200)})`);
  return { balance: Number(body.balance ?? 0), inflight_debit: Number(body.inflight_debit_balance ?? 0) };
}

// ===========================================================================
// 1. Book-transfer controls on one partner's members (sections 1, 2, 4, 19, 25)
// ===========================================================================

flow("transfers: book transfer — clean, NSF, exact balance, $10k line, velocity cap, evidence", async (t) => {
  let partner = "";
  const m: Record<string, string> = {};
  let okId = "";
  let nsfId = "";
  let velBlockedId = "";

  await t.step("fixtures: a partner onboards fresh members", async () => {
    partner = await actor("partner");
    m.richA = (await member(partner, $(50_000))).account;
    m.richB = (await member(partner, $(50_000))).account;
    m.broke = (await member(partner, $(100))).account;
    m.tenA = (await member(partner, $(50_000))).account;
    m.tenB = (await member(partner, $(100))).account;
    m.velSrc = (await member(partner, $(50_000))).account;
    m.velDst = (await member(partner, $(100))).account;
  });

  await t.step("a small, funded transfer settles with no control artifacts (§1)", async () => {
    const r = await transfer(partner, m.richA, m.richB, $(250), "flow: compliant");
    assertEq(r.status, 201, `transfer (${JSON.stringify(r.body).slice(0, 300)})`);
    assertEq(r.body.status, "settled", "settled");
    assertEq(r.body.amount_cents, $(250), "amount_cents echoed");
    assertEq(inline(r).length, 0, `no control fired inline (${inline(r)})`);
    okId = String(r.body.id);
    assertEq((await persisted(okId)).length, 0, "no control_result rows for a clean transfer");
    const row = await transferRow(okId);
    assertEq(row?.status, "settled", "transfer row settled");
    assert(row?.blnk_transaction_id, "the Blnk mirror is on the row");
    assertEq(await balanceOf(partner, m.richA), $(50_000 - 250), "source debited");
    assertEq(await balanceOf(partner, m.richB), $(50_000 + 250), "destination credited");
  });

  await t.step("the settled transfer left its bookkeeping entry + transfer.settled event (§19)", async () => {
    const bke = await core().from("bookkeeping_entry").select("id, amount, account_code_5300")
      .eq("id", `bke_${okId}`).maybeSingle();
    assert(bke.data, `bookkeeping_entry bke_${okId} exists (${bke.error?.message ?? "missing"})`);
    assertEq(bke.data!.amount, $(250), "bookkeeping amount");
    assertEq(bke.data!.account_code_5300, "018", "booked against 5300 Total Shares & Deposits");

    const evt = await core().from("event").select("id, code, type, resource_id, entity_hash, payload")
      .eq("id", `evt_${okId}_settled`).maybeSingle();
    assert(evt.data, `event evt_${okId}_settled exists (${evt.error?.message ?? "missing"})`);
    assertEq(evt.data!.code, "transfer.settled", "event code");
    assertEq(evt.data!.type, "transfer", "event type");
    assertEq(evt.data!.resource_id, okId, "event names the transfer");
    assertEq(evt.data!.entity_hash, await sha256Hex(m.richA), "entity_hash is sha256(source account)");
    assertEq(evt.data!.payload?.amount_cents, $(250), "payload amount");
    assertEq(evt.data!.payload?.source_account_id, m.richA, "payload source");
    assertEq(evt.data!.payload?.destination_account_id, m.richB, "payload destination");
    assert(evt.data!.payload?.blnk_transaction_id, "payload carries the Blnk transaction");
  });

  await t.step("the partner finds the transfer on BOTH legs' statements", async () => {
    const tr = await api("GET", `/transfers/${okId}`, undefined, { key: partner });
    assertEq(tr.status, 200, "transfer readable");
    assertEq(tr.body.amount_cents, $(250), "single read serves amount_cents");
    for (const acct of [m.richA, m.richB]) {
      const l = await api("GET", `/transfers?account_id=${acct}`, undefined, { key: partner });
      assertEq(l.status, 200, `list for ${acct}`);
      const hit = (l.body.data as Any[]).find((x) => x.id === okId);
      assert(hit, `transfer appears on ${acct === m.richA ? "the debit" : "the credit"} leg's list`);
      assertEq(hit.amount_cents, $(250), "list serves amount_cents");
      assertEq(hit.amount, undefined, "the raw column name does not leak");
      assertEq(hit.originator?.account_id, m.richA, "originator leg");
    }
  });

  await t.step("NSF is refused, the row rejected, CG-NSF-01 persisted (§2)", async () => {
    const r = await transfer(partner, m.broke, m.richA, $(5_000), "flow: nsf");
    assertEq(r.status, 422, `NSF (${JSON.stringify(r.body).slice(0, 300)})`);
    assertEq(r.body.type, "insufficient_funds", "typed error");
    assertEq(r.body.resource_type, "transfer", "envelope names the rail");
    nsfId = String(r.body.resource_id);
    assert(nsfId.startsWith("tr_"), `envelope names the transfer (${nsfId})`);
    const cr = await persisted(nsfId);
    assertEq(JSON.stringify(cr.map((c) => [c.control_id, c.decision, c.subject_ref])),
      JSON.stringify([["CG-NSF-01", "reject", m.broke]]), "exactly one CG-NSF-01 reject against the payer");
    assertEq((await transferRow(nsfId))?.status, "rejected", "transfer row rejected");
    assertEq(await balanceOf(partner, m.broke), $(100), "nothing left the account");
    const l = await api("GET", `/transfers?account_id=${m.broke}&status=rejected`, undefined, { key: partner });
    assertEq(l.status, 200, "rejected filter lists");
    assert((l.body.data as Any[]).some((x) => x.id === nsfId), "the rejected attempt is on the statement");
  });

  await t.step("a balance exactly equal to the amount is sufficient, not NSF", async () => {
    const r = await transfer(partner, m.broke, m.richA, $(100), "flow: exact balance");
    assertEq(r.status, 201, `exact-balance transfer (${JSON.stringify(r.body).slice(0, 300)})`);
    assertEq(r.body.status, "settled", "settled");
    assert(!inline(r).includes("CG-NSF-01"), "no NSF on available == requested");
    assertEq(await balanceOf(partner, m.broke), 0, "account drained to exactly zero");
  });

  await t.step("exactly $10,000 trips nothing — the large-txn line is strictly above", async () => {
    const r = await transfer(partner, m.tenA, m.tenB, $(10_000), "flow: on the line");
    assertEq(r.status, 201, `transfer (${JSON.stringify(r.body).slice(0, 300)})`);
    assertEq(inline(r).length, 0, `no control inline at exactly $10k (${inline(r)})`);
    const id = String(r.body.id);
    assertEq((await persisted(id)).length, 0, "no CG-LGTXN-01 / STR-01 / STR-02 persisted at exactly $10k");
    const alert = await core().from("bsa_alert").select("id").like("details", `%${id}%`);
    assertEq((alert.data ?? []).length, 0, "no bsa_alert names a $10k transfer");
  });

  await t.step("velocity: 4 × $6k settle; outbound structuring flags the $12k day (CG-STR-02)", async () => {
    for (let i = 1; i <= 4; i++) {
      const r = await transfer(partner, m.velSrc, m.velDst, $(6_000), `flow: velocity ${i}`);
      assertEq(r.status, 201, `velocity leg ${i} (${JSON.stringify(r.body).slice(0, 300)})`);
      if (i === 1) assert(!inline(r).includes("CG-STR-02"), "first $6k: outbound aggregate under the line");
      if (i === 2) {
        assert(inline(r).includes("CG-STR-02"), `second $6k takes the day to $12k: CG-STR-02 (${inline(r)})`);
        assert(!inline(r).includes("CG-LGTXN-01"), "no per-txn large-txn on a $6k leg");
        const cr = await persisted(String(r.body.id));
        assert(cr.some((c) => c.control_id === "CG-STR-02" && c.subject_ref === m.velSrc),
          "CG-STR-02 persisted against the sending account");
      }
    }
  });

  await t.step("velocity lands exactly on the $25k cap without blocking", async () => {
    const r = await transfer(partner, m.velSrc, m.velDst, $(1_000), "flow: velocity on the cap");
    assertEq(r.status, 201, `$24k + $1k = $25k is allowed (${JSON.stringify(r.body).slice(0, 300)})`);
    assertEq(r.body.status, "settled", "settled on the cap");
  });

  await t.step("one cent over the cap is BLOCKED with CG-VEL-01 only (§4)", async () => {
    const r = await transfer(partner, m.velSrc, m.velDst, 1, "flow: velocity over");
    assertEq(r.status, 422, `over the cap (${JSON.stringify(r.body).slice(0, 300)})`);
    assertEq(r.body.type, "velocity_limit_exceeded", "typed error");
    velBlockedId = String(r.body.resource_id);
    const cr = await persisted(velBlockedId);
    assertEq(JSON.stringify(cr.map((c) => [c.control_id, c.decision, c.subject_ref])),
      JSON.stringify([["CG-VEL-01", "block", m.velSrc]]),
      "the block is reported once — no outbound-structuring double report");
    assertEq((await transferRow(velBlockedId))?.status, "rejected", "transfer row rejected");
    assertEq(await balanceOf(partner, m.velSrc), $(50_000 - 25_000), "exactly $25k left today, not a cent more");
  });

  await t.step("GET /control-results agrees with the database and the inline results (§25)", async () => {
    const byEvent = await api("GET", `/control-results?event=${velBlockedId}`, undefined, { key: partner });
    assertEq(byEvent.status, 200, "query by event");
    assert((byEvent.body.data as Any[]).some((x) => x.control_id === "CG-VEL-01" && x.decision === "block"),
      "carries the CG-VEL-01 block");
    assertEq(byEvent.body.data.length, (await persisted(velBlockedId)).length, "row count agrees with the DB");

    const filtered = await api("GET",
      `/control-results?control_id=CG-VEL-01&decision=block&subject_ref=${m.velSrc}`, undefined, { key: partner });
    assertEq(filtered.status, 200, "filtered query");
    const db = await core().from("control_result").select("id")
      .eq("control_id", "CG-VEL-01").eq("decision", "block").eq("subject_ref", m.velSrc);
    assertEq(filtered.body.data.length, (db.data ?? []).length, "filtered count agrees with the DB");
    assertEq(filtered.body.data.length, 1, "exactly this run's one velocity block");

    const bad = await api("GET", "/control-results?decision=maybe", undefined, { key: partner });
    assertEq(bad.status, 400, "an unknown decision is refused, never an empty 'no findings'");
  });
});

// ===========================================================================
// 2. Inbound structuring + the single-large exclusion (sections 8, 25)
// ===========================================================================

flow("transfers: structuring — 3 × $4k into one account flags CG-STR-01; one $11k flags CTR only", async (t) => {
  let partner = "";
  const src: string[] = [];
  let dest = "";
  let strId = "";
  let bigId = "";

  await t.step("fixtures: three funded senders, one receiving member", async () => {
    partner = await actor("partner");
    for (let i = 0; i < 3; i++) src.push((await member(partner, $(50_000))).account);
    dest = (await member(partner, $(100))).account;
  });

  await t.step("$4k + $4k into one account: aggregate $8k stays silent", async () => {
    for (let i = 0; i < 2; i++) {
      const r = await transfer(partner, src[i], dest, $(4_000), `flow: struct ${i + 1}`);
      assertEq(r.status, 201, `leg ${i + 1} (${JSON.stringify(r.body).slice(0, 300)})`);
      assertEq(inline(r).length, 0, `no control while the day is under $10k (${inline(r)})`);
    }
  });

  await t.step("the third $4k takes the day to $12k: settles, CG-STR-01 + structuring alert (§8)", async () => {
    const r = await transfer(partner, src[2], dest, $(4_000), "flow: struct 3");
    assertEq(r.status, 201, `third leg (${JSON.stringify(r.body).slice(0, 300)})`);
    assertEq(r.body.status, "settled", "structuring is alert-only");
    assertEq(JSON.stringify(inline(r)), JSON.stringify(["CG-STR-01"]),
      "CG-STR-01 only: per-txn large-txn silent, and no sender is over $10k outbound");
    strId = String(r.body.id);
    const cr = await persisted(strId);
    assert(cr.some((c) => c.control_id === "CG-STR-01" && c.subject_ref === dest),
      "CG-STR-01 persisted against the RECEIVING account");
    const alert = await core().from("bsa_alert").select("id, alert_type, details")
      .eq("alert_type", "structuring").like("details", `%${dest}%`).like("details", `%${strId}%`);
    assert(!alert.error, `bsa_alert read: ${alert.error?.message}`);
    assertEq((alert.data ?? []).length, 1, "one structuring alert naming the account and this transfer");
    assert(String(alert.data![0].details).includes("daily_inflow_cents=1200000"), "alert states the $12k aggregate");
  });

  await t.step("a single $11k on a $4k day (both legs) raises CG-LGTXN-01 only — no STR-01, no STR-02", async () => {
    // the sender already sent $4k today and the receiver already got it: both
    // aggregates cross $10k with this one, yet only the per-txn control speaks
    const big = (await member(partner, $(50_000))).account;
    const dest2 = (await member(partner, $(100))).account;
    const pre = await transfer(partner, big, dest2, $(4_000), "flow: prior $4k");
    assertEq(pre.status, 201, "prior $4k out of the sender and into the receiver");
    const r = await transfer(partner, big, dest2, $(11_000), "flow: single large");
    assertEq(r.status, 201, `large transfer (${JSON.stringify(r.body).slice(0, 300)})`);
    assertEq(JSON.stringify(inline(r)), JSON.stringify(["CG-LGTXN-01"]),
      "CTR-sized: large-txn only, never also inbound or outbound structuring");
    bigId = String(r.body.id);
    const cr = await persisted(bigId);
    assertEq(JSON.stringify(cr.map((c) => c.control_id)), JSON.stringify(["CG-LGTXN-01"]), "DB agrees");
    const alert = await core().from("bsa_alert").select("alert_type").like("details", `%${bigId}%`);
    assertEq(JSON.stringify((alert.data ?? []).map((a) => a.alert_type)), JSON.stringify(["ctr_threshold"]),
      "one ctr_threshold alert, no structuring alert");
  });

  await t.step("GET /control-results by event shows the same evidence as inline + DB (§25)", async () => {
    for (const id of [strId, bigId]) {
      const r = await api("GET", `/control-results?event=${id}`, undefined, { key: partner });
      assertEq(r.status, 200, `query ${id}`);
      const db = await persisted(id);
      assertEq(r.body.data.length, db.length, `row count agrees with the DB for ${id}`);
      for (const c of db) {
        assert((r.body.data as Any[]).some((x) => x.control_id === c.control_id && x.subject_ref === c.subject_ref),
          `${c.control_id} served by GET`);
      }
    }
  });
});

// ===========================================================================
// 3. Cross-rail aggregation (section 16 + the cross-rail velocity sweep)
// ===========================================================================

flow("transfers: cross-rail — ACH + card + book aggregate for CG-STR-02 and CG-VEL-01", async (t) => {
  let partner = "";
  let xb = "";
  let xv = "";
  let sink = "";

  await t.step("fixtures", async () => {
    partner = await actor("partner");
    xb = (await member(partner, $(50_000))).account;
    xv = (await member(partner, $(50_000))).account;
    sink = (await member(partner, $(100))).account;
  });

  await t.step("$4k ACH + $4k card hold + $4k book transfer: the book leg flags CG-STR-02 (§16)", async () => {
    const ach = await api("POST", "/payments/ach",
      { source_account_id: xb, amount_cents: $(4_000), counterparty: { name: "Acme Vendor" } }, { key: partner });
    assertEq(ach.status, 201, `ACH (${JSON.stringify(ach.body).slice(0, 300)})`);
    assert(!inline(ach).includes("CG-STR-02"), "first rail alone is under the line");
    assert(!inline(ach).includes("CG-STR-01"), "no destination account: inbound structuring never runs on ACH");
    const card = await api("POST", "/payments/card/authorize",
      { source_account_id: xb, amount_cents: $(4_000), merchant: "Acme Coffee" }, { key: partner });
    assertEq(card.status, 201, `card (${JSON.stringify(card.body).slice(0, 300)})`);
    assert(!inline(card).includes("CG-STR-02"), "$8k across two rails is under the line");
    assert(!inline(card).includes("CG-STR-01"), "no destination account: inbound structuring never runs on card");

    const r = await transfer(partner, xb, sink, $(4_000), "flow: xrail structuring");
    assertEq(r.status, 201, `book leg (${JSON.stringify(r.body).slice(0, 300)})`);
    assertEq(r.body.status, "settled", "alert-only");
    assert(inline(r).includes("CG-STR-02"), `CG-STR-02 on the third rail (${inline(r)})`);
    const id = String(r.body.id);
    assert((await persisted(id)).some((c) => c.control_id === "CG-STR-02" && c.subject_ref === xb),
      "CG-STR-02 persisted against the sender");
    const alert = await core().from("bsa_alert").select("details")
      .eq("alert_type", "structuring").like("details", "%OUTBOUND%").like("details", `%${xb}%`).like("details", `%${id}%`);
    assertEq((alert.data ?? []).length, 1, "one OUTBOUND structuring alert naming the sender");
    assert(String(alert.data![0].details).includes("daily_outflow_cents=1200000"), "alert states the $12k cross-rail day");
  });

  await t.step("$8k wire hold + $8k ACH + $8k card hold, then a $2k book transfer is BLOCKED", async () => {
    const wire = await api("POST", "/payments/wire/prepare", {
      source_account_id: xv, amount_cents: $(8_000), beneficiary: { name: "Acme Corp", country: "US" }, purpose: "flow xrail vel",
    }, { key: partner });
    assertEq(wire.status, 201, `wire (${JSON.stringify(wire.body).slice(0, 300)})`);
    const ach = await api("POST", "/payments/ach",
      { source_account_id: xv, amount_cents: $(8_000), counterparty: { name: "Acme Vendor" } }, { key: partner });
    assertEq(ach.status, 201, `ACH (${JSON.stringify(ach.body).slice(0, 300)})`);
    const card = await api("POST", "/payments/card/authorize",
      { source_account_id: xv, amount_cents: $(8_000), merchant: "Acme Hardware" }, { key: partner });
    assertEq(card.status, 201, `card (${JSON.stringify(card.body).slice(0, 300)})`);

    const r = await transfer(partner, xv, sink, $(2_000), "flow: xrail velocity");
    assertEq(r.status, 422, `no single rail is over $25k, together they are (${JSON.stringify(r.body).slice(0, 300)})`);
    assertEq(r.body.type, "velocity_limit_exceeded", "typed error");
    const cr = await persisted(String(r.body.resource_id));
    assertEq(JSON.stringify(cr.map((c) => [c.control_id, c.decision, c.subject_ref])),
      JSON.stringify([["CG-VEL-01", "block", xv]]), "CG-VEL-01 block persisted against the sender");
  });

  await t.step("the same cap declines a card authorization — 'declined', and the envelope names the card rail", async () => {
    const r = await api("POST", "/payments/card/authorize",
      { source_account_id: xv, amount_cents: $(2_000), merchant: "Acme Books" }, { key: partner });
    assertEq(r.status, 422, `card over the cap (${JSON.stringify(r.body).slice(0, 300)})`);
    assertEq(r.body.type, "velocity_limit_exceeded", "typed error");
    assertEq(r.body.resource_type, "card_authorization", "the envelope names the rail that was blocked");
    const row = await core().from("card_authorization").select("status").eq("id", r.body.resource_id).maybeSingle();
    assertEq(row.data?.status, "declined", "a blocked card is 'declined' (its CHECK forbids 'rejected')");
  });
});

// ===========================================================================
// 4. Conservation across every rail (section 24)
// ===========================================================================

flow("transfers: conservation — book, wire (returned + partial), ACH (late return), card captures add up", async (t) => {
  let maker = "";
  let checker = "";
  let ca = "";
  let cb = "";

  await t.step("fixtures: CA $10,000, CB $5,000; a maker and a separate wire approver", async () => {
    maker = await actor("partner");
    checker = await actor("partner");
    ca = (await member(maker, $(10_000))).account;
    cb = (await member(maker, $(5_000))).account;
  });

  await t.step("book: CA → CB $1,000", async () => {
    const r = await transfer(maker, ca, cb, $(1_000), "flow: cons book");
    assertEq(r.status, 201, `book (${JSON.stringify(r.body).slice(0, 300)})`);
  });

  await t.step("wire $2,000: approved by a second actor, confirmed, returned, return accepted → net zero", async () => {
    const w = await api("POST", "/payments/wire/prepare", {
      source_account_id: ca, amount_cents: $(2_000), beneficiary: { name: "Acme", country: "US" }, purpose: "cons wire",
    }, { key: maker });
    assertEq(w.status, 201, `prepare (${JSON.stringify(w.body).slice(0, 300)})`);
    const id = String(w.body.id);
    const self = await api("POST", `/payments/wire/${id}/approve`, {}, { key: maker });
    assertEq(self.status, 409, "the maker cannot approve its own wire (EPS-06)");
    const ap = await api("POST", `/payments/wire/${id}/approve`, {}, { key: checker });
    assertEq(ap.status, 200, `approve (${JSON.stringify(ap.body).slice(0, 200)})`);
    const c = await api("POST", `/payments/wire/${id}/confirm`, {}, { key: maker });
    assertEq(c.status, 200, `confirm (${JSON.stringify(c.body).slice(0, 200)})`);
    assertEq(c.body.status, "completed", "wire completed");
    const ret = await api("POST", `/payments/wire/${id}/return`, { reason: "conservation walk" }, { key: maker });
    assertEq(ret.status, 200, `return (${JSON.stringify(ret.body).slice(0, 200)})`);
    const res = await api("POST", `/payments/wire/${id}/return/resolve`, { outcome: "accepted" }, { key: maker });
    assertEq(res.status, 200, `resolve (${JSON.stringify(res.body).slice(0, 200)})`);
    assertEq(res.body.status, "returned", "wire returned");
  });

  await t.step("wire held at $1,000, confirmed for $400 → the $600 remainder is released", async () => {
    const w = await api("POST", "/payments/wire/prepare", {
      source_account_id: ca, amount_cents: $(1_000), beneficiary: { name: "Acme", country: "US" }, purpose: "cons partial",
    }, { key: maker });
    assertEq(w.status, 201, `prepare (${JSON.stringify(w.body).slice(0, 300)})`);
    const id = String(w.body.id);
    assertEq((await api("POST", `/payments/wire/${id}/approve`, {}, { key: checker })).status, 200, "approve");
    const c = await api("POST", `/payments/wire/${id}/confirm`, { amount_cents: $(400) }, { key: maker });
    assertEq(c.status, 200, `partial confirm (${JSON.stringify(c.body).slice(0, 200)})`);
  });

  await t.step("ACH $500: settled, then returned late (R01) → net zero", async () => {
    const a = await api("POST", "/payments/ach",
      { source_account_id: ca, amount_cents: $(500), counterparty: { name: "Acme" }, window: "next_day" }, { key: maker });
    assertEq(a.status, 201, `ACH (${JSON.stringify(a.body).slice(0, 300)})`);
    const id = String(a.body.id);
    const s = await api("POST", `/payments/ach/${id}/settle`, {}, { key: maker });
    assertEq(s.status, 200, `settle (${JSON.stringify(s.body).slice(0, 200)})`);
    const r = await api("POST", `/payments/ach/${id}/return`, { return_reason: "R01" }, { key: maker });
    assertEq(r.status, 200, `return (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.status, "returned", "ACH returned after settlement");
  });

  await t.step("card $300 authorized, captured $100 + $200 (fully drawn)", async () => {
    const a = await api("POST", "/payments/card/authorize",
      { source_account_id: ca, amount_cents: $(300), merchant: "Cons Cafe" }, { key: maker });
    assertEq(a.status, 201, `authorize (${JSON.stringify(a.body).slice(0, 300)})`);
    const id = String(a.body.id);
    const c1 = await api("POST", `/payments/card/${id}/capture`, { amount_cents: $(100) }, { key: maker });
    assertEq(c1.status, 200, `capture 1 (${JSON.stringify(c1.body).slice(0, 200)})`);
    const c2 = await api("POST", `/payments/card/${id}/capture`, { amount_cents: $(200) }, { key: maker });
    assertEq(c2.status, 200, `capture 2 (${JSON.stringify(c2.body).slice(0, 200)})`);
    assertEq(c2.body.status, "captured", "fully captured");
    assertEq(c2.body.remaining_cents, 0, "nothing left on the hold");
  });

  await t.step("the ledger adds up: CA $8,300, CB $6,000, no stranded inflight", async () => {
    // CA = 10,000 − 1,000 (book) − 400 (partial wire) − 300 (card) = 8,300
    // CB =  5,000 + 1,000 (book) = 6,000
    let a = await ledger(ca);
    let b = await ledger(cb);
    for (let i = 0; i < 10 && (a.balance !== $(8_300) || a.inflight_debit !== 0); i++) {
      await new Promise((r) => setTimeout(r, 1_000)); // Blnk may apply queued postings async
      a = await ledger(ca);
      b = await ledger(cb);
    }
    assertEq(a.balance, $(8_300), "CA ledger balance conserves");
    assertEq(b.balance, $(6_000), "CB ledger balance conserves");
    assertEq(a.inflight_debit, 0, "CA has no stranded inflight residue");
    assertEq(b.inflight_debit, 0, "CB has no stranded inflight residue");
  });
});

// ===========================================================================
// 5. The statement surface: what operations and the partner can find
// ===========================================================================
//
// Cross-partner confinement is not observable here: the demo instance hosts
// exactly one fintech (D18 — ptnr_drill lives on inst_drill, and a second
// active partner on inst_local would make every ops write ownerless). What IS
// observable is D23 (operations sees the partner's rows) and that the list
// refuses a filter rather than widening it.

flow("transfers: statement — operations sees partner transfers; bad filters are refused, not widened", async (t) => {
  let partner = "";
  let a1 = "";
  let a2 = "";
  let id = "";

  await t.step("fixtures: a partner moves $100 between two of its members", async () => {
    partner = await actor("partner");
    a1 = (await member(partner, $(5_000))).account;
    a2 = (await member(partner, 0)).account;
    const r = await transfer(partner, a1, a2, $(100), "flow: statement");
    assertEq(r.status, 201, `transfer (${JSON.stringify(r.body).slice(0, 300)})`);
    id = String(r.body.id);
  });

  await t.step("operations (D23) reads the partner's transfer by id and on the account statement", async () => {
    const one = await api("GET", `/transfers/${id}`);
    assertEq(one.status, 200, "ops reads the transfer");
    assertEq((await transferRow(id))?.partner_id, await ownerOf(partner), "the row is owned by the partner that moved it");
    const ops = await api("GET", `/transfers?account_id=${a2}`);
    assertEq(ops.status, 200, "ops list");
    assert((ops.body.data as Any[]).some((x) => x.id === id), "ops finds it on the credit leg");
    assertEq((await api("GET", "/transfers/tr_does_not_exist", undefined, { key: partner })).status, 404,
      "an unknown transfer is a 404");
  });

  await t.step("the list refuses bad filters instead of widening them", async () => {
    const s = await api("GET", "/transfers?status=cleared", undefined, { key: partner });
    assertEq(s.status, 400, "unknown status refused");
    assertEq(s.body.errors?.[0]?.field, "status", "names the field");
    for (const legal of ["pending_approval", "submitted", "settled", "returned", "rejected", "canceled"]) {
      assertEq((await api("GET", `/transfers?status=${legal}`, undefined, { key: partner })).status, 200, `${legal} lists`);
    }
    for (const bad of [`${a1},partner_id.neq.x`, `${a1})`, `${a1}.or.(status.eq.settled`, "acct 1", `${a1}'`]) {
      const inj = await api("GET", `/transfers?account_id=${encodeURIComponent(bad)}`, undefined, { key: partner });
      assertEq(inj.status, 400, `account_id ${JSON.stringify(bad)} cannot smuggle a second filter term`);
      assertEq(inj.body.errors?.[0]?.field, "account_id", "names the field");
    }
  });
});
