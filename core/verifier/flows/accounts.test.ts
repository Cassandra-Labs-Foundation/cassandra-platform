// Account lifecycle, as a partner lives it: open (and the opens it must refuse),
// find a member's accounts, lock, freeze, close — and the money rail honouring
// each state. Covers the behaviours pinned by the unit stubs in
// core/supabase/functions/api/accounts.test.ts (see ledger/accounts.md) plus
// the lock/transition handlers no stub covered, against the DEPLOYED core.
//
// Every claim about state is also read back from core.account / core.event /
// core.record: a lock that answers 200 but never lands is the failure mode.
import { actor, type Any, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

const ACCOUNT_TYPES = ["checking", "savings", "money_market", "certificate", "ira", "keogh"];
const CU_SPELLINGS: Record<string, string> = {
  share_draft: "checking", share: "savings", share_certificate: "certificate",
};

const fields = (r: { body: Any }): string[] =>
  ((r.body?.errors ?? []) as { field: string }[]).map((e) => e.field).sort();

async function accountRow(id: string): Promise<Any> {
  const r = await core().from("account").select("id, status, lock_type, account_type, entity_id, balance")
    .eq("id", id).maybeSingle();
  assert(!r.error, `account read: ${r.error?.message}`);
  return r.data;
}

async function lastEvent(accountId: string, code: string): Promise<Any> {
  const r = await core().from("event").select("code, payload, created_at")
    .eq("resource_id", accountId).eq("code", code).order("created_at", { ascending: false }).limit(1);
  assert(!r.error, `event read: ${r.error?.message}`);
  return (r.data ?? [])[0];
}

flow("accounts: lifecycle — refuse bad opens, open once, find, lock, freeze, close", async (t) => {
  let partner = "";
  let entity = "";
  let unfunded = "";
  let funded = "";
  let closing = "";
  const all: string[] = [];

  const transfer = (src: string, dst: string, cents: number) =>
    api("POST", "/transfers", {
      source_account_id: src, destination_account_id: dst, amount_cents: cents, description: "flow: lifecycle",
    }, { key: partner });

  await t.step("fixtures: a partner onboards a member", async () => {
    partner = await actor("partner");
    const e = await api("POST", "/entities", {
      type: "person", name: personaName(), date_of_birth: "1979-02-03",
      address: "300 Oak St, Springfield, IL 62701",
    }, { key: partner });
    assertEq(e.status, 201, `create entity (${JSON.stringify(e.body).slice(0, 200)})`);
    entity = String(e.body.id);
  });

  await t.step("bad opens are refused naming every field at once, and write nothing", async () => {
    const all4 = await api("POST", "/accounts", { opening_deposit_cents: -5 }, { key: partner, idem: null });
    assertEq(all4.status, 400, "everything wrong");
    assertEq(JSON.stringify(fields(all4)),
      JSON.stringify(["Idempotency-Key", "account_type", "entity_id", "opening_deposit_cents"]),
      "one round trip reports all four problems");

    for (const bad of [0, -100, 12.5, "10000"]) {
      const r = await api("POST", "/accounts",
        { entity_id: entity, account_type: "checking", opening_deposit_cents: bad }, { key: partner });
      assertEq(r.status, 400, `opening deposit ${JSON.stringify(bad)} refused`);
      assert(fields(r).includes("opening_deposit_cents"), `names opening_deposit_cents (${fields(r)})`);
    }

    const noKey = await api("POST", "/accounts",
      { entity_id: entity, account_type: "checking", opening_deposit_cents: 10_000 }, { key: partner, idem: null });
    assertEq(noKey.status, 400, "a funded open without an Idempotency-Key is refused");
    assertEq(JSON.stringify(fields(noKey)), JSON.stringify(["Idempotency-Key"]), "names the header");

    const noOwner = await api("POST", "/accounts", { account_type: "checking", opening_deposit_cents: 1_000 }, { key: partner });
    assertEq(noOwner.status, 400, "an ownerless account is refused (OQ-12)");
    assert((noOwner.body.errors as Any[]).some((e) => e.field === "entity_id" && e.type === "missing_field"),
      "entity_id missing_field");

    const ghost = await api("POST", "/accounts", { entity_id: `ent_ghost_${uid()}`, account_type: "checking" }, { key: partner });
    assertEq(ghost.status, 400, "an unknown entity is a 400, not an FK 500");
    assertEq(ghost.body.errors?.[0]?.field, "entity_id", "names entity_id");

    for (const bad of [7, "", {}, []]) {
      const r = await api("POST", "/accounts",
        { entity_id: bad, account_type: "checking", opening_deposit_cents: 1_000 }, { key: partner });
      assertEq(r.status, 400, `entity_id=${JSON.stringify(bad)} refused rather than coerced`);
    }

    const brokerage = await api("POST", "/accounts", { entity_id: entity, account_type: "brokerage" }, { key: partner });
    assertEq(brokerage.status, 400, "a product outside the vocabulary is refused");
    assertEq(brokerage.body.errors?.[0]?.field, "account_type", "names account_type");
    const msg = String(brokerage.body.errors?.[0]?.message);
    assert(msg.includes("checking") && msg.includes("share_draft"), `message names both vocabularies (${msg})`);

    const unstated = await api("POST", "/accounts", { entity_id: entity }, { key: partner });
    assertEq(unstated.status, 400, "no silent default product");
    assertEq(unstated.body.errors?.[0]?.field, "account_type", "names account_type");
    assertEq(unstated.body.errors?.[0]?.type, "missing_field", "as missing");

    const rows = await core().from("account").select("id").eq("entity_id", entity);
    assertEq((rows.data ?? []).length, 0, "not one account row was written by a refused open");
  });

  await t.step("an unfunded open needs no Idempotency-Key", async () => {
    const r = await api("POST", "/accounts", { entity_id: entity, account_type: "checking" }, { key: partner, idem: null });
    assertEq(r.status, 201, `unfunded open (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.balance, 0, "zero balance");
    unfunded = String(r.body.id);
    all.push(unfunded);
    assertEq((await accountRow(unfunded))?.entity_id, entity, "owned by the member");
  });

  await t.step("a funded open lands ONCE even when the partner retries it", async () => {
    const key = `flow-open-${uid()}`;
    const body = { entity_id: entity, account_type: "checking", opening_deposit_cents: 50_000 };
    const first = await api("POST", "/accounts", body, { key: partner, idem: key });
    assertEq(first.status, 201, `funded open (${JSON.stringify(first.body).slice(0, 200)})`);
    funded = String(first.body.id);
    all.push(funded);
    const retry = await api("POST", "/accounts", body, { key: partner, idem: key });
    assertEq(retry.status, 201, "retry replays");
    assertEq(retry.body.id, funded, "the retry returns the SAME account");
    assertEq(retry.headers.get("Idempotent-Replayed"), "true", "and says it is a replay");
    const got = await api("GET", `/accounts/${funded}`, undefined, { key: partner });
    assertEq(got.status, 200, "readable");
    assertEq(got.body.balance, 50_000, "the opening deposit landed once, not twice");
    assertEq(got.body.account_type, "checking", "product");
    const changed = await api("POST", "/accounts", { ...body, opening_deposit_cents: 60_000 }, { key: partner, idem: key });
    assertEq(changed.status, 409, "the same key with a different deposit is a conflict, not a second account");
  });

  await t.step("every product, and the credit-union spellings, open and are stored canonical", async () => {
    for (const [wire, stored] of [...ACCOUNT_TYPES.map((x) => [x, x]), ...Object.entries(CU_SPELLINGS)]) {
      const r = await api("POST", "/accounts", { entity_id: entity, account_type: wire }, { key: partner });
      assertEq(r.status, 201, `${wire} accepted (${JSON.stringify(r.body).slice(0, 200)})`);
      assertEq(r.body.account_type, stored, `${wire} reads back as ${stored}`);
      assertEq((await accountRow(String(r.body.id)))?.account_type, stored, `${wire} stored as ${stored}`);
      all.push(String(r.body.id));
      if (wire === "savings") closing = String(r.body.id);
    }
  });

  await t.step("the partner walks member → accounts, page by page, with the spec's envelope", async () => {
    const seen: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const q: string = `/accounts?entity_id=${entity}&limit=4${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const r = await api("GET", q, undefined, { key: partner });
      assertEq(r.status, 200, `page ${page}`);
      assertEq(JSON.stringify(Object.keys(r.body).sort()), JSON.stringify(["data", "pagination"]), "envelope");
      assertEq(JSON.stringify(Object.keys(r.body.pagination).sort()),
        JSON.stringify(["has_more", "limit", "next_after"]), "pagination block");
      for (const a of r.body.data as Any[]) {
        assertEq(a.entity_id, entity, "only this member's accounts");
        seen.push(a.id);
      }
      if (!r.body.pagination.has_more) {
        assertEq(r.body.pagination.next_after, null, "the last page offers no cursor");
        break;
      }
      assertEq(r.body.data.length, 4, "a full page before the cursor");
      assertEq(r.body.pagination.next_after, r.body.data[3].created_at, "the cursor is the last served row");
      after = r.body.pagination.next_after;
    }
    assertEq(new Set(seen).size, seen.length, "no account served twice");
    assertEq(JSON.stringify([...seen].sort()), JSON.stringify([...all].sort()), "every account found, nothing else");
  });

  await t.step("bad list parameters are refused in ONE 400; the limit is bounded", async () => {
    const r = await api("GET", "/accounts?status=dormant&limit=0&after=soon", undefined, { key: partner });
    assertEq(r.status, 400, "bad filters");
    assertEq(JSON.stringify(fields(r)), JSON.stringify(["after", "limit", "status"]), "all three named at once");
    for (const bad of ["201", "-1", "1.5", "all"]) {
      assertEq((await api("GET", `/accounts?limit=${bad}&entity_id=${entity}`, undefined, { key: partner })).status, 400,
        `limit=${bad} refused`);
    }
    assertEq((await api("GET", `/accounts?limit=200&entity_id=${entity}`, undefined, { key: partner })).status, 200,
      "200 is the ceiling, and allowed");
    assertEq((await api("GET", `/accounts/acct_${uid()}`, undefined, { key: partner })).status, 404, "unknown account 404");
  });

  await t.step("operations (D23) finds the partner's member accounts too", async () => {
    const r = await api("GET", `/accounts?entity_id=${entity}&limit=50`);
    assertEq(r.status, 200, "ops list");
    assertEq(r.body.data.length, all.length, "ops sees every account the partner opened");
  });

  await t.step("a fraud lock stops money in BOTH directions without touching status", async () => {
    const bad = await api("POST", `/accounts/${funded}/lock`, { lock_type: "temporary" }, { key: partner });
    assertEq(bad.status, 400, "unknown lock type refused");
    assertEq(bad.body.errors?.[0]?.field, "lock_type", "names lock_type");

    const r = await api("POST", `/accounts/${funded}/lock`, { lock_type: "fraud", reason: "flow: suspected ATO" }, { key: partner });
    assertEq(r.status, 200, `lock (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.lock_type, "fraud", "lock_type echoed");
    assertEq(r.body.status, "open", "status untouched");
    const row = await accountRow(funded);
    assertEq(row?.lock_type, "fraud", "lock landed on the row");
    assertEq(row?.status, "open", "lifecycle state untouched");
    const evt = await lastEvent(funded, "account.locked");
    assert(evt, "account.locked event emitted");
    assertEq(evt.payload?.lock_type, "fraud", "event lock_type");
    assertEq(evt.payload?.previous_lock, "none", "event previous_lock");
    assertEq(evt.payload?.status_untouched, "open", "event records the state it did not touch");
    assertEq(evt.payload?.reason, "flow: suspected ATO", "event carries the reason");

    const out = await transfer(funded, unfunded, 1_000);
    assertEq(out.status, 422, "debit from a locked account refused");
    assertEq(out.body.type, "account_locked", "typed");
    const into = await transfer(unfunded, funded, 1);
    assertEq(into.status, 422, "credit into a locked account refused");
    assertEq(into.body.type, "account_locked", "typed");
  });

  await t.step("unlocking restores the rail", async () => {
    const r = await api("POST", `/accounts/${funded}/lock`, { lock_type: "none" }, { key: partner });
    assertEq(r.status, 200, "unlock");
    assertEq((await accountRow(funded))?.lock_type, "none", "lock cleared on the row");
    assert(await lastEvent(funded, "account.unlocked"), "account.unlocked event emitted");
    const out = await transfer(funded, unfunded, 1_000);
    assertEq(out.status, 201, `transfer after unlock (${JSON.stringify(out.body).slice(0, 200)})`);
    assertEq(out.body.status, "settled", "settled");
  });

  await t.step("freeze: the account is findable as frozen and refuses money; unfreeze reopens it", async () => {
    const r = await api("POST", `/accounts/${funded}/transition`, { to: "frozen" }, { key: partner });
    assertEq(r.status, 200, `freeze (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.status, "frozen", "status");
    assertEq((await accountRow(funded))?.status, "frozen", "row frozen");
    const evt = await lastEvent(funded, "account.frozen");
    assertEq(evt?.payload?.from, "open", "account.frozen event: from");
    assertEq(evt?.payload?.to, "frozen", "account.frozen event: to");

    const l = await api("GET", `/accounts?entity_id=${entity}&status=frozen`, undefined, { key: partner });
    assertEq(l.status, 200, "status filter");
    assertEq(JSON.stringify((l.body.data as Any[]).map((a) => a.id)), JSON.stringify([funded]),
      "exactly the frozen account");

    const out = await transfer(funded, unfunded, 1_000);
    assertEq(out.status, 422, "a frozen account cannot pay");
    assertEq(out.body.type, "account_not_open", "typed");

    const back = await api("POST", `/accounts/${funded}/transition`, { to: "open" }, { key: partner });
    assertEq(back.status, 200, "unfreeze");
    assertEq((await accountRow(funded))?.status, "open", "row open again");
    assert(await lastEvent(funded, "account.opened"), "account.opened event (verb form, not account.open)");
  });

  await t.step("close: closed is forever, refuses money, and starts the retention clock", async () => {
    const bogus = await api("POST", `/accounts/${closing}/transition`, { to: "dormant" }, { key: partner });
    assertEq(bogus.status, 400, "unknown target state refused");
    assertEq(bogus.body.errors?.[0]?.field, "to", "names `to`");

    const r = await api("POST", `/accounts/${closing}/transition`, { to: "closed" }, { key: partner });
    assertEq(r.status, 200, `close (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq((await accountRow(closing))?.status, "closed", "row closed");
    assert(await lastEvent(closing, "account.closed"), "account.closed event");

    const rec = await core().from("record").select("id, retention_expires_at").eq("subject_ref", closing);
    assert(!rec.error, `record read: ${rec.error?.message}`);
    assert((rec.data ?? []).length > 0, "closure-anchored retention records were clocked (BSA-21)");
    assert((rec.data ?? []).every((x) => x.retention_expires_at), "each with an expiry");

    for (const to of ["open", "frozen"]) {
      const again = await api("POST", `/accounts/${closing}/transition`, { to }, { key: partner });
      assertEq(again.status, 409, `closed → ${to} refused`);
      assertEq(again.body.type, "invalid_state", "typed");
    }
    assertEq((await accountRow(closing))?.status, "closed", "still closed");

    const into = await transfer(funded, closing, 100);
    assertEq(into.status, 422, "no money into a closed account");
    assertEq(into.body.type, "account_not_open", "typed");

    const l = await api("GET", `/accounts?entity_id=${entity}&status=closed`, undefined, { key: partner });
    assertEq(JSON.stringify((l.body.data as Any[]).map((a) => a.id)), JSON.stringify([closing]), "findable as closed");
  });
});
