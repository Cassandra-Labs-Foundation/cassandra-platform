// Origination flows: how an instance (a partner program's side of the
// cross-fintech layer) authenticates to the aggregator, reads its FBO position,
// and reserves against it before money leaves. Ported from
// core/supabase/tests/e2e/compliance_e2e.sh section 42 (cards 64-67), plus the
// user-observable behaviour of the aggregator unit stubs (see
// ledger/origination.md).
//
// These routes live on the `aggregator` edge function, not `api`, so the flow
// talks to AGGREGATOR_URL with an instance JWT (Bearer), never a partner key.
//
// Corrections against the bash script:
//   * the FBO position is a ROLL-UP of the program's open member balances
//     (migration 20260817000100), so accept no longer debits the position:
//     position_before == position_after, and the captured reserve keeps
//     available down instead. The bash "position moved by exactly the amount"
//     check describes the retired accumulator.
//   * seed_position's account_type 'share' now fails the account-type
//     vocabulary (inst_saga_test reads position 0 on the live core). The
//     fixture here uses 'checking' and a run-unique instance.
//   * the stale-consumer 503 now watches blnk-reconcile, which is shared and
//     must not be aged; the gate itself is exercised at the SQL function with a
//     tight window instead (see the step for why).
//
// Fixtures: each saga run gets its own instance id, credential, partner,
// member and account, so no assertion races other flows moving money on
// inst_local. Teardown closes the account, offboards the partner and deletes
// the credential; origination/reserve rows stay as evidence.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type Any, assert, assertEq, core, flow, uid } from "./helpers.ts";

// --------------------------------------------------------------- local helpers

const AGG = Deno.env.get("AGGREGATOR_URL") ??
  "https://jynsipdvrgqdkeqrlzcv.functions.supabase.co/aggregator";
const JWT_SECRET = Deno.env.get("AGGREGATOR_JWT_SECRET") ?? "";
const HOME_SECRET = Deno.env.get("AGGREGATOR_CLIENT_SECRET") ?? "";
const ADMIN_SECRET = Deno.env.get("CU_ADMIN_SECRET") ?? "";

let aggClient: SupabaseClient | null = null;
/** service-role access to the aggregator schema (evidence reads + fixtures) */
function aggregator() {
  aggClient ??= createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } });
  return aggClient.schema("aggregator");
}

interface AggResponse {
  status: number;
  headers: Headers;
  body: Any;
}

async function agg(method: string, path: string, body?: unknown, bearer?: string): Promise<AggResponse> {
  const headers: Record<string, string> = {};
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${AGG}${path}`, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed: Any = text;
  try {
    parsed = JSON.parse(text);
  } catch { /* raw */ }
  return { status: res.status, headers: res.headers, body: parsed };
}

const show = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);

const randHex = (n: number) =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64json = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

function decodePart(part: string): Any {
  const pad = part.length % 4 === 0 ? "" : "=".repeat(4 - (part.length % 4));
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/") + pad));
}

/** Sign an HS256 JWT over arbitrary header/claims — for forging refusals only. */
async function signJwt(claims: Record<string, unknown>, secret: string, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }): Promise<string> {
  const input = `${b64json(header)}.${b64json(claims)}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

async function exchange(instanceId: string, secret: string): Promise<AggResponse> {
  return await agg("POST", "/auth/token", { instance_id: instanceId, client_secret: secret });
}

async function tokenFor(instanceId: string, secret: string): Promise<string> {
  const r = await exchange(instanceId, secret);
  assertEq(r.status, 200, `token for ${instanceId} (${show(r)})`);
  return String(r.body.access_token);
}

/** A run-unique instance with its own client secret (and, optionally, a funded program). */
interface Program {
  instanceId: string;
  secret: string;
  partnerId?: string;
  accountId?: string;
}

async function newCredential(): Promise<Program> {
  const instanceId = `inst_flow_${uid()}`;
  const secret = `flow_secret_${randHex(24)}`;
  const ins = await aggregator().from("instance_credential").insert({
    instance_id: instanceId, client_secret_hash: await sha256Hex(secret), role: "instance",
  });
  if (ins.error) throw new Error(`credential insert: ${ins.error.message}`);
  return { instanceId, secret };
}

/**
 * A partner program on its own instance with one open member account holding
 * `cents`. The FBO position is the sum of the program's open member balances,
 * so this is the position. No blnk_balance_id: blnk-reconcile's balance sweep
 * only touches mirrored accounts, so nothing outside this flow moves it.
 */
async function newProgram(cents: number): Promise<Program> {
  const p = await newCredential();
  const tag = p.instanceId.slice("inst_flow_".length);
  p.partnerId = `ptnr_flow_${tag}`;
  p.accountId = `acct_flow_${tag}`;
  const entityId = `ent_flow_${tag}`;
  const pr = await core().from("partner").insert({
    id: p.partnerId, name: `origination flow fixture ${tag}`, instance_id: p.instanceId, status: "active",
  });
  if (pr.error) throw new Error(`partner insert: ${pr.error.message}`);
  const en = await core().from("entity").insert({ id: entityId, partner_id: p.partnerId });
  if (en.error) throw new Error(`entity insert: ${en.error.message}`);
  const ac = await core().from("account").insert({
    id: p.accountId, account_type: "checking", balance: cents, status: "open",
    partner_id: p.partnerId, entity_id: entityId, balance_synced_at: new Date().toISOString(),
  });
  if (ac.error) throw new Error(`account insert: ${ac.error.message}`);
  return p;
}

/** Release anything still held, close the program, and kill the credential. */
async function teardown(p: Program | null): Promise<void> {
  if (!p) return;
  const pending = await aggregator().from("origination").select("id")
    .eq("instance_id", p.instanceId).eq("status", "pending");
  for (const o of pending.data ?? []) {
    const r = await aggregator().rpc("reject_origination", { p_id: o.id, p_instance: p.instanceId });
    if (r.error) console.error(`teardown reject ${o.id}: ${r.error.message}`);
  }
  if (p.accountId) {
    const r = await core().from("account").update({ status: "closed" }).eq("id", p.accountId);
    if (r.error) console.error(`teardown account: ${r.error.message}`);
  }
  if (p.partnerId) {
    const r = await core().from("partner").update({ status: "offboarded" }).eq("id", p.partnerId);
    if (r.error) console.error(`teardown partner: ${r.error.message}`);
  }
  const d = await aggregator().from("instance_credential").delete().eq("instance_id", p.instanceId);
  if (d.error) console.error(`teardown credential: ${d.error.message}`);
}

async function rows(table: "origination" | "reserve", instanceId: string): Promise<Any[]> {
  const r = await aggregator().from(table).select("*").eq("instance_id", instanceId).order("created_at");
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data ?? [];
}

async function fbo(jwt: string): Promise<Any> {
  const r = await agg("GET", "/fbo", undefined, jwt);
  assertEq(r.status, 200, `fbo read (${show(r)})`);
  return r.body;
}

function requireSecrets(...names: [string, string][]): void {
  for (const [name, v] of names) assert(v.length > 0, `${name} must be set (.env.local) for origination flows`);
}

// =============================================================================
// card 64 — /auth/token: a client secret buys a 300s JWT, and nothing else does
// =============================================================================

flow("origination: an instance exchanges its client secret for a 300s token; forged, expired and dead credentials buy nothing", async (t) => {
  requireSecrets(["AGGREGATOR_JWT_SECRET", JWT_SECRET], ["CU_ADMIN_SECRET", ADMIN_SECRET]);
  let prog: Program | null = null;
  try {
    prog = await newCredential();
    const p = prog;
    let jwt = "";

    await t.step("a valid client secret buys a Bearer token that expires in 300s", async () => {
      const before = Math.floor(Date.now() / 1000);
      const r = await exchange(p.instanceId, p.secret);
      assertEq(r.status, 200, `exchange (${show(r)})`);
      assertEq(r.body.token_type, "Bearer", "token_type");
      assertEq(r.body.expires_in, 300, "expires_in");
      assertEq(r.body.instance_id, p.instanceId, "issued for the instance that asked");
      assertEq(r.body.role, "instance", "an instance credential mints the instance role");
      jwt = String(r.body.access_token);
      const parts = jwt.split(".");
      assertEq(parts.length, 3, "a JWT comes back");
      assertEq(decodePart(parts[0]).alg, "HS256", "signed HS256");
      const claims = decodePart(parts[1]);
      assertEq(claims.instance_id, p.instanceId, "the instance is in the signed claims, not the request");
      assertEq(claims.exp - claims.iat, 300, "lifetime is exactly 300s");
      assert(Math.abs(claims.iat - before) < 60, `iat ${claims.iat} is now (${before})`);
      assert(!jwt.includes(p.secret), "the long-lived secret never rides inside the token");
    });

    await t.step("the token reads its own instance's FBO", async () => {
      const r = await agg("GET", "/fbo", undefined, jwt);
      assertEq(r.status, 200, `fbo (${show(r)})`);
      assertEq(r.body.instance_id, p.instanceId, "scoped to the token's instance");
      assertEq(r.body.position_cents, 0, "a credential with no program holds no position");
    });

    await t.step("a wrong secret and an unknown instance are the SAME 401; a missing field is a 400", async () => {
      const wrong = await exchange(p.instanceId, `${p.secret}x`);
      const ghost = await exchange(`inst_ghost_${uid()}`, p.secret);
      assertEq(wrong.status, 401, `wrong secret (${show(wrong)})`);
      assertEq(ghost.status, 401, `unknown instance (${show(ghost)})`);
      assertEq(wrong.body.type, ghost.body.type, "same type");
      assertEq(wrong.body.detail, ghost.body.detail, "indistinguishable — no instance-id oracle");
      assert(!("access_token" in wrong.body), "no token on a refusal");
      for (const bad of [{ instance_id: p.instanceId }, { client_secret: p.secret }, {}]) {
        const r = await agg("POST", "/auth/token", bad);
        assertEq(r.status, 400, `missing field ${JSON.stringify(bad)} (${show(r)})`);
        assertEq(r.body.type, "validation_error", "typed");
      }
    });

    await t.step("forged and expired tokens are refused at the door", async () => {
      const now = Math.floor(Date.now() / 1000);
      const good = { instance_id: p.instanceId, iat: now, exp: now + 300, role: "instance" };
      const [h, , s] = jwt.split(".");
      const forged: [string, string][] = [
        ["expired (validly signed, exp an hour ago)", await signJwt({ ...good, iat: now - 7200, exp: now - 3600 }, JWT_SECRET)],
        ["signed with the wrong secret", await signJwt(good, `attacker_${randHex(8)}`)],
        ["payload swapped to another instance under the real signature", `${h}.${b64json({ ...decodePart(jwt.split(".")[1]), instance_id: "inst_local" })}.${s}`],
        ['alg:"none"', `${b64json({ alg: "none", typ: "JWT" })}.${b64json(good)}.`],
        ["lifetime over the one-hour cap", await signJwt({ ...good, exp: now + 86_400 }, JWT_SECRET)],
        ["no expiry at all", await signJwt({ instance_id: p.instanceId, iat: now }, JWT_SECRET)],
        ["issued a day in the future", await signJwt({ ...good, iat: now + 86_400, exp: now + 86_400 + 300 }, JWT_SECRET)],
        ["not a JWT", "a.b"],
      ];
      for (const [label, tok] of forged) {
        const r = await agg("GET", "/fbo", undefined, tok);
        assertEq(r.status, 401, `${label} (${show(r)})`);
        assertEq(r.body.type, "unauthorized", `${label}: typed`);
        assert(!("position_cents" in r.body), `${label}: no FBO data leaked`);
      }
      const none = await agg("GET", "/fbo");
      assertEq(none.status, 401, `no credential (${show(none)})`);
    });

    await t.step("the cu_admin credential mints a read-only token: it cannot originate", async () => {
      const r = await exchange("cu_admin_main", ADMIN_SECRET);
      assertEq(r.status, 200, `admin exchange (${show(r)})`);
      assertEq(r.body.role, "cu_admin", "role comes from the credential row");
      assertEq(decodePart(String(r.body.access_token).split(".")[1]).role, "cu_admin", "and is signed into the token");
      const before = (await rows("origination", "cu_admin_main")).length;
      const o = await agg("POST", "/originations", { amount_cents: 100 }, String(r.body.access_token));
      assertEq(o.status, 403, `admin originate (${show(o)})`);
      assertEq(o.body.type, "admin_read_only", "refused by credential class");
      assertEq((await rows("origination", "cu_admin_main")).length, before, "no origination row written");
    });

    await t.step("once the credential is removed, its secret buys nothing — same 401 as a stranger", async () => {
      const d = await aggregator().from("instance_credential").delete().eq("instance_id", p.instanceId);
      assert(!d.error, `credential delete: ${d.error?.message}`);
      const r = await exchange(p.instanceId, p.secret);
      assertEq(r.status, 401, `dead credential (${show(r)})`);
      const ghost = await exchange(`inst_ghost_${uid()}`, p.secret);
      assertEq(r.body.detail, ghost.body.detail, "indistinguishable from an instance that never existed");
      // The JWT minted above stays valid until its exp (<= 300s): instance JWTs
      // are stateless by design (card 64 trades revocation for a 5-minute life).
    });
  } finally {
    await teardown(prog);
  }
});

// =============================================================================
// card 65 — the live program's FBO read
// =============================================================================

flow("origination: the live program's FBO read is the token's instance, internally consistent", async (t) => {
  requireSecrets(["AGGREGATOR_CLIENT_SECRET", HOME_SECRET]);
  const inst = await core().from("instance").select("id").limit(1).single();
  assert(!inst.error, `instance lookup: ${inst.error?.message}`);
  const home = String(inst.data!.id);
  let jwt = "";

  await t.step("the home instance's secret buys a token for the home instance", async () => {
    jwt = await tokenFor(home, HOME_SECRET);
    assertEq(decodePart(jwt.split(".")[1]).instance_id, home, "claims");
  });

  await t.step("FBO read carries position, reserved, available and mirror staleness; available = position - reserved", async () => {
    const f = await fbo(jwt);
    assertEq(f.instance_id, home, "the token's instance");
    for (const k of ["position_cents", "available_balance_cents", "reserved_cents", "mirror"]) {
      assert(k in f, `FBO read carries ${k} (${JSON.stringify(f).slice(0, 300)})`);
    }
    assertEq(f.available_balance_cents, f.position_cents - f.reserved_cents, "available = position - reserved, to the cent");
    assert(f.position_cents > 0, "the live program holds member shares");
    const res = await aggregator().from("reserve").select("amount_cents, status").eq("instance_id", home)
      .in("status", ["held", "captured"]);
    assert(!res.error, `reserve read: ${res.error?.message}`);
    const sum = (res.data ?? []).reduce((a: number, r: Any) => a + Number(r.amount_cents), 0);
    assertEq(f.reserved_cents, sum, "reserved is exactly the held + captured reserves on file");
    assertEq(f.mirror.instance_id, home, "mirror block is for the same instance");
    assert(f.mirror.accounts > 0, "the mirror counts the program's open accounts");
  });

  await t.step("there is no way to name another instance: query params are ignored, path params are 404", async () => {
    const q = await agg("GET", "/fbo?instance_id=inst_drill", undefined, jwt);
    assertEq(q.status, 200, `query param (${show(q)})`);
    assertEq(q.body.instance_id, home, "still the token's instance");
    const p = await agg("GET", "/fbo/inst_drill", undefined, jwt);
    assertEq(p.status, 404, `path param (${show(p)})`);
    assert(!("position_cents" in p.body), "no foreign position leaked");
  });
});

// =============================================================================
// cards 66/67 — the reserve saga, on a dedicated program
// =============================================================================

flow("origination: reserve, accept and reject on a dedicated program; refusals leave nothing half-applied", async (t) => {
  requireSecrets(["AGGREGATOR_CLIENT_SECRET", HOME_SECRET]);
  const POSITION = 100_000; // $1,000 of member shares
  let prog: Program | null = null;
  try {
    prog = await newProgram(POSITION);
    const p = prog;
    let jwt = "";
    let o1 = "";
    let r1 = "";

    await t.step("the program's FBO starts as its member balance, nothing reserved", async () => {
      jwt = await tokenFor(p.instanceId, p.secret);
      const f = await fbo(jwt);
      assertEq(f.position_cents, POSITION, "position is the sum of open member balances");
      assertEq(f.reserved_cents, 0, "nothing reserved");
      assertEq(f.available_balance_cents, POSITION, "all of it available");
      assertEq(f.mirror.accounts, 1, "one account under the roll-up");
      assertEq(f.mirror.never_synced, 0, "and its balance is mirrored");
    });

    await t.step("malformed amounts are refused before anything is reserved", async () => {
      for (const amount of [0, -500, 12.5, "1000", null]) {
        const r = await agg("POST", "/originations", { amount_cents: amount }, jwt);
        assertEq(r.status, 400, `amount ${JSON.stringify(amount)} (${show(r)})`);
        assertEq(r.body.type, "validation_error", "typed");
      }
      const nonJson = await fetch(`${AGG}/originations`, {
        method: "POST", headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }, body: "{",
      });
      assertEq(nonJson.status, 400, "a non-JSON body");
      await nonJson.body?.cancel();
      assertEq((await rows("origination", p.instanceId)).length, 0, "no origination row");
      assertEq((await rows("reserve", p.instanceId)).length, 0, "no reserve row");
    });

    await t.step("a clean origination reserves and returns pending — origination and hold land together", async () => {
      const r = await agg("POST", "/originations", { amount_cents: 30_000 }, jwt);
      assertEq(r.status, 201, `originate (${show(r)})`);
      assertEq(r.body.status, "pending", "pending");
      assertEq(r.body.amount_cents, 30_000, "amount echoed");
      assertEq(r.body.instance_id, p.instanceId, "for the token's instance");
      o1 = String(r.body.origination_id);
      r1 = String(r.body.reserve_id);
      const org = await rows("origination", p.instanceId);
      const rsv = await rows("reserve", p.instanceId);
      assertEq(org.length, 1, "one origination");
      assertEq(org[0].id, o1, "the one returned");
      assertEq(org[0].status, "pending", "pending in the db");
      assertEq(rsv.length, 1, "one reserve");
      assertEq(rsv[0].id, r1, "the one returned");
      assertEq(rsv[0].origination_id, o1, "bound to the origination");
      assertEq(rsv[0].status, "held", "held, not captured");
      assertEq(Number(rsv[0].amount_cents), 30_000, "for the full amount");
    });

    await t.step("the reserve is held, not spent: position intact, available down by the hold", async () => {
      const f = await fbo(jwt);
      assertEq(f.position_cents, POSITION, "position untouched");
      assertEq(f.reserved_cents, 30_000, "the hold is visible");
      assertEq(f.available_balance_cents, POSITION - 30_000, "available down by exactly the hold");
    });

    await t.step("an origination larger than AVAILABLE (though under position) is refused 409 and writes nothing", async () => {
      const r = await agg("POST", "/originations", { amount_cents: 80_000 }, jwt);
      assertEq(r.status, 409, `oversized (${show(r)})`);
      assertEq(r.body.type, "insufficient_available", "typed");
      assert(String(r.body.detail).includes("70000"), `detail names the available figure (${r.body.detail})`);
      assertEq((await rows("origination", p.instanceId)).length, 1, "no second origination");
      assertEq((await rows("reserve", p.instanceId)).length, 1, "no second reserve");
      const f = await fbo(jwt);
      assertEq(f.available_balance_cents, POSITION - 30_000, "available unchanged by the refusal");
    });

    await t.step("exactly the available amount can be reserved, and rejecting it gives every cent back", async () => {
      const r = await agg("POST", "/originations", { amount_cents: 70_000 }, jwt);
      assertEq(r.status, 201, `exact-available origination (${show(r)})`);
      assertEq((await fbo(jwt)).available_balance_cents, 0, "available is now exactly zero");
      const one = await agg("POST", "/originations", { amount_cents: 1 }, jwt);
      assertEq(one.status, 409, `one more cent (${show(one)})`);
      const rej = await agg("POST", `/originations/${r.body.origination_id}/reject`, undefined, jwt);
      assertEq(rej.status, 200, `reject (${show(rej)})`);
      assertEq(rej.body.status, "rejected", "rejected");
      const rsv = await aggregator().from("reserve").select("status").eq("origination_id", r.body.origination_id).single();
      assertEq(rsv.data?.status, "released", "its hold is released");
      assertEq((await fbo(jwt)).available_balance_cents, POSITION - 30_000, "available restored to the cent");
    });

    await t.step("another instance cannot resolve this program's origination", async () => {
      const foreign = await tokenFor("inst_local", HOME_SECRET);
      for (const verb of ["accept", "reject"]) {
        const r = await agg("POST", `/originations/${o1}/${verb}`, undefined, foreign);
        // Regression guard (bug found by this flow, fixed 2026-10-03): aggregator/handler.ts:296-300 passes only the path id to accept_/reject_origination, which never check the caller's instance — any instance JWT can resolve another program's origination (D23)
        assertEq(r.status, 404, `inst_local ${verb}s ${p.instanceId}'s origination (${show(r)})`);
      }
      const org = await aggregator().from("origination").select("status").eq("id", o1).single();
      assertEq(org.data?.status, "pending", "still pending — the owner decides");
      const rsv = await aggregator().from("reserve").select("status").eq("id", r1).single();
      assertEq(rsv.data?.status, "held", "hold untouched");
    });

    await t.step("accept captures the hold; under the roll-up the position does not move, available stays down", async () => {
      // an earlier step can (wrongly) resolve o1 from another instance; make a
      // fresh origination so this step proves accept on its own terms
      const st = await aggregator().from("origination").select("status").eq("id", o1).single();
      if (st.data?.status !== "pending") {
        const r = await agg("POST", "/originations", { amount_cents: 30_000 }, jwt);
        assertEq(r.status, 201, `re-originate (${show(r)})`);
        o1 = String(r.body.origination_id);
        r1 = String(r.body.reserve_id);
      }
      const before = await fbo(jwt);
      const r = await agg("POST", `/originations/${o1}/accept`, undefined, jwt);
      assertEq(r.status, 200, `accept (${show(r)})`);
      assertEq(r.body.status, "accepted", "accepted");
      assertEq(r.body.origination_id, o1, "the one asked for");
      assertEq(r.body.position_before_cents, POSITION, "position before");
      assertEq(r.body.position_after_cents, POSITION, "capturing a reserve moves no member balance, so no position");
      const org = await aggregator().from("origination").select("status").eq("id", o1).single();
      assertEq(org.data?.status, "accepted", "origination accepted in the db");
      const rsv = await aggregator().from("reserve").select("status").eq("id", r1).single();
      assertEq(rsv.data?.status, "captured", "reserve captured in the db");
      const after = await fbo(jwt);
      assertEq(after.position_cents, POSITION, "position intact");
      assertEq(after.available_balance_cents, before.available_balance_cents,
        "available unchanged by accept — the captured reserve still counts against it");
      assertEq(after.reserved_cents, before.reserved_cents, "reserved = held + captured, unchanged");
    });

    await t.step("a resolved origination cannot be resolved again, either way, and nothing changes", async () => {
      for (const verb of ["reject", "accept"]) {
        const r = await agg("POST", `/originations/${o1}/${verb}`, undefined, jwt);
        assertEq(r.status, 409, `${verb} after accept (${show(r)})`);
        assertEq(r.body.type, "conflict", "typed");
        assert(String(r.body.detail).includes("accepted"), `says why (${r.body.detail})`);
      }
      const rsv = await aggregator().from("reserve").select("status").eq("id", r1).single();
      assertEq(rsv.data?.status, "captured", "still captured, not released by the late reject");
      const unknown = await agg("POST", `/originations/org_${randHex(16)}/accept`, undefined, jwt);
      assertEq(unknown.status, 404, `unknown origination (${show(unknown)})`);
      assertEq(unknown.body.type, "not_found", "typed");
    });

    await t.step("reject nets to zero: position untouched, hold released, no residual holds", async () => {
      const before = await fbo(jwt);
      const o = await agg("POST", "/originations", { amount_cents: 10_000 }, jwt);
      assertEq(o.status, 201, `originate (${show(o)})`);
      assertEq((await fbo(jwt)).available_balance_cents, before.available_balance_cents - 10_000, "held while pending");
      const r = await agg("POST", `/originations/${o.body.origination_id}/reject`, undefined, jwt);
      assertEq(r.status, 200, `reject (${show(r)})`);
      const after = await fbo(jwt);
      assertEq(after.position_cents, POSITION, "position untouched");
      assertEq(after.available_balance_cents, before.available_balance_cents, "available back where it was");
      const held = (await rows("reserve", p.instanceId)).filter((x) => x.status === "held");
      assertEq(held.length, 0, "no residual holds on the program");
      const again = await agg("POST", `/originations/${o.body.origination_id}/accept`, undefined, jwt);
      assertEq(again.status, 409, `accept after reject (${show(again)})`);
    });

    await t.step("the staleness gate refuses to reserve against an unmaintained mirror, and writes nothing", async () => {
      // The HTTP 503 + Retry-After path needs blnk-reconcile to be >600s
      // stale, which would mean ageing a shared row every other flow depends
      // on. The gate is the SQL function `originate`; drive it with a window
      // tighter than the reconciler's real age so it trips for this call only.
      const sync = await core().from("blnk_sync_state").select("last_synced_at").eq("resource", "reconcile").single();
      assert(!sync.error && sync.data?.last_synced_at, `reconcile sync state (${sync.error?.message})`);
      const ageSecs = (Date.now() - Date.parse(sync.data!.last_synced_at)) / 1000;
      assert(ageSecs < 600, `blnk-reconcile ran ${Math.round(ageSecs)}s ago — the live gate is open (the HTTP originations above prove it)`);
      if (ageSecs < 10) await new Promise((r) => setTimeout(r, 10_000));
      const before = (await rows("origination", p.instanceId)).length;
      const g = await aggregator().rpc("originate", { p_instance: p.instanceId, p_amount: 100, p_stale_after_secs: 1 });
      assert(!g.error, `originate rpc: ${g.error?.message}`);
      assertEq(g.data?.error, "consumer_stale", `gate trips (${JSON.stringify(g.data)})`);
      assertEq(g.data?.retry_after_secs, 1, "and says when to retry");
      assert(String(g.data?.detail).includes("blnk-reconcile"), "names the maintainer it watches");
      assertEq((await rows("origination", p.instanceId)).length, before, "no origination row");
    });
  } finally {
    await teardown(prog);
  }
});
