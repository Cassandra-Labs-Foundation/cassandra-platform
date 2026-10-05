// Records administration (RR-01..RR-12) as the credit union's records staff
// live it, against the DEPLOYED core. Replaces the stubbed units in
// core/supabase/functions/api/records_admin.test.ts (see ledger/records_admin.md).
//
// The demo core is shared, so every key this flow writes is run-unique: Schedule
// A classes (`flowcls_*`), record ids, integrity-test subjects, archive periods,
// box ids, CDD profile ids, contact roles, and the policy-review cycle year
// (ids are `rpolrev_<year>` and upsert — reusing a real year would overwrite the
// real review). Disposals only ever target records this flow classified.
//
// Every claim is read back from the core tables an examiner would read.
import { actor, type Any, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

async function row(table: string, id: string, cols = "*"): Promise<Any> {
  const r = await core().from(table).select(cols).eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data;
}

async function events(resourceType: string, id: string): Promise<Any[]> {
  const r = await core().from("event").select("code, payload, provenance").eq("resource_id", `${resourceType}:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  return r.data ?? [];
}
const codesOf = (evs: Any[]): string[] => evs.map((e) => String(e.code));

/** a 0-year Schedule A class: its records expire at 00:00 UTC today, honestly */
async function expiredClass(staff: string): Promise<string> {
  const cls = `flowcls_${uid()}`;
  const s = await api("POST", "/records/schedule", {
    record_class: cls, retention_years: 0, anchor_kind: "created", citation: "flow fixture: 0-year synthetic class",
  }, { key: staff });
  assertEq(s.status, 201, `0-year entry (${JSON.stringify(s.body).slice(0, 200)})`);
  return cls;
}

async function classify(staff: string, cls: string, subject?: string): Promise<string> {
  const id = `rec_flow_${uid()}`;
  const c = await api("POST", "/records/classify", { record_class: cls, record_id: id, subject_ref: subject ?? id },
    { key: staff });
  assertEq(c.status, 201, `classify ${cls} (${JSON.stringify(c.body).slice(0, 200)})`);
  return id;
}

flow("records_admin: Schedule A governs the clock — add, amend effective-dated, future-dated, retire, unmatched, permanent", async (t) => {
  let partner = "";
  let staff = "";
  const cls = `flowcls_${uid()}`;
  const v = (n: number) => `rsched_${cls}_v${n}`;

  await t.step("a partner cannot reach records administration — every route is a 404 and writes nothing", async () => {
    partner = await actor("partner");
    staff = await actor("cu_admin", ["bsa_compliance"]);
    const tries: [string, string, Any][] = [
      ["POST", "/records/schedule", { record_class: cls, retention_years: 5, citation: "c" }],
      ["POST", "/records/classify", { record_class: cls }],
      ["POST", "/records/integrity-tests", { subject_kind: "record", subject_ref: "x", test_kind: "conversion" }],
      ["POST", "/records/integrity-tests/rint_x/complete", { passed: true, sample_size: 1, certified_by: "x" }],
      ["POST", "/records/archives/confirm", { archive_kind: "core_archive", period: `p_${uid()}` }],
      ["POST", "/records/boxes", { label: "L", location: "X" }],
      ["POST", "/records/destruction-log/reconcile", {}],
      ["POST", "/records/destruction-log/dlmm_x/resolve", { resolution: "x" }],
      ["POST", "/records/cdd-profiles", { risk_tier: "high" }],
      ["POST", "/records/cdd-profiles/cdd_x/refresh", { refreshed_by: "x" }],
      ["POST", "/records/rec_x/dispose-with-method", { method: "destroyed", approved_by: "x" }],
      ["POST", "/records/policy-reviews", { cycle_year: 1, reviewed_by: "x", policy_document_version: "v" }],
      ["PUT", `/records/contacts/flowrole_${uid()}`, { assigned_ref: "x" }],
    ];
    for (const [m, path, body] of tries) {
      const r = await api(m, path, body, { key: partner });
      assertEq(r.status, 404, `${m} ${path} is invisible to a partner`);
    }
    assertEq(await row("retention_schedule_entry", v(1)), null, "no schedule entry written by the partner");
  });

  await t.step("RR-01: an entry with no citation (or no term) is refused naming each, and writes nothing", async () => {
    const r = await api("POST", "/records/schedule", { record_class: cls, retention_years: 3, anchor_kind: "created" },
      { key: staff });
    assertEq(r.status, 400, "no citation");
    assert((r.body.errors as Any[]).some((e) => e.field === "citation"), "names citation");
    const r2 = await api("POST", "/records/schedule", { record_class: cls, citation: "c" }, { key: staff });
    assertEq(r2.status, 400, "no term, not permanent");
    assert((r2.body.errors as Any[]).some((e) => e.field === "retention_years"), "names retention_years");
    const rows = await core().from("retention_schedule_entry").select("id").eq("record_class", cls);
    assertEq((rows.data ?? []).length, 0, "nothing written for the class");
  });

  await t.step("RR-01: an entry is added (v1, 5 years from 2026-01-01) and a record's clock comes from it", async () => {
    const r = await api("POST", "/records/schedule", {
      record_class: cls, retention_years: 5, anchor_kind: "account_closed", citation: "31 CFR 1020.220",
      effective_at: "2026-01-01T00:00:00.000Z", amended_by: "svp-ops",
    }, { key: staff });
    assertEq(r.status, 201, `add (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.data?.version, 1, "version 1");
    const e = await row("retention_schedule_entry", v(1));
    assertEq(e?.retention_years, 5, "stored term");
    assertEq(e?.citation, "31 CFR 1020.220", "stored citation");
    assertEq(e?.superseded_at, null, "in force");
    assert(codesOf(await events("retention_schedule_entry", v(1))).includes("schedule_a.entry.added"), "entry.added event");

    const rec = await classify(staff, cls);
    const rr = await row("record", rec);
    assertEq(new Date(rr.retention_expires_at).getUTCFullYear(), new Date().getUTCFullYear() + 5, "5 years, from the schedule");
    assertEq(rr.retention_anchor_kind, "account_closed", "anchor kind from the schedule");
    assertEq(rr.provenance, "demo", "a test credential's record is demo evidence");
    const evs = await events("record", rec);
    assert(codesOf(evs).includes("record.retention_clock_set"), "clock_set event");
    assertEq(evs.find((x) => x.code === "record.created")?.payload?.schedule_entry, v(1), "record.created names the governing entry");
  });

  await t.step("RR-01: an amendment (7 years from 2026-06-01) supersedes AT its effective date and inherits from v1", async () => {
    const r = await api("POST", "/records/schedule", {
      record_class: cls, retention_years: 7, anchor_kind: "account_closed", citation: "31 CFR 1020.220",
      effective_at: "2026-06-01T00:00:00.000Z",
    }, { key: staff });
    assertEq(r.status, 201, "amend");
    assertEq(r.body.data?.version, 2, "version increments");
    const v1 = await row("retention_schedule_entry", v(1));
    assertEq(new Date(v1.superseded_at).toISOString(), "2026-06-01T00:00:00.000Z", "v1 superseded at v2's effective date");
    const evs = await events("retention_schedule_entry", v(2));
    assert(codesOf(evs).includes("schedule_a.entry.amended"), "entry.amended event");
    assertEq(evs.find((x) => x.code === "schedule_a.entry_inherited")?.payload?.inherited_from, v(1),
      "inheritance walks back to v1");
    const rec = await classify(staff, cls);
    assertEq(new Date((await row("record", rec)).retention_expires_at).getUTCFullYear(), new Date().getUTCFullYear() + 7,
      "a record made now is clocked by the amendment");
  });

  await t.step("RR-01/RR-09: the amendment is NOT retroactive — the schedule stays effective-dated for March 2026", async () => {
    const rows = await core().from("retention_schedule_entry").select("id, retention_years, effective_at, superseded_at")
      .eq("record_class", cls).order("version");
    const march = new Date("2026-03-01T00:00:00Z").getTime();
    const inForce = (rows.data as Any[]).filter((e) =>
      new Date(e.effective_at).getTime() <= march && (!e.superseded_at || new Date(e.superseded_at).getTime() > march)
    );
    assertEq(inForce.length, 1, "exactly one entry governed March 2026");
    assertEq(inForce[0].retention_years, 5, "and it is the 5-year rule, not the June amendment");
  });

  await t.step("RR-01: a future-dated amendment (2027) leaves no gap — today is still governed by v2", async () => {
    const future = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1)).toISOString();
    const r = await api("POST", "/records/schedule", {
      record_class: cls, retention_years: 9, anchor_kind: "account_closed", citation: "c", effective_at: future,
    }, { key: staff });
    assertEq(r.status, 201, "future-dated amend");
    assertEq(r.body.data?.version, 3, "v3");
    assertEq(new Date((await row("retention_schedule_entry", v(2))).superseded_at).toISOString(), future,
      "v2 superseded at the future date, not now");
    const rec = await classify(staff, cls);
    assertEq(new Date((await row("record", rec)).retention_expires_at).getUTCFullYear(), new Date().getUTCFullYear() + 7,
      "today still uses the 7-year v2");
  });

  await t.step("RR-01: a RETIRED class stops applying and refuses like an unregistered one; no guessed clock", async () => {
    const r = await api("POST", "/records/schedule", { record_class: cls, retire: true, citation: "n/a" }, { key: staff });
    assertEq(r.status, 200, `retire (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.data?.retired, true, "retired");
    assert((await row("retention_schedule_entry", v(2))).superseded_at, "v2 superseded");
    const ev = (await events("retention_schedule_entry", v(2))).find((x) => x.code === "schedule_a.entry.amended" && x.payload?.retired);
    assert(ev, "retirement recorded as an amendment with retired: true");

    const id = `rec_flow_${uid()}`;
    const c = await api("POST", "/records/classify", { record_class: cls, record_id: id }, { key: staff });
    assertEq(c.status, 409, "a retired class refuses");
    assertEq(c.body.type, "record_class_unmatched", "typed");
    assertEq(await row("record", id), null, "no record with the retired period");
    const unm = await core().from("record_class_unmatched").select("id, record_id").eq("record_id", id);
    assertEq((unm.data ?? []).length, 1, "the miss is recorded for follow-up");

    const ghost = await api("POST", "/records/schedule", { record_class: `flowcls_${uid()}`, retire: true }, { key: staff });
    assertEq(ghost.status, 404, "retiring a class that was never registered is a 404");
  });

  await t.step("RR-01: an unregistered class REFUSES rather than defaulting a retention period", async () => {
    const mystery = `flowmystery_${uid()}`;
    const id = `rec_flow_${uid()}`;
    const none = await api("POST", "/records/classify", { record_id: id }, { key: staff });
    assertEq(none.status, 400, "a class is required");
    assertEq(none.body.errors?.[0]?.field, "record_class", "names record_class");
    const c = await api("POST", "/records/classify", { record_class: mystery, record_id: id }, { key: staff });
    assertEq(c.status, 409, "unmatched");
    assertEq(c.body.type, "record_class_unmatched", "typed");
    assertEq(await row("record", id), null, "NO record created with a guessed clock");
    const unm = await core().from("record_class_unmatched").select("id, record_class, record_id, provenance")
      .eq("record_class", mystery);
    assertEq((unm.data ?? []).length, 1, "one unmatched row");
    assertEq(unm.data![0].record_id, id, "naming the record");
    assert(codesOf(await events("record_class_unmatched", unm.data![0].id)).includes("record_class.unmatched"),
      "record_class.unmatched event");
  });

  await t.step("RR-11: a permanent record gets no expiry, is explicitly NOT eligible, and no method disposes it", async () => {
    const perm = `flowperm_${uid()}`;
    // a stray term on a permanent class is discarded (stored 0), so it can never leak into a clock
    const s = await api("POST", "/records/schedule",
      { record_class: perm, permanent: true, retention_years: 10, anchor_kind: "created", citation: "12 CFR 701" },
      { key: staff });
    assertEq(s.status, 201, `permanent entry (${JSON.stringify(s.body).slice(0, 200)})`);
    assertEq(s.body.data?.permanent, true, "permanent");
    const e = await row("retention_schedule_entry", String(s.body.data?.id));
    assertEq(e?.permanent, true, "stored permanent");
    assertEq(e?.retention_years, 0, "the stray 10-year term is not stored");
    const rec = await classify(staff, perm);
    assertEq((await row("record", rec)).retention_expires_at, null, "no expiry");
    const ev = (await events("record", rec)).find((x) => x.code === "record.disposal_eligible");
    assert(ev, "'never eligible' is stated, not merely absent");
    assertEq(ev.payload?.eligible, false, "eligible: false");
    assertEq(ev.payload?.reason, "permanent_record", "reason");
    for (const method of ["destroyed", "anonymized", "returned"]) {
      const d = await api("POST", `/records/${rec}/dispose-with-method`, { method, approved_by: "records-mgmt" }, { key: staff });
      assertEq(d.status, 409, `${method} refused`);
      assertEq(d.body.type, "record_permanent", "typed");
    }
    assertEq((await core().from("record_disposition").select("id").eq("record_id", rec)).data?.length, 0, "no disposition row");
    assertEq((await row("record", rec)).disposed_at, null, "not disposed");
  });
});

flow("records_admin: integrity tests and archive confirmations — a failed test opens a finding, a pass does not", async (t) => {
  let staff = "";
  const subj = `flowsubj_${uid()}`;
  const rint = (kind: string, ref: string, test: string) => `rint_${kind}_${ref}_${test}`;

  await t.step("RR-02: scheduling needs a known subject kind and test kind; a default due date lands a year out", async () => {
    staff = await actor("cu_admin", ["bsa_compliance"]);
    const bad = await api("POST", "/records/integrity-tests", { subject_kind: "floppy", subject_ref: subj, test_kind: "conversion" },
      { key: staff });
    assertEq(bad.status, 400, "unknown subject kind refused");
    const bad2 = await api("POST", "/records/integrity-tests", { subject_kind: "record", subject_ref: subj, test_kind: "vibes" },
      { key: staff });
    assertEq(bad2.status, 400, "unknown test kind refused");
    for (const test of ["conversion", "readability"]) {
      const r = await api("POST", "/records/integrity-tests", { subject_kind: "record", subject_ref: subj, test_kind: test },
        { key: staff });
      assertEq(r.status, 201, `schedule ${test} (${JSON.stringify(r.body).slice(0, 200)})`);
      assertEq(r.body.data?.id, rint("record", subj, test), "deterministic id");
      const tr = await row("record_integrity_test", r.body.data.id);
      assertEq(tr?.completed_at, null, "open");
      const days = (new Date(tr.due_at).getTime() - Date.now()) / 86_400_000;
      assert(days > 360 && days < 370, `due about a year out (${days.toFixed(1)}d)`);
      assert(codesOf(await events("record_integrity_test", r.body.data.id)).includes("record.integrity.test.due"), "due event");
    }
  });

  await t.step("RR-02: a completion with no sample or certifier is refused and the test stays open", async () => {
    const id = rint("record", subj, "conversion");
    for (const body of [{ passed: true }, { passed: true, sample_size: 0, certified_by: "ro" }, { sample_size: 40, certified_by: "ro" }]) {
      const r = await api("POST", `/records/integrity-tests/${id}/complete`, body, { key: staff });
      assertEq(r.status, 400, `${JSON.stringify(body)} refused`);
    }
    assertEq((await row("record_integrity_test", id)).completed_at, null, "still open");
    const ghost = await api("POST", `/records/integrity-tests/rint_ghost_${uid()}/complete`,
      { passed: true, sample_size: 1, certified_by: "ro" }, { key: staff });
    assertEq(ghost.status, 404, "an unknown test is a 404");
  });

  await t.step("RR-02: a FAILED readability test opens a finding", async () => {
    const id = rint("record", subj, "readability");
    const r = await api("POST", `/records/integrity-tests/${id}/complete`,
      { passed: false, sample_size: 40, certified_by: "records-officer" }, { key: staff });
    assertEq(r.status, 200, `complete (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.data?.finding_id, `rfind_${id}`, "finding id returned");
    const tr = await row("record_integrity_test", id);
    assertEq(tr.passed, false, "verdict stored");
    assertEq(tr.sample_size, 40, "sample stored");
    assertEq(tr.certified_by, "records-officer", "certifier stored");
    assertEq(tr.finding_id, `rfind_${id}`, "finding linked");
    const codes = codesOf(await events("record_integrity_test", id));
    assert(codes.includes("record.integrity_test.completed"), "completed event");
    assert(codes.includes("finding.opened"), "finding.opened event");
  });

  await t.step("RR-02: a PASSED conversion test certifies the conversion and opens no finding", async () => {
    const id = rint("record", subj, "conversion");
    const r = await api("POST", `/records/integrity-tests/${id}/complete`,
      { passed: true, sample_size: 25, certified_by: "records-officer" }, { key: staff });
    assertEq(r.status, 200, "complete");
    assertEq(r.body.data?.finding_id, null, "no finding");
    const tr = await row("record_integrity_test", id);
    assertEq(tr.passed, true, "passed");
    assertEq(tr.finding_id, null, "no finding linked");
    const codes = codesOf(await events("record_integrity_test", id));
    assert(codes.includes("record.conversion.certified"), "conversion certified");
    assert(!codes.includes("finding.opened"), "no finding.opened");
  });

  await t.step("RR-06: an email-archive retrievability test runs under its own codes", async () => {
    const r = await api("POST", "/records/integrity-tests",
      { subject_kind: "email_archive", subject_ref: subj, test_kind: "completeness" }, { key: staff });
    assertEq(r.status, 201, "schedule");
    const id = r.body.data.id;
    const c = await api("POST", `/records/integrity-tests/${id}/complete`,
      { passed: true, sample_size: 10, certified_by: "it-lead" }, { key: staff });
    assertEq(c.status, 200, "complete");
    const codes = codesOf(await events("record_integrity_test", id));
    assert(codes.includes("email_archive.test.due"), "email_archive.test.due");
    assert(codes.includes("email_archive.test.completed"), "email_archive.test.completed");
  });

  await t.step("RR-06: an archive confirmation records the years the vendor actually confirmed", async () => {
    const bad = await api("POST", "/records/archives/confirm", { archive_kind: "tape" }, { key: staff });
    assertEq(bad.status, 400, "unknown archive kind refused");
    assertEq(bad.body.errors?.[0]?.field, "archive_kind", "names archive_kind");
    const period = `flow_${uid()}`;
    const r = await api("POST", "/records/archives/confirm", {
      archive_kind: "core_archive", period, vendor_ref: "vendor-flow", retention_years_confirmed: 7, confirmed_by: "records-officer",
    }, { key: staff });
    assertEq(r.status, 201, `confirm (${JSON.stringify(r.body).slice(0, 200)})`);
    const id = `arcconf_core_archive_${period}`;
    assertEq(r.body.data?.id, id, "id");
    const a = await row("archive_confirmation", id);
    assertEq(a.retention_years_confirmed, 7, "years confirmed stored");
    assertEq(a.confirmed_by, "records-officer", "confirmer stored");
    const ev = (await events("archive_confirmation", id)).find((x) => x.code === "core_archive.retention.confirmed");
    assertEq(ev?.payload?.retention_years_confirmed, 7, "core_archive.retention.confirmed carries the years");
  });
});

flow("records_admin: destruction log — boxes reconcile against real disposals; a mismatch needs an explanation", async (t) => {
  let staff = "";
  let cls = "";
  let live = "";
  let gone = "";
  let liveInDestroyed = "";
  const boxOk = `sbox_flow_ok_${uid()}`;
  const boxOpen = `sbox_flow_open_${uid()}`;
  const boxDestroyed = `sbox_flow_dest_${uid()}`;

  await t.step("fixtures: three expired records; one is disposed under SC-02's three conditions", async () => {
    staff = await actor("cu_admin", ["bsa_compliance"]);
    cls = await expiredClass(staff);
    live = await classify(staff, cls);
    gone = await classify(staff, cls);
    liveInDestroyed = await classify(staff, cls);
    const d = await api("POST", `/retention/records/${gone}/dispose`,
      { approved_by: "records-mgmt", certificate: `cert-${uid()}` }, { key: staff });
    assertEq(d.status, 200, `dispose (${JSON.stringify(d.body).slice(0, 200)})`);
    assert((await row("record", gone)).disposed_at, "disposed");
  });

  await t.step("RR-04: boxes are sealed with their contents; a box needs a label and a location", async () => {
    const bad = await api("POST", "/records/boxes", { label: "BOX-X", record_ids: [live] }, { key: staff });
    assertEq(bad.status, 400, "no location refused");
    for (const [id, ids] of [[boxOk, [live]], [boxOpen, [gone]], [boxDestroyed, [liveInDestroyed]]] as [string, string[]][]) {
      const r = await api("POST", "/records/boxes", { id, label: `FLOW-${id.slice(-6)}`, location: "offsite-vault", record_ids: ids },
        { key: staff });
      assertEq(r.status, 201, `box ${id}`);
      const b = await row("storage_box", id);
      assertEq(JSON.stringify(b.record_ids), JSON.stringify(ids), "contents stored");
      assert(b.sealed_at, "sealed");
      assert(codesOf(await events("storage_box", id)).includes("storage_box.created"), "storage_box.created");
    }
    // No route records a box's physical destruction (the drill does the same
    // service-role write, drill/firers.ts:821). Mark only OUR box destroyed.
    const u = await core().from("storage_box").update({ destroyed_at: new Date().toISOString() }).eq("id", boxDestroyed);
    assert(!u.error, `mark destroyed: ${u.error?.message}`);
  });

  await t.step("RR-04: reconcile flags a destroyed box with live records, and leaves a consistent box alone", async () => {
    const r = await api("POST", "/records/destruction-log/reconcile", {}, { key: staff });
    assertEq(r.status, 200, `reconcile (${JSON.stringify(r.body).slice(0, 200)})`);
    assert(typeof r.body.data?.mismatches === "number", "reports a count");
    assertEq(await row("destruction_log_mismatch", `dlmm_${boxOk}`), null, "consistent box: no mismatch — the reconcile is not an echo");
    const m = await row("destruction_log_mismatch", `dlmm_${boxDestroyed}`);
    assert(m, "destroyed box with a live record is a mismatch");
    assertEq(m.kind, "box_destroyed_records_live", "kind");
    assertEq(m.detail?.live_records, 1, "one live record");
    assertEq(m.resolved_at, null, "open");
    assert(codesOf(await events("destruction_log_mismatch", `dlmm_${boxDestroyed}`)).includes("destruction_log.mismatch.detected"),
      "mismatch.detected event");
  });

  await t.step("RR-04: reconcile flags an OPEN box whose records were all disposed", async () => {
    // DEFECT: reconcile reads core.record with an unbounded select capped at PostgREST's 1000 rows (of ~2.7k), so a fresh disposal is invisible and the mismatch is missed (records_admin.ts:469)
    const m = await row("destruction_log_mismatch", `dlmm_${boxOpen}`);
    assert(m, "records disposed but box never closed out is a mismatch");
    assertEq(m.kind, "records_disposed_box_open", "kind");
  });

  await t.step("RR-04: a mismatch cannot be closed without an explanation; with one it is resolved", async () => {
    const mid = `dlmm_${boxDestroyed}`;
    const none = await api("POST", `/records/destruction-log/${mid}/resolve`, {}, { key: staff });
    assertEq(none.status, 400, "no resolution refused");
    assertEq(none.body.errors?.[0]?.field, "resolution", "names resolution");
    assertEq((await row("destruction_log_mismatch", mid)).resolved_at, null, "still open");
    const ok = await api("POST", `/records/destruction-log/${mid}/resolve`,
      { resolution: "box recalled from vendor; record re-shelved" }, { key: staff });
    assertEq(ok.status, 200, "resolve");
    const m = await row("destruction_log_mismatch", mid);
    assert(m.resolved_at, "resolved");
    assertEq(m.resolution, "box recalled from vendor; record re-shelved", "explanation stored");
    assert(codesOf(await events("destruction_log_mismatch", mid)).includes("destruction_log.mismatch.resolved"), "resolved event");
  });
});

flow("records_admin: CDD refresh is risk-based, and a late refresh says it was late", async (t) => {
  let staff = "";
  let entity = "";
  const ids: Record<string, string> = {};

  await t.step("fixtures: a partner onboards a member", async () => {
    staff = await actor("cu_admin", ["bsa_compliance"]);
    const partner = await actor("partner");
    const e = await api("POST", "/entities", { type: "person", name: personaName(), date_of_birth: "1983-09-09" }, { key: partner });
    assertEq(e.status, 201, `entity (${JSON.stringify(e.body).slice(0, 200)})`);
    entity = String(e.body.id);
  });

  await t.step("RR-08: high / moderate / low refresh at 12 / 36 / 60 months — not one interval for everyone", async () => {
    const bad = await api("POST", "/records/cdd-profiles", { entity_id: entity, risk_tier: "extreme" }, { key: staff });
    assertEq(bad.status, 400, "unknown risk tier refused");
    assertEq(bad.body.errors?.[0]?.field, "risk_tier", "names risk_tier");
    for (const [risk, due, months] of [["high", "2027-01", 12], ["moderate", "2029-01", 36], ["low", "2031-01", 60]] as const) {
      const id = `cdd_flow_${risk}_${uid()}`;
      ids[risk] = id;
      const r = await api("POST", "/records/cdd-profiles",
        { id, entity_id: entity, risk_tier: risk, last_refreshed_at: "2026-01-01T00:00:00.000Z" }, { key: staff });
      assertEq(r.status, 201, `${risk} (${JSON.stringify(r.body).slice(0, 200)})`);
      const p = await row("cdd_profile", id);
      assertEq(String(p.refresh_due_at).slice(0, 7), due, `${risk} due ${due}`);
      assertEq(p.entity_id, entity, "for the member");
      const ev = (await events("cdd_profile", id)).find((x) => x.code === "cdd.refresh.due");
      assertEq(ev?.payload?.cycle_months, months, `cdd.refresh.due cycle ${months}`);
    }
  });

  await t.step("RR-08: a refresh needs a refresher, and an unknown profile is a 404", async () => {
    const none = await api("POST", `/records/cdd-profiles/${ids.low}/refresh`, {}, { key: staff });
    assertEq(none.status, 400, "no refreshed_by");
    assertEq(none.body.errors?.[0]?.field, "refreshed_by", "names refreshed_by");
    const ghost = await api("POST", `/records/cdd-profiles/cdd_ghost_${uid()}/refresh`, { refreshed_by: "a" }, { key: staff });
    assertEq(ghost.status, 404, "unknown profile");
  });

  await t.step("RR-08: an overdue high-risk refresh records refreshed_late: true and restarts a 12-month cycle", async () => {
    const id = `cdd_flow_late_${uid()}`;
    const c = await api("POST", "/records/cdd-profiles",
      { id, entity_id: entity, risk_tier: "high", last_refreshed_at: "2020-01-01T00:00:00.000Z" }, { key: staff });
    assertEq(c.status, 201, "overdue profile");
    const r = await api("POST", `/records/cdd-profiles/${id}/refresh`, { refreshed_by: "analyst-flow" }, { key: staff });
    assertEq(r.status, 200, `refresh (${JSON.stringify(r.body).slice(0, 200)})`);
    const p = await row("cdd_profile", id);
    assertEq(p.refreshed_by, "analyst-flow", "refresher stored");
    const months = (new Date(p.refresh_due_at).getTime() - Date.now()) / (30.44 * 86_400_000);
    assert(months > 11.5 && months < 12.5, `next due ~12 months out (${months.toFixed(1)})`);
    const ev = (await events("cdd_profile", id)).find((x) => x.code === "cdd.profile.refreshed");
    assertEq(ev?.payload?.refreshed_late, true, "lateness is part of the record");
  });

  await t.step("RR-08: an on-time refresh records refreshed_late: false", async () => {
    const r = await api("POST", `/records/cdd-profiles/${ids.low}/refresh`, { refreshed_by: "analyst-flow" }, { key: staff });
    assertEq(r.status, 200, "refresh");
    const ev = (await events("cdd_profile", ids.low)).find((x) => x.code === "cdd.profile.refreshed");
    assertEq(ev?.payload?.refreshed_late, false, "not late");
  });
});

flow("records_admin: RR-07 disposition — anonymized and destroyed are different acts; a method is not a bypass", async (t) => {
  let staff = "";
  let anon = "";
  let dest = "";
  let unexpired = "";

  await t.step("fixtures: two expired records and one inside a 5-year term", async () => {
    staff = await actor("cu_admin", ["bsa_compliance"]);
    const cls = await expiredClass(staff);
    anon = await classify(staff, cls);
    dest = await classify(staff, cls);
    const five = `flowcls_${uid()}`;
    const s = await api("POST", "/records/schedule",
      { record_class: five, retention_years: 5, anchor_kind: "created", citation: "31 CFR 1010.430" }, { key: staff });
    assertEq(s.status, 201, "5-year entry");
    unexpired = await classify(staff, five);
  });

  await t.step("a method outside the vocabulary, or no approver, is refused; an unknown record is a 404", async () => {
    for (const body of [{ method: "shredded", approved_by: "bsa" }, { method: "destroyed" }]) {
      const r = await api("POST", `/records/${anon}/dispose-with-method`, body, { key: staff });
      assertEq(r.status, 400, `${JSON.stringify(body)} refused`);
    }
    const ghost = await api("POST", `/records/rec_ghost_${uid()}/dispose-with-method`, { method: "destroyed", approved_by: "x" },
      { key: staff });
    assertEq(ghost.status, 404, "unknown record");
    assertEq((await row("record", anon)).disposed_at, null, "untouched");
  });

  await t.step("an unexpired record is refused whatever the method", async () => {
    const r = await api("POST", `/records/${unexpired}/dispose-with-method`, { method: "anonymized", approved_by: "bsa" },
      { key: staff });
    assertEq(r.status, 409, "refused");
    assertEq(r.body.type, "record_not_expired", "typed");
    assertEq((await core().from("record_disposition").select("id").eq("record_id", unexpired)).data?.length, 0, "no disposition");
  });

  await t.step("anonymized keeps the analytical fields it names; destroyed keeps none — and each is recorded as itself", async () => {
    const a = await api("POST", `/records/${anon}/dispose-with-method`,
      { method: "anonymized", approved_by: "bsa-officer", retained_fields: ["amount_band", "month"] }, { key: staff });
    assertEq(a.status, 200, `anonymize (${JSON.stringify(a.body).slice(0, 200)})`);
    const d = await api("POST", `/records/${dest}/dispose-with-method`, { method: "destroyed", approved_by: "records-mgmt" },
      { key: staff });
    assertEq(d.status, 200, "destroy");

    const da = await row("record_disposition", `rdisp_${anon}`);
    assertEq(da.method, "anonymized", "anonymized recorded");
    assertEq(JSON.stringify(da.retained_fields), JSON.stringify(["amount_band", "month"]), "retained fields recorded");
    assertEq(da.approved_by, "bsa-officer", "approver");
    const dd = await row("record_disposition", `rdisp_${dest}`);
    assertEq(dd.method, "destroyed", "destroyed recorded");
    assertEq(dd.retained_fields, null, "nothing retained");

    for (const [id, method] of [[anon, "anonymized"], [dest, "destroyed"]]) {
      const rr = await row("record", id);
      assert(rr.disposed_at, `${id} disposed`);
      assert(rr.disposal_approved_by, "approval on the register");
      const evs = await events("record", id);
      assertEq(evs.find((x) => x.code === "record.disposal_method")?.payload?.method, method, `record.disposal_method = ${method}`);
      assert(codesOf(evs).includes("record.disposed"), "record.disposed");
    }
  });
});

flow("records_admin: governance — the annual review COUNTS amendments; a contact vacancy is its own state", async (t) => {
  let staff = "";
  const year = 9000 + Math.floor(Math.random() * 999); // run-scoped; rpolrev_<year> upserts
  const role = `flowrole_${uid()}`;

  await t.step("RR-09: a review needs its year, reviewer and policy version", async () => {
    staff = await actor("cu_admin", ["bsa_compliance"]);
    const r = await api("POST", "/records/policy-reviews", { cycle_year: year, reviewed_by: "cco" }, { key: staff });
    assertEq(r.status, 400, "no policy version refused");
  });

  await t.step("RR-09: the amendment count is COUNTED from Schedule A, not taken from the request", async () => {
    // make sure at least one amendment exists that this run made
    const cls = `flowcls_${uid()}`;
    for (const years of [5, 6]) {
      const s = await api("POST", "/records/schedule",
        { record_class: cls, retention_years: years, citation: "c", effective_at: years === 5 ? "2026-01-01T00:00:00Z" : undefined },
        { key: staff });
      assertEq(s.status, 201, `entry ${years}y`);
    }
    const r = await api("POST", "/records/policy-reviews", {
      cycle_year: year, reviewed_by: "cco-flow", policy_document_version: `v-flow-${year}`,
      schedule_entries_amended: 99, regulation_changes: ["flow: none material"],
    }, { key: staff });
    assertEq(r.status, 201, `review (${JSON.stringify(r.body).slice(0, 200)})`);
    const truth = await core().from("retention_schedule_entry").select("id", { count: "exact", head: true }).gt("version", 1);
    assert(!truth.error, `count: ${truth.error?.message}`);
    const rev = await row("records_policy_review", `rpolrev_${year}`);
    assert(rev.schedule_entries_amended !== 99, "the request's claimed count is ignored");
    // DEFECT: the count reads retention_schedule_entry unbounded, capped at PostgREST's 1000 rows (of 1.2k+), so it undercounts (records_admin.ts:714)
    assertEq(rev.schedule_entries_amended, truth.count, "equals the amended entries actually on Schedule A");
    assert(rev.board_report_filed_at, "board report dated");
    const codes = codesOf(await events("records_policy_review", `rpolrev_${year}`));
    for (const c of ["records.policy_review.completed", "policy.revision.published", "records.board_report.filed"]) {
      assert(codes.includes(c), `${c} emitted`);
    }
  });

  await t.step("RR-12: a role is assigned, then VACATED — the vacancy is distinguishable from a role that never existed", async () => {
    const none = await api("PUT", `/records/contacts/${role}`, {}, { key: staff });
    assertEq(none.status, 400, "no assignee and not vacating");
    assertEq(none.body.errors?.[0]?.field, "assigned_ref", "names assigned_ref");
    const a = await api("PUT", `/records/contacts/${role}`, { assigned_ref: "ro_flow_1" }, { key: staff });
    assertEq(a.status, 200, "assign");
    let c = await row("records_contact", `rcontact_${role}`);
    assertEq(c.assigned_ref, "ro_flow_1", "holder recorded");
    assertEq(c.vacated_at, null, "not vacant");
    assert(codesOf(await events("records_contact", `rcontact_${role}`)).includes("records.contact.assigned"), "assigned event");

    const v = await api("PUT", `/records/contacts/${role}`, { vacate: true }, { key: staff });
    assertEq(v.status, 200, "vacate");
    assertEq(v.body.data?.vacated, true, "vacated");
    c = await row("records_contact", `rcontact_${role}`);
    assertEq(c.assigned_ref, null, "no holder");
    assert(c.vacated_at, "vacancy dated");
    assert(codesOf(await events("records_contact", `rcontact_${role}`)).includes("records.contact_vacated"), "vacancy event");
  });
});
