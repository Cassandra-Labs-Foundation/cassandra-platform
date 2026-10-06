// TEST-CATALOG Tier 1 — D5 authentication & authorization, card 45 (partner
// tokens) and card 51 (instance binding), black-box over HTTP.
//
// Every assertion is on an HTTP answer from the DEPLOYED core. The core has
// no token-provisioning API yet (catalog D5-T2), so credentials with a
// specific actor class, scope, expiry or partner are PROVISIONED the way an
// operator's issue-token script does it: a sha256-only row inserted with the
// service role. The database is used for that setup only — never to assert.
//
// Every token minted here carries token_prefix `cass_test`, which the core
// labels `demo` evidence (that labelling is itself asserted below), and every
// one is revoked in a `finally`. Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// beside DEMO_API_KEY; self-skips without them. Minting is local to this file
// on purpose: the contract suite does not depend on the flow harness.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type Any,
  API,
  api,
  type ApiResponse,
  assert,
  assertEq,
  assertErrorShape,
  ENABLED as API_ENABLED,
  KEY,
  mkAccount,
  mkEntity,
  uid,
} from "./helpers.ts";

const DB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const DB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ENABLED = API_ENABLED && DB_URL.length > 0 && DB_KEY.length > 0;

let client: SupabaseClient | null = null;
function core() {
  client ??= createClient(DB_URL, DB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return client.schema("core");
}

function t(name: string, fn: () => Promise<void>, ignore = false): void {
  Deno.test({ name, ignore: ignore || !ENABLED, fn });
}

const show = (b: unknown) => JSON.stringify(b).slice(0, 300);

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------- provisioning

type Actor = "partner" | "cu_admin" | "pynthia_ops";
const ALL_TIERS = ["read", "write", "realtime", "bulk"];

let home: { instanceId: string; partnerId: string } | null = null;
/** THIS instance and its sole active partner (D18). */
async function homePartner(): Promise<{ instanceId: string; partnerId: string }> {
  if (home) return home;
  const inst = await core().from("instance").select("id").limit(1).single();
  if (inst.error) throw new Error(`instance lookup: ${inst.error.message}`);
  const p = await core().from("partner").select("id")
    .eq("status", "active").eq("instance_id", inst.data.id).order("id").limit(1).single();
  if (p.error) throw new Error(`partner lookup: ${p.error.message}`);
  home = { instanceId: inst.data.id, partnerId: p.data.id };
  return home;
}

/** An active partner bound to some OTHER instance (the core hosts ptnr_drill on inst_drill). */
async function foreignPartner(): Promise<{ instanceId: string; partnerId: string }> {
  const { instanceId } = await homePartner();
  const p = await core().from("partner").select("id, instance_id")
    .eq("status", "active").neq("instance_id", instanceId).order("id").limit(1).single();
  if (p.error) throw new Error(`foreign partner lookup: ${p.error.message}`);
  return { instanceId: p.data.instance_id, partnerId: p.data.id };
}

interface Grant {
  actor?: Actor;
  endpoints?: string[];
  tiers?: string[];
  expiresAt?: string | null;
  /** override the partner (default: home partner for `partner`, none otherwise) */
  partnerId?: string | null;
  /** override the instance the row is bound to (default: this instance) */
  instanceId?: string;
}

/** Mint a cass_test token with an explicit grant; its id lands on `minted`. */
async function mint(minted: string[], label: string, g: Grant = {}): Promise<string> {
  const { instanceId, partnerId } = await homePartner();
  const actor = g.actor ?? "partner";
  const rand = [...crypto.getRandomValues(new Uint8Array(20))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const plaintext = `cass_test_${rand}`;
  const id = `tok_test_ct_${label}_${rand.slice(0, 12)}`;
  const ins = await core().from("api_token").insert({
    id, token_hash: await sha256Hex(plaintext), token_prefix: "cass_test",
    actor_type: actor, roles: [],
    partner_id: g.partnerId !== undefined ? g.partnerId : (actor === "partner" ? partnerId : null),
    instance_id: g.instanceId ?? instanceId,
    allowed_endpoints: g.endpoints ?? ["*"], allowed_tiers: g.tiers ?? ALL_TIERS,
    status: "active", expires_at: g.expiresAt ?? null,
  });
  if (ins.error) throw new Error(`token insert (${label}): ${ins.error.message}`);
  minted.push(id);
  return plaintext;
}

async function revoke(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const r = await core().from("api_token").update({ status: "revoked" }).in("id", ids.splice(0));
  if (r.error) console.error(`revoking contract tokens: ${r.error.message}`);
}

/** Run `fn` with a fresh mint list that is always revoked afterwards. */
async function withTokens(fn: (minted: string[]) => Promise<void>): Promise<void> {
  const minted: string[] = [];
  try {
    await fn(minted);
  } finally {
    await revoke(minted);
  }
}

/** Raw request with an Authorization: Bearer header instead of X-Api-Key. */
async function bearer(method: string, path: string, token: string): Promise<ApiResponse> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: Any = text;
  try {
    body = JSON.parse(text);
  } catch { /* raw */ }
  return { status: res.status, headers: res.headers, body };
}

function assert401(r: ApiResponse, msg: string): void {
  assertEq(r.status, 401, `${msg} (${show(r.body)})`);
  assertEq(r.body.type, "unauthorized", `${msg}: typed unauthorized`);
  assertErrorShape(r, msg);
}

function assert403(r: ApiResponse, msg: string, detailIncludes?: string): void {
  assertEq(r.status, 403, `${msg} (${show(r.body)})`);
  assertEq(r.body.type, "insufficient_scope", `${msg}: typed insufficient_scope`);
  assertErrorShape(r, msg);
  if (detailIncludes) {
    assert(String(r.body.detail).includes(detailIncludes),
      `${msg}: detail should name '${detailIncludes}' — got '${r.body.detail}'`);
  }
}

/** Authenticated AND authorized: the handler ran (any status but 401/403). */
function assertPastAuth(r: ApiResponse, msg: string): void {
  assert(r.status !== 401 && r.status !== 403,
    `${msg}: expected to pass authentication + authorization, got ${r.status} ${show(r.body)}`);
}

/** The 401 body with its per-request id removed, for byte comparison. */
function sansRequestId(r: ApiResponse): string {
  const { request_id: _rid, ...rest } = r.body ?? {};
  return JSON.stringify(rest);
}

// One funded-or-not account owned by the home partner, created by operations
// (the demo key resolves ownership to the instance's sole partner).
let fixtureAcct: string | null = null;
async function acct(): Promise<string> {
  fixtureAcct ??= await mkAccount(await mkEntity("D5 Auth Fixture"));
  return fixtureAcct;
}

// ===================================================== authentication (401)

t("D5-A01: a minted token authenticates via Authorization: Bearer AND the legacy X-Api-Key header", () =>
  withTokens(async (minted) => {
    const tok = await mint(minted, "hdr");
    const viaBearer = await bearer("GET", "/cards?limit=1", tok);
    assertEq(viaBearer.status, 200, `Bearer (${show(viaBearer.body)})`);
    const viaLegacy = await api("GET", "/cards?limit=1", undefined, { key: tok });
    assertEq(viaLegacy.status, 200, `X-Api-Key (${show(viaLegacy.body)})`);
    const demoBearer = await bearer("GET", "/cards?limit=1", KEY);
    assertEq(demoBearer.status, 200, "the demo key is read from Bearer too");
  }));

t("D5-A02: a missing or unknown token is 401 on a Bearer request too", async () => {
  assert401(await bearer("GET", "/cards?limit=1", `cass_test_${uid()}`), "unknown Bearer token");
  const none = await fetch(`${API}/cards?limit=1`, { headers: { Authorization: "Bearer " } });
  assertEq(none.status, 401, "empty Bearer");
  await none.body?.cancel();
});

t("D5-A03: a revoked token stops authenticating at once", () =>
  withTokens(async (minted) => {
    const tok = await mint(minted, "rev");
    assertEq((await api("GET", "/cards?limit=1", undefined, { key: tok })).status, 200, "live before revoke");
    const r = await core().from("api_token").update({ status: "revoked" }).eq("id", minted[0]);
    assert(!r.error, `revoke: ${r.error?.message}`);
    assert401(await api("GET", "/cards?limit=1", undefined, { key: tok }), "after revoke");
  }));

t("D5-A04: an expired token is 401; an unexpired one with an expiry still works", () =>
  withTokens(async (minted) => {
    const past = await mint(minted, "exp", { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    assert401(await api("GET", "/cards?limit=1", undefined, { key: past }), "expired token");
    const future = await mint(minted, "fut", { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    assertEq((await api("GET", "/cards?limit=1", undefined, { key: future })).status, 200, "unexpired token");
  }));

// ===================================================== card 51: instance binding

t("D5-A05 (card 51): a token valid on ANOTHER instance is 401 here, byte-identical to an unknown token", () =>
  withTokens(async (minted) => {
    const f = await foreignPartner();
    const tok = await mint(minted, "foreign", { partnerId: f.partnerId, instanceId: f.instanceId });
    const foreign = await api("GET", "/cards?limit=1", undefined, { key: tok });
    assert401(foreign, "foreign-instance token");
    const unknown = await api("GET", "/cards?limit=1", undefined, { key: `cass_test_${uid()}` });
    assert401(unknown, "unknown token");
    // no probe surface: holding one key must not reveal which instances it is valid on
    assertEq(sansRequestId(foreign), sansRequestId(unknown), "foreign vs unknown 401 bodies");
    assertEq(foreign.headers.get("content-type"), unknown.headers.get("content-type"), "same content-type");
  }));

t("D5-A06 (card 51): a token bound here whose PARTNER belongs to another instance is 401", () =>
  withTokens(async (minted) => {
    const f = await foreignPartner();
    const tok = await mint(minted, "mismatch", { partnerId: f.partnerId }); // instance = this one
    assert401(await api("GET", "/cards?limit=1", undefined, { key: tok }), "incoherent token/partner");
  }));

t("D5-A07: a suspended partner's tokens stop working without being revoked", () =>
  withTokens(async (minted) => {
    // A run-unique partner on THIS instance, created suspended — never touch
    // the real partner. Left 'offboarded' afterwards (its token rows keep the
    // FK), the same terminal state the origination flow leaves its fixtures in.
    const { instanceId } = await homePartner();
    const pid = `ptnr_ct_${uid()}`;
    const ins = await core().from("partner").insert({
      id: pid, name: `contract suspended-partner fixture ${pid}`, instance_id: instanceId, status: "suspended",
    });
    assert(!ins.error, `partner insert: ${ins.error?.message}`);
    try {
      const tok = await mint(minted, "susp", { partnerId: pid });
      assert401(await api("GET", "/cards?limit=1", undefined, { key: tok }), "suspended partner's live token");
    } finally {
      const off = await core().from("partner").update({ status: "offboarded" }).eq("id", pid);
      if (off.error) console.error(`offboarding ${pid}: ${off.error.message}`);
    }
  }));

// ===================================================== scope: endpoint × tier (403)

t("D5-A08: an exact endpoint grant covers that endpoint only — out-of-scope is 403 insufficient_scope, not 401", () =>
  withTokens(async (minted) => {
    const a = await acct();
    const tok = await mint(minted, "exact", { endpoints: ["GET /accounts/{id}"], tiers: ["read"] });
    assertEq((await api("GET", `/accounts/${a}`, undefined, { key: tok })).status, 200, "granted endpoint");
    assert403(await api("GET", `/accounts/${a}/numbers`, undefined, { key: tok }),
      "a longer path is not covered by an exact grant", "not scoped for");
    assert403(await api("GET", "/cards?limit=1", undefined, { key: tok }), "an unrelated endpoint");
  }));

t("D5-A09: a '/*' prefix grant covers the subtree but stops at the segment boundary", () =>
  withTokens(async (minted) => {
    const a = await acct();
    const tok = await mint(minted, "prefix", { endpoints: ["GET /accounts/*"], tiers: ["read"] });
    assertEq((await api("GET", `/accounts/${a}`, undefined, { key: tok })).status, 200, "GET /accounts/{id}");
    assertEq((await api("GET", `/accounts/${a}/numbers`, undefined, { key: tok })).status, 200,
      "GET /accounts/{id}/numbers");
    assert403(await api("GET", "/accounts?limit=1", undefined, { key: tok }),
      "the bare collection is not inside 'GET /accounts/*'", "not scoped for");

    // /eps/pospay/* must not cover the sibling route /eps/pospay-items —
    // substring matching would silently widen every prefix grant
    const ops = await mint(minted, "prefix_cu", {
      actor: "cu_admin", endpoints: ["POST /eps/pospay/*"], tiers: ["write"],
    });
    // empty body → the handler's own 400; proves the grant let it through
    const inside = await api("POST", `/eps/pospay/pp_${uid()}/decide`, {}, { key: ops });
    assertPastAuth(inside, "POST /eps/pospay/{id}/decide under 'POST /eps/pospay/*'");
    assert403(await api("POST", "/eps/pospay-items", {}, { key: ops }),
      "POST /eps/pospay-items under 'POST /eps/pospay/*'", "not scoped for");
  }));

t("D5-A10: endpoint and tier are BOTH required — a wildcard endpoint list cannot escape the tier list", () =>
  withTokens(async (minted) => {
    const a = await acct();
    const wrongTier = await mint(minted, "wtier", { endpoints: ["GET /accounts/{id}"], tiers: ["write"] });
    assert403(await api("GET", `/accounts/${a}`, undefined, { key: wrongTier }),
      "right endpoint, wrong tier", "tier: read");
    const readAll = await mint(minted, "readall", { endpoints: ["*"], tiers: ["read"] });
    assertEq((await api("GET", `/accounts/${a}`, undefined, { key: readAll })).status, 200, "'*' + read reads");
    const w = await api("POST", "/entities", { type: "person", name: "Never Created", date_of_birth: "1990-01-01" },
      { key: readAll });
    assert403(w, "'*' + read cannot write", "tier: write");
  }));

// ===================================================== actor class (D23 matrix)

t("D5-A11: a partner with '*' on every tier still cannot reach an actor-restricted endpoint", () =>
  withTokens(async (minted) => {
    // POST /sandbox/event-sink is ops-only (the outbox worker's own sink; its
    // handler only acks). /sandbox/simulate is partner-audience by design.
    const p = await mint(minted, "wild");
    assert403(await api("POST", "/sandbox/event-sink", {}, { key: p }), "partner → ops-only", "pynthia_ops");
    assert403(await api("GET", "/governance/obligations", undefined, { key: p }), "partner → CU-only read", "cu_admin");
    const cu = await mint(minted, "wild_cu", { actor: "cu_admin" });
    assertEq((await api("GET", "/governance/obligations", undefined, { key: cu })).status, 200, "cu_admin reads it");
    assert403(await api("POST", "/sandbox/event-sink", {}, { key: cu }), "cu_admin → ops-only", "pynthia_ops");
  }));

t("D5-A12: an ops token reaches the ops-only endpoint", () =>
  withTokens(async (minted) => {
    const ops = await mint(minted, "ops", { actor: "pynthia_ops" });
    const r = await api("POST", "/sandbox/event-sink", {}, { key: ops });
    assertEq(r.status, 200, `pynthia_ops → POST /sandbox/event-sink (${show(r.body)})`);
  }));

t("D5-A13: the demo key is an operations actor (ALLOW_DEMO_KEY on) — it reaches the ops-only endpoint", async () => {
  const r = await api("POST", "/sandbox/event-sink", {});
  assertEq(r.status, 200, `demo key → POST /sandbox/event-sink (${show(r.body)})`);
});

t("D5-T2 (minted partner token): a partner token scoped '*' cannot reach an internal endpoint (404 or 403, with the envelope)", () =>
  withTokens(async (minted) => {
    const p = await mint(minted, "internal");
    const r = await api("POST", "/internal/role-grants", { subject_ref: "x", role_id: "y" }, { key: p });
    assert(r.status === 404 || r.status === 403, `D5-T2: expected 404/403, got ${r.status} ${show(r.body)}`);
    assertErrorShape(r, "D5-T2");
  }));

// ===================================================== evidence provenance

t("D5-A14: evidence written under a cass_test token or the demo key is labelled 'demo'", () =>
  withTokens(async (minted) => {
    // a cash deposit is evidence whose write echoes its own provenance
    const a = await acct();
    const day = new Date().toISOString().slice(0, 10);
    const cu = await mint(minted, "prov_cu", { actor: "cu_admin" });
    for (const [who, key] of [["cass_test token", cu], ["demo key", KEY]] as const) {
      const r = await api("POST", "/cash/transactions",
        { direction: "cash_in", amount_cents: 1_000, business_date: day, account_id: a }, { key });
      assertEq(r.status, 201, `${who}: cash deposit (${show(r.body)})`);
      assertEq(r.body.provenance, "demo", `${who}: manufactured traffic is never production evidence`);
    }
  }));

t("D5-A15: a KYC verification written under a cass_test token or the demo key reads back labelled 'demo'", () =>
  withTokens(async (minted) => {
    const p = await mint(minted, "prov_pt");
    for (const [who, key] of [["cass_test token", p], ["demo key", KEY]] as const) {
      const ent = await api("POST", "/entities", { type: "person", name: "Provenance Probe", date_of_birth: "1990-01-01" },
        { key });
      assertEq(ent.status, 201, `${who}: entity (${show(ent.body)})`);
      const v = await api("POST", `/entities/${ent.body.id}/verifications`, {}, { key });
      assertEq(v.status, 201, `${who}: verification (${show(v.body)})`);
      const list = await api("GET", `/entities/${ent.body.id}/verifications`, undefined, { key });
      assertEq(list.status, 200, `${who}: read back`);
      const row = (list.body.verifications ?? []).find((x: { id: string }) => x.id === v.body.id);
      assert(row, `${who}: the verification is listed`);
      // Regression guard (fixed 2026-10-06): kyc.ts now stamps the verification row with provenanceFor("core", ctx).
      assertEq(row.provenance, "demo", `${who}: verification evidence provenance`);
    }
  }));

// ===================================================== idempotency namespaces (card 45)

t("D5-A16 (card 45): idempotency keys are namespaced per caller — another caller's key is never a replay", () =>
  withTokens(async (minted) => {
    const ent = await mkEntity("D5 Idempotency Namespace Fixture");
    const body = { entity_id: ent, account_type: "checking" };
    const key = `order-42-${uid()}`; // a key two callers plausibly both derive

    // two ops actors: no partner of their own, each its own namespace
    const opsA = await mint(minted, "nsA", { actor: "pynthia_ops" });
    const opsB = await mint(minted, "nsB", { actor: "pynthia_ops" });
    const a = await api("POST", "/accounts", body, { key: opsA, idem: key });
    assertEq(a.status, 201, `A creates (${show(a.body)})`);
    const b = await api("POST", "/accounts", body, { key: opsB, idem: key });
    assertEq(b.status, 201, `B with A's key is fresh, not a replay (${show(b.body)})`);
    assert(b.body.id !== a.body.id, "B never receives A's cached response");
    assert(b.headers.get("idempotent-replayed") !== "true", "B is not marked replayed");

    // a different body under the same key is not a conflict across callers
    const c = await api("POST", "/accounts", { ...body, account_type: "savings" }, { key: opsB, idem: `${key}-x` });
    assertEq(c.status, 201, "sanity: B can open a savings account");
    const bConflict = await api("POST", "/accounts", { ...body, account_type: "savings" }, { key: opsB, idem: key });
    assertEq(bConflict.status, 409, "within B's own namespace the reuse conflicts");
    // B's writes did not overwrite A's stored response
    const aAgain = await api("POST", "/accounts", body, { key: opsA, idem: key });
    assertEq(String(aAgain.body.id), String(a.body.id), "A still replays its own response");
    assertEq(aAgain.headers.get("idempotent-replayed"), "true", "A's replay is marked");
  }));

t("D5-A17 (card 45): two tokens of the SAME partner share one idempotency namespace", () =>
  withTokens(async (minted) => {
    const ent = await mkEntity("D5 Partner Namespace Fixture");
    const body = { entity_id: ent, account_type: "checking" };
    const key = `order-7-${uid()}`;
    const t1 = await mint(minted, "pt1");
    const t2 = await mint(minted, "pt2");
    const first = await api("POST", "/accounts", body, { key: t1, idem: key });
    assertEq(first.status, 201, `first token creates (${show(first.body)})`);
    const second = await api("POST", "/accounts", body, { key: t2, idem: key });
    assertEq(String(second.body.id), String(first.body.id), "the partner's retry on a rotated token replays");
    assertEq(second.headers.get("idempotent-replayed"), "true", "marked replayed");
  }));
