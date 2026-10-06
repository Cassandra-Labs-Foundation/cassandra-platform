// Risk breaches, acceptances and control overrides — ERM-06, ERM-07, IC-06.
//
// Three registers of the same SHAPE that must not be merged: a breach has a
// clock, an acceptance has an expiry, an override has a repetition count. See
// the migration header.
//
// EC-02 and IS-06 are NOT built here. Both need `employee.terminated` to drive
// deprovisioning, and an access register that cannot revoke is the half of the
// control that never fires.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor } from "./bsa.ts";
import {
  apiError, internalErrorResponse, isNonEmptyString, jsonResponse, notFoundResponse,
  parseJsonBody, validationError, type ValidationErrorItem,
} from "./lib.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const DAY_MS = 24 * 60 * 60 * 1000;

/** ERM-06: triage within 2 days, committee within 30, review monthly. */
const TRIAGE_DAYS = 2;
const COMMITTEE_DAYS = 30;
const REVIEW_DAYS = 30;
/**
 * ERM-07: a decision on an acceptance request within 30 calendar days of the
 * request ("`risk_acceptance.decision_due_at` (set to 30 calendar days from
 * `risk_acceptance.requested`)"). It was 10 until 2026-10-06, a number no
 * policy text supports.
 */
export const ACCEPTANCE_DECISION_DAYS = 30;
/** ERM-07: warn this far ahead of expiry, so it can be revisited in time. */
export const EXPIRY_ALERT_DAYS = 30;
/**
 * ERM-07: the SECOND, separate escalation (`risk_acceptance.expiry_warning`) —
 * to the CCO and the owner, 7 days before expiry. It is its own threshold, not
 * a duplicate of the 30-day alert: sent together, the 7-day escalation would
 * fire 30 days out and never again, which is no escalation at all.
 */
export const EXPIRY_WARNING_DAYS = 7;

/** ERM-06: severity from the size of the excursion relative to tolerance. */
export function severityFor(excursion: number, tolerance: number): string {
  if (tolerance === 0) return "critical";
  const pct = Math.abs(excursion / tolerance);
  if (pct >= 1) return "critical";
  if (pct >= 0.5) return "high";
  if (pct >= 0.2) return "moderate";
  return "low";
}

function requireInternalActor(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/risk");
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
  if (error) throw new Error(`risk event (${code}): ${error.message}`);
}

const plusDays = (f: Date, d: number) => new Date(f.getTime() + d * DAY_MS).toISOString();

// --------------------------------------------------------------- the register

/**
 * PUT /risk/register/:id {title, taxonomy_category_code, owner_id,
 *                         inherent_rating, residual_rating}
 *
 * `core.risk` is one of the 22 abandoned tables. ERM-06's breach is an
 * excursion on a REGISTERED risk with a named owner; ERM-07's acceptance is a
 * decision to carry that specific risk. Without the register both controls are
 * about excursions on nothing.
 */
export async function putRisk(
  req: Request, riskId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const errors: ValidationErrorItem[] = [];
  for (const f of ["title", "taxonomy_category_code", "owner_id"]) {
    if (!isNonEmptyString(body[f])) {
      // A risk with no OWNER is a risk nobody is accountable for, which is the
      // state a register exists to make impossible.
      errors.push({ type: "missing_field", field: f, message: "is required" });
    }
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const { error } = await db.schema(scope).from("risk").upsert({
    id: riskId, title: body.title,
    taxonomy_category_code: body.taxonomy_category_code,
    owner_id: body.owner_id,
    inherent_rating: isNonEmptyString(body.inherent_rating) ? body.inherent_rating : null,
    residual_rating: isNonEmptyString(body.residual_rating) ? body.residual_rating : null,
    remediation_evidence: isNonEmptyString(body.remediation_evidence)
      ? body.remediation_evidence
      : null,
    last_assessed_at: new Date().toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${riskId}_reg`, "risk.registered", "risk", riskId, {
    "risk.id": riskId, "risk.owner_id": body.owner_id,
    "risk.residual_rating": body.residual_rating ?? null,
    "risk.remediation_evidence": body.remediation_evidence ?? null,
    "taxonomy.category_code": body.taxonomy_category_code,
  }, ctx);
  return jsonResponse({ data: { id: riskId } }, 200, requestId);
}

// -------------------------------------------------------------- ERM appetite

/** PUT /risk/appetite/:id {taxonomy_category_code, kri_name, tolerance_value, ...} */
export async function putRiskAppetite(
  req: Request, appetiteId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const tol = typeof body.tolerance_value === "number" ? body.tolerance_value : NaN;
  const errors: ValidationErrorItem[] = [];
  for (const f of ["taxonomy_category_code", "kri_name", "owner_id", "document_ref", "approved_by"]) {
    if (!isNonEmptyString(body[f])) {
      errors.push({ type: "missing_field", field: f, message: "is required" });
    }
  }
  if (!Number.isFinite(tol)) {
    errors.push({ type: "invalid_value", field: "tolerance_value", message: "is required" });
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const { error } = await db.schema(scope).from("risk_appetite").upsert({
    id: appetiteId,
    risk_id: isNonEmptyString(body.risk_id) ? body.risk_id : null,
    taxonomy_category_code: body.taxonomy_category_code, kri_name: body.kri_name,
    tolerance_value: tol,
    direction: body.direction === "below" ? "below" : "above",
    owner_id: body.owner_id, document_ref: body.document_ref,
    approved_by: body.approved_by,
    effective_at: isNonEmptyString(body.effective_at)
      ? body.effective_at
      : new Date().toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  return jsonResponse({ data: { id: appetiteId } }, 200, requestId);
}

/**
 * POST /risk/observations {appetite_id, kri_value, impact_summary?, residual_rating?}
 *
 * ERM-06. A KRI observation. It opens a breach only if it is OUTSIDE appetite —
 * and an observation INSIDE appetite still records that the check ran, because
 * "measured and within tolerance" and "never measured" must not look alike.
 */
export async function postRiskObservation(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const value = typeof body.kri_value === "number" ? body.kri_value : NaN;
  if (!isNonEmptyString(body.appetite_id) || !Number.isFinite(value)) {
    return validationError(requestId, [{
      type: "missing_field", field: "kri_value",
      message: "appetite_id and kri_value are required",
    }]);
  }
  const { data: ap } = await db.schema(scope).from("risk_appetite")
    .select("id, taxonomy_category_code, kri_name, tolerance_value, direction, owner_id, document_ref")
    .eq("id", body.appetite_id).maybeSingle();
  if (!ap) return notFoundResponse(requestId, "risk_appetite", String(body.appetite_id));

  const tol = Number(ap.tolerance_value);
  const outside = ap.direction === "below" ? value < tol : value > tol;
  const now = new Date();

  if (!outside) {
    // Absence of a finding is itself recorded. See the class in BLUEPRINT.
    await emit(db, scope, `ev_${ap.id}_within_${now.getTime()}`, "risk.within_appetite",
      "risk_appetite", String(ap.id), {
        "kri.value": value, tolerance_value: tol,
        "taxonomy.category_code": ap.taxonomy_category_code,
        "risk_appetite.document": ap.document_ref,
      }, ctx);
    return jsonResponse({ data: { breached: false } }, 200, requestId);
  }

  const excursion = Math.abs(value - tol);
  const severity = severityFor(excursion, tol);
  const id = `rbrch_${ap.id}_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("risk_breach").upsert({
    id, appetite_id: ap.id,
    taxonomy_category_code: ap.taxonomy_category_code,
    kri_value: value, tolerance_value: tol, current_excursion: excursion,
    severity, owner_id: ap.owner_id,
    residual_rating: isNonEmptyString(body.residual_rating) ? body.residual_rating : null,
    impact_summary: isNonEmptyString(body.impact_summary) ? body.impact_summary : null,
    detected_at: now.toISOString(),
    triage_due_at: plusDays(now, TRIAGE_DAYS),
    committee_due_at: plusDays(now, COMMITTEE_DAYS),
    review_due_at: plusDays(now, REVIEW_DAYS),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "risk_breach.id": id, "kri.value": value,
    "risk_breach.current_excursion": excursion,
    "risk_breach.severity": severity,
    "risk.owner_id": ap.owner_id,
    "risk.residual_rating": body.residual_rating ?? null,
    "risk_breach.impact_summary": body.impact_summary ?? null,
    "taxonomy.category_code": ap.taxonomy_category_code,
    "risk_appetite.document": ap.document_ref,
    "user.id": ctx.tokenId,
  };
  await emit(db, scope, `ev_${id}_det`, "risk_breach.detected", "risk_breach", id, payload, ctx);
  // The clocks are emitted as facts, not left implicit in the row. A deadline
  // nothing announced cannot be monitored by anything that reads the event log.
  await emit(db, scope, `ev_${id}_triagedue`, "risk_breach.triage.due_at",
    "risk_breach", id, { triage_due_at: plusDays(now, TRIAGE_DAYS) }, ctx);
  await emit(db, scope, `ev_${id}_commdue`, "risk_breach.committee_due_at",
    "risk_breach", id, { committee_due_at: plusDays(now, COMMITTEE_DAYS) }, ctx);
  await emit(db, scope, `ev_${id}_revdue`, "risk_breach.review.due_at",
    "risk_breach", id, { review_due_at: plusDays(now, REVIEW_DAYS) }, ctx);
  await emit(db, scope, `ev_${id}_open`, "risk_breach.opened", "risk_breach", id, payload, ctx);
  // ERM-06: severity drives WHO is told. A critical excursion goes to the CRO
  // immediately rather than waiting for the committee cycle — notifying on
  // every breach would make the notification meaningless.
  if (severity === "critical" || severity === "high") {
    await emit(db, scope, `ev_${id}_cro`, "risk_breach.cro.notified", "risk_breach", id, {
      ...payload, reason: `severity=${severity}`,
    }, ctx);
  }
  return jsonResponse({ data: { id, severity, breached: true } }, 201, requestId);
}

/** POST /risk/breaches/:id/present {remediation_plan, remediation_status?} */
export async function postRiskBreachPresentation(
  req: Request, breachId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: b } = await db.schema(scope).from("risk_breach")
    .select("id, committee_due_at, review_due_at, severity, owner_id, current_excursion")
    .eq("id", breachId).maybeSingle();
  if (!b) return notFoundResponse(requestId, "risk_breach", breachId);
  if (!isNonEmptyString(body.remediation_plan)) {
    // A breach presented with no plan is a status report.
    return validationError(requestId, [{
      type: "missing_field", field: "remediation_plan",
      message: "a breach presented with no remediation plan is a status report",
    }]);
  }
  const now = new Date();
  const status = ["open", "in_progress", "complete", "accepted"]
      .includes(String(body.remediation_status))
    ? String(body.remediation_status)
    : "in_progress";
  const { error } = await db.schema(scope).from("risk_breach").update({
    triaged_at: now.toISOString(), committee_presented_at: now.toISOString(),
    reviewed_at: now.toISOString(), remediation_plan: body.remediation_plan,
    remediation_status: status, updated_at: now.toISOString(),
  }).eq("id", breachId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${breachId}_comm`, "risk_breach.committee.presented",
    "risk_breach", breachId, {
      "risk_breach.remediation_plan": body.remediation_plan,
      "risk_breach.remediation_status": status,
      "risk_breach.severity": b.severity,
      presented_late: now.toISOString() > String(b.committee_due_at),
    }, ctx);
  await emit(db, scope, `ev_${breachId}_rev`, "risk_breach.status.reviewed",
    "risk_breach", breachId, {
      "risk_breach.remediation_status": status,
      "risk_breach.current_excursion": b.current_excursion,
      reviewed_late: now.toISOString() > String(b.review_due_at),
    }, ctx);
  return jsonResponse({ data: { id: breachId, status } }, 200, requestId);
}

// ------------------------------------------------------------ ERM-07 accept

/**
 * POST /risk/acceptances
 * {risk_id, owner_id, rationale, expiry_date, breach_id?, remediation_evidence?}
 *
 * The EXPIRY is mandatory. An acceptance with no end date is a permanent
 * exception granted by inattention, which is the failure this control exists
 * to prevent.
 */
export async function postRiskAcceptance(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const errors: ValidationErrorItem[] = [];
  for (const f of ["risk_id", "owner_id", "rationale"]) {
    if (!isNonEmptyString(body[f])) {
      errors.push({ type: "missing_field", field: f, message: "is required" });
    }
  }
  if (!isNonEmptyString(body.expiry_date)) {
    errors.push({
      type: "missing_field", field: "expiry_date",
      message: "an acceptance with no expiry is a permanent exception granted by inattention",
    });
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const now = new Date();
  const expiry = new Date(String(body.expiry_date));
  const alertAt = new Date(expiry.getTime() - EXPIRY_ALERT_DAYS * DAY_MS);
  if (alertAt.getTime() <= now.getTime()) {
    // An acceptance whose warning window has already passed cannot be revisited
    // in time. Refusing is better than granting one that expires unnoticed.
    return apiError(409, "risk_acceptance_expiry_too_soon", requestId, {
      title: "expiry too soon",
      detail: `the expiry must be more than ${EXPIRY_ALERT_DAYS} days away so it can be revisited`,
    });
  }

  const id = `racc_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("risk_acceptance").upsert({
    id, risk_id: body.risk_id,
    breach_id: isNonEmptyString(body.breach_id) ? body.breach_id : null,
    owner_id: body.owner_id, rationale: body.rationale,
    // the requesting CREDENTIAL, so four-eyes compares who acted, not names
    requested_by: ctx.tokenId,
    remediation_evidence: isNonEmptyString(body.remediation_evidence)
      ? body.remediation_evidence
      : null,
    requested_at: now.toISOString(),
    decision_due_at: plusDays(now, ACCEPTANCE_DECISION_DAYS),
    expiry_date: expiry.toISOString(),
    expiry_alert_at: alertAt.toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_decdue`, "risk_acceptance.decision.due_at",
    "risk_acceptance", id, {
      decision_due_at: plusDays(now, ACCEPTANCE_DECISION_DAYS),
    }, ctx);
  await emit(db, scope, `ev_${id}_alertat`, "risk_acceptance.expiry_alert_at",
    "risk_acceptance", id, { expiry_alert_at: alertAt.toISOString() }, ctx);
  await emit(db, scope, `ev_${id}_req`, "risk_acceptance.requested",
    "risk_acceptance", id, {
      "risk_acceptance.id": id, "risk.id": body.risk_id,
      "risk_acceptance.owner_id": body.owner_id,
      "risk_acceptance.rationale": body.rationale,
      "risk_acceptance.expiry_date": expiry.toISOString(),
      "risk.remediation_evidence": body.remediation_evidence ?? null,
      "user.id": ctx.tokenId,
    }, ctx);
  return jsonResponse({ data: { id, expiry_alert_at: alertAt.toISOString() } }, 201, requestId);
}

/**
 * POST /risk/acceptances/:id/decide {decision, decided_by?}
 *
 * ERM-07: acceptance decisions are the CCO's, for every risk level (user
 * decision 2026-10-06: no separate CRO tier). The gate is the credential's
 * `cco` role — any staff token could grant an acceptance before. The decider
 * recorded is the CREDENTIAL (`ctx.tokenId`); the typed `decided_by` is kept
 * only as a display label, because a typed name proves nothing about who acted.
 * Four-eyes compares credentials: the credential that requested an acceptance
 * cannot decide it.
 */
export async function postRiskAcceptanceDecision(
  req: Request, accId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  if (!ctx.roles.includes("cco")) {
    return apiError(403, "insufficient_role", requestId, {
      title: "Insufficient Role",
      detail: `cco is required to decide a risk acceptance (ERM-07); this token carries ${
        ctx.roles.length ? ctx.roles.join(", ") : "no such role"
      }`,
    });
  }
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: a } = await db.schema(scope).from("risk_acceptance")
    .select("id, owner_id, requested_by, decision_due_at, risk_id, expiry_date")
    .eq("id", accId).maybeSingle();
  if (!a) return notFoundResponse(requestId, "risk_acceptance", accId);

  const label = isNonEmptyString(body.decided_by) ? body.decided_by : null;
  if (body.decision !== "accepted" && body.decision !== "declined") {
    return validationError(requestId, [{
      type: "invalid_value", field: "decision",
      message: "decision must be accepted or declined",
    }]);
  }
  if (label === a.owner_id || (a.requested_by && a.requested_by === ctx.tokenId)) {
    // The owner asking to carry a risk — or the credential that asked for
    // it — cannot be the one who grants it.
    return apiError(409, "risk_acceptance_self_granted", requestId, {
      title: "self-granted acceptance",
      detail: "the requester of a risk acceptance cannot decide it",
    });
  }

  const now = new Date();
  const { error } = await db.schema(scope).from("risk_acceptance").update({
    decision: body.decision, decided_at: now.toISOString(), decided_by: ctx.tokenId,
    decided_by_label: label, updated_at: now.toISOString(),
  }).eq("id", accId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${accId}_dec`, "risk_acceptance.decided",
    "risk_acceptance", accId, {
      "risk_acceptance.id": accId, decision: body.decision,
      decided_by: ctx.tokenId, decided_by_label: label, "user.id": ctx.tokenId,
      "user.role": "cco",
      "risk_acceptance.expiry_date": a.expiry_date,
      decided_late: now.toISOString() > String(a.decision_due_at),
    }, ctx);
  return jsonResponse({ data: { id: accId, decision: body.decision } }, 200, requestId);
}

/**
 * POST /risk/acceptances/sweep
 *
 * ERM-07's clock. An acceptance that expires unnoticed silently becomes
 * permanent, so the sweep both WARNS ahead of expiry and expires it — and an
 * expired acceptance re-opens the breach it was covering, because the risk did
 * not go away when the paperwork did.
 *
 * Every examined row is touched whether or not it fires: the heartbeat
 * starvation finding.
 */
export async function postRiskAcceptanceSweep(
  _req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;

  const now = new Date();
  const iso = now.toISOString();
  const { data, error } = await db.schema(scope).from("risk_acceptance")
    .select("id, risk_id, breach_id, owner_id, decision, expiry_date, expiry_alert_at, expiry_alerted_at, expiry_warned_at, expired_at")
    .is("expired_at", null)
    .order("expiry_date", { ascending: true })
    .limit(200);
  if (error) return internalErrorResponse(requestId, error.message);

  let alerted = 0, warned = 0, expired = 0;
  for (const a of data ?? []) {
    const id = String(a.id);
    const patch: Record<string, unknown> = { updated_at: iso };
    const expiryMs = new Date(String(a.expiry_date)).getTime();
    const daysRemaining = Math.ceil((expiryMs - now.getTime()) / DAY_MS);

    if (String(a.expiry_date) <= iso) {
      // ERM-07: the lapse creates a breach RECORD for the associated risk, not
      // only an event — an event leaves nothing to triage, present or review.
      // If the record cannot be written the acceptance is NOT marked expired,
      // so the next sweep retries instead of losing the lapse.
      let breachId: string;
      try {
        breachId = await openLapseBreach(db, scope, a, now, ctx);
      } catch (e) {
        console.error(`risk acceptance ${id}: lapse breach not recorded: ${e}`);
        await db.schema(scope).from("risk_acceptance").update(patch).eq("id", id);
        continue;
      }
      patch.expired_at = iso;
      expired++;
      await emit(db, scope, `ev_${id}_expired`, "risk_acceptance.expired",
        "risk_acceptance", id, {
          "risk_acceptance.id": id, "risk.id": a.risk_id,
          "risk_acceptance.expiry_date": a.expiry_date,
          "risk_breach.id": breachId,
        }, ctx);
      // the risk is back outside appetite with nothing covering it
      await emit(db, scope, `ev_${id}_reopen`, "risk_breach.opened", "risk_acceptance", id, {
        "risk_breach.id": breachId, reason: "risk_acceptance_expired",
        "risk_acceptance.id": id, "risk.id": a.risk_id,
        "risk_breach.prior_id": a.breach_id ?? null,
        "risk.owner_id": a.owner_id,
      }, ctx);
    } else {
      // Two thresholds, each judged on its own and each fired once. A sweep
      // that missed the 30-day window and runs inside 7 days sends both,
      // because both are owed; otherwise they arrive ~23 days apart.
      if (String(a.expiry_alert_at) <= iso && !a.expiry_alerted_at) {
        patch.expiry_alerted_at = iso;
        alerted++;
        await emit(db, scope, `ev_${id}_alert`, "risk_acceptance.expiry_alerted",
          "risk_acceptance", id, {
            "risk_acceptance.id": id,
            "risk_acceptance.expiry_date": a.expiry_date,
            "risk_acceptance.owner_id": a.owner_id,
            threshold_days: EXPIRY_ALERT_DAYS,
            days_remaining: daysRemaining,
          }, ctx);
      }
      if (expiryMs - now.getTime() <= EXPIRY_WARNING_DAYS * DAY_MS && !a.expiry_warned_at) {
        patch.expiry_warned_at = iso;
        warned++;
        await emit(db, scope, `ev_${id}_warn`, "risk_acceptance.expiry.warning",
          "risk_acceptance", id, {
            "risk_acceptance.id": id,
            "risk_acceptance.expiry_date": a.expiry_date,
            "risk_acceptance.owner_id": a.owner_id,
            days_remaining: daysRemaining,
          }, ctx);
        // the escalation the warning produces: to the CCO as well as the owner
        await emit(db, scope, `ev_${id}_warn_alert`, "risk_acceptance.expiry_alerted",
          "risk_acceptance", id, {
            "risk_acceptance.id": id,
            "risk_acceptance.expiry_date": a.expiry_date,
            "risk_acceptance.owner_id": a.owner_id,
            threshold_days: EXPIRY_WARNING_DAYS,
            days_remaining: daysRemaining,
            escalated_to: ["cco", "owner"],
          }, ctx);
      }
    }
    // touched either way, so a bounded sweep cannot starve its tail
    await db.schema(scope).from("risk_acceptance").update(patch).eq("id", id);
  }
  return jsonResponse({
    data: { examined: (data ?? []).length, alerted, warned, expired },
  }, 200, requestId);
}

const SEVERITIES = ["low", "moderate", "high", "critical"];

/** The register's free-text rating, mapped onto the breach severity scale. */
function severityFromRating(rating: unknown): string | null {
  const r = String(rating ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (r === "very high") return "critical";
  if (r === "medium") return "moderate";
  if (r === "minor") return "low";
  if (r === "major") return "high";
  return SEVERITIES.includes(r) ? r : null;
}

/**
 * ERM-07 lapse → breach. One `risk_breach` row per lapsed acceptance, keyed on
 * the acceptance (deterministic id + a partial unique index on
 * `risk_acceptance_id`), so a re-run sweep can never open a second one.
 *
 * The excursion is taken from the breach the acceptance was covering, when it
 * names one — that is the last measured position of the risk. An acceptance
 * that covered no recorded breach has no measurement to copy, and the row
 * says so with NULL kri/tolerance/excursion (allowed only on a lapse row; see
 * the migration) rather than inventing a KRI reading.
 */
async function openLapseBreach(
  db: SupabaseClient, scope: EvidenceScope, a: Any, now: Date, ctx: PartnerContext,
): Promise<string> {
  const accId = String(a.id);
  const id = `rbrch_lapse_${accId}`;

  const prior: Any = a.breach_id
    ? (await db.schema(scope).from("risk_breach")
      .select("id, appetite_id, taxonomy_category_code, kri_value, tolerance_value, current_excursion, severity, residual_rating, impact_summary")
      .eq("id", String(a.breach_id)).maybeSingle()).data
    : null;
  const risk: Any = (await db.schema(scope).from("risk")
    .select("id, taxonomy_category_code, residual_rating")
    .eq("id", String(a.risk_id)).maybeSingle()).data;
  const appetite: Any = prior?.appetite_id
    ? null
    : (await db.schema(scope).from("risk_appetite")
      .select("id, taxonomy_category_code")
      .eq("risk_id", String(a.risk_id)).limit(1).maybeSingle()).data;

  const severity = (prior?.severity as string | undefined) ??
    severityFromRating(risk?.residual_rating) ??
    // an unrated lapse is escalated rather than under-called
    "high";
  const row = {
    id,
    appetite_id: prior?.appetite_id ?? appetite?.id ?? null,
    risk_id: a.risk_id,
    risk_acceptance_id: accId,
    taxonomy_category_code: prior?.taxonomy_category_code ??
      risk?.taxonomy_category_code ?? appetite?.taxonomy_category_code ?? "unclassified",
    kri_value: prior?.kri_value ?? null,
    tolerance_value: prior?.tolerance_value ?? null,
    current_excursion: prior?.current_excursion ?? null,
    severity,
    owner_id: a.owner_id,
    residual_rating: prior?.residual_rating ?? risk?.residual_rating ?? null,
    impact_summary: `risk acceptance ${accId} expired without renewal` +
      (prior?.impact_summary ? `; ${prior.impact_summary}` : ""),
    detected_at: now.toISOString(),
    triage_due_at: plusDays(now, TRIAGE_DAYS),
    committee_due_at: plusDays(now, COMMITTEE_DAYS),
    review_due_at: plusDays(now, REVIEW_DAYS),
    provenance: provenanceFor(scope, ctx),
  };
  const { error } = await db.schema(scope).from("risk_breach")
    .upsert(row, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(error.message);

  await emit(db, scope, `ev_${id}_triagedue`, "risk_breach.triage.due_at",
    "risk_breach", id, { triage_due_at: row.triage_due_at }, ctx);
  await emit(db, scope, `ev_${id}_commdue`, "risk_breach.committee_due_at",
    "risk_breach", id, { committee_due_at: row.committee_due_at }, ctx);
  await emit(db, scope, `ev_${id}_revdue`, "risk_breach.review.due_at",
    "risk_breach", id, { review_due_at: row.review_due_at }, ctx);
  return id;
}

// ------------------------------------------------------------ IC-06 overrides

/** POST /controls/overrides {control_id, subject_kind, subject_ref, actor_ref, rationale} */
export async function postControlOverride(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const errors: ValidationErrorItem[] = [];
  for (const f of ["control_id", "subject_ref", "actor_ref"]) {
    if (!isNonEmptyString(body[f])) {
      errors.push({ type: "missing_field", field: f, message: "is required" });
    }
  }
  if (!isNonEmptyString(body.rationale)) {
    // An override with no rationale is indistinguishable from a control that
    // does not work.
    errors.push({
      type: "missing_field", field: "rationale",
      message: "an override with no rationale cannot be reviewed",
    });
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const now = new Date();
  // IC-06 declares `user.id` and `user.role`: an override is attributable to a
  // SYSTEM PRINCIPAL. Registering the actor here rather than only naming them
  // in the payload is what makes "who overrides most" answerable — and it is a
  // role register, not an employment record (see the classification rule).
  await db.schema(scope).from("user").upsert({
    id: String(body.actor_ref),
    role: isNonEmptyString(body.actor_role) ? body.actor_role : "operator",
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  const id = `covr_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("control_override").upsert({
    id, control_id: body.control_id,
    subject_kind: isNonEmptyString(body.subject_kind) ? body.subject_kind : "transaction",
    subject_ref: body.subject_ref, actor_ref: body.actor_ref,
    rationale: body.rationale, invoked_at: now.toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_inv`, "control.override.invoked",
    "control_override", id, {
      "control.id": body.control_id, "override.rationale": body.rationale,
      "user.id": body.actor_ref, subject_ref: body.subject_ref,
    }, ctx);
  await emit(db, scope, `ev_${id}_rec`, "override.recorded", "control_override", id, {
    "control.id": body.control_id, "override.rationale": body.rationale,
    "user.id": body.actor_ref,
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/**
 * POST /controls/exceptions
 * {control_id, scope, rationale, approver_id, registered_by, expires_at,
 *  risk_acceptance_id}
 *
 * IC-06: a standing exception is registered with an expiry AND the risk
 * acceptance that carries it (`exception.risk_acceptance`). Without one, the
 * control is switched off with nobody having accepted the risk of it being off.
 */
export async function postControlException(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const errors: ValidationErrorItem[] = [];
  for (const f of ["control_id", "scope", "rationale", "approver_id", "registered_by"]) {
    if (!isNonEmptyString(body[f])) {
      errors.push({ type: "missing_field", field: f, message: "is required" });
    }
  }
  if (!isNonEmptyString(body.expires_at)) {
    errors.push({
      type: "missing_field", field: "expires_at",
      message: "a registered exception must be time-boxed",
    });
  }
  if (!isNonEmptyString(body.risk_acceptance_id)) {
    errors.push({
      type: "missing_field", field: "risk_acceptance_id",
      message: "a standing exception must reference the risk acceptance that carries it",
    });
  }
  if (errors.length > 0) return validationError(requestId, errors);
  if (body.approver_id === body.registered_by) {
    return apiError(409, "control_exception_self_approved", requestId, {
      title: "self-approved exception",
      detail: "the person registering an exception cannot approve it",
    });
  }
  const { data: acceptance, error: accErr } = await db.schema(scope).from("risk_acceptance")
    .select("id").eq("id", String(body.risk_acceptance_id)).maybeSingle();
  if (accErr) return internalErrorResponse(requestId, accErr.message);
  if (!acceptance) {
    return notFoundResponse(requestId, "risk_acceptance", String(body.risk_acceptance_id));
  }

  const now = new Date();
  const id = `cexc_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("control_exception").upsert({
    id, control_id: body.control_id, scope: body.scope, rationale: body.rationale,
    risk_acceptance_id: body.risk_acceptance_id,
    approver_id: body.approver_id, registered_by: body.registered_by,
    registered_at: now.toISOString(), expires_at: body.expires_at,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_reg`, "exception.registered", "control_exception", id, {
    "control.id": body.control_id, "exception.scope": body.scope,
    "exception.rationale": body.rationale,
    "exception.approver_id": body.approver_id,
    "exception.expires_at": body.expires_at,
    "exception.risk_acceptance": body.risk_acceptance_id,
    "user.id": body.registered_by,
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/**
 * POST /controls/exceptions/sweep
 *
 * IC-06. An exception that expires must REVERT — the control comes back on.
 * An expiry that only alerts leaves the control off indefinitely, which is the
 * same failure as an acceptance nobody revisits.
 */
export async function postControlExceptionSweep(
  _req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;

  const now = new Date();
  const iso = now.toISOString();
  const { data, error } = await db.schema(scope).from("control_exception")
    .select("id, control_id, scope, expires_at, reverted_at")
    .is("reverted_at", null)
    .order("expires_at", { ascending: true })
    .limit(200);
  if (error) return internalErrorResponse(requestId, error.message);

  let reverted = 0, expiring = 0;
  for (const e of data ?? []) {
    const id = String(e.id);
    const patch: Record<string, unknown> = {};
    if (String(e.expires_at) <= iso) {
      patch.reverted_at = iso;
      reverted++;
      await emit(db, scope, `ev_${id}_rev`, "exception.reverted", "control_exception", id, {
        "control.id": e.control_id, "exception.scope": e.scope,
        "exception.expires_at": e.expires_at,
      }, ctx);
    } else if (
      new Date(String(e.expires_at)).getTime() - now.getTime() <= EXPIRY_ALERT_DAYS * DAY_MS
    ) {
      expiring++;
      await emit(db, scope, `ev_${id}_expiring`, "exception.expiring",
        "control_exception", id, {
          "control.id": e.control_id, "exception.expires_at": e.expires_at,
        }, ctx);
    }
    if (Object.keys(patch).length > 0) {
      await db.schema(scope).from("control_exception").update(patch).eq("id", id);
    }
  }
  return jsonResponse({ data: { examined: (data ?? []).length, reverted, expiring } }, 200, requestId);
}

/**
 * POST /controls/overrides/analytics {period}
 *
 * IC-06. The control is REPETITION — a single override with a good rationale is
 * fine; the same control overridden forty times is a control that does not fit
 * the business. A register with no analytics over it cannot see that.
 */
export async function postOverrideAnalytics(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: overrides } = await db.schema(scope).from("control_override")
    .select("id, control_id, actor_ref, invoked_at");
  const { data: exceptions } = await db.schema(scope).from("control_exception")
    .select("id, control_id, reverted_at, expires_at");

  const byControl: Record<string, number> = {};
  const byActor: Record<string, number> = {};
  for (const o of overrides ?? []) {
    byControl[String(o.control_id)] = (byControl[String(o.control_id)] ?? 0) + 1;
    byActor[String(o.actor_ref)] = (byActor[String(o.actor_ref)] ?? 0) + 1;
  }
  const repeated = Object.entries(byControl).filter(([, n]) => n >= 3)
    .map(([c, n]) => ({ control_id: c, count: n }));

  const id = `covran_${body.period ?? "p"}`;
  await emit(db, scope, `ev_${id}`, "override.analytics.published",
    "control_override", id, {
      period: body.period ?? null,
      total_overrides: (overrides ?? []).length,
      by_control: byControl, by_actor: byActor,
      // the finding is REPETITION, so it is named rather than left for a reader
      // to spot in a frequency table
      repeatedly_overridden: repeated,
      open_exceptions: (exceptions ?? []).filter((e: Any) => !e.reverted_at).length,
    }, ctx);
  return jsonResponse({
    data: { total: (overrides ?? []).length, repeatedly_overridden: repeated },
  }, 201, requestId);
}
