// Flows: the Blnk integration layer — the webhook inbox, the reconciler, and
// the shared Blnk writer client — proven against the DEPLOYED core and the
// live Blnk ledger.
//
// Blnk is the ledger of record; core.* holds mirrors of it. Three things keep
// those mirrors honest, and each is checked here on the rows an examiner (or
// an on-call engineer) would read:
//   1. the writer client (_shared/blnk.ts) stamps every Blnk write with
//      reference = table:id[:leg] and meta_data.core_resource, so the ledger can
//      route back to the row;
//   2. blnk-webhook records every delivery in core.blnk_event (the inbox) and
//      applies it to that row — and refuses anything not signed by Blnk;
//   3. blnk-reconcile (pg_cron, every 5 min) repairs whatever the push missed.
//
// Isolation is additive: fresh members per flow, never /sandbox/reset, and no
// row this suite did not create is ever written. Coverage of the three stubbed
// unit files is mapped in ledger/blnk-webhook.md, ledger/blnk-reconcile.md and
// ledger/blnk-client.md.
//
// FAULT INJECTION IS OPT-IN. The flows that create drift on our own fixtures
// (a wrong balance mirror, a wrong committed amount, a stalled inbox row, a
// correctly signed synthetic event) and then invoke the deployed reconciler
// only run with LEDGER_FAULT_INJECTION=1. Without it they are registered as
// ignored, so a default `scripts/flow.sh -f ledger:` never mutates state it
// did not reach through the partner API.
import { actor, type Any, api, assert, assertEq, core, flow, personaName } from "./helpers.ts";

const $ = (dollars: number) => Math.round(dollars * 100);
const brief = (b: unknown) => JSON.stringify(b).slice(0, 300);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/blnk-webhook`;
const RECONCILE_URL = `${SUPABASE_URL}/functions/v1/blnk-reconcile`;
const BLNK_URL = (Deno.env.get("BLNK_API_URL") ?? "").replace(/\/+$/, "");
const BLNK_KEY = Deno.env.get("BLNK_API_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("BLNK_WEBHOOK_SECRET") ?? "";
const RECONCILE_SECRET = Deno.env.get("RECONCILE_SECRET") ?? "";
const FAULT_INJECTION = Deno.env.get("LEDGER_FAULT_INJECTION") === "1";

/** A flow that writes drift onto our own fixtures; registered ignored unless opted in. */
function faultFlow(name: string, fn: (t: Deno.TestContext) => Promise<void>): void {
  if (FAULT_INJECTION) flow(name, fn);
  else Deno.test({ name, ignore: true, fn: () => {} });
}

// ------------------------------------------------------------ local helpers

/** A fresh member: person entity + checking account, owned by `key`'s partner. */
async function member(key: string, openingCents: number): Promise<string> {
  const e = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1986-04-11",
    address: "41 Ledger Ln, Springfield, IL 62701",
  }, { key });
  assertEq(e.status, 201, `create entity (${brief(e.body)})`);
  const a = await api("POST", "/accounts", {
    entity_id: e.body.id, account_type: "checking", opening_deposit_cents: openingCents,
  }, { key });
  assertEq(a.status, 201, `open account (${brief(a.body)})`);
  assertEq(a.body.balance, openingCents, "opening deposit landed");
  return String(a.body.id);
}

async function accountRow(id: string): Promise<Any> {
  const r = await core().from("account")
    .select("id, balance, balance_synced_at, blnk_balance_id, blnk_ledger_id").eq("id", id).single();
  assert(!r.error, `account read: ${r.error?.message}`);
  return r.data as Any;
}

async function moneyRow(table: string, id: string): Promise<Any> {
  const r = await core().from(table)
    .select("id, status, blnk_transaction_id, blnk_reference, synced_at").eq("id", id).single();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data as Any;
}

async function blnk(method: string, path: string, body?: unknown): Promise<{ status: number; body: Any }> {
  assert(BLNK_URL && BLNK_KEY, "ledger reads need BLNK_API_URL + BLNK_API_KEY");
  const res = await fetch(`${BLNK_URL}${path}`, {
    method,
    headers: { "X-blnk-key": BLNK_KEY, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed: Any = text as unknown as Any;
  try { parsed = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, body: parsed };
}

/** Blnk's search index, the read the reconciler's sweeps are built on. */
async function search(params: Record<string, unknown>): Promise<Any[]> {
  const r = await blnk("POST", "/search/transactions", { q: "*", query_by: "reference", per_page: 50, ...params });
  assert(r.status < 300, `blnk search (${brief(r.body)})`);
  return ((r.body?.hits ?? []) as Any[]).map((h) => h.document as Any);
}

/** Poll the inbox until rows matching `filter` exist (and satisfy `ok`). */
async function inbox(
  filter: Record<string, string>,
  ok: (rows: Any[]) => boolean = (rows) => rows.length > 0,
  seconds = 25,
): Promise<Any[]> {
  let rows: Any[] = [];
  for (let i = 0; i < seconds; i++) {
    let q = core().from("blnk_event")
      .select("id, event, blnk_id, resource_type, resource_id, status, error, attempts, payload, received_at, processed_at, updated_at");
    for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
    const r = await q;
    assert(!r.error, `blnk_event read: ${r.error?.message}`);
    rows = (r.data ?? []) as Any[];
    if (ok(rows)) return rows;
    await sleep(1000);
  }
  return rows;
}

async function inboxRow(id: string): Promise<Any | null> {
  const r = await core().from("blnk_event")
    .select("id, status, error, attempts, processed_at, updated_at, received_at").eq("id", id).maybeSingle();
  assert(!r.error, `blnk_event read: ${r.error?.message}`);
  return r.data as Any | null;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** POST a delivery to the deployed blnk-webhook the way Blnk does (or deliberately not). */
async function deliver(
  rawBody: string,
  sign: { ts?: number; secret?: string; signature?: string; omit?: boolean; signedBody?: string } = {},
): Promise<{ status: number; body: Any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!sign.omit) {
    const ts = String(sign.ts ?? Math.floor(Date.now() / 1000));
    headers["X-Blnk-Timestamp"] = ts;
    headers["X-Blnk-Signature"] = sign.signature ??
      await hmacHex(sign.secret ?? WEBHOOK_SECRET, `${ts}.${sign.signedBody ?? rawBody}`);
  }
  const res = await fetch(WEBHOOK_URL, { method: "POST", headers, body: rawBody, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let parsed: Any = text as unknown as Any;
  try { parsed = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, body: parsed };
}

/** Invoke the reconciler exactly as pg_cron does (pg_net POST + X-Reconcile-Key). */
async function reconcile(key: string | null = RECONCILE_SECRET, method = "POST"): Promise<{ status: number; body: Any }> {
  const res = await fetch(RECONCILE_URL, {
    method,
    headers: key === null ? {} : { "X-Reconcile-Key": key },
    signal: AbortSignal.timeout(150_000),
  });
  const text = await res.text();
  let parsed: Any = text as unknown as Any;
  try { parsed = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, body: parsed };
}

/** A transfer's Blnk-applied webhook, once the inbox has processed it. */
async function appliedDelivery(table: string, id: string): Promise<Any> {
  const rows = await inbox(
    { resource_type: table, resource_id: id, event: "transaction.applied" },
    (rs) => rs.some((r) => r.status !== "received"),
  );
  assert(rows.length > 0, `no transaction.applied delivery for ${table}:${id} reached the inbox in 25s`);
  return rows[0];
}

// ===========================================================================
// 1. A book transfer: the writer stamps the ledger, the webhook records and
//    applies the delivery, and the mirror agrees with the ledger.
// ===========================================================================

flow("ledger: webhook — a transfer's ledger write is stamped, delivered to the inbox and applied to its row", async (t) => {
  let partner = "";
  let src = "";
  let dst = "";
  let xfer = "";
  let row: Any = {};
  let delivery: Any = {};

  await t.step("fixtures: a partner onboards two funded members", async () => {
    partner = await actor("partner");
    src = await member(partner, $(500));
    dst = await member(partner, $(100));
  });

  await t.step("opening an account creates its ledger balance, stamped back to the account", async () => {
    const a = await accountRow(src);
    assert(String(a.blnk_balance_id).startsWith("bln_"), `a real Blnk balance id (${a.blnk_balance_id})`);
    const b = await blnk("GET", `/balances/${a.blnk_balance_id}`);
    assertEq(b.status, 200, `blnk balance read (${brief(b.body)})`);
    assertEq(b.body.meta_data?.core_resource?.table, "account", "balance core_resource.table");
    assertEq(b.body.meta_data?.core_resource?.id, src, "balance core_resource.id names the account");
    assertEq(b.body.balance, $(500), "the ledger holds the opening deposit");
  });

  await t.step("balance.created is recorded and processed, linking the id without zeroing the funded mirror", async () => {
    const a = await accountRow(src);
    const rows = await inbox({ id: `balance.created:${a.blnk_balance_id}` }, (rs) => rs.some((r) => r.status !== "received"));
    assertEq(rows.length, 1, "exactly one inbox row for the balance's creation");
    assertEq(rows[0].status, "processed", `balance.created processed (${rows[0].error})`);
    assertEq(rows[0].resource_type, "account", "routed to the account table");
    assertEq(rows[0].resource_id, src, "routed to this account");
    assertEq(rows[0].payload?.data?.balance, 0, "the delivery snapshots the balance at birth (0)");
    const after = await accountRow(src);
    assertEq(after.blnk_balance_id, a.blnk_balance_id, "the account keeps its balance id");
    assertEq(after.balance, $(500), "the birth snapshot did not overwrite the funded mirror");
  });

  await t.step("a $125 transfer settles and its ledger write carries the writer contract", async () => {
    const r = await api("POST", "/transfers", {
      source_account_id: src, destination_account_id: dst, amount_cents: $(125), description: "ledger: stamped move",
    }, { key: partner });
    assertEq(r.status, 201, `transfer (${brief(r.body)})`);
    assertEq(r.body.status, "settled", "settled");
    xfer = String(r.body.id);
    row = await moneyRow("transfer", xfer);
    assertEq(row.blnk_reference, `transfer:${xfer}`, "row stamps the canonical reference table:id");
    assert(row.blnk_transaction_id, "row carries the Blnk transaction id");

    const tx = await blnk("GET", `/transactions/${row.blnk_transaction_id}`);
    assertEq(tx.status, 200, `blnk transaction read (${brief(tx.body)})`);
    assertEq(tx.body.reference, `transfer:${xfer}`, "ledger reference");
    assertEq(tx.body.precise_amount, $(125), "integer cents in precise_amount");
    assertEq(tx.body.precision, 100, "precision 100");
    assertEq(tx.body.currency, "USD", "currency");
    assertEq(tx.body.description, "ledger: stamped move", "narration carried");
    assertEq(tx.body.meta_data?.core_resource?.table, "transfer", "core_resource.table");
    assertEq(tx.body.meta_data?.core_resource?.id, xfer, "core_resource.id");
    assertEq(tx.body.status, "APPLIED", "applied, not queued");
  });

  await t.step("the transaction.applied delivery is recorded once and processed against this transfer", async () => {
    delivery = await appliedDelivery("transfer", xfer);
    const all = await inbox({ resource_type: "transfer", resource_id: xfer });
    assertEq(all.length, 1, "exactly one inbox row for the move");
    assertEq(delivery.status, "processed", `processed (${delivery.error})`);
    assertEq(delivery.id, `transaction.applied:${row.blnk_transaction_id}`, "inbox key = event + transaction id");
    assertEq(delivery.blnk_id, row.blnk_transaction_id, "blnk_id is the ledger transaction");
    assertEq(delivery.error ?? null, null, "no error recorded");
    assertEq(delivery.attempts ?? 0, 0, "applied on first delivery, no re-drive");
    assert(delivery.processed_at, "processed_at stamped");
  });

  await t.step("applying it stamped the row (synced_at) and kept the canonical reference", async () => {
    const after = await moneyRow("transfer", xfer);
    assert(after.synced_at, "synced_at stamped");
    assert(Date.parse(after.synced_at) >= Date.parse(delivery.received_at) - 1000,
      `synced_at (${after.synced_at}) reflects the delivery (${delivery.received_at})`);
    assertEq(after.blnk_reference, `transfer:${xfer}`, "reference stays canonical");
    assertEq(after.blnk_transaction_id, row.blnk_transaction_id, "transaction id unchanged");
    assertEq(after.status, "settled", "business status untouched by the webhook");
  });

  await t.step("both mirrors agree with the ledger after the delivery", async () => {
    for (const [acct, expected] of [[src, $(375)], [dst, $(225)]] as const) {
      const a = await accountRow(acct);
      const b = await blnk("GET", `/balances/${a.blnk_balance_id}`);
      assertEq(b.body.balance, expected, `${acct} ledger`);
      assertEq(a.balance, expected, `${acct} mirror`);
      const r = await api("GET", `/accounts/${acct}`, undefined, { key: partner });
      assertEq(r.body.balance, expected, `${acct} as the partner reads it`);
    }
  });
});

// ===========================================================================
// 2. An ACH settle: the writer does NOT refresh the balance inline, so the
//    member's balance only moves because the webhook refreshed the mirror.
// ===========================================================================

flow("ledger: webhook — an ACH settlement's delivery refreshes the balance mirror the API never wrote", async (t) => {
  let partner = "";
  let acct = "";
  let ach = "";
  let before: Any = {};

  await t.step("fixtures: a member with $800 submits a $230 ACH debit", async () => {
    partner = await actor("partner");
    acct = await member(partner, $(800));
    const r = await api("POST", "/payments/ach",
      { source_account_id: acct, amount_cents: $(230), counterparty: { name: "Ledger Vendor" }, window: "next_day" },
      { key: partner });
    assertEq(r.status, 201, `submit (${brief(r.body)})`);
    ach = String(r.body.id);
  });

  await t.step("the inflight hold's delivery is recorded and processed against the ACH row", async () => {
    const rows = await inbox({ resource_type: "ach_transfer", resource_id: ach, event: "transaction.inflight" },
      (rs) => rs.some((r) => r.status !== "received"));
    assertEq(rows.length, 1, "one inflight delivery");
    assertEq(rows[0].status, "processed", `processed (${rows[0].error})`);
    before = await accountRow(acct);
  });

  await t.step("settling commits the hold; the APPLIED child's delivery is processed and refreshes the mirror", async () => {
    const r = await api("POST", `/payments/ach/${ach}/settle`, {}, { key: partner });
    assertEq(r.status, 200, `settle (${brief(r.body)})`);
    assertEq(r.body.status, "settled", "settled");
    const d = await appliedDelivery("ach_transfer", ach);
    assertEq(d.status, "processed", `processed (${d.error})`);
    assert(String(d.payload?.data?.reference ?? "").length > 0, "the child carries a reference");

    let a = await accountRow(acct);
    for (let i = 0; i < 20 && a.balance !== $(570); i++) { await sleep(1000); a = await accountRow(acct); }
    assertEq(a.balance, $(570), "mirror shows the debit");
    assert(Date.parse(a.balance_synced_at) > Date.parse(before.balance_synced_at),
      "balance_synced_at advanced — the mirror was refreshed after the hold");
    assert(Date.parse(a.balance_synced_at) >= Date.parse(d.received_at) - 1000,
      `the refresh happened on/after the delivery (${a.balance_synced_at} vs ${d.received_at})`);
    const b = await blnk("GET", `/balances/${a.blnk_balance_id}`);
    assertEq(b.body.balance, $(570), "ledger agrees");
  });
});

// ===========================================================================
// 3. The webhook's front door: only Blnk-signed, fresh deliveries are let in,
//    and a redelivery of something already applied is absorbed.
// ===========================================================================

flow("ledger: webhook — unsigned, forged and stale deliveries are refused; a redelivery is absorbed, never re-applied", async (t) => {
  let partner = "";
  let src = "";
  let dst = "";
  let xfer = "";
  let row: Any = {};
  let delivery: Any = {};
  let forged = "";
  let forgedId = "";

  await t.step("fixtures: a settled transfer whose delivery has been processed", async () => {
    partner = await actor("partner");
    src = await member(partner, $(300));
    dst = await member(partner, $(10));
    const r = await api("POST", "/transfers", {
      source_account_id: src, destination_account_id: dst, amount_cents: $(40), description: "ledger: signature fixture",
    }, { key: partner });
    assertEq(r.status, 201, `transfer (${brief(r.body)})`);
    xfer = String(r.body.id);
    delivery = await appliedDelivery("transfer", xfer);
    assertEq(delivery.status, "processed", "fixture delivery processed");
    row = await moneyRow("transfer", xfer);

    // A delivery that, if it were ever accepted, would re-point our transfer at
    // a ledger transaction that does not exist. Clearly synthetic, our row only.
    const fakeTxn = `txn_flowforged_${crypto.randomUUID()}`;
    forgedId = `transaction.applied:${fakeTxn}`;
    forged = JSON.stringify({
      event: "transaction.applied",
      data: {
        transaction_id: fakeTxn, reference: `transfer:${xfer}`, status: "APPLIED",
        precise_amount: 1, precision: 100, currency: "USD", source: "@FlowForged", destination: "@FlowForged",
        meta_data: { core_resource: { table: "transfer", id: xfer }, flow_test: true },
      },
    });
  });

  const untouched = async (label: string) => {
    assertEq(await inboxRow(forgedId), null, `${label}: nothing recorded in the inbox`);
    const now = await moneyRow("transfer", xfer);
    assertEq(now.blnk_transaction_id, row.blnk_transaction_id, `${label}: the transfer still points at its real ledger move`);
    assertEq(now.synced_at, row.synced_at, `${label}: the transfer row was not touched`);
  };

  await t.step("only POST is accepted", async () => {
    const res = await fetch(WEBHOOK_URL, { method: "GET", signal: AbortSignal.timeout(15_000) });
    await res.body?.cancel();
    assertEq(res.status, 405, "GET → 405");
  });

  await t.step("a delivery with no signature headers is refused 401 and not recorded", async () => {
    const r = await deliver(forged, { omit: true });
    assertEq(r.status, 401, `unsigned (${brief(r.body)})`);
    assert(String(r.body?.error ?? "").includes("missing signature"), `names the failure (${brief(r.body)})`);
    await untouched("unsigned");
  });

  await t.step("a delivery signed with the wrong secret is refused 401 and not recorded", async () => {
    const r = await deliver(forged, { secret: `not-the-secret-${crypto.randomUUID()}` });
    assertEq(r.status, 401, `wrong secret (${brief(r.body)})`);
    assert(String(r.body?.error ?? "").includes("signature mismatch"), `names the failure (${brief(r.body)})`);
    await untouched("wrong secret");
  });

  await t.step("a garbage signature, and a signature over a different body, are refused 401", async () => {
    const g = await deliver(forged, { signature: "deadbeef" });
    assertEq(g.status, 401, `garbage signature (${brief(g.body)})`);
    const swapped = await deliver(forged, { signedBody: JSON.stringify({ event: "system.error", data: {} }) });
    assertEq(swapped.status, 401, `body swapped after signing (${brief(swapped.body)})`);
    await untouched("tampered");
  });

  await t.step("a correctly signed delivery outside the ±5 minute window is refused as a replay", async () => {
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    const r = await deliver(forged, { ts: stale });
    assertEq(r.status, 401, `stale (${brief(r.body)})`);
    assert(String(r.body?.error ?? "").includes("replay window"), `names the replay window (${brief(r.body)})`);
    const future = await deliver(forged, { ts: Math.floor(Date.now() / 1000) + 10 * 60 });
    assertEq(future.status, 401, `future-dated (${brief(future.body)})`);
    await untouched("stale");
  });

  await t.step("Blnk redelivering the SAME event is acked as a duplicate and applied nothing twice", async () => {
    const before = await inboxRow(delivery.id);
    const balances = [(await accountRow(src)).balance, (await accountRow(dst)).balance];
    // The stored payload IS the original body: re-sign and redeliver it, as a
    // Blnk retry would.
    const r = await deliver(JSON.stringify(delivery.payload));
    assertEq(r.status, 200, `redelivery (${brief(r.body)})`);
    assertEq(r.body?.duplicate, true, "acked as a duplicate");
    await sleep(1500);
    const after = await inboxRow(delivery.id);
    assertEq(after?.status, "processed", "inbox row still processed");
    assertEq(after?.processed_at, before?.processed_at, "not re-processed");
    assertEq(after?.updated_at, before?.updated_at, "inbox row untouched");
    assertEq(after?.attempts ?? 0, before?.attempts ?? 0, "no attempt counted");
    assertEq((await inbox({ resource_type: "transfer", resource_id: xfer })).length, 1, "still exactly one inbox row");
    const now = await moneyRow("transfer", xfer);
    assertEq(now.synced_at, row.synced_at, "the transfer row was not re-applied");
    assertEq(JSON.stringify([(await accountRow(src)).balance, (await accountRow(dst)).balance]), JSON.stringify(balances),
      "no balance moved");
  });
});

// ===========================================================================
// 4. The inbox after an ordinary account opening. Every funded open posts an
//    opening-deposit transaction stamped core_resource {table: "account"};
//    the webhook must not treat that as an undeliverable event.
// ===========================================================================

flow("ledger: inbox — a funded account opening leaves no failed delivery behind", async (t) => {
  let partner = "";
  let acct = "";

  await t.step("fixtures: a partner opens a funded account", async () => {
    partner = await actor("partner");
    acct = await member(partner, $(250));
  });

  await t.step("the opening deposit's delivery reaches the inbox", async () => {
    const rows = await inbox({ resource_type: "account", resource_id: acct, event: "transaction.applied" },
      (rs) => rs.some((r) => r.status !== "received"));
    assertEq(rows.length, 1, "one delivery for the opening deposit");
    assertEq(rows[0].payload?.data?.reference, `account:${acct}:open`, "reference = account:id:open (writer leg)");
    assertEq(rows[0].payload?.data?.precise_amount, $(250), "the deposit amount");
    const meta = rows[0].payload?.data?.meta_data;
    assertEq(meta?.core_resource?.table, "account", "core_resource.table stamped by the client");
    assertEq(meta?.core_resource?.id, acct, "core_resource.id names the account");
    assertEq(meta?.allow_overdraft, true, "the caller's own meta_data survives alongside core_resource");
  });

  await t.step("the opening deposit's delivery is not recorded as failed", async () => {
    const rows = await inbox({ resource_type: "account", resource_id: acct, event: "transaction.applied" });
    // DEFECT: blnk-webhook/handlers.ts:138-139 — applyTransaction only routes MONEY_TABLES (ach_transfer, wire_transfer, transfer, card_authorization); the opening deposit is stamped core_resource {table:"account"} by api/accounts.ts:287-289, so every funded open is inboxed `failed` ("no core row for transaction"), re-driven 5x by blnk-reconcile, then dead-lettered with a HIGH-severity production finding (178 such findings live, failed+dead_letter backlog 605 → blnk.inbox_backlog fires every run)
    assert(["processed", "skipped"].includes(String(rows[0]?.status)),
      `opening deposit delivery status = ${rows[0]?.status} (${rows[0]?.error})`);
  });
});

// ===========================================================================
// 5. The writer client under a partner's concurrent retries. Three POSTs with
//    one Idempotency-Key race into the same `resume` path, so more than one
//    reaches recordTransaction with the same reference — the duplicate-reference
//    path in _shared/blnk.ts is what keeps the ledger to ONE move.
// ===========================================================================

flow("ledger: client — concurrent retries of one transfer post to the ledger exactly once", async (t) => {
  let partner = "";
  let src = "";
  let dst = "";
  const key = `flow-ledger-${crypto.randomUUID()}`;
  let responses: { status: number; body: Any }[] = [];

  await t.step("fixtures: two funded members", async () => {
    partner = await actor("partner");
    src = await member(partner, $(1_000));
    dst = await member(partner, $(1_000));
  });

  await t.step("three simultaneous retries: one transfer row, one ledger move, money moved once", async () => {
    responses = await Promise.all([0, 1, 2].map(() =>
      api("POST", "/transfers", {
        source_account_id: src, destination_account_id: dst, amount_cents: $(12.34), description: "ledger: concurrent retry",
      }, { key: partner, idem: key })
    ));
    const ok = responses.filter((r) => r.status === 201);
    assert(ok.length >= 1, `at least one retry succeeded (${responses.map((r) => r.status)})`);
    const ids = new Set(ok.map((r) => String(r.body.id)));
    assertEq(ids.size, 1, `every success names the same transfer (${[...ids]})`);
    const id = [...ids][0];

    const rows = await core().from("transfer").select("id, status").eq("originator->>account_id", src);
    assert(!rows.error, `transfer read: ${rows.error?.message}`);
    assertEq(rows.data!.length, 1, "exactly one transfer row for the key");
    assertEq(rows.data![0].id, id, "it is the one the partner was told about");

    let hits: Any[] = [];
    for (let i = 0; i < 10; i++) {
      hits = (await search({ q: `transfer:${id}` })).filter((d) => String(d.reference).startsWith(`transfer:${id}`));
      if (hits.length) break;
      await sleep(1000);
    }
    assertEq(hits.length, 1, `exactly one ledger transaction for transfer:${id} (${hits.map((h) => h.reference)})`);

    const a = await accountRow(src);
    const b = await blnk("GET", `/balances/${a.blnk_balance_id}`);
    assertEq(b.body.balance, $(1_000 - 12.34), "the ledger debited the source once");
  });

  await t.step("no retry is answered with a server error", async () => {
    // DEFECT: two ways, both while the money DID move once. (a) 500 internal_error — api/transfers.ts:690-712: a concurrent retry claims `resume`, finds no transfer row yet, inserts the same id and throws "transfer insert: duplicate key". (b, inferred from the response — no function log read) 502 bank_error — _shared/blnk.ts:291-316: the retry that reaches Blnk second hits the duplicate-reference path, looks the original up in Blnk's eventually-consistent search index (line 298), finds nothing yet, and throws BlnkError instead of resolving to the existing move
    const errs = responses.filter((r) => r.status >= 500);
    assertEq(errs.length, 0, `5xx responses to an idempotent retry: ${errs.map((r) => brief(r.body)).join(" | ")}`);
    // Regression guard (fixed 2026-10-05): a retry that arrives while the
    // original is still running is told so — a typed 409 — rather than racing it.
    for (const r of responses.filter((r) => r.status !== 201)) {
      assertEq(r.status, 409, `a non-success retry is a 409 (${brief(r.body)})`);
      assertEq(r.body.type, "idempotency_request_in_progress", "typed in-progress refusal");
    }
  });
});

// ===========================================================================
// 6. What the reconciler reads. Its sweeps parse Blnk's search index; these
//    steps check the index returns the shapes the sweeps assume, on our own
//    fixtures, without invoking the reconciler.
// ===========================================================================

flow("ledger: reconciler inputs — the ledger search the sweeps depend on returns what they parse", async (t) => {
  let partner = "";
  let acct = "";
  let card = "";
  let hold = "";
  let xfer = "";

  await t.step("fixtures: a member captures $300 of a $1,000 card hold and sends a transfer", async () => {
    partner = await actor("partner");
    acct = await member(partner, $(5_000));
    const other = await member(partner, $(1));
    const a = await api("POST", "/payments/card/authorize",
      { source_account_id: acct, amount_cents: $(1_000), merchant: "Ledger Diner" }, { key: partner });
    assertEq(a.status, 201, `authorize (${brief(a.body)})`);
    card = String(a.body.id);
    hold = String(a.body.blnk_inflight_id);
    const c = await api("POST", `/payments/card/${card}/capture`, { amount_cents: $(300) }, { key: partner });
    assertEq(c.status, 200, `capture (${brief(c.body)})`);
    const x = await api("POST", "/transfers", {
      source_account_id: acct, destination_account_id: other, amount_cents: $(5), description: "ledger: search fixture",
    }, { key: partner });
    assertEq(x.status, 201, `transfer (${brief(x.body)})`);
    xfer = String(x.body.id);
    await appliedDelivery("card_authorization", card);
  });

  await t.step("the hold's capture is findable as an APPLIED child of the hold", async () => {
    let kids: Any[] = [];
    for (let i = 0; i < 10 && !kids.length; i++) {
      kids = await search({ filter_by: `parent_transaction:=${hold}` });
      if (!kids.length) await sleep(1000);
    }
    const applied = kids.filter((k) => k.status === "APPLIED");
    assertEq(applied.length, 1, `one APPLIED child (${kids.map((k) => k.status)})`);
    const row = await core().from("card_authorization").select("blnk_committed_amount").eq("id", card).single();
    assertEq(row.data?.blnk_committed_amount, $(300), "the core's running total");
  });

  await t.step("the child's amount is integer cents in a form the card sweep re-sums ($300)", async () => {
    const kids = (await search({ filter_by: `parent_transaction:=${hold}` })).filter((k) => k.status === "APPLIED");
    // Regression guard (bug found by this flow, fixed 2026-10-03): Blnk search
    // serves precise_amount as a digit STRING ("30000"); the sweep summed only
    // numbers, re-summed every capture to 0 and "repaired" correct running
    // totals to 0 on every cron run. It now accepts an integer or a digit
    // string. This goes red if Blnk changes to any other form.
    const cents = (v: unknown) =>
      typeof v === "number" && Number.isInteger(v) ? v
      : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v)
      : NaN;
    const resum = kids.reduce((s, c) => s + cents(c.precise_amount), 0);
    assertEq(resum, $(300), `re-sum of applied children (raw: ${kids.map((k) => JSON.stringify(k.precise_amount))})`);
  });

  await t.step("a transaction's created_at is a form the missing-mirror walk can date", async () => {
    const tx = (await moneyRow("transfer", xfer)).blnk_transaction_id;
    let doc: Any | undefined;
    for (let i = 0; i < 10 && !doc; i++) {
      doc = (await search({ q: `transfer:${xfer}` })).find((d) => d.transaction_id === tx);
      if (!doc) await sleep(1000);
    }
    assert(doc, `transfer ${xfer} is in the search index`);
    // Regression guard (bug found by this flow, fixed 2026-10-03): Blnk search
    // serves created_at as epoch SECONDS; the sweep skipped non-strings, so it
    // examined nothing since 2026-07-15. It now accepts epoch seconds/ms or an
    // ISO string — this goes red if Blnk changes to anything else, and checks
    // the value dates this transfer to within a day of now.
    const v = doc!.created_at;
    const ms = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) : NaN;
    assert(Number.isFinite(ms) && Math.abs(Date.now() - ms) < 86_400_000,
      `created_at as indexed (${JSON.stringify(v)}) dates this transfer to today`);
  });
});

// ===========================================================================
// 7. The reconciler's front door (no sweep runs: every call here is refused).
// ===========================================================================

flow("ledger: reconciler — only pg_cron's keyed POST may run the sweeps", async (t) => {
  await t.step("GET is refused 405", async () => {
    const r = await reconcile(RECONCILE_SECRET, "GET");
    assertEq(r.status, 405, `GET (${brief(r.body)})`);
  });

  await t.step("a POST with no X-Reconcile-Key is refused 401", async () => {
    const r = await reconcile(null);
    assertEq(r.status, 401, `no key (${brief(r.body)})`);
    assertEq(r.body?.ok ?? null, null, "no sweep summary returned");
  });

  await t.step("a POST with the wrong key is refused 401", async () => {
    const r = await reconcile(`wrong-${crypto.randomUUID()}`);
    assertEq(r.status, 401, `wrong key (${brief(r.body)})`);
    assertEq(r.body?.swept ?? null, null, "no sweep summary returned");
  });
});

// ===========================================================================
// 8–11. FAULT INJECTION (opt-in: LEDGER_FAULT_INJECTION=1). Drift is written
//       onto rows this flow created, then the deployed reconciler is invoked
//       the way pg_cron invokes it. Other agents and pg_cron itself may run a
//       sweep in between, so the assertions are on the repaired row and its
//       evidence, never on this call's counters.
// ===========================================================================

faultFlow("ledger: reconciler — a drifted balance mirror is repaired from the ledger, with drift evidence", async (t) => {
  let partner = "";
  let acct = "";
  let blnkId = "";
  const WRONG = 1;

  await t.step("fixtures: a fresh member with $640 whose mirror is then corrupted to $0.01", async () => {
    partner = await actor("partner");
    acct = await member(partner, $(640));
    const a = await accountRow(acct);
    blnkId = String(a.blnk_balance_id);
    await inbox({ id: `balance.created:${blnkId}` }, (rs) => rs.some((r) => r.status !== "received"));
    // Oldest balance_synced_at first (nulls first): put ours at the head of the tail pass.
    const u = await core().from("account").update({ balance: WRONG, balance_synced_at: null }).eq("id", acct);
    assert(!u.error, `drift write: ${u.error?.message}`);
    assertEq((await accountRow(acct)).balance, WRONG, "the mirror is wrong");
  });

  await t.step("one reconcile run: Blnk wins, the mirror is repaired, blnk.balance_drift records both figures", async () => {
    const r = await reconcile();
    assertEq(r.status, 200, `reconcile (${brief(r.body)})`);
    assertEq(r.body.ok, true, "ok");
    const a = await accountRow(acct);
    assertEq(a.balance, $(640), "mirror repaired to the ledger balance");
    assert(a.balance_synced_at, "balance_synced_at refreshed");
    const ev = await core().from("event").select("code, type, payload").eq("code", "blnk.balance_drift").eq("resource_id", acct);
    assert(!ev.error, `event read: ${ev.error?.message}`);
    assertEq(ev.data!.length, 1, "one drift event for this account");
    assertEq(ev.data![0].type, "reconciliation", "event type");
    assertEq(ev.data![0].payload?.mirrored, WRONG, "payload.mirrored = the drifted value");
    assertEq(ev.data![0].payload?.actual, $(640), "payload.actual = the ledger value");
    assertEq(ev.data![0].payload?.blnk_balance_id, blnkId, "payload names the ledger balance");
  });

  await t.step("a second run finds nothing to repair: no second drift event", async () => {
    await core().from("account").update({ balance_synced_at: null }).eq("id", acct); // ensure ours is swept again
    const r = await reconcile();
    assertEq(r.status, 200, `reconcile (${brief(r.body)})`);
    assertEq((await accountRow(acct)).balance, $(640), "mirror still right");
    const ev = await core().from("event").select("id").eq("code", "blnk.balance_drift").eq("resource_id", acct);
    assertEq(ev.data?.length, 1, "still exactly one drift event");
  });
});

faultFlow("ledger: reconciler — a card hold's committed total is re-summed from the ledger, in sync or drifted", async (t) => {
  let partner = "";
  let acct = "";
  let card = "";

  await t.step("fixtures: authorize $1,000, capture $300, wait for the ledger's confirmation", async () => {
    partner = await actor("partner");
    acct = await member(partner, $(5_000));
    const a = await api("POST", "/payments/card/authorize",
      { source_account_id: acct, amount_cents: $(1_000), merchant: "Ledger Cafe" }, { key: partner });
    assertEq(a.status, 201, `authorize (${brief(a.body)})`);
    card = String(a.body.id);
    const c = await api("POST", `/payments/card/${card}/capture`, { amount_cents: $(300) }, { key: partner });
    assertEq(c.status, 200, `capture (${brief(c.body)})`);
    await appliedDelivery("card_authorization", card);
  });

  const sweepOurs = async () => {
    // Oldest synced_at first, nulls first: ours is at the head of the 25-row window.
    const u = await core().from("card_authorization").update({ synced_at: null }).eq("id", card);
    assert(!u.error, `synced_at reset: ${u.error?.message}`);
    const r = await reconcile();
    assertEq(r.status, 200, `reconcile (${brief(r.body)})`);
  };
  const committed = async () =>
    (await core().from("card_authorization").select("blnk_committed_amount, synced_at").eq("id", card).single()).data;

  await t.step("in sync: the sweep only touches synced_at and leaves the $300 total alone", async () => {
    await sweepOurs();
    const row = await committed();
    // DEFECT: blnk-reconcile/sweeps.ts:127-130 sums only numeric precise_amount; Blnk search returns a string, so a correct 30000 is rewritten to 0
    assertEq(row?.blnk_committed_amount, $(300), "running total unchanged by an in-sync sweep");
    assert(row?.synced_at, "synced_at touched");
    const ev = await core().from("event").select("id").eq("resource_id", `card_authorization:${card}`).eq("code", "blnk.mirror.recovered");
    assertEq(ev.data?.length ?? 0, 0, "no recovery event for a row that was right");
  });

  await t.step("drifted: a total of $0 is re-summed to $300 and blnk.mirror.recovered is written", async () => {
    const u = await core().from("card_authorization").update({ blnk_committed_amount: 0 }).eq("id", card);
    assert(!u.error, `drift write: ${u.error?.message}`);
    await sweepOurs();
    const row = await committed();
    // DEFECT: same root cause — the re-sum of the string amounts is 0, equal to the drifted value, so nothing is repaired
    assertEq(row?.blnk_committed_amount, $(300), "running total repaired from the ledger's applied children");
    const ev = await core().from("event").select("id, payload")
      .eq("id", `evt_recon_${card}_${$(300)}`).maybeSingle();
    assert(ev.data, "blnk.mirror.recovered evidence for the repair");
    assertEq(ev.data!.payload?.from, "0", "payload.from");
    assertEq(ev.data!.payload?.to, String($(300)), "payload.to");
  });

  await t.step("cleanup: the hold is reversed so the sweep stops visiting it", async () => {
    const r = await api("POST", `/payments/card/${card}/reverse`, {}, { key: partner });
    assert(r.status < 500, `reverse (${brief(r.body)})`);
  });
});

faultFlow("ledger: reconciler — a delivery that stalled before dispatch is re-driven through the same handler", async (t) => {
  let partner = "";
  let xfer = "";
  let stalledId = "";

  await t.step("fixtures: a settled transfer whose row then loses its webhook stamp", async () => {
    partner = await actor("partner");
    const src = await member(partner, $(200));
    const dst = await member(partner, $(10));
    const r = await api("POST", "/transfers", {
      source_account_id: src, destination_account_id: dst, amount_cents: $(15), description: "ledger: stalled delivery",
    }, { key: partner });
    assertEq(r.status, 201, `transfer (${brief(r.body)})`);
    xfer = String(r.body.id);
    const real = await appliedDelivery("transfer", xfer);

    // Simulate the crash between the inbox insert and dispatch: a `received`
    // row carrying this transfer's real payload, older than the 10-minute
    // grace (and older than every live backlog row, so it is in the 50).
    stalledId = `flowtest.stalled:${crypto.randomUUID()}`;
    const ins = await core().from("blnk_event").insert({
      id: stalledId, event: "transaction.applied", blnk_id: real.blnk_id,
      resource_type: "transfer", resource_id: xfer, payload: real.payload, status: "received",
      received_at: "2000-01-01T00:00:00Z",
    });
    assert(!ins.error, `stalled row insert: ${ins.error?.message}`);
    const u = await core().from("transfer").update({ synced_at: null }).eq("id", xfer);
    assert(!u.error, `synced_at reset: ${u.error?.message}`);
  });

  await t.step("one reconcile run: the stalled row is processed and the transfer re-stamped", async () => {
    const r = await reconcile();
    assertEq(r.status, 200, `reconcile (${brief(r.body)})`);
    const row = await inboxRow(stalledId);
    assertEq(row?.status, "processed", `re-dispatched (${row?.error})`);
    assertEq(row?.error ?? null, null, "error cleared");
    assert(row?.processed_at, "processed_at stamped");
    const x = await moneyRow("transfer", xfer);
    assert(x.synced_at, "the transfer was re-stamped by the re-driven handler");
    assertEq(x.blnk_reference, `transfer:${xfer}`, "canonical reference");
  });

  await t.step("a processed row is never re-driven again", async () => {
    const before = await inboxRow(stalledId);
    await reconcile();
    const after = await inboxRow(stalledId);
    assertEq(after?.processed_at, before?.processed_at, "not re-processed");
  });
});

faultFlow("ledger: reconciler — an undeliverable event counts attempts and stays retryable below the cap", async (t) => {
  let failedId = "";

  await t.step("a correctly signed balance.monitor for a balance no account owns is stored as failed", async () => {
    const fake = `bln_flowtest_${crypto.randomUUID()}`;
    const body = JSON.stringify({
      event: "balance.monitor",
      data: {
        balance_id: fake, monitor_id: `mon_flowtest_${crypto.randomUUID()}`, triggered_at: new Date().toISOString(),
        condition: { field: "balance", operator: ">", value: 1 }, meta_data: { flow_test: true },
      },
    });
    const r = await deliver(body);
    assertEq(r.status, 200, `stored (${brief(r.body)})`);
    assertEq(r.body?.status, "failed", "always 200 once stored; the processing failure is on the row");
    const rows = await inbox({ blnk_id: fake });
    assertEq(rows.length, 1, "one inbox row");
    failedId = String(rows[0].id);
    assertEq(rows[0].status, "failed", "failed");
    assert(String(rows[0].error).includes("no account for balance"), `error recorded (${rows[0].error})`);
    // Past the grace window and at the head of the oldest-first batch.
    const u = await core().from("blnk_event").update({ received_at: "2000-01-01T00:00:00Z" }).eq("id", failedId);
    assert(!u.error, `backdate: ${u.error?.message}`);
  });

  try {
    await t.step("one reconcile run re-drives it: still failed, one attempt counted, not dead-lettered", async () => {
      const r = await reconcile();
      assertEq(r.status, 200, `reconcile (${brief(r.body)})`);
      const row = await inboxRow(failedId);
      assertEq(row?.status, "failed", "still retryable");
      assert((row?.attempts ?? 0) >= 1 && (row?.attempts ?? 0) < 5, `attempts counted (${row?.attempts})`);
      assert(String(row?.error).includes("no account for balance"), "error kept");
    });
  } finally {
    // Our synthetic row must never reach the 5-attempt cap: that would open a
    // production-provenance dead-letter finding for test data.
    if (failedId) await core().from("blnk_event").delete().eq("id", failedId);
  }
});

faultFlow("ledger: webhook — a queued move's `_q` child reference still finds its row; unknown events are skipped", async (t) => {
  let partner = "";
  let xfer = "";
  let row: Any = {};

  await t.step("fixtures: a settled transfer", async () => {
    partner = await actor("partner");
    const src = await member(partner, $(100));
    const dst = await member(partner, $(10));
    const r = await api("POST", "/transfers", {
      source_account_id: src, destination_account_id: dst, amount_cents: $(3), description: "ledger: _q fixture",
    }, { key: partner });
    assertEq(r.status, 201, `transfer (${brief(r.body)})`);
    xfer = String(r.body.id);
    await appliedDelivery("transfer", xfer);
    row = await moneyRow("transfer", xfer);
  });

  await t.step("a signed applied child with reference `transfer:<id>_q` and no core_resource is routed by reference", async () => {
    const child = `txn_flowtest_q_${crypto.randomUUID()}`;
    const r = await deliver(JSON.stringify({
      event: "transaction.applied",
      data: { transaction_id: child, reference: `transfer:${xfer}_q`, status: "APPLIED",
        source: "@FlowTest", destination: "@FlowTest", meta_data: { flow_test: true } },
    }));
    assertEq(r.status, 200, `delivered (${brief(r.body)})`);
    assertEq(r.body?.status, "processed", "routed and applied");
    const x = await moneyRow("transfer", xfer);
    assertEq(x.blnk_reference, `transfer:${xfer}`, "the row keeps the canonical (un-suffixed) reference");
    assertEq(x.blnk_transaction_id, child, "the child id is recorded");
    // restore our fixture's real ledger id
    await core().from("transfer").update({ blnk_transaction_id: row.blnk_transaction_id }).eq("id", xfer);
  });

  await t.step("an unknown event is stored and skipped, never failed; its redelivery is a duplicate", async () => {
    const body = JSON.stringify({ event: "flowtest.unknown", data: { note: crypto.randomUUID(), meta_data: { core_resource: { table: "transfer", id: xfer } } } });
    const r = await deliver(body);
    assertEq(r.status, 200, `stored (${brief(r.body)})`);
    assertEq(r.body?.status, "skipped", "skipped");
    const again = await deliver(body);
    assertEq(again.body?.duplicate, true, "same payload → same key → duplicate");
    const other = await deliver(JSON.stringify({ event: "flowtest.unknown", data: { note: crypto.randomUUID() } }));
    assertEq(other.body?.status, "skipped", "a different id-less payload is its own event, not a duplicate");
  });
});
