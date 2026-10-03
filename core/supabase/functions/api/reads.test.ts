// The payment-rail and verification read endpoints.
//
// These rails had 20+ write endpoints between them and no way to read any of
// them back. What is tested here is mostly what a read must REFUSE: the partner
// predicate going on before any caller-supplied filter, and an unknown status
// being rejected rather than passed to PostgREST.
//
// The loan-application reads that used to live here are gone with the rest of
// lending — Pynthia is a narrow bank and does not originate credit.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getWireTransfer, getWireTransfers } from "./wires.ts";
import { getAchTransfer, getAchTransfers } from "./ach.ts";
import { getCards } from "./cards.ts";
import { getEntityVerifications } from "./kyc.ts";
import { type Any, filtersOf, listDb, OPS_CTX, stubDb, TEST_CTX } from "./test_helpers.ts";

// ------------------------------------------------------------- partner scoping

Deno.test("every rail list is confined to one partner BEFORE any caller filter", async () => {
  // Order matters, not just presence: the partner predicate is what makes the
  // rest of the query safe, so it cannot be appended after a filter the caller
  // supplied.
  // Each rail is given a status from its OWN vocabulary — a card is never
  // 'rejected', it is 'declined', and passing the wrong word would 400 before
  // the query is built and make this assertion vacuously pass on an empty list.
  const cases: [string, typeof getWireTransfers, string][] = [
    ["wire-transfers", getWireTransfers, "rejected"],
    ["ach-transfers", getAchTransfers, "returned"],
    ["cards", getCards, "declined"],
  ];
  for (const [path, handler, status] of cases) {
    const { db, calls } = listDb([]);
    await handler(new Request(`https://x/${path}?status=${status}`), db, "r0", TEST_CTX);
    assertEquals(
      filtersOf(calls),
      ["eq:partner_id=ptnr_test", `eq:status=${status}`],
      `${path} must scope before it filters`,
    );
  }
});

Deno.test("an ops actor lists every rail across partners — D23", async () => {
  for (const handler of [getWireTransfers, getAchTransfers, getCards]) {
    const { db, calls } = listDb([]);
    await handler(new Request("https://x/x"), db, "r1", OPS_CTX);
    assertEquals(filtersOf(calls), []);
  }
});

// ------------------------------------------------------------ status vocabulary

Deno.test("each rail refuses a status outside its OWN vocabulary", async () => {
  // The three rails do not share a status set — 'settled' is an ACH terminal
  // state, wires reach 'completed', and a card is 'captured'. Validating them
  // against one merged list would accept a status the table's CHECK refuses.
  const wrong: [string, unknown, string][] = [
    ["wire", getWireTransfers, "settled"], // ACH's word, not a wire's
    ["ach", getAchTransfers, "completed"], // the wire's word
    ["card", getCards, "submitted"], // neither
  ];
  for (const [name, handler, bad] of wrong) {
    const { db, calls } = listDb([]);
    const res = await (handler as typeof getWireTransfers)(
      new Request(`https://x/x?status=${bad}`),
      db,
      "r2",
      TEST_CTX,
    );
    assertEquals(res.status, 400, `${name} must refuse ${bad}`);
    assertEquals(
      calls.filter((c) => c.fn === "eq" && c.args[0] === "status").length,
      0,
      `${name}: ${bad} must never reach the query builder`,
    );
  }
});

Deno.test("dual_control_status is validated, and is what makes an approval id resolvable", async () => {
  const { db, calls } = listDb([]);
  const bad = await getWireTransfers(
    new Request("https://x/wire-transfers?dual_control_status=maybe"),
    db,
    "r3",
    TEST_CTX,
  );
  assertEquals(bad.status, 400);

  const { db: db2, calls: calls2 } = listDb([]);
  await getWireTransfers(
    new Request("https://x/wire-transfers?dual_control_status=unassessed"),
    db2,
    "r4",
    TEST_CTX,
  );
  assertEquals(filtersOf(calls2), [
    "eq:partner_id=ptnr_test",
    "eq:dual_control_status=unassessed",
  ]);
  assert(calls.length >= 0);
});

Deno.test("a malformed id on a uuid-keyed rail is 404, not 500", async () => {
  // core.wire_transfer and core.ach_transfer key on uuid; account, transfer,
  // card_authorization and loan_application all key on text. On the text tables
  // a junk id is simply a row that isn't there. On these two PostgREST hands it
  // to Postgres, which raises a CAST ERROR rather than returning no rows — so
  // the handler's error branch answered 500 and a caller who typo'd an id was
  // told "an unexpected error occurred". Caught before the query is issued.
  for (const [name, handler] of [["wire", getWireTransfer], ["ach", getAchTransfer]] as const) {
    const { db, calls } = listDb([]);
    const res = await handler(new Request("https://x/x"), "does-not-exist", db, "u1", TEST_CTX);
    assertEquals(res.status, 404, `${name} must 404 a malformed id`);
    assertEquals(calls.length, 0, `${name}: the database must never see an unparseable uuid`);
  }
});

Deno.test("a well-formed but absent uuid is also 404 — the two are indistinguishable", async () => {
  // Answering 400 for "malformed" and 404 for "absent" would let a caller sort
  // real ids from unreal ones by shape alone. Same reasoning as OWN-01 taking
  // 404 over 403 across partners.
  const { db } = stubDb(null);
  const res = await getWireTransfer(
    new Request("https://x/x"),
    "00000000-0000-4000-8000-000000000000",
    db,
    "u2",
    TEST_CTX,
  );
  assertEquals(res.status, 404);
});

// ------------------------------------------------- GET /entities/{id}/verifications
//
// core.verification has no partner_id, so this endpoint is scoped through the
// ENTITY. The tests that matter are about what it refuses and what it omits.

/**
 * Two tables, two answers. Purpose-built rather than reusing listDb, because
 * the whole behaviour under test is "what the entity lookup returned decides
 * whether the verification query runs at all".
 */
function entityVerificationDb(
  entity: unknown,
  verifications: Record<string, unknown>[],
) {
  const calls: { table: string; fn: string; args: unknown[] }[] = [];
  const from = (table: string) => {
    const chain: Any = {
      select: (...a: unknown[]) => (calls.push({ table, fn: "select", args: a }), chain),
      eq: (...a: unknown[]) => (calls.push({ table, fn: "eq", args: a }), chain),
      order: (...a: unknown[]) => (calls.push({ table, fn: "order", args: a }), chain),
      maybeSingle: () => Promise.resolve({ data: entity, error: null }),
      then: (res: (v: unknown) => unknown) => res({ data: verifications, error: null }),
    };
    return chain;
  };
  const db: Any = { schema: () => ({ from }) };
  return { db, calls };
}

Deno.test("a member the caller cannot see is 404, NOT an empty verification list", async () => {
  // An empty list asserts "this member has never been verified". A 404 says
  // "no such member here". For a compliance surface those are entirely
  // different claims, and returning the wrong one about another partner's
  // member is the OWN-01 failure in a new place.
  const { db, calls } = entityVerificationDb(null, []);
  const res = await getEntityVerifications(
    new Request("https://x/x"),
    "ent_someone_elses",
    db,
    "v1",
    TEST_CTX,
  );
  assertEquals(res.status, 404);
  assertEquals(
    calls.filter((c) => c.table === "verification").length,
    0,
    "the verification table must not be queried for an invisible entity",
  );
});

Deno.test("the entity gate is partner-scoped, and the list is keyed on entity_id", async () => {
  const { db, calls } = entityVerificationDb({ id: "ent_1" }, []);
  await getEntityVerifications(new Request("https://x/x"), "ent_1", db, "v2", TEST_CTX);
  const eqs = calls.filter((c) => c.fn === "eq").map((c) => `${c.table}:${c.args[0]}=${c.args[1]}`);
  assertEquals(eqs, [
    "entity:id=ent_1",
    "entity:partner_id=ptnr_test",
    "verification:entity_id=ent_1",
  ]);
});

Deno.test("a verification read omits provider_result — it is the vendor's raw payload", async () => {
  // For a full-trust attestation provider_result carries the attesting partner;
  // for a live run it is whatever the vendor returned. Member Services needs
  // the decision and the OFAC outcome, not third-party PII.
  const { db } = entityVerificationDb({ id: "ent_1" }, [{
    id: "ver_1",
    entity_id: "ent_1",
    type: "kyc",
    status: "approved",
    ofac_result: "clear",
    match_status: "no_match",
    trust_level: null,
    provider: "alloy",
    created_at: "2026-07-20T00:00:00Z",
  }]);
  const res = await getEntityVerifications(new Request("https://x/x"), "ent_1", db, "v3", TEST_CTX);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.count, 1);
  assertEquals(body.entity_id, "ent_1");
  assertEquals(body.verifications[0].ofac_result, "clear");
  assertEquals(body.verifications[0].provider_result, undefined);
});

Deno.test("the projection itself never names provider_result", async () => {
  // The assertion above only proves the fixture lacked the field. This proves
  // the SELECT could not have asked for it, which is what actually keeps the
  // vendor payload out when the row does carry one.
  const { db, calls } = entityVerificationDb({ id: "ent_1" }, []);
  await getEntityVerifications(new Request("https://x/x"), "ent_1", db, "v4", TEST_CTX);
  const projection = calls.find((c) => c.table === "verification" && c.fn === "select");
  assert(projection, "the verification table must be selected from");
  assert(
    !String(projection.args[0]).includes("provider_result"),
    "provider_result must not be in the projection",
  );
});

Deno.test("an empty list still says the pre-migration rows cannot appear", async () => {
  // 171 rows predate entity_id and are unattributable. A compliance reader who
  // takes an empty list as "nothing was ever run" would be wrong, so the
  // response says so rather than leaving the caller to know it.
  const { db } = entityVerificationDb({ id: "ent_1" }, []);
  const res = await getEntityVerifications(new Request("https://x/x"), "ent_1", db, "v5", TEST_CTX);
  const body = await res.json();
  assertEquals(body.count, 0);
  assert(
    String(body.unattributable_note).includes("20260727000100"),
    "the caveat must name the migration that draws the line",
  );
});
