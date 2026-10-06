// Internal-control flows: the institution's own control environment as its
// staff run it — IC-02 separation of duties at grant time, IC-04 reconciliation
// ageing, IS-03 asset ownership, IS-10 red-flag cases and the ruleset that
// learns from them, CP-08/CP-09 capital contingency actions, DF-06 affiliate
// limits, and the ops-security registers (BC-07 backups and restore tests,
// IS-05 vulnerability triage, IS-13 AI governance, IS-14 SIEM alerts).
//
// Ports the user-observable behaviour of
// core/supabase/functions/api/tail.test.ts (IC/IS/CP/DF half; the EPS half is
// in eps_controls.test.ts) and the non-access half of ops_security.test.ts
// (see ledger/tail.md and ledger/ops_security.md).
//
// SHARED-STATE DISCIPLINE. Every role, subject, reconciling item, asset,
// account ref, affiliate, backup, finding and AI tool here is run-unique, and
// assertions are on THOSE rows. Two writes are instance-wide by design:
//   * an SoD rule joins the matrix every grant is checked against — the roles
//     in it are run-unique, so no other subject can ever match it; the rules
//     are deleted at the end of the flow (configuration, not evidence);
//   * the red-flag ruleset is versioned by row count, so posting one is the
//     routine "next version" the live tier also posts. It is left in place:
//     deleting it would make the next poster's count-derived id collide.
// The capital position used for CP-09 is dated in the 1900s (never the latest)
// and deleted at the end, as capital.test.ts does.
import { actor, type Any, api, assert, assertEq, core, flow } from "./helpers.ts";

const RUN = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
let seq = 0;
/** a run-unique id with a readable prefix */
const rid = (p: string) => `${p}_flow_${RUN}_${++seq}`;

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const DAY = 86_400_000;
const ms = (s: unknown) => Date.parse(String(s));

async function rowById(table: string, id: string): Promise<Any> {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data;
}

/** events the core wrote about one resource (`<type>:<id>`) */
async function eventsFor(resourceType: string, id: string): Promise<Any[]> {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("resource_id", `${resourceType}:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  return r.data ?? [];
}
const codesFor = async (resourceType: string, id: string) =>
  (await eventsFor(resourceType, id)).map((e) => String(e.code));

/** a partner is kept off an internal route: 404 (self-gate) or 403 (route gate) */
function refusedToPartner(r: { status: number; body: Any }, what: string) {
  assert(r.status === 404 || r.status === 403, `${what}: partner refused (got ${r.status} ${body(r)})`);
}

// ============================================================ IC-02

flow("internal_controls: IC-02 — the admin writes an SoD rule; a conflicting grant is BLOCKED at grant time, the same role is clear for someone else, and a conflict is accepted only with an approved, expiring compensating control", async (t) => {
  const admin = await actor("cu_admin");
  const partner = await actor("partner");
  const INIT = `pay_init_${RUN}`;
  const APPR = `pay_appr_${RUN}`;
  const VEND = `vendor_admin_${RUN}`;
  const alice = rid("usr_alice");
  const bob = rid("usr_bob");
  const carol = rid("usr_carol");
  const rules: string[] = [];
  const grantId = (subject: string, role: string) => `grant_${subject}_${role}`;
  const grant = (subject: string, role: string, extra: Record<string, unknown> = {}, key = admin) =>
    api("POST", "/internal/role-grants", { subject_ref: subject, role_id: role, entitlements: [`${role}.do`], ...extra }, { key });

  try {
    await t.step("a partner cannot write the SoD matrix or grant a role, and nothing is stored", async () => {
      refusedToPartner(await api("POST", "/internal/sod-rules", { role_a: INIT, role_b: APPR, rationale: "x" }, { key: partner }), "sod rule");
      refusedToPartner(await grant(alice, INIT, {}, partner), "role grant");
      assertEq(await rowById("sod_rule", `sod_${INIT}__${APPR}`), null, "no rule");
      assertEq(await rowById("access_role_grant", grantId(alice, INIT)), null, "no grant");
    });

    await t.step("a rule needs two DISTINCT roles and a risk rationale", async () => {
      const same = await api("POST", "/internal/sod-rules", { role_a: INIT, role_b: INIT, rationale: "r" }, { key: admin });
      assertEq(same.status, 400, `same role twice (${body(same)})`);
      const noWhy = await api("POST", "/internal/sod-rules", { role_a: INIT, role_b: APPR }, { key: admin });
      assertEq(noWhy.status, 400, `no rationale (${body(noWhy)})`);
      assertEq(await rowById("sod_rule", `sod_${INIT}__${APPR}`), null, "nothing stored");
    });

    await t.step("the admin records the initiate/approve conflict: the matrix is versioned and the update is an event", async () => {
      const r = await api("POST", "/internal/sod-rules", {
        role_a: INIT, role_b: APPR, conflict: "initiate and approve the same payment",
        rationale: "one person could move money with no second pair of eyes",
      }, { key: admin });
      assertEq(r.status, 201, `rule (${body(r)})`);
      const id = r.body.data.id;
      rules.push(id);
      const row = await rowById("sod_rule", id);
      assertEq(row.role_a, INIT, "role a");
      assertEq(row.role_b, APPR, "role b");
      assertEq(row.sod_risk_rationale, "one person could move money with no second pair of eyes", "rationale");
      assertEq(row.provenance, "demo", "demo evidence");
      const ev = await eventsFor("sod_rule", id);
      const upd = ev.find((e) => e.code === "authority.matrix.updated");
      assert(upd, "authority.matrix.updated emitted");
      assertEq(upd.payload["sod.matrix_version"], row.sod_matrix_version, "event carries the matrix version");
    });

    await t.step("Alice is granted payment initiation: the check runs and is clear", async () => {
      const r = await grant(alice, INIT);
      assertEq(r.status, 201, `grant initiator (${body(r)})`);
      const row = await rowById("access_role_grant", grantId(alice, INIT));
      assert(row.granted_at, "granted");
      assertEq(row.sod_check_result, "clear", "clear");
      assert((await codesFor("access_role_grant", grantId(alice, INIT))).includes("sod.check_result"), "check result recorded");
    });

    await t.step("IC-02: granting Alice payment APPROVAL is blocked at grant time — 409, stored blocked, never granted", async () => {
      const r = await grant(alice, APPR);
      assertEq(r.status, 409, `conflicting grant (${body(r)})`);
      assertEq(r.body.type, "sod_conflict", "typed refusal");
      const row = await rowById("access_role_grant", grantId(alice, APPR));
      assertEq(row.granted_at, null, "never granted");
      assert(row.blocked_at, "blocked_at stamped");
      assertEq(row.sod_check_result, "conflict", "conflict recorded");
      assertEq(row.sod_conflict_with, INIT, "names the role it conflicts with");
      const codes = await codesFor("access_role_grant", grantId(alice, APPR));
      for (const c of ["sod.grant.blocked", "sod.conflict.detected", "sod.violation.logged"]) {
        assert(codes.includes(c), `${c} emitted`);
      }
      assert(!codes.includes("sod.compensating_control.approved"), "no compensating control");
    });

    await t.step("the SAME approver role is clear for Bob, who holds no initiator role — the conflict is the pair", async () => {
      const r = await grant(bob, APPR);
      assertEq(r.status, 201, `bob approver (${body(r)})`);
      const row = await rowById("access_role_grant", grantId(bob, APPR));
      assertEq(row.sod_check_result, "clear", "clear for a different subject");
      assert(row.granted_at, "granted");
    });

    await t.step("a BLOCKED role does not count as held: with approver↔vendor-admin also in the matrix, Alice still gets vendor admin", async () => {
      const r = await api("POST", "/internal/sod-rules", {
        role_a: APPR, role_b: VEND, rationale: "pay a vendor you created",
      }, { key: admin });
      assertEq(r.status, 201, `second rule (${body(r)})`);
      rules.push(r.body.data.id);
      const g = await grant(alice, VEND);
      assertEq(g.status, 201, `vendor admin for alice (${body(g)})`);
      assertEq((await rowById("access_role_grant", grantId(alice, VEND))).sod_check_result, "clear", "the blocked approver role was not held");
    });

    await t.step("a compensating control with no approver does not unblock: 409, still blocked", async () => {
      assertEq((await grant(carol, INIT)).status, 201, "carol initiator");
      const r = await grant(carol, APPR, { compensating_control: "we'll watch it" });
      assertEq(r.status, 409, `unapproved compensating control (${body(r)})`);
      const row = await rowById("access_role_grant", grantId(carol, APPR));
      assertEq(row.granted_at, null, "not granted");
      assertEq(row.sod_compensating_control, null, "the hope is not recorded as a control");
    });

    await t.step("an unavoidable conflict is accepted WITH an approved compensating control — and the acceptance expires in 90 days", async () => {
      const r = await grant(carol, APPR, {
        compensating_control: "all payments over $10k reviewed by internal audit weekly",
        compensating_approved_by: "cro_flow",
      });
      assertEq(r.status, 201, `compensated grant (${body(r)})`);
      assertEq(r.body.data.compensated, true, "reported as compensated");
      const row = await rowById("access_role_grant", grantId(carol, APPR));
      assert(row.granted_at, "granted");
      assertEq(row.blocked_at, null, "no longer blocked");
      assertEq(row.sod_check_result, "conflict", "still recorded as a conflict");
      assertEq(row.compensating_approved_by, "cro_flow", "approver recorded");
      assert(Math.abs(ms(row.compensating_expires_at) - ms(row.granted_at) - 90 * DAY) < 60_000, "expires 90 days after the grant");
      assert((await codesFor("access_role_grant", grantId(carol, APPR))).includes("sod.compensating_control.approved"), "approval event");
    });
  } finally {
    if (rules.length) {
      const d = await core().from("sod_rule").delete().in("id", rules);
      if (d.error) console.error(`cleanup sod_rule ${rules.join(",")}: ${d.error.message}`);
    }
  }
});

// ============================================================ IC-04

flow("internal_controls: IC-04 — an accountant books a reconciling item; it escalates only when it AGES to 30 days, and only with the research behind it; resolution closes it", async (t) => {
  const acct = await actor("cu_admin");
  const partner = await actor("partner");
  const fresh = rid("recon_daily");
  const aged = rid("recon_month");
  const post = (o: Record<string, unknown>, key = acct) => api("POST", "/internal/recon-items", o, { key });

  await t.step("a partner cannot book reconciling items; an item with no owner is refused", async () => {
    refusedToPartner(await post({ recon_ref: fresh, owner: "acct_1" }, partner), "recon item");
    const noOwner = await post({ recon_ref: fresh, cadence: "daily", variance_cents: 1250 });
    assertEq(noOwner.status, 400, `no owner (${body(noOwner)})`);
    assertEq(await rowById("recon_item", `reconitem_${fresh}`), null, "nothing stored");
  });

  await t.step("a one-day-old $12.50 variance is booked but NOT escalated — age is the control", async () => {
    const r = await post({ recon_ref: fresh, cadence: "daily", variance_cents: 1250, owner: "acct_flow", age_days: 1 });
    assertEq(r.status, 201, `fresh item (${body(r)})`);
    assertEq(r.body.data.escalated, false, "not escalated");
    const row = await rowById("recon_item", `reconitem_${fresh}`);
    assertEq(Number(row.variance_cents), 1250, "variance");
    assertEq(row.recon_item_owner, "acct_flow", "owner");
    assertEq(row.escalated_at, null, "no escalation stamp");
    const codes = await codesFor("recon_item", `reconitem_${fresh}`);
    assert(codes.includes("recon.daily.completed"), "daily recon recorded");
    assert(!codes.includes("recon.item.escalated"), "no escalation event");
  });

  await t.step("at 30 days with nothing researched the escalation is refused — escalating a mystery", async () => {
    const r = await post({ recon_ref: aged, cadence: "monthly", variance_cents: 40_000, owner: "acct_flow", age_days: 30 });
    assertEq(r.status, 400, `no research (${body(r)})`);
    assert((r.body.errors ?? []).some((e: Any) => e.field === "research_notes"), "names research_notes");
    assertEq(await rowById("recon_item", `reconitem_${aged}`), null, "nothing stored");
  });

  await t.step("with the research it escalates, and the escalation carries the threshold", async () => {
    const r = await post({
      recon_ref: aged, cadence: "monthly", variance_cents: 40_000, owner: "acct_flow", age_days: 30,
      research_notes: "traced to an unposted ACH return from March",
    });
    assertEq(r.status, 201, `escalated item (${body(r)})`);
    assertEq(r.body.data.escalated, true, "escalated");
    const row = await rowById("recon_item", `reconitem_${aged}`);
    assert(row.escalated_at, "escalated_at stamped");
    assertEq(row.recon_research_notes, "traced to an unposted ACH return from March", "research stored");
    const esc = (await eventsFor("recon_item", `reconitem_${aged}`)).find((e) => e.code === "recon.item.escalated");
    assert(esc, "recon.item.escalated emitted");
    assertEq(esc.payload.threshold_days, 30, "threshold carried");
  });

  await t.step("the accountant resolves the aged item: resolution stored and a resolved event", async () => {
    const r = await post({
      recon_ref: aged, cadence: "monthly", variance_cents: 40_000, owner: "acct_flow", age_days: 31,
      research_notes: "traced to an unposted ACH return from March", resolution: "return posted 2026-04-02",
    });
    assertEq(r.status, 201, `resolve (${body(r)})`);
    const row = await rowById("recon_item", `reconitem_${aged}`);
    assert(row.resolved_at, "resolved_at stamped");
    assertEq(row.resolution, "return posted 2026-04-02", "resolution stored");
    assert((await codesFor("recon_item", `reconitem_${aged}`)).includes("recon.item.resolved"), "resolved event");
  });
});

// ============================================================ IS-03

flow("internal_controls: IS-03 — IT registers an asset with a named owner and classification; an attestation is someone's statement and needs their name", async (t) => {
  const it = await actor("pynthia_ops");
  const partner = await actor("partner");
  const asset = rid("srv");
  const id = `asset_${asset}`;
  const post = (o: Record<string, unknown>, key = it) => api("POST", "/internal/assets", { asset_id: asset, ...o }, { key });

  await t.step("a partner cannot register assets", async () => {
    refusedToPartner(await post({ owner: "infra", classification: "internal" }, partner), "asset");
    assertEq(await rowById("it_asset", id), null, "nothing stored");
  });

  await t.step("an asset with no named owner, or no valid classification, is refused", async () => {
    const noOwner = await post({ classification: "restricted" });
    assertEq(noOwner.status, 400, `no owner (${body(noOwner)})`);
    const badClass = await post({ owner: "infra", classification: "top_secret" });
    assertEq(badClass.status, 400, `bad classification (${body(badClass)})`);
    assertEq(await rowById("it_asset", id), null, "nothing stored");
  });

  await t.step("an attestation with no attester is refused", async () => {
    const r = await post({ owner: "infra", classification: "internal", attest: true });
    assertEq(r.status, 400, `anonymous attestation (${body(r)})`);
    assert((r.body.errors ?? []).some((e: Any) => e.field === "attested_by"), "names attested_by");
    assertEq(await rowById("it_asset", id), null, "nothing stored");
  });

  await t.step("an owned, classified asset is registered unattested; the CMDB update is evidence", async () => {
    const r = await post({ owner: "infra_flow", classification: "restricted", media_type: "physical" });
    assertEq(r.status, 201, `register (${body(r)})`);
    const row = await rowById("it_asset", id);
    assertEq(row.asset_owner, "infra_flow", "owner");
    assertEq(row.asset_classification, "restricted", "classification");
    assertEq(row.attested_at, null, "not attested");
    const codes = await codesFor("it_asset", id);
    assert(codes.includes("asset.cmdb.updated"), "cmdb event");
    assert(!codes.includes("asset.attestation.completed"), "no attestation event");
  });

  await t.step("the owner attests by name: attested_at, attested_by and the attestation event", async () => {
    const r = await post({ owner: "infra_flow", classification: "restricted", attest: true, attested_by: "owner_flow" });
    assertEq(r.status, 201, `attest (${body(r)})`);
    const row = await rowById("it_asset", id);
    assert(row.attested_at, "attested");
    assertEq(row.attested_by, "owner_flow", "attester");
    const ev = (await eventsFor("it_asset", id)).find((e) => e.code === "asset.attestation.completed");
    assert(ev, "attestation event");
    assertEq(ev.payload.attested_by, "owner_flow", "event names the attester");
  });
});

// ============================================================ IS-10

flow("internal_controls: IS-10 — a red flag is detected, cannot be closed until the member's step-up completes, is disposed with its SAR, and the next ruleset learns from the disposition", async (t) => {
  const fraud = await actor("cu_admin", ["bsa_investigator"]);
  const partner = await actor("partner");
  const account = rid("acct");
  const TYPE = `address_change_then_card_${RUN}`;
  const caseId = `rfcase_${account}_${TYPE}`;
  const post = (o: Record<string, unknown>, key = fraud) =>
    api("POST", "/internal/redflag-cases", { account_id: account, type: TYPE, ...o }, { key });

  await t.step("a partner cannot open red-flag cases; a case with no type is refused", async () => {
    refusedToPartner(await post({}, partner), "red flag case");
    const noType = await api("POST", "/internal/redflag-cases", { account_id: account }, { key: fraud });
    assertEq(noType.status, 400, `no type (${body(noType)})`);
    assertEq(await rowById("redflag_case", caseId), null, "nothing stored");
  });

  await t.step("disposing a case whose required step-up never completed is refused — 409, no case row", async () => {
    const r = await post({ stepup_required: true, disposition: "closed, no fraud" });
    assertEq(r.status, 409, `dispose without step-up (${body(r)})`);
    assertEq(r.body.type, "stepup_incomplete", "typed refusal");
    assertEq(await rowById("redflag_case", caseId), null, "the unverified closure left nothing");
  });

  await t.step("the flag is detected with step-up required: an open case", async () => {
    const r = await post({ stepup_required: true, address_reissue_match: true });
    assertEq(r.status, 201, `detect (${body(r)})`);
    const row = await rowById("redflag_case", caseId);
    assertEq(row.redflag_stepup_required, true, "step-up required");
    assertEq(row.disposed_at, null, "open");
    assert((await codesFor("redflag_case", caseId)).includes("redflag.detected"), "detected event");
  });

  await t.step("after the step-up completes the investigator disposes it as a confirmed takeover with its SAR", async () => {
    const r = await post({
      stepup_required: true, stepup_completed: true, disposition: "confirmed takeover", sar_filing_id: rid("SAR"),
    });
    assertEq(r.status, 201, `dispose (${body(r)})`);
    const row = await rowById("redflag_case", caseId);
    assert(row.stepup_completed_at, "step-up stamped");
    assert(row.disposed_at, "disposed");
    assertEq(row.disposition, "confirmed takeover", "disposition");
    const codes = await codesFor("redflag_case", caseId);
    for (const c of ["redflag.stepup.completed", "redflag.case.disposed", "sar.filed"]) assert(codes.includes(c), `${c} emitted`);
  });

  await t.step("the next ruleset version is built from the case register: this case is counted, by its type, as disposed", async () => {
    const r = await api("POST", "/internal/redflag-ruleset", {
      ruleset: { window_days: 45 }, pattern_updates: [`widen ${TYPE} to 45 days`],
    }, { key: fraud });
    assertEq(r.status, 201, `ruleset (${body(r)})`);
    const row = await rowById("redflag_ruleset", r.body.data.id);
    assert(row, "ruleset row");
    const stats = row.redflag_case_stats;
    assertEq(stats.by_type[TYPE], 1, "this type counted once");
    assert(stats.disposed >= 1, "disposed cases counted");
    assertEq(row.provenance, "demo", "demo evidence");
    assert((await codesFor("redflag_ruleset", r.body.data.id)).includes("redflag.ruleset.updated"), "ruleset event");
  });
});

// ============================================================ CP-08 / CP-09

/** a 1900s as_of_date no capital_position row holds (never the latest position) */
async function freshPositionDate(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const y = 1900 + Math.floor(Math.random() * 100);
    const m = 1 + Math.floor(Math.random() * 12);
    const d = 1 + Math.floor(Math.random() * 28);
    const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const r = await core().from("capital_position").select("id").eq("as_of_date", date).maybeSingle();
    assert(!r.error, `capital_position read: ${r.error?.message}`);
    if (!r.data) return date;
  }
  throw new Error("no free 1900s as_of_date");
}

flow("internal_controls: CP-08/CP-09 — the CFO proposes and executes contingency capital actions: never ahead of the regulator, never a restricted distribution, never without the Board", async (t) => {
  const cfo = await actor("pynthia_ops", ["cfo"]);
  const partner = await actor("partner");
  const pos = rid("cap");
  const action = (o: Record<string, unknown>, key = cfo) =>
    api("POST", "/capital/actions", { position_id: pos, ...o }, { key });
  const createdPositions: string[] = [];

  try {
    await t.step("a partner cannot reach capital actions; an unknown action type is refused", async () => {
      refusedToPartner(await action({ action_type: "subordinated_debt", amount_cents: 1 }, partner), "capital action");
      const bad = await action({ action_type: "bake_sale", amount_cents: 1 });
      assertEq(bad.status, 400, `unknown type (${body(bad)})`);
    });

    await t.step("CP-09: executing subordinated debt on a PENDING preapproval is refused — 409, nothing recorded", async () => {
      const r = await action({
        action_type: "subordinated_debt", amount_cents: 5_000_000,
        regulatory_preapproval_status: "pending", board_resolution_id: "BR-flow", execute: true,
      });
      assertEq(r.status, 409, `ahead of the regulator (${body(r)})`);
      assertEq(r.body.type, "preapproval_not_granted", "typed refusal");
      assertEq(await rowById("capital_action", `capact_${pos}_subordinated_debt`), null, "no action row");
    });

    await t.step("CP-09: a distribution while distributions are restricted is refused", async () => {
      const r = await action({
        action_type: "distribution", amount_cents: 500_000, distribution_restriction: true,
        board_resolution_id: "BR-flow", execute: true,
      });
      assertEq(r.status, 409, `restricted distribution (${body(r)})`);
      assertEq(r.body.type, "distribution_restricted", "typed refusal");
      assertEq(await rowById("capital_action", `capact_${pos}_distribution`), null, "no action row");
    });

    await t.step("CP-09: an executed action needs the Board resolution behind it", async () => {
      const r = await action({ action_type: "asset_sale", amount_cents: 1, regulatory_preapproval_status: "not_required", execute: true });
      assertEq(r.status, 400, `no board resolution (${body(r)})`);
      assertEq(await rowById("capital_action", `capact_${pos}_asset_sale`), null, "no action row");
    });

    await t.step("a proposal awaiting preapproval is recorded but not executed", async () => {
      const r = await action({ action_type: "secondary_capital", amount_cents: 2_000_000, regulatory_preapproval_status: "pending" });
      assertEq(r.status, 201, `proposal (${body(r)})`);
      assertEq(r.body.data.executed, false, "not executed");
      const row = await rowById("capital_action", `capact_${pos}_secondary_capital`);
      assertEq(row.executed_at, null, "no execution stamp");
      assertEq(row.capital_regulatory_preapproval_status, "pending", "pending recorded");
      const codes = await codesFor("capital_action", `capact_${pos}_secondary_capital`);
      assert(codes.includes("capital.action.proposed"), "proposed event");
      assert(!codes.includes("capital.action.executed"), "no executed event");
    });

    await t.step("CP-08: with preapproval granted and a Board resolution it executes, and the contingency events name the action and amount", async () => {
      const r = await action({
        action_type: "subordinated_debt", amount_cents: 5_000_000, expected_capital_impact_cents: 5_000_000,
        regulatory_preapproval_status: "granted", regulatory_preapproval_id: "NCUA-PRE-flow",
        board_resolution_id: "BR-flow", execute: true,
      });
      assertEq(r.status, 201, `execute (${body(r)})`);
      const id = `capact_${pos}_subordinated_debt`;
      const row = await rowById("capital_action", id);
      assert(row.executed_at, "executed");
      assertEq(row.capital_board_resolution_id, "BR-flow", "board resolution");
      assertEq(row.capital_regulatory_preapproval_id, "NCUA-PRE-flow", "preapproval id");
      const ev = await eventsFor("capital_action", id);
      const exec = ev.find((e) => e.code === "capital.contingency_action.executed");
      assert(exec, "contingency executed event");
      assertEq(exec.payload["capital.action_amount"], 5_000_000, "carries the amount");
      assertEq(exec.payload["capital.action_type"], "subordinated_debt", "carries the type");
      for (const c of ["capital.action_board.decided", "capital.action.executed", "capital.contingency_memo.issued"]) {
        assert(ev.some((e) => e.code === c), `${c} emitted`);
      }
    });

    await t.step("CP-09: the restriction is a FACT of the position — a distribution on an undercapitalized position is refused even when the caller does not say so", async () => {
      const date = await freshPositionDate();
      const p = await api("POST", "/capital/positions", {
        as_of_date: date, net_worth_cents: 500_000_000, total_assets_cents: 10_000_000_000,
      }, { key: cfo });
      assertEq(p.status, 201, `undercapitalized position (${body(p)})`);
      const posIdForDate = `cap_${date.replace(/-/g, "")}`;
      createdPositions.push(posIdForDate);
      assertEq((await rowById("capital_position", posIdForDate)).distribution_restricted, true, "the position restricts payouts");
      const r = await api("POST", "/capital/actions", {
        position_id: posIdForDate, action_type: "distribution", amount_cents: 500_000,
        regulatory_preapproval_status: "not_required", board_resolution_id: "BR-flow", execute: true,
      }, { key: cfo });
      // DEFECT: postCapitalAction reads distribution_restriction from the request body, never from the position; an undercapitalized position's restricted distribution executes 201.
      assertEq(r.status, 409, `distribution on a restricted position (${body(r)})`);
    });
  } finally {
    if (createdPositions.length) {
      // the action the DEFECT lets through would otherwise outlive its position
      const a = await core().from("capital_action").delete().in("position_id", createdPositions);
      if (a.error) console.error(`cleanup capital_action: ${a.error.message}`);
      const d = await core().from("capital_position").delete().in("id", createdPositions);
      if (d.error) console.error(`cleanup capital_position: ${d.error.message}`);
    }
  }
});

// ============================================================ DF-06

flow("internal_controls: DF-06 — the CUSO is listed as an affiliate; credit to it is checked against 10% of capital and surplus and the low-quality-asset screen before it funds, and the funded file is archived", async (t) => {
  const treasury = await actor("cu_admin");
  const partner = await actor("partner");
  const entry = rid("CUSO");
  const aff = `aff_${entry}`;
  const tx = (o: Record<string, unknown>, id = aff, key = treasury) =>
    api("POST", `/governance/affiliates/${id}/transactions`, o, { key });
  const txId = `afftx_${aff}_credit`;

  await t.step("a partner cannot touch the affiliate list; a list entry is required", async () => {
    refusedToPartner(await api("POST", "/governance/affiliates", { list_entry: entry }, { key: partner }), "affiliate");
    const r = await api("POST", "/governance/affiliates", {}, { key: treasury });
    assertEq(r.status, 400, `no entry (${body(r)})`);
  });

  await t.step("the CUSO is listed: affiliate row and list-updated event", async () => {
    const r = await api("POST", "/governance/affiliates", { list_entry: entry, relationship: "cuso" }, { key: treasury });
    assertEq(r.status, 201, `list (${body(r)})`);
    const row = await rowById("affiliate", aff);
    assertEq(row.relationship, "cuso", "relationship");
    assert((await codesFor("affiliate", aff)).includes("affiliate.list.updated"), "list event");
  });

  await t.step("a transaction with an unlisted affiliate is 404; without capital the limit cannot be checked — 400", async () => {
    const ghost = await tx({ type: "credit", amount_cents: 1, capital_surplus_cents: 100_000_000 }, rid("aff_ghost"));
    assertEq(ghost.status, 404, `unlisted (${body(ghost)})`);
    const noCap = await tx({ type: "credit", amount_cents: 1 });
    assertEq(noCap.status, 400, `no capital (${body(noCap)})`);
    assertEq(await rowById("affiliate_transaction", txId), null, "nothing stored");
  });

  await t.step("funding $200k against $1M capital (2000bp) is over the limit: 409, not recorded as funded", async () => {
    const r = await tx({ type: "credit", amount_cents: 20_000_000, capital_surplus_cents: 100_000_000, lqa_screened: true, fund: true });
    assertEq(r.status, 409, `over limit (${body(r)})`);
    assertEq(r.body.type, "affiliate_limit_exceeded", "typed refusal");
    assertEq(await rowById("affiliate_transaction", txId), null, "no transaction row");
  });

  await t.step("unscreened is not screened-and-clean: funding without the LQA screen is refused", async () => {
    const r = await tx({ type: "credit", amount_cents: 5_000_000, capital_surplus_cents: 100_000_000, fund: true });
    assertEq(r.status, 409, `unscreened (${body(r)})`);
    assertEq(r.body.type, "lqa_screen_missing", "typed refusal");
    assertEq(await rowById("affiliate_transaction", txId), null, "no transaction row");
  });

  await t.step("a screened, collateralized $50k credit (500bp) funds, and the file is archived", async () => {
    const r = await tx({
      type: "credit", amount_cents: 5_000_000, capital_surplus_cents: 100_000_000,
      collateral_type: "us_treasury", collateral_value_cents: 6_500_000, lqa_screened: true, fund: true,
    });
    assertEq(r.status, 201, `fund (${body(r)})`);
    assertEq(r.body.data.utilisation_bp, 500, "500bp");
    const row = await rowById("affiliate_transaction", txId);
    assertEq(row.affiliate_limit_utilization_bp, 500, "utilisation stored");
    assertEq(row.within_limits, true, "within limits");
    assert(row.funded_at && row.file_archived_at && row.lqa_screen_at, "funded, archived, screened");
    const codes = await codesFor("affiliate_transaction", txId);
    for (const c of ["affiliate.limits.checked", "affiliate.lqa_screen.logged", "affiliate.transaction_file.archived"]) {
      assert(codes.includes(c), `${c} emitted`);
    }
  });

  await t.step("a SECOND $60k credit to the same affiliate is its own record and counts toward the limit: 500 + 600bp is over 1000bp", async () => {
    const r = await tx({
      type: "credit", amount_cents: 6_000_000, capital_surplus_cents: 100_000_000, lqa_screened: true, fund: true,
    });
    // DEFECT: postAffiliateTransaction checks each transaction alone and keys rows afftx_<affiliate>_<type>; a second credit funds (201) and OVERWRITES the first, so aggregate exposure is never limited.
    assertEq(r.status, 409, `aggregate over the limit (${body(r)})`);
    assertEq(Number((await rowById("affiliate_transaction", txId)).affiliate_transaction_amount_cents), 5_000_000, "the first funded credit is still on record");
  });
});

// ============================================================ BC-07

flow("internal_controls: BC-07 — ops records backup cycles; a restore test against a failed backup tests nothing, a failed job is remediated only with a stated action, and a restore from a good backup clocks the RTO", async (t) => {
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  let bad = "";
  let good = "";

  await t.step("a partner cannot record backups; a cycle with no valid status is refused", async () => {
    const p = await api("POST", "/security/backups", { status: "completed" }, { key: partner });
    refusedToPartner(p, "backup");
    const r = await api("POST", "/security/backups", { status: "fine" }, { key: ops });
    assertEq(r.status, 400, `bad status (${body(r)})`);
  });

  await t.step("a FAILED backup is recorded with its failure event", async () => {
    const r = await api("POST", "/security/backups", { status: "failed" }, { key: ops });
    assertEq(r.status, 201, `failed backup (${body(r)})`);
    bad = r.body.data.id;
    assertEq((await rowById("backup_job", bad)).status, "failed", "failed");
    assert((await codesFor("backup_job", bad)).includes("backup.job.failed"), "failure event");
  });

  await t.step("a restore test against the failed backup is refused — 409, no restore evidence", async () => {
    const r = await api("POST", "/security/restore-tests", { backup_id: bad }, { key: ops });
    assertEq(r.status, 409, `restore from failed (${body(r)})`);
    assertEq(r.body.type, "restore_from_unusable_backup", "typed refusal");
    const ghost = await api("POST", "/security/restore-tests", { backup_id: rid("bkp_ghost") }, { key: ops });
    assertEq(ghost.status, 404, `unknown backup (${body(ghost)})`);
  });

  await t.step("remediation: a non-failed job has nothing to remediate; a failed one needs a stated action; then it is remediated", async () => {
    const ok = await api("POST", "/security/backups", { status: "completed", restore_point: "2026-08-09T00:00:00Z" }, { key: ops });
    assertEq(ok.status, 201, `good backup (${body(ok)})`);
    good = ok.body.data.id;
    const notFailed = await api("POST", `/security/backups/${good}/remediate`, { action: "rerun" }, { key: ops });
    assertEq(notFailed.status, 409, `remediate a completed job (${body(notFailed)})`);
    const silent = await api("POST", `/security/backups/${bad}/remediate`, {}, { key: ops });
    assertEq(silent.status, 400, `no action (${body(silent)})`);
    assertEq((await rowById("backup_job", bad)).status, "failed", "still failed");
    const r = await api("POST", `/security/backups/${bad}/remediate`, { action: "replaced storage target" }, { key: ops });
    assertEq(r.status, 200, `remediate (${body(r)})`);
    const row = await rowById("backup_job", bad);
    assertEq(row.status, "remediated", "remediated");
    assert(row.remediated_at, "stamped");
    const ev = (await eventsFor("backup_job", bad)).find((e) => e.code === "backup.job.remediated");
    assertEq(ev?.payload?.action, "replaced storage target", "event carries the action");
  });

  await t.step("a restore test from the completed backup: restore row with the RTO clock, and the full restore evidence", async () => {
    const r = await api("POST", "/security/restore-tests", { backup_id: good }, { key: ops });
    assertEq(r.status, 201, `restore (${body(r)})`);
    const rst = r.body.data.id;
    const row = await rowById("backup_job", rst);
    assertEq(row.kind, "restore_test", "restore test row");
    assertEq(row.status, "completed", "completed");
    assert(row.rto_started_at && row.verified_at, "RTO clocked and verified");
    assertEq(ms(row.restore_point), ms("2026-08-09T00:00:00Z"), "restored to the source's point");
    const codes = await codesFor("backup_job", rst);
    for (const c of ["restore.rto_timer", "restore.point.validated", "restore.completed", "restore.test.completed", "backup.restore.verified"]) {
      assert(codes.includes(c), `${c} emitted`);
    }
  });
});

// ============================================================ IS-05

flow("internal_controls: IS-05 — a vulnerability is confirmed, cannot be remediated until triaged, then is triaged and fixed", async (t) => {
  const sec = await actor("pynthia_ops");
  const partner = await actor("partner");
  let id = "";

  await t.step("a partner cannot file findings; an unknown severity is refused", async () => {
    refusedToPartner(await api("POST", "/security/vulns", { severity: "high" }, { key: partner }), "vuln");
    const r = await api("POST", "/security/vulns", { severity: "spicy" }, { key: sec });
    assertEq(r.status, 400, `bad severity (${body(r)})`);
  });

  await t.step("a high finding is confirmed", async () => {
    const r = await api("POST", "/security/vulns", { severity: "high" }, { key: sec });
    assertEq(r.status, 201, `finding (${body(r)})`);
    id = r.body.data.id;
    assertEq((await rowById("vuln_finding", id)).severity, "high", "severity");
    assert((await codesFor("vuln_finding", id)).includes("vuln.finding.confirmed"), "confirmed event");
  });

  await t.step("remediation before triage is refused — the queue is the control", async () => {
    const r = await api("POST", `/security/vulns/${id}/remediate`, { fix: "patched" }, { key: sec });
    assertEq(r.status, 409, `jump the queue (${body(r)})`);
    assertEq(r.body.type, "triage_first", "typed refusal");
    assertEq((await rowById("vuln_finding", id)).remediated_at, null, "not remediated");
  });

  await t.step("triage needs an outcome; then triaged fix-now and remediated", async () => {
    const empty = await api("POST", `/security/vulns/${id}/triage`, {}, { key: sec });
    assertEq(empty.status, 400, `no outcome (${body(empty)})`);
    const tr = await api("POST", `/security/vulns/${id}/triage`, { outcome: "fix_now" }, { key: sec });
    assertEq(tr.status, 200, `triage (${body(tr)})`);
    const r = await api("POST", `/security/vulns/${id}/remediate`, { fix: "patched openssl" }, { key: sec });
    assertEq(r.status, 200, `remediate (${body(r)})`);
    const row = await rowById("vuln_finding", id);
    assertEq(row.triage_outcome, "fix_now", "outcome");
    assert(row.triaged_at && row.remediated_at, "triaged then remediated");
    assert(ms(row.triaged_at) <= ms(row.remediated_at), "in order");
    const codes = await codesFor("vuln_finding", id);
    assert(codes.includes("vuln.triage.completed") && codes.includes("vuln.remediated"), "triage and remediation events");
  });
});

// ============================================================ IS-13

flow("internal_controls: IS-13 — a member-facing AI tool is proposed, cannot launch before approval, launches with its disclosure; a rejected tool stays unlaunchable", async (t) => {
  const gov = await actor("cu_admin");
  const partner = await actor("partner");
  let tool = "";
  let risky = "";

  await t.step("a partner cannot propose AI tools; a nameless proposal is refused", async () => {
    refusedToPartner(await api("POST", "/security/ai-tools", { name: "x" }, { key: partner }), "ai tool");
    const r = await api("POST", "/security/ai-tools", { member_facing: true }, { key: gov });
    assertEq(r.status, 400, `no name (${body(r)})`);
  });

  await t.step("the chat helper is proposed as member-facing", async () => {
    const r = await api("POST", "/security/ai-tools", { name: rid("chat_helper"), member_facing: true }, { key: gov });
    assertEq(r.status, 201, `propose (${body(r)})`);
    tool = r.body.data.id;
    assertEq((await rowById("ai_tool", tool)).member_facing, true, "member facing");
    assert((await codesFor("ai_tool", tool)).includes("ai.tool.proposed"), "proposed event");
  });

  await t.step("launching before approval is refused — 409, no launch, no disclosure", async () => {
    const r = await api("POST", `/security/ai-tools/${tool}/launch`, {}, { key: gov });
    assertEq(r.status, 409, `early launch (${body(r)})`);
    assertEq(r.body.type, "ai_tool_not_approved", "typed refusal");
    const row = await rowById("ai_tool", tool);
    assertEq(row.disclosure_published_at, null, "no disclosure");
    assert(!(await codesFor("ai_tool", tool)).includes("ai.member_feature.launched"), "no launch event");
  });

  await t.step("a decision must be approved or rejected; approval updates the AI register", async () => {
    const bad = await api("POST", `/security/ai-tools/${tool}/decide`, { decision: "maybe" }, { key: gov });
    assertEq(bad.status, 400, `bad decision (${body(bad)})`);
    const r = await api("POST", `/security/ai-tools/${tool}/decide`, { decision: "approved" }, { key: gov });
    assertEq(r.status, 200, `approve (${body(r)})`);
    const row = await rowById("ai_tool", tool);
    assertEq(row.status, "approved", "approved");
    assert(row.register_updated_at, "register stamped");
    const codes = await codesFor("ai_tool", tool);
    assert(codes.includes("ai.tool.approved") && codes.includes("ai.register.updated"), "approval + register events");
  });

  await t.step("the approved tool launches and the member disclosure ships in the same act", async () => {
    const r = await api("POST", `/security/ai-tools/${tool}/launch`, {}, { key: gov });
    assertEq(r.status, 200, `launch (${body(r)})`);
    const row = await rowById("ai_tool", tool);
    assertEq(row.status, "launched", "launched");
    assert(row.disclosure_published_at, "disclosure published");
    const codes = await codesFor("ai_tool", tool);
    assert(codes.includes("ai.member_feature.launched") && codes.includes("ai.disclosure.published"), "launch + disclosure events");
  });

  await t.step("a REJECTED tool stays unlaunchable", async () => {
    const p = await api("POST", "/security/ai-tools", { name: rid("risky_bot") }, { key: gov });
    assertEq(p.status, 201, `propose (${body(p)})`);
    risky = p.body.data.id;
    const d = await api("POST", `/security/ai-tools/${risky}/decide`, { decision: "rejected" }, { key: gov });
    assertEq(d.status, 200, `reject (${body(d)})`);
    assert((await codesFor("ai_tool", risky)).includes("ai.tool.rejected"), "rejected event");
    const r = await api("POST", `/security/ai-tools/${risky}/launch`, {}, { key: gov });
    assertEq(r.status, 409, `launch rejected (${body(r)})`);
    assertEq((await rowById("ai_tool", risky)).status, "rejected", "still rejected");
  });
});

// ============================================================ IS-14

flow("internal_controls: IS-14 — the SOC files SIEM alerts: severity is stated or refused, only a stated critical raises the critical event, and a disposition needs substance", async (t) => {
  const soc = await actor("pynthia_ops");
  const partner = await actor("partner");

  await t.step("a partner cannot file SIEM alerts", async () => {
    refusedToPartner(await api("POST", "/security/siem/alerts", { severity: "low" }, { key: partner }), "siem alert");
  });

  await t.step("an alert with no severity, or a typo severity, is refused — an empty body is not a critical", async () => {
    const empty = await api("POST", "/security/siem/alerts", {}, { key: soc });
    assertEq(empty.status, 400, `no severity (${body(empty)})`);
    const typo = await api("POST", "/security/siem/alerts", { severity: "sev_critical" }, { key: soc });
    assertEq(typo.status, 400, `typo severity (${body(typo)})`);
  });

  await t.step("a low alert is stored with no critical event; a stated critical raises siem.alert_critical", async () => {
    const low = await api("POST", "/security/siem/alerts", { severity: "low" }, { key: soc });
    assertEq(low.status, 201, `low (${body(low)})`);
    assertEq((await rowById("siem_alert", low.body.data.id)).severity, "low", "low stored");
    assert(!(await codesFor("siem_alert", low.body.data.id)).includes("siem.alert_critical"), "no critical event for low");
    const crit = await api("POST", "/security/siem/alerts", { severity: "critical" }, { key: soc });
    assertEq(crit.status, 201, `critical (${body(crit)})`);
    assert((await codesFor("siem_alert", crit.body.data.id)).includes("siem.alert_critical"), "critical event");

    const silent = await api("POST", `/security/siem/alerts/${crit.body.data.id}/dispose`, {}, { key: soc });
    assertEq(silent.status, 400, `dispose with no disposition (${body(silent)})`);
    const d = await api("POST", `/security/siem/alerts/${crit.body.data.id}/dispose`, { disposition: "true positive, host isolated" }, { key: soc });
    assertEq(d.status, 200, `dispose (${body(d)})`);
    const row = await rowById("siem_alert", crit.body.data.id);
    assertEq(row.disposition, "true positive, host isolated", "disposition stored");
    assert((await codesFor("siem_alert", crit.body.data.id)).includes("siem.alert.disposed"), "disposed event");
  });
});
