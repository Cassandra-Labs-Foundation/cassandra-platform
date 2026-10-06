// Resolution flows: RS-02 early-warning indicators and the resolution
// posture, RS-04 targeted account freezes, RS-05 the institution-wide freeze,
// RS-06 the read-only member portal, RS-08 the resolution records package.
// (RS-03 safe mode lives in member_protection.test.ts.) The freeze journey is
// the heart of it: A FREEZE IS A SET, NOT A FLAG — releasing one authority's
// freeze must leave the others standing, and the freeze must actually stop the
// money. Replaces the stubbed unit tests in
// core/supabase/functions/api/resolution.test.ts (see ledger/resolution.md).
//
// SHARED-STATE DISCIPLINE.
//   * Freezes are on this run's own accounts and are released at the end.
//   * The institution freeze row is the flow's own order and is deleted at the
//     end (there is no release route). The core ENFORCES it (runGate refuses
//     every movement while any freeze is active), so while this flow's order is
//     active every rail on the instance is halted: do not run it concurrently
//     with other money-moving flows.
//   * The member portal state is ONE instance-wide row ("portal"): the flow
//     saves it first and restores it exactly in a finally.
//   * The resolution posture is instance-wide (latest row wins) and every EWI
//     sweep moves it. The flow's indicators are run-unique; the posture rows it
//     causes are deleted in a finally so the latest posture is what it was
//     before. Its indicators and observations are deleted too. Events stay.
import { actor, type Any, api, assert, assertEq, core, flow, personaName } from "./helpers.ts";

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const run = () => crypto.randomUUID().slice(0, 8);

async function rowById(table: string, id: string) {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data as Any;
}

async function rowsWhere(table: string, col: string, val: string): Promise<Any[]> {
  const r = await core().from(table).select("*").eq(col, val);
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data ?? [];
}

async function eventsFor(resourceType: string, id: string): Promise<Map<string, Any[]>> {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("resource_id", `${resourceType}:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  const m = new Map<string, Any[]>();
  for (const e of r.data ?? []) m.set(e.code, [...(m.get(e.code) ?? []), e]);
  return m;
}

async function entity(partner: string): Promise<string> {
  const e = await api("POST", "/entities", { type: "person", name: personaName(), date_of_birth: "1980-05-05" }, { key: partner });
  assertEq(e.status, 201, `create entity (${body(e)})`);
  return String(e.body.id);
}

async function openAccount(partner: string, entityId: string, cents: number): Promise<string> {
  const a = await api("POST", "/accounts", { entity_id: entityId, account_type: "checking", opening_deposit_cents: cents }, { key: partner });
  assertEq(a.status, 201, `open account (${body(a)})`);
  return String(a.body.id);
}

async function balanceOf(partner: string, accountId: string): Promise<number> {
  const r = await api("GET", `/accounts/${accountId}`, undefined, { key: partner });
  assertEq(r.status, 200, `account read (${body(r)})`);
  return r.body.balance;
}

function transfer(partner: string, from: string, to: string, cents: number) {
  return api("POST", "/transfers", {
    source_account_id: from, destination_account_id: to, amount_cents: cents, description: "flow: resolution",
  }, { key: partner });
}

// ------------------------------------------------------- RS-04 freezes

flow("resolution: legal process freezes a member's account → freezes from several authorities stack and resolve by precedence → releasing one leaves the others → the freeze stops the money", async (t) => {
  const partner = await actor("partner");
  const legal = await actor("cu_admin", ["bsa_counsel"]);
  let acct = "";
  let other = "";
  const freeze = (o: Record<string, unknown>) => api("POST", "/resolution/freezes", { account_ref: acct, ...o }, { key: legal });
  const release = (id: string, o: Record<string, unknown> = { release_reference: "order lifted" }) =>
    api("POST", `/resolution/freezes/${id}/release`, o, { key: legal });
  // one freeze per (account, authority, order): the reference is part of the id
  const fid = (authority: string, ref: string) => `frz_${acct}_${authority}_${ref}`;
  const accountRow = () => rowById("account", acct);
  try {
    await t.step("the partner onboards a member with $1,000 checking, and a second member to pay", async () => {
      acct = await openAccount(partner, await entity(partner), 100_000);
      other = await openAccount(partner, await entity(partner), 1_000);
      const a = await accountRow();
      assertEq(a.debits_blocked, false, "not blocked");
      assertEq(a.active_freeze_count, 0, "no freezes");
    });

    await t.step("a partner cannot freeze an account (404) and nothing is recorded", async () => {
      const res = await api("POST", "/resolution/freezes", { account_ref: acct, authority: "fraud_hold" }, { key: partner });
      assertEq(res.status, 404, `partner (${body(res)})`);
      assertEq((await rowsWhere("account_freeze", "account_ref", acct)).length, 0, "no freeze row");
    });

    await t.step("an unknown authority is refused, and a garnishment that names no legal process is refused (400)", async () => {
      const bad = await freeze({ authority: "because_i_said_so" });
      assertEq(bad.status, 400, `unknown authority (${body(bad)})`);
      const noRef = await freeze({ authority: "garnishment" });
      assertEq(noRef.status, 400, `garnishment without process (${body(noRef)})`);
      assert(JSON.stringify(noRef.body).includes("legal_process_reference"), "legal_process_reference named");
      assertEq((await rowsWhere("account_freeze", "account_ref", acct)).length, 0, "no freeze row");
      assertEq((await accountRow()).debits_blocked, false, "not blocked");
    });

    await t.step("legal applies a court order: debits AND credits blocked, the process reference stored, applied by the credential", async () => {
      const res = await freeze({ authority: "court_order", legal_process_reference: "NC-CV-2026-118", order_reference: "ORD-118" });
      assertEq(res.status, 201, `court order (${body(res)})`);
      assertEq(res.body.data.active_freezes, 1, "one freeze");
      const f = await rowById("account_freeze", fid("court_order", "NC-CV-2026-118"));
      assertEq(f.account_freeze_legal_process_reference, "NC-CV-2026-118", "process stored");
      assertEq(f.precedence, 10, "court process outranks everything");
      assert(String(f.applied_by).startsWith("tok_test_"), `applied_by is the credential (${f.applied_by})`);
      assertEq(f.provenance, "demo", "labelled demo");
      const a = await accountRow();
      assertEq(a.debits_blocked, true, "debits blocked");
      assertEq(a.credits_blocked, true, "credits blocked");
      assertEq(a.active_freeze_count, 1, "count");
      assertEq((await eventsFor("account_freeze", fid("court_order", "NC-CV-2026-118"))).get("account_freeze.applied")?.[0].payload["account_freeze.legal_process_reference"],
        "NC-CV-2026-118", "applied event names the process");
    });

    await t.step("RS-04: a debit from the court-frozen account is REFUSED and no money leaves", async () => {
      const before = await balanceOf(partner, acct);
      const res = await transfer(partner, acct, other, 10_000);
      // Regression guard (fixed 2026-10-06): nothing outside resolution.ts read account_freeze, so POST /transfers
      // moved money out of an account under a court-ordered freeze (RS-04: "blocks all debit transactions").
      // runGate now refuses every rail with 423 account_frozen.
      assert(res.status >= 400, `transfer from a frozen account was accepted (${res.status} ${body(res)})`);
      assertEq(await balanceOf(partner, acct), before, "balance unchanged");
    });

    await t.step("a fraud hold on top: two freezes, the court order GOVERNS, and the resolution is recorded", async () => {
      const res = await freeze({ authority: "fraud_hold", order_reference: "FRD-9" });
      assertEq(res.status, 201, `fraud hold (${body(res)})`);
      assertEq(res.body.data.active_freezes, 2, "two standing");
      assertEq(res.body.data.governing, "court_order", "court order governs");
      assertEq((await accountRow()).active_freeze_count, 2, "account counts two");
      const prec = (await eventsFor("account_freeze", fid("fraud_hold", "FRD-9"))).get("account_freeze.precedence.resolved")?.[0];
      assertEq(prec?.payload.governing_authority, "court_order", "precedence resolved and recorded");
    });

    await t.step("a release that names no authority is refused (400) and the account stays frozen; an unknown freeze is 404", async () => {
      const res = await release(fid("fraud_hold", "FRD-9"), {});
      assertEq(res.status, 400, `no reference (${body(res)})`);
      assertEq((await rowById("account_freeze", fid("fraud_hold", "FRD-9"))).released_at, null, "not released");
      assertEq((await accountRow()).active_freeze_count, 2, "still two");
      const unk = await release(`frz_${acct}_member_request`);
      assertEq(unk.status, 404, `unknown freeze (${body(unk)})`);
    });

    await t.step("THE BUG THIS EXISTS TO PREVENT: releasing the fraud hold leaves the court order standing", async () => {
      const res = await release(fid("fraud_hold", "FRD-9"), { release_reference: "fraud cleared FRD-9" });
      assertEq(res.status, 200, `release (${body(res)})`);
      assertEq(res.body.data.remaining_freezes, 1, "one remains");
      const a = await accountRow();
      assertEq(a.active_freeze_count, 1, "count derived from what is still standing");
      assertEq(a.debits_blocked, true, "the court order is still enforced");
      const f = await rowById("account_freeze", fid("fraud_hold", "FRD-9"));
      assert(f.released_at && String(f.released_by).startsWith("tok_test_"), "release stamped with the credential");
      assertEq(f.account_freeze_release_reference, "fraud cleared FRD-9", "release reference stored");
      const ev = (await eventsFor("account_freeze", fid("fraud_hold", "FRD-9"))).get("account_freeze.released")?.[0];
      assertEq(ev?.payload.still_blocked, true, "release event says the account is still blocked");
    });

    await t.step("releasing the LAST freeze clears the account — derived, not set", async () => {
      const res = await release(fid("court_order", "NC-CV-2026-118"), { release_reference: "order vacated NC-CV-2026-118" });
      assertEq(res.status, 200, `release (${body(res)})`);
      const a = await accountRow();
      assertEq(a.active_freeze_count, 0, "none left");
      assertEq(a.debits_blocked, false, "debits clear");
      assertEq(a.credits_blocked, false, "credits clear");
    });

    await t.step("a garnishment blocks debits but PERMITS credits: the member's payroll is accepted", async () => {
      const res = await freeze({ authority: "garnishment", legal_process_reference: "NC-GARN-1" });
      assertEq(res.status, 201, `garnishment (${body(res)})`);
      const a = await accountRow();
      assertEq(a.debits_blocked, true, "debits blocked");
      assertEq(a.credits_blocked, false, "credits allowed");
      const cr = await api("POST", `/resolution/accounts/${acct}/credit`, { amount_cents: 250_000 }, { key: legal });
      assertEq(cr.status, 201, `credit (${body(cr)})`);
      assertEq(cr.body.data.posted, true, "posted");
      assertEq(cr.body.data.governing, "garnishment", "governing authority named");
      const ev = (await eventsFor("account", acct)).get("account_freeze.credit.posted")?.[0];
      assertEq(ev?.payload.debits_blocked, true, "credit evidence records debits still blocked");
    });

    await t.step("RS-04: the credit the core says it POSTED actually lands in the member's balance", async () => {
      const bal = await balanceOf(partner, acct);
      // Regression guard (fixed 2026-10-06): postFrozenAccountCredit used to emit account_freeze.credit.posted and
      // answer posted:true with no ledger entry; it now posts @ResolutionCredits -> the account in Blnk first.
      assert(bal >= 100_000 + 250_000 - 10_000, `balance ${bal} after a $2,500 credit reported posted on a $1,000 account`);
    });

    await t.step("an OFAC block stops credits too: the credit is NOT posted, and says why", async () => {
      const res = await freeze({ authority: "ofac", order_reference: "SDN-hit" });
      assertEq(res.status, 201, `ofac (${body(res)})`);
      assertEq((await accountRow()).credits_blocked, true, "credits blocked");
      const cr = await api("POST", `/resolution/accounts/${acct}/credit`, { amount_cents: 1 }, { key: legal });
      assertEq(cr.status, 200, `refused credit (${body(cr)})`);
      assertEq(cr.body.data.posted, false, "not posted");
      assertEq(cr.body.data.reason, "credits blocked", "reason");
      const rel = await release(fid("ofac", "SDN-hit"), { release_reference: "SDN false positive" });
      assertEq(rel.status, 200, `release ofac (${body(rel)})`);
      assertEq((await accountRow()).credits_blocked, false, "credits open again under the garnishment alone");
    });

    await t.step("RS-04: a second garnishment from a DIFFERENT court is its own freeze, not an overwrite of the first", async () => {
      const res = await freeze({ authority: "garnishment", legal_process_reference: "NC-GARN-2" });
      assertEq(res.status, 201, `second garnishment (${body(res)})`);
      const live = (await rowsWhere("account_freeze", "account_ref", acct)).filter((f) => !f.released_at);
      // Regression guard (fixed 2026-10-06): the freeze id was frz_<account>_<authority>, so a second garnishment
      // upserted over the first. The legal process reference is now part of the id.
      assertEq(live.length, 2, `standing freezes (${live.map((f) => f.account_freeze_legal_process_reference).join(",")})`);
      assertEq((await accountRow()).active_freeze_count, 2, "account counts two garnishments");
    });
  } finally {
    if (acct) {
      const live = (await rowsWhere("account_freeze", "account_ref", acct)).filter((f) => !f.released_at);
      for (const f of live) await release(f.id, { release_reference: "flow cleanup" });
    }
  }
});

// ------------------------------------------------- RS-05 institution freeze

flow("resolution: an NCUA order freezes the institution → activation needs evidence → members are told and the regulator confirms → the FROZEN state halts outbound money", async (t) => {
  const partner = await actor("partner");
  const cco = await actor("cu_admin", ["cco"]);
  const r = run();
  const ordered = `NCUA-FLOW-ORD-${r}`;
  const pending = `NCUA-FLOW-PEND-${r}`;
  const id = `instfrz_${ordered}`;
  let a = "";
  let b = "";
  const order = (o: Record<string, unknown>) =>
    api("POST", "/resolution/institution-freeze", { order_reference: ordered, ordered_by: "ncua_regional_flow", ...o }, { key: cco });
  try {
    await t.step("a partner cannot freeze the institution (404) and nothing is recorded", async () => {
      const res = await api("POST", "/resolution/institution-freeze",
        { order_reference: ordered, ordered_by: "x", activation_evidence: {} }, { key: partner });
      assertEq(res.status, 404, `partner (${body(res)})`);
      assertEq(await rowById("institution_freeze", id), null, "no row");
    });

    await t.step("an order with no reference is refused; ACTIVATION with no evidence of how it was applied is refused (400)", async () => {
      const noRef = await api("POST", "/resolution/institution-freeze", { ordered_by: "ncua" }, { key: cco });
      assertEq(noRef.status, 400, `no order (${body(noRef)})`);
      const noEv = await order({});
      assertEq(noEv.status, 400, `no evidence (${body(noEv)})`);
      assert(JSON.stringify(noEv.body).includes("activation_evidence"), "activation_evidence named");
      assertEq(await rowById("institution_freeze", id), null, "no row");
    });

    await t.step("an order recorded but not yet activated: stored, nothing activated, no activation evidence", async () => {
      const res = await api("POST", "/resolution/institution-freeze",
        { order_reference: pending, ordered_by: "ncua_regional_flow", activate: false }, { key: cco });
      assertEq(res.status, 201, `pending order (${body(res)})`);
      assertEq(res.body.data.activated, false, "not activated");
      const row = await rowById("institution_freeze", `instfrz_${pending}`);
      assertEq(row.activated_at, null, "activated_at null");
      assert(!(await eventsFor("institution_freeze", `instfrz_${pending}`)).has("institution_freeze.activated"), "no activation event");
    });

    await t.step("activated with evidence, the member notice published and the regulator's confirmation recorded", async () => {
      const res = await order({
        activation_evidence: { rails_disabled: ["ach", "wire", "card"] }, notice_template_id: "ntpl_freeze_flow",
        channels: ["website", "email"], regulator_reference: `NCUA-CONF-${r}`,
      });
      assertEq(res.status, 201, `activate (${body(res)})`);
      assertEq(res.body.data.activated, true, "activated");
      assertEq(res.body.data.notice_published, true, "notice published");
      const row = await rowById("institution_freeze", id);
      assert(row.activated_at, "activated_at");
      assertEq(row.activation_evidence?.rails_disabled?.length, 3, "evidence stored");
      assert(row.notice_published_at, "notice published at");
      assertEq(row.regulator_reference, `NCUA-CONF-${r}`, "regulator reference");
      assertEq(row.provenance, "demo", "labelled demo");
      const ev = await eventsFor("institution_freeze", id);
      for (const c of ["institution_freeze.activated", "institution_freeze.activation_evidence", "institution_freeze.notice.published", "institution_freeze.notice_record", "institution_freeze.regulator.confirmed"]) {
        assert(ev.has(c), `${c} emitted`);
      }
      assertEq(ev.get("institution_freeze.notice_record")?.[0].payload.channels?.length, 2, "notice channels recorded");
    });

    await t.step("RS-05: while the institution is FROZEN, a member's outbound transfer is refused and no money moves", async () => {
      a = await openAccount(partner, await entity(partner), 10_000);
      b = await openAccount(partner, await entity(partner), 1_000);
      const before = await balanceOf(partner, a);
      const res = await transfer(partner, a, b, 1_000);
      // Regression guard (fixed 2026-10-06, user decision to enforce): nothing read core.institution_freeze, so an
      // activated NCUA freeze (RS-05: "halting all outbound and new-account transactions") left every rail open.
      // runGate now refuses every movement with 423 institution_frozen. (Account opening is not gated by runGate.)
      assert(res.status >= 400, `transfer during an institution freeze was accepted (${res.status} ${body(res)})`);
      assertEq(await balanceOf(partner, a), before, "balance unchanged");
    });
  } finally {
    // the flow's own orders; no release route exists, and a live FROZEN row must not outlive the flow
    const d = await core().from("institution_freeze").delete().in("id", [id, `instfrz_${pending}`]);
    if (d.error) console.error(`cleanup institution_freeze: ${d.error.message}`);
  }
});

// ---------------------------------------------------- RS-06 member portal

flow("resolution: with the core down the member portal goes read-only on a dated snapshot → every member access is logged → the CCO switches it back", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  const noRole = await actor("cu_admin");
  const cco = await actor("cu_admin", ["cco"]);
  const r = run();
  const member = `mem_flow_${r}`;
  // a run-unique as-of second so the evidence is unmistakably ours
  const snapshot = new Date(Date.UTC(2026, 6, 18, 23, Math.floor(Math.random() * 60), Math.floor(Math.random() * 60))).toISOString();
  const prior = await rowById("member_portal_state", "portal");
  const sameInstant = (a: string | null, b: string | null) => (a && b ? new Date(a).getTime() === new Date(b).getTime() : a === b);
  try {
    await t.step("a partner cannot change the portal (404), and read-only access with no dated snapshot is refused (400); state unchanged", async () => {
      const p = await api("POST", "/resolution/member-portal", { core_unavailable: true, snapshot_as_of: snapshot }, { key: partner });
      assertEq(p.status, 404, `partner (${body(p)})`);
      const res = await api("POST", "/resolution/member-portal", { core_unavailable: true, claims_template_id: "claims_flow" }, { key: ops });
      assertEq(res.status, 400, `no snapshot (${body(res)})`);
      assert(JSON.stringify(res.body).includes("snapshot_as_of"), "snapshot_as_of named");
      const now = await rowById("member_portal_state", "portal");
      assert(sameInstant(now?.snapshot_as_of ?? null, prior?.snapshot_as_of ?? null), "snapshot untouched");
    });

    await t.step("operations put the portal in read-only mode on the snapshot: state stored with its claims template", async () => {
      const res = await api("POST", "/resolution/member-portal",
        { core_unavailable: true, claims_template_id: `claims_flow_${r}`, snapshot_as_of: snapshot }, { key: ops });
      assertEq(res.status, 201, `activate (${body(res)})`);
      const s = await rowById("member_portal_state", "portal");
      assert(s.readonly_activated_at, "read-only activated");
      assert(sameInstant(s.snapshot_as_of, snapshot), "serves our snapshot");
      assertEq(s.member_portal_claims_template_id, `claims_flow_${r}`, "claims template");
      assertEq(s.member_portal_core_unavailable, true, "core marked unavailable");
    });

    await t.step("RS-06: THIS activation is evidenced (member_portal.readonly.activated naming our snapshot)", async () => {
      const r2 = await core().from("event").select("id, payload").eq("code", "member_portal.readonly.activated");
      assert(!r2.error, `event read: ${r2.error?.message}`);
      // Regression guard (fixed 2026-10-06): the event id was the constant `ev_portal_ro` with ignoreDuplicates,
      // so only the first activation in the instance's life was ever evidenced. Each switch now has its own id.
      assert((r2.data ?? []).some((e: Any) => sameInstant(e.payload?.snapshot_as_of ?? null, snapshot)),
        `no activation event for this snapshot (${(r2.data ?? []).length} activation event(s) exist in total)`);
    });

    await t.step("a member reads their balance: served the SNAPSHOT, and the access is logged — who saw what, as of when", async () => {
      const res = await api("POST", "/resolution/member-portal/access", { member_ref: member }, { key: ops });
      assertEq(res.status, 201, `access (${body(res)})`);
      assert(sameInstant(res.body.data.snapshot_as_of, snapshot), "snapshot served");
      const rows = await rowsWhere("member_portal_access", "member_ref", member);
      assertEq(rows.length, 1, "one access row");
      assert(sameInstant(rows[0].snapshot_served_as_of, snapshot), "as-of recorded on the access");
      assertEq(rows[0].provenance, "demo", "labelled demo");
      const ev = await eventsFor("member_portal_access", rows[0].id);
      assertEq(ev.get("member_portal.access.logged")?.[0].payload["member.id"], member, "access logged");
      assert(sameInstant(ev.get("member_portal.snapshot_served")?.[0].payload.snapshot_as_of ?? null, snapshot), "snapshot served evidenced");
    });

    await t.step("RS-06: leaving read-only mode needs the CCO — a staff credential without the role is refused (403)", async () => {
      const res = await api("POST", "/resolution/member-portal", { activate: false }, { key: noRole });
      // Regression guard (fixed 2026-10-06): postMemberPortalState had no role gate; RS-06 says read-only mode
      // "requires explicit CCO authorization to deactivate". Deactivation now needs the cco role.
      assertEq(res.status, 403, `no-role deactivation (${body(res)})`);
    });

    await t.step("the CCO switches read-only off: a member access is now a 404 and nothing is logged", async () => {
      const res = await api("POST", "/resolution/member-portal", { activate: false }, { key: cco });
      assertEq(res.status, 201, `deactivate (${body(res)})`);
      assertEq((await rowById("member_portal_state", "portal")).readonly_activated_at, null, "read-only off");
      const acc = await api("POST", "/resolution/member-portal/access", { member_ref: member }, { key: ops });
      assertEq(acc.status, 404, `access when not read-only (${body(acc)})`);
      assertEq((await rowsWhere("member_portal_access", "member_ref", member)).length, 1, "still one access row");
    });
  } finally {
    // restore the instance-wide portal row exactly as it was
    if (prior) {
      const { created_at: _c, ...rest } = prior;
      const u = await core().from("member_portal_state").upsert(rest, { onConflict: "id" });
      if (u.error) console.error(`restore member_portal_state: ${u.error.message}`);
    } else {
      const d = await core().from("member_portal_state").delete().eq("id", "portal");
      if (d.error) console.error(`cleanup member_portal_state: ${d.error.message}`);
    }
  }
});

// ------------------------------------------------------- RS-02 EWI posture

flow("resolution: early-warning indicators are swept → no threshold, no verdict → each interval sets the posture from its breach count (no damping, decided 2026-10-06) → the CEO is told on the CHANGE, not on every sweep", async (t) => {
  const partner = await actor("partner");
  const risk = await actor("cu_admin", ["cco"]);
  const r = run();
  const started = new Date(Date.now() - 5_000).toISOString();
  const ind = { out: `outflow_${r}`, lar: `lar_${r}`, npl: `npl_${r}`, none: `uncfg_${r}` };
  const created = Object.values(ind).map((i) => `ewi_${i}`);
  let n = 0;
  const sweep = async (obs: [string, number][]) => {
    const period = `flow-${r}-${++n}`;
    const res = await api("POST", "/resolution/ewi/sweep",
      { period, observations: obs.map(([indicator_id, value]) => ({ indicator_id, value })) }, { key: risk });
    assertEq(res.status, 201, `sweep ${period} (${body(res)})`);
    return { ...res.body.data, period };
  };
  const latestPosture = async () => {
    const p = await core().from("resolution_posture").select("*").order("changed_at", { ascending: false }).limit(1).maybeSingle();
    assert(!p.error, `posture read: ${p.error?.message}`);
    return p.data as Any;
  };
  const myPostures = async () => {
    const p = await core().from("resolution_posture").select("*").gte("changed_at", started).like("changed_by", "tok_test_%")
      .order("changed_at", { ascending: true });
    assert(!p.error, `posture read: ${p.error?.message}`);
    return (p.data ?? []) as Any[];
  };
  const obsOf = (indicator: string) => rowsWhere("ewi_observation", "indicator_id", `ewi_${indicator}`);
  const breachedEvents = async (indicator: string) => {
    let c = 0;
    for (const o of await obsOf(indicator)) c += (await eventsFor("ewi_observation", o.id)).get("ewi.threshold.breached")?.length ?? 0;
    return c;
  };
  try {
    await t.step("a partner cannot configure an indicator (404); an indicator with no id is refused (400)", async () => {
      const p = await api("POST", "/resolution/ewi/indicators", { indicator_id: ind.out }, { key: partner });
      assertEq(p.status, 404, `partner (${body(p)})`);
      const bad = await api("POST", "/resolution/ewi/indicators", { name: "nameless" }, { key: risk });
      assertEq(bad.status, 400, `no id (${body(bad)})`);
      assertEq(await rowById("ewi_indicator", `ewi_${ind.out}`), null, "no indicator row");
    });

    await t.step("risk engineering configures three thresholded indicators and one with NO threshold (institutional, nullable)", async () => {
      for (const [id, thr] of [[ind.out, { breach_at: 300 }], [ind.lar, { breach_at: 700 }], [ind.npl, { breach_at: 200 }], [ind.none, null]] as const) {
        const res = await api("POST", "/resolution/ewi/indicators", { indicator_id: id, name: id, thresholds: thr, schedule: "daily" }, { key: risk });
        assertEq(res.status, 201, `indicator ${id} (${body(res)})`);
      }
      assertEq((await rowById("ewi_indicator", `ewi_${ind.none}`)).ewi_thresholds, null, "no threshold stored as null, not zero");
      assertEq((await rowById("ewi_indicator", `ewi_${ind.out}`)).ewi_thresholds.breach_at, 300, "threshold stored");
    });

    await t.step("RS-02: 999,999 against NO threshold is no verdict — breached is NULL and nothing alerts", async () => {
      const s = await sweep([[ind.none, 999_999], [ind.out, 100]]);
      assertEq(s.evaluated, 2, "both evaluated");
      assertEq(s.breached, 0, "no breaches");
      const o = (await obsOf(ind.none))[0];
      assertEq(o.breached, null, "no verdict");
      assertEq(await breachedEvents(ind.none), 0, "no threshold.breached");
      assertEq((await obsOf(ind.out))[0].breached, false, "a configured indicator under its threshold is a FALSE verdict");
      assertEq((await eventsFor("ewi_observation", `ewisweep_${s.period}`)).get("ewi.sweep.completed")?.[0].payload.evaluated, 2,
        "sweep completion evidenced");
    });

    await t.step("baseline: a second clean interval — the posture is NORMAL", async () => {
      await sweep([[ind.out, 120]]);
      assertEq((await latestPosture()).resolution_posture_current, "normal", "normal after two clean intervals");
    });

    await t.step("the outflow indicator breaches (400 ≥ 300): alerted once, as a first breach", async () => {
      const s = await sweep([[ind.out, 400]]);
      assertEq(s.breached, 1, "one breach");
      assertEq(await breachedEvents(ind.out), 1, "ewi.threshold.breached once");
    });

    // User decision 2026-10-06: KEEP single-sweep posture changes (no two-interval damping) — one sweep moves it up AND down.
    await t.step("RS-02: ONE breached interval moves the posture to WATCH — the change evidenced, the CEO summary sent", async () => {
      const p = await latestPosture();
      assertEq(p.resolution_posture_current, "watch", "watch after a single breached interval");
      assert(String(p.changed_by).startsWith("tok_test_"), "changed by our credential");
      const ev = await eventsFor("resolution_posture", p.id);
      assertEq(ev.get("resolution_posture.changed")?.[0].payload["resolution_posture.current"], "watch", "posture change evidenced");
      assert(ev.has("ewi.ceo_summary.sent"), "CEO summary on the change");
    });

    await t.step("the next interval still breached: still WATCH, no new posture, and the breach is NOT re-alerted", async () => {
      const before = (await myPostures()).length;
      await sweep([[ind.out, 450]]);
      assertEq((await myPostures()).length, before, "no posture row");
      assertEq((await latestPosture()).resolution_posture_current, "watch", "still watch");
      assertEq(await breachedEvents(ind.out), 1, "an already-breached indicator does not re-alert");
      const obs = (await obsOf(ind.out)).sort((a, b) => Number(a.ewi_value) - Number(b.ewi_value));
      const second = obs.find((o) => Number(o.ewi_value) === 450);
      assertEq(second?.ewi_prior_breach_state, true, "it knew it was already breached");
      assertEq(second?.ewi_trend, "worsening", "trend");
      assertEq(obs.length, 4, "every observation is its own row (no id collision)");
    });

    await t.step("re-observing the same breached state changes nothing: no new posture, no new CEO summary", async () => {
      const before = (await myPostures()).length;
      await sweep([[ind.out, 460]]);
      assertEq((await myPostures()).length, before, "no posture row");
      assertEq((await latestPosture()).resolution_posture_current, "watch", "still watch");
    });

    await t.step("three indicators breached in ONE interval: HEIGHTENED at once, with its own CEO summary; a repeat changes nothing", async () => {
      const three: [string, number][] = [[ind.out, 470], [ind.lar, 800], [ind.npl, 300]];
      const s = await sweep(three);
      assertEq(s.breached, 3, "three breached");
      const p = await latestPosture();
      assertEq(p.resolution_posture_current, "heightened", "heightened after one interval");
      assert((await eventsFor("resolution_posture", p.id)).has("ewi.ceo_summary.sent"), "CEO told of the escalation");
      const before = (await myPostures()).length;
      await sweep(three);
      assertEq((await myPostures()).length, before, "no posture row on the repeat");
      assertEq(await breachedEvents(ind.lar), 1, "lar alerted once over two intervals");
    });

    await t.step("ONE clean interval steps the posture straight back down to NORMAL, and the change is evidenced", async () => {
      await sweep([[ind.out, 100], [ind.lar, 100], [ind.npl, 100]]);
      const p = await latestPosture();
      assertEq(p.resolution_posture_current, "normal", "normal after a single clean interval");
      const ev = await eventsFor("resolution_posture", p.id);
      assertEq(ev.get("resolution_posture.changed")?.[0].payload.from, "heightened", "step-down evidenced from heightened");
    });
  } finally {
    // the posture is instance-wide: remove the rows this flow caused, so the latest is what it was
    const mine = (await myPostures().catch(() => [])).map((p) => p.id);
    if (mine.length) {
      const d = await core().from("resolution_posture").delete().in("id", mine);
      if (d.error) console.error(`cleanup resolution_posture: ${d.error.message}`);
    }
    const o = await core().from("ewi_observation").delete().in("indicator_id", created);
    if (o.error) console.error(`cleanup ewi_observation: ${o.error.message}`);
    const i = await core().from("ewi_indicator").delete().in("id", created);
    if (i.error) console.error(`cleanup ewi_indicator: ${i.error.message}`);
  }
});

// ----------------------------------------------------- RS-08 records package

flow("resolution: the records package is built against a manifest → only a matching checksum chain completes it → completed and failed never coexist → a sealed package is write-once", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  const r = run();
  const pkg = (o: Record<string, unknown>) => api("POST", "/resolution/records-packages", o, { key: ops });
  const row = (m: string) => rowById("records_package", `recpkg_${m}`);
  const ev = (m: string) => eventsFor("records_package", `recpkg_${m}`);
  const m = { none: `man_flow_none_${r}`, bad: `man_flow_bad_${r}`, good: `man_flow_good_${r}`, retry: `man_flow_retry_${r}` };
  const NO_ROW = "no records_package row for this manifest (see the RECORDED step)";

  await t.step("a partner cannot build a package (404); a package with no manifest is refused (400)", async () => {
    const p = await api("POST", "/resolution/records-packages", { manifest_id: m.good }, { key: partner });
    assertEq(p.status, 404, `partner (${body(p)})`);
    const res = await pkg({ snapshot_as_of: "2026-07-18T23:59:59.000Z" });
    assertEq(res.status, 400, `no manifest (${body(res)})`);
    assertEq(await row(m.good), null, "no row");
  });

  await t.step("RS-08: a package with NO checksum chain FAILS rather than completing", async () => {
    const res = await pkg({ manifest_id: m.none });
    assertEq(res.status, 200, `no chain (${body(res)})`);
    assertEq(res.body.data.verified, false, "not verified");
    assertEq(res.body.data.reason, "no checksum chain produced", "reason");
    const e = await ev(m.none);
    assert(e.has("records_package.build.started"), "build started");
    assertEq(e.get("records_package.verification.failed")?.[0].payload["records_package.failure_reason"], "no checksum chain produced", "failure evidenced");
    assert(!e.has("records_package.completed"), "never completed");
  });

  await t.step("RS-08: a chain whose root does not match FAILS, and the reason names both roots", async () => {
    const res = await pkg({ manifest_id: m.bad, checksum_chain: { root: "deadbeef" }, expected_checksum: "cafebabe" });
    assertEq(res.status, 200, `mismatch (${body(res)})`);
    assertEq(res.body.data.verified, false, "not verified");
    assert(String(res.body.data.reason).includes("deadbeef") && String(res.body.data.reason).includes("cafebabe"), "both roots named");
    const e = await ev(m.bad);
    assert(e.has("records_package.verification.failed"), "failure evidenced");
    assert(!e.has("records_package.completed"), "never completed");
  });

  await t.step("a matching chain completes: snapshot and completion evidenced with the chain", async () => {
    const res = await pkg({
      manifest_id: m.good, snapshot_id: `snap_${r}`, snapshot_as_of: "2026-07-18T23:59:59.000Z",
      checksum_chain: { root: "cafebabe", links: 412 }, expected_checksum: "cafebabe",
    });
    assertEq(res.status, 201, `complete (${body(res)})`);
    assertEq(res.body.data.verified, true, "verified");
    const e = await ev(m.good);
    assert(e.has("records_package.snapshot.completed"), "snapshot completed");
    assertEq(e.get("records_package.completed")?.[0].payload["records_package.checksum_chain"]?.root, "cafebabe", "completion carries the chain");
    assertEq(e.get("records_package.completed")?.[0].payload["records_package.snapshot_id"], `snap_${r}`, "manifest traceable to its snapshot");
  });

  await t.step("RS-08: every build is RECORDED — the packages exist with their verdicts (two failed, one completed with its chain)", async () => {
    const none = await row(m.none);
    const bad = await row(m.bad);
    const good = await row(m.good);
    // Regression guard (fixed 2026-10-06): postRecordsPackage never set `purpose` (NOT NULL on the table shared with
    // the cash-ops exam exports) and ignored the upsert error, so no RS-08 package was ever stored while the API
    // answered verified:true. It now sets purpose 'resolution' and fails loudly on any write error.
    assert(none && bad && good, `rows: none=${!!none} bad=${!!bad} good=${!!good}`);
    assertEq(none.completed_at, null, "no-chain package not completed");
    assert(none.verification_failed_at, "no-chain package failed");
    assertEq(none.records_package_failure_reason, "no checksum chain produced", "reason stored");
    assertEq(bad.completed_at, null, "mismatched package not completed");
    assert(bad.verification_failed_at, "mismatched package failed");
    assert(good.completed_at, "matching package completed");
    assertEq(good.verification_failed_at, null, "not failed");
    assertEq(good.records_package_checksum_chain?.root, "cafebabe", "chain stored");
    assertEq(good.records_package_snapshot_id, `snap_${r}`, "snapshot id stored");
    assertEq(good.provenance, "demo", "labelled demo");
  });

  await t.step("RS-08: a SEALED package is write-once — resubmitting its manifest with another chain is refused and nothing about it changes", async () => {
    const before = await row(m.good);
    const res = await pkg({ manifest_id: m.good, snapshot_id: `snap_tampered_${r}`, checksum_chain: { root: "deadbeef" }, expected_checksum: "cafebabe" });
    // Regression guard (fixed 2026-10-06): postRecordsPackage upserted by manifest with no sealed check, so a
    // resubmitted completed manifest was reprocessed and a verification failure logged against it. Now 409.
    assert(!(await ev(m.good)).has("records_package.verification.failed"), "failure evidence logged against a sealed package");
    assertEq(res.status, 409, `resubmission of a sealed package (${body(res)})`);
    const after = await row(m.good);
    assert(before && after, NO_ROW);
    assertEq(after.records_package_snapshot_id, before.records_package_snapshot_id, "sealed snapshot id unchanged");
    assertEq(after.records_package_checksum_chain?.root, "cafebabe", "sealed chain unchanged");
  });

  await t.step("RS-08: a package that FAILED and is rebuilt with a good chain — the answer and the record agree", async () => {
    const first = await pkg({ manifest_id: m.retry });
    assertEq(first.status, 200, `first build fails (${body(first)})`);
    const res = await pkg({ manifest_id: m.retry, checksum_chain: { root: "cafebabe" }, expected_checksum: "cafebabe" });
    const p = await row(m.retry);
    const completedEvent = (await ev(m.retry)).has("records_package.completed");
    assert(p, NO_ROW);
    // A rebuild must not leave the answer, the event and the record disagreeing (ck_package_not_both forbids a
    // row both completed and failed). The core completes it and clears the failure stamp in the same write; a
    // refusal would also be acceptable as long as all three agree.
    if (res.status === 201) {
      assert(p.completed_at, `answered verified:true and logged completed=${completedEvent}, but the record is not complete (failed_at ${p.verification_failed_at})`);
      assertEq(p.verification_failed_at, null, "a completed package carries no failure stamp");
    } else {
      assert(!completedEvent, `refused (${res.status}) yet records_package.completed was logged`);
      assertEq(p.completed_at, null, "refused rebuild leaves it not complete");
    }
  });
});
