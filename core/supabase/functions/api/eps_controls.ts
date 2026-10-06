// EPS authentication and fraud controls (EPS-05, EPS-07).
//
// EPS-05 and EPS-07 are one shape, not two: a decision taken against a member
// or a transaction, which may raise an exception someone must resolve before a
// cutoff. Building them as separate auth and fraud stacks would have expressed
// the same lifecycle twice.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor } from "./bsa.ts";
import {
  apiError, internalErrorResponse, jsonResponse, notFoundResponse, parseJsonBody,
  validationError,
} from "./lib.ts";

/** EPS-05: consecutive failures before the account locks. */
export const AUTH_LOCKOUT_THRESHOLD = 3;
const SWEEP_LIMIT = 200;

async function emit(
  db: SupabaseClient, scope: EvidenceScope, id: string, code: string,
  rType: string, rId: string, payload: Record<string, unknown>, ctx?: PartnerContext,
): Promise<void> {
  const { error } = await db.schema(scope).from("event").upsert({
    id, code, resource_type: rType, resource_id: `${rType}:${rId}`,
    payload, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`eps event (${code}): ${error.message}`);
}

/**
 * POST /eps/auth {subject_ref, channel, outcome, challenge_method?}
 *
 * The lockout is applied HERE, in the same write that records the failure that
 * crossed the threshold. A design where the count is recorded and a sweep locks
 * out later leaves a window in which the threshold is breached and the account
 * is still open, which is the window an attacker uses.
 */
export async function postAuthEvent(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const subject = typeof body.subject_ref === "string" ? body.subject_ref : "";
  const channel = typeof body.channel === "string" ? body.channel : "";
  const outcome = typeof body.outcome === "string" ? body.outcome : "";
  if (!subject || !channel || !["success", "failure"].includes(outcome)) {
    return validationError(requestId, [{
      field: "outcome", type: "invalid",
      message: "subject_ref, channel and outcome (success|failure) are required",
    }]);
  }

  const { data: priorRows } = await db.schema(scope).from("eps_auth_event")
    .select("id, subject_ref, decision, failure_count, chain_seq")
    // Ordered by chain_seq — a per-subject monotonic attempt sequence — NOT
    // created_at (the drill's frozen clock makes timestamp order arbitrary;
    // that bug produced EPS-05 5/6 with the lockout silently missing) and NOT
    // failure_count (max-ever is CUMULATIVE: a success never won the read, so
    // fail,fail,success,fail locked out, and one lockout locked every failure
    // after it forever — the §5 follow-up defect, fixed 2026-08-11).
    .eq("subject_ref", subject).order("chain_seq", { ascending: false }).limit(1);
  const prior = ((priorRows ?? []) as unknown as Array<Record<string, unknown>>)[0];
  const priorCount = typeof prior?.failure_count === "number" ? prior.failure_count : 0;
  const priorSeq = typeof prior?.chain_seq === "number" ? prior.chain_seq : 0;

  const failureCount = outcome === "failure" ? priorCount + 1 : 0;
  const chainSeq = priorSeq + 1;
  const challengeMethod = typeof body.challenge_method === "string" ? body.challenge_method : null;

  let decision: string;
  if (outcome === "success") decision = "allowed";
  else if (failureCount >= AUTH_LOCKOUT_THRESHOLD) decision = "locked_out";
  else if (challengeMethod) decision = "challenged";
  else decision = "denied";

  // A challenge with no stated method is not an authentication control, and the
  // schema refuses it. Refusing here gives the caller the reason.
  if (decision === "challenged" && !challengeMethod) {
    return apiError(409, "challenge_method_required", requestId, {
      detail: "a challenge decision must record how the member was challenged",
    });
  }

  const now = new Date().toISOString();
  // Every attempt is its own record, keyed by its place in the subject's
  // chain. Until 2026-10-06 the id was epsauth_<subject>_<failure_count>_<outcome>,
  // so a later attempt with the same count (fail,fail,success,FAIL) upserted
  // over the first and its events were dropped as duplicates — the audit trail
  // lost attempts. INSERT, not upsert: two concurrent attempts that read the
  // same prior chain_seq collide loudly instead of one erasing the other.
  const id = `epsauth_${subject}_${chainSeq}`;
  const { data, error } = await db.schema(scope).from("eps_auth_event").insert({
    id, subject_ref: subject, channel, decision, failure_count: failureCount,
    chain_seq: chainSeq, challenge_method: challengeMethod,
    locked_out_at: decision === "locked_out" ? now : null,
    provenance: provenanceFor(scope, ctx),
  }).select("id, subject_ref, decision, failure_count").maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return apiError(409, "concurrent_auth_attempt", requestId, {
        detail: "another attempt for this subject was recorded concurrently; retry",
      });
    }
    return internalErrorResponse(requestId, error.message);
  }

  await emit(db, scope, `ev_${id}_dec`, "eps.auth.decided", "eps_auth", id, { decision }, ctx);
  await emit(db, scope, `ev_${id}_cnt`, "eps.auth.failure_count", "eps_auth", id, {
    failure_count: failureCount,
  }, ctx);
  if (decision === "challenged") {
    await emit(db, scope, `ev_${id}_ch`, "eps.auth.challenged", "eps_auth", id, {
      challenge_method: challengeMethod,
    }, ctx);
  }
  if (decision === "locked_out") {
    await emit(db, scope, `ev_${id}_lo`, "eps.auth_lockout.applied", "eps_auth", id, {
      failure_count: failureCount,
    }, ctx);
  }
  return jsonResponse({ data }, 201, requestId);
}

/** POST /eps/card-controls {card_ref, control_type, new_value, applied_by} */
export async function postCardControl(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const cardRef = typeof body.card_ref === "string" ? body.card_ref : "";
  const controlType = typeof body.control_type === "string" ? body.control_type : "";
  const newValue = typeof body.new_value === "string" ? body.new_value : "";
  const appliedBy = typeof body.applied_by === "string" ? body.applied_by : "";
  if (!cardRef || !controlType || !newValue || !appliedBy) {
    return validationError(requestId, [{
      field: "card_ref", type: "required",
      message: "card_ref, control_type, new_value and applied_by are required",
    }]);
  }

  // The prior state is the latest application by control_seq — a per
  // (card, control) monotonic sequence, the same shape as eps_auth_event's
  // chain_seq. Until 2026-10-06 rows were keyed epscc_<card>_<type>_<value>
  // and the prior read ordered by created_at, which an upsert never advances:
  // on,off,on,OFF read the old 'off' row as the latest and reported no change.
  const { data: priorRows, error: priorErr } = await db.schema(scope).from("eps_card_control")
    .select("id, card_ref, control_type, new_value, control_seq")
    .eq("card_ref", cardRef).eq("control_type", controlType)
    .order("control_seq", { ascending: false }).limit(1);
  if (priorErr) return internalErrorResponse(requestId, priorErr.message);
  const prior = ((priorRows ?? []) as unknown as Array<Record<string, unknown>>)[0];
  const previousValue = typeof prior?.new_value === "string" ? prior.new_value : null;
  const priorSeq = typeof prior?.control_seq === "number" ? prior.control_seq : 0;
  const controlSeq = priorSeq + 1;

  // Each application is its own row and its own events. INSERT, not upsert:
  // a concurrent toggle that read the same prior collides instead of erasing.
  const id = `epscc_${cardRef}_${controlType}_${controlSeq}`;
  const { data, error } = await db.schema(scope).from("eps_card_control").insert({
    id, card_ref: cardRef, control_type: controlType, applied_by: appliedBy,
    previous_value: previousValue, new_value: newValue, control_seq: controlSeq,
    provenance: provenanceFor(scope, ctx),
  }).select("id, card_ref, control_type, previous_value, new_value").maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return apiError(409, "concurrent_card_control", requestId, {
        detail: "another change to this control was recorded concurrently; retry",
      });
    }
    return internalErrorResponse(requestId, error.message);
  }

  await emit(db, scope, `ev_${id}_app`, "eps.card_control.applied", "eps_card_control", id, {
    control_type: controlType, new_value: newValue,
  }, ctx);
  // A CHANGE is only a change if there was a previous value. Emitting
  // `changed` on first application would report a modification that never
  // happened.
  if (previousValue !== null && previousValue !== newValue) {
    await emit(db, scope, `ev_${id}_chg`, "eps.card_control.changed", "eps_card_control", id, {
      previous_value: previousValue, new_value: newValue,
    }, ctx);
  }
  return jsonResponse({ data }, 201, requestId);
}

/** POST /eps/pospay {account_ref, item_ref, amount_cents, reason, cutoff_at} */
export async function postPospayException(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const account = typeof body.account_ref === "string" ? body.account_ref : "";
  const item = typeof body.item_ref === "string" ? body.item_ref : "";
  const amount = typeof body.amount_cents === "number" ? body.amount_cents : NaN;
  const reason = typeof body.reason === "string" ? body.reason : "";
  const cutoff = typeof body.cutoff_at === "string" ? body.cutoff_at : "";
  if (!account || !item || !Number.isFinite(amount) || !reason || !cutoff) {
    return validationError(requestId, [{
      field: "item_ref", type: "required",
      message: "account_ref, item_ref, amount_cents, reason and cutoff_at are required",
    }]);
  }

  const id = `epspp_${item}`;
  const { data, error } = await db.schema(scope).from("eps_pospay_exception").upsert({
    id, account_ref: account, item_ref: item, amount_cents: amount, reason,
    decision_cutoff_at: cutoff, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" }).select("id, item_ref, amount_cents, decision, decision_cutoff_at")
    .maybeSingle();
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_pres`, "eps.pospay_exception.presented", "eps_pospay", id, {
    amount_cents: amount, reason, decision_cutoff_at: cutoff,
  }, ctx);
  return jsonResponse({ data }, 201, requestId);
}

/** POST /eps/pospay/:id/decide {decision, decided_by} */
export async function postPospayDecision(
  req: Request, exceptionId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const decision = typeof body.decision === "string" ? body.decision : "";
  const decidedBy = typeof body.decided_by === "string" ? body.decided_by : "";
  if (!["pay", "return"].includes(decision) || !decidedBy) {
    return validationError(requestId, [{
      field: "decision", type: "invalid",
      message: "decision (pay|return) and decided_by are required",
    }]);
  }

  // §5 follow-up defect: this update ran unconditionally — deciding a
  // nonexistent exception returned 200 and emitted a `decided` event for
  // nothing, and a second decision silently overwrote the first (pay ->
  // return with no trace). An exception is decided at most once, by someone,
  // about something that exists.
  const { data: existing } = await db.schema(scope).from("eps_pospay_exception")
    .select("id, decision, decision_cutoff_at").eq("id", exceptionId).maybeSingle();
  if (!existing) return notFoundResponse(requestId, "eps_pospay_exception", exceptionId);
  if (existing.decision) {
    return apiError(409, "already_decided", requestId, {
      title: "Already Decided",
      detail: `this exception was already decided '${existing.decision}' — a decision is not overwritable`,
    });
  }
  const decidedAt = new Date().toISOString();
  // Past-cutoff decisions are allowed but marked: the item already paid by
  // default at the cutoff, so a late `return` is a recovery action, not a
  // timely decision — the evidence must not let the two look alike.
  const pastCutoff = String(existing.decision_cutoff_at ?? "") < decidedAt &&
    existing.decision_cutoff_at != null;

  const { data, error } = await db.schema(scope).from("eps_pospay_exception")
    .update({ decision, decided_by: decidedBy, decided_at: decidedAt })
    .eq("id", exceptionId).select("id, decision, decided_by").maybeSingle();
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${exceptionId}_dec`, "eps.pospay_exception.decided", "eps_pospay",
    exceptionId, { decision, decided_by: decidedBy, past_cutoff: pastCutoff }, ctx);
  return jsonResponse({ data: { ...(data ?? {}), past_cutoff: pastCutoff } }, 200, requestId);
}

/**
 * POST /eps/fraud-review — the periodic trend review, plus the undecided
 * positive-pay sweep.
 *
 * An undecided exception past its cutoff PAYS BY DEFAULT. That is the whole
 * risk, so it is reported as its own count rather than folded into a total —
 * same reasoning as `undetermined` incidents and `unassessed` capital triggers.
 */
export async function postFraudTrendReview(
  _req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const nowIso = new Date().toISOString();
  const { data: rows, error } = await db.schema(scope).from("eps_pospay_exception")
    .select("id, decision, decision_cutoff_at, amount_cents")
    .order("decision_cutoff_at", { ascending: true }).limit(SWEEP_LIMIT);
  if (error) return internalErrorResponse(requestId, error.message);

  const excs = (rows ?? []) as unknown as Array<Record<string, unknown>>;
  const paidByDefault: string[] = [];
  for (const e of excs) {
    if (!e.decision && String(e.decision_cutoff_at) < nowIso) paidByDefault.push(e.id as string);
  }

  await emit(db, scope, `ev_fraudrev_${nowIso.slice(0, 10)}`, "eps.fraud_trend_review.completed",
    "eps_pospay", "review", { examined: excs.length }, ctx);

  return jsonResponse({
    data: {
      examined: excs.length,
      undecided_past_cutoff: paidByDefault.length,
      undecided_past_cutoff_ids: paidByDefault,
      note: paidByDefault.length > 0
        ? "these exceptions passed their cutoff undecided and pay by default"
        : undefined,
    },
  }, 200, requestId);
}
