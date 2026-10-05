// Cash OPERATIONS — CP-01..CP-12. Vaults, devices, limits, reconciliation.
//
// Separate module from `cash.ts` on purpose. That one exists because a CTR
// obligation attaches to currency crossing the counter for a MEMBER; this one
// is the institution's own currency INVENTORY. See the migration header.
//
// Personnel facts come from hr.ts — a WRITER, not an invention: employees,
// separations, coaching and training are declared by an authorized internal
// actor exactly like thresholds and board approvals. (This header used to
// declare the employee concept deliberately absent and keep CP-05/CP-07 red
// naming it; the HR seam is that backlog paid, not a change of stance.)

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor, raiseAlert } from "./bsa.ts";
import { trainingCoveragePct } from "./hr.ts";
import {
  apiError, internalErrorResponse, isNonEmptyString, jsonResponse, notFoundResponse,
  parseJsonBody, selectAll, validationError, type ValidationErrorItem,
} from "./lib.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** 31 CFR 1010.340 — FinCEN Form 105 attaches above $10,000 crossing a border. */
export const CMIR_THRESHOLD_CENTS = 10_000_00;
/** CP-06: an unreconciled suspense item escalates after this long. */
const SUSPENSE_ESCALATION_DAYS = 5;
/** CP-07: an over/short opens an investigation window. */
const OVERSHORT_INVESTIGATION_DAYS = 3;
/** CP-03: a breach must be remediated inside this window. */
const ENTERPRISE_REMEDIATION_DAYS = 30;
/** CP-08: a received shipment must be verified same day. */
const SHIPMENT_VERIFICATION_HOURS = 24;
/** CP-01/CP-12: the KRI pack publishes within this many days of month close. */
const KRI_PUBLISH_DAYS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

function requireInternalActor(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/cash-ops");
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
  if (error) throw new Error(`cash_ops event (${code}): ${error.message}`);
}

function plusDays(from: Date, days: number): string {
  return new Date(from.getTime() + days * DAY_MS).toISOString();
}

// --------------------------------------------------------------- CP-04 limits

/**
 * THE LIMIT IN FORCE for an asset, at a moment.
 *
 * FIFTH INSTANCE OF THE ORDERING-ASSUMPTION CLASS (BLUEPRINT §5g). The
 * schedule that governs is the one with the greatest `effective_at` that is
 * NOT in the future — not the newest row. Two failures the naive version
 * produces, both silent:
 *
 *   - a schedule entered today to take effect next month starts governing
 *     today's loads, so a planned limit increase applies a month early;
 *   - a backdated correction loses to whichever row was typed first, because
 *     insertion order and effective order are different orderings.
 *
 * Every read of a limit goes through here so there is one place to be wrong.
 * An EXPIRED deviation (`sunset_at` in the past) is excluded, which is what
 * makes a seasonal deviation actually seasonal.
 */
export async function limitInForce(
  db: SupabaseClient, scope: EvidenceScope, assetId: string, at: Date,
): Promise<{ limit_cents: number; schedule_id: string; whitelisted: boolean } | null> {
  const { data, error } = await db.schema(scope).from("cash_limits_schedule")
    .select("id, asset_id, limit_cents, effective_at, sunset_at, whitelisted, deviation_id")
    .eq("asset_id", assetId)
    .order("effective_at", { ascending: false });
  if (error) throw new Error(`cash_limits_schedule: ${error.message}`);
  const iso = at.toISOString();
  for (const row of data ?? []) {
    if (String(row.effective_at) > iso) continue;            // not yet in force
    if (row.sunset_at && String(row.sunset_at) <= iso) continue; // deviation lapsed
    return {
      limit_cents: Number(row.limit_cents),
      schedule_id: String(row.id),
      whitelisted: row.whitelisted === true,
    };
  }
  return null;
}

/** PUT /cash-ops/assets/:id — register a vault, drawer, ATM or night drop. */
export async function putCashAsset(
  req: Request, assetId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const TYPES = ["vault", "teller_drawer", "atm", "itm", "night_drop", "cash_recycler"];
  if (!TYPES.includes(String(body.asset_type))) {
    return validationError(requestId, [{
      type: "invalid_value", field: "asset_type", message: `must be one of ${TYPES.join(", ")}`,
    }]);
  }
  const { data, error } = await db.schema(scope).from("cash_asset").upsert({
    id: assetId,
    location_id: isNonEmptyString(body.location_id) ? body.location_id : "unknown",
    asset_type: body.asset_type,
    balance_cents: typeof body.balance_cents === "number" ? body.balance_cents : 0,
    custodian_user_id: isNonEmptyString(body.custodian_user_id) ? body.custodian_user_id : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" }).select("id, asset_type, balance_cents, location_id").maybeSingle();
  if (error) return internalErrorResponse(requestId, error.message);
  return jsonResponse({ data }, 200, requestId);
}

/**
 * POST /cash-ops/limits {asset_id, limit_cents, effective_at, board_resolution_id?,
 *                        deviation_id?, sunset_at?, whitelisted?}
 */
export async function postCashLimitsSchedule(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const limit = typeof body.limit_cents === "number" ? body.limit_cents : NaN;
  const errors: ValidationErrorItem[] = [];
  if (!isNonEmptyString(body.asset_id)) {
    errors.push({ type: "missing_field", field: "asset_id", message: "is required" });
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    errors.push({ type: "invalid_value", field: "limit_cents", message: "must be greater than zero" });
  }
  if (isNonEmptyString(body.deviation_id) && !isNonEmptyString(body.sunset_at)) {
    // CP-10: a deviation with no end date is a permanent limit change wearing
    // an exception's name.
    errors.push({
      type: "missing_field", field: "sunset_at",
      message: "a deviation-backed limit must sunset",
    });
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const effectiveAt = isNonEmptyString(body.effective_at)
    ? body.effective_at
    : new Date().toISOString();
  const id = `cashlim_${body.asset_id}_${new Date(effectiveAt).getTime()}`;
  const { error } = await db.schema(scope).from("cash_limits_schedule").upsert({
    id, asset_id: body.asset_id, limit_cents: limit, effective_at: effectiveAt,
    board_resolution_id: isNonEmptyString(body.board_resolution_id)
      ? body.board_resolution_id
      : null,
    deviation_id: isNonEmptyString(body.deviation_id) ? body.deviation_id : null,
    sunset_at: isNonEmptyString(body.sunset_at) ? body.sunset_at : null,
    whitelisted: body.whitelisted === true,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_sched`, "cash.limits_schedule.updated",
    "cash_asset", String(body.asset_id), {
      "cash.asset.limit": limit,
      "cash.limits_schedule.effective": effectiveAt,
      board_resolution_id: body.board_resolution_id ?? null,
    }, ctx);
  if (body.whitelisted === true) {
    await emit(db, scope, `ev_${id}_wl`, "cash.limits_whitelist.activated",
      "cash_asset", String(body.asset_id), {
        "cash.limits_whitelist.entry": id, sunset_at: body.sunset_at ?? null,
      }, ctx);
  }
  return jsonResponse({ data: { id, limit_cents: limit, effective_at: effectiveAt } }, 201, requestId);
}

/**
 * POST /cash-ops/assets/:id/loads
 * {amount_cents, counter_user_id, custodian_user_id, exception_ticket_id?}
 *
 * CP-04. The limit is tested against the PROJECTED balance — balance + load —
 * before anything is written. Testing the current balance and then applying
 * the load permits every first breach, which is the same defect the CDA cap
 * test avoids and the reason both go through a projection.
 */
export async function postCashLoad(
  req: Request, assetId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const amount = typeof body.amount_cents === "number" ? body.amount_cents : NaN;
  if (!Number.isFinite(amount) || amount === 0) {
    return validationError(requestId, [{
      type: "invalid_value", field: "amount_cents", message: "must be non-zero",
    }]);
  }
  const { data: asset } = await db.schema(scope).from("cash_asset")
    .select("id, balance_cents, location_id, custodian_user_id").eq("id", assetId).maybeSingle();
  if (!asset) return notFoundResponse(requestId, "cash_asset", assetId);

  const now = new Date();
  const inForce = await limitInForce(db, scope, assetId, now);
  const projected = Number(asset.balance_cents ?? 0) + amount;

  const counter = isNonEmptyString(body.counter_user_id) ? body.counter_user_id : null;
  const custodian = isNonEmptyString(body.custodian_user_id) ? body.custodian_user_id : null;

  let reason: string | null = null;
  if (!counter || !custodian) reason = "dual_control_missing";
  else if (counter === custodian) reason = "dual_control_self";
  else if (!inForce) {
    // No schedule means the limit is UNKNOWN, which is not the same as
    // unlimited. Same rule as the unassessed CDA overlay: unknown is not
    // permission.
    reason = "no_limit_in_force";
  } else if (projected > inForce.limit_cents && !inForce.whitelisted) {
    reason = "limit_exceeded";
  }

  const id = `cashload_${assetId}_${crypto.randomUUID()}`;
  const decision = reason === null ? "permitted" : "blocked";
  const { error } = await db.schema(scope).from("cash_load").upsert({
    id, asset_id: assetId, amount_cents: amount,
    projected_balance_cents: projected,
    limit_cents: inForce?.limit_cents ?? null,
    decision, blocked_reason: reason,
    counter_user_id: counter, custodian_user_id: custodian,
    exception_ticket_id: isNonEmptyString(body.exception_ticket_id)
      ? body.exception_ticket_id
      : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_dec`, "cash.load.decided", "cash_asset", assetId, {
    "cash.load.amount": amount, "cash.asset.balance": asset.balance_cents,
    "cash.asset.limit": inForce?.limit_cents ?? null,
    "cash.asset.id": assetId, decision, blocked_reason: reason,
    "cash.counter.user_id": counter, "cash.custodian.user_id": custodian,
    "cash.exception_ticket.id": body.exception_ticket_id ?? null,
  }, ctx);

  if (decision === "blocked") {
    await emit(db, scope, `ev_${id}_block`, "cash.limit_block.alerted",
      "cash_asset", assetId, {
        reason, projected_balance_cents: projected,
        "cash.asset.limit": inForce?.limit_cents ?? null,
      }, ctx);
    return apiError(409, "cash_load_blocked", requestId, {
      title: "cash load blocked",
      detail: reason === "limit_exceeded"
        ? `load would take ${assetId} to ${projected} against a limit of ${inForce?.limit_cents}`
        : reason ?? "blocked",
    });
  }

  // dual control satisfied and the limit respected — only now does cash move
  await db.schema(scope).from("cash_asset").update({
    balance_cents: projected, updated_at: now.toISOString(),
  }).eq("id", assetId);
  await emit(db, scope, `ev_${id}_dual`, "cash.dual_control.completed",
    "cash_asset", assetId, {
      "cash.counter.user_id": counter, "cash.custodian.user_id": custodian,
      "cash.asset.id": assetId,
    }, ctx);

  return jsonResponse({
    data: { id, decision, balance_cents: projected },
  }, 201, requestId);
}

// -------------------------------------------------------- CP-03 enterprise

/**
 * POST /cash-ops/enterprise-positions
 * {as_of_date, cash_cents, gl_total_assets_cents, limit_bp?, warning_bp?}
 *
 * The limit is INSTITUTIONAL, so an unset one yields `unassessed` and no
 * verdict. Reporting "within limit" for an institution that never set a limit
 * would be the most flattering possible reading of a missing decision.
 */
export async function postCashEnterprisePosition(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const cash = typeof body.cash_cents === "number" ? body.cash_cents : NaN;
  const assets = typeof body.gl_total_assets_cents === "number"
    ? body.gl_total_assets_cents
    : NaN;
  const asOf = isNonEmptyString(body.as_of_date) ? body.as_of_date : null;
  if (!asOf || !Number.isFinite(cash) || !Number.isFinite(assets) || assets <= 0) {
    return validationError(requestId, [{
      type: "missing_field", field: "gl_total_assets_cents",
      message: "as_of_date, cash_cents and a positive gl_total_assets_cents are required",
    }]);
  }

  const utilization = Math.floor((cash * 10000) / assets);
  const limitBp = typeof body.limit_bp === "number" ? body.limit_bp : null;
  const warnBp = typeof body.warning_bp === "number" ? body.warning_bp : null;

  let verdict: string;
  if (limitBp === null) verdict = "unassessed";
  else if (utilization > limitBp) verdict = "breached";
  else if (warnBp !== null && utilization > warnBp) verdict = "warning";
  else verdict = "within_limit";

  const excess = verdict === "breached"
    ? cash - Math.floor((assets * (limitBp ?? 0)) / 10000)
    : 0;
  const headroom = limitBp === null
    ? null
    : Math.floor((assets * limitBp) / 10000) - cash;

  const now = new Date();
  const id = `cashent_${String(asOf).replace(/-/g, "")}`;
  const { error } = await db.schema(scope).from("cash_enterprise_position").upsert({
    id, as_of_date: asOf, cash_cents: cash, gl_total_assets_cents: assets,
    utilization_bp: utilization, limit_bp: limitBp, warning_bp: warnBp,
    verdict, excess_cents: excess, headroom_cents: headroom,
    remediation_due_at: verdict === "breached"
      ? plusDays(now, ENTERPRISE_REMEDIATION_DAYS)
      : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "cash.enterprise_position": cash, "gl.total_assets": assets,
    "cash.enterprise_limit.pct": limitBp === null ? null : limitBp / 100,
    "cash.enterprise_position.excess": excess,
    "cash.enterprise_position.headroom": headroom,
    "cash.custodian.user_id": body.custodian_user_id ?? null,
    verdict,
  };
  await emit(db, scope, `ev_${id}_pos`, "cash.enterprise_position.posted",
    "cash_enterprise_position", id, payload, ctx);

  if (verdict === "warning") {
    await emit(db, scope, `ev_${id}_warn`, "cash.enterprise_limit.warning",
      "cash_enterprise_position", id, payload, ctx);
  }
  if (verdict === "breached") {
    await emit(db, scope, `ev_${id}_brch`, "cash.enterprise_limit.breached",
      "cash_enterprise_position", id, payload, ctx);
    await emit(db, scope, `ev_${id}_due`, "cash.enterprise_limit.remediation.due_at",
      "cash_enterprise_position", id, {
        remediation_due_at: plusDays(now, ENTERPRISE_REMEDIATION_DAYS),
      }, ctx);
    // CP-03: excess cash above the limit is idle and gets invested out. The
    // notification is the remediation PATH, not a courtesy.
    await emit(db, scope, `ev_${id}_treas`, "treasury.invest_excess.notified",
      "cash_enterprise_position", id, {
        "cash.enterprise_position.excess": excess,
      }, ctx);
  }
  return jsonResponse({ data: { id, verdict, utilization_bp: utilization, excess_cents: excess } }, 201, requestId);
}

/** POST /cash-ops/enterprise-positions/:id/remediate {action, cash_cents} */
export async function postCashEnterpriseRemediation(
  req: Request, positionId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: pos } = await db.schema(scope).from("cash_enterprise_position")
    .select("id, verdict, limit_bp, gl_total_assets_cents, remediation_due_at")
    .eq("id", positionId).maybeSingle();
  if (!pos) return notFoundResponse(requestId, "cash_enterprise_position", positionId);
  if (pos.verdict !== "breached") {
    return apiError(409, "cash_enterprise_not_breached", requestId, {
      title: "nothing to remediate", detail: "this position recorded no breach",
    });
  }

  // Same rule as the CDA cap cure: remediation means the position ACTUALLY
  // came back under the limit, not that a plan was written down.
  const newCash = typeof body.cash_cents === "number" ? body.cash_cents : NaN;
  if (!Number.isFinite(newCash)) {
    return validationError(requestId, [{
      type: "missing_field", field: "cash_cents",
      message: "the remediated cash position is required — a plan is not a remediation",
    }]);
  }
  const util = Math.floor((newCash * 10000) / Number(pos.gl_total_assets_cents));
  if (util > Number(pos.limit_bp)) {
    return apiError(409, "cash_enterprise_still_breached", requestId, {
      title: "remediation does not clear the breach",
      detail: `position is still ${util}bp against a ${pos.limit_bp}bp limit`,
    });
  }

  const now = new Date();
  await db.schema(scope).from("cash_enterprise_position").update({
    remediated_at: now.toISOString(), updated_at: now.toISOString(),
  }).eq("id", positionId);
  await emit(db, scope, `ev_${positionId}_rem`, "cash.enterprise_limit.remediated",
    "cash_enterprise_position", positionId, {
      action: body.action ?? null, utilization_bp: util,
      within_deadline: pos.remediation_due_at
        ? now.toISOString() <= String(pos.remediation_due_at)
        : null,
    }, ctx);
  return jsonResponse({ data: { id: positionId, remediated: true, utilization_bp: util } }, 200, requestId);
}

// ------------------------------------------------- CP-06 reconciliation / GL

/**
 * POST /cash-ops/assets/:id/reconciliations
 * {business_date, counted_cents, gl_balance_cents, research_notes?}
 */
export async function postCashReconciliation(
  req: Request, assetId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const counted = typeof body.counted_cents === "number" ? body.counted_cents : NaN;
  const gl = typeof body.gl_balance_cents === "number" ? body.gl_balance_cents : NaN;
  const date = isNonEmptyString(body.business_date) ? body.business_date : null;
  if (!date || !Number.isFinite(counted) || !Number.isFinite(gl)) {
    return validationError(requestId, [{
      type: "missing_field", field: "counted_cents",
      message: "business_date, counted_cents and gl_balance_cents are required",
    }]);
  }

  const variance = counted - gl;
  const balanced = variance === 0;
  const now = new Date();
  const id = `cashrec_${assetId}_${String(date).replace(/-/g, "")}`;
  const { error } = await db.schema(scope).from("cash_reconciliation").upsert({
    id, asset_id: assetId, business_date: date,
    counted_cents: counted, gl_balance_cents: gl,
    variance_cents: variance, balanced,
    research_notes: isNonEmptyString(body.research_notes) ? body.research_notes : null,
    due_at: plusDays(now, 1),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_rec`, "cash.recon.completed", "cash_asset", assetId, {
    "cash.asset.balance": counted, "gl.balances": gl,
    "cash.recon.variance": variance, balanced,
    "cash.recon.research_notes": body.research_notes ?? null,
  }, ctx);
  await emit(db, scope, `ev_${id}_due`, "cash.recon.due_at", "cash_asset", assetId, {
    due_at: plusDays(now, 1),
  }, ctx);

  if (!balanced) {
    // A variance does not vanish because it was noticed. It parks in suspense
    // with an aging clock, which is what CP-06 actually asks for.
    const sid = `glsus_${id}`;
    const { error: sErr } = await db.schema(scope).from("gl_cash_suspense").upsert({
      id: sid, reconciliation_id: id, amount_cents: variance,
      opened_at: now.toISOString(),
      escalate_at: plusDays(now, SUSPENSE_ESCALATION_DAYS),
      provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id" });
    if (sErr) return internalErrorResponse(requestId, sErr.message);
    await emit(db, scope, `ev_${sid}_post`, "gl.cash_suspense.posted",
      "gl_cash_suspense", sid, {
        "gl.cash_suspense.item": sid, amount_cents: variance,
        "gl.cash_suspense.aging_timer": plusDays(now, SUSPENSE_ESCALATION_DAYS),
      }, ctx);
    await emit(db, scope, `ev_${id}_var`, "cash.recon.variance_found",
      "cash_asset", assetId, { "cash.recon.variance": variance }, ctx);
  }
  return jsonResponse({ data: { id, balanced, variance_cents: variance } }, 201, requestId);
}

/**
 * POST /cash-ops/suspense/sweep
 *
 * CP-06's aging escalation. Bounded oldest-first, and EVERY examined row is
 * touched whether or not it escalates — the heartbeat starvation finding
 * (BLUEPRINT, memory: bounded oldest-first sweeps that skip rows starve the
 * tail forever).
 */
export async function postCashSuspenseSweep(
  _req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;

  const now = new Date();
  const { data, error } = await db.schema(scope).from("gl_cash_suspense")
    .select("id, amount_cents, opened_at, escalate_at, escalated_at, cleared_at")
    .is("cleared_at", null)
    .order("opened_at", { ascending: true })
    .limit(200);
  if (error) return internalErrorResponse(requestId, error.message);

  const escalated: string[] = [];
  for (const row of data ?? []) {
    const id = String(row.id);
    const due = String(row.escalate_at) <= now.toISOString();
    if (due && !row.escalated_at) {
      await db.schema(scope).from("gl_cash_suspense")
        .update({ escalated_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", id);
      await emit(db, scope, `ev_${id}_esc`, "gl.cash_suspense.escalated",
        "gl_cash_suspense", id, {
          "gl.cash_suspense.item": id, amount_cents: row.amount_cents,
          aged_since: row.opened_at,
        }, ctx);
      await emit(db, scope, `ev_${id}_aged`, "gl.cash_suspense.aged",
        "gl_cash_suspense", id, { aged_since: row.opened_at }, ctx);
      escalated.push(id);
    } else {
      // touched even when nothing happens, so the sweep window rotates past it
      await db.schema(scope).from("gl_cash_suspense")
        .update({ updated_at: now.toISOString() }).eq("id", id);
    }
  }
  return jsonResponse({
    data: { examined: (data ?? []).length, escalated: escalated.length },
  }, 200, requestId);
}

/** POST /cash-ops/suspense/:id/clear {correction_txn_id} */
export async function postCashSuspenseClear(
  req: Request, suspenseId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.correction_txn_id)) {
    // Without the correcting entry, "cleared" means "we stopped looking".
    return validationError(requestId, [{
      type: "missing_field", field: "correction_txn_id",
      message: "clearing a suspense item requires the correcting GL entry",
    }]);
  }
  const now = new Date();
  const { error } = await db.schema(scope).from("gl_cash_suspense").update({
    cleared_at: now.toISOString(), correction_txn_id: body.correction_txn_id,
    updated_at: now.toISOString(),
  }).eq("id", suspenseId);
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${suspenseId}_clr`, "gl.cash_suspense.cleared",
    "gl_cash_suspense", suspenseId, {
      "gl.correction.txn_id": body.correction_txn_id,
    }, ctx);
  return jsonResponse({ data: { id: suspenseId, cleared: true } }, 200, requestId);
}

// ---------------------------------------- CP-05 custody, keys, combinations

/** CP-05: keys and combinations rotate on a clock, not on a memory. */
const CUSTODY_ROTATION_DAYS = 180;
const CUSTODY_ATTESTATION_DAYS = 90;

/**
 * POST /cash-ops/custody {employee_id, kind, asset_id?}
 *
 * The registry entry IS the control: who holds which key/combination, when it
 * rotates, when coverage was last attested. Granting custody to a separated
 * employee is refused — that is not a validation nicety, it is the control.
 */
const CUSTODY_KINDS = ["key", "combination", "keybox"];

export async function postCashCustody(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.employee_id) || !isNonEmptyString(body.kind)) {
    return validationError(requestId, [{
      type: "missing_field", field: "employee_id",
      message: "employee_id and kind (key|combination|keybox) are required",
    }]);
  }
  if (!CUSTODY_KINDS.includes(body.kind)) {
    // the table's check constraint would refuse it anyway — as a 500
    return validationError(requestId, [{
      type: "invalid_value", field: "kind", message: `must be one of ${CUSTODY_KINDS.join(", ")}`,
    }]);
  }
  const { data: emp } = await db.schema(scope).from("employee")
    .select("id, status").eq("id", body.employee_id).maybeSingle();
  if (!emp) return notFoundResponse(requestId, "employee", String(body.employee_id));
  if (emp.status !== "active") {
    return apiError(409, "custody_to_separated_employee", requestId, {
      title: "Custody Refused",
      detail: "custody cannot be granted to a separated employee — that is the CP-05 exposure itself",
    });
  }

  const now = new Date();
  const id = `custody_${crypto.randomUUID()}`;
  const rotationDue = plusDays(now, CUSTODY_ROTATION_DAYS);
  const attestDue = plusDays(now, CUSTODY_ATTESTATION_DAYS);
  const { error } = await db.schema(scope).from("cash_custody").upsert({
    id, employee_id: body.employee_id, kind: body.kind,
    asset_id: isNonEmptyString(body.asset_id) ? body.asset_id : null,
    rotation_due_at: rotationDue, attestation_due_at: attestDue,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_cov`, "cash.coverage.updated", "cash_custody", id, {
    "cash.coverage.registry": [id], "employee.id": body.employee_id, kind: body.kind,
  }, ctx);
  await emit(db, scope, `ev_${id}_rot`, "cash.custody.rotation_due_at", "cash_custody", id, {
    rotation_due_at: rotationDue,
  }, ctx);
  await emit(db, scope, `ev_${id}_attdue`, "cash.coverage.attestation.due_at", "cash_custody", id, {
    attestation_due_at: attestDue,
  }, ctx);
  await emit(db, scope, `ev_${id}_evid`, "cash.evidence.created", "cash_custody", id, {
    "cash.evidence.type": "custody_grant", "employee.id": body.employee_id,
  }, ctx);
  return jsonResponse({ data: { id, rotation_due_at: rotationDue } }, 201, requestId);
}

/** POST /cash-ops/custody/{id}/attest {attested_by} */
export async function postCashCustodyAttest(
  req: Request, custodyId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: cust } = await db.schema(scope).from("cash_custody")
    .select("id, revoked_at").eq("id", custodyId).maybeSingle();
  if (!cust) return notFoundResponse(requestId, "cash_custody", custodyId);
  if (cust.revoked_at) {
    return apiError(409, "custody_revoked", requestId, {
      title: "Custody Revoked",
      detail: "a revoked custody cannot be attested — attest the live registry, not history",
    });
  }
  const now = new Date();
  const { error } = await db.schema(scope).from("cash_custody").update({
    attested_at: now.toISOString(),
    attestation_due_at: plusDays(now, CUSTODY_ATTESTATION_DAYS),
  }).eq("id", custodyId);
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${custodyId}_att_${now.getTime()}`, "cash.coverage.attested",
    "cash_custody", custodyId, {
      attested_by: body.attested_by ?? ctx.tokenId,
    }, ctx);
  return jsonResponse({ data: { id: custodyId, attested: true } }, 200, requestId);
}

/**
 * POST /cash-ops/custody/{id}/keybox-open {second_person_id, reason}
 *
 * DUAL CONTROL enforced, not described: no second person or no reason is a
 * refusal, and the refusal names the rule.
 */
export async function postCashKeyboxOpen(
  req: Request, custodyId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: cust } = await db.schema(scope).from("cash_custody")
    .select("id, employee_id, revoked_at").eq("id", custodyId).maybeSingle();
  if (!cust) return notFoundResponse(requestId, "cash_custody", custodyId);
  if (cust.revoked_at) {
    return apiError(409, "custody_revoked", requestId, {
      title: "Custody Revoked", detail: "a revoked custody cannot open the keybox",
    });
  }
  if (!isNonEmptyString(body.second_person_id) || !isNonEmptyString(body.reason)) {
    return apiError(422, "dual_control_required", requestId, {
      title: "Dual Control Required",
      detail: "keybox access requires a second person and a stated reason (CP-05)",
    });
  }
  if (body.second_person_id === cust.employee_id) {
    return apiError(422, "dual_control_required", requestId, {
      title: "Dual Control Required",
      detail: "the second person must be a DIFFERENT person — one keyholder twice is one keyholder",
    });
  }
  // The second person must be someone who can actually stand there: a current
  // employee. An unknown id used to reach the employee FK and come back a 500.
  const { data: second } = await db.schema(scope).from("employee")
    .select("id, status").eq("id", body.second_person_id).maybeSingle();
  if (!second || second.status !== "active") {
    return apiError(422, "dual_control_required", requestId, {
      title: "Dual Control Required",
      detail: "the second person must be a current employee",
    });
  }
  const id = `keybox_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("cash_keybox_access").upsert({
    id, custody_id: custodyId, second_person_id: body.second_person_id,
    reason: body.reason, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${id}_log`, "cash.keybox_access.logged", "cash_keybox_access", id, {
    "cash.keybox.reason": body.reason, "employee.id": cust.employee_id,
    second_person_id: body.second_person_id,
  }, ctx);
  await emit(db, scope, `ev_${id}_dual`, "cash.dual_control.completed",
    "cash_keybox_access", id, { second_person_id: body.second_person_id }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

// ------------------------------------------------------- CP-07 over / short

/**
 * POST /cash-ops/assets/:id/overshort
 * {custodian_user_id, business_date, amount_cents, research_notes?, threshold_cents?}
 *
 * CP-07 stays RED — it declares `hr.coaching.recorded` and this system has no
 * concept of an employee, let alone of coaching one. Everything else the
 * control asks for is real and is built: the posting, the investigation clock,
 * the cumulative running total per custodian, and the BSA alert when the
 * pattern crosses a threshold.
 *
 * The CUMULATIVE total is the control. A single $20 short is noise; the same
 * custodian $20 short eleven times is the pattern CP-07 exists to surface, and
 * a per-event threshold can never see it.
 */
export async function postCashOverShort(
  req: Request, assetId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const amount = typeof body.amount_cents === "number" ? body.amount_cents : NaN;
  const custodian = isNonEmptyString(body.custodian_user_id) ? body.custodian_user_id : null;
  if (!Number.isFinite(amount) || amount === 0 || !custodian) {
    return validationError(requestId, [{
      type: "invalid_value", field: "amount_cents",
      message: "a non-zero amount_cents and custodian_user_id are required",
    }]);
  }

  const { data: prior } = await db.schema(scope).from("cash_overshort")
    .select("id, custodian_user_id, amount_cents").eq("custodian_user_id", custodian);
  const cumulative = (prior ?? [])
    .reduce((n: number, r: Any) => n + Math.abs(Number(r.amount_cents)), 0) + Math.abs(amount);

  const now = new Date();
  const id = `cashos_${assetId}_${crypto.randomUUID()}`;
  const { data: asset } = await db.schema(scope).from("cash_asset")
    .select("id, location_id").eq("id", assetId).maybeSingle();

  const { error } = await db.schema(scope).from("cash_overshort").upsert({
    id, asset_id: assetId, custodian_user_id: custodian,
    business_date: isNonEmptyString(body.business_date)
      ? body.business_date
      : now.toISOString().slice(0, 10),
    amount_cents: amount, cumulative_cents: cumulative,
    research_notes: isNonEmptyString(body.research_notes) ? body.research_notes : null,
    investigation_due_at: plusDays(now, OVERSHORT_INVESTIGATION_DAYS),
    investigation_opened_at: now.toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "cash.overshort.amount": amount, "cash.overshort.cumulative": cumulative,
    "cash.custodian.user_id": custodian, "cash.location.id": asset?.location_id ?? null,
    "cash.overshort.research_notes": body.research_notes ?? null,
  };
  await emit(db, scope, `ev_${id}_post`, "cash.overshort.posted", "cash_asset", assetId, payload, ctx);
  await emit(db, scope, `ev_${id}_rec`, "cash.overshort.recorded", "cash_asset", assetId, payload, ctx);
  await emit(db, scope, `ev_${id}_due`, "cash.overshort.investigation.due_at",
    "cash_asset", assetId, {
      investigation_due_at: plusDays(now, OVERSHORT_INVESTIGATION_DAYS),
    }, ctx);
  await emit(db, scope, `ev_${id}_inv`, "cash.overshort_investigation.opened",
    "cash_asset", assetId, payload, ctx);

  // The threshold is INSTITUTIONAL, so an unset one is reported as unassessed
  // rather than as "not crossed".
  const threshold = typeof body.threshold_cents === "number" ? body.threshold_cents : null;
  if (threshold === null) {
    await emit(db, scope, `ev_${id}_unassessed`, "cash.overshort.thresholds",
      "cash_asset", assetId, {
        "cash.overshort.thresholds": null, verdict: "unassessed",
      }, ctx);
  } else if (cumulative > threshold) {
    await emit(db, scope, `ev_${id}_thr`, "cash.overshort.threshold_crossed",
      "cash_asset", assetId, {
        "cash.overshort.thresholds": threshold, "cash.overshort.cumulative": cumulative,
        "cash.overshort.pattern": `${(prior ?? []).length + 1} events`,
      }, ctx);
    // A repeated unexplained cash difference is a BSA signal, not only an
    // operational one. This routes through the SAME alert writer money movement
    // uses, so the case machinery picks it up unchanged.
    await raiseAlert(db, {
      ctx, scope, alertType: "structuring", entityHash: custodian,
      causeType: "cash_overshort", causeId: id,
      details: `cumulative over/short ${cumulative} crossed ${threshold}`,
    });
  }
  return jsonResponse({ data: { id, cumulative_cents: cumulative } }, 201, requestId);
}

/** POST /cash-ops/overshort/:id/resolve {research_notes} */
export async function postCashOverShortResolve(
  req: Request, osId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.research_notes)) {
    return validationError(requestId, [{
      type: "missing_field", field: "research_notes",
      message: "an over/short closed with no research is closed, not resolved",
    }]);
  }
  const now = new Date();
  const { data: rec } = await db.schema(scope).from("cash_overshort")
    .select("id, investigation_due_at, amount_cents").eq("id", osId).maybeSingle();
  if (!rec) return notFoundResponse(requestId, "cash_overshort", osId);

  const { error } = await db.schema(scope).from("cash_overshort").update({
    resolved_at: now.toISOString(), research_notes: body.research_notes,
    updated_at: now.toISOString(),
  }).eq("id", osId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${osId}_res`, "cash.overshort.resolved",
    "cash_overshort", osId, {
      "cash.overshort.research_notes": body.research_notes,
      "cash.overshort.amount": rec.amount_cents,
      resolved_late: rec.investigation_due_at
        ? now.toISOString() > String(rec.investigation_due_at)
        : null,
    }, ctx);
  return jsonResponse({ data: { id: osId, resolved: true } }, 200, requestId);
}

// ---------------------------------------------------------- CP-08 shipments

/** POST /cash-ops/shipments {id?, asset_id?, direction, amount_cents, seal_expected, crosses_border?} */
export async function postCashShipment(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const amount = typeof body.amount_cents === "number" ? body.amount_cents : NaN;
  if (!isNonEmptyString(body.seal_expected) || !Number.isFinite(amount) || amount <= 0) {
    // Without the EXPECTED seal recorded at dispatch, a mismatch on receipt is
    // undetectable — which is the whole risk the control addresses.
    return validationError(requestId, [{
      type: "missing_field", field: "seal_expected",
      message: "seal_expected and a positive amount_cents are required",
    }]);
  }
  const now = new Date();
  const id = isNonEmptyString(body.id) ? body.id : `cashship_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("cash_shipment").upsert({
    id,
    asset_id: isNonEmptyString(body.asset_id) ? body.asset_id : null,
    direction: body.direction === "outbound" ? "outbound" : "inbound",
    amount_cents: amount,
    courier_receipt_id: isNonEmptyString(body.courier_receipt_id)
      ? body.courier_receipt_id
      : null,
    seal_expected: body.seal_expected,
    crosses_border: body.crosses_border === true,
    verification_due_at: new Date(now.getTime() + SHIPMENT_VERIFICATION_HOURS * 60 * 60 * 1000)
      .toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_recv`, "cash.shipment.received", "cash_shipment", id, {
    "cash.shipment.amount": amount, "courier.receipt.id": body.courier_receipt_id ?? null,
    "cash.seal.expected": body.seal_expected,
    "gl.cash_in_transit.entry": `cit_${id}`,
  }, ctx);
  await emit(db, scope, `ev_${id}_vdue`, "cash.shipment.verification.due_at",
    "cash_shipment", id, {
      verification_due_at: new Date(
        now.getTime() + SHIPMENT_VERIFICATION_HOURS * 60 * 60 * 1000,
      ).toISOString(),
    }, ctx);

  // 31 CFR 1010.340. Identified on RECEIPT, not on filing: the obligation
  // attaches when the currency crosses, and a report nobody has filed yet is
  // exactly the state the record needs to represent.
  if (body.crosses_border === true && amount > CMIR_THRESHOLD_CENTS) {
    const cid = `cmir_${id}`;
    await db.schema(scope).from("cmir_filing").upsert({
      id: cid, shipment_id: id, amount_cents: amount,
      identified_at: now.toISOString(),
      provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id" });
    await emit(db, scope, `ev_${cid}_id`, "cmir.reportable.identified",
      "cmir_filing", cid, {
        amount_cents: amount, threshold_cents: CMIR_THRESHOLD_CENTS,
        "cash.shipment.amount": amount,
      }, ctx);
  }
  return jsonResponse({ data: { id } }, 201, requestId);
}

/**
 * POST /cash-ops/shipments/:id/verify
 * {seal_found, counter_user_id, custodian_user_id}
 *
 * CP-08. A seal mismatch is not a discrepancy to note — it is an incident, and
 * it creates one. The shipment CANNOT be marked verified, enforced by
 * `ck_cash_shipment_verified_seal_ok` as well as here, because the API path
 * and the constraint should not be the same single point of failure.
 */
export async function postCashShipmentVerify(
  req: Request, shipmentId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: ship } = await db.schema(scope).from("cash_shipment")
    .select("id, seal_expected, amount_cents, asset_id, direction").eq("id", shipmentId).maybeSingle();
  if (!ship) return notFoundResponse(requestId, "cash_shipment", shipmentId);

  const found = isNonEmptyString(body.seal_found) ? body.seal_found : null;
  const counter = isNonEmptyString(body.counter_user_id) ? body.counter_user_id : null;
  const custodian = isNonEmptyString(body.custodian_user_id) ? body.custodian_user_id : null;
  if (!found || !counter || !custodian || counter === custodian) {
    return validationError(requestId, [{
      type: "invalid_value", field: "seal_found",
      message: "seal_found and two DIFFERENT users (counter, custodian) are required",
    }]);
  }

  const matched = found === ship.seal_expected;
  const now = new Date();

  await emit(db, scope, `ev_${shipmentId}_dual`, "cash.dual_control.completed",
    "cash_shipment", shipmentId, {
      "cash.counter.user_id": counter, "cash.custodian.user_id": custodian,
    }, ctx);
  await emit(db, scope, `ev_${shipmentId}_svc`, "cash.device_service.logged",
    "cash_shipment", shipmentId, {
      "cash.asset.id": ship.asset_id, direction: ship.direction,
    }, ctx);

  if (!matched) {
    // An incident row, through the same table the incident lifecycle uses, so
    // the 72-hour NCUA determination machinery applies unchanged.
    const incId = `inc_seal_${shipmentId}`;
    await db.schema(scope).from("incident").upsert({
      id: incId, title: `cash shipment seal mismatch ${shipmentId}`,
      severity: "sev2", source: "cash_operations", status: "declared",
      declared_at: now.toISOString(),
      provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id", ignoreDuplicates: true });
    await db.schema(scope).from("cash_shipment").update({
      seal_found: found, seal_matched: false, incident_id: incId,
      updated_at: now.toISOString(),
    }).eq("id", shipmentId);

    await emit(db, scope, `ev_${shipmentId}_seal`, "cash.seal.mismatch",
      "cash_shipment", shipmentId, {
        "cash.seal.expected": ship.seal_expected, "cash.seal.found": found,
        "cash.shipment.amount": ship.amount_cents,
      }, ctx);
    await emit(db, scope, `ev_${incId}_created`, "incident.created", "incident", incId, {
      source: "cash_operations", shipment_id: shipmentId, severity: "sev2",
    }, ctx);
    return apiError(409, "cash_seal_mismatch", requestId, {
      title: "shipment seal does not match",
      detail: `expected ${ship.seal_expected}, found ${found}; an incident has been declared`,
    });
  }

  await db.schema(scope).from("cash_shipment").update({
    seal_found: found, seal_matched: true, verified_at: now.toISOString(),
    updated_at: now.toISOString(),
  }).eq("id", shipmentId);
  await emit(db, scope, `ev_${shipmentId}_ver`, "cash.shipment.verified",
    "cash_shipment", shipmentId, {
      "cash.seal.expected": ship.seal_expected, "cash.seal.found": found,
      "cash.shipment.amount": ship.amount_cents,
    }, ctx);
  return jsonResponse({ data: { id: shipmentId, verified: true } }, 200, requestId);
}

/** POST /cash-ops/nightdrop/:assetId/retrieve {counter_user_id, custodian_user_id, bag_count} */
export async function postCashNightDropRetrieval(
  req: Request, assetId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const counter = isNonEmptyString(body.counter_user_id) ? body.counter_user_id : null;
  const custodian = isNonEmptyString(body.custodian_user_id) ? body.custodian_user_id : null;
  if (!counter || !custodian || counter === custodian) {
    // A night drop opened by one person is the classic single-custody exposure
    // CP-08 exists to close.
    return validationError(requestId, [{
      type: "invalid_value", field: "custodian_user_id",
      message: "night drop retrieval requires two different users",
    }]);
  }
  const id = `cashnd_${assetId}_${crypto.randomUUID()}`;
  await emit(db, scope, `ev_${id}_dual`, "cash.dual_control.completed",
    "cash_asset", assetId, {
      "cash.counter.user_id": counter, "cash.custodian.user_id": custodian,
    }, ctx);
  await emit(db, scope, `ev_${id}_nd`, "cash.nightdrop.verified", "cash_asset", assetId, {
    "cash.asset.id": assetId, bag_count: body.bag_count ?? null,
  }, ctx);
  return jsonResponse({ data: { id, verified: true } }, 201, requestId);
}

// ---------------------------------------------------- CP-09 surprise counts

/** POST /cash-ops/surprise-counts {asset_id, scheduled_for} */
export async function postCashSurpriseCountSchedule(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.asset_id) || !isNonEmptyString(body.scheduled_for)) {
    return validationError(requestId, [{
      type: "missing_field", field: "scheduled_for",
      message: "asset_id and scheduled_for are required",
    }]);
  }
  const id = `cashsc_${body.asset_id}_${String(body.scheduled_for).replace(/-/g, "")}`;
  const due = new Date(`${body.scheduled_for}T23:59:59.000Z`).toISOString();
  const { error } = await db.schema(scope).from("cash_surprise_count").upsert({
    id, asset_id: body.asset_id, scheduled_for: body.scheduled_for, due_at: due,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_due`, "cash.surprise_count.due",
    "cash_surprise_count", id, {
      "cash.surprise_count.schedule": body.scheduled_for, due_at: due,
      "cash.asset.id": body.asset_id,
    }, ctx);
  return jsonResponse({ data: { id, due_at: due } }, 201, requestId);
}

/** POST /cash-ops/surprise-counts/:id/complete {counted_cents, counted_by} */
export async function postCashSurpriseCountComplete(
  req: Request, countId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: sc } = await db.schema(scope).from("cash_surprise_count")
    .select("id, asset_id, scheduled_for").eq("id", countId).maybeSingle();
  if (!sc) return notFoundResponse(requestId, "cash_surprise_count", countId);

  const counted = typeof body.counted_cents === "number" ? body.counted_cents : NaN;
  const by = isNonEmptyString(body.counted_by) ? body.counted_by : null;
  if (!Number.isFinite(counted) || !by) {
    return validationError(requestId, [{
      type: "missing_field", field: "counted_by",
      message: "counted_cents and counted_by are required — an uncounted count is a schedule entry",
    }]);
  }

  const { data: asset } = await db.schema(scope).from("cash_asset")
    .select("id, balance_cents, custodian_user_id").eq("id", sc.asset_id).maybeSingle();
  const book = Number(asset?.balance_cents ?? 0);
  const variance = counted - book;
  const now = new Date();

  const { error } = await db.schema(scope).from("cash_surprise_count").update({
    completed_at: now.toISOString(), counted_cents: counted, book_cents: book,
    variance_cents: variance, counted_by: by, updated_at: now.toISOString(),
  }).eq("id", countId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${countId}_done`, "cash.surprise_count.completed",
    "cash_surprise_count", countId, {
      "cash.asset.count": counted, "cash.asset.balance": book,
      "cash.surprise_count.variance": variance, counted_by: by,
    }, ctx);

  if (variance !== 0) {
    // A surprise count variance IS an over/short and opens the same
    // investigation. Two separate registers would let the same difference be
    // investigated under one and ignored under the other.
    await emit(db, scope, `ev_${countId}_inv`, "cash.overshort_investigation.opened",
      "cash_surprise_count", countId, {
        "cash.surprise_count.variance": variance,
        "cash.custodian.user_id": asset?.custodian_user_id ?? null,
      }, ctx);
  }
  return jsonResponse({ data: { id: countId, variance_cents: variance } }, 200, requestId);
}

// -------------------------------------------------------- CP-10 deviations

/** POST /cash-ops/deviations {asset_id, requested_limit_cents, period_reason, sunset_at} */
export async function postCashDeviationRequest(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const limit = typeof body.requested_limit_cents === "number"
    ? body.requested_limit_cents
    : NaN;
  if (!isNonEmptyString(body.asset_id) || !Number.isFinite(limit) ||
      !isNonEmptyString(body.period_reason) || !isNonEmptyString(body.sunset_at)) {
    return validationError(requestId, [{
      type: "missing_field", field: "sunset_at",
      message: "asset_id, requested_limit_cents, period_reason and sunset_at are required",
    }]);
  }
  const id = `cashdev_${body.asset_id}_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("cash_deviation").upsert({
    id, asset_id: body.asset_id, requested_limit_cents: limit,
    period_reason: body.period_reason, sunset_at: body.sunset_at,
    decision: "requested", provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_req`, "cash.deviation.requested",
    "cash_deviation", id, {
      "cash.deviation.period": body.period_reason,
      "cash.deviation.reason": body.period_reason,
      "cash.deviation.sunset_at": body.sunset_at,
    }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/**
 * POST /cash-ops/deviations/:id/decide
 * {decision, board_resolution_id?, insurance_bond_adjustment?}
 *
 * CP-10. Approving a higher cash limit needs BOTH a Board resolution and a
 * bond adjustment: raising the exposure without raising the coverage is the
 * failure this control exists to prevent, and either one alone reads like a
 * complete approval.
 */
export async function postCashDeviationDecision(
  req: Request, devId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: dev } = await db.schema(scope).from("cash_deviation")
    .select("id, asset_id, requested_limit_cents, sunset_at, period_reason")
    .eq("id", devId).maybeSingle();
  if (!dev) return notFoundResponse(requestId, "cash_deviation", devId);

  const approving = body.decision === "approved";
  const board = isNonEmptyString(body.board_resolution_id) ? body.board_resolution_id : null;
  const bond = isNonEmptyString(body.insurance_bond_adjustment)
    ? body.insurance_bond_adjustment
    : null;
  if (approving && (!board || !bond)) {
    return validationError(requestId, [{
      type: "missing_field", field: board ? "insurance_bond_adjustment" : "board_resolution_id",
      message: "an approved deviation requires a Board resolution AND a bond adjustment",
    }]);
  }

  const now = new Date();
  const { error } = await db.schema(scope).from("cash_deviation").update({
    decision: approving ? "approved" : "denied",
    board_resolution_id: board, insurance_bond_adjustment: bond,
    decided_at: now.toISOString(), updated_at: now.toISOString(),
  }).eq("id", devId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${devId}_dec`, "cash.deviation_board.decided",
    "cash_deviation", devId, {
      decision: approving ? "approved" : "denied",
      board_resolution_id: board,
      "insurance.bond.adjustment": bond,
      "cash.deviation.sunset_at": dev.sunset_at,
      "exception.rationale": dev.period_reason,
      "exception.risk_acceptance": approving ? "board_accepted" : "declined",
    }, ctx);

  if (approving) {
    // The approval WRITES A SCHEDULE ROW rather than mutating a limit in
    // place, so the deviation is visible as a time-boxed override and expires
    // by itself. A mutated limit would have to be remembered and undone.
    const schedId = `cashlim_${dev.asset_id}_${new Date(now).getTime()}`;
    await db.schema(scope).from("cash_limits_schedule").upsert({
      id: schedId, asset_id: dev.asset_id,
      limit_cents: dev.requested_limit_cents,
      effective_at: now.toISOString(), board_resolution_id: board,
      deviation_id: devId, sunset_at: dev.sunset_at, whitelisted: true,
      provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id" });
    await emit(db, scope, `ev_${schedId}_sched`, "cash.limits_schedule.updated",
      "cash_asset", String(dev.asset_id), {
        "cash.asset.limit": dev.requested_limit_cents,
        "cash.limits_schedule.effective": now.toISOString(),
        deviation_id: devId,
      }, ctx);
    await emit(db, scope, `ev_${schedId}_wl`, "cash.limits_whitelist.activated",
      "cash_asset", String(dev.asset_id), {
        "cash.limits_whitelist.entry": schedId,
        "cash.deviation.sunset_at": dev.sunset_at,
      }, ctx);
  }
  return jsonResponse({ data: { id: devId, decision: approving ? "approved" : "denied" } }, 200, requestId);
}

// ------------------------------------------- CP-01 / CP-12 governance & KRI

/** POST /cash-ops/policy {policy_document_version, board_resolution_id, adopted_at?} */
export async function postCashPolicyAdoption(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.policy_document_version) ||
      !isNonEmptyString(body.board_resolution_id)) {
    return validationError(requestId, [{
      type: "missing_field", field: "board_resolution_id",
      message: "policy_document_version and board_resolution_id are required",
    }]);
  }
  const adoptedAt = isNonEmptyString(body.adopted_at) ? new Date(body.adopted_at) : new Date();
  const expires = new Date(adoptedAt.getTime());
  expires.setUTCMonth(expires.getUTCMonth() + 12);

  const id = `cashpol_${String(body.policy_document_version).replace(/[^a-zA-Z0-9]/g, "")}`;
  const { error } = await db.schema(scope).from("cash_policy").upsert({
    id, policy_document_version: body.policy_document_version,
    board_resolution_id: body.board_resolution_id,
    adopted_at: adoptedAt.toISOString(), policy_expiry_at: expires.toISOString(),
    superseded_at: null, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_appr`, "policy.board.approved", "cash_policy", id, {
    "policy.document_version": body.policy_document_version,
    board_resolution_id: body.board_resolution_id,
  }, ctx);
  await emit(db, scope, `ev_${id}_pub`, "policy.revision.published", "cash_policy", id, {
    "policy.document_version": body.policy_document_version,
    policy_expiry_at: expires.toISOString(),
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/** POST /cash-ops/exceptions {kind, rationale, risk_acceptance, accepted_by, asset_id?} */
export async function postCashException(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const errors: ValidationErrorItem[] = [];
  for (const f of ["kind", "rationale", "risk_acceptance", "accepted_by"]) {
    if (!isNonEmptyString(body[f])) {
      // An exception without a rationale AND an explicit risk acceptance is a
      // log line. The two fields are what make it a governance record.
      errors.push({ type: "missing_field", field: f, message: "is required" });
    }
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const id = `cashexc_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("cash_exception").upsert({
    id, asset_id: isNonEmptyString(body.asset_id) ? body.asset_id : null,
    kind: body.kind, rationale: body.rationale,
    risk_acceptance: body.risk_acceptance, accepted_by: body.accepted_by,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_exc`, "cash.exception.logged", "cash_exception", id, {
    "exception.rationale": body.rationale,
    "exception.risk_acceptance": body.risk_acceptance,
    kind: body.kind, accepted_by: body.accepted_by,
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/**
 * POST /cash-ops/kri {period}
 *
 * CP-01 and CP-12. Every figure is COMPUTED from the tables — over/short
 * totals, reconciliation variances, open suspense items, exception count. A
 * KRI pack whose numbers are supplied by the caller reports whatever the
 * caller believes, which is the opposite of a key risk indicator.
 */
export async function postCashKriPublish(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const period = isNonEmptyString(body.period) ? body.period : "unknown";

  // Whole registers, paged: an unpaged select stops at 1000 rows without
  // saying so, and the KRI then under-reports (caught by the flow suite).
  const os = await selectAll<Any>(db, scope, "cash_overshort", "id, amount_cents, resolved_at");
  const recs = await selectAll<Any>(db, scope, "cash_reconciliation", "id, balanced, variance_cents");
  const excs = await selectAll<Any>(db, scope, "cash_exception", "id, kind, rationale, risk_acceptance");
  const susp = await selectAll<Any>(db, scope, "gl_cash_suspense", "id, cleared_at");

  const overshortTotal = (os ?? [])
    .reduce((n: number, r: Any) => n + Math.abs(Number(r.amount_cents)), 0);
  const varianceCount = (recs ?? []).filter((r: Any) => r.balanced === false).length;
  const openSuspense = (susp ?? []).filter((r: Any) => !r.cleared_at).length;

  const now = new Date();
  const dueAt = plusDays(now, KRI_PUBLISH_DAYS);
  const id = `cashkri_${period}`;
  const { error } = await db.schema(scope).from("cash_kri").upsert({
    id, period,
    overshort_monthly_summary_cents: overshortTotal,
    overshort_event_count: (os ?? []).length,
    recon_variance_count: varianceCount,
    exception_count: (excs ?? []).length,
    suspense_open_count: openSuspense,
    trend: (os ?? []).length > 0 ? "active" : "flat",
    publish_due_at: dueAt, published_at: now.toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_due`, "cash.kri.publish.due_at", "cash_kri", id, {
    publish_due_at: dueAt,
  }, ctx);
  // CP-12: training coverage is COMPUTED like every other KRI figure —
  // trained cash-handlers over all cash-handlers, null (unassessed) when the
  // institution has declared no personnel. Caller-supplied coverage would
  // report whatever the caller believes.
  const trainingCoverage = await trainingCoveragePct(db, scope);
  await emit(db, scope, `ev_${id}_pub`, "cash.kri.published", "cash_kri", id, {
    "cash.kri": {
      overshort_monthly_summary_cents: overshortTotal,
      recon_variance_count: varianceCount, suspense_open_count: openSuspense,
    },
    "cash.kri.trend": (os ?? []).length > 0 ? "active" : "flat",
    "cash.overshort.monthly_summary": overshortTotal,
    "training.coverage_pct": trainingCoverage,
    ...(trainingCoverage === null ? { training_coverage_verdict: "unassessed" } : {}),
    period,
  }, ctx);
  // CP-07's monthly report is this section of the KRI pack, not a separate
  // document. Emitting it from a second writer would let the two disagree.
  await emit(db, scope, `ev_${id}_osrep`, "cash.overshort_report.issued", "cash_kri", id, {
    "cash.overshort.monthly_summary": overshortTotal,
    "cash.overshort.cumulative": overshortTotal,
    event_count: (os ?? []).length, period,
  }, ctx);
  await emit(db, scope, `ev_${id}_excreg`, "cash.exception_register", "cash_kri", id, {
    "cash.exception_register": (excs ?? []).map((e: Any) => ({
      id: e.id, kind: e.kind, "exception.rationale": e.rationale,
      "exception.risk_acceptance": e.risk_acceptance,
    })),
  }, ctx);
  await emit(db, scope, `ev_${id}_excsum`, "cash.exception_register.summary",
    "cash_kri", id, {
      "cash.exception_register.summary": {
        count: (excs ?? []).length, period,
      },
    }, ctx);
  return jsonResponse({
    data: { id, overshort_monthly_summary_cents: overshortTotal, exception_count: (excs ?? []).length },
  }, 201, requestId);
}

/**
 * POST /cash-ops/board-summary {quarter}
 *
 * CP-01's quarterly Board packet. Assembled from the registers, same rule as
 * the KRI pack and the CDA board packet.
 */
export async function postCashBoardSummary(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const quarter = isNonEmptyString(body.quarter) ? body.quarter : "unknown";

  const { data: pos } = await db.schema(scope).from("cash_enterprise_position")
    .select("id, as_of_date, utilization_bp, verdict")
    .order("as_of_date", { ascending: false }).limit(1);
  const assets = await selectAll<Any>(db, scope, "cash_asset", "id, balance_cents");
  const excs = await selectAll<Any>(db, scope, "cash_exception", "id, kind");
  // The MOST RECENTLY published KRI. Unordered, [0] was whichever row
  // Postgres returned first — an arbitrary period in front of the Board.
  const { data: kri } = await db.schema(scope).from("cash_kri")
    .select("id, period, overshort_monthly_summary_cents, trend")
    .order("published_at", { ascending: false, nullsFirst: false }).limit(1);

  const id = `cashboard_${quarter}`;
  await emit(db, scope, `ev_${id}`, "board.cash_summary.delivered", "cash_kri", id, {
    quarter,
    "cash.enterprise_position": (pos ?? [])[0]?.utilization_bp ?? null,
    "cash.asset.balance": (assets ?? [])
      .reduce((n: number, a: Any) => n + Number(a.balance_cents ?? 0), 0),
    "cash.exception_register.summary": { count: (excs ?? []).length },
    "cash.kri.trend": (kri ?? [])[0]?.trend ?? null,
    "cash.overshort.monthly_summary": (kri ?? [])[0]?.overshort_monthly_summary_cents ?? 0,
  }, ctx);
  return jsonResponse({ data: { id, quarter } }, 201, requestId);
}

/**
 * POST /cash-ops/records-packages {purpose, scope, requested_at?, delivered_to?}
 *
 * CP-09 / CP-12. An examiner export is a bundle with a DECLARED SCOPE, stored
 * because "what did we give them" is the question asked afterwards.
 */
export async function postCashRecordsPackage(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const purposes = ["exam_export", "supervisory_count", "internal"];
  if (!purposes.includes(String(body.purpose))) {
    return validationError(requestId, [{
      type: "invalid_value", field: "purpose", message: `must be one of ${purposes.join(", ")}`,
    }]);
  }
  const exportScope = (body.scope ?? null) as Record<string, unknown> | null;
  if (!exportScope || typeof exportScope !== "object") {
    return validationError(requestId, [{
      type: "missing_field", field: "scope",
      message: "an export with no declared scope cannot be reconciled afterwards",
    }]);
  }

  // The item count is COUNTED, not asserted — a package claiming 400 documents
  // and containing 3 is worse than no package.
  const recons = await selectAll<Any>(db, scope, "cash_reconciliation", "id");
  const counts = await selectAll<Any>(db, scope, "cash_surprise_count", "id");
  const oss = await selectAll<Any>(db, scope, "cash_overshort", "id");
  const itemIds = [
    ...(recons ?? []).map((r: Any) => String(r.id)),
    ...(counts ?? []).map((r: Any) => String(r.id)),
    ...(oss ?? []).map((r: Any) => String(r.id)),
  ];
  const itemCount = itemIds.length;

  const now = new Date();
  const id = `recpkg_${crypto.randomUUID()}`;
  // RS-08 owns this table and its rule applies to exam exports too: a package
  // without a manifest is "a directory somebody said was fine". The manifest
  // is the item list itself; the checksum chain binds it. (Found LIVE: the
  // shared table requires the manifest and this writer never carried one —
  // the hermetic fake enforces no constraints, so only the live tier saw it.)
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(itemIds.join("\n")),
  );
  const checksum = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const { error } = await db.schema(scope).from("records_package").upsert({
    id, purpose: body.purpose, scope: exportScope, item_count: itemCount,
    records_package_manifest_id: `manifest_${id}`,
    records_package_checksum_chain: [{ seq: 1, items: itemCount, sha256: checksum }],
    build_started_at: isNonEmptyString(body.requested_at) ? body.requested_at : now.toISOString(),
    requested_at: isNonEmptyString(body.requested_at) ? body.requested_at : now.toISOString(),
    completed_at: now.toISOString(),
    delivered_at: isNonEmptyString(body.delivered_to) ? now.toISOString() : null,
    delivered_to: isNonEmptyString(body.delivered_to) ? body.delivered_to : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_done`, "records_package.completed",
    "records_package", id, {
      "exam.export.scope": exportScope, item_count: itemCount, purpose: body.purpose,
    }, ctx);
  if (isNonEmptyString(body.delivered_to)) {
    await emit(db, scope, `ev_${id}_deliv`, "exam.export.delivered",
      "records_package", id, {
        "exam.export.scope": exportScope, delivered_to: body.delivered_to,
        item_count: itemCount,
      }, ctx);
    await emit(db, scope, `ev_${id}_sup`, "supervisory.count_results.delivered",
      "records_package", id, { delivered_to: body.delivered_to }, ctx);
  }
  return jsonResponse({ data: { id, item_count: itemCount } }, 201, requestId);
}
