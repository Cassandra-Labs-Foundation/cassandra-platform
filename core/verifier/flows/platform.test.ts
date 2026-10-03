// Platform flows: what a partner relies on underneath every product call.
//
//   * versioning + paging, exercised on the partner's own data: the changelog
//     agrees with the version header, and a cursor walk over /control-results
//     reaches the OFAC evidence the partner just generated, page by page, with
//     no overlap and strictly older rows on every hop;
//   * the event outbox: a write lands an event, the worker (ops-only) delivers
//     it to the aggregator, and identity crosses that boundary only as a hash;
//   * confinement: a token can do exactly what it was granted — one endpoint,
//     one tier, one partner's rows — and nothing after it is revoked.
//
// Ported from core/supabase/tests/e2e/compliance_e2e.sh sections 26
// (platform), 30 (outbox) and 39 (scoped tokens). The pure HTTP-shape halves
// of section 26 (error envelope, X-API-Version format, pagination envelope,
// /sandbox/reset guard, unsimulated rail 501) already live in
// core/verifier/contract/ and are not repeated here.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

// --------------------------------------------------------------- local helpers

let aggClient: SupabaseClient | null = null;
/** service-role read of the aggregator's ingested copy (schema `aggregator`) */
function aggregator() {
  aggClient ??= createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } });
  return aggClient.schema("aggregator");
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function homePartner(): Promise<{ instanceId: string; partnerId: string }> {
  const inst = await core().from("instance").select("id").limit(1).single();
  if (inst.error) throw new Error(`instance lookup: ${inst.error.message}`);
  const p = await core().from("partner").select("id")
    .eq("status", "active").eq("instance_id", inst.data.id).order("id").limit(1).single();
  if (p.error) throw new Error(`partner lookup: ${p.error.message}`);
  return { instanceId: inst.data.id, partnerId: p.data.id };
}

/**
 * Mint a cass_test partner token for THIS instance's partner with an explicit
 * grant. `allowed_endpoints` uses the router's "METHOD /path/{param}" form.
 * The id goes onto `minted`; the flow revokes it in its finally block.
 */
async function mintToken(
  minted: string[],
  label: string,
  grant: { endpoints: string[]; tiers: string[] },
): Promise<string> {
  const { instanceId, partnerId } = await homePartner();
  const rand = [...crypto.getRandomValues(new Uint8Array(20))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const plaintext = `cass_test_${rand}`;
  const id = `tok_test_${label}_${rand.slice(0, 12)}`;
  const ins = await core().from("api_token").insert({
    id, token_hash: await sha256Hex(plaintext), token_prefix: "cass_test",
    actor_type: "partner", roles: [], partner_id: partnerId, instance_id: instanceId,
    allowed_endpoints: grant.endpoints, allowed_tiers: grant.tiers, status: "active",
  });
  if (ins.error) throw new Error(`token insert: ${ins.error.message}`);
  minted.push(id);
  return plaintext;
}

const WILDCARD = { endpoints: ["*"], tiers: ["read", "write", "realtime", "bulk"] };

async function revoke(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const r = await core().from("api_token").update({ status: "revoked" }).in("id", ids.splice(0));
  if (r.error) console.error(`revoking platform tokens: ${r.error.message}`);
}

const show = (b: unknown) => JSON.stringify(b).slice(0, 300);

async function newMember(key: string): Promise<string> {
  const r = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1991-01-01",
  }, { key });
  assertEq(r.status, 201, `entity (${show(r.body)})`);
  return String(r.body.id);
}

// =============================================================================
// 26 — version + paging, on the partner's own evidence
// =============================================================================

flow("platform: a partner pins the API version and pages to its own evidence by cursor", async (t) => {
  const minted: string[] = [];
  try {
    const partner = await mintToken(minted, "plat", WILDCARD);
    const as = { key: partner };
    let verId = "";

    await t.step("the changelog leads with the version every response is stamped with", async () => {
      const r = await api("GET", "/changelog", undefined, as);
      assertEq(r.status, 200, "changelog");
      const header = r.headers.get("x-api-version");
      assert(header, "X-API-Version present");
      assertEq(r.body.data[0].version, header, "newest changelog entry is the running version");
      const dates = r.body.data.map((e: { date: string }) => e.date);
      assert(dates.every((d: string, i: number) => i === 0 || dates[i - 1] >= d), `newest first (${dates})`);
      const err = await api("GET", `/entities/ent_${uid()}`, undefined, as);
      assertEq(err.status, 404, "unknown entity");
      assertEq(err.headers.get("x-api-version"), header, "errors carry the same version");
      assertEq(err.headers.get("x-request-id"), err.body.request_id, "request id header matches the envelope");
    });

    await t.step("the partner screens a member, creating fresh CG-OFAC-01 evidence", async () => {
      const ent = await newMember(partner);
      const r = await api("POST", `/entities/${ent}/verifications`, {}, as);
      assertEq(r.status, 201, `verification (${show(r.body)})`);
      verId = String(r.body.id);
    });

    await t.step("a limit=1 cursor walk reaches that evidence: no overlap, strictly older each hop", async () => {
      const seen = new Set<string>();
      let cursor: string | null = null;
      let lastCreated = "";
      let found = false;
      for (let page = 0; page < 200 && !found; page++) {
        const q = cursor ? `?limit=1&after=${encodeURIComponent(cursor)}` : "?limit=1";
        const r = await api("GET", `/control-results${q}`, undefined, as);
        assertEq(r.status, 200, `page ${page}`);
        assertEq(r.body.data.length, 1, `page ${page} holds exactly one row`);
        const row = r.body.data[0];
        assert(!seen.has(row.id), `page ${page}: ${row.id} repeated`);
        seen.add(row.id);
        if (lastCreated) assert(row.created_at < lastCreated, `page ${page} is strictly older than page ${page - 1}`);
        lastCreated = row.created_at;
        if (row.event === verId && row.control_id === "CG-OFAC-01") found = true;
        assertEq(r.body.pagination.has_more, true, `page ${page}: the institution has older evidence`);
        assertEq(r.body.pagination.next_after, row.created_at, "cursor is the last row's created_at");
        cursor = r.body.pagination.next_after;
      }
      assert(found, `the partner's own CG-OFAC-01 for ${verId} was reached within 200 pages`);
    });

    await t.step("the 5300 heartbeat ties the FBO position to member shares and reports the ingest high-water", async () => {
      const { instanceId } = await homePartner();
      const maxSeq = async () => {
        const r = await aggregator().from("event").select("sequence_id")
          .eq("instance_id", instanceId).order("sequence_id", { ascending: false }).limit(1);
        assert(!r.error, `aggregator read: ${r.error?.message}`);
        return Number(r.data?.[0]?.sequence_id ?? 0);
      };
      const before = await maxSeq();
      const r = await api("GET", "/reports/5300", undefined, as);
      const after = await maxSeq();
      assertEq(r.status, 200, `5300 (${show(r.body)})`);
      assertEq(r.body.instance_id, instanceId, "scoped to this instance");
      assert(typeof r.body.member_share_cents === "number", "member shares reported");
      const position = r.body.current?.fbo_position_cents ?? 0;
      assertEq(r.body.fbo_reconciliation_diff_cents, position - r.body.member_share_cents,
        "diff is position minus member shares, unsmoothed");
      if (r.body.current) {
        const seq = Number(r.body.current.last_seq);
        assert(seq >= before && seq <= after,
          `last_seq ${seq} is the aggregator's ingest high-water (between ${before} and ${after})`);
      }
    });

    await t.step("a malformed cursor is refused by field, not ignored", async () => {
      const r = await api("GET", "/control-results?after=yesterday-ish", undefined, as);
      assertEq(r.status, 400, `bad cursor (${show(r.body)})`);
      assert((r.body.errors ?? []).some((e: { field: string }) => e.field === "after"), "error names 'after'");
    });
  } finally {
    await revoke(minted);
  }
});

// =============================================================================
// 30 — the outbox: an event lands and the worker delivers it
// =============================================================================

flow("platform: an event lands in the outbox and the worker delivers it to the aggregator", async (t) => {
  const minted: string[] = [];
  try {
    const partner = await mintToken(minted, "outbox", WILDCARD);
    let entity = "";
    let eventId = "";

    await t.step("creating a member writes entity.created into the outbox", async () => {
      entity = await newMember(partner);
      const ev = await core().from("event").select("id, code, entity_hash, payload, delivered_at")
        .eq("resource_id", entity).eq("code", "entity.created");
      assertEq((ev.data ?? []).length, 1, "one entity.created for the member");
      eventId = String(ev.data![0].id);
      assertEq(ev.data![0].entity_hash, await sha256Hex(entity), "outbox row carries the entity hash");
    });

    await t.step("a partner cannot drive the worker: the sweep is operations-only", async () => {
      const r = await api("POST", "/events/deliver", {}, { key: partner });
      assertEq(r.status, 403, `partner sweep (${show(r.body)})`);
      assertEq(r.body.type, "insufficient_scope", "typed refusal");
    });

    await t.step("operations sweeps until the event is delivered", async () => {
      // Regression guard (bug found by this flow, fixed 2026-10-03): deploying the aggregator function without `verify_jwt = false` (core/supabase/config.toml has no [functions.aggregator] block) makes the Supabase gateway 401 the outbox's instance-JWT POST to /events/ingest, so every sweep fails and nothing is delivered (stuck since the 22:16Z deploy)
      // The sweep is oldest-first and capped, so a backlog can take a few
      // passes; bounded so a stuck queue fails here rather than hanging.
      let last: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
      let delivered: string | null = null;
      for (let i = 0; i < 10 && !delivered; i++) {
        last = await api("POST", "/events/deliver", {});
        assertEq(last.status, 200, `sweep ${i} (${show(last.body)})`);
        const row = await core().from("event").select("delivered_at").eq("id", eventId).single();
        delivered = row.data?.delivered_at ?? null;
      }
      assert(delivered, `event ${eventId} delivered within 10 sweeps (last sweep: ${show(last.body)})`);
    });

    await t.step("the aggregator holds the event — identity only as a hash, no plaintext name", async () => {
      // Regression guard (bug found by this flow, fixed 2026-10-03): same root cause as the step above — nothing reaches aggregator.event while the gateway 401s the ingest
      const agg = await aggregator().from("event")
        .select("code, resource_id, entity_hash, payload").eq("event_id", eventId);
      assert(!agg.error, `aggregator read: ${agg.error?.message}`);
      assertEq((agg.data ?? []).length, 1, "ingested exactly once");
      const row = agg.data![0];
      assertEq(row.code, "entity.created", "code");
      assertEq(row.resource_id, entity, "resource");
      assertEq(row.entity_hash, await sha256Hex(entity), "identity crosses as entity_hash");
      assert(!("name" in (row.payload ?? {})), `no plaintext name crossed the boundary (${show(row.payload)})`);
    });
  } finally {
    await revoke(minted);
  }
});

// =============================================================================
// 39 — scoped tokens are actually confined
// =============================================================================

flow("platform: a scoped token can do exactly what it was granted, and nothing once revoked", async (t) => {
  const minted: string[] = [];
  try {
    const partner = await mintToken(minted, "scope", WILDCARD);
    const OPENING = 100_000; // $1,000
    let source = "";
    let dest = "";
    let narrow = "";
    let readOnly = "";

    await t.step("the partner opens two funded accounts", async () => {
      for (const which of ["source", "dest"]) {
        const ent = await newMember(partner);
        const r = await api("POST", "/accounts", {
          entity_id: ent, account_type: "checking", opening_deposit_cents: OPENING,
        }, { key: partner });
        assertEq(r.status, 201, `${which} account (${show(r.body)})`);
        if (which === "source") source = String(r.body.id);
        else dest = String(r.body.id);
      }
    });

    await t.step("inside its scope: a one-endpoint read token reads the account", async () => {
      narrow = await mintToken(minted, "narrow", { endpoints: ["GET /accounts/{id}"], tiers: ["read"] });
      const r = await api("GET", `/accounts/${source}`, undefined, { key: narrow });
      assertEq(r.status, 200, `scoped read (${show(r.body)})`);
      assertEq(r.body.balance, OPENING, "it sees the balance");
    });

    await t.step("outside its endpoint list: a transfer is refused as insufficient_scope, no money moves", async () => {
      const r = await api("POST", "/transfers", {
        source_account_id: source, destination_account_id: dest, amount_cents: 1_000,
        description: "flow: should never happen",
      }, { key: narrow });
      assertEq(r.status, 403, `scoped transfer (${show(r.body)})`);
      assertEq(r.body.type, "insufficient_scope", "typed, not a generic denial");
      const [s, d] = await Promise.all([
        api("GET", `/accounts/${source}`, undefined, { key: partner }),
        api("GET", `/accounts/${dest}`, undefined, { key: partner }),
      ]);
      assertEq(s.body.balance, OPENING, "source untouched");
      assertEq(d.body.balance, OPENING, "destination untouched");
      const tr = await core().from("transfer").select("id").eq("source_account_id", source);
      assertEq((tr.data ?? []).length, 0, "no transfer row was written");
    });

    await t.step("a read it was never granted is refused too", async () => {
      for (const path of ["/control-results?limit=1", `/accounts/${source}/numbers`]) {
        const r = await api("GET", path, undefined, { key: narrow });
        assertEq(r.status, 403, `${path} (${show(r.body)})`);
        assertEq(r.body.type, "insufficient_scope", `${path} typed`);
      }
    });

    await t.step("a read-tier token over every endpoint still cannot write", async () => {
      readOnly = await mintToken(minted, "readonly", { endpoints: ["*"], tiers: ["read"] });
      const ok = await api("GET", `/accounts/${source}`, undefined, { key: readOnly });
      assertEq(ok.status, 200, "reads work");
      const before = await core().from("account").select("lock_type").eq("id", source).single();
      const w = await api("POST", `/accounts/${source}/lock`, { lock_type: "compliance", reason: "flow" }, { key: readOnly });
      assertEq(w.status, 403, `write on a read-tier token (${show(w.body)})`);
      assertEq(w.body.type, "insufficient_scope", "typed");
      const after = await core().from("account").select("lock_type").eq("id", source).single();
      assertEq(after.data?.lock_type, before.data?.lock_type, "the lock was not applied");
    });

    await t.step("a partner is confined to its own rows: another partner's account is a 404", async () => {
      const { partnerId } = await homePartner();
      const foreign = await core().from("account").select("id").neq("partner_id", partnerId).limit(1).single();
      assert(!foreign.error && foreign.data, `a foreign-partner account exists to probe (${foreign.error?.message})`);
      const r = await api("GET", `/accounts/${foreign.data!.id}`, undefined, { key: partner });
      assertEq(r.status, 404, `foreign read (${show(r.body)})`);
      assertEq(r.body.type, "not_found", "indistinguishable from a missing id — no enumeration oracle");
      const ops = await api("GET", `/accounts/${foreign.data!.id}`);
      assertEq(ops.status, 200, `operations reads across partners (${show(ops.body)})`);
      const own = await api("GET", `/accounts/${source}`, undefined, { key: partner });
      assertEq(own.status, 200, "and the partner reads its own normally");
    });

    await t.step("idempotency keys are per caller: ops reusing the partner's key is not a replay", async () => {
      // POST /accounts is an idempotent create (entities are not — the claim
      // lives in the money-touching handlers)
      const ent = await newMember(partner);
      const key = `flow-idem-${uid()}`;
      const body = { entity_id: ent, account_type: "checking" };
      const p = await api("POST", "/accounts", body, { key: partner, idem: key });
      assertEq(p.status, 201, `partner open (${show(p.body)})`);
      const replay = await api("POST", "/accounts", body, { key: partner, idem: key });
      assertEq(String(replay.body.id), String(p.body.id), "same caller + same key replays");
      const reused = await api("POST", "/accounts", { ...body, account_type: "savings" }, { key: partner, idem: key });
      assertEq(reused.status, 409, `same caller, same key, new body (${show(reused.body)})`);
      assertEq(reused.body.type, "idempotency_key_reused", "typed");
      const o = await api("POST", "/accounts", body, { idem: key });
      assertEq(o.status, 201, `ops with the partner's key opens its own account (${show(o.body)})`);
      assert(o.body.id !== p.body.id, "a different caller never receives the partner's cached response");
      const rows = await core().from("account").select("id").eq("entity_id", ent);
      assertEq((rows.data ?? []).length, 2, "exactly two accounts exist for the member");
    });

    await t.step("once revoked, the token authenticates as nothing: 401", async () => {
      const narrowId = minted.find((id) => id.startsWith("tok_test_narrow_"))!;
      const r = await core().from("api_token").update({ status: "revoked" }).eq("id", narrowId);
      assert(!r.error, `revoke: ${r.error?.message}`);
      const g = await api("GET", `/accounts/${source}`, undefined, { key: narrow });
      assertEq(g.status, 401, `revoked token (${show(g.body)})`);
      assertEq(g.body.type, "unauthorized", "typed unauthorized");
    });
  } finally {
    await revoke(minted);
  }
});
