// flow-runner: serial — changes or reads instance-wide state (see scripts/flow.sh)
// Isolation and violation flows: who may see across fintechs, and the
// refusals that ARE the controls.
//
// Ported from core/supabase/tests/e2e/compliance_e2e.sh:
//
//   §45 isolation tier — the cu_admin credential reads across every instance
//       at the aggregator and writes nothing; the cross-fintech search is keyed
//       by entity_hash (never identity) and refused to an instance credential.
//   §46 violation tier — MP-07 death/estate, MP-06 expulsion, PR-03/04
//       privacy gates, PR-15 connection scope violation, CP-05 custody on
//       separation. Each refusal is asserted on the row an examiner reads, not
//       only on the status code.
//
// Not run here (see the report that accompanied this file):
//   * RS-03 safe mode ACTIVATION: one active safe_mode row gates every
//     transfer on the instance, so turning it on would refuse other flows'
//     money movement on the shared demo core. Only the refusals that leave
//     nothing active are exercised.
//   * DF-05 insider lending: lending is deliberately unrouted (api/index.ts).
//   * one entity seen at TWO fintechs via search: the demo core has a single
//     partner on inst_local, so a genuine two-fintech match cannot be made.
//
// Scoped-token confinement (§39) lives in platform.test.ts and is not repeated.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { actor, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

// --------------------------------------------------------------- local helpers

const show = (b: unknown) => JSON.stringify(b).slice(0, 300);
const AGG = (Deno.env.get("AGGREGATOR_URL") ?? "https://jynsipdvrgqdkeqrlzcv.functions.supabase.co/aggregator")
  .replace(/\/$/, "");

let aggClient: SupabaseClient | null = null;
/** service-role read of the aggregator schema */
function aggregator() {
  aggClient ??= createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } });
  return aggClient.schema("aggregator");
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// deno-lint-ignore no-explicit-any
type Any = any;
async function agg(method: string, path: string, opts: { bearer?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${AGG}${path}`, {
    method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: Any = text;
  try {
    body = JSON.parse(text);
  } catch { /* raw */ }
  return { status: res.status, body };
}

async function aggToken(instanceId: string, secret: string, extra: Record<string, unknown> = {}) {
  return await agg("POST", "/auth/token", { body: { instance_id: instanceId, client_secret: secret, ...extra } });
}

async function person(key: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1952-06-01", ...extra,
  }, { key });
  assertEq(r.status, 201, `entity (${show(r.body)})`);
  return String(r.body.id);
}

async function account(key: string, entity: string, openingCents: number): Promise<string> {
  const r = await api("POST", "/accounts", {
    entity_id: entity, account_type: "checking", opening_deposit_cents: openingCents,
  }, { key });
  assertEq(r.status, 201, `account (${show(r.body)})`);
  return String(r.body.id);
}

async function balanceOf(acct: string, expected: number): Promise<number> {
  let last = -1;
  for (let i = 0; i < 10; i++) {
    const r = await api("GET", `/accounts/${acct}`);
    last = Number(r.body.balance);
    if (last === expected) return last;
    await new Promise((res) => setTimeout(res, 500));
  }
  return last;
}

async function event(id: string) {
  const r = await core().from("event").select("code, payload, provenance").eq("id", id).maybeSingle();
  assert(!r.error, `event read ${id}: ${r.error?.message}`);
  return r.data as { code: string; payload: Record<string, unknown>; provenance: string } | null;
}

const ADDRESS = "40 Oak Ln, Springfield, IL 62704";

// =============================================================================
// §45 — the CU admin reads across instances, writes nothing
// =============================================================================

flow("isolation: the CU admin reads across every fintech's instance at the aggregator and writes nothing", async (t) => {
  const adminSecret = Deno.env.get("CU_ADMIN_SECRET") ?? "";
  const instSecret = Deno.env.get("AGGREGATOR_CLIENT_SECRET") ?? "";
  let admin = "";
  let instance = "";
  let entity = "";
  let hash = "";

  await t.step("a fintech's new member crosses into the aggregator — as a hash", async () => {
    const partner = await actor("partner");
    entity = await person(partner, { address: ADDRESS });
    hash = await sha256Hex(entity);
    const ev = await core().from("event").select("id").eq("resource_id", entity).eq("code", "entity.created").single();
    assert(!ev.error, `entity.created in the outbox: ${ev.error?.message}`);
    let delivered: string | null = null;
    for (let i = 0; i < 10 && !delivered; i++) {
      const s = await api("POST", "/events/deliver", {});
      assertEq(s.status, 200, `sweep ${i} (${show(s.body)})`);
      const row = await core().from("event").select("delivered_at").eq("id", ev.data!.id).single();
      delivered = row.data?.delivered_at ?? null;
    }
    assert(delivered, "the member's entity.created was delivered within 10 sweeps");
    const a = await aggregator().from("event").select("entity_hash, instance_id").eq("event_id", ev.data!.id);
    assertEq(a.data?.[0]?.entity_hash, hash, "ingested keyed by entity_hash");
    assertEq(a.data?.[0]?.instance_id, "inst_local", "attributed to the fintech's instance");
  });

  await t.step("the admin credential mints a cu_admin token — the role comes from the ROW, not the request", async () => {
    assert(adminSecret && instSecret, "CU_ADMIN_SECRET and AGGREGATOR_CLIENT_SECRET present");
    const r = await aggToken("cu_admin_main", adminSecret, { role: "instance" });
    assertEq(r.status, 200, `admin token (${show(r.body)})`);
    assertEq(r.body.role, "cu_admin", "admin role, whatever the body claimed");
    admin = String(r.body.access_token);
    const i = await aggToken("inst_local", instSecret, { role: "cu_admin" });
    assertEq(i.status, 200, `instance token (${show(i.body)})`);
    assertEq(i.body.role, "instance", "an instance cannot talk itself into cu_admin");
    instance = String(i.body.access_token);
    const wrong = await aggToken("cu_admin_main", `${adminSecret}x`);
    assertEq(wrong.status, 401, "a wrong secret mints nothing");
    const unknown = await aggToken(`inst_${uid()}`, adminSecret);
    assertEq(unknown.status, 401, "an unknown instance is the same 401 — no instance-id oracle");
  });

  await t.step("card 52: the admin overview spans instances, including other fintechs'", async () => {
    const r = await agg("GET", "/admin/overview", { bearer: admin });
    assertEq(r.status, 200, `overview (${show(r.body)})`);
    const ids = (r.body.instances ?? []).map((i: { instance_id: string }) => i.instance_id);
    assert(ids.includes("inst_local"), `the demo fintech's instance (${ids})`);
    assert(ids.some((id: string) => id !== "inst_local" && id !== "cu_admin_main"), `and at least one other instance (${ids})`);
    const local = r.body.instances.find((i: { instance_id: string }) => i.instance_id === "inst_local");
    assert(Number(local.event_count) > 0, "the fintech's activity is visible to the CU");
  });

  await t.step("an admin WRITE is refused wholesale, by credential class", async () => {
    const o = await agg("POST", "/originations", { bearer: admin, body: { amount_cents: 1 } });
    assertEq(o.status, 403, `admin origination (${show(o.body)})`);
    assertEq(o.body.type, "admin_read_only", "and says why");
    const evId = `evt_flow_admin_${uid()}`;
    const ing = await agg("POST", "/events/ingest", { bearer: admin, body: { events: [{ id: evId, code: "entity.created" }] } });
    assertEq(ing.status, 403, `admin ingest (${show(ing.body)})`);
    assertEq(ing.body.type, "admin_read_only", "same refusal");
    const row = await aggregator().from("event").select("event_id").eq("event_id", evId);
    assertEq((row.data ?? []).length, 0, "nothing was ingested");
  });

  await t.step("card 54: the cross-fintech search finds the member by hash, and identity is not a key", async () => {
    const r = await agg("GET", `/search?entity_hash=${hash}`, { bearer: admin });
    assertEq(r.status, 200, `search (${show(r.body)})`);
    const local = (r.body.instances ?? []).find((i: { instance_id: string }) => i.instance_id === "inst_local");
    assert(local && Number(local.event_count) >= 1, `the member's activity at inst_local (${show(r.body)})`);
    const byId = await agg("GET", `/search?entity_hash=${entity}`, { bearer: admin });
    assertEq(byId.status, 200, "a plaintext id is just a non-matching hash");
    assertEq((byId.body.instances ?? []).length, 0, "searching by identity finds nothing — identity never crossed");
    const none = await agg("GET", "/search", { bearer: admin });
    assertEq(none.status, 400, `no entity_hash (${show(none.body)})`);
  });

  await t.step("the search surfaces alerts raised against a hash", async () => {
    const a = await aggregator().from("alert").select("entity_hash, alert_type").not("entity_hash", "is", null).limit(1);
    assert(!a.error && (a.data ?? []).length === 1, `an aggregator alert with a hash exists (${a.error?.message})`);
    const r = await agg("GET", `/search?entity_hash=${a.data![0].entity_hash}`, { bearer: admin });
    assertEq(r.status, 200, "search");
    assert((r.body.alerts ?? []).some((x: { alert_type: string }) => x.alert_type === a.data![0].alert_type),
      `the ${a.data![0].alert_type} alert is in the result (${show(r.body)})`);
  });

  await t.step("an INSTANCE credential is refused the cross-fintech view (D23)", async () => {
    const s = await agg("GET", `/search?entity_hash=${hash}`, { bearer: instance });
    assertEq(s.status, 403, `instance search (${show(s.body)})`);
    assertEq(s.body.type, "cu_admin_only", "typed");
    const o = await agg("GET", "/admin/overview", { bearer: instance });
    assertEq(o.status, 403, `instance overview (${show(o.body)})`);
    const none = await agg("GET", "/admin/overview");
    assertEq(none.status, 401, "no credential at all is a 401");
  });
});

// =============================================================================
// §46 RS-03 — safe mode: only the refusals that leave nothing active
// =============================================================================

flow("isolation: safe mode cannot be switched on by a partner or without a cap", async (t) => {
  const basis = `flow_${uid()}`;
  const created: string[] = [];
  try {
    await t.step("a partner cannot touch resolution posture", async () => {
      const partner = await actor("partner");
      const r = await api("POST", "/resolution/safe-mode", { trigger_basis: basis, activated_by: "partner" }, { key: partner });
      if (r.status === 201) created.push(String(r.body.data?.id));
      assertEq(r.status, 403, `partner activation (${show(r.body)})`);
      assertEq(r.body.type, "insufficient_scope", "refused by actor class");
    });

    await t.step("the CU cannot activate safe mode without a positive per-transaction cap", async () => {
      const cu = await actor("cu_admin");
      for (const cap of [undefined, 0, -5]) {
        const r = await api("POST", "/resolution/safe-mode",
          { trigger_basis: basis, activated_by: "resolution officer", ...(cap === undefined ? {} : { per_txn_cap_cents: cap }) },
          { key: cu });
        if (r.status === 201) created.push(String(r.body.data?.id));
        assertEq(r.status, 400, `cap ${cap} (${show(r.body)})`);
      }
      const rows = await core().from("safe_mode").select("id").eq("trigger_basis", basis);
      assertEq((rows.data ?? []).length, 0, "no safe_mode row was written");
      const unknown = await api("POST", `/resolution/safe-mode/safemode_${uid()}/deactivate`,
        { authorized_by: "a", second_authorizer: "b" }, { key: cu });
      assertEq(unknown.status, 404, `deactivating an unknown safe mode (${show(unknown.body)})`);
    });
  } finally {
    // belt and braces: never leave the shared core in safe mode
    for (const id of created) {
      await api("POST", `/resolution/safe-mode/${id}/deactivate`, { authorized_by: "flow_a", second_authorizer: "flow_b" });
    }
  }
});

// =============================================================================
// §46 MP-07 — a death flag freezes movement; the estate is paid only once verified
// =============================================================================

flow("isolation: a death report freezes the member's money and the estate is paid only to a verified claimant", async (t) => {
  const OPENING = 30_000; // $300
  let partner = "";
  let cu = "";
  let deceased = "";
  let dAcct = "";
  let other = "";
  let claim = "";
  let verification = "";

  await t.step("the fintech onboards the member and a counterparty", async () => {
    partner = await actor("partner");
    cu = await actor("cu_admin");
    deceased = await person(partner, { address: ADDRESS });
    dAcct = await account(partner, deceased, OPENING);
    other = await account(partner, await person(partner, { address: ADDRESS }), 10_000);
    assertEq(await balanceOf(dAcct, OPENING), OPENING, "funded");
  });

  await t.step("a fintech cannot file a death report — it is the CU's act", async () => {
    const r = await api("POST", `/members/${deceased}/death-report`,
      { date_of_death: "2026-07-01", death_certificate_ref: "dc_77" }, { key: partner });
    assertEq(r.status, 403, `partner death report (${show(r.body)})`);
    const a = await core().from("account").select("lock_type").eq("id", dAcct).single();
    assertEq(a.data?.lock_type, "none", "account untouched");
  });

  await t.step("a death is flagged from a document: no certificate, no flag", async () => {
    const r = await api("POST", `/members/${deceased}/death-report`, { date_of_death: "2026-07-01" }, { key: cu });
    assertEq(r.status, 400, `no certificate (${show(r.body)})`);
    const a = await core().from("account").select("lock_type").eq("id", dAcct).single();
    assertEq(a.data?.lock_type, "none", "account untouched");
  });

  await t.step("the death report flags every account durably: lock_type=deceased", async () => {
    const r = await api("POST", `/members/${deceased}/death-report`,
      { date_of_death: "2026-07-01", death_certificate_ref: "dc_77" }, { key: cu });
    assertEq(r.status, 201, `death report (${show(r.body)})`);
    assertEq(r.body.data.accounts_flagged, 1, "one account flagged");
    const a = await core().from("account").select("lock_type").eq("id", dAcct).single();
    assertEq(a.data?.lock_type, "deceased", "lock_type");
    const ev = await event(`ev_death_${dAcct}`);
    assertEq(ev?.code, "account.death_flag.applied", "per-account evidence");
    assertEq(ev?.payload.previous_lock, "none", "records what it replaced");
  });

  await t.step("a transfer out of the deceased member's account is REFUSED by the lock gate", async () => {
    const r = await api("POST", "/transfers", {
      source_account_id: dAcct, destination_account_id: other, amount_cents: 1_000, description: "flow: from beyond",
    }, { key: partner });
    assertEq(r.status, 422, `transfer (${show(r.body)})`);
    assertEq(r.body.type, "account_locked", "by name");
    assertEq(await balanceOf(dAcct, OPENING), OPENING, "no money left the estate");
  });

  await t.step("the estate claim is documented and opens claimant verification", async () => {
    const r = await api("POST", `/members/${deceased}/estate-claims`, {
      claimant: "Edith Ellison (executor)", date_of_death: "2026-07-01",
      death_certificate_ref: "dc_77", authority_document_ref: "letters_testamentary_1",
    }, { key: cu });
    assertEq(r.status, 201, `estate claim (${show(r.body)})`);
    claim = String(r.body.data.id);
    verification = String(r.body.data.verification_id);
    const v = await core().from("verification").select("type, status").eq("id", verification).single();
    assertEq(v.data?.type, "estate_claimant", "a real verification row");
    assertEq(v.data?.status, "pending", "pending");
  });

  await t.step("paying an UNVERIFIED claimant is refused", async () => {
    const r = await api("POST", `/estate-claims/${claim}/payout`, {}, { key: cu });
    assertEq(r.status, 409, `unverified payout (${show(r.body)})`);
    assertEq(r.body.type, "claimant_not_verified", "typed");
    const c = await core().from("estate_claim").select("status, payout_cents").eq("id", claim).single();
    assert(c.data?.status !== "paid", `claim not paid (${c.data?.status})`);
    assertEq(c.data?.payout_cents, null, "no payout amount recorded");
  });

  await t.step("once verification completes, the payout goes and nets amounts owed", async () => {
    // The verification vendor's approval: no routed API completes an
    // estate-claimant verification (/verifications/{id}/transition is in
    // x-proposed-paths), so the vendor result is written with the service role,
    // as the bash harness did with psql.
    const u = await core().from("verification").update({ status: "approved" }).eq("id", verification);
    assert(!u.error, `vendor approval: ${u.error?.message}`);
    const r = await api("POST", `/estate-claims/${claim}/payout`, { amounts_owed_cents: 500 }, { key: cu });
    assertEq(r.status, 200, `payout (${show(r.body)})`);
    assertEq(r.body.data.payout_cents, OPENING - 500, "ledger balance net of amounts owed");
    const c = await core().from("estate_claim").select("status, payout_cents, provenance").eq("id", claim).single();
    assertEq(c.data?.status, "paid", "paid");
    assertEq(Number(c.data?.payout_cents), OPENING - 500, "payout evidence");
    const ev = await event(`ev_${claim}_paid`);
    assertEq(ev?.code, "estate.payout.sent", "payout event");
    assertEq(ev?.payload["verification.status"], "approved", "paid against an approved verification");
  });

  await t.step("an estate is paid once", async () => {
    const r = await api("POST", `/estate-claims/${claim}/payout`, {}, { key: cu });
    assertEq(r.status, 409, `second payout (${show(r.body)})`);
    assertEq(r.body.type, "estate_already_paid", "typed");
  });
});

// =============================================================================
// §46 MP-06 — expulsion needs a deliverable contact; close locks and pays out
// =============================================================================

flow("isolation: an expulsion needs a deliverable contact, and closing it locks the account and pays out", async (t) => {
  const OPENING = 50_000; // $500
  let cu = "";
  let partner = "";
  let member = "";
  let acct = "";
  let expulsion = "";

  await t.step("expelling a member with no deliverable contact is refused, and nothing is recorded", async () => {
    partner = await actor("partner");
    cu = await actor("cu_admin");
    const ghost = await person(partner);
    const r = await api("POST", `/members/${ghost}/expulsion`,
      { grounds: "fraud", decided_by: "board", meeting_date: "2026-08-01" }, { key: cu });
    assertEq(r.status, 422, `contactless expulsion (${show(r.body)})`);
    assertEq(r.body.type, "no_deliverable_contact", "the refusal names due process");
    const rows = await core().from("expulsion").select("id").eq("entity_id", ghost);
    assertEq((rows.data ?? []).length, 0, "no expulsion row");
  });

  await t.step("a fintech cannot expel a member", async () => {
    member = await person(partner, { address: ADDRESS });
    acct = await account(partner, member, OPENING);
    const r = await api("POST", `/members/${member}/expulsion`,
      { grounds: "abuse of services", decided_by: "board", meeting_date: "2026-08-15" }, { key: partner });
    assertEq(r.status, 403, `partner expulsion (${show(r.body)})`);
  });

  await t.step("with an address on file the board's decision is noticed by mail", async () => {
    const r = await api("POST", `/members/${member}/expulsion`, {
      grounds: "abuse of services", decided_by: "board-2026-07", meeting_date: "2026-08-15", amounts_owed_cents: 100,
    }, { key: cu });
    assertEq(r.status, 201, `expulsion (${show(r.body)})`);
    assertEq(r.body.data.notice_channel, "mail", "noticed to the address on file");
    expulsion = String(r.body.data.id);
    const row = await core().from("expulsion").select("status, notice_sent_at, notice_channel").eq("id", expulsion).single();
    assertEq(row.data?.status, "noticed", "noticed");
    assert(row.data?.notice_sent_at, "notice timestamp");
  });

  await t.step("after the hearing, closing files the board report, locks the account and pays out net", async () => {
    assertEq(await balanceOf(acct, OPENING), OPENING, "funded before close");
    const h = await api("POST", `/expulsions/${expulsion}/hearing`, { kind: "held" }, { key: cu });
    assertEq(h.status, 200, `hearing (${show(h.body)})`);
    const c = await api("POST", `/expulsions/${expulsion}/close`, {}, { key: cu });
    assertEq(c.status, 200, `close (${show(c.body)})`);
    assertEq(c.body.data.payout_cents, OPENING - 100, "share balance net of amounts owed");
    const row = await core().from("expulsion")
      .select("status, board_report_filed_at, hearing_held_at, payout_cents").eq("id", expulsion).single();
    assertEq(row.data?.status, "final", "final");
    assert(row.data?.board_report_filed_at, "board report filed");
    assert(row.data?.hearing_held_at, "hearing on record");
    assertEq(Number(row.data?.payout_cents), OPENING - 100, "payout evidence");
    const a = await core().from("account").select("lock_type").eq("id", acct).single();
    assertEq(a.data?.lock_type, "expelled", "account locked expelled");
    const again = await api("POST", `/expulsions/${expulsion}/close`, {}, { key: cu });
    assertEq(again.status, 409, `re-close (${show(again.body)})`);
  });
});

// =============================================================================
// §46 PR-03 / PR-04 / PR-15 — privacy gates
// =============================================================================

flow("isolation: member data leaves only on a legal basis, to the entitled, and a connection that oversteps is cut off", async (t) => {
  let partner = "";
  let cu = "";
  let member = "";
  let acct = "";
  let connId = "";
  let connToken = "";
  let connTokenId = "";

  try {
    await t.step("the fintech onboards a member", async () => {
      partner = await actor("partner");
      cu = await actor("cu_admin");
      member = await person(partner, { address: ADDRESS });
      acct = await account(partner, member, 20_000);
    });

    await t.step("PR-03: a disclosure with no legal basis is BLOCKED, and the block is evidence", async () => {
      const r = await api("POST", "/privacy/disclosures", { entity_id: member, recipient: "data_broker_x" }, { key: cu });
      assertEq(r.status, 422, `no basis (${show(r.body)})`);
      assertEq(r.body.type, "privacy_sharing_blocked", "typed");
      const vendor = await api("POST", "/privacy/disclosures",
        { entity_id: member, recipient: "statement_printer", legal_basis: "service_provider_glba", vendor_id: "vnd_print" }, { key: cu });
      assertEq(vendor.status, 422, `vendor without GLBA addendum (${show(vendor.body)})`);
      const rows = await core().from("privacy_disclosure").select("id, recipient, blocked, blocked_reason").eq("entity_id", member);
      const blocked = (rows.data ?? []).filter((x) => x.blocked === true);
      assertEq(blocked.length, 2, "both refusals are durable rows");
      assert(blocked.every((x) => x.blocked_reason), "each block says why");
      const ev = await event(`ev_${blocked[0].id}_blocked`);
      assertEq(ev?.code, "privacy.sharing.blocked", "block event");
    });

    await t.step("PR-03: a recognized basis lets the disclosure through, recorded with its basis", async () => {
      const r = await api("POST", "/privacy/disclosures",
        { entity_id: member, recipient: "county court", legal_basis: "legal_process" }, { key: cu });
      assertEq(r.status, 201, `legal process (${show(r.body)})`);
      const row = await core().from("privacy_disclosure").select("blocked, legal_basis").eq("id", r.body.data.id).single();
      assertEq(row.data?.blocked, false, "not blocked");
      assertEq(row.data?.legal_basis, "legal_process", "basis recorded");
    });

    await t.step("a fintech cannot make the CU's disclosure decisions", async () => {
      const r = await api("POST", "/privacy/disclosures",
        { entity_id: member, recipient: "x", legal_basis: "consent" }, { key: partner });
      assertEq(r.status, 403, `partner disclosure (${show(r.body)})`);
    });

    await t.step("PR-04: an access request with no entitlement is refused and the refusal recorded", async () => {
      const r = await api("POST", "/privacy/access-requests",
        { entity_id: member, requester_kind: "other", agent_identity: "Nosy Neighbor" }, { key: cu });
      assertEq(r.status, 403, `no entitlement (${show(r.body)})`);
      assertEq(r.body.type, "access_refused", "typed");
      const poa = await api("POST", "/privacy/access-requests",
        { entity_id: member, requester_kind: "agent_poa", agent_identity: "Cousin Vinny" }, { key: cu });
      assertEq(poa.status, 422, `POA claimed without the artifact (${show(poa.body)})`);
      const self = await api("POST", "/privacy/access-requests", { entity_id: member, requester_kind: "self" }, { key: cu });
      assertEq(self.status, 201, `the member themself (${show(self.body)})`);
      const rows = await core().from("privacy_access_request").select("requester_kind, status, refusal_reason").eq("entity_id", member);
      const by = (k: string) => (rows.data ?? []).find((x) => x.requester_kind === k);
      assertEq(by("other")?.status, "refused", "the stranger's request is refused on record");
      assert(by("other")?.refusal_reason, "with a reason");
      assertEq(by("agent_poa")?.status, "refused", "the unsupported POA too");
      assertEq(by("self")?.status, "granted", "the member is granted");
    });

    await t.step("PR-15: the member's consent mints a connection token confined to its scope", async () => {
      const r = await api("POST", "/privacy/connections",
        { entity_id: member, party_id: "budget_app_z", scopes: ["GET /accounts/{id}"] }, { key: partner });
      assertEq(r.status, 201, `connection (${show(r.body)})`);
      connId = String(r.body.data.id);
      connToken = String(r.body.data.token);
      connTokenId = String(r.body.data.token_id);
      const ok = await api("GET", `/accounts/${acct}`, undefined, { key: connToken });
      assertEq(ok.status, 200, `in scope (${show(ok.body)})`);
      const tok = await core().from("api_token").select("allowed_endpoints, allowed_tiers, status").eq("id", connTokenId).single();
      assertEq(JSON.stringify(tok.data?.allowed_endpoints), JSON.stringify(["GET /accounts/{id}"]), "token carries only the consented scope");
      assertEq(JSON.stringify(tok.data?.allowed_tiers), JSON.stringify(["read"]), "read tier only");
    });

    await t.step("a fintech-side token is never accepted at the aggregator (D23)", async () => {
      const r = await agg("GET", "/admin/overview", { bearer: connToken });
      assertEq(r.status, 403, `partner token at the aggregator (${show(r.body)})`);
      assertEq(r.body.type, "partner_token_not_valid_here", "refused by credential class");
    });

    await t.step("out of scope, the connection token is refused and no money moves", async () => {
      const r = await api("POST", "/transfers",
        { source_account_id: acct, destination_account_id: acct, amount_cents: 100, description: "flow: overstep" },
        { key: connToken });
      assertEq(r.status, 403, `out of scope (${show(r.body)})`);
      assertEq(r.body.type, "insufficient_scope", "typed");
      const tr = await core().from("transfer").select("id").eq("source_account_id", acct);
      assertEq((tr.data ?? []).length, 0, "no transfer row");
    });

    await t.step("the violating request itself suspends and revokes the connection", async () => {
      // DEFECT: privacy.ts documents recordConnectionScopeViolation as "called from the router's insufficient_scope path, so the VIOLATING REQUEST ITSELF triggers suspension and revocation", but nothing calls it (auth.ts forbidden() only returns 403) — the overstepping token stays live until an operator files the violation
      const c = await core().from("connection").select("status").eq("id", connId).single();
      assertEq(c.data?.status, "revoked", "connection revoked by the overstep");
      const tok = await core().from("api_token").select("status").eq("id", connTokenId).single();
      assertEq(tok.data?.status, "revoked", "its token revoked");
    });

    await t.step("the CU files the scope violation: connection revoked, token dead", async () => {
      const r = await api("POST", `/privacy/connections/${connId}/scope-violation`, { attempted: "POST /transfers" }, { key: cu });
      assertEq(r.status, 200, `violation (${show(r.body)})`);
      const c = await core().from("connection").select("status, violation_count, revoked_at").eq("id", connId).single();
      assertEq(c.data?.status, "revoked", "connection revoked durably");
      assert(Number(c.data?.violation_count) >= 1, "violation counted");
      assert(c.data?.revoked_at, "revocation timestamp");
      const g = await api("GET", `/accounts/${acct}`, undefined, { key: connToken });
      assertEq(g.status, 401, `the token is DEAD (${show(g.body)})`);
    });
  } finally {
    if (connTokenId) {
      await core().from("api_token").update({ status: "revoked" }).eq("id", connTokenId);
    }
  }
});

// =============================================================================
// §46 CP-05 — separation revokes custody in the same act
// =============================================================================

flow("isolation: keybox access needs two people, and separating an employee revokes their custody at once", async (t) => {
  let cu = "";
  let teller = "";
  let witness = "";
  let custody = "";

  await t.step("a fintech has no reach into the CU's personnel or vault", async () => {
    const partner = await actor("partner");
    const r = await api("POST", "/hr/employees", { name: "Fintech Fred", role: "teller" }, { key: partner });
    assertEq(r.status, 403, `partner hire (${show(r.body)})`);
  });

  await t.step("the CU hires a cash-handling teller and a second keyholder, and grants the teller a key", async () => {
    cu = await actor("cu_admin");
    const a = await api("POST", "/hr/employees", { name: "Kay Keys", role: "teller", cash_handler: true }, { key: cu });
    assertEq(a.status, 201, `teller (${show(a.body)})`);
    teller = String(a.body.data.id);
    const b = await api("POST", "/hr/employees", { name: "Wes Witness", role: "head teller", cash_handler: true }, { key: cu });
    assertEq(b.status, 201, `witness (${show(b.body)})`);
    witness = String(b.body.data.id);
    const c = await api("POST", "/cash-ops/custody", { employee_id: teller, kind: "key", asset_id: `vault_${uid()}` }, { key: cu });
    assertEq(c.status, 201, `custody (${show(c.body)})`);
    custody = String(c.body.data.id);
  });

  await t.step("keybox access without a DIFFERENT second person is refused", async () => {
    const solo = await api("POST", `/cash-ops/custody/${custody}/keybox-open`, { reason: "solo" }, { key: cu });
    assertEq(solo.status, 422, `solo (${show(solo.body)})`);
    assertEq(solo.body.type, "dual_control_required", "typed");
    const twice = await api("POST", `/cash-ops/custody/${custody}/keybox-open`,
      { reason: "me twice", second_person_id: teller }, { key: cu });
    assertEq(twice.status, 422, `one keyholder twice (${show(twice.body)})`);
    const rows = await core().from("cash_keybox_access").select("id").eq("custody_id", custody);
    assertEq((rows.data ?? []).length, 0, "no keybox access logged");
  });

  await t.step("with a second person and a reason the access is logged", async () => {
    const r = await api("POST", `/cash-ops/custody/${custody}/keybox-open`,
      { reason: "replenish ATM", second_person_id: witness }, { key: cu });
    assertEq(r.status, 201, `dual (${show(r.body)})`);
    const row = await core().from("cash_keybox_access").select("second_person_id, reason").eq("id", r.body.data.id).single();
    assertEq(row.data?.second_person_id, witness, "second person on record");
  });

  await t.step("separation revokes the custody durably, in the same act", async () => {
    const r = await api("POST", `/hr/employees/${teller}/separate`, { reason: "resigned" }, { key: cu });
    assertEq(r.status, 200, `separate (${show(r.body)})`);
    assertEq(r.body.data.custodies_revoked, 1, "one custody revoked");
    const c = await core().from("cash_custody").select("revoked_at, revoke_reason").eq("id", custody).single();
    assert(c.data?.revoked_at, "revoked_at set");
    assertEq(c.data?.revoke_reason, "employee_separated", "reason");
    const e = await core().from("employee").select("status").eq("id", teller).single();
    assertEq(e.data?.status, "separated", "employee separated");
    assertEq((await event(`ev_${custody}_revoked`))?.code, "cash.custody.revoked", "revocation event");
  });

  await t.step("a separated employee can neither open the keybox nor be handed new custody", async () => {
    const open = await api("POST", `/cash-ops/custody/${custody}/keybox-open`,
      { reason: "after hours", second_person_id: witness }, { key: cu });
    assertEq(open.status, 409, `revoked custody (${show(open.body)})`);
    assertEq(open.body.type, "custody_revoked", "typed");
    const grant = await api("POST", "/cash-ops/custody", { employee_id: teller, kind: "combination" }, { key: cu });
    assertEq(grant.status, 409, `custody to a separated employee (${show(grant.body)})`);
    assertEq(grant.body.type, "custody_to_separated_employee", "typed");
  });
});
