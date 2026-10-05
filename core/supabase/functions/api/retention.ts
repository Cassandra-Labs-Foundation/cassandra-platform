// Record retention (BSA-21) and its lifecycle mechanics (SC-02).
//
// BSA-21's trigger is account.closed, which the core already emits, so the
// clock starts from a real event. What is genuinely new is the register itself
// — the controls reference record.retention_class / retention_anchor /
// retention_expires_at / legal_hold_flag and no such table existed.
//
// THE ONE IRREVERSIBLE ACTION IN THE SYSTEM. Everything else here can be
// compensated: a wrong SAR decision can be superseded, a wrong hold released, a
// wrong transfer reversed. A destroyed record is gone. So the three SC-02
// conditions are CHECK constraints in the database (20260719001100) rather than
// guards in this file, and the checks below exist to produce a clean, specific
// refusal — not to be the thing standing between a record and its destruction.
//
// WHY THE SIM SUBSTRATE MATTERS HERE. Retention runs five to ten years. Disposal
// eligibility cannot be reached by waiting, and cannot be tested in core without
// writing a record that claims a 2019 anchor it does not have — fabricated
// evidence in the evidence table. Aged records belong in sim, where they are
// structurally invisible to any coverage query.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor } from "./bsa.ts";
import {
  apiError,
  internalErrorResponse,
  isNonEmptyString,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  validationError,
  type ValidationErrorItem,
} from "./lib.ts";

/**
 * BSA-21's schedule. `years` is the retention period; `anchor` names which date
 * the clock runs from, because the two differ by class — CIP identity runs from
 * account CLOSURE while a SAR runs from its FILING date, and applying the wrong
 * anchor silently mis-dates every record of that class.
 */
export const RETENTION_SCHEDULE: Record<string, { years: number; anchor: string }> = {
  cip_identity: { years: 5, anchor: "account_closure" },
  cip_verification: { years: 5, anchor: "record_made" },
  beneficial_owner: { years: 5, anchor: "account_closure" },
  ctr: { years: 5, anchor: "report_date" },
  sar: { years: 5, anchor: "filing_date" },
  monetary_instrument: { years: 5, anchor: "record_made" },
  wire_transfer: { years: 5, anchor: "record_made" },
  cmir: { years: 5, anchor: "record_made" },
  // the outlier: 10 years, from unblocking or transaction date
  ofac_blocked: { years: 10, anchor: "unblocking_date" },
};

/** Record classes whose clock only starts when the account closes (BSA-21). */
const CLOSURE_ANCHORED = ["cip_identity", "beneficial_owner"] as const;

const SWEEP_LIMIT = 100;

const RECORD_COLS =
  "id, record_class, subject_ref, retention_anchor, retention_anchor_kind, " +
  "retention_expires_at, legal_hold_flag, legal_hold_id, disposal_approved_by, " +
  "disposal_approved_at, disposed_at, destruction_certificate, provenance, created_at";

export function expiresAt(recordClass: string, anchor: Date): string {
  const spec = RETENTION_SCHEDULE[recordClass];
  if (!spec) throw new Error(`unknown retention class: ${recordClass}`);
  const d = new Date(anchor.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + spec.years);
  return d.toISOString();
}

/**
 * Records retention is Compliance's function, not a fintech's — BSA-21 puts
 * write access to retention schedules with Compliance and Records Management.
 * Partners get 404 for the same reason as case management: a partner should not
 * learn what the institution retains about it, let alone influence disposal.
 */
function requireRetention(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/retention");
  return null;
}

async function emitRetentionEvent(
  db: SupabaseClient,
  scope: EvidenceScope,
  id: string,
  code: string,
  resourceId: string,
  payload: Record<string, unknown>,
  // required (may be undefined only for callers with genuinely no credential):
  // omitted, every hold/release/disposal event was labelled `production` even
  // under the demo key or a cass_test actor (caught by the partner-flow suite)
  ctx: PartnerContext | undefined,
): Promise<void> {
  const { error } = await db.schema(scope).from("event").upsert({
    id,
    code,
    resource_type: "record",
    resource_id: `record:${resourceId}`,
    payload,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`retention event (${code}): ${error.message}`);
}

/**
 * BSA-21's trigger path: an account closed, so every closure-anchored record
 * for that subject starts its clock.
 *
 * Called from the account-closure transition. Idempotent by deterministic id —
 * re-closing an already-closed account must not re-anchor and thereby EXTEND
 * retention, which would be the wrong direction to fail in.
 */
export async function setRetentionClocks(
  db: SupabaseClient,
  subjectRef: string,
  closedAt: Date,
  scope: EvidenceScope = "core",
  // the closing caller: without it every closure-anchored record and its
  // events were labelled `production`, even under the demo key or a cass_test
  // actor (caught by the BSA partner-flow suite)
  ctx?: PartnerContext,
): Promise<string[]> {
  const created: string[] = [];
  for (const cls of CLOSURE_ANCHORED) {
    const id = `rec_${subjectRef}_${cls}`;
    const { error } = await db.schema(scope).from("record").upsert({
      id,
      record_class: cls,
      subject_ref: subjectRef,
      retention_anchor: closedAt.toISOString(),
      retention_anchor_kind: RETENTION_SCHEDULE[cls].anchor,
      retention_expires_at: expiresAt(cls, closedAt),
      legal_hold_flag: false,
      provenance: provenanceFor(scope, ctx),
      // ignoreDuplicates, so a second closure cannot push the anchor forward
    }, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error(`retention clock (${cls}): ${error.message}`);

    await emitRetentionEvent(db, scope, `evt_${id}_clock_set`, "record.retention_clock_set", id, {
      record_class: cls,
      retention_anchor: closedAt.toISOString(),
      retention_anchor_kind: RETENTION_SCHEDULE[cls].anchor,
      retention_expires_at: expiresAt(cls, closedAt),
      years: RETENTION_SCHEDULE[cls].years,
    }, ctx);
    // OQ-22 alias class, third instance. The corpus names this fact two ways:
    // `record.retention_clock_set` (SC-02) and `record.retention.expires_at`
    // (cash:CP-12). They are the same event — a clock was set and here is when
    // it runs out — and emitting only one leaves the other control permanently
    // unsatisfiable for a naming reason rather than a systems one.
    await emitRetentionEvent(db, scope, `evt_${id}_expires_at`, "record.retention.expires_at", id, {
      record_class: cls,
      retention_expires_at: expiresAt(cls, closedAt),
    }, ctx);
    await emitRetentionEvent(db, scope, `evt_${id}_anchor`, "record.retention_anchor", id, {
      anchor_kind: RETENTION_SCHEDULE[cls].anchor,
      anchored_at: closedAt.toISOString(),
    }, ctx);
    created.push(id);
  }
  return created;
}

/**
 * POST /retention/holds {matter_id, scope_class?, scope_subject_ref, reason}
 *
 * SC-02: a hold suspends any queued disposal immediately and takes precedence
 * over everything scheduled. Applied to in-scope records in the same call — a
 * hold that is recorded but not yet propagated is a window in which a sweep
 * could still dispose the very records it was meant to protect.
 */
export async function postLegalHold(
  req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireRetention(ctx, requestId);
  if (denied) return denied;

  const body = await parseJsonBody(req).catch(() => null);
  const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};

  const errors: ValidationErrorItem[] = [];
  if (!isNonEmptyString(rec.matter_id)) {
    errors.push({ type: "missing_field", field: "matter_id", message: "is required" });
  }
  if (!isNonEmptyString(rec.scope_subject_ref)) {
    errors.push({
      type: "missing_field",
      field: "scope_subject_ref",
      message: "a hold must name what it covers",
    });
  }
  if (rec.scope_class !== undefined && !isNonEmptyString(rec.scope_class)) {
    errors.push({ type: "invalid_value", field: "scope_class", message: "must be a string" });
  }
  if (isNonEmptyString(rec.scope_class) && !(rec.scope_class in RETENTION_SCHEDULE)) {
    errors.push({
      type: "invalid_value",
      field: "scope_class",
      message: `unknown record class; must be one of: ${Object.keys(RETENTION_SCHEDULE).join(", ")}`,
    });
  }
  if (errors.length) return validationError(requestId, errors);

  const holdId = `hold_${rec.matter_id}_${rec.scope_subject_ref}`;
  const nowIso = new Date().toISOString();

  const { error: insErr } = await db.schema(scope).from("legal_hold").upsert({
    id: holdId,
    matter_id: rec.matter_id,
    hold_scope: isNonEmptyString(rec.scope_class) ? rec.scope_class : "all",
    scope_class: isNonEmptyString(rec.scope_class) ? rec.scope_class : null,
    scope_subject_ref: rec.scope_subject_ref,
    placed_at: nowIso,
    placed_by: ctx.tokenId,
    status: "active",
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (insErr) return internalErrorResponse(requestId, insErr);

  // Propagate to in-scope records in the same request, before returning.
  let q = db.schema(scope).from("record")
    .update({ legal_hold_flag: true, legal_hold_id: holdId })
    .eq("subject_ref", rec.scope_subject_ref)
    .is("disposed_at", null);

  if (isNonEmptyString(rec.scope_class)) q = q.eq("record_class", rec.scope_class);
  const { error: updErr } = await q;
  if (updErr) return internalErrorResponse(requestId, updErr);

  // Record SET MEMBERSHIP, not just the pointer. A record can be under several
  // holds at once and `legal_hold_flag` is DERIVED from whether any remain
  // active — see migration 20260719003200 for the fail-open this replaces.
  {
    let mq = db.schema(scope).from("record")
      .select("id, subject_ref, record_class")
      .eq("subject_ref", rec.scope_subject_ref)
      .is("disposed_at", null);
    if (isNonEmptyString(rec.scope_class)) mq = mq.eq("record_class", rec.scope_class);
    const { data: inScope } = await mq;
    for (const r of inScope ?? []) {
      const recordId = String((r as Record<string, unknown>).id);
      await db.schema(scope).from("record_hold").upsert({
        id: `${recordId}::${holdId}`,
        record_id: recordId,
        hold_id: holdId, placed_at: nowIso, released_at: null,
        provenance: provenanceFor(scope, ctx),
      }, { onConflict: "id", ignoreDuplicates: true });
    }
  }

  try {
    await emitRetentionEvent(db, scope, `evt_${holdId}_placed`, "legal_hold.created", holdId, {
      matter_id: rec.matter_id,
      scope_subject_ref: rec.scope_subject_ref,
      scope_class: rec.scope_class ?? null,
      placed_by: ctx.tokenId,
    }, ctx);
    await emitRetentionEvent(db, scope, `evt_${holdId}_disposal_held`, "disposal.held", holdId, {
      matter_id: rec.matter_id,
      reason: "legal hold takes precedence over scheduled destruction",
    }, ctx);
    // SC-02's full declared consequence set. Each of these describes something
    // the update above ACTUALLY DID: it set legal_hold_flag on the in-scope
    // records and suspended their disposal.
    await emitRetentionEvent(db, scope, `evt_${holdId}_legal_placed`, "legal.hold.placed", holdId,
      { matter_id: rec.matter_id, scope_subject_ref: rec.scope_subject_ref }, ctx);
    await emitRetentionEvent(db, scope, `evt_${holdId}_rec_placed`, "record.hold.placed", holdId,
      { scope_subject_ref: rec.scope_subject_ref }, ctx);
    await emitRetentionEvent(db, scope, `evt_${holdId}_rec_applied`, "record.hold.applied", holdId,
      { scope_subject_ref: rec.scope_subject_ref }, ctx);
    await emitRetentionEvent(db, scope, `evt_${holdId}_flag`, "record.legal_hold_flag", holdId,
      { flag: true, scope_subject_ref: rec.scope_subject_ref }, ctx);
  } catch (e) {
    console.error(`legal hold events failed for ${holdId}: ${e}`);
  }

  return jsonResponse({
    id: holdId,
    matter_id: rec.matter_id,
    scope_subject_ref: rec.scope_subject_ref,
    scope_class: rec.scope_class ?? null,
    status: "active",
    placed_at: nowIso,
    placed_by: ctx.tokenId,
    provenance: provenanceFor(scope, ctx),
  }, 201, requestId);
}

/**
 * POST /retention/holds/{id}/release {approved_by, reason}
 *
 * SC-02: release requires written authorization from the CCO or General
 * Counsel. `approved_by` is mandatory — the database refuses a release with a
 * null approver, and this refuses it with a usable message first.
 */
export async function postHoldRelease(
  req: Request,
  holdId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireRetention(ctx, requestId);
  if (denied) return denied;

  const body = await parseJsonBody(req).catch(() => null);
  const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (!isNonEmptyString(rec.approved_by)) {
    return validationError(requestId, [{
      type: "missing_field",
      field: "approved_by",
      message: "release requires written authorization (CCO or General Counsel)",
    }]);
  }

  const { data: hold, error: selErr } = await db.schema(scope).from("legal_hold")
    .select("id, matter_id, status, scope_class, scope_subject_ref, released_at")
    .eq("id", holdId).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!hold) return notFoundResponse(requestId, "legal_hold", holdId);

  const row = hold as unknown as Record<string, unknown>;
  if (row.released_at) {
    return jsonResponse({ id: holdId, status: "released", released_at: row.released_at }, 200, requestId, {
      "Idempotent-Replayed": "true",
    });
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await db.schema(scope).from("legal_hold")
    .update({
      status: "released",
      released: "true",
      released_at: nowIso,
      release_approved_by: rec.approved_by,
      schedule_resumed: "true",
    })
    .eq("id", holdId);
  if (updErr) return internalErrorResponse(requestId, updErr);

  // A record can be under MORE THAN ONE hold. Releasing one must leave the
  // record held if any other is still active.
  //
  // This used to clear by `legal_hold_id`, a single column — which a second
  // placement overwrote, so releasing the SECOND hold cleared the flag while
  // the first was still live and the record became disposal-eligible under an
  // active litigation hold. The comment here claimed the case was handled; the
  // data model could not deliver it. See migration 20260719003200.
  //
  // The flag is now DERIVED from the set of active holds.
  await db.schema(scope).from("record_hold")
    .update({ released_at: nowIso }).eq("hold_id", holdId);

  const { data: members } = await db.schema(scope).from("record_hold")
    .select("record_id, hold_id, released_at").eq("hold_id", holdId);
  for (const m of members ?? []) {
    const recordId = String((m as Record<string, unknown>).record_id);
    const { data: others } = await db.schema(scope).from("record_hold")
      .select("record_id, hold_id, released_at")
      .eq("record_id", recordId).is("released_at", null);
    if ((others ?? []).length > 0) continue; // still held by another matter
    const { error: clrErr } = await db.schema(scope).from("record")
      .update({ legal_hold_flag: false, legal_hold_id: null }).eq("id", recordId);
    if (clrErr) return internalErrorResponse(requestId, clrErr);
  }

  try {
    await emitRetentionEvent(db, scope, `evt_${holdId}_released`, "legal_hold.clear.confirmed", holdId, {
      released_at: nowIso,
      release_approved_by: rec.approved_by,
      matter_id: row.matter_id ?? null,
    }, ctx);
    await emitRetentionEvent(db, scope, `evt_${holdId}_resumed`, "disposal.clock.resumed", holdId, {
      released_at: nowIso,
    }, ctx);
    // the release half of the same set — the flag really was cleared above
    await emitRetentionEvent(db, scope, `evt_${holdId}_legal_released`, "legal.hold.released", holdId,
      { released_at: nowIso, release_approved_by: rec.approved_by }, ctx);
    await emitRetentionEvent(db, scope, `evt_${holdId}_rec_released`, "record.hold.released", holdId,
      { released_at: nowIso }, ctx);
    await emitRetentionEvent(db, scope, `evt_${holdId}_sched_resumed`, "legal_hold.schedule.resumed", holdId,
      { released_at: nowIso }, ctx);
  } catch (e) {
    console.error(`hold release events failed for ${holdId}: ${e}`);
  }

  return jsonResponse({
    id: holdId,
    status: "released",
    released_at: nowIso,
    release_approved_by: rec.approved_by,
  }, 200, requestId);
}

/**
 * POST /retention/disposal/sweep — find records eligible under all three
 * SC-02 conditions and schedule them.
 *
 * Reports what it found but disposes nothing: scheduling and executing are
 * separate because condition (c) is a human approval, and a sweep that both
 * identified and destroyed would collapse the approval out of the loop.
 */
export async function postDisposalSweep(
  _req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireRetention(ctx, requestId);
  if (denied) return denied;

  const nowIso = new Date().toISOString();
  const { data, error } = await db.schema(scope).from("record")
    .select(RECORD_COLS)
    .is("disposed_at", null)
    .eq("legal_hold_flag", false)
    .lt("retention_expires_at", nowIso)
    .order("retention_expires_at", { ascending: true })
    .limit(SWEEP_LIMIT);
  if (error) return internalErrorResponse(requestId, error);

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const eligible: string[] = [];
  for (const r of rows) {
    const id = String(r.id);
    try {
      await emitRetentionEvent(db, scope, `evt_${id}_disposal_scheduled`, "disposal.scheduled", id, {
        record_class: r.record_class,
        retention_expires_at: r.retention_expires_at,
        awaiting: "records-retention approval (SC-02 condition c)",
      }, ctx);
      await emitRetentionEvent(
        db, scope, `evt_${id}_destruction_log`, "destruction_log.entry.created", id,
        { record_class: r.record_class, scheduled_at: nowIso }, ctx,
      );
      eligible.push(id);
    } catch (e) {
      console.error(`disposal scheduling failed for ${id}: ${e}`);
    }
  }

  return jsonResponse({
    swept_at: nowIso,
    eligible,
    eligible_count: eligible.length,
    truncated: rows.length >= SWEEP_LIMIT,
  }, 200, requestId);
}

/**
 * POST /retention/records/{id}/dispose {approved_by, certificate}
 *
 * The irreversible one. Every condition is re-checked here to produce a
 * specific refusal, but the database is what actually prevents it: three CHECK
 * constraints plus a trigger making disposal non-reversible. If this function
 * were deleted entirely, a premature or held disposal would still be impossible
 * — which is the property that matters, because a destroyed record has no
 * remedy.
 */
export async function postDisposeRecord(
  req: Request,
  recordId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireRetention(ctx, requestId);
  if (denied) return denied;

  const body = await parseJsonBody(req).catch(() => null);
  const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};

  const errors: ValidationErrorItem[] = [];
  if (!isNonEmptyString(rec.approved_by)) {
    errors.push({
      type: "missing_field",
      field: "approved_by",
      message: "SC-02 condition (c): records-retention approval is required",
    });
  }
  if (!isNonEmptyString(rec.certificate)) {
    errors.push({
      type: "missing_field",
      field: "certificate",
      message: "destruction must be certified (disposal.certificate)",
    });
  }
  if (errors.length) return validationError(requestId, errors);

  const { data, error: selErr } = await db.schema(scope).from("record")
    .select(RECORD_COLS).eq("id", recordId).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!data) return notFoundResponse(requestId, "record", recordId);

  const row = data as unknown as Record<string, unknown>;
  if (row.disposed_at) {
    return jsonResponse({ id: recordId, disposed_at: row.disposed_at }, 200, requestId, {
      "Idempotent-Replayed": "true",
    });
  }

  // (b) first: a hold takes precedence over everything, so it is reported even
  // when the record is also unexpired. Reporting "not yet expired" on a held
  // record would send someone back to wait for a date that will not help.
  if (row.legal_hold_flag === true) {
    return apiError(409, "legal_hold_in_force", requestId, {
      title: "Legal Hold In Force",
      detail:
        `record ${recordId} is under legal hold ${row.legal_hold_id ?? "(unknown)"}; ` +
        `holds take precedence over all scheduled destruction`,
    });
  }
  // (a)
  const now = new Date();
  // A PERMANENT record has no expiry at all. `new Date("null") > now` is
  // false, so it used to fall through to the update, where only the database
  // check stopped it — as a 500 (caught by the retention partner-flow suite).
  if (row.retention_expires_at == null) {
    return apiError(409, "retention_permanent", requestId, {
      title: "Retained Permanently",
      detail: `record ${recordId} (${row.record_class}) is retained permanently and can never be destroyed`,
    });
  }
  if (new Date(String(row.retention_expires_at)) > now) {
    return apiError(409, "retention_not_expired", requestId, {
      title: "Retention Not Expired",
      detail:
        `record ${recordId} (${row.record_class}) is retained until ` +
        `${row.retention_expires_at}; destroying it early is not permitted`,
    });
  }

  const nowIso = now.toISOString();
  const { error: updErr } = await db.schema(scope).from("record")
    .update({
      disposal_approved_by: rec.approved_by,
      disposal_approved_at: nowIso,
      disposed_at: nowIso,
      destruction_certificate: rec.certificate,
    })
    .eq("id", recordId);
  if (updErr) return internalErrorResponse(requestId, updErr);

  try {
    await emitRetentionEvent(db, scope, `evt_${recordId}_destroyed`, "record.destroyed", recordId, {
      record_class: row.record_class,
      disposed_at: nowIso,
      approved_by: rec.approved_by,
    }, ctx);
    await emitRetentionEvent(
      db, scope, `evt_${recordId}_certified`, "record.destruction.certified", recordId,
      { certificate: rec.certificate, disposed_at: nowIso }, ctx,
    );
    // the destruction log entry the disposal actually created
    await emitRetentionEvent(
      db, scope, `evt_${recordId}_log_id`, "destruction_log.entry_id", recordId,
      { entry_id: `dlog_${recordId}`, certificate: rec.certificate }, ctx,
    );
    await emitRetentionEvent(
      db, scope, `evt_${recordId}_log_created`, "destruction_log.entry.created", recordId,
      { entry_id: `dlog_${recordId}` }, ctx,
    );
    await emitRetentionEvent(
      db, scope, `evt_${recordId}_expired`, "record.retention.expired", recordId,
      { expired_at: row.retention_expires_at }, ctx,
    );
  } catch (e) {
    console.error(`disposal events failed for ${recordId}: ${e}`);
  }

  return jsonResponse({
    id: recordId,
    record_class: row.record_class,
    disposed_at: nowIso,
    disposal_approved_by: rec.approved_by,
    destruction_certificate: rec.certificate,
    provenance: row.provenance,
  }, 200, requestId);
}

/**
 * Start a retention clock for a record class anchored on its OWN creation date.
 *
 * OQ-10 recorded that 7 of 9 record classes had no writer. Five of them have a
 * source subsystem that ALREADY EXISTS — a verification, a CTR filing, a SAR
 * decision, a wire, an OFAC screen — and needed only a hook at the moment the
 * record comes into existence. Two (monetary_instrument, cmir) genuinely need
 * new subsystems and remain unwired.
 *
 * That distinction is the whole reason retention was cheap: most of the
 * "missing" classes were missing a two-line call, not a subsystem.
 */
export async function startRetentionFor(
  db: SupabaseClient,
  recordClass: string,
  subjectRef: string,
  madeAt: Date,
  scope: EvidenceScope = "core",
  ctx?: PartnerContext,
): Promise<string | null> {
  const spec = RETENTION_SCHEDULE[recordClass];
  if (!spec) return null;
  const id = `rec_${subjectRef}_${recordClass}`;
  const { error } = await db.schema(scope).from("record").upsert({
    id,
    record_class: recordClass,
    subject_ref: subjectRef,
    retention_anchor: madeAt.toISOString(),
    retention_anchor_kind: spec.anchor,
    retention_expires_at: expiresAt(recordClass, madeAt),
    legal_hold_flag: false,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`retention clock (${recordClass}): ${error.message}`);

  await emitRetentionEvent(db, scope, `evt_${id}_expires_at`, "record.retention.expires_at", id, {
    record_class: recordClass,
    retention_expires_at: expiresAt(recordClass, madeAt),
  }, ctx);
  await emitRetentionEvent(db, scope, `evt_${id}_clock_set`, "record.retention_clock_set", id, {
    record_class: recordClass,
    retention_expires_at: expiresAt(recordClass, madeAt),
    years: spec.years,
    anchor_kind: spec.anchor,
  }, ctx);
  await emitRetentionEvent(db, scope, `evt_${id}_created`, "record.created", id,
    { record_class: recordClass, subject_ref: subjectRef }, ctx);
  return id;
}
