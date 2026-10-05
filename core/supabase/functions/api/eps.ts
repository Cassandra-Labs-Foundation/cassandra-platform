// Dual control for high-risk payment processes (EPS-06).
//
// EPS-06 is the first control that corrected the API rather than fitting into
// it. The two-phase wire prepare/confirm split looked like dual control and was
// not: it required two CALLS, not two PEOPLE. Anyone holding a token could
// prepare and then immediately confirm. EPS-06 says wire dual control is
// REQUIRED, so confirm now demands an approver distinct from the preparer, and
// the database refuses a completed wire whose approval is outstanding.
//
// THE POLICY VALUE THAT IS MISSING
//
// EPS-06 on ACH: "dual control is recommended for clients originating over
// $50,000 per batch; client exposure limits are assigned by the Credit Union".
// Both the threshold and whether it applies at all are per-client configuration
// this repo does not hold, and inventing $50,000 as a default would be
// fabricating a policy nobody set.
//
// So an ACH batch from a client with no configured limit is UNASSESSED, not
// exempt. The distinction matters in both directions:
//
//   treat unconfigured as exempt   -> fails OPEN. A $2m batch originates with
//                                     no second pair of eyes and nothing says so
//   treat unconfigured as required -> fails CLOSED on a number nobody chose,
//                                     and blocks every client until configured
//   unassessed (this file)         -> the batch proceeds, because EPS-06 says
//                                     "recommended" for ACH, and its status
//                                     says plainly that no determination was
//                                     made
//
// Wires do not have this problem: EPS-06 states the requirement unconditionally,
// so no policy value is needed and dual control is enforced outright.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor } from "./bsa.ts";
import {
  apiError,
  internalErrorResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  validationError,
  type ValidationErrorItem,
} from "./lib.ts";

export type DualControlStatus =
  | "not_required"
  | "required"
  | "approved"
  | "rejected"
  | "unassessed";

/**
 * The same vocabulary as a runtime value, for read endpoints that validate a
 * `dual_control_status` filter.
 *
 * Built from a Record keyed by the union rather than written out as an array:
 * Record<DualControlStatus, true> is only satisfied when EVERY member is
 * present, so adding a status above and forgetting it here is a compile error
 * rather than a filter that silently rejects a legitimate value. An array
 * literal would type-check while missing entries, which is the bug this shape
 * exists to make impossible.
 *
 * Exported as readonly string[] because callers test unvalidated query
 * parameters against it; a DualControlStatus[] would narrow .includes() to
 * reject the very `string` it is meant to validate.
 */
const DUAL_CONTROL_STATUS_SET: Record<DualControlStatus, true> = {
  not_required: true,
  required: true,
  approved: true,
  rejected: true,
  unassessed: true,
};

export const DUAL_CONTROL_STATUSES: readonly string[] = Object.keys(DUAL_CONTROL_STATUS_SET);

/** What dual control a payment needs, and why. */
export interface DualControlDecision {
  status: DualControlStatus;
  basis: string;
  thresholdCents: number | null;
}

/**
 * Wires: unconditional. EPS-06 says "dual control or offline callback approval
 * with PIN is required" with no threshold, so there is no policy value to look
 * up and nothing to be unassessed about.
 */
export function wireDualControl(): DualControlDecision {
  return {
    status: "required",
    basis: "EPS-06: wire dual control is required unconditionally",
    thresholdCents: null,
  };
}

/**
 * ACH: threshold-based and per-client.
 *
 * `limitCents === null` means no limit row, or a row with the column unset —
 * nobody has configured this client. That is UNASSESSED, and deliberately not
 * collapsed into either "exempt" or "required".
 */
export function achDualControl(
  amountCents: number,
  limitCents: number | null | undefined,
): DualControlDecision {
  if (limitCents === null || limitCents === undefined) {
    return {
      status: "unassessed",
      basis:
        "EPS-06: no ACH dual-control limit configured for this client, so no " +
        "determination could be made (see OQ-14)",
      thresholdCents: null,
    };
  }
  if (amountCents > limitCents) {
    return {
      status: "required",
      basis: `EPS-06: batch exceeds the configured client dual-control limit`,
      thresholdCents: limitCents,
    };
  }
  return {
    status: "not_required",
    basis: `EPS-06: batch is below the configured client dual-control limit`,
    thresholdCents: limitCents,
  };
}

/** Reads the configured limit for a partner. Absent row -> null, not zero. */
export async function clientLimitFor(
  db: SupabaseClient,
  partnerId: string,
  scope: EvidenceScope = "core",
): Promise<number | null> {
  const { data, error } = await db.schema(scope).from("client_limit")
    .select("ach_dual_control_over_cents")
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (error) throw new Error(`client_limit lookup: ${error.message}`);
  if (!data) return null;
  const v = (data as unknown as Record<string, unknown>).ach_dual_control_over_cents;
  return typeof v === "number" ? v : null;
}

/** Opens the maker-checker record for a payment that needs a second approver. */
export async function openApproval(
  db: SupabaseClient,
  p: {
    resourceType: string;
    resourceId: string;
    createdBy: string;
    decision: DualControlDecision;
    scope?: EvidenceScope;
    ctx?: PartnerContext;
  },
): Promise<void> {
  const scope = p.scope ?? "core";
  const { error } = await db.schema(scope).from("payment_approval").upsert({
    id: `appr_${p.resourceType}_${p.resourceId}`,
    resource_type: p.resourceType,
    resource_id: p.resourceId,
    created_by: p.createdBy,
    basis: p.decision.basis,
    threshold_cents: p.decision.thresholdCents,
    provenance: provenanceFor(scope, p.ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`payment_approval insert: ${error.message}`);
}

async function emitEpsEvent(
  db: SupabaseClient,
  scope: EvidenceScope,
  id: string,
  code: string,
  resourceType: string,
  resourceId: string,
  payload: Record<string, unknown>,
  ctx?: PartnerContext,
): Promise<void> {
  const { error } = await db.schema(scope).from("event").upsert({
    id,
    code,
    resource_type: resourceType,
    resource_id: `${resourceType}:${resourceId}`,
    payload,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`eps event (${code}): ${error.message}`);
}

/**
 * POST /payments/{type}/{id}/approve {note?}
 *
 * The second pair of eyes. Refused if the approver is the originator — checked
 * here for a clean 409, and enforced by ck_payment_approval_four_eyes so it
 * holds against every writer including service_role.
 */
export async function postPaymentApproval(
  req: Request,
  resourceType: string,
  resourceId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  const body = await parseJsonBody(req).catch(() => null);
  const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const outcome = rec.outcome ?? "approve";
  if (outcome !== "approve" && outcome !== "reject") {
    return validationError(requestId, [{
      type: "invalid_value",
      field: "outcome",
      message: 'must be "approve" or "reject"',
    }]);
  }

  const apprId = `appr_${resourceType}_${resourceId}`;
  const { data, error: selErr } = await db.schema(scope).from("payment_approval")
    .select("id, resource_type, resource_id, created_by, approved_by, approved_at, rejected_at, basis")
    .eq("id", apprId).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!data) return notFoundResponse(requestId, "payment_approval", apprId);

  const row = data as unknown as Record<string, unknown>;
  if (row.approved_at || row.rejected_at) {
    return jsonResponse({
      id: apprId,
      approved_at: row.approved_at ?? null,
      rejected_at: row.rejected_at ?? null,
    }, 200, requestId, { "Idempotent-Replayed": "true" });
  }

  // EPS-06's actual property. Two calls is not two people.
  if (row.created_by === ctx.tokenId) {
    return apiError(409, "dual_control_violation", requestId, {
      title: "Dual Control Violation",
      detail:
        `token ${ctx.tokenId} originated this ${resourceType} and may not also ` +
        `approve it; EPS-06 requires a second approver`,
    });
  }

  const nowIso = new Date().toISOString();
  const patch = outcome === "approve"
    ? { approved_by: ctx.tokenId, approved_at: nowIso, decision_note: rec.note ?? null }
    : { rejected_by: ctx.tokenId, rejected_at: nowIso, decision_note: rec.note ?? null };

  const { error: updErr } = await db.schema(scope).from("payment_approval")
    .update(patch).eq("id", apprId);
  if (updErr) return internalErrorResponse(requestId, updErr);

  const { error: railErr } = await db.schema(scope).from(resourceType)
    .update({ dual_control_status: outcome === "approve" ? "approved" : "rejected" })
    .eq("id", resourceId);
  if (railErr) return internalErrorResponse(requestId, railErr);

  try {
    await emitEpsEvent(
      db, scope, `evt_${apprId}_${outcome}`,
      resourceType === "wire_transfer" ? "eps.wire.second_approval" : "eps.dual_control.decided",
      resourceType, resourceId,
      { outcome, approver: ctx.tokenId, originator: row.created_by, basis: row.basis },
      ctx,
    );
  } catch (e) {
    console.error(`eps approval event failed for ${apprId}: ${e}`);
  }

  return jsonResponse({
    id: apprId,
    resource_type: resourceType,
    resource_id: resourceId,
    outcome,
    originator: row.created_by,
    approver: ctx.tokenId,
    decided_at: nowIso,
  }, 200, requestId);
}

/**
 * GET /eps/pending-approvals — payments waiting on a second pair of eyes, plus
 * the UNASSESSED ones.
 *
 * The unassessed list is the visible-unknown surface. Those payments were not
 * blocked (EPS-06 says ACH dual control is "recommended", not required) but
 * nobody determined whether they should have been, and that has to be
 * enumerable rather than inferred from an absence.
 */
/** items per list in one GET /eps/pending-approvals response */
const QUEUE_PAGE = 200;

export async function getPendingApprovals(
  _req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  if (ctx.actorType === "partner") {
    return notFoundResponse(requestId, "route", "/eps");
  }

  // Oldest first (a work queue is cleared in arrival order), one page of
  // QUEUE_PAGE — but the counts are the TRUE totals. They used to be the page
  // length, so a queue of 508 reported 200 and nothing said the rest existed
  // (caught by the partner-flow suite). `truncated` says when the page is not
  // the whole queue.
  const { data: pending, error, count: pendingTotal } = await db.schema(scope).from("payment_approval")
    .select("id, resource_type, resource_id, created_by, created_at, basis, threshold_cents", { count: "exact" })
    .is("approved_at", null)
    .is("rejected_at", null)
    .order("created_at", { ascending: true })
    .limit(QUEUE_PAGE);
  if (error) return internalErrorResponse(requestId, error);

  const unassessed: { rail: string; id: string; amount: number }[] = [];
  let unassessedTotal = 0;
  for (const rail of ["ach_transfer", "wire_transfer"]) {
    const { data, error: uErr, count } = await db.schema(scope).from(rail)
      .select("id, amount, dual_control_status", { count: "exact" })
      .eq("dual_control_status", "unassessed")
      .order("created_at", { ascending: true })
      .limit(QUEUE_PAGE);
    if (uErr) return internalErrorResponse(requestId, uErr);
    unassessedTotal += count ?? (data ?? []).length;
    for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
      unassessed.push({ rail, id: String(r.id), amount: Number(r.amount ?? 0) });
    }
  }

  const pendingCount = pendingTotal ?? (pending ?? []).length;
  return jsonResponse({
    pending: (pending ?? []) as unknown[],
    pending_count: pendingCount,
    pending_truncated: pendingCount > (pending ?? []).length,
    // NOT the same as pending: nobody decided whether these needed approval
    unassessed,
    unassessed_count: unassessedTotal,
    unassessed_truncated: unassessedTotal > unassessed.length,
    ...(unassessedTotal
      ? {
        warning:
          `${unassessedTotal} payment(s) could not be assessed for dual control ` +
          `because no client limit is configured; they were NOT blocked and NOT ` +
          `determined exempt (OQ-14)`,
      }
      : {}),
  }, 200, requestId);
}

/**
 * PUT /eps/client-limits/{partner_id} — set the policy values.
 *
 * The endpoint that makes OQ-14 answerable. Until it is called for a partner,
 * that partner's ACH batches are unassessed.
 */
export async function putClientLimit(
  req: Request,
  partnerId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  if (ctx.actorType === "partner") {
    // a fintech must not set its own dual-control threshold
    return notFoundResponse(requestId, "route", "/eps");
  }

  const body = await parseJsonBody(req).catch(() => null);
  const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};

  const errors: ValidationErrorItem[] = [];
  for (const f of ["ach_dual_control_over_cents", "ach_client_exposure_limit_cents", "wire_daily_limit_cents"]) {
    const v = rec[f];
    if (v !== undefined && v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 0)) {
      errors.push({
        type: "invalid_value",
        field: f,
        message: "must be a non-negative integer number of cents, or null to leave unconfigured",
      });
    }
  }
  if (errors.length) return validationError(requestId, errors);

  const nowIso = new Date().toISOString();
  const { error } = await db.schema(scope).from("client_limit").upsert({
    id: `climit_${partnerId}`,
    partner_id: partnerId,
    ach_dual_control_over_cents: rec.ach_dual_control_over_cents ?? null,
    ach_client_exposure_limit_cents: rec.ach_client_exposure_limit_cents ?? null,
    wire_daily_limit_cents: rec.wire_daily_limit_cents ?? null,
    set_by: ctx.tokenId,
    set_at: nowIso,
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error);

  try {
    await emitEpsEvent(
      db, scope, `evt_climit_${partnerId}_${nowIso}`, "eps.client_limit.changed",
      "client_limit", partnerId,
      { set_by: ctx.tokenId, limits: rec },
      ctx,
    );
  } catch (e) {
    console.error(`client limit event failed for ${partnerId}: ${e}`);
  }

  return jsonResponse({
    partner_id: partnerId,
    ach_dual_control_over_cents: rec.ach_dual_control_over_cents ?? null,
    set_by: ctx.tokenId,
    set_at: nowIso,
  }, 200, requestId);
}
