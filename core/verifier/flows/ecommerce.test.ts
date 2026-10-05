// E-commerce flows (EC-01, EC-03, EC-04, EC-07): Pynthia's staff run the
// online-banking programme — the policy's risk assessment and board approval,
// enrolling a member into online banking, the credential lifecycle (temporary
// password → forced change → lockout), and the transaction audit trail that
// answers a repudiation claim. Ported from the user-observable behaviour of the
// ecommerce.ts unit stubs (see ledger/ecommerce.md).
//
// Every route is staff-only and self-gated: a partner token gets 404, as if the
// route did not exist. Every member is a fresh entity created by the partner,
// so the ids the handlers derive (`enroll_<member>`, `cred_<member>`) are
// run-unique.
import { actor, type Any, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);

async function member(partner: string): Promise<string> {
  const e = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1984-08-21",
    address: "40 Oak Ave, Springfield, IL 62704",
  }, { key: partner });
  assertEq(e.status, 201, `create entity (${body(e)})`);
  return String(e.body.id);
}

async function row(table: string, id: string): Promise<Any> {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data;
}

async function eventsFor(resourceType: string, id: string): Promise<Any[]> {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("resource_id", `${resourceType}:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  return r.data ?? [];
}
const codesOf = (evs: Any[]) => evs.map((e) => String(e.code));

// ------------------------------------------------------------------- EC-01

flow("ecommerce: online-banking policy — board approval before the risk assessment completes is refused; a completed assessment's finding lands in the finding register", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  const early = `flow_${uid()}`;
  const version = `flow_${uid()}`;

  await t.step("a partner cannot reach the e-commerce routes (404 — they do not exist for it)", async () => {
    const r = await api("POST", "/ecommerce/risk-assessments", { document_version: version }, { key: partner });
    assertEq(r.status, 404, `partner risk assessment (${body(r)})`);
    const c = await api("POST", "/ecommerce/credentials", { member_ref: `m_${uid()}`, login_id: "x" }, { key: partner });
    assertEq(c.status, 404, `partner credential issue (${body(c)})`);
    assertEq(await row("ecommerce_risk_assessment", `ecra_${version}`), null, "nothing recorded");
  });

  await t.step("board approval of an incomplete assessment is refused and leaves no record", async () => {
    const bad = await api("POST", "/ecommerce/risk-assessments", { completed: true }, { key: ops });
    assertEq(bad.status, 400, `no policy version (${body(bad)})`);
    const r = await api("POST", "/ecommerce/risk-assessments", {
      document_version: early, completed: false, board_approved_by: "board_chair",
    }, { key: ops });
    assertEq(r.status, 409, `approval before completion (${body(r)})`);
    assertEq(r.body.type, "assessment_incomplete", "typed refusal");
    assertEq(await row("ecommerce_risk_assessment", `ecra_${early}`), null, "no assessment row");
    assertEq((await eventsFor("ecommerce_risk_assessment", `ecra_${early}`)).length, 0, "no board approval on the record");
  });

  await t.step("a completed, board-approved assessment: its finding is tracked in core.finding", async () => {
    const r = await api("POST", "/ecommerce/risk-assessments", {
      document_version: version, finding_description: `session timeout too long (${version})`,
      finding_severity: "high", control_register: ["EC-03", "EC-04"], board_approved_by: "board_chair",
    }, { key: ops });
    assertEq(r.status, 201, `assessment (${body(r)})`);
    const id = `ecra_${version}`;
    const a = await row("ecommerce_risk_assessment", id);
    assert(a?.completed_at, "completed");
    assert(a?.board_approved_at, "board approval stamped");
    assertEq(a?.board_approved_by, "board_chair", "approver named");
    const f = await row("finding", `find_${id}`);
    assertEq(f?.description, `session timeout too long (${version})`, "the finding is a register row");
    assertEq(f?.remediation_status, "open", "open for remediation");
    assertEq(f?.severity, "high", "severity");
    const ev = codesOf(await eventsFor("ecommerce_risk_assessment", id));
    for (const code of ["ecommerce.risk_assessment.completed", "policy.board.approved", "policy.board_approved_at"]) {
      assert(ev.includes(code), `${code} (got ${ev})`);
    }
  });
});

// ------------------------------------------------------------------- EC-03

flow("ecommerce: online-banking enrollment — an unanswered member-number check blocks approval; a denial records its reason; a matched, verified applicant is approved and told", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");

  await t.step("verified identity but NO member-number comparison: unknown is not permission", async () => {
    const m = await member(partner);
    const bad = await api("POST", "/ecommerce/enrollments", { member_ref: m, channel: "fax" }, { key: ops });
    assertEq(bad.status, 400, `unknown channel (${body(bad)})`);
    const r = await api("POST", "/ecommerce/enrollments", {
      member_ref: m, channel: "web", applicant_identity: "applicant A", verified: true,
    }, { key: ops });
    assertEq(r.status, 201, `enroll (${body(r)})`);
    assertEq(r.body.data.approved, false, "not approved");
    const e = await row("ecommerce_enrollment", `enroll_${m}`);
    assertEq(e?.member_number_match, null, "null, not false");
    assertEq(e?.approved_at, null, "not approved");
    assertEq(e?.verification_outcome, "verified", "identity was verified");
    const ev = codesOf(await eventsFor("ecommerce_enrollment", `enroll_${m}`));
    assert(!ev.includes("ecommerce.enrollment.approved"), "no approval event");
    assert(ev.includes("ecommerce.audit_trail.recorded"), "audit trail recorded");
  });

  await t.step("a phone applicant whose member number does not match is denied with a reason", async () => {
    const m = await member(partner);
    const r = await api("POST", "/ecommerce/enrollments", {
      member_ref: m, channel: "phone", applicant_identity: "caller", member_number_match: false,
      verified: false, denial_reason: "member number mismatch",
    }, { key: ops });
    assertEq(r.status, 201, `enroll (${body(r)})`);
    const e = await row("ecommerce_enrollment", `enroll_${m}`);
    assertEq(e?.verification_outcome, "denied", "denied");
    assertEq(e?.denial_reason, "member number mismatch", "reason kept");
    assertEq(e?.approved_at, null, "not approved");
    assert(codesOf(await eventsFor("ecommerce_enrollment", `enroll_${m}`)).includes("verification.denied"), "verification.denied");
  });

  await t.step("a matched, verified applicant is approved AND the member is sent a confirmation", async () => {
    const m = await member(partner);
    const r = await api("POST", "/ecommerce/enrollments", {
      member_ref: m, channel: "web", applicant_identity: "the member", member_number_match: true,
      entity_email: `${m}@example.test`, verified: true,
    }, { key: ops });
    assertEq(r.status, 201, `enroll (${body(r)})`);
    assertEq(r.body.data.approved, true, "approved");
    const e = await row("ecommerce_enrollment", `enroll_${m}`);
    assert(e?.approved_at, "approved_at");
    assert(e?.confirmation_sent_at, "confirmation_sent_at");
    const ev = await eventsFor("ecommerce_enrollment", `enroll_${m}`);
    assert(codesOf(ev).includes("ecommerce.enrollment.approved"), "approved event");
    const conf = ev.find((x) => x.code === "ecommerce.enrollment_confirmation.sent");
    assertEq(conf?.payload?.["entity.email"], `${m}@example.test`, "the confirmation goes to the member");
  });
});

// ------------------------------------------------------------------- EC-04 / EC-03 lockout

flow("ecommerce: member credential — temporary password with an expiry → only a real change clears it (no secret in the evidence) → five failures lock it, recorded", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  let credId = "";
  const NEW_PASSWORD = `correct-horse-${uid()}`;

  await t.step("a temporary credential is issued with an expiry and no set-date", async () => {
    const m = await member(partner);
    credId = `cred_${m}`;
    const bad = await api("POST", "/ecommerce/credentials", { member_ref: m }, { key: ops });
    assertEq(bad.status, 400, `no login id (${body(bad)})`);
    const r = await api("POST", "/ecommerce/credentials", {
      member_ref: m, login_id: `login_${m}`, password_hash: "argon2id$flow_issued_hash",
    }, { key: ops });
    assertEq(r.status, 201, `issue (${body(r)})`);
    assertEq(r.body.data.temporary, true, "temporary by default");
    const c = await row("member_credential", credId);
    assertEq(c?.is_temporary, true, "temporary");
    assert(c?.temp_password_expires_at, "a temporary password has an expiry");
    const hours = (Date.parse(c.temp_password_expires_at) - Date.now()) / 3_600_000;
    assert(hours > 23 && hours <= 24, `expires in 24h (got ${hours.toFixed(2)}h)`);
    assertEq(c?.password_set_at, null, "no set-date");
    const ev = await eventsFor("member_credential", credId);
    assert(codesOf(ev).includes("member_credential.issued"), "issued");
    assert(!JSON.stringify(ev).includes("flow_issued_hash"), "the hash never enters the event log");
  });

  await t.step("only an actual password change clears is_temporary; the new password is never recorded", async () => {
    const bad = await api("POST", `/ecommerce/credentials/${credId}/password`, {}, { key: ops });
    assertEq(bad.status, 400, `no new password (${body(bad)})`);
    assertEq((await row("member_credential", credId))?.is_temporary, true, "still temporary");
    const missing = await api("POST", `/ecommerce/credentials/cred_${uid()}/password`, { new_password: "x" }, { key: ops });
    assertEq(missing.status, 404, `unknown credential (${body(missing)})`);
    const r = await api("POST", `/ecommerce/credentials/${credId}/password`, { new_password: NEW_PASSWORD }, { key: ops });
    assertEq(r.status, 200, `change (${body(r)})`);
    const c = await row("member_credential", credId);
    assertEq(c.is_temporary, false, "no longer temporary");
    assertEq(c.temp_password_expires_at, null, "expiry cleared");
    assert(c.password_set_at, "set-date anchors the rotation clock");
    assert(!JSON.stringify(c).includes(NEW_PASSWORD), "the plaintext is not on the credential row");
    const ev = await eventsFor("member_credential", credId);
    const chg = ev.find((e) => e.code === "member_credential.password.changed");
    assertEq(chg?.payload?.was_temporary, true, "the change retired a temporary password");
    assert(!JSON.stringify(ev).includes(NEW_PASSWORD), "the plaintext is in no event");
  });

  await t.step("four failures do not lock; the fifth locks AND the lockout is recorded", async () => {
    for (let i = 1; i <= 4; i++) {
      const r = await api("POST", `/ecommerce/credentials/${credId}/login-failed`, {}, { key: ops });
      assertEq(r.status, 200, `failure ${i} (${body(r)})`);
      assertEq(r.body.data.locked, false, `not locked after ${i}`);
    }
    assertEq((await row("member_credential", credId))?.locked_at, null, "not yet");
    const r = await api("POST", `/ecommerce/credentials/${credId}/login-failed`, {}, { key: ops });
    assertEq(r.status, 200, `failure 5 (${body(r)})`);
    assertEq(r.body.data.locked, true, "locked");
    const c = await row("member_credential", credId);
    assert(c.locked_at, "locked_at stamped");
    assertEq(c.failed_login_count, 5, "count");
    assertEq(c.lockout_reason, "5 consecutive failed logins", "reason");
    const ev = codesOf(await eventsFor("member_credential", credId));
    assert(ev.includes("ecommerce.credential.locked"), "credential.locked");
    assert(ev.includes("ecommerce.lockout.recorded"), "lockout.recorded");
    assertEq(ev.filter((c) => c === "ecommerce.audit_trail.recorded").length, 5, "each failure on the audit trail");
  });
});

// ------------------------------------------------------------------- EC-07

flow("ecommerce: transaction audit trail — no initiator is refused; the trail is recorded; a repudiation verdict needs a rationale and carries the trail it was decided from", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  let m = "";
  let txId = "";

  const txOf = async (memberRef: string) => {
    const r = await core().from("ecommerce_transaction").select("*").eq("member_ref", memberRef);
    assert(!r.error, `ecommerce_transaction read: ${r.error?.message}`);
    return r.data ?? [];
  };

  await t.step("a transaction with no recorded initiator is refused and leaves no row", async () => {
    m = await member(partner);
    const r = await api("POST", "/ecommerce/transactions", { member_ref: m, transaction_type: "transfer", amount_cents: 2500 }, { key: ops });
    assertEq(r.status, 400, `no initiator (${body(r)})`);
    assertEq((await txOf(m)).length, 0, "nothing recorded");
  });

  await t.step("a member-initiated transfer records who, when, from where", async () => {
    const r = await api("POST", "/ecommerce/transactions", {
      member_ref: m, transaction_type: "transfer", amount_cents: 2500, initiated_by: m,
      source_ip: "203.0.113.7", device: "ios", session_ref: `sess_${uid()}`,
    }, { key: ops });
    assertEq(r.status, 201, `record (${body(r)})`);
    txId = String(r.body.data.id);
    const tx = await row("ecommerce_transaction", txId);
    assertEq(tx?.transaction_initiated_by, m, "initiator");
    assertEq(tx?.transaction_amount_cents, 2500, "amount");
    assertEq(tx?.audit_trail?.source_ip, "203.0.113.7", "source ip on the trail");
    assertEq(tx?.audit_trail?.device, "ios", "device on the trail");
    assert(codesOf(await eventsFor("ecommerce_transaction", txId)).includes("ecommerce.audit_trail.recorded"), "trail event");
  });

  await t.step("a repudiation verdict with no rationale is refused; the transaction is unchanged", async () => {
    const r = await api("POST", `/ecommerce/transactions/${txId}/repudiation`, { outcome: "rejected" }, { key: ops });
    assertEq(r.status, 400, `no rationale (${body(r)})`);
    const tx = await row("ecommerce_transaction", txId);
    assertEq(tx.repudiation_outcome, null, "no verdict");
    assertEq(tx.repudiation_claimed_at, null, "nothing written");
    const missing = await api("POST", `/ecommerce/transactions/ectx_${uid()}/repudiation`, { outcome: "rejected", rationale: "x" }, { key: ops });
    assertEq(missing.status, 404, `unknown transaction (${body(missing)})`);
  });

  await t.step("the member's claim is reviewed and rejected; the review carries the trail it was decided from", async () => {
    const r = await api("POST", `/ecommerce/transactions/${txId}/repudiation`, {
      outcome: "rejected", rationale: "member's own device and session",
    }, { key: ops });
    assertEq(r.status, 200, `review (${body(r)})`);
    const tx = await row("ecommerce_transaction", txId);
    assert(tx.repudiation_claimed_at && tx.repudiation_reviewed_at, "claim + review stamped");
    assertEq(tx.repudiation_outcome, "rejected", "verdict");
    assertEq(tx.repudiation_rationale, "member's own device and session", "rationale");
    const ev = (await eventsFor("ecommerce_transaction", txId)).find((e) => e.code === "ecommerce.repudiation.reviewed");
    assertEq(ev?.payload?.["ecommerce.audit_trail.recorded"]?.source_ip, "203.0.113.7", "shown, not asserted");
  });
});
