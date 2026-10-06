// Aggregator flows: the cross-fintech layer seen from an instance that reports
// into it. An instance pushes its outbox to /events/ingest with a short-lived
// instance JWT; the aggregator keeps an append-only log, the BSA approver
// consumer turns money events into CTR and structuring alerts, and /health
// reports the consumers' lag and writes an alarm when one stalls. Partner keys
// never work here (card 51).
//
// Ported from core/supabase/tests/e2e/compliance_e2e.sh sections 40 (ingest,
// approver, health, card 51) and 41 (analytics tail), plus the
// user-observable behaviour of the aggregator unit stubs not already covered
// by origination.test.ts (see ledger/aggregator-auth.md and
// ledger/aggregator-handler.md).
//
// Fixtures: every flow that writes at the aggregator does it as a run-unique
// instance (`inst_flow_agg_*`) with its own client secret, deleted in a
// finally. aggregator.event is append-only by design, so the events a run
// ingests stay as evidence under that run-unique instance id. Nothing here
// touches inst_local's rows, the shared bsa_approver cursor (other than
// running the consumer the way the cron does), or the cron.
//
// Corrections against the bash script:
//   * card 61: bash rewound the SHARED bsa_approver cursor and aged it an hour
//     to fake a stall. Here a run-unique probe cursor is inserted already
//     stalled, /health is asked, and the probe and its alarm are removed after.
//   * cards 56/57 (payment_hub cursor, exactly-once apply) are retired with the
//     accumulator; the position is a VIEW and is asserted as one.
//   * section 41 (archive, spanning query, reporters) runs from
//     analytics/*.sh with a local DuckDB CLI and Parquet files. The flow runner
//     has no --allow-run/--allow-read and must not advance the shared archive
//     watermark, so those scripts are not driven here. What IS live is the
//     evidence their daily schedule leaves in Postgres, and that is asserted.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type Any, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

// --------------------------------------------------------------- local helpers

const AGG = Deno.env.get("AGGREGATOR_URL") ??
  "https://jynsipdvrgqdkeqrlzcv.functions.supabase.co/aggregator";
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

async function agg(
  method: string,
  path: string,
  opts: { body?: unknown; bearer?: string; headers?: Record<string, string> } = {},
): Promise<AggResponse> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${AGG}${path}`, {
    method, headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed: Any = text;
  try {
    parsed = JSON.parse(text);
  } catch { /* raw */ }
  // The aggregator's gateway JWT check must stay off (verify_jwt = false): a
  // gateway 401 never reaches handler.ts, and every ingest would fail.
  const sb = res.headers.get("sb-error-code");
  assert(sb !== "UNAUTHORIZED_NO_AUTH_HEADER" && sb !== "UNAUTHORIZED_INVALID_JWT_FORMAT",
    `GATEWAY refused ${method} ${path} (sb-error-code ${sb}) — aggregator verify_jwt is on`);
  return { status: res.status, headers: res.headers, body: parsed };
}

const show = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const randHex = (n: number) =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Instance {
  instanceId: string;
  secret: string;
  jwt: string;
}

/** A run-unique instance credential, exchanged for a live instance JWT. */
async function newInstance(): Promise<Instance> {
  const instanceId = `inst_flow_agg_${uid()}`;
  const secret = `flow_secret_${randHex(24)}`;
  const ins = await aggregator().from("instance_credential").insert({
    instance_id: instanceId, client_secret_hash: await sha256Hex(secret), role: "instance",
  });
  if (ins.error) throw new Error(`credential insert: ${ins.error.message}`);
  const r = await agg("POST", "/auth/token", { body: { instance_id: instanceId, client_secret: secret } });
  if (r.status !== 200) throw new Error(`token exchange ${r.status}: ${show(r)}`);
  return { instanceId, secret, jwt: String(r.body.access_token) };
}

async function dropInstance(i: Instance | null): Promise<void> {
  if (!i) return;
  const d = await aggregator().from("instance_credential").delete().eq("instance_id", i.instanceId);
  if (d.error) console.error(`teardown credential ${i.instanceId}: ${d.error.message}`);
}

async function eventRows(eventIds: string[]): Promise<Any[]> {
  const r = await aggregator().from("event").select("*").in("event_id", eventIds).order("sequence_id");
  assert(!r.error, `aggregator.event read: ${r.error?.message}`);
  return r.data ?? [];
}

async function countForInstance(instanceId: string): Promise<number> {
  const r = await aggregator().from("event").select("event_id", { count: "exact", head: true })
    .eq("instance_id", instanceId);
  assert(!r.error, `aggregator.event count: ${r.error?.message}`);
  return r.count ?? 0;
}

async function alertsFor(eventId: string, type: string): Promise<Any[]> {
  const r = await aggregator().from("alert").select("*").eq("event_id", eventId).eq("alert_type", type);
  assert(!r.error, `aggregator.alert read: ${r.error?.message}`);
  return r.data ?? [];
}

/**
 * Drive the BSA approver through the aggregator's operator route until `done`
 * holds. The consumer is global and the cron also runs it every minute with a
 * 200-row batch, so a backlog (or the cron holding the cursor lock) can take a
 * few passes; bounded so a stuck consumer fails here rather than hanging.
 */
async function runApproverUntil(jwt: string, done: () => Promise<boolean>, label: string): Promise<void> {
  let last: AggResponse | null = null;
  for (let i = 0; i < 12; i++) {
    last = await agg("POST", "/consumers/bsa_approver/run", { bearer: jwt });
    assertEq(last.status, 200, `approver run ${i} (${show(last)})`);
    if (await done()) return;
    await sleep(5_000);
  }
  throw new Error(`${label}: not reached within 12 approver runs (last: ${last ? show(last) : "none"})`);
}

/** sweep the outbox (operations) until every listed core.event is delivered */
async function deliver(eventIds: string[]): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const s = await api("POST", "/events/deliver", {});
    assertEq(s.status, 200, `sweep ${i} (${show(s)})`);
    const r = await core().from("event").select("id, delivered_at").in("id", eventIds);
    assert(!r.error, `outbox read: ${r.error?.message}`);
    if ((r.data ?? []).length === eventIds.length && r.data!.every((e: Any) => e.delivered_at)) return;
    await sleep(3_000);
  }
  throw new Error(`events ${eventIds.join(",")} not delivered within 12 sweeps`);
}

// =============================================================================
// card 51 — a partner key is the wrong CLASS of credential at the aggregator
// =============================================================================

flow("aggregator: a partner key is refused at the aggregator by credential class, and a foreign instance's token is refused at the api", async (t) => {
  let foreignTokenId = "";
  try {
    await t.step("a partner token as Bearer is a 403 that names itself, and nothing is ingested", async () => {
      const evId = `evt_flow_agg_pt_${uid()}`;
      const r = await agg("POST", "/events/ingest", {
        bearer: `cass_pt_${randHex(20)}`,
        body: { events: [{ id: evId, code: "transfer.settled" }] },
      });
      assertEq(r.status, 403, `partner bearer (${show(r)})`);
      assertEq(r.body.type, "partner_token_not_valid_here", "named refusal");
      assert(String(r.body.detail).includes("never accepted at the aggregator"), `explains itself (${r.body.detail})`);
      assert(r.body.request_id, "carries a request id");
      assertEq((await eventRows([evId])).length, 0, "nothing ingested");
    });

    await t.step("the same partner token in X-Api-Key is refused the same way", async () => {
      const evId = `evt_flow_agg_pt_${uid()}`;
      const r = await agg("POST", "/events/ingest", {
        headers: { "X-Api-Key": `cass_pt_${randHex(20)}` },
        body: { events: [{ id: evId, code: "transfer.settled" }] },
      });
      assertEq(r.status, 403, `partner X-Api-Key (${show(r)})`);
      assertEq(r.body.type, "partner_token_not_valid_here", "named refusal");
      assertEq((await eventRows([evId])).length, 0, "nothing ingested");
    });

    await t.step("the live demo partner key gets nothing at the aggregator either", async () => {
      // DEMO_API_KEY works at the api; here it is just not an instance JWT
      const key = Deno.env.get("DEMO_API_KEY") ?? "";
      const r = await agg("GET", "/health", { headers: { "X-Api-Key": key } });
      assert(r.status === 401 || r.status === 403, `demo key at /health (${r.status} ${show(r)})`);
      assert(!("consumers" in (r.body ?? {})), "no health data leaked");
    });

    await t.step("no credential at all is a 401", async () => {
      const r = await agg("POST", "/events/ingest", { body: { events: [{ id: `evt_${uid()}` }] } });
      assertEq(r.status, 401, `no credential (${show(r)})`);
      assertEq(r.body.type, "unauthorized", "typed");
    });

    await t.step("a valid api token bound to ANOTHER instance is a 401 at the api, indistinguishable from unknown", async () => {
      const plaintext = `cass_test_${randHex(20)}`;
      foreignTokenId = `tok_test_aggforeign_${randHex(6)}`;
      const ins = await core().from("api_token").insert({
        id: foreignTokenId, token_hash: await sha256Hex(plaintext), token_prefix: "cass_test",
        actor_type: "pynthia_ops", roles: [], partner_id: null, instance_id: `inst_flow_elsewhere_${uid()}`,
        allowed_endpoints: ["*"], allowed_tiers: ["read", "write", "realtime", "bulk"], status: "active",
      });
      assert(!ins.error, `foreign token insert: ${ins.error?.message}`);
      const foreign = await api("GET", "/changelog", undefined, { key: plaintext });
      const unknown = await api("GET", "/changelog", undefined, { key: `cass_test_${randHex(20)}` });
      assertEq(foreign.status, 401, `foreign-instance token (${show(foreign)})`);
      assertEq(unknown.status, 401, `unknown token (${show(unknown)})`);
      assertEq(foreign.body.type, unknown.body.type, "same type");
      assertEq(foreign.body.detail, unknown.body.detail, "same detail — no oracle for which instances exist");
    });
  } finally {
    if (foreignTokenId) {
      const r = await core().from("api_token").update({ status: "revoked" }).eq("id", foreignTokenId);
      if (r.error) console.error(`revoking ${foreignTokenId}: ${r.error.message}`);
    }
  }
});

// =============================================================================
// card 55 — direct ingest: attribution, schema_version, dedup, PII, append-only
// =============================================================================

flow("aggregator: an instance ingests its events — attributed from the token, deduped, PII refused, append-only", async (t) => {
  let inst: Instance | null = null;
  try {
    inst = await newInstance();
    const me = inst;
    const tag = randHex(6);
    const e1 = `evt_flow_agg_${tag}_1`;
    const e2 = `evt_flow_agg_${tag}_2`;
    const hash = await sha256Hex(`flow-agg-member-${tag}`);

    await t.step("a batch lands: instance_id from the TOKEN (never the body), schema_version defaulted or kept", async () => {
      const r = await agg("POST", "/events/ingest", {
        bearer: me.jwt,
        body: {
          events: [
            { id: e1, code: "entity.created", resource_id: `flowtest:${tag}`, entity_hash: hash, instance_id: "inst_local" },
            { id: e2, code: "account.opened", resource_id: `flowtest:${tag}`, entity_hash: hash, schema_version: 2, payload: { account_type: "checking" } },
          ],
        },
      });
      assertEq(r.status, 200, `ingest (${show(r)})`);
      assertEq(r.body.ingested, 2, "both counted");
      assertEq(r.body.instance_id, me.instanceId, "the token's instance answers");
      const rows = await eventRows([e1, e2]);
      assertEq(rows.length, 2, "both stored");
      for (const row of rows) {
        assertEq(row.instance_id, me.instanceId, `${row.event_id}: attributed to the token's instance, not the body's inst_local`);
        assertEq(row.entity_hash, hash, `${row.event_id}: entity_hash kept`);
        assertEq(row.resource_id, `flowtest:${tag}`, `${row.event_id}: resource kept`);
      }
      assertEq(rows[0].schema_version, 1, "schema_version defaults to 1");
      assertEq(rows[1].schema_version, 2, "an explicit schema_version is kept");
      assertEq(rows[1].payload.account_type, "checking", "payload stored");
      assert(rows[1].sequence_id > rows[0].sequence_id, "global sequence orders the batch");
    });

    await t.step("redelivery dedups by event_id: still exactly one row, the original untouched", async () => {
      const r = await agg("POST", "/events/ingest", {
        bearer: me.jwt,
        body: { events: [{ id: e2, code: "account.opened", payload: { account_type: "TAMPERED" } }] },
      });
      assertEq(r.status, 200, `redelivery is a no-op, not an error (${show(r)})`);
      const rows = await eventRows([e2]);
      assertEq(rows.length, 1, "exactly one row");
      assertEq(rows[0].payload.account_type, "checking", "the first delivery wins; a replay cannot rewrite it");
      assertEq(await countForInstance(me.instanceId), 2, "the instance holds exactly two events");
    });

    await t.step("malformed batches are refused 400 and store nothing", async () => {
      const bad: [string, unknown][] = [
        ["no events key", {}],
        ["empty events", { events: [] }],
        ["events not an array", { events: "nope" }],
        ["an event with no id", { events: [{ code: "transfer.settled" }] }],
      ];
      for (const [label, body] of bad) {
        const r = await agg("POST", "/events/ingest", { bearer: me.jwt, body });
        assertEq(r.status, 400, `${label} (${show(r)})`);
        assertEq(r.body.type, "validation_error", `${label}: typed`);
      }
      const nonJson = await fetch(`${AGG}/events/ingest`, {
        method: "POST", headers: { Authorization: `Bearer ${me.jwt}`, "Content-Type": "application/json" }, body: "{",
      });
      assertEq(nonJson.status, 400, "a non-JSON body");
      await nonJson.body?.cancel();
      assertEq(await countForInstance(me.instanceId), 2, "nothing new stored");
    });

    await t.step("raw PII in any payload refuses the WHOLE batch with a named 400 — identity crosses only as a hash", async () => {
      const clean = `evt_flow_agg_${tag}_clean`;
      const leaky = `evt_flow_agg_${tag}_pii`;
      const r = await agg("POST", "/events/ingest", {
        bearer: me.jwt,
        body: {
          events: [
            { id: clean, code: "entity.updated", entity_hash: hash, payload: { status: "active" } },
            { id: leaky, code: "entity.created", payload: { name: personaName() } },
          ],
        },
      });
      assertEq(r.status, 400, `PII batch (${show(r)})`);
      assertEq(r.body.type, "raw_pii_refused", "named refusal");
      assert(String(r.body.detail).includes("'name'"), `the refused key is named (${r.body.detail})`);
      assert(String(r.body.detail).includes(leaky), "and the event carrying it");
      assertEq((await eventRows([clean, leaky])).length, 0, "neither event stored — not even the clean one");
      for (const key of ["ssn", "date_of_birth", "email"]) {
        const x = await agg("POST", "/events/ingest", {
          bearer: me.jwt, body: { events: [{ id: `evt_flow_agg_${tag}_${key}`, code: "entity.created", payload: { [key]: "x" } }] },
        });
        assertEq(x.status, 400, `${key} refused (${show(x)})`);
        assertEq(x.body.type, "raw_pii_refused", `${key}: typed`);
      }
      assertEq(await countForInstance(me.instanceId), 2, "still exactly two events");
    });

    await t.step("the event log is append-only: an update and a delete are both refused by the database", async () => {
      const up = await aggregator().from("event").update({ code: "tampered" }).eq("event_id", e1).select();
      assert(up.error, `update must be refused (got ${JSON.stringify(up.data)})`);
      assert(String(up.error!.message).includes("append-only"), `by the trigger (${up.error!.message})`);
      const del = await aggregator().from("event").delete().eq("event_id", e1).select();
      assert(del.error, `delete must be refused (got ${JSON.stringify(del.data)})`);
      const rows = await eventRows([e1]);
      assertEq(rows.length, 1, "the row survives");
      assertEq(rows[0].code, "entity.created", "unaltered");
    });

    await t.step("the FBO position is a VIEW: a direct write is refused, so it cannot drift from member balances", async () => {
      const w = await aggregator().from("fbo_position").insert({ instance_id: me.instanceId, position_cents: 1 });
      assert(w.error, "an insert into the position must fail");
      // every credentialed instance has a row (a 0 is a statement, not a gap)
      const v = await aggregator().from("fbo_position").select("position_cents").eq("instance_id", me.instanceId);
      assertEq((v.data ?? []).length, 1, "the credentialed instance has exactly one position row");
      assertEq(Number(v.data![0].position_cents), 0, "and it reads 0 — the written 1 did not land");
      // the live program: the view IS the member-share sum (retry: balances move between two reads)
      const home = await core().from("instance").select("id").limit(1).single();
      let view = -1, sum = -2;
      for (let i = 0; i < 3 && view !== sum; i++) {
        const p = await aggregator().from("fbo_position").select("position_cents").eq("instance_id", home.data!.id).single();
        const s = await aggregator().rpc("member_share_cents", { p_instance: home.data!.id });
        assert(!p.error && !s.error, `position reads: ${p.error?.message ?? s.error?.message}`);
        view = Number(p.data!.position_cents);
        sum = Number(s.data);
      }
      assertEq(view, sum, "the live program's position reads back as the sum of member balances, to the cent");
    });

    await t.step("the cu_admin credential cannot ingest or drive a consumer — read-only by class", async () => {
      if (!ADMIN_SECRET) throw new Error("CU_ADMIN_SECRET must be set (.env.local)");
      const tok = await agg("POST", "/auth/token", { body: { instance_id: "cu_admin_main", client_secret: ADMIN_SECRET } });
      assertEq(tok.status, 200, `admin token (${show(tok)})`);
      const admin = String(tok.body.access_token);
      const evId = `evt_flow_agg_${tag}_admin`;
      const ing = await agg("POST", "/events/ingest", { bearer: admin, body: { events: [{ id: evId, code: "entity.created" }] } });
      assertEq(ing.status, 403, `admin ingest (${show(ing)})`);
      assertEq(ing.body.type, "admin_read_only", "typed");
      assertEq((await eventRows([evId])).length, 0, "nothing ingested");
      const run = await agg("POST", "/consumers/bsa_approver/run", { bearer: admin });
      assertEq(run.status, 403, `admin consumer run (${show(run)})`);
      assertEq(run.body.type, "admin_read_only", "typed");
    });
  } finally {
    await dropInstance(inst);
  }
});

// =============================================================================
// card 58 — the BSA approver, on events an instance pushed directly
// =============================================================================

flow("aggregator: the BSA approver raises one CTR per large event and a lookback-owed structuring flag", async (t) => {
  let inst: Instance | null = null;
  try {
    inst = await newInstance();
    const me = inst;
    const tag = randHex(6);
    const ctrHash = await sha256Hex(`flow-agg-ctr-${tag}`);
    const dripHash = await sha256Hex(`flow-agg-drip-${tag}`);
    const ctrEv = `evt_flow_agg_${tag}_ctr`;
    const drips = [1, 2, 3].map((i) => `evt_flow_agg_${tag}_drip${i}`);
    const small = `evt_flow_agg_${tag}_small`;

    await t.step("the instance pushes an $11k settlement, three $4k drips for one member, and a $50 one", async () => {
      const money = (id: string, h: string, cents: number) => ({
        id, code: "transfer.settled", resource_id: `flowtest:${tag}`, entity_hash: h, payload: { amount_cents: cents },
      });
      const r = await agg("POST", "/events/ingest", {
        bearer: me.jwt,
        body: {
          events: [
            money(ctrEv, ctrHash, 1_100_000),
            ...drips.map((id) => money(id, dripHash, 400_000)),
            money(small, ctrHash, 5_000),
          ],
        },
      });
      assertEq(r.status, 200, `ingest (${show(r)})`);
      assertEq((await eventRows([ctrEv, ...drips, small])).length, 5, "all five stored");
    });

    await t.step("the consumer run route drives the approver and reports what it did", async () => {
      const r = await agg("POST", "/consumers/bsa_approver/run", { bearer: me.jwt });
      assertEq(r.status, 200, `run (${show(r)})`);
      assertEq(r.body.consumer, "bsa_approver", "names the consumer");
      for (const k of ["processed", "ctr", "structuring", "cursor"]) {
        assert(typeof r.body[k] === "number", `reports ${k} (${show(r)})`);
      }
    });

    await t.step("a $11k event raises exactly one ctr_threshold alert, attributed to the instance", async () => {
      await runApproverUntil(me.jwt, async () => (await alertsFor(ctrEv, "ctr_threshold")).length > 0, "ctr alert");
      const a = await alertsFor(ctrEv, "ctr_threshold");
      assertEq(a.length, 1, "one CTR alert");
      assertEq(a[0].instance_id, me.instanceId, "for the pushing instance");
      assertEq(a[0].entity_hash, ctrHash, "keyed by the member's hash");
      assert(String(a[0].details).includes("1100000"), `details carry the amount (${a[0].details})`);
      assertEq((await alertsFor(small, "ctr_threshold")).length, 0, "a $50 settlement raises nothing");
    });

    await t.step("three sub-threshold drips aggregate into ONE structuring flag, marked for the 90-day lookback", async () => {
      await runApproverUntil(me.jwt, async () => (await alertsFor(drips[2], "structuring")).length > 0, "structuring flag");
      const r = await aggregator().from("alert").select("*").eq("entity_hash", dripHash);
      assert(!r.error, `alert read: ${r.error?.message}`);
      const all = r.data ?? [];
      assertEq(all.length, 1, `exactly one alert for the drip member (${JSON.stringify(all.map((x: Any) => [x.event_id, x.alert_type]))})`);
      assertEq(all[0].alert_type, "structuring", "structuring");
      assertEq(all[0].event_id, drips[2], "raised on the drip that crossed $10k in aggregate ($12k), not before");
      assertEq(all[0].requires_lookback, true, "the 24h approver owes the reporter a 90-day lookback");
      assertEq(all[0].instance_id, me.instanceId, "attributed to the instance");
    });

    await t.step("re-running the consumer mints no second alert (UNIQUE event_id, alert_type)", async () => {
      const r = await agg("POST", "/consumers/bsa_approver/run", { bearer: me.jwt });
      assertEq(r.status, 200, `rerun (${show(r)})`);
      assertEq((await alertsFor(ctrEv, "ctr_threshold")).length, 1, "still one CTR");
      const s = await aggregator().from("alert").select("id").eq("entity_hash", dripHash);
      assertEq((s.data ?? []).length, 1, "still one structuring flag");
    });

    await t.step("only the bsa_approver can be driven: unknown and retired consumers are 404", async () => {
      for (const name of ["rm_rf", "payment_hub"]) {
        const r = await agg("POST", `/consumers/${name}/run`, { bearer: me.jwt });
        assertEq(r.status, 404, `${name} (${show(r)})`);
        assertEq(r.body.type, "not_found", `${name}: typed`);
      }
    });

    await t.step("the CU sees the instance's activity and alerts by hash in the cross-fintech search", async () => {
      if (!ADMIN_SECRET) throw new Error("CU_ADMIN_SECRET must be set (.env.local)");
      const tok = await agg("POST", "/auth/token", { body: { instance_id: "cu_admin_main", client_secret: ADMIN_SECRET } });
      assertEq(tok.status, 200, `admin token (${show(tok)})`);
      const r = await agg("GET", `/search?entity_hash=${dripHash}`, { bearer: String(tok.body.access_token) });
      assertEq(r.status, 200, `search (${show(r)})`);
      assertEq(r.body.instances.length, 1, "one instance holds this member");
      assertEq(r.body.instances[0].instance_id, me.instanceId, "this one");
      assertEq(r.body.instances[0].event_count, 3, "three events");
      assertEq(Number(r.body.instances[0].money_cents), 1_200_000, "summing $12k of money movement");
      assert(r.body.alerts.some((a: Any) => a.alert_type === "structuring" && a.requires_lookback), `the flag is visible (${show(r)})`);
      const mine = await agg("GET", `/search?entity_hash=${dripHash}`, { bearer: me.jwt });
      assertEq(mine.status, 403, "the instance itself cannot run the cross-fintech search");
    });
  } finally {
    await dropInstance(inst);
  }
});

// =============================================================================
// cards 55 + 58 on the real path — a partner's transfer crosses the boundary
// =============================================================================

flow("aggregator: a partner's $11k transfer crosses the outbox into the aggregator once and raises one CTR there", async (t) => {
  let inst: Instance | null = null;
  try {
    inst = await newInstance(); // only to drive the (global) consumer; never written as
    const me = inst;
    const accounts: string[] = [];
    let transferId = "";
    let eventId = "";

    await t.step("a partner onboards two verified members with funded checking accounts", async () => {
      for (const who of ["sender", "receiver"]) {
        const e = await api("POST", "/entities", {
          type: "person", name: personaName(), date_of_birth: "1987-03-09",
          address: "100 Main St, Springfield, IL 62701", tin: "900-00-0000",
        });
        assertEq(e.status, 201, `${who} entity (${show(e)})`);
        const v = await api("POST", `/entities/${e.body.id}/verifications`, { simulate: "approve" });
        assertEq(v.status, 201, `${who} verification (${show(v)})`);
        const a = await api("POST", "/accounts", {
          entity_id: e.body.id, account_type: "checking", opening_deposit_cents: 5_000_000,
        });
        assertEq(a.status, 201, `${who} account (${show(a)})`);
        accounts.push(String(a.body.id));
      }
    });

    await t.step("an $11,000 book transfer settles and writes transfer.settled into the outbox", async () => {
      const r = await api("POST", "/transfers", {
        source_account_id: accounts[0], destination_account_id: accounts[1],
        amount_cents: 1_100_000, description: "aggregator flow: ctr",
      });
      assertEq(r.status, 201, `transfer (${show(r)})`);
      transferId = String(r.body.id);
      const ev = await core().from("event").select("id, entity_hash, payload").eq("resource_id", transferId).eq("code", "transfer.settled");
      assertEq((ev.data ?? []).length, 1, `one transfer.settled in the outbox (${JSON.stringify(ev.data)})`);
      eventId = String(ev.data![0].id);
      assertEq(eventId, `evt_${transferId}_settled`, "deterministic event id — the dedup key");
      assertEq(Number(ev.data![0].payload.amount_cents), 1_100_000, "carries the amount");
      assert(ev.data![0].entity_hash, "carries the member's hash");
    });

    await t.step("the outbox delivers it: one aggregator row, inst_local from the verified token, schema_version 1", async () => {
      await deliver([eventId]);
      const rows = await eventRows([eventId]);
      assertEq(rows.length, 1, "crossed the boundary exactly once");
      const inst = await core().from("instance").select("id").limit(1).single();
      assertEq(rows[0].instance_id, inst.data?.id, "attributed to this fintech's instance");
      assertEq(rows[0].schema_version, 1, "carrying its schema_version");
      assertEq(rows[0].code, "transfer.settled", "code");
      assertEq(Number(rows[0].payload.amount_cents), 1_100_000, "amount");
      assert(!("name" in (rows[0].payload ?? {})), "no plaintext identity");
    });

    await t.step("another sweep does not deliver it twice", async () => {
      const s = await api("POST", "/events/deliver", {});
      assertEq(s.status, 200, `sweep (${show(s)})`);
      assertEq((await eventRows([eventId])).length, 1, "still exactly one");
    });

    await t.step("the approver raises exactly one ctr_threshold for it, however often it runs", async () => {
      await runApproverUntil(me.jwt, async () => (await alertsFor(eventId, "ctr_threshold")).length > 0, "real-path CTR");
      const again = await agg("POST", "/consumers/bsa_approver/run", { bearer: me.jwt });
      assertEq(again.status, 200, `rerun (${show(again)})`);
      const a = await alertsFor(eventId, "ctr_threshold");
      assertEq(a.length, 1, "one alert");
      assertEq(a[0].entity_hash, (await eventRows([eventId]))[0].entity_hash, "keyed by the delivered hash");
    });
  } finally {
    await dropInstance(inst);
  }
});

// =============================================================================
// card 61 — health: lag over the wire, and a stall WRITES an alarm
// =============================================================================

flow("aggregator: health reports consumer lag and ingest gap, and a stalled consumer writes an alarm", async (t) => {
  let inst: Instance | null = null;
  const probe = `flow_probe_${randHex(6)}`;
  let probeInserted = false;
  try {
    inst = await newInstance();
    const me = inst;

    await t.step("health answers over the wire with the tip, the ingest gap, consumers and mirrors", async () => {
      const r = await agg("GET", "/health", { bearer: me.jwt });
      assertEq(r.status, 200, `health (${show(r)})`);
      for (const k of ["tip_sequence", "last_ingest_at", "ingest_gap_seconds", "consumers", "mirrors"]) {
        assert(k in r.body, `carries ${k} (${show(r)})`);
      }
      const max = await aggregator().from("event").select("sequence_id").order("sequence_id", { ascending: false }).limit(1);
      assert(Number(r.body.tip_sequence) <= Number(max.data?.[0]?.sequence_id), "tip is the log's sequence high-water");
      assert(Number(r.body.tip_sequence) > 0, "the log is not empty");
    });

    await t.step("the real bsa_approver is live: listed, not stalled, its cursor stamped recently", async () => {
      const r = await agg("GET", "/health", { bearer: me.jwt });
      const c = (r.body.consumers ?? []).find((x: Any) => x.consumer === "bsa_approver");
      assert(c, `bsa_approver listed (${show(r)})`);
      assertEq(c.stalled, false, `not stalled (${JSON.stringify(c)})`);
      assert(c.idle_seconds < 600, `the cron stamped it within 10 minutes (idle ${c.idle_seconds}s)`);
    });

    await t.step("a consumer that has fallen behind and gone idle is named stalled — and the trip WROTE an alert", async () => {
      // a run-unique probe cursor, born stalled: an hour idle, behind the tip
      const ins = await aggregator().from("consumer_cursor").insert({
        consumer: probe, last_seq: 0, updated_at: new Date(Date.now() - 3_600_000).toISOString(),
      });
      assert(!ins.error, `probe cursor: ${ins.error?.message}`);
      probeInserted = true;
      const r = await agg("GET", "/health", { bearer: me.jwt });
      assertEq(r.status, 200, `health (${show(r)})`);
      const c = (r.body.consumers ?? []).find((x: Any) => x.consumer === probe);
      assert(c, `the probe is listed (${show(r)})`);
      assertEq(c.stalled, true, "named stalled");
      assertEq(Number(c.lag), Number(r.body.tip_sequence), "its lag is the whole log");
      assert(c.idle_seconds >= 3_500, `idle about an hour (${c.idle_seconds}s)`);
      const a = await aggregator().from("alert").select("*").eq("alert_type", "consumer_stalled").like("event_id", `stall_${probe}_%`);
      assert(!a.error, `alert read: ${a.error?.message}`);
      assertEq((a.data ?? []).length, 1, "exactly one consumer_stalled alarm for the probe");
      assert(String(a.data![0].details).includes(probe), `the alarm names the consumer (${a.data![0].details})`);
      const again = await agg("GET", "/health", { bearer: me.jwt });
      assertEq(again.status, 200, "second health");
      const b = await aggregator().from("alert").select("id").eq("alert_type", "consumer_stalled").like("event_id", `stall_${probe}_%`);
      assertEq((b.data ?? []).length, 1, "a second check in the same hour does not re-alarm (hourly dedup)");
    });
  } finally {
    if (probeInserted) {
      const d = await aggregator().from("consumer_cursor").delete().eq("consumer", probe);
      if (d.error) console.error(`teardown probe cursor: ${d.error.message}`);
      const a = await aggregator().from("alert").delete().eq("alert_type", "consumer_stalled").like("event_id", `stall_${probe}_%`);
      if (a.error) console.error(`teardown probe alarm: ${a.error.message}`);
    }
    await dropInstance(inst);
  }
});

// =============================================================================
// section 41 — the analytics tail (cards 62/59/60), as the evidence it leaves
// =============================================================================

flow("aggregator: the daily analytics tail is alive — archive watermark, 5300 rows and SAR lookbacks keep up", async (t) => {
  // archive.sh / bsa_reporter.sh / report_5300.sh run from a scheduled GitHub
  // workflow with the DuckDB CLI; the flow cannot (and must not) run them. It
  // reads the evidence each run leaves in Postgres. Every one of them stamps
  // its row even when there is no new work (card-18 liveness), so a row older
  // than two days means the schedule is not running.
  const DAY = 86_400_000;

  await t.step("the archive watermark never runs ahead of the log", async () => {
    const w = await aggregator().from("archive_watermark").select("archived_through, archived_at").single();
    assert(!w.error, `watermark read: ${w.error?.message}`);
    const max = await aggregator().from("event").select("sequence_id").order("sequence_id", { ascending: false }).limit(1);
    assert(Number(w.data!.archived_through) <= Number(max.data?.[0]?.sequence_id),
      "archived_through <= the log's head — nothing is archived that does not exist");
  });

  await t.step("the archive job stamped liveness within two days", async () => {
    const w = await aggregator().from("archive_watermark").select("archived_at").single();
    const age = Date.now() - Date.parse(w.data!.archived_at);
    // Regression guard (bug found by this flow, fixed 2026-10-06 in 28cec49): the daily analytics workflow had been emptied by b4964da, so archive / BSA lookback / 5300 stopped on 2026-08-17. This goes red if the schedule stops again.
    assert(age < 2 * DAY, `archive_watermark.archived_at ${w.data!.archived_at} is ${Math.round(age / DAY)} days old`);
  });

  await t.step("the 5300 reporter left a recent row for the live instance", async () => {
    const inst = await core().from("instance").select("id").limit(1).single();
    const r = await aggregator().from("report_5300").select("as_of").eq("instance_id", inst.data!.id)
      .order("as_of", { ascending: false }).limit(1);
    assert(!r.error, `report_5300 read: ${r.error?.message}`);
    const latest = r.data?.[0]?.as_of;
    assert(latest, "a 5300 row exists for the instance");
    // Regression guard (bug found by this flow, fixed 2026-10-06 in 28cec49): the daily analytics workflow had been emptied by b4964da, so archive / BSA lookback / 5300 stopped on 2026-08-17. This goes red if the schedule stops again.
    assert(Date.now() - Date.parse(latest) < 2 * DAY, `newest report_5300.as_of is ${latest}`);
  });

  await t.step("every structuring flag that owes a lookback has a SAR candidate within two days", async () => {
    const cutoff = new Date(Date.now() - 2 * DAY).toISOString();
    const flags = await aggregator().from("alert").select("entity_hash, created_at").eq("alert_type", "structuring")
      .eq("requires_lookback", true).not("entity_hash", "is", null).lt("created_at", cutoff)
      // inside the 90-day horizon, where the lookback must still find the flagged movement
      .gt("created_at", new Date(Date.now() - 88 * DAY).toISOString());
    assert(!flags.error, `alert read: ${flags.error?.message}`);
    const hashes = [...new Set((flags.data ?? []).map((f: Any) => String(f.entity_hash)))];
    const covered = new Set<string>();
    for (let i = 0; i < hashes.length; i += 100) {
      const s = await aggregator().from("sar_candidate").select("entity_hash").in("entity_hash", hashes.slice(i, i + 100));
      assert(!s.error, `sar_candidate read: ${s.error?.message}`);
      for (const r of s.data ?? []) covered.add(String(r.entity_hash));
    }
    const owed = hashes.filter((h) => !covered.has(h));
    // Regression guard (bug found by this flow, fixed 2026-10-06 in 28cec49): the daily analytics workflow had been emptied by b4964da, so archive / BSA lookback / 5300 stopped on 2026-08-17. This goes red if the schedule stops again.
    assertEq(owed.length, 0, `${owed.length} of ${hashes.length} lookback-owed entities have no SAR candidate`);
  });
});
