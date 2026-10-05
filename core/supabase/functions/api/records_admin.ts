// Records administration — RR-01..RR-12.
//
// Extensions to an EXISTING subsystem. `core.record`, its clocks, its legal
// holds and its three-condition disposal gate all already work (retention.ts);
// what was missing is everything around them — the schedule the classes come
// from, the integrity testing that keeps electronic records readable, the
// reconciliation of the destruction log, and the governance that amends any of
// it. See the migration header on why this is a third domain shape.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor } from "./bsa.ts";
import {
  apiError, internalErrorResponse, isNonEmptyString, jsonResponse, notFoundResponse,
  parseJsonBody, selectAll, validationError, type ValidationErrorItem,
} from "./lib.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const DAY_MS = 24 * 60 * 60 * 1000;
/** RR-08: risk-based CDD refresh cycles. */
export const CDD_REFRESH_MONTHS: Readonly<Record<string, number>> = {
  high: 12, moderate: 36, low: 60,
};

function requireInternalActor(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/records");
  return null;
}

async function emit(
  db: SupabaseClient, scope: EvidenceScope, id: string, code: string,
  resourceType: string, resourceId: string, payload: Record<string, unknown>,
  ctx?: PartnerContext,
): Promise<void> {
  const { error } = await db.schema(scope).from("event").upsert({
    id, code, resource_type: resourceType, resource_id: `${resourceType}:${resourceId}`,
    payload, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`records_admin event (${code}): ${error.message}`);
}

const plusDays = (from: Date, d: number) => new Date(from.getTime() + d * DAY_MS).toISOString();

// ------------------------------------------------------- RR-01 Schedule A

/**
 * The schedule entry IN FORCE for a class at a moment.
 *
 * SIXTH ORDERING-ASSUMPTION INSTANCE, and the one with the sharpest
 * consequence. A retention schedule is amended over time, and a record
 * disposed in 2024 must be checkable against the schedule that governed it in
 * 2024 — not against today's. Taking the newest entry makes every historical
 * disposal look compliant with a rule that did not exist when it happened,
 * which is precisely the direction an examiner tests.
 */
export async function scheduleInForce(
  db: SupabaseClient, scope: EvidenceScope, recordClass: string, at: Date,
): Promise<Record<string, Any> | null> {
  const { data, error } = await db.schema(scope).from("retention_schedule_entry")
    .select("id, record_class, retention_years, anchor_kind, citation, version, permanent, effective_at, superseded_at")
    .eq("record_class", recordClass)
    .order("effective_at", { ascending: false });
  if (error) throw new Error(`retention_schedule_entry: ${error.message}`);
  const iso = at.toISOString();
  for (const row of data ?? []) {
    if (String(row.effective_at) > iso) continue;
    if (row.superseded_at && String(row.superseded_at) <= iso) continue;
    return row;
  }
  return null;
}

/**
 * POST /records/schedule
 * {record_class, retention_years, anchor_kind, citation, permanent?, effective_at?, amended_by?}
 */
export async function postRetentionScheduleEntry(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  // RETIRING a class supersedes its entry WITHOUT a successor, and is checked
  // BEFORE the add/amend validation because a retirement supplies no term and
  // no citation — there is nothing to validate. Found by a surviving mutation:
  // the "superseded entries stop applying" branch in scheduleInForce was
  // unreachable because nothing could produce that state, and a branch no path
  // reaches is not a control. The case is real — a record class removed from
  // Schedule A must behave like an unregistered one and refuse to set a clock,
  // not keep silently using the retired period.
  if (body.retire === true) {
    const cls0 = String(body.record_class ?? "");
    const at = isNonEmptyString(body.effective_at)
      ? body.effective_at
      : new Date().toISOString();
    const cur = cls0 ? await scheduleInForce(db, scope, cls0, new Date(at)) : null;
    if (!cur) return notFoundResponse(requestId, "retention_schedule_entry", cls0);
    await db.schema(scope).from("retention_schedule_entry")
      .update({ superseded_at: at }).eq("id", cur.id);
    await emit(db, scope, `ev_${cur.id}_retire`, "schedule_a.entry.amended",
      "retention_schedule_entry", String(cur.id), {
        record_class: cls0, retired: true, effective_at: at,
      }, ctx);
    return jsonResponse({ data: { record_class: cls0, retired: true } }, 200, requestId);
  }

  const errors: ValidationErrorItem[] = [];
  if (!isNonEmptyString(body.record_class)) {
    errors.push({ type: "missing_field", field: "record_class", message: "is required" });
  }
  if (!isNonEmptyString(body.citation)) {
    // A retention period with no citation cannot be checked against the
    // regulation it claims to implement, and RR-09's annual review is exactly
    // that check.
    errors.push({
      type: "missing_field", field: "citation",
      message: "a retention period needs the authority it derives from",
    });
  }
  const permanent = body.permanent === true;
  const years = typeof body.retention_years === "number" ? body.retention_years : NaN;
  if (!permanent && (!Number.isFinite(years) || years < 0)) {
    errors.push({
      type: "invalid_value", field: "retention_years",
      message: "must be a non-negative number unless the class is permanent",
    });
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const now = new Date();
  const effectiveAt = isNonEmptyString(body.effective_at) ? body.effective_at : now.toISOString();
  const cls = String(body.record_class);

  const prior = await scheduleInForce(db, scope, cls, new Date(effectiveAt));

  const version = prior ? Number(prior.version) + 1 : 1;
  if (prior) {
    // superseded AT the new entry's effective date, not "now" — otherwise a
    // future-dated amendment retires the current entry immediately and leaves
    // a gap with no schedule at all
    await db.schema(scope).from("retention_schedule_entry")
      .update({ superseded_at: effectiveAt }).eq("id", prior.id);
  }

  const id = `rsched_${cls}_v${version}`;
  const { error } = await db.schema(scope).from("retention_schedule_entry").upsert({
    id, record_class: cls,
    retention_years: permanent ? 0 : years,
    anchor_kind: isNonEmptyString(body.anchor_kind) ? body.anchor_kind : "created",
    citation: body.citation, version, permanent,
    effective_at: effectiveAt, superseded_at: null,
    amended_by: isNonEmptyString(body.amended_by) ? body.amended_by : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_${prior ? "amend" : "add"}`,
    prior ? "schedule_a.entry.amended" : "schedule_a.entry.added",
    "retention_schedule_entry", id, {
      record_class: cls, retention_years: permanent ? 0 : years,
      citation: body.citation, version, permanent,
      prior_version: prior ? prior.version : null,
    }, ctx);
  if (prior) {
    // an amendment supersedes; the inheritance event says which entry the new
    // one descends from, so the chain is walkable
    await emit(db, scope, `ev_${id}_inherit`, "schedule_a.entry_inherited",
      "retention_schedule_entry", id, {
        inherited_from: prior.id, record_class: cls,
      }, ctx);
  }
  return jsonResponse({ data: { id, version, permanent } }, 201, requestId);
}

/**
 * POST /records/classify {record_class, record_id?}
 *
 * RR-01. Sets the clock from the SCHEDULE rather than from a constant, and
 * surfaces an unmatched class instead of defaulting it. A default retention
 * period applied to a class nobody registered is a guess that looks like a
 * policy, and it fails silently in the direction of disposing too early.
 */
export async function postRecordClassify(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.record_class)) {
    return validationError(requestId, [{
      type: "missing_field", field: "record_class", message: "is required",
    }]);
  }
  const cls = String(body.record_class);
  const now = new Date();
  const entry = await scheduleInForce(db, scope, cls, now);

  if (!entry) {
    const id = `rcunm_${cls}_${crypto.randomUUID()}`;
    await db.schema(scope).from("record_class_unmatched").upsert({
      id, record_class: cls,
      record_id: isNonEmptyString(body.record_id) ? body.record_id : null,
      detected_at: now.toISOString(), provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id" });
    await emit(db, scope, `ev_${id}_unm`, "record_class.unmatched",
      "record_class_unmatched", id, { record_class: cls }, ctx);
    return apiError(409, "record_class_unmatched", requestId, {
      title: "no retention schedule for this class",
      detail: `'${cls}' has no Schedule A entry; the clock cannot be set without one`,
    });
  }

  const recordId = isNonEmptyString(body.record_id) ? body.record_id : `rec_${crypto.randomUUID()}`;
  const permanent = entry.permanent === true;
  const expiresAt = permanent
    ? null
    : new Date(
      Date.UTC(
        now.getUTCFullYear() + Number(entry.retention_years),
        now.getUTCMonth(), now.getUTCDate(),
      ),
    ).toISOString();

  const { error } = await db.schema(scope).from("record").upsert({
    id: recordId, record_class: cls,
    subject_ref: isNonEmptyString(body.subject_ref) ? body.subject_ref : recordId,
    retention_anchor: now.toISOString(),
    retention_anchor_kind: entry.anchor_kind,
    retention_expires_at: expiresAt,
    legal_hold_flag: false,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${recordId}_created`, "record.created", "record", recordId, {
    record_class: cls, schedule_entry: entry.id,
  }, ctx);
  await emit(db, scope, `ev_${recordId}_clock`, "record.retention_clock_set",
    "record", recordId, {
      record_class: cls, retention_expires_at: expiresAt,
      years: entry.retention_years, citation: entry.citation,
    }, ctx);
  await emit(db, scope, `ev_${recordId}_exp`, "record.retention.expires_at",
    "record", recordId, { retention_expires_at: expiresAt, permanent }, ctx);

  if (permanent) {
    // RR-11: a permanent record must never become disposal eligible. The event
    // is emitted with `eligible: false` rather than withheld, because "no
    // eligibility event" and "explicitly never eligible" are different facts
    // and only the second is a control.
    await emit(db, scope, `ev_${recordId}_perm`, "record.disposal_eligible",
      "record", recordId, {
        eligible: false, reason: "permanent_record", record_class: cls,
      }, ctx);
  }
  return jsonResponse({
    data: { id: recordId, record_class: cls, permanent, retention_expires_at: expiresAt },
  }, 201, requestId);
}

// -------------------------------------------------- RR-02 / RR-06 integrity

/**
 * POST /records/integrity-tests
 * {subject_kind, subject_ref, test_kind, due_at?}
 */
export async function postIntegrityTestSchedule(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const kinds = ["record", "core_archive", "email_archive"];
  const tests = ["conversion", "readability", "completeness"];
  if (!kinds.includes(String(body.subject_kind)) || !tests.includes(String(body.test_kind))) {
    return validationError(requestId, [{
      type: "invalid_value", field: "subject_kind",
      message: `subject_kind in ${kinds.join("/")} and test_kind in ${tests.join("/")}`,
    }]);
  }
  const now = new Date();
  const id = `rint_${body.subject_kind}_${body.subject_ref}_${body.test_kind}`;
  const dueAt = isNonEmptyString(body.due_at) ? body.due_at : plusDays(now, 365);
  const { error } = await db.schema(scope).from("record_integrity_test").upsert({
    id, subject_kind: body.subject_kind, subject_ref: body.subject_ref,
    test_kind: body.test_kind, due_at: dueAt,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const code = body.subject_kind === "email_archive"
    ? "email_archive.test.due"
    : body.subject_kind === "core_archive"
    ? "core_archive.confirmation_due"
    : "record.integrity.test.due";
  await emit(db, scope, `ev_${id}_due`, code, "record_integrity_test", id, {
    due_at: dueAt, test_kind: body.test_kind, subject_ref: body.subject_ref,
  }, ctx);
  return jsonResponse({ data: { id, due_at: dueAt } }, 201, requestId);
}

/**
 * POST /records/integrity-tests/:id/complete
 * {passed, sample_size, certified_by}
 *
 * RR-02 / RR-06. A FAILED test opens a finding — that is the entire
 * consequence, and a failure with no finding is a test result nobody acts on.
 * Enforced here and by `ck_integrity_test_failure_has_finding`.
 */
export async function postIntegrityTestComplete(
  req: Request, testId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: t } = await db.schema(scope).from("record_integrity_test")
    .select("id, subject_kind, subject_ref, test_kind, due_at").eq("id", testId).maybeSingle();
  if (!t) return notFoundResponse(requestId, "record_integrity_test", testId);

  const sample = typeof body.sample_size === "number" ? body.sample_size : NaN;
  const certifiedBy = isNonEmptyString(body.certified_by) ? body.certified_by : null;
  if (typeof body.passed !== "boolean" || !Number.isFinite(sample) || sample <= 0 || !certifiedBy) {
    // A "test" with no verdict, no sample and nobody certifying it is a
    // calendar entry being reported as assurance.
    return validationError(requestId, [{
      type: "missing_field", field: "sample_size",
      message: "passed, a positive sample_size and certified_by are all required",
    }]);
  }

  const now = new Date();
  const passed = body.passed === true;
  const findingId = passed ? null : `rfind_${testId}`;

  const { error } = await db.schema(scope).from("record_integrity_test").update({
    completed_at: now.toISOString(), passed, sample_size: sample,
    certified_by: certifiedBy, finding_id: findingId, updated_at: now.toISOString(),
  }).eq("id", testId);
  if (error) return internalErrorResponse(requestId, error.message);

  const completedCode = t.subject_kind === "email_archive"
    ? "email_archive.test.completed"
    : "record.integrity_test.completed";
  await emit(db, scope, `ev_${testId}_done`, completedCode,
    "record_integrity_test", testId, {
      passed, sample_size: sample, certified_by: certifiedBy, test_kind: t.test_kind,
    }, ctx);

  if (t.test_kind === "conversion") {
    await emit(db, scope, `ev_${testId}_conv`, "record.conversion.certified",
      "record_integrity_test", testId, {
        certified_by: certifiedBy, subject_ref: t.subject_ref, passed,
      }, ctx);
  }
  if (t.subject_kind === "core_archive") {
    await emit(db, scope, `ev_${testId}_arch`, "core_archive.retention.confirmed",
      "record_integrity_test", testId, {
        confirmed_by: certifiedBy, retention_years_confirmed: body.retention_years_confirmed ?? null,
      }, ctx);
  }
  if (!passed) {
    await emit(db, scope, `ev_${findingId}_open`, "finding.opened",
      "record_integrity_test", testId, {
        finding_id: findingId, source: "records_integrity_test",
        subject_ref: t.subject_ref, test_kind: t.test_kind,
      }, ctx);
  }
  return jsonResponse({ data: { id: testId, passed, finding_id: findingId } }, 200, requestId);
}

/** POST /records/archives/confirm {archive_kind, period, vendor_ref, retention_years_confirmed, confirmed_by} */
export async function postArchiveConfirmation(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!["core_archive", "email_archive"].includes(String(body.archive_kind))) {
    return validationError(requestId, [{
      type: "invalid_value", field: "archive_kind",
      message: "must be core_archive or email_archive",
    }]);
  }
  const now = new Date();
  const id = `arcconf_${body.archive_kind}_${body.period ?? "p"}`;
  const { error } = await db.schema(scope).from("archive_confirmation").upsert({
    id, archive_kind: body.archive_kind, period: String(body.period ?? "p"),
    vendor_ref: isNonEmptyString(body.vendor_ref) ? body.vendor_ref : null,
    retention_years_confirmed: typeof body.retention_years_confirmed === "number"
      ? body.retention_years_confirmed
      : null,
    confirmed_at: now.toISOString(),
    confirmed_by: isNonEmptyString(body.confirmed_by) ? body.confirmed_by : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_conf`, "core_archive.retention.confirmed",
    "archive_confirmation", id, {
      archive_kind: body.archive_kind,
      retention_years_confirmed: body.retention_years_confirmed ?? null,
      vendor_ref: body.vendor_ref ?? null,
    }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

// ------------------------------------------------ RR-04 destruction logging

/** POST /records/boxes {label, location, record_ids} */
export async function postStorageBox(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.label) || !isNonEmptyString(body.location)) {
    return validationError(requestId, [{
      type: "missing_field", field: "label", message: "label and location are required",
    }]);
  }
  const id = isNonEmptyString(body.id) ? body.id : `sbox_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("storage_box").upsert({
    id, label: body.label, location: body.location,
    record_ids: Array.isArray(body.record_ids) ? body.record_ids : [],
    sealed_at: new Date().toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_box`, "storage_box.created", "storage_box", id, {
    label: body.label, location: body.location,
    record_count: Array.isArray(body.record_ids) ? body.record_ids.length : 0,
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/**
 * POST /records/destruction-log/reconcile
 *
 * RR-04. Reconciles boxes marked destroyed against the records actually
 * disposed. An append-only destruction log cannot detect either failure the
 * control exists for — a box destroyed whose records are still live, or
 * records disposed whose box was never closed out.
 */
export async function postDestructionLogReconcile(
  _req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;

  const now = new Date();
  // Whole registers, not PostgREST's silent first 1000 rows: with ~2,700
  // records a freshly disposed box was never even looked at, so the control
  // reported no mismatch for exactly the failure it exists to catch (caught by
  // the records-admin partner-flow suite).
  const boxes = await selectAll<Any>(db, scope, "storage_box", "id, label, record_ids, destroyed_at");
  const records = await selectAll<Any>(db, scope, "record", "id, disposed_at, record_class");
  const disposed = new Set(
    (records ?? []).filter((r: Any) => r.disposed_at).map((r: Any) => String(r.id)),
  );

  const mismatches: string[] = [];
  for (const b of boxes ?? []) {
    const ids: string[] = (Array.isArray(b.record_ids) ? b.record_ids : []).map(String);
    const live = ids.filter((i) => !disposed.has(i));
    const gone = ids.filter((i) => disposed.has(i));

    let kind: string | null = null;
    if (b.destroyed_at && live.length > 0) kind = "box_destroyed_records_live";
    else if (!b.destroyed_at && gone.length > 0 && gone.length === ids.length) {
      kind = "records_disposed_box_open";
    }
    if (!kind) continue;

    const mid = `dlmm_${b.id}`;
    await db.schema(scope).from("destruction_log_mismatch").upsert({
      id: mid, box_id: b.id, kind,
      detail: { box: b.label, live_records: live.length, disposed_records: gone.length },
      detected_at: now.toISOString(), provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id" });
    await emit(db, scope, `ev_${mid}_det`, "destruction_log.mismatch.detected",
      "destruction_log_mismatch", mid, {
        kind, box_id: b.id, live_records: live.length,
      }, ctx);
    await emit(db, scope, `ev_${mid}_entry`, "destruction_log.entry_id",
      "destruction_log_mismatch", mid, { destruction_log_entry_id: mid, box_id: b.id }, ctx);
    mismatches.push(mid);
  }
  return jsonResponse({
    data: { boxes: (boxes ?? []).length, mismatches: mismatches.length },
  }, 200, requestId);
}

/** POST /records/destruction-log/:id/resolve {resolution} */
export async function postDestructionLogResolve(
  req: Request, mismatchId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.resolution)) {
    return validationError(requestId, [{
      type: "missing_field", field: "resolution",
      message: "a mismatch closed with no explanation is closed, not resolved",
    }]);
  }
  const { error } = await db.schema(scope).from("destruction_log_mismatch").update({
    resolved_at: new Date().toISOString(), resolution: body.resolution,
  }).eq("id", mismatchId);
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${mismatchId}_res`, "destruction_log.mismatch.resolved",
    "destruction_log_mismatch", mismatchId, { resolution: body.resolution }, ctx);
  return jsonResponse({ data: { id: mismatchId, resolved: true } }, 200, requestId);
}

// --------------------------------------------------------------- RR-08 CDD

/** POST /records/cdd-profiles {id?, entity_id, risk_tier, last_refreshed_at?} */
export async function postCddProfile(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const risk = String(body.risk_tier);
  if (!["low", "moderate", "high"].includes(risk)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "risk_tier", message: "must be low, moderate or high",
    }]);
  }
  const last = isNonEmptyString(body.last_refreshed_at)
    ? new Date(body.last_refreshed_at)
    : new Date();
  // The refresh cycle is RISK-BASED. A single interval for every member is the
  // failure mode: it is either too slow for high risk or pointless churn for
  // low.
  const due = new Date(last.getTime());
  due.setUTCMonth(due.getUTCMonth() + CDD_REFRESH_MONTHS[risk]);

  const id = isNonEmptyString(body.id) ? body.id : `cdd_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("cdd_profile").upsert({
    id, entity_id: isNonEmptyString(body.entity_id) ? body.entity_id : null,
    risk_tier: risk, last_refreshed_at: last.toISOString(),
    refresh_due_at: due.toISOString(), provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_due`, "cdd.refresh.due", "cdd_profile", id, {
    refresh_due_at: due.toISOString(), risk_tier: risk,
    cycle_months: CDD_REFRESH_MONTHS[risk],
  }, ctx);
  return jsonResponse({ data: { id, refresh_due_at: due.toISOString() } }, 201, requestId);
}

/** POST /records/cdd-profiles/:id/refresh {refreshed_by, risk_tier?} */
export async function postCddRefresh(
  req: Request, profileId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: p } = await db.schema(scope).from("cdd_profile")
    .select("id, risk_tier, refresh_due_at, entity_id").eq("id", profileId).maybeSingle();
  if (!p) return notFoundResponse(requestId, "cdd_profile", profileId);
  if (!isNonEmptyString(body.refreshed_by)) {
    return validationError(requestId, [{
      type: "missing_field", field: "refreshed_by", message: "is required",
    }]);
  }

  const now = new Date();
  const risk = isNonEmptyString(body.risk_tier) && ["low", "moderate", "high"].includes(body.risk_tier)
    ? body.risk_tier
    : String(p.risk_tier);
  const due = new Date(now.getTime());
  due.setUTCMonth(due.getUTCMonth() + CDD_REFRESH_MONTHS[risk]);

  const { error } = await db.schema(scope).from("cdd_profile").update({
    last_refreshed_at: now.toISOString(), refresh_due_at: due.toISOString(),
    risk_tier: risk, refreshed_by: body.refreshed_by, updated_at: now.toISOString(),
  }).eq("id", profileId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${profileId}_ref`, "cdd.profile.refreshed",
    "cdd_profile", profileId, {
      refreshed_by: body.refreshed_by, risk_tier: risk,
      refresh_due_at: due.toISOString(),
      // whether it was refreshed LATE is part of the record; a refresh that
      // silently drops its own lateness makes the cycle unfalsifiable
      refreshed_late: p.refresh_due_at ? now.toISOString() > String(p.refresh_due_at) : null,
    }, ctx);
  return jsonResponse({ data: { id: profileId, refresh_due_at: due.toISOString() } }, 200, requestId);
}

// ----------------------------------------------- RR-07 disposition method

/**
 * POST /records/:id/dispose-with-method {method, approved_by, retained_fields?}
 *
 * RR-07. A BSA/AML record past retention is ANONYMIZED rather than destroyed,
 * so the analytical series survives while the personal data does not. Recording
 * only "disposed" conflates two different acts with different consequences —
 * one of which leaves data behind.
 */
export async function postRecordDisposition(
  req: Request, recordId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const methods = ["destroyed", "anonymized", "returned"];
  if (!methods.includes(String(body.method)) || !isNonEmptyString(body.approved_by)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "method",
      message: `method in ${methods.join("/")} and approved_by are required`,
    }]);
  }
  const { data: rec } = await db.schema(scope).from("record")
    .select("id, record_class, retention_expires_at, legal_hold_flag, disposed_at")
    .eq("id", recordId).maybeSingle();
  if (!rec) return notFoundResponse(requestId, "record", recordId);

  // RR-11 / SC-02: the three disposal conditions still apply. A method choice
  // is not a bypass.
  const now = new Date();
  if (rec.legal_hold_flag === true) {
    return apiError(409, "record_under_hold", requestId, {
      title: "record is under legal hold", detail: "disposal is blocked regardless of method",
    });
  }
  if (!rec.retention_expires_at) {
    return apiError(409, "record_permanent", requestId, {
      title: "permanent record", detail: "a record with no expiry never becomes disposal eligible",
    });
  }
  if (String(rec.retention_expires_at) > now.toISOString()) {
    return apiError(409, "record_not_expired", requestId, {
      title: "retention has not expired",
      detail: `expires ${rec.retention_expires_at}`,
    });
  }

  const id = `rdisp_${recordId}`;
  const { error } = await db.schema(scope).from("record_disposition").upsert({
    id, record_id: recordId, method: body.method,
    disposed_at: now.toISOString(), approved_by: body.approved_by,
    retained_fields: body.method === "anonymized" ? (body.retained_fields ?? []) : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await db.schema(scope).from("record").update({
    disposed_at: now.toISOString(), disposal_approved_by: body.approved_by,
    disposal_approved_at: now.toISOString(),
  }).eq("id", recordId);

  await emit(db, scope, `ev_${id}_method`, "record.disposal_method", "record", recordId, {
    method: body.method, record_class: rec.record_class,
    retained_fields: body.method === "anonymized" ? (body.retained_fields ?? []) : null,
  }, ctx);
  await emit(db, scope, `ev_${id}_disposed`, "record.disposed", "record", recordId, {
    method: body.method, approved_by: body.approved_by,
  }, ctx);
  return jsonResponse({ data: { id, method: body.method } }, 200, requestId);
}

// ------------------------------------------------- RR-09 / RR-12 governance

/**
 * POST /records/policy-reviews
 * {cycle_year, reviewed_by, policy_document_version, regulation_changes?}
 */
export async function postRecordsPolicyReview(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const year = typeof body.cycle_year === "number" ? body.cycle_year : NaN;
  if (!Number.isFinite(year) || !isNonEmptyString(body.reviewed_by) ||
      !isNonEmptyString(body.policy_document_version)) {
    return validationError(requestId, [{
      type: "missing_field", field: "cycle_year",
      message: "cycle_year, reviewed_by and policy_document_version are required",
    }]);
  }

  // The count of amendments is COUNTED from the schedule, not asserted. A
  // review claiming it considered the schedule while amending nothing is the
  // rubber-stamp case RR-09 exists to make visible.
  // Every entry — an unbounded select stopped at 1000 and under-counted
  // amendments once the schedule passed that (caught by the flow suite).
  const entries = await selectAll<Any>(
    db, scope, "retention_schedule_entry", "id, version, effective_at, record_class",
  );
  const amended = (entries ?? []).filter((e: Any) => Number(e.version) > 1).length;

  const now = new Date();
  const id = `rpolrev_${year}`;
  const { error } = await db.schema(scope).from("records_policy_review").upsert({
    id, cycle_year: year, reviewed_at: now.toISOString(),
    reviewed_by: body.reviewed_by,
    policy_document_version: body.policy_document_version,
    schedule_entries_amended: amended,
    regulation_changes_considered: Array.isArray(body.regulation_changes)
      ? body.regulation_changes
      : [],
    board_report_filed_at: now.toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_rev`, "records.policy_review.completed",
    "records_policy_review", id, {
      cycle_year: year, reviewed_by: body.reviewed_by,
      schedule_entries_amended: amended,
      regulation_changes_considered: body.regulation_changes ?? [],
    }, ctx);
  await emit(db, scope, `ev_${id}_pub`, "policy.revision.published",
    "records_policy_review", id, {
      "policy.document_version": body.policy_document_version, cycle_year: year,
    }, ctx);
  await emit(db, scope, `ev_${id}_board`, "records.board_report.filed",
    "records_policy_review", id, {
      cycle_year: year, schedule_entries_amended: amended,
    }, ctx);
  return jsonResponse({ data: { id, schedule_entries_amended: amended } }, 201, requestId);
}

/**
 * PUT /records/contacts/:role {assigned_ref} — or {vacate: true}
 *
 * RR-12. A register of ROLES with current holders, not of people. It records
 * that a named responsibility has a holder and when it was vacated; it does
 * not model employment. Same shape as `cash_asset.custodian_user_id` — a
 * pointer, not an entity — which is the line the standing rule draws.
 */
export async function putRecordsContact(
  req: Request, role: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const now = new Date();
  const vacating = body.vacate === true;
  if (!vacating && !isNonEmptyString(body.assigned_ref)) {
    return validationError(requestId, [{
      type: "missing_field", field: "assigned_ref",
      message: "assigned_ref is required unless vacating",
    }]);
  }
  const id = `rcontact_${role}`;
  const { error } = await db.schema(scope).from("records_contact").upsert({
    id, role,
    assigned_ref: vacating ? null : body.assigned_ref,
    assigned_at: vacating ? null : now.toISOString(),
    vacated_at: vacating ? now.toISOString() : null,
    updated_at: now.toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  if (vacating) {
    // A VACANCY is the interesting state: the responsibility still exists and
    // nobody holds it. Recording only assignments makes a vacancy look
    // identical to a role that was never created.
    await emit(db, scope, `ev_${id}_vac_${now.getTime()}`, "records.contact_vacated",
      "records_contact", id, { role }, ctx);
  } else {
    await emit(db, scope, `ev_${id}_asg`, "records.contact.assigned",
      "records_contact", id, { role, assigned_ref: body.assigned_ref }, ctx);
    await emit(db, scope, `ev_${id}_asgs`, "records.contacts.assigned",
      "records_contact", id, { role, assigned_ref: body.assigned_ref }, ctx);
  }
  return jsonResponse({ data: { role, vacated: vacating } }, 200, requestId);
}
