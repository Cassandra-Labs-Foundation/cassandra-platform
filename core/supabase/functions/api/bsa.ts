// BSA case management — the chain the gate's alerts have never had.
//
// core.case has been fully shaped since the first migration (status machine,
// type, sar_decision_timer, evidence, summary) and has never had a writer, so
// every alert CG-LGTXN-01 / CG-STR-01 / CG-STR-02 raised was a dead end: a real
// detection nobody could triage, escalate or decide on.
//
// This is deliberately the FIRST subsystem built, and it is the one that needs
// no fabricated data at all. Its trigger is bsa_alert.created, which the core
// already emits from real money movement through the real gate — a $12k
// transfer really happened and really tripped the threshold. Everything after
// it is real too. That is what makes it the right place to prove the
// provenance machinery works before anything depends on that machinery being
// correct.
//
// BSA-06: alerts triaged within 2 business days; unresolved ones escalate to a
//         case; cases reach a SAR/no-SAR decision within 30 days of detection
//         (60 where there is no suspect).
// BSA-07: the filing decision itself, and do-not-file decisions documented.
//
// WHO MAY DO THIS. Not partners. BSA case management is the chartered credit
// union's obligation, not a fintech's, and SAR confidentiality means a partner
// must not even learn that a case exists. Every endpoint here is closed to
// `partner` actors and a partner asking about a case gets 404, never 403.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type BsaRole, type PartnerContext } from "./auth.ts";
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
import { startRetentionFor } from "./retention.ts";

/** BSA-06: 2 business days from alert creation. */
const TRIAGE_BUSINESS_DAYS = 2;
/** BSA-06: 30 days from detection, or 60 where no suspect is identified. */
const SAR_DECISION_DAYS_WITH_SUSPECT = 30;
const SAR_DECISION_DAYS_NO_SUSPECT = 60;

/** How many rows one timer sweep will touch. Bounded like every other sweep. */
const SWEEP_LIMIT = 100;

const ALERT_COLS =
  "id, alert_type, details, entity_hash, event_id, requires_lookback, status, " +
  "triage_due_at, triaged_at, triage_outcome, case_id, provenance, created_at";
const CASE_COLS =
  "id, alert_id, type, status, summary, evidence, owner_id, opened_at, " +
  "sar_decision_due_at, decided_at, sar_decision, decision_rationale, opened_by, decided_by, concurred_by, provenance, created_at";

/**
 * Which schema this request's evidence lives in.
 *
 * `sim` is the TDD substrate: structurally separate, and the check constraints
 * make simulated rows unrepresentable in core (see 20260719000900). One
 * implementation serves both — if simulation had its own code path we would be
 * testing the simulator rather than the thing that ships.
 */
export type EvidenceScope = "core" | "sim";

export function provenanceFor(
  scope: EvidenceScope,
  ctx?: PartnerContext,
): "production" | "simulated" | "demo" {
  // sim wins outright: a simulated row is simulated whoever wrote it.
  if (scope === "sim") return "simulated";
  // otherwise the CREDENTIAL decides. Evidence written under the shared
  // bootstrap key is demo, because it cannot be attributed to an actor and the
  // traffic behind it was manufactured (analytics/seed.sh).
  return ctx?.evidenceProvenance ?? "production";
}

/**
 * Add N business days. Weekends only — federal holidays are NOT handled, so a
 * due date spanning one is up to a day early. Early is the safe direction for a
 * compliance timer (it surfaces the alert sooner), but it is an approximation
 * and calling it anything else would overstate what this computes.
 */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

/**
 * Two gates, in a deliberate order (OQ-08).
 *
 * CLASS first: case management belongs to the credit union, so a partner is
 * refused with 404 — under BSA-07 the existence of a case is itself the
 * confidential fact, and 403 would confirm it.
 *
 * ROLE second, and only for actors already inside: a cu_admin without the right
 * BSA role gets 403, because at that point the actor legitimately knows case
 * management exists and the honest answer is "not your duty".
 */
function requireBsa(
  ctx: PartnerContext,
  requestId: string,
  role?: BsaRole,
): Response | null {
  if (ctx.actorType === "partner") {
    return notFoundResponse(requestId, "route", "/bsa");
  }
  if (role && !ctx.roles.includes(role)) {
    return apiError(403, "insufficient_role", requestId, {
      title: "Insufficient Role",
      detail: `${role} is required for this action; this token carries ${
        ctx.roles.length ? ctx.roles.join(", ") : "no BSA role"
      }`,
    });
  }
  return null;
}

function alertResponse(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    alert_type: row.alert_type,
    status: row.status,
    entity_hash: row.entity_hash,
    event_id: row.event_id,
    requires_lookback: row.requires_lookback,
    triage_due_at: row.triage_due_at,
    triaged_at: row.triaged_at,
    triage_outcome: row.triage_outcome,
    case_id: row.case_id,
    // surfaced on every response: a consumer must never have to guess whether
    // the row it is looking at is real
    provenance: row.provenance,
    created_at: row.created_at,
  };
}

function caseResponse(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    alert_id: row.alert_id,
    type: row.type,
    status: row.status,
    summary: row.summary,
    evidence: row.evidence ?? [],
    opened_at: row.opened_at,
    sar_decision_due_at: row.sar_decision_due_at,
    decided_at: row.decided_at,
    sar_decision: row.sar_decision,
    decision_rationale: row.decision_rationale,
    opened_by: row.opened_by,
    decided_by: row.decided_by,
    concurred_by: row.concurred_by ?? [],
    provenance: row.provenance,
    created_at: row.created_at,
  };
}

/** Durable event, stamped with the scope's provenance. */
async function emitBsaEvent(
  db: SupabaseClient,
  scope: EvidenceScope,
  id: string,
  code: string,
  resourceType: string,
  resourceId: string,
  payload: Record<string, unknown>,
  // required: omitted, provenanceFor defaulted every case-chain event to
  // `production`, even under the demo key or a cass_test actor
  ctx: PartnerContext,
): Promise<void> {
  const { error } = await db.schema(scope).from("event").upsert({
    id,
    code,
    resource_type: resourceType,
    resource_id: `${resourceType}:${resourceId}`,
    payload,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`bsa event upsert (${code}): ${error.message}`);
}

/**
 * Raise a BSA alert, with the event that caused it (OQ-05).
 *
 * Every alert site used to insert bsa_alert directly with event_id NULL,
 * because an FK to core.event exists and no core.event row was ever created
 * for a money movement — so a non-null value violated the constraint and the
 * whole insert was silently dropped. The causing id was smuggled into the
 * free-text `details` instead, leaving alerts that could not be joined back to
 * what caused them. bsa_alert.event_id is a REQUIRED INPUT of BSA-06, so that
 * gap was not cosmetic.
 *
 * Fixed by writing the event FIRST and pointing the alert at it. The event's
 * code is `bsa_alert.created` — which is precisely BSA-06's declared trigger
 * event, so raising an alert now actually fires the thing the catalogue says
 * starts case management, rather than merely resembling it.
 *
 * Ids are deterministic (D26: "idempotent inserts ... prevents duplicates"), so
 * a retried gate evaluation converges on one alert instead of a duplicate.
 */
export async function raiseAlert(
  db: SupabaseClient,
  p: {
    alertType: string;
    entityHash: string | null;
    details: string;
    requiresLookback?: boolean;
    /** the resource whose evaluation raised this — seeds the deterministic ids */
    causeType: string;
    causeId: string;
    scope?: EvidenceScope;
    ctx?: PartnerContext;
  },
): Promise<{ alertId: string; eventId: string }> {
  const scope = p.scope ?? "core";
  const alertId = `alert_${p.causeId}_${p.alertType}`;
  const eventId = `evt_${alertId}`;
  const now = new Date();

  // Event first: the alert's FK points at it, so the order is load-bearing.
  const { error: evtErr } = await db.schema(scope).from("event").upsert({
    id: eventId,
    code: "bsa_alert.created",
    resource_type: p.causeType,
    resource_id: `${p.causeType}:${p.causeId}`,
    payload: { alert_type: p.alertType, details: p.details },
    provenance: provenanceFor(scope, p.ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (evtErr) throw new Error(`bsa_alert.created event: ${evtErr.message}`);

  const { error: alertErr } = await db.schema(scope).from("bsa_alert").upsert({
    id: alertId,
    alert_type: p.alertType,
    status: "open",
    requires_lookback: p.requiresLookback === false ? "false" : "true",
    entity_hash: p.entityHash,
    event_id: eventId,
    details: p.details,
    // BSA-06's 2-business-day clock starts at creation, not at first look
    triage_due_at: triageDueAt(now),
    provenance: provenanceFor(scope, p.ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (alertErr) throw new Error(`bsa_alert insert: ${alertErr.message}`);

  // BSA-06 lists bsa_alert.triage.timer among the events this step produces,
  // and setting triage_due_at above genuinely is that timer starting. Emitted
  // separately from bsa_alert.created because a consumer watching for the
  // deadline should not have to infer it from the creation event.
  const { error: timerErr } = await db.schema(scope).from("event").upsert({
    id: `${eventId}_triage_timer`,
    code: "bsa_alert.triage.timer",
    resource_type: "bsa_alert",
    resource_id: `bsa_alert:${alertId}`,
    payload: { due_at: triageDueAt(now), business_days: TRIAGE_BUSINESS_DAYS },
    provenance: provenanceFor(scope, p.ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (timerErr) throw new Error(`triage timer event: ${timerErr.message}`);

  return { alertId, eventId };
}

/**
 * POST /bsa/alerts/{id}/triage {outcome, note?, no_suspect?}
 *
 * BSA-06's first decision point. `resolved` closes the alert; `escalated` opens
 * a case and starts the SAR decision clock.
 */
export async function postAlertTriage(
  req: Request,
  alertId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  // BSA-06: the Investigations role opens and closes cases.
  const denied = requireBsa(ctx, requestId, "bsa_investigator");
  if (denied) return denied;

  const body = await parseJsonBody(req).catch(() => null);
  const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const outcome = rec.outcome;
  const note = rec.note;

  const errors: ValidationErrorItem[] = [];
  if (outcome !== "resolved" && outcome !== "escalated") {
    errors.push({
      type: "invalid_value",
      field: "outcome",
      message: 'must be "resolved" or "escalated"',
    });
  }
  // A resolved alert is a decision NOT to investigate, which is exactly the
  // decision an examiner will ask about. Undocumented is refused.
  if (outcome === "resolved" && !isNonEmptyString(note)) {
    errors.push({
      type: "missing_field",
      field: "note",
      message: "resolving an alert without investigating requires a documented rationale",
    });
  }
  if (errors.length) return validationError(requestId, errors);

  const { data: alert, error: selErr } = await db.schema(scope).from("bsa_alert")
    .select(ALERT_COLS).eq("id", alertId).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!alert) return notFoundResponse(requestId, "bsa_alert", alertId);

  const row = alert as unknown as Record<string, unknown>;
  if (row.triaged_at) {
    // Re-triage replays rather than re-deciding: a second triage would
    // overwrite the first decision and its rationale, losing the audit trail.
    return jsonResponse(alertResponse(row), 200, requestId, {
      "Idempotent-Replayed": "true",
    });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const patch: Record<string, unknown> = {
    triaged_at: nowIso,
    triage_outcome: outcome,
    status: outcome === "resolved" ? "closed" : "escalated",
  };

  let caseRow: Record<string, unknown> | null = null;
  if (outcome === "escalated") {
    const caseId = `case_${crypto.randomUUID()}`;
    // 30 days from DETECTION, not from triage. The clock starts when the
    // institution first knew, which is alert creation — triaging late does not
    // buy more time, and computing from `now` would silently extend it.
    const detectedAt = new Date(String(row.created_at ?? nowIso));
    const days = rec.no_suspect === true
      ? SAR_DECISION_DAYS_NO_SUSPECT
      : SAR_DECISION_DAYS_WITH_SUSPECT;
    const dueAt = new Date(detectedAt.getTime() + days * 86_400_000);

    const { error: caseErr } = await db.schema(scope).from("case").insert({
      id: caseId,
      alert_id: alertId,
      type: "investigation",
      status: "opened",
      summary: isNonEmptyString(note) ? note : `escalated from ${row.alert_type} alert`,
      evidence: [{ kind: "bsa_alert", id: alertId, details: row.details ?? null }],
      opened_at: nowIso,
      opened_by: ctx.tokenId,
      sar_decision_due_at: dueAt.toISOString(),
      provenance: provenanceFor(scope, ctx),
    });
    if (caseErr) return internalErrorResponse(requestId, caseErr);
    patch.case_id = caseId;

    try {
      await emitBsaEvent(
        db, scope, `evt_${caseId}_decision_timer`, "case.sar.decision.timer",
        "case", caseId,
        { due_at: dueAt.toISOString(), days, from: "detection", no_suspect: rec.no_suspect === true }, ctx,
      );
      await emitBsaEvent(db, scope, `evt_${caseId}_opened`, "case.opened", "case", caseId, {
        alert_id: alertId,
        alert_type: row.alert_type,
        sar_decision_due_at: dueAt.toISOString(),
        no_suspect: rec.no_suspect === true,
      }, ctx);
    } catch (e) {
      console.error(`case.opened event failed for ${caseId}: ${e}`);
    }

    const { data: fresh } = await db.schema(scope).from("case")
      .select(CASE_COLS).eq("id", caseId).maybeSingle();
    caseRow = (fresh as unknown as Record<string, unknown>) ?? null;
  }

  const { data: updated, error: updErr } = await db.schema(scope).from("bsa_alert")
    .update(patch).eq("id", alertId).select(ALERT_COLS).single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  try {
    await emitBsaEvent(
      db, scope, `evt_${alertId}_triaged`, "bsa_alert.triaged", "bsa_alert", alertId,
      { outcome, note: isNonEmptyString(note) ? note : null, case_id: patch.case_id ?? null }, ctx,
    );
  } catch (e) {
    console.error(`bsa_alert.triaged event failed for ${alertId}: ${e}`);
  }

  return jsonResponse({
    alert: alertResponse(updated as unknown as Record<string, unknown>),
    case: caseRow ? caseResponse(caseRow) : null,
  }, 200, requestId);
}

/**
 * POST /bsa/cases/{id}/decision {decision, rationale, evidence?}
 *
 * BSA-07's filing decision. A no_file decision REQUIRES a rationale: do-not-file
 * decisions must be documented and retained, and an undocumented one is the
 * finding an examiner is looking for.
 */
export async function postCaseDecision(
  req: Request,
  caseId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  // BSA-06: the BSA Officer has write access to SAR decisions.
  const denied = requireBsa(ctx, requestId, "bsa_officer");
  if (denied) return denied;

  const body = await parseJsonBody(req).catch(() => null);
  const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const decision = rec.decision;
  const rationale = rec.rationale;

  const errors: ValidationErrorItem[] = [];
  if (decision !== "file" && decision !== "no_file") {
    errors.push({
      type: "invalid_value",
      field: "decision",
      message: 'must be "file" or "no_file"',
    });
  }
  if (!isNonEmptyString(rationale)) {
    errors.push({
      type: "missing_field",
      field: "rationale",
      message: "every SAR decision must be documented, including a decision not to file",
    });
  }
  if (errors.length) return validationError(requestId, errors);

  const { data: kase, error: selErr } = await db.schema(scope).from("case")
    .select(CASE_COLS).eq("id", caseId).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!kase) return notFoundResponse(requestId, "case", caseId);

  const row = kase as unknown as Record<string, unknown>;
  if (row.decided_at) {
    return jsonResponse(caseResponse(row), 200, requestId, {
      "Idempotent-Replayed": "true",
    });
  }
  if (row.status === "closed") {
    return apiError(409, "invalid_state", requestId, {
      title: "Invalid State",
      detail: `case ${caseId} is closed; a decision cannot be recorded against it`,
    });
  }

  // SEGREGATION OF DUTIES (BSA-06). The actor who opened the investigation may
  // not decide its outcome, even holding both roles.
  //
  // Checked here AND enforced by ck_case_four_eyes in the database. Those are
  // not duplicate enforcement of one rule: the constraint makes the violation
  // impossible against any writer including service_role and a psql session,
  // while this check makes the refusal a clean 409 with an explanation instead
  // of a constraint violation surfacing as a 500. The database decides what is
  // possible; the application decides what is well-explained.
  if (row.opened_by && row.opened_by === ctx.tokenId) {
    return apiError(409, "segregation_of_duties", requestId, {
      title: "Segregation of Duties",
      detail:
        `token ${ctx.tokenId} opened this investigation and may not also decide it; ` +
        `BSA-06 requires the SAR decision to come from a different actor`,
    });
  }

  const nowIso = new Date().toISOString();
  // Whether the decision was late is computed and RECORDED, not silently
  // dropped. A SAR filed past the deadline is still filed, but the lateness is
  // itself reportable and must survive on the row.
  const dueAt = row.sar_decision_due_at ? new Date(String(row.sar_decision_due_at)) : null;
  const late = dueAt ? new Date(nowIso) > dueAt : false;

  const { data: updated, error: updErr } = await db.schema(scope).from("case")
    .update({
      status: "closed",
      decided_at: nowIso,
      decided_by: ctx.tokenId,
      // BSA-07's SAR committee, RECORDED not enforced: quorum and composition
      // are organizational controls this system does not police (OQ-09).
      concurred_by: Array.isArray(rec.concurred_by)
        ? (rec.concurred_by as unknown[]).map(String)
        : [],
      sar_decision: decision,
      decision_rationale: rationale,
    })
    .eq("id", caseId)
    .select(CASE_COLS)
    .single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  try {
    // BSA-06's second declared trigger. Recording the decision IS the
    // investigation completing, so this is the event the catalogue expects at
    // this point — emitted alongside the filing outcome rather than instead of
    // it, because they answer different questions (did the work finish / what
    // was decided).
    await emitBsaEvent(
      db, scope, `evt_${caseId}_investigation_complete`, "case.investigation_complete",
      "case", caseId,
      { decision, alert_id: row.alert_id ?? null, decided_at: nowIso }, ctx,
    );
    await emitBsaEvent(
      db, scope, `evt_${caseId}_decided`,
      decision === "file" ? "sar.filed" : "sar.decision_no_file",
      "case", caseId,
      {
        decision,
        rationale,
        alert_id: row.alert_id ?? null,
        decided_at: nowIso,
        due_at: row.sar_decision_due_at ?? null,
        late,
      }, ctx,
    );
  } catch (e) {
    console.error(`sar decision event failed for ${caseId}: ${e}`);
  }

  // BSA-21: SAR records and supporting documents retain 5 years from FILING.
  if (decision === "file") {
    try {
      await startRetentionFor(db, "sar", caseId, new Date(), scope, ctx);
    } catch (e) {
      console.error(`sar retention clock failed for ${caseId}: ${e}`);
    }
  }

  return jsonResponse(
    { ...caseResponse(updated as unknown as Record<string, unknown>), decision_was_late: late },
    200,
    requestId,
  );
}

/**
 * POST /bsa/timers/sweep — the NEGATIVE cases.
 *
 * Every other endpoint here records something that happened. This one records
 * something that DID NOT: an alert nobody triaged inside 2 business days, a
 * case nobody decided inside 30. Those are the failures a BSA examination
 * actually looks for, and they produce no event on their own precisely because
 * nothing occurred — without a sweep they are invisible.
 *
 * Emits a durable breach event per overdue row, with a deterministic id so
 * repeated sweeps converge on one event rather than one per sweep.
 */
export async function postTimerSweep(
  _req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  // No duty role: the sweep decides nothing, it only surfaces what nobody did.
  const denied = requireBsa(ctx, requestId);
  if (denied) return denied;

  const nowIso = new Date().toISOString();
  const breaches: { kind: string; id: string; due_at: string }[] = [];

  const { data: alerts, error: aErr } = await db.schema(scope).from("bsa_alert")
    .select("id, alert_type, triage_due_at, triaged_at")
    .is("triaged_at", null)
    .lt("triage_due_at", nowIso)
    .order("triage_due_at", { ascending: true })
    .limit(SWEEP_LIMIT);
  if (aErr) return internalErrorResponse(requestId, aErr);

  for (const a of (alerts ?? []) as unknown as Record<string, unknown>[]) {
    const id = String(a.id);
    try {
      await emitBsaEvent(
        db, scope, `evt_${id}_triage_overdue`, "bsa_alert.triage.overdue",
        "bsa_alert", id,
        { due_at: a.triage_due_at, alert_type: a.alert_type, detected_at: nowIso }, ctx,
      );
      breaches.push({ kind: "triage_overdue", id, due_at: String(a.triage_due_at) });
    } catch (e) {
      console.error(`triage-overdue event failed for ${id}: ${e}`);
    }
  }

  const { data: cases, error: cErr } = await db.schema(scope).from("case")
    .select("id, alert_id, sar_decision_due_at, decided_at")
    .is("decided_at", null)
    .lt("sar_decision_due_at", nowIso)
    .order("sar_decision_due_at", { ascending: true })
    .limit(SWEEP_LIMIT);
  if (cErr) return internalErrorResponse(requestId, cErr);

  for (const c of (cases ?? []) as unknown as Record<string, unknown>[]) {
    const id = String(c.id);
    try {
      await emitBsaEvent(
        db, scope, `evt_${id}_decision_overdue`, "case.sar_decision.overdue",
        "case", id,
        { due_at: c.sar_decision_due_at, alert_id: c.alert_id ?? null, detected_at: nowIso }, ctx,
      );
      breaches.push({ kind: "sar_decision_overdue", id, due_at: String(c.sar_decision_due_at) });
    } catch (e) {
      console.error(`decision-overdue event failed for ${id}: ${e}`);
    }
  }

  return jsonResponse({
    swept_at: nowIso,
    breaches,
    breach_count: breaches.length,
    // the sweep is bounded, so say when it did not see everything rather than
    // letting a capped run read as a clean one
    truncated: (alerts ?? []).length >= SWEEP_LIMIT || (cases ?? []).length >= SWEEP_LIMIT,
  }, 200, requestId);
}

/** GET /bsa/cases/{id} */
export async function getCase(
  caseId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireBsa(ctx, requestId);
  if (denied) return denied;

  const { data, error } = await db.schema(scope).from("case")
    .select(CASE_COLS).eq("id", caseId).maybeSingle();
  if (error) return internalErrorResponse(requestId, error);
  if (!data) return notFoundResponse(requestId, "case", caseId);
  return jsonResponse(caseResponse(data as unknown as Record<string, unknown>), 200, requestId);
}

/** Compute the triage deadline for a newly raised alert (BSA-06). */
export function triageDueAt(createdAt: Date): string {
  return addBusinessDays(createdAt, TRIAGE_BUSINESS_DAYS).toISOString();
}
