// Read, list, simulate and control-results flows: what a partner (and
// operations) can read back after money has moved, and what those reads must
// REFUSE. Closes the user-observable gaps the stubbed unit files
// core/supabase/functions/api/{reads,happy_paths,simulate,controls}.test.ts
// left after the rail flows (see ledger/{reads,happy_paths,simulate,controls}.md).
//
// Every fixture is a fresh person + account created by the partner; foreign
// rows (another partner's) are found in the database, never created.
import { actor, type Any, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

const RICH = 5_000_000; // $50,000
const BROKE = 10_000; // $100
const US_BENEFICIARY = { name: "Acme Corp", country: "US", routing_number: "021000021" };
const COUNTERPARTY = { name: "Acme Vendor", routing_number: "021000021", account_number: "123456789" };

const show = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);

async function newPerson(partner: string): Promise<string> {
  const e = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1990-03-14",
    address: "300 Elm St, Springfield, IL 62701",
  }, { key: partner });
  assertEq(e.status, 201, `create entity (${show(e)})`);
  return String(e.body.id);
}

async function onboard(partner: string, openingCents: number): Promise<string> {
  const entity = await newPerson(partner);
  const a = await api("POST", "/accounts", {
    entity_id: entity, account_type: "checking", opening_deposit_cents: openingCents,
  }, { key: partner });
  assertEq(a.status, 201, `open account (${show(a)})`);
  return String(a.body.id);
}

async function homePartner(): Promise<string> {
  const inst = await core().from("instance").select("id").limit(1).single();
  const p = await core().from("partner").select("id")
    .eq("status", "active").eq("instance_id", inst.data!.id).order("id").limit(1).single();
  assert(!p.error, `partner lookup: ${p.error?.message}`);
  return String(p.data!.id);
}

/** the partner_id the DB holds for each id (the API never echoes it) */
async function ownersOf(table: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const r = await core().from(table).select("partner_id").in("id", ids);
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return new Set((r.data ?? []).map((x: Any) => String(x.partner_id)));
}

const idsOf = (r: { body: Any }): string[] => (r.body.data ?? []).map((x: Any) => String(x.id));

// ===========================================================================
// 1. rail lists: partner-confined, per-rail vocabulary, 404 for the unshowable
// ===========================================================================

flow("reads: rail lists are confined to the partner, check each rail's own vocabulary, and 404 what they cannot show", async (t) => {
  const partner = await actor("partner");
  let home = "";
  let rich = "";
  let broke = "";
  let heldWire = "";
  let rejectedWire = "";
  let rejectedAch = "";
  let declinedCard = "";

  await t.step("fixtures: a partner onboards a funded and an unfunded member", async () => {
    home = await homePartner();
    rich = await onboard(partner, RICH);
    broke = await onboard(partner, BROKE);
  });

  await t.step("the partner moves money on every rail: a held wire, and NSF refusals on wire, ACH and card", async () => {
    const w = await api("POST", "/payments/wire/prepare", {
      source_account_id: rich, amount_cents: 150_000, beneficiary: US_BENEFICIARY, purpose: "reads: held wire",
    }, { key: partner });
    assertEq(w.status, 201, `held wire (${show(w)})`);
    heldWire = String(w.body.id);

    const rw = await api("POST", "/payments/wire/prepare", {
      source_account_id: broke, amount_cents: 500_000, beneficiary: US_BENEFICIARY, purpose: "reads: nsf wire",
    }, { key: partner });
    assertEq(rw.status, 422, `NSF wire (${show(rw)})`);
    rejectedWire = String(rw.body.resource_id);

    const ra = await api("POST", "/payments/ach",
      { source_account_id: broke, amount_cents: 500_000, counterparty: COUNTERPARTY }, { key: partner });
    assertEq(ra.status, 422, `NSF ach (${show(ra)})`);
    rejectedAch = String(ra.body.resource_id);

    const rc = await api("POST", "/payments/card/authorize",
      { source_account_id: broke, amount_cents: 500_000, merchant: "Acme Coffee" }, { key: partner });
    assertEq(rc.status, 422, `NSF card (${show(rc)})`);
    declinedCard = String(rc.body.resource_id);
  });

  await t.step("each rail's status filter finds this run's row and only this partner's rows", async () => {
    const cases: [string, string, string, string][] = [
      ["/wire-transfers", "wire_transfer", "rejected", rejectedWire],
      ["/ach-transfers", "ach_transfer", "rejected", rejectedAch],
      ["/cards", "card_authorization", "declined", declinedCard],
    ];
    for (const [path, table, status, mine] of cases) {
      const r = await api("GET", `${path}?status=${status}&limit=200`, undefined, { key: partner });
      assertEq(r.status, 200, `${path} list (${show(r)})`);
      const ids = idsOf(r);
      assert(ids.includes(mine), `${path}?status=${status} lists this run's ${mine}`);
      assert((r.body.data as Any[]).every((x) => x.status === status), `${path}: every row is ${status}`);
      const owners = await ownersOf(table, ids);
      assertEq(JSON.stringify([...owners]), JSON.stringify([home]), `${path}: every listed row is the partner's own`);
    }
  });

  await t.step("operations (D23) lists across partners; the partner never sees the foreign row", async () => {
    for (const [path, table] of [["/wire-transfers", "wire_transfer"], ["/ach-transfers", "ach_transfer"]]) {
      const foreign = await core().from(table).select("id, status, created_at")
        .neq("partner_id", home).order("created_at", { ascending: false }).limit(1).single();
      assert(!foreign.error && foreign.data, `a foreign ${table} exists to probe (${foreign.error?.message})`);
      const f = foreign.data as Any;
      // `after` is strictly-older: just past the foreign row puts it at the top
      const after = new Date(Date.parse(f.created_at) + 1).toISOString();
      const qs = `?status=${f.status}&after=${encodeURIComponent(after)}&limit=5`;
      const ops = await api("GET", `${path}${qs}`);
      assertEq(ops.status, 200, `ops ${path} (${show(ops)})`);
      assert(idsOf(ops).includes(String(f.id)), `operations sees the foreign ${table} ${f.id}`);
      const mine = await api("GET", `${path}${qs}`, undefined, { key: partner });
      assertEq(mine.status, 200, `partner ${path} (${show(mine)})`);
      assert(!idsOf(mine).includes(String(f.id)), `the partner's list never carries the foreign ${table}`);
      const one = await api("GET", `${path}/${f.id}`, undefined, { key: partner });
      assertEq(one.status, 404, `partner reads the foreign ${table} by id (${show(one)})`);
    }
  });

  await t.step("each rail refuses a status from ANOTHER rail's vocabulary, naming the field", async () => {
    const wrong: [string, string][] = [
      ["/wire-transfers", "settled"], // ACH's word
      ["/ach-transfers", "completed"], // the wire's word
      ["/cards", "submitted"], // neither
    ];
    for (const [path, bad] of wrong) {
      const r = await api("GET", `${path}?status=${bad}`, undefined, { key: partner });
      assertEq(r.status, 400, `${path}?status=${bad} (${show(r)})`);
      assertEq(r.body.type, "validation_error", `${path}: typed`);
      assert((r.body.errors ?? []).some((e: Any) => e.field === "status"), `${path}: names status`);
    }
  });

  await t.step("dual_control_status is validated, and filtering on it finds the wire awaiting approval", async () => {
    const bad = await api("GET", "/wire-transfers?dual_control_status=maybe", undefined, { key: partner });
    assertEq(bad.status, 400, `unknown dual_control_status (${show(bad)})`);
    assert((bad.body.errors ?? []).some((e: Any) => e.field === "dual_control_status"), "names the field");

    const req = await api("GET", "/wire-transfers?dual_control_status=required&limit=200", undefined, { key: partner });
    assertEq(req.status, 200, `required filter (${show(req)})`);
    assert(idsOf(req).includes(heldWire), "the held wire is findable as awaiting its second approver");
    assert((req.body.data as Any[]).every((x) => x.dual_control_status === "required"), "filter honoured");
    assertEq(JSON.stringify([...await ownersOf("wire_transfer", idsOf(req))]), JSON.stringify([home]),
      "still confined to the partner");
  });

  await t.step("a malformed id and a well-formed absent uuid both 404 the same way on wire and ACH", async () => {
    for (const path of ["/wire-transfers", "/ach-transfers"]) {
      const junk = await api("GET", `${path}/does-not-exist`, undefined, { key: partner });
      assertEq(junk.status, 404, `${path} malformed id (${show(junk)})`);
      assertEq(junk.body.type, "not_found", `${path} malformed: typed not_found, never a 500 cast error`);
      const absent = await api("GET", `${path}/00000000-0000-4000-8000-000000000000`, undefined, { key: partner });
      assertEq(absent.status, 404, `${path} absent uuid (${show(absent)})`);
      assertEq(absent.body.type, junk.body.type, `${path}: shape cannot tell malformed from absent`);
    }
  });
});

// ===========================================================================
// 2. GET /entities/{id}/verifications
// ===========================================================================

flow("reads: a member's verification history — scoped by entity, vendor payload withheld, caveat stated", async (t) => {
  const partner = await actor("partner");
  let home = "";
  let entity = "";
  let verId = "";

  await t.step("a member never verified: an empty history that still names the pre-linkage caveat", async () => {
    home = await homePartner();
    entity = await newPerson(partner);
    const r = await api("GET", `/entities/${entity}/verifications`, undefined, { key: partner });
    assertEq(r.status, 200, `empty history (${show(r)})`);
    assertEq(r.body.entity_id, entity, "keyed on the member");
    assertEq(r.body.count, 0, "nothing run yet");
    assertEq(r.body.verifications.length, 0, "empty list");
    assert(String(r.body.unattributable_note).includes("20260727000100"),
      "an empty list says pre-migration rows cannot appear, naming the migration");
  });

  await t.step("after a KYC run the history shows it — but never the vendor's raw provider_result", async () => {
    const v = await api("POST", `/entities/${entity}/verifications`, { simulate: "approve" }, { key: partner });
    assertEq(v.status, 201, `verification (${show(v)})`);
    verId = String(v.body.id);
    const row = await core().from("verification").select("provider_result").eq("id", verId).single();
    assert(!row.error, `verification read: ${row.error?.message}`);
    assert(row.data?.provider_result != null, "the stored row DOES carry a vendor payload");

    const r = await api("GET", `/entities/${entity}/verifications`, undefined, { key: partner });
    assertEq(r.status, 200, `history (${show(r)})`);
    assertEq(r.body.count, 1, "one run");
    const got = r.body.verifications[0];
    assertEq(got.id, verId, "the run is listed");
    assertEq(got.status, "approved", "decision served");
    assert(got.ofac_result, "OFAC outcome served");
    assert(!("provider_result" in got), `provider_result withheld (keys: ${Object.keys(got).join(",")})`);
  });

  await t.step("another partner's member is a 404 — not an empty 'never verified' list", async () => {
    const foreign = await core().from("entity").select("id")
      .neq("partner_id", home).order("created_at", { ascending: false }).limit(1).single();
    assert(!foreign.error && foreign.data, `a foreign entity exists to probe (${foreign.error?.message})`);
    const r = await api("GET", `/entities/${foreign.data!.id}/verifications`, undefined, { key: partner });
    assertEq(r.status, 404, `foreign member (${show(r)})`);
    assertEq(r.body.type, "not_found", "indistinguishable from a missing member");
    const ops = await api("GET", `/entities/${foreign.data!.id}/verifications`);
    assertEq(ops.status, 200, `operations reads across partners (${show(ops)})`);
  });
});

// ===========================================================================
// 3. GET /control-results: ordering, bounds, empty results
// ===========================================================================

flow("reads: control-results — newest first, bounded pages, and no match is an empty list", async (t) => {
  const partner = await actor("partner");

  await t.step("the default page is newest-first and capped at 50", async () => {
    const r = await api("GET", "/control-results", undefined, { key: partner });
    assertEq(r.status, 200, `default page (${show(r)})`);
    assert(Array.isArray(r.body.data), "rows wrapped in data");
    assertEq(r.body.pagination?.limit, 50, "default limit");
    assert(r.body.data.length <= 50, `at most 50 rows (got ${r.body.data.length})`);
    const ts = (r.body.data as Any[]).map((x) => Date.parse(x.created_at));
    assert(ts.every((v, i) => i === 0 || ts[i - 1] >= v), "newest first");
  });

  await t.step("limit is honoured within bounds and refused outside them", async () => {
    const r = await api("GET", "/control-results?limit=10", undefined, { key: partner });
    assertEq(r.status, 200, `limit=10 (${show(r)})`);
    assert(r.body.data.length <= 10, `at most 10 rows (got ${r.body.data.length})`);
    assertEq(r.body.pagination?.limit, 10, "limit echoed");
    for (const bad of ["0", "-5", "201", "ten", "2.5"]) {
      const b = await api("GET", `/control-results?limit=${bad}`, undefined, { key: partner });
      assertEq(b.status, 400, `limit=${bad} refused (${show(b)})`);
      assert((b.body.errors ?? []).some((e: Any) => e.field === "limit"), `limit=${bad}: names limit`);
    }
  });

  await t.step("a control that never fired is an empty data array, not an error", async () => {
    const r = await api("GET", `/control-results?control_id=CG-NOPE-${uid()}`, undefined, { key: partner });
    assertEq(r.status, 200, `no matches (${show(r)})`);
    assertEq(JSON.stringify(r.body.data), "[]", "empty data");
  });
});

// ===========================================================================
// 4. submission edges the rail flows did not walk
// ===========================================================================

flow("reads: submission edges — a retried wire replays, a reused key conflicts, unknown sources 404, ACH window defaults, a card needs a merchant", async (t) => {
  const partner = await actor("partner");
  let src = "";
  const KEY = uid();
  const WIRE = { amount_cents: 200_000, beneficiary: US_BENEFICIARY, purpose: "reads: retried wire" };
  let wireId = "";

  const wiresFrom = async (acct: string) => {
    const r = await core().from("wire_transfer").select("id").contains("originator", { account_id: acct });
    assert(!r.error, `wire_transfer read: ${r.error?.message}`);
    return (r.data ?? []).map((x: Any) => String(x.id));
  };

  await t.step("fixtures: a funded member", async () => {
    src = await onboard(partner, RICH);
  });

  await t.step("a retried wire prepare replays the same wire — one row, one hold", async () => {
    const first = await api("POST", "/payments/wire/prepare", { source_account_id: src, ...WIRE }, { key: partner, idem: KEY });
    assertEq(first.status, 201, `prepare (${show(first)})`);
    assertEq(first.body.status, "submitted", "held");
    wireId = String(first.body.id);
    const again = await api("POST", "/payments/wire/prepare", { source_account_id: src, ...WIRE }, { key: partner, idem: KEY });
    assertEq(again.status, 201, `retry (${show(again)})`);
    assertEq(again.headers.get("Idempotent-Replayed"), "true", "replay header");
    assertEq(String(again.body.id), wireId, "same wire");
    assertEq(JSON.stringify(await wiresFrom(src)), JSON.stringify([wireId]), "exactly one wire row");
  });

  await t.step("the same key with a different body is 409 idempotency_key_reused — no second wire", async () => {
    const r = await api("POST", "/payments/wire/prepare",
      { source_account_id: src, ...WIRE, amount_cents: 300_000 }, { key: partner, idem: KEY });
    assertEq(r.status, 409, `reused key (${show(r)})`);
    assertEq(r.body.type, "idempotency_key_reused", "typed");
    assertEq((await wiresFrom(src)).length, 1, "still one wire row");
  });

  await t.step("a wire from an account that does not exist is a 404 and writes nothing", async () => {
    const ghost = `acct_ghost_${uid()}`;
    const r = await api("POST", "/payments/wire/prepare", { source_account_id: ghost, ...WIRE }, { key: partner });
    assertEq(r.status, 404, `unknown source (${show(r)})`);
    assertEq(r.body.type, "not_found", "typed");
    assertEq((await wiresFrom(ghost)).length, 0, "no row for the ghost account");
  });

  await t.step("an ACH with no window settles next_day by default", async () => {
    const r = await api("POST", "/payments/ach",
      { source_account_id: src, amount_cents: 25_000, counterparty: COUNTERPARTY }, { key: partner });
    assertEq(r.status, 201, `ach (${show(r)})`);
    assertEq(r.body.status, "submitted", "held");
    assertEq(r.body.window, "next_day", "default window on the response");
    const row = await core().from("ach_transfer").select("window").eq("id", r.body.id).single();
    assertEq(row.data?.window, "next_day", "default window stored");
  });

  await t.step("a card authorization without a merchant is refused by field and leaves no row", async () => {
    const before = await core().from("card_authorization").select("id", { count: "exact", head: true })
      .contains("originator", { account_id: src });
    const r = await api("POST", "/payments/card/authorize",
      { source_account_id: src, amount_cents: 10_000 }, { key: partner });
    assertEq(r.status, 400, `no merchant (${show(r)})`);
    assert((r.body.errors ?? []).some((e: Any) => e.field === "merchant"), "names merchant");
    const after = await core().from("card_authorization").select("id", { count: "exact", head: true })
      .contains("originator", { account_id: src });
    assertEq(after.count, before.count, "no authorization row written");
  });
});

// ===========================================================================
// 5. the sandbox simulator routes to the real writers
// ===========================================================================

flow("reads: sandbox simulate — every terminal step is routed, resolve is not shadowed, a gate block still blocks", async (t) => {
  const partner = await actor("partner");
  const SIM = "/sandbox/simulate";
  let broke = "";
  let nsfId = "";

  await t.step("every rail's lifecycle step is simulated — none answers 501", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    const paths = [
      "/ach", `/ach/${ghost}/settle`, `/ach/${ghost}/return`, `/ach/${ghost}/noc`,
      "/wire/prepare", `/wire/${ghost}/confirm`, `/wire/${ghost}/cancel`, `/wire/${ghost}/reject`,
      `/wire/${ghost}/return`, `/wire/${ghost}/return/resolve`,
      "/card/authorize", "/card/x/capture", "/card/x/settle", "/card/x/reverse", "/card/x/expire",
    ];
    for (const p of paths) {
      const r = await api("POST", `${SIM}${p}`, {}, { key: partner });
      assert(r.status !== 501, `${p} must be simulated, got 501 (${show(r)})`);
      assert(r.status < 500, `${p} answered ${r.status} (${show(r)})`);
    }
  });

  await t.step("wire return/resolve reaches the RESOLVE writer, not the bare return route", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    const resolve = await api("POST", `${SIM}/wire/${ghost}/return/resolve`, {}, { key: partner });
    assertEq(resolve.status, 400, `resolve without outcome (${show(resolve)})`);
    assertEq(resolve.body.errors?.[0]?.field, "outcome", "refused for a missing OUTCOME, not a missing reason");
  });

  await t.step("a simulated ACH the member cannot fund is blocked exactly like a real one", async () => {
    broke = await onboard(partner, BROKE);
    const r = await api("POST", `${SIM}/ach`,
      { source_account_id: broke, amount_cents: 500_000, counterparty: COUNTERPARTY }, { key: partner });
    assertEq(r.status, 422, `simulated NSF (${show(r)})`);
    assertEq(r.body.type, "insufficient_funds", "typed");
    nsfId = String(r.body.resource_id);
    const cr = await core().from("control_result").select("control_id, decision")
      .eq("event", nsfId).eq("control_id", "CG-NSF-01");
    assert(!cr.error, `control_result read: ${cr.error?.message}`);
    assertEq(cr.data?.[0]?.decision, "reject", "control evidence written for the simulated entry");
    const row = await core().from("ach_transfer").select("status, blnk_transaction_id").eq("id", nsfId).single();
    assertEq(row.data?.status, "rejected", "row rejected");
    assertEq(row.data?.blnk_transaction_id ?? null, null, "a blocked entry never reaches the ledger");
  });
});
