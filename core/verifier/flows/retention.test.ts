// Record retention (BSA-21) and legal holds (SC-02 / RR-05), as the credit
// union's records staff live them, against the DEPLOYED core. Replaces the
// stubbed units in core/supabase/functions/api/retention.test.ts and
// legal_hold_multi.test.ts (see ledger/retention.md, ledger/legal_hold_multi.md).
//
// Disposal is the one irreversible action in the system, and the demo core is
// shared, so every hold, release and disposal here targets ONLY records this
// flow created: the closure-anchored records of an account it opened and
// closed, and records it classified under a run-unique Schedule A class. The
// sweep is called because it is non-destructive by design (it schedules, it
// never disposes) — and the flow asserts exactly that on whatever it finds.
//
// How an expired record is reached WITHOUT fabricating evidence: a run-unique
// record class is registered on Schedule A with a 0-year term (POST
// /records/schedule), and POST /records/classify sets its clock from that
// schedule — expiring at 00:00 UTC today. No row claims an anchor it lacks.
//
// Every claim is read back from core.record / core.legal_hold /
// core.record_hold / core.event: a refusal that answers 409 while the row
// moved, or a hold that answers 201 but never lands, is the failure mode.
import { actor, type Any, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

const RECORD_COLS = "id, record_class, subject_ref, retention_anchor, retention_anchor_kind, retention_expires_at, " +
  "legal_hold_flag, legal_hold_id, disposal_approved_by, disposal_approved_at, disposed_at, destruction_certificate, provenance";

async function recordRow(id: string): Promise<Any> {
  const r = await core().from("record").select(RECORD_COLS).eq("id", id).maybeSingle();
  assert(!r.error, `record read: ${r.error?.message}`);
  return r.data;
}

async function holdRow(id: string): Promise<Any> {
  const r = await core().from("legal_hold")
    .select("id, matter_id, status, scope_class, scope_subject_ref, placed_by, released_at, release_approved_by, provenance")
    .eq("id", id).maybeSingle();
  assert(!r.error, `legal_hold read: ${r.error?.message}`);
  return r.data;
}

async function memberships(recordId: string): Promise<Any[]> {
  const r = await core().from("record_hold").select("id, hold_id, released_at").eq("record_id", recordId);
  assert(!r.error, `record_hold read: ${r.error?.message}`);
  return r.data ?? [];
}

/** codes of every event emitted against `record:<id>` (records and holds share the prefix) */
async function eventCodes(resourceId: string): Promise<string[]> {
  const r = await core().from("event").select("code").eq("resource_id", `record:${resourceId}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  return (r.data ?? []).map((e: Any) => String(e.code));
}

/** BSA-21's arithmetic: anchor + N calendar years, UTC */
function plusYears(anchorIso: string, years: number): number {
  const d = new Date(anchorIso);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.getTime();
}

const fields = (r: { body: Any }): string[] =>
  ((r.body?.errors ?? []) as { field: string }[]).map((e) => e.field).sort();

/** register a run-unique 0-year class and classify `n` records under it — expired, honestly */
async function expiredRecords(staff: string, subject: string, n: number): Promise<string[]> {
  const cls = `flowcls_${uid()}`;
  const s = await api("POST", "/records/schedule", {
    record_class: cls, retention_years: 0, anchor_kind: "created",
    citation: "flow fixture: 0-year synthetic class", amended_by: "flow:retention",
  }, { key: staff });
  assertEq(s.status, 201, `0-year schedule entry (${JSON.stringify(s.body).slice(0, 200)})`);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `rec_flow_${uid()}`;
    const c = await api("POST", "/records/classify", { record_class: cls, record_id: id, subject_ref: subject },
      { key: staff });
    assertEq(c.status, 201, `classify (${JSON.stringify(c.body).slice(0, 200)})`);
    const row = await recordRow(id);
    assert(row, "record landed");
    assert(new Date(row.retention_expires_at).getTime() <= Date.now(), "a 0-year clock has already run out");
    ids.push(id);
  }
  return ids;
}

flow("retention: an account closes → clocks start → early disposal refused → hold outranks the date → authorized release", async (t) => {
  let partner = "";
  let staff = "";
  let account = "";
  let closedAt = "";
  const cip = () => `rec_${account}_cip_identity`;
  const bo = () => `rec_${account}_beneficial_owner`;
  const matter = `mat_${uid()}`;
  const holdId = () => `hold_${matter}_${account}`;

  await t.step("fixtures: a partner onboards a member, opens an account, and closes it", async () => {
    partner = await actor("partner");
    staff = await actor("cu_admin", ["bsa_compliance"]);
    const e = await api("POST", "/entities", {
      type: "person", name: personaName(), date_of_birth: "1971-06-15", address: "12 Elm St, Springfield, IL 62701",
    }, { key: partner });
    assertEq(e.status, 201, `create entity (${JSON.stringify(e.body).slice(0, 200)})`);
    const a = await api("POST", "/accounts", { entity_id: e.body.id, account_type: "savings" }, { key: partner });
    assertEq(a.status, 201, `open (${JSON.stringify(a.body).slice(0, 200)})`);
    account = String(a.body.id);
    const c = await api("POST", `/accounts/${account}/transition`, { to: "closed" }, { key: partner });
    assertEq(c.status, 200, `close (${JSON.stringify(c.body).slice(0, 200)})`);
  });

  await t.step("closure starts BOTH closure-anchored clocks: five years from the closure date, not from opening", async () => {
    const rows = await core().from("record").select(RECORD_COLS).eq("subject_ref", account).order("id");
    assert(!rows.error, `records: ${rows.error?.message}`);
    const classes = (rows.data ?? []).map((r: Any) => r.record_class).sort();
    assertEq(JSON.stringify(classes), JSON.stringify(["beneficial_owner", "cip_identity"]),
      "CIP identity and beneficial owner — the two classes BSA-21 anchors on closure");
    const closedEvt = await core().from("event").select("created_at").eq("resource_id", account)
      .eq("code", "account.closed").order("created_at", { ascending: false }).limit(1);
    const closedEvtAt = new Date(String(closedEvt.data?.[0]?.created_at)).getTime();
    for (const r of rows.data as Any[]) {
      assertEq(r.retention_anchor_kind, "account_closure", `${r.record_class} anchor kind`);
      assert(Math.abs(new Date(r.retention_anchor).getTime() - closedEvtAt) < 60_000,
        `${r.record_class} anchored at the closure (${r.retention_anchor} vs account.closed ${closedEvt.data?.[0]?.created_at})`);
      assertEq(new Date(r.retention_expires_at).getTime(), plusYears(r.retention_anchor, 5),
        `${r.record_class} expires exactly five years after its anchor`);
      assertEq(r.legal_hold_flag, false, "not held");
      assertEq(r.disposed_at, null, "not disposed");
    }
    closedAt = String((rows.data as Any[])[0].retention_anchor);
    for (const id of [cip(), bo()]) {
      const codes = await eventCodes(id);
      for (const c of ["record.retention_clock_set", "record.retention.expires_at", "record.retention_anchor"]) {
        assert(codes.includes(c), `${id}: ${c} emitted (got ${codes.join(",")})`);
      }
    }
  });

  await t.step("a closure stamped by a demo credential is demo evidence, not production", async () => {
    // DEFECT: setRetentionClocks takes no ctx, so a test token's closure writes core.record rows stamped `production` (retention.ts:128; accounts.ts:536 passes no ctx)
    for (const id of [cip(), bo()]) {
      assertEq((await recordRow(id))?.provenance, "demo", `${id} provenance`);
    }
  });

  await t.step("closed is final, so a second closure cannot re-anchor and EXTEND retention", async () => {
    const again = await api("POST", `/accounts/${account}/transition`, { to: "closed" }, { key: partner });
    assert(again.status === 409 || again.status === 200, `re-close answered ${again.status}`);
    for (const id of [cip(), bo()]) {
      assertEq((await recordRow(id))?.retention_anchor, closedAt, `${id}: anchor unchanged`);
    }
  });

  await t.step("a partner cannot see or touch retention at all — every route refuses (403 at the actor gate) and writes nothing", async () => {
    const pm = `mat_${uid()}`;
    const tries: [string, string, Any][] = [
      ["hold", "/retention/holds", { matter_id: pm, scope_subject_ref: account, reason: "x" }],
      ["release", `/retention/holds/${holdId()}/release`, { approved_by: "x" }],
      ["sweep", "/retention/disposal/sweep", {}],
      ["dispose", `/retention/records/${cip()}/dispose`, { approved_by: "x", certificate: "c" }],
    ];
    for (const [name, path, body] of tries) {
      // x-actors [cu_admin, pynthia_ops] gates at auth (auth.ts: 403 after authentication);
      // the handler's own 404 (requireRetention) is defence in depth behind it
      const r = await api("POST", path, body, { key: partner });
      assertEq(r.status, 403, `${name} refused to a partner (${JSON.stringify(r.body).slice(0, 160)})`);
      assert(String(r.body.detail).includes("cu_admin, pynthia_ops"), "names the actors it is restricted to");
    }
    assertEq(await holdRow(`hold_${pm}_${account}`), null, "no hold row written by the partner");
    assertEq((await recordRow(cip()))?.legal_hold_flag, false, "nothing flagged");
  });

  await t.step("(c) disposal without an approver or a certificate is refused naming both, and touches nothing", async () => {
    for (const [body, want] of [
      [{ certificate: "cert-1" }, ["approved_by"]],
      [{ approved_by: "records-mgmt" }, ["certificate"]],
      [{}, ["approved_by", "certificate"]],
    ] as [Any, string[]][]) {
      const r = await api("POST", `/retention/records/${cip()}/dispose`, body, { key: staff });
      assertEq(r.status, 400, `${JSON.stringify(body)} refused`);
      assertEq(JSON.stringify(fields(r)), JSON.stringify(want), "names what is missing");
    }
    const ghost = await api("POST", `/retention/records/rec_ghost_${uid()}/dispose`,
      { approved_by: "records-mgmt", certificate: "c" }, { key: staff });
    assertEq(ghost.status, 404, "an unknown record is a 404");
    assertEq((await recordRow(cip()))?.disposed_at, null, "still undisposed");
  });

  await t.step("(a) a record inside its five years cannot be destroyed — refused for THAT reason, nothing written", async () => {
    const r = await api("POST", `/retention/records/${cip()}/dispose`,
      { approved_by: "records-mgmt", certificate: `cert-${uid()}` }, { key: staff });
    assertEq(r.status, 409, `early disposal (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.type, "retention_not_expired", "typed as not expired");
    const row = await recordRow(cip());
    assertEq(row?.disposed_at, null, "not disposed");
    assertEq(row?.disposal_approved_by, null, "no approval recorded on a refusal");
    assert(!(await eventCodes(cip())).includes("record.destroyed"), "no record.destroyed event");
  });

  await t.step("a hold must name what it covers, and a scope class outside the schedule is refused", async () => {
    const none = await api("POST", "/retention/holds", { matter_id: matter }, { key: staff });
    assertEq(none.status, 400, "scopeless hold refused");
    assertEq(none.body.errors?.[0]?.field, "scope_subject_ref", "names scope_subject_ref");
    const noMatter = await api("POST", "/retention/holds", { scope_subject_ref: account }, { key: staff });
    assertEq(noMatter.status, 400, "matterless hold refused");
    assertEq(noMatter.body.errors?.[0]?.field, "matter_id", "names matter_id");
    const badMatter = `mat_${uid()}`;
    const bad = await api("POST", "/retention/holds",
      { matter_id: badMatter, scope_subject_ref: account, scope_class: "not_a_class" }, { key: staff });
    assertEq(bad.status, 400, "unknown class refused");
    assertEq(bad.body.errors?.[0]?.field, "scope_class", "names scope_class");
    assertEq(await holdRow(`hold_${badMatter}_${account}`), null, "no hold row for a refused placement");
    assertEq((await recordRow(cip()))?.legal_hold_flag, false, "nothing flagged");
  });

  await t.step("a class-scoped hold flags its in-scope record in the same request — and only that one", async () => {
    const r = await api("POST", "/retention/holds", {
      matter_id: matter, scope_subject_ref: account, scope_class: "cip_identity", reason: "flow: subpoena",
    }, { key: staff });
    assertEq(r.status, 201, `place hold (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.id, holdId(), "deterministic hold id");
    assertEq(r.body.status, "active", "active");
    const h = await holdRow(holdId());
    assertEq(h?.status, "active", "hold row active");
    assertEq(h?.scope_class, "cip_identity", "scope class stored");
    assert(String(h?.placed_by).startsWith("tok_test_cu_admin"), `placed_by names the staff credential (${h?.placed_by})`);
    const held = await recordRow(cip());
    assertEq(held?.legal_hold_flag, true, "CIP identity flagged before the response returned");
    assertEq(held?.legal_hold_id, holdId(), "pointer names the hold");
    assertEq((await recordRow(bo()))?.legal_hold_flag, false, "beneficial-owner record is out of scope — not flagged");
    const m = await memberships(cip());
    assertEq(m.length, 1, "set membership recorded");
    assertEq(m[0].released_at, null, "active membership");
    const codes = await eventCodes(holdId());
    for (const c of ["legal_hold.created", "disposal.held", "record.legal_hold_flag"]) {
      assert(codes.includes(c), `${c} emitted (got ${codes.join(",")})`);
    }
  });

  await t.step("a hold placed by a demo credential is labelled demo evidence", async () => {
    // DEFECT: postLegalHold stamps the legal_hold row with provenanceFor(scope) — no ctx — so a test token's hold is `production` (retention.ts:214)
    assertEq((await holdRow(holdId()))?.provenance, "demo", "legal_hold provenance");
  });

  await t.step("a record both held AND unexpired reports the HOLD, naming the matter to chase", async () => {
    const r = await api("POST", `/retention/records/${cip()}/dispose`,
      { approved_by: "records-mgmt", certificate: `cert-${uid()}` }, { key: staff });
    assertEq(r.status, 409, "refused");
    assertEq(r.body.type, "legal_hold_in_force", "the hold outranks the date");
    assert(String(r.body.detail).includes(holdId()), `detail names the hold (${r.body.detail})`);
    assertEq((await recordRow(cip()))?.disposed_at, null, "not disposed");
  });

  await t.step("release without written authorization is refused and the hold stays live", async () => {
    const r = await api("POST", `/retention/holds/${holdId()}/release`, { reason: "matter closed" }, { key: staff });
    assertEq(r.status, 400, "unauthorized release refused");
    assertEq(r.body.errors?.[0]?.field, "approved_by", "names approved_by");
    assertEq((await holdRow(holdId()))?.status, "active", "still active");
    assertEq((await recordRow(cip()))?.legal_hold_flag, true, "still held");
    const ghost = await api("POST", `/retention/holds/hold_ghost_${uid()}/release`, { approved_by: "gc" }, { key: staff });
    assertEq(ghost.status, 404, "an unknown hold is a 404");
  });

  await t.step("an authorized release clears the hold, the flag and the membership, and resumes the schedule", async () => {
    const r = await api("POST", `/retention/holds/${holdId()}/release`,
      { approved_by: "general-counsel", reason: "matter closed" }, { key: staff });
    assertEq(r.status, 200, `release (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.status, "released", "released");
    const h = await holdRow(holdId());
    assertEq(h?.status, "released", "hold row released");
    assertEq(h?.release_approved_by, "general-counsel", "approver recorded");
    assert(h?.released_at, "release dated");
    const row = await recordRow(cip());
    assertEq(row?.legal_hold_flag, false, "flag cleared — no other matter holds it");
    assertEq(row?.legal_hold_id, null, "pointer cleared");
    assert((await memberships(cip())).every((m) => m.released_at), "membership released");
    const codes = await eventCodes(holdId());
    for (const c of ["legal_hold.clear.confirmed", "disposal.clock.resumed"]) {
      assert(codes.includes(c), `${c} emitted (got ${codes.join(",")})`);
    }
    const again = await api("POST", `/retention/holds/${holdId()}/release`, { approved_by: "general-counsel" }, { key: staff });
    assertEq(again.status, 200, "re-release");
    assertEq(again.headers.get("Idempotent-Replayed"), "true", "replays rather than re-releasing");
  });

  await t.step("released but still inside its five years: disposal is refused on the DATE now", async () => {
    const r = await api("POST", `/retention/records/${cip()}/dispose`,
      { approved_by: "records-mgmt", certificate: `cert-${uid()}` }, { key: staff });
    assertEq(r.status, 409, "refused");
    assertEq(r.body.type, "retention_not_expired", "the hold is gone; the clock still governs");
  });
});

flow("retention: two matters hold one expired record → both must release → the sweep schedules but never destroys → certified disposal", async (t) => {
  let staff = "";
  let rec = "";
  let bystander = "";
  const subject = `subj_flow_${uid()}`;
  const mA = `matA_${uid()}`;
  const mB = `matB_${uid()}`;
  const holdA = `hold_${mA}_${subject}`;
  const holdB = `hold_${mB}_${subject}`;
  const cert = `cert-flow-${uid()}`;

  const dispose = () =>
    api("POST", `/retention/records/${rec}/dispose`, { approved_by: "records-mgmt", certificate: cert }, { key: staff });

  await t.step("fixtures: records staff classify a record under a 0-year schedule — expired without a fabricated anchor", async () => {
    staff = await actor("cu_admin", ["bsa_compliance"]);
    [rec] = await expiredRecords(staff, subject, 1);
    [bystander] = await expiredRecords(staff, `subj_flow_${uid()}`, 1);
    const row = await recordRow(rec);
    assertEq(row.legal_hold_flag, false, "unheld");
    assertEq(row.provenance, "demo", "a test credential's record is demo evidence");
  });

  await t.step("matter A then matter B place holds: both memberships are recorded, the pointer names only the latest", async () => {
    for (const [m, reason] of [[mA, "litigation A"], [mB, "litigation B"]]) {
      const r = await api("POST", "/retention/holds", { matter_id: m, scope_subject_ref: subject, reason }, { key: staff });
      assertEq(r.status, 201, `hold ${m} (${JSON.stringify(r.body).slice(0, 200)})`);
    }
    const row = await recordRow(rec);
    assertEq(row.legal_hold_flag, true, "held");
    assertEq(row.legal_hold_id, holdB, "the informational pointer names only the most recent hold");
    const m = await memberships(rec);
    assertEq(JSON.stringify(m.map((x) => x.hold_id).sort()), JSON.stringify([holdA, holdB].sort()),
      "the membership SET carries both holds — the authority, not the pointer");
    assert(m.every((x) => x.released_at === null), "both memberships start active");
  });

  await t.step("expired AND approved AND certified, but held: disposal is refused as legal_hold_in_force", async () => {
    const r = await dispose();
    assertEq(r.status, 409, "refused");
    assertEq(r.body.type, "legal_hold_in_force", "typed");
    assertEq((await recordRow(rec)).disposed_at, null, "not disposed");
  });

  await t.step("releasing the SECOND hold (the direction that used to fail open) leaves the record held by matter A", async () => {
    const r = await api("POST", `/retention/holds/${holdB}/release`, { approved_by: "general-counsel" }, { key: staff });
    assertEq(r.status, 200, "release B");
    const row = await recordRow(rec);
    assertEq(row.legal_hold_flag, true, "matter A is still live — the record must stay held");
    const m = await memberships(rec);
    assertEq(m.find((x) => x.hold_id === holdA)?.released_at, null, "A's membership still active");
    assert(m.find((x) => x.hold_id === holdB)?.released_at, "B's membership released");
    const d = await dispose();
    assertEq(d.status, 409, "still refused");
    assertEq(d.body.type, "legal_hold_in_force", "because of the surviving matter");
  });

  await t.step("the sweep (operations) schedules what is eligible, skips a record still held by a surviving matter, and destroys NOTHING", async () => {
    const r = await api("POST", "/retention/disposal/sweep", {});
    assertEq(r.status, 200, `sweep (${JSON.stringify(r.body).slice(0, 200)})`);
    assert(Array.isArray(r.body.eligible), "eligible is a list");
    assertEq(r.body.eligible_count, r.body.eligible.length, "count matches the list — zero is reported, not silence");
    assertEq(typeof r.body.truncated, "boolean", "says whether it was truncated");
    assert(!r.body.eligible.includes(rec), "a record held by a surviving matter is never scheduled (spoliation)");
    if (!r.body.truncated) {
      assert(r.body.eligible.includes(bystander), "an expired, unheld record is scheduled");
    }
    // whatever it found: still on the shelf, and scheduled in the event log
    const sample = (r.body.eligible as string[]).slice(0, 5).concat([bystander]);
    for (const id of sample) assertEq((await recordRow(id))?.disposed_at, null, `${id} not destroyed by the sweep`);
    if (r.body.eligible.length) {
      const codes = await eventCodes(r.body.eligible[0]);
      assert(codes.includes("disposal.scheduled"), "disposal.scheduled emitted for what it found");
      assert(codes.includes("destruction_log.entry.created"), "destruction log entry for what it found");
    }
  });

  await t.step("the other order: releasing the FIRST hold also leaves the record held, by matter B", async () => {
    const subj2 = `subj_flow_${uid()}`;
    const [rec2] = await expiredRecords(staff, subj2, 1);
    const [h1, h2] = [`hold_${mA}_${subj2}`, `hold_${mB}_${subj2}`];
    for (const m of [mA, mB]) {
      const r = await api("POST", "/retention/holds", { matter_id: m, scope_subject_ref: subj2, reason: "litigation" }, { key: staff });
      assertEq(r.status, 201, `hold ${m}`);
    }
    assertEq((await api("POST", `/retention/holds/${h1}/release`, { approved_by: "general-counsel" }, { key: staff })).status, 200,
      "release the first");
    assertEq((await recordRow(rec2)).legal_hold_flag, true, "matter B is still live — the record must stay held");
    assertEq((await memberships(rec2)).find((x) => x.hold_id === h2)?.released_at, null, "B's membership still active");
    assertEq((await api("POST", `/retention/holds/${h2}/release`, { approved_by: "general-counsel" }, { key: staff })).status, 200,
      "release the second");
    assertEq((await recordRow(rec2)).legal_hold_flag, false, "both released — cleared");
  });

  await t.step("a disposal method is not a bypass: anonymizing a held record is refused too", async () => {
    const r = await api("POST", `/records/${rec}/dispose-with-method`,
      { method: "anonymized", approved_by: "bsa", retained_fields: ["amount_band"] }, { key: staff });
    assertEq(r.status, 409, "refused");
    assertEq(r.body.type, "record_under_hold", "typed");
    const d = await core().from("record_disposition").select("id").eq("record_id", rec);
    assertEq((d.data ?? []).length, 0, "no disposition row");
    assertEq((await recordRow(rec)).disposed_at, null, "not disposed");
  });

  await t.step("releasing BOTH holds clears the flag", async () => {
    const r = await api("POST", `/retention/holds/${holdA}/release`, { approved_by: "chief-compliance-officer" }, { key: staff });
    assertEq(r.status, 200, "release A");
    const row = await recordRow(rec);
    assertEq(row.legal_hold_flag, false, "no live matter — flag cleared");
    assert((await memberships(rec)).every((x) => x.released_at), "every membership released");
  });

  await t.step("all three conditions met: the record is destroyed, approved, certified and logged", async () => {
    const r = await dispose();
    assertEq(r.status, 200, `dispose (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.destruction_certificate, cert, "certificate echoed");
    const row = await recordRow(rec);
    assert(row.disposed_at, "disposal dated");
    assertEq(row.disposal_approved_by, "records-mgmt", "approver recorded");
    assertEq(row.destruction_certificate, cert, "certificate recorded");
    assert(new Date(row.disposal_approved_at) <= new Date(row.disposed_at), "approved no later than destroyed");
    assert(new Date(row.disposed_at) >= new Date(row.retention_expires_at), "destroyed no earlier than expiry");
    const codes = await eventCodes(rec);
    for (const c of ["record.destroyed", "record.destruction.certified", "destruction_log.entry.created", "record.retention.expired"]) {
      assert(codes.includes(c), `${c} emitted (got ${codes.join(",")})`);
    }
  });

  await t.step("re-disposing replays rather than destroying twice", async () => {
    const before = (await recordRow(rec)).disposed_at;
    const r = await api("POST", `/retention/records/${rec}/dispose`,
      { approved_by: "someone-else", certificate: "cert-other" }, { key: staff });
    assertEq(r.status, 200, "replay");
    assertEq(r.headers.get("Idempotent-Replayed"), "true", "says it is a replay");
    const row = await recordRow(rec);
    assertEq(row.disposed_at, before, "disposal date unchanged");
    assertEq(row.destruction_certificate, cert, "original certificate stands");
  });
});

flow("retention: a permanent record is never destroyed — the retention endpoint refuses it cleanly", async (t) => {
  let staff = "";
  let rec = "";
  await t.step("fixtures: a permanent Schedule A class and a record classified under it", async () => {
    staff = await actor("cu_admin", ["bsa_compliance"]);
    const cls = `flowperm_${uid()}`;
    const s = await api("POST", "/records/schedule",
      { record_class: cls, permanent: true, anchor_kind: "created", citation: "12 CFR 701 (flow fixture)" }, { key: staff });
    assertEq(s.status, 201, `permanent entry (${JSON.stringify(s.body).slice(0, 200)})`);
    rec = `rec_flow_${uid()}`;
    const c = await api("POST", "/records/classify", { record_class: cls, record_id: rec }, { key: staff });
    assertEq(c.status, 201, `classify (${JSON.stringify(c.body).slice(0, 200)})`);
    assertEq((await recordRow(rec))?.retention_expires_at, null, "no expiry");
  });

  await t.step("disposal via /retention/records/{id}/dispose is a specific 409, not a database error", async () => {
    const r = await api("POST", `/retention/records/${rec}/dispose`,
      { approved_by: "records-mgmt", certificate: `cert-${uid()}` }, { key: staff });
    // DEFECT: postDisposeRecord compares new Date(null) > now (false) and attempts the UPDATE; only the DB check stops it, surfacing a 500 (retention.ts:516)
    assertEq(r.status, 409, `permanent record refused (${r.status} ${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq((await recordRow(rec))?.disposed_at, null, "and it is not disposed");
  });
});
