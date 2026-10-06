// The tail — EPS-01/03/06/10, IS-03/10/19, CP-08/09, DF-06/09, IC-02/04.
//
// See the migration header. IC-02 is the only genuinely new SHAPE in here:
// separation of duties is a PAIR constraint, checked at grant time and
// blocking, not a property of any single role that a quarterly review notices
// three months late.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor } from "./bsa.ts";
import {
  apiError, internalErrorResponse, isNonEmptyString, jsonResponse, notFoundResponse,
  parseJsonBody, validationError,
} from "./lib.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const DAY_MS = 24 * 60 * 60 * 1000;

/** IC-04: a reconciling item older than this is escalated, not just aged. */
export const RECON_ESCALATION_DAYS = 30;
/** EPS-03: how often the control review comes round. */
export const EPS_CONTROL_REVIEW_DAYS = 365;
/** EPS-03: remediation window by severity. */
export const EPS_REMEDIATION_DAYS: Record<string, number> = { high: 30, medium: 90, low: 180 };
/** EPS-10: the post-deployment retro. */
export const EPS_RETRO_DAYS = 14;
/** DF-09: an insider public-request disclosure is retained this long. */
export const INSIDER_PUBLIC_REQUEST_RETENTION_DAYS = 365 * 3;
/** DF-06: Reg-W style ceiling — one affiliate, 10% of capital and surplus. */
export const AFFILIATE_SINGLE_LIMIT_BP = 1000;

function requireInternalActor(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/internal");
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
  if (error) throw new Error(`tail event (${code}): ${error.message}`);
}

// ============================ IC-02 separation of duties ====================

/** POST /internal/sod-rules {role_a, role_b, conflict, rationale} */
export async function postSodRule(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.role_a) || !isNonEmptyString(body.role_b) ||
      body.role_a === body.role_b || !isNonEmptyString(body.rationale)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "role_b",
      message: "two DISTINCT roles and the risk rationale are required",
    }]);
  }
  const { data: prior } = await db.schema(scope).from("sod_rule").select("id");
  const version = (prior ?? []).length + 1;
  const id = `sod_${body.role_a}__${body.role_b}`;
  const { error } = await db.schema(scope).from("sod_rule").upsert({
    id, sod_matrix_version: version, role_a: body.role_a, role_b: body.role_b,
    sod_conflict: isNonEmptyString(body.conflict) ? body.conflict : "incompatible duties",
    sod_risk_rationale: body.rationale, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_matrix`, "authority.matrix.updated", "sod_rule", id, {
    "sod.matrix_version": version, "sod.conflict": body.conflict ?? "incompatible duties",
    "sod.risk_rationale": body.rationale,
  }, ctx);
  return jsonResponse({ data: { id, matrix_version: version } }, 201, requestId);
}

/**
 * POST /internal/role-grants {subject_ref, role_id, entitlements, compensating_control?}
 *
 * IC-02. The check runs HERE, at grant time, and BLOCKS. A quarterly review
 * that detects the conflict finds it has been live for three months, which is
 * three months of someone being able to both initiate and approve.
 */
export async function postRoleGrant(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.subject_ref) || !isNonEmptyString(body.role_id)) {
    return validationError(requestId, [{
      type: "missing_field", field: "role_id", message: "subject_ref and role_id are required",
    }]);
  }
  const { data: held } = await db.schema(scope).from("access_role_grant")
    .select("id, subject_ref, access_role_id, granted_at").eq("subject_ref", body.subject_ref);
  const heldRoles = (held ?? [])
    .filter((g: Any) => g.granted_at != null)
    .map((g: Any) => String(g.access_role_id));
  const { data: rules } = await db.schema(scope).from("sod_rule")
    .select("id, role_a, role_b, sod_conflict, sod_matrix_version");

  // THE PAIR CONSTRAINT. The conflict is not a property of the role being
  // granted; it is a property of the pair (new role, role already held).
  const conflict = (rules ?? []).find((r: Any) =>
    (r.role_a === body.role_id && heldRoles.includes(String(r.role_b))) ||
    (r.role_b === body.role_id && heldRoles.includes(String(r.role_a)))
  );
  const compensating = isNonEmptyString(body.compensating_control) &&
    isNonEmptyString(body.compensating_approved_by);
  const now = new Date();
  const id = `grant_${body.subject_ref}_${body.role_id}`;

  if (conflict) {
    const conflictWith = conflict.role_a === body.role_id ? conflict.role_b : conflict.role_a;
    const { error } = await db.schema(scope).from("access_role_grant").upsert({
      id, subject_ref: body.subject_ref, access_role_id: body.role_id,
      access_role_entitlements: (body.entitlements ?? []) as Any,
      // Accepted only WITH a compensating control, an approver and an expiry.
      // A permanent exception created by someone who has since left is the
      // failure this shape exists to prevent.
      granted_at: compensating ? now.toISOString() : null,
      blocked_at: compensating ? null : now.toISOString(),
      sod_check_result: "conflict", sod_conflict_with: String(conflictWith),
      sod_compensating_control: compensating ? body.compensating_control : null,
      compensating_approved_by: compensating ? body.compensating_approved_by : null,
      compensating_expires_at: compensating
        ? new Date(now.getTime() + 90 * DAY_MS).toISOString()
        : null,
      provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id" });
    if (error) return internalErrorResponse(requestId, error.message);

    const payload = {
      "sod.check_result": "conflict", "sod.conflict": conflict.sod_conflict,
      "sod.matrix_version": conflict.sod_matrix_version,
      "access.role_id": body.role_id,
      "access.role_entitlements": body.entitlements ?? [],
      "sod.compensating_control": body.compensating_control ?? null,
      "sod.risk_rationale": body.risk_rationale ?? null,
      conflicts_with: conflictWith,
    };
    await emit(db, scope, `ev_${id}_check`, "sod.check_result",
      "access_role_grant", id, payload, ctx);
    await emit(db, scope, `ev_${id}_conf`, "sod.conflict.detected",
      "access_role_grant", id, payload, ctx);
    await emit(db, scope, `ev_${id}_viol`, "sod.violation.logged",
      "access_role_grant", id, payload, ctx);
    if (compensating) {
      await emit(db, scope, `ev_${id}_comp`, "sod.compensating_control.approved",
        "access_role_grant", id, payload, ctx);
      return jsonResponse({
        data: { id, granted: true, conflict_with: conflictWith, compensated: true },
      }, 201, requestId);
    }
    await emit(db, scope, `ev_${id}_block`, "sod.grant.blocked",
      "access_role_grant", id, payload, ctx);
    return apiError(409, "sod_conflict", requestId, {
      title: "separation of duties conflict",
      detail: `${body.role_id} conflicts with ${conflictWith}, already held by ${body.subject_ref}`,
    });
  }

  const { error } = await db.schema(scope).from("access_role_grant").upsert({
    id, subject_ref: body.subject_ref, access_role_id: body.role_id,
    access_role_entitlements: (body.entitlements ?? []) as Any,
    granted_at: now.toISOString(), blocked_at: null,
    sod_check_result: "clear", sod_conflict_with: null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_check`, "sod.check_result", "access_role_grant", id, {
    "sod.check_result": "clear", "access.role_id": body.role_id,
    "access.role_entitlements": body.entitlements ?? [],
    "sod.matrix_version": (rules ?? []).length,
    "transaction.initiated_by": body.subject_ref, "transaction.type": "role_grant",
  }, ctx);
  return jsonResponse({ data: { id, granted: true } }, 201, requestId);
}

// ================================ IC-04 reconciliation =====================

/** POST /internal/recon-items {recon_ref, cadence, gl_balances, variance_cents, owner} */
export async function postReconItem(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.recon_ref) || !isNonEmptyString(body.owner)) {
    return validationError(requestId, [{
      type: "missing_field", field: "owner",
      message: "a reconciling item needs a reference and an owner",
    }]);
  }
  const age = typeof body.age_days === "number" ? body.age_days : 0;
  // IC-04's real control is AGE. A variance is not a problem on day one; a
  // variance nobody has closed in thirty days is a different fact entirely.
  const escalate = age >= RECON_ESCALATION_DAYS;
  if (escalate && !isNonEmptyString(body.research_notes)) {
    return validationError(requestId, [{
      type: "missing_field", field: "research_notes",
      message: "an item old enough to escalate must carry what was researched",
    }]);
  }
  const resolved = isNonEmptyString(body.resolution);
  const now = new Date();
  const id = `reconitem_${body.recon_ref}`;
  const { error } = await db.schema(scope).from("recon_item").upsert({
    id, recon_ref: body.recon_ref,
    cadence: body.cadence === "monthly" ? "monthly" : "daily",
    gl_balances: (body.gl_balances ?? {}) as Any,
    gl_trial_balance: (body.gl_trial_balance ?? null) as Any,
    variance_cents: typeof body.variance_cents === "number" ? body.variance_cents : 0,
    recon_item_owner: body.owner, recon_item_age_days: age,
    recon_research_notes: isNonEmptyString(body.research_notes) ? body.research_notes : null,
    escalated_at: escalate ? now.toISOString() : null,
    resolved_at: resolved ? now.toISOString() : null,
    resolution: resolved ? body.resolution : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "recon.item": body.recon_ref, "recon.item_age_days": age,
    "recon.item_owner": body.owner,
    "recon.research_notes": body.research_notes ?? null,
    "gl.balances": body.gl_balances ?? {},
    "gl.trial_balance": body.gl_trial_balance ?? {},
    "cash.recon": body.recon_ref,
  };
  await emit(db, scope, `ev_${id}_item`, "recon.item", "recon_item", id, payload, ctx);
  await emit(db, scope, `ev_${id}_cadence`,
    body.cadence === "monthly" ? "recon.monthly.completed" : "recon.daily.completed",
    "recon_item", id, payload, ctx);
  if (escalate) {
    await emit(db, scope, `ev_${id}_esc`, "recon.item.escalated", "recon_item", id, {
      ...payload, threshold_days: RECON_ESCALATION_DAYS,
    }, ctx);
  }
  if (resolved) {
    await emit(db, scope, `ev_${id}_res`, "recon.item.resolved", "recon_item", id, {
      ...payload, resolution: body.resolution,
    }, ctx);
  }
  return jsonResponse({ data: { id, escalated: escalate } }, 201, requestId);
}

// ================================== IS-03 assets ===========================

/** POST /internal/assets {id, owner, classification, media_type, attest?} */
export async function postItAsset(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const classes = ["public", "internal", "confidential", "restricted"];
  if (!isNonEmptyString(body.owner) || !classes.includes(String(body.classification))) {
    // IS-03 is an OWNERSHIP control, not an inventory one. An asset with no
    // named owner has nobody to attest to it.
    return validationError(requestId, [{
      type: "invalid_value", field: "owner",
      message: `an owner and a classification in ${classes.join("/")} are required`,
    }]);
  }
  const attest = body.attest === true;
  if (attest && !isNonEmptyString(body.attested_by)) {
    return validationError(requestId, [{
      type: "missing_field", field: "attested_by",
      message: "an attestation is somebody's statement, and needs their name",
    }]);
  }
  const now = new Date();
  const id = `asset_${body.asset_id ?? crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("it_asset").upsert({
    id, asset_owner: body.owner, asset_classification: body.classification,
    asset_media_type: isNonEmptyString(body.media_type) ? body.media_type : "virtual",
    asset_attributes: (body.attributes ?? {}) as Any,
    asset_cmdb_snapshot: (body.cmdb_snapshot ?? null) as Any,
    attested_at: attest ? now.toISOString() : null,
    attested_by: attest ? body.attested_by : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "asset.owner": body.owner, "asset.classification": body.classification,
    "asset.media_type": body.media_type ?? "virtual",
    "asset.attributes": body.attributes ?? {},
    "asset.cmdb_snapshot": body.cmdb_snapshot ?? {},
    "asset.owner_roster": body.owner_roster ?? [body.owner],
  };
  await emit(db, scope, `ev_${id}_cmdb`, "asset.cmdb.updated", "it_asset", id, payload, ctx);
  if (attest) {
    await emit(db, scope, `ev_${id}_att`, "asset.attestation.completed", "it_asset", id, {
      ...payload, attested_by: body.attested_by,
    }, ctx);
  }
  return jsonResponse({ data: { id, attested: attest } }, 201, requestId);
}

// ================================ IS-10 red flags ==========================

/** POST /internal/redflag-cases {account_id, type, stepup_required?, disposition?} */
export async function postRedflagCase(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.type)) {
    return validationError(requestId, [{
      type: "missing_field", field: "type", message: "a red flag has a type",
    }]);
  }
  const stepupRequired = body.stepup_required === true;
  const stepupDone = body.stepup_completed === true;
  const disposing = isNonEmptyString(body.disposition);
  if (disposing && stepupRequired && !stepupDone) {
    // A required step-up that never happened means an unverified member
    // proceeded as a verified one, and closing the case hides it.
    return apiError(409, "stepup_incomplete", requestId, {
      title: "cannot dispose a case whose step-up verification never completed",
      detail: "the member was never re-verified; disposing closes the finding without the fact",
    });
  }
  const now = new Date();
  const id = `rfcase_${body.account_id ?? "na"}_${body.type}`;
  const { error } = await db.schema(scope).from("redflag_case").upsert({
    id, account_id: isNonEmptyString(body.account_id) ? body.account_id : null,
    redflag_type: body.type,
    redflag_address_reissue_match: body.address_reissue_match === true,
    redflag_stepup_required: stepupRequired,
    stepup_completed_at: stepupDone ? now.toISOString() : null,
    disposed_at: disposing ? now.toISOString() : null,
    disposition: disposing ? body.disposition : null,
    sar_filing_id: isNonEmptyString(body.sar_filing_id) ? body.sar_filing_id : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "account.id": body.account_id ?? null, "redflag.type": body.type,
    "redflag.address_reissue_match": body.address_reissue_match === true,
    "redflag.stepup_required": stepupRequired,
    "sar.filing_id": body.sar_filing_id ?? null,
  };
  await emit(db, scope, `ev_${id}_det`, "redflag.detected", "redflag_case", id, payload, ctx);
  if (stepupDone) {
    await emit(db, scope, `ev_${id}_step`, "redflag.stepup.completed",
      "redflag_case", id, payload, ctx);
  }
  if (disposing) {
    await emit(db, scope, `ev_${id}_disp`, "redflag.case.disposed", "redflag_case", id, {
      ...payload, disposition: body.disposition,
    }, ctx);
  }
  if (isNonEmptyString(body.sar_filing_id)) {
    await emit(db, scope, `ev_${id}_sar`, "sar.filed", "redflag_case", id, payload, ctx);
  }
  return jsonResponse({ data: { id, disposed: disposing } }, 201, requestId);
}

/** POST /internal/redflag-ruleset {ruleset, pattern_updates} — IS-10's feedback loop. */
export async function postRedflagRuleset(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: cases } = await db.schema(scope).from("redflag_case")
    .select("id, redflag_type, disposed_at, disposition");
  const all = cases ?? [];
  const { data: prior } = await db.schema(scope).from("redflag_ruleset").select("id");
  const version = (prior ?? []).length + 1;
  // The loop that makes IS-10 a control rather than a log: what the disposed
  // cases actually looked like feeds the next ruleset. A detection ruleset that
  // never learns from its own dispositions detects last year's fraud.
  const stats = {
    total: all.length,
    disposed: all.filter((c: Any) => c.disposed_at != null).length,
    by_type: all.reduce((acc: Any, c: Any) => {
      acc[String(c.redflag_type)] = (acc[String(c.redflag_type)] ?? 0) + 1;
      return acc;
    }, {} as Any),
  };
  const now = new Date();
  const id = `rfrules_v${version}`;
  const { error } = await db.schema(scope).from("redflag_ruleset").upsert({
    id, version, redflag_ruleset: (body.ruleset ?? {}) as Any,
    redflag_pattern_updates: (body.pattern_updates ?? []) as Any,
    redflag_case_stats: stats as Any, updated_at: now.toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_upd`, "redflag.ruleset.updated", "redflag_ruleset", id, {
    "redflag.ruleset": body.ruleset ?? {},
    "redflag.pattern_updates": body.pattern_updates ?? [],
    "redflag.case_stats": stats, version,
  }, ctx);
  return jsonResponse({ data: { id, version, stats } }, 201, requestId);
}

// ============================== CP-08 / CP-09 capital actions ==============

/** POST /capital/actions {position_id, action_type, amount_cents, ...} */
export async function postCapitalAction(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const types = ["retained_earnings", "subordinated_debt", "asset_sale", "distribution",
    "growth_restriction", "secondary_capital"];
  if (!types.includes(String(body.action_type)) || !isNonEmptyString(body.position_id)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "action_type",
      message: `position_id and an action_type in ${types.join("/")} are required`,
    }]);
  }
  const preapprovalStatus = isNonEmptyString(body.regulatory_preapproval_status)
    ? String(body.regulatory_preapproval_status)
    : "not_required";
  // CP-09: the distribution restriction is a FACT of the capital position,
  // set when the position was classified (capital.ts). Before 2026-10-06 it was
  // read from the request body, so a caller who simply did not mention it
  // executed a distribution on an undercapitalized position. The body may only
  // ADD a restriction, never lift the one the position carries.
  const { data: position, error: posErr } = await db.schema(scope).from("capital_position")
    .select("id, distribution_restricted").eq("id", String(body.position_id)).maybeSingle();
  if (posErr) return internalErrorResponse(requestId, posErr.message);
  if (!position) return notFoundResponse(requestId, "capital_position", String(body.position_id));
  const restricted = (position as Any).distribution_restricted === true ||
    body.distribution_restriction === true;
  const executing = body.execute === true;

  if (executing && !["not_required", "granted"].includes(preapprovalStatus)) {
    // CP-09: some capital actions need the regulator's blessing BEFORE they
    // happen. Executing on a pending preapproval is the violation, not a lag.
    return apiError(409, "preapproval_not_granted", requestId, {
      title: "capital action executed ahead of regulatory preapproval",
      detail: `preapproval is ${preapprovalStatus}; the action cannot be executed`,
    });
  }
  if (executing && body.action_type === "distribution" && restricted) {
    return apiError(409, "distribution_restricted", requestId, {
      title: "distribution while distributions are restricted",
      detail: "the restriction exists for exactly this action",
    });
  }
  if (executing && !isNonEmptyString(body.board_resolution_id)) {
    return validationError(requestId, [{
      type: "missing_field", field: "board_resolution_id",
      message: "an executed capital action needs the board resolution behind it",
    }]);
  }
  const now = new Date();
  const actionId = `capact_${body.position_id}_${body.action_type}`;
  const contingencyId = `cont_${actionId}`;
  const { error } = await db.schema(scope).from("capital_action").upsert({
    id: actionId, position_id: body.position_id,
    capital_contingency_action_id: contingencyId,
    capital_action_analysis_id: isNonEmptyString(body.action_analysis_id)
      ? body.action_analysis_id
      : `analysis_${actionId}`,
    capital_action_type: body.action_type,
    capital_action_amount_cents: Number(body.amount_cents ?? 0),
    capital_expected_capital_impact_cents: Number(body.expected_capital_impact_cents ?? 0),
    capital_projected_shortfall_cents: typeof body.projected_shortfall_cents === "number"
      ? body.projected_shortfall_cents
      : null,
    capital_projection_below_target: typeof body.projection_below_target === "boolean"
      ? body.projection_below_target
      : null,
    capital_projection_below_well_capitalized:
      typeof body.projection_below_well_capitalized === "boolean"
        ? body.projection_below_well_capitalized
        : null,
    capital_subordinated_debt_cents: typeof body.subordinated_debt_cents === "number"
      ? body.subordinated_debt_cents
      : null,
    capital_instrument_terms: (body.instrument_terms ?? null) as Any,
    capital_eligible_retained_income_cents:
      typeof body.eligible_retained_income_cents === "number"
        ? body.eligible_retained_income_cents
        : null,
    capital_proposed_distribution_amount_cents:
      typeof body.proposed_distribution_amount_cents === "number"
        ? body.proposed_distribution_amount_cents
        : null,
    capital_distribution_restriction: restricted,
    capital_regulatory_preapproval_id: isNonEmptyString(body.regulatory_preapproval_id)
      ? body.regulatory_preapproval_id
      : null,
    capital_regulatory_preapproval_status: preapprovalStatus,
    capital_board_resolution_id: isNonEmptyString(body.board_resolution_id)
      ? body.board_resolution_id
      : null,
    proposed_at: now.toISOString(),
    board_decided_at: isNonEmptyString(body.board_resolution_id) ? now.toISOString() : null,
    executed_at: executing ? now.toISOString() : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "capital.contingency_action_id": contingencyId,
    "capital.action_analysis_id": body.action_analysis_id ?? `analysis_${actionId}`,
    "capital.action_type": body.action_type,
    "capital.action_amount": body.amount_cents ?? 0,
    "capital.expected_capital_impact": body.expected_capital_impact_cents ?? 0,
    "capital.projected_shortfall": body.projected_shortfall_cents ?? null,
    "capital.projection_below_target": body.projection_below_target ?? null,
    "capital.projection_below_well_capitalized": body.projection_below_well_capitalized ?? null,
    "capital.subordinated_debt": body.subordinated_debt_cents ?? null,
    "capital.instrument_terms": body.instrument_terms ?? null,
    "capital.eligible_retained_income": body.eligible_retained_income_cents ?? null,
    "capital.proposed_distribution_amount": body.proposed_distribution_amount_cents ?? null,
    "capital.distribution_restriction": restricted,
    "capital.regulatory_preapproval_id": body.regulatory_preapproval_id ?? null,
    "capital.regulatory_preapproval_status": preapprovalStatus,
    "capital.board_resolution_id": body.board_resolution_id ?? null,
  };
  // The three events capital.ts already emitted with EMPTY payloads now carry
  // the action they are about. See the migration header.
  await emit(db, scope, `ev_${actionId}_contid`, "capital.contingency_action_id",
    "capital_action", actionId, payload, ctx);
  await emit(db, scope, `ev_${actionId}_preid`, "capital.regulatory_preapproval_id",
    "capital_action", actionId, payload, ctx);
  await emit(db, scope, `ev_${actionId}_prop`, "capital.action.proposed",
    "capital_action", actionId, payload, ctx);
  if (isNonEmptyString(body.board_resolution_id)) {
    await emit(db, scope, `ev_${actionId}_board`, "capital.action_board.decided",
      "capital_action", actionId, payload, ctx);
  }
  if (executing) {
    await emit(db, scope, `ev_${actionId}_exec`, "capital.action.executed",
      "capital_action", actionId, payload, ctx);
    await emit(db, scope, `ev_${actionId}_contexec`, "capital.contingency_action.executed",
      "capital_action", actionId, payload, ctx);
    await emit(db, scope, `ev_${actionId}_memo`, "capital.contingency_memo.issued",
      "capital_action", actionId, payload, ctx);
  }
  return jsonResponse({ data: { id: actionId, executed: executing } }, 201, requestId);
}

// ================================ DF-06 / DF-09 ============================

/** POST /governance/affiliates {list_entry, relationship} */
export async function postAffiliate(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.list_entry)) {
    return validationError(requestId, [{
      type: "missing_field", field: "list_entry", message: "is required",
    }]);
  }
  const now = new Date();
  const id = `aff_${body.list_entry}`;
  const { error } = await db.schema(scope).from("affiliate").upsert({
    id, affiliate_list_entry: body.list_entry,
    relationship: isNonEmptyString(body.relationship) ? body.relationship : "affiliate",
    list_updated_at: now.toISOString(), provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_list`, "affiliate.list.updated", "affiliate", id, {
    "affiliate.list_entry": body.list_entry, "affiliate.list": [body.list_entry],
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/** POST /governance/affiliates/:id/transactions {type, amount_cents, capital_cents, ...} */
export async function postAffiliateTransaction(
  req: Request, affiliateId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: aff } = await db.schema(scope).from("affiliate")
    .select("id, affiliate_list_entry").eq("id", affiliateId).maybeSingle();
  if (!aff) return notFoundResponse(requestId, "affiliate", affiliateId);

  const capital = Number(body.capital_surplus_cents ?? 0);
  const amount = Number(body.amount_cents ?? 0);
  if (!(capital > 0)) {
    // A limit expressed as a percentage of capital cannot be checked without
    // capital. Refused rather than defaulted, because a default here is a
    // limit nobody set.
    return validationError(requestId, [{
      type: "missing_field", field: "capital_surplus_cents",
      message: "the affiliate limit is a share of capital and surplus",
    }]);
  }
  // DF-06: the limit is on the affiliate's AGGREGATE exposure, not on each
  // transaction alone. Before 2026-10-06 every transaction was checked by
  // itself and rows were keyed afftx_<affiliate>_<type>, so a second credit
  // both passed the check and overwrote the first — exposure was never
  // limited. Every funded transaction already on file counts.
  const txType = String(body.type ?? "credit");
  const { data: priorTx, error: priorErr } = await db.schema(scope).from("affiliate_transaction")
    .select("id, affiliate_transaction_type, affiliate_transaction_amount_cents, funded_at")
    .eq("affiliate_id", affiliateId);
  if (priorErr) return internalErrorResponse(requestId, priorErr.message);
  const prior = (priorTx ?? []) as unknown as Array<Record<string, unknown>>;
  const fundedCents = prior
    .filter((t) => t.funded_at != null)
    .reduce((sum, t) => sum + Number(t.affiliate_transaction_amount_cents ?? 0), 0);
  const exposure = fundedCents + amount;
  const utilisationBp = Math.round((exposure / capital) * 10000);
  const withinLimits = utilisationBp <= AFFILIATE_SINGLE_LIMIT_BP;
  const screened = body.lqa_screened === true;
  const funding = body.fund === true;

  if (funding && !withinLimits) {
    return apiError(409, "affiliate_limit_exceeded", requestId, {
      title: "affiliate transaction over the limit",
      detail: `aggregate exposure ${utilisationBp}bp of capital and surplus ` +
        `(${fundedCents} cents already funded + ${amount} new) exceeds ${AFFILIATE_SINGLE_LIMIT_BP}bp`,
    });
  }
  if (funding && !screened) {
    // Unscreened is not the same as screened-and-clean.
    return apiError(409, "lqa_screen_missing", requestId, {
      title: "funding without a low-quality-asset screen",
      detail: "an unscreened affiliate transaction cannot be funded",
    });
  }
  const now = new Date();
  // Each transaction is its own record. The first of a type keeps the
  // historical id (afftx_<affiliate>_<type>); later ones take a sequence
  // suffix. INSERT, not upsert: a concurrent writer that picked the same
  // sequence fails loudly instead of overwriting a funded credit.
  const seq = prior.filter((t) => String(t.affiliate_transaction_type) === txType).length + 1;
  const baseId = `afftx_${affiliateId}_${txType}`;
  const id = seq === 1 ? baseId : `${baseId}_${seq}`;
  const { error } = await db.schema(scope).from("affiliate_transaction").insert({
    id, affiliate_id: affiliateId,
    affiliate_transaction_type: txType,
    affiliate_transaction_amount_cents: amount,
    cu_unimpaired_capital_surplus_cents: capital,
    affiliate_limit_utilization_bp: utilisationBp,
    affiliate_collateral_type: isNonEmptyString(body.collateral_type)
      ? body.collateral_type
      : null,
    affiliate_collateral_value_cents: typeof body.collateral_value_cents === "number"
      ? body.collateral_value_cents
      : null,
    affiliate_required_coverage_ratio_bp: typeof body.required_coverage_ratio_bp === "number"
      ? body.required_coverage_ratio_bp
      : null,
    affiliate_market_terms_basis: isNonEmptyString(body.market_terms_basis)
      ? body.market_terms_basis
      : null,
    affiliate_asset_quality_classification: isNonEmptyString(body.asset_quality_classification)
      ? body.asset_quality_classification
      : null,
    affiliate_independent_evaluation: isNonEmptyString(body.independent_evaluation)
      ? body.independent_evaluation
      : null,
    limits_checked_at: now.toISOString(),
    lqa_screen_at: screened ? now.toISOString() : null,
    within_limits: withinLimits,
    funded_at: funding ? now.toISOString() : null,
    file_archived_at: funding ? now.toISOString() : null,
    provenance: provenanceFor(scope, ctx),
  });
  if (error) {
    if ((error as Any).code === "23505") {
      return apiError(409, "concurrent_affiliate_transaction", requestId, {
        title: "another transaction for this affiliate was recorded concurrently",
        detail: "retry: the aggregate limit must be re-checked against it",
      });
    }
    return internalErrorResponse(requestId, error.message);
  }

  const payload = {
    "affiliate.transaction_type": txType,
    "affiliate.transaction_amount": amount,
    "cu.unimpaired_capital_surplus": capital,
    "affiliate.limit_utilization": utilisationBp,
    "affiliate.list_entry": aff.affiliate_list_entry,
    "affiliate.collateral_type": body.collateral_type ?? null,
    "affiliate.collateral_value": body.collateral_value_cents ?? null,
    "affiliate.required_coverage_ratio": body.required_coverage_ratio_bp ?? null,
    "affiliate.market_terms_basis": body.market_terms_basis ?? null,
    "affiliate.asset_quality_classification": body.asset_quality_classification ?? null,
    "affiliate.independent_evaluation": body.independent_evaluation ?? null,
    "affiliate.list": [aff.affiliate_list_entry],
    within_limits: withinLimits,
    aggregate_funded_cents: fundedCents,
  };
  await emit(db, scope, `ev_${id}_lim`, "affiliate.limits.checked",
    "affiliate_transaction", id, payload, ctx);
  await emit(db, scope, `ev_${id}_rec`, "affiliate.transaction.recorded",
    "affiliate_transaction", id, payload, ctx);
  if (screened) {
    await emit(db, scope, `ev_${id}_lqa`, "affiliate.lqa_screen.logged",
      "affiliate_transaction", id, payload, ctx);
  }
  if (funding) {
    await emit(db, scope, `ev_${id}_arch`, "affiliate.transaction_file.archived",
      "affiliate_transaction", id, payload, ctx);
  }
  return jsonResponse({
    data: { id, within_limits: withinLimits, utilisation_bp: utilisationBp },
  }, 201, requestId);
}

/** POST /governance/insiders/:id/public-request {capital_surplus_cents} — DF-09. */
export async function postInsiderPublicRequest(
  req: Request, insiderId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const now = new Date();
  const retentionExpires = new Date(
    now.getTime() + INSIDER_PUBLIC_REQUEST_RETENTION_DAYS * DAY_MS,
  ).toISOString();
  const { error } = await db.schema(scope).from("insider").update({
    insider_correspondent_credit_data: (body.correspondent_credit_data ?? {}) as Any,
    public_request_at: now.toISOString(),
    public_disclosure_issued_at: now.toISOString(),
    public_request_retention_expires_at: retentionExpires,
  }).eq("id", insiderId);
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "insider.public_request": true,
    "cu.unimpaired_capital_surplus": body.capital_surplus_cents ?? 0,
    "insider.correspondent_credit_data": body.correspondent_credit_data ?? {},
  };
  // A public request is answered AND the answer is retained: the disclosure and
  // its retention clock are the same obligation, and Reg O's is three years.
  await emit(db, scope, `ev_${insiderId}_pubdisc`, "insider.public_disclosure.issued",
    "insider", insiderId, payload, ctx);
  await emit(db, scope, `ev_${insiderId}_pubret`,
    "insider.public_request.retention.expires_at", "insider", insiderId, {
      ...payload, expires_at: retentionExpires,
    }, ctx);
  return jsonResponse({ data: { insider_id: insiderId, retention_expires_at: retentionExpires } }, 201, requestId);
}

// ==================================== EPS ==================================

/** POST /eps/proposals {service_id, sponsor, study_doc, ...} — EPS-01. */
export async function postEpsProposal(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.service_id) || !isNonEmptyString(body.sponsor)) {
    return validationError(requestId, [{
      type: "missing_field", field: "sponsor",
      message: "a proposal needs a service and a sponsor who owns it",
    }]);
  }
  const analysed = body.risk_analysis_drafted !== false;
  const decision = ["approved", "rejected"].includes(String(body.erm_decision))
    ? String(body.erm_decision)
    : null;
  const activating = body.activate === true;

  if (decision && !analysed) {
    // ERM cannot review what was never analysed.
    return apiError(409, "erm_review_without_analysis", requestId, {
      title: "ERM review before the product risk analysis",
      detail: "the analysis is what ERM is reviewing",
    });
  }
  if (activating && decision !== "approved") {
    // A new payment service live before ERM reviewed it is the whole reason
    // EPS-01 exists. The gate is the ACTIVATION, not the paperwork.
    return apiError(409, "activation_before_erm", requestId, {
      title: "payment service activated before ERM approval",
      detail: `ERM decision is ${decision ?? "not made"}; the service cannot go live`,
    });
  }
  if (decision && !isNonEmptyString(body.erm_reviewed_by)) {
    return validationError(requestId, [{
      type: "missing_field", field: "erm_reviewed_by",
      message: "an ERM decision needs the reviewer who made it",
    }]);
  }
  const now = new Date();
  const id = `epsprop_${body.service_id}`;
  const { error } = await db.schema(scope).from("eps_proposal").upsert({
    id, eps_service_id: body.service_id, eps_proposal_sponsor: body.sponsor,
    eps_proposal_study_doc: isNonEmptyString(body.study_doc) ? body.study_doc : null,
    eps_proposal_design_docs: (body.design_docs ?? []) as Any,
    risk_inherent_score: typeof body.inherent_score === "number" ? body.inherent_score : null,
    eps_risk_assessment_delta: (body.risk_assessment_delta ?? null) as Any,
    product_risk_analysis_at: analysed ? now.toISOString() : null,
    erm_review_decision: decision,
    erm_reviewed_by: decision ? body.erm_reviewed_by : null,
    activated_at: activating ? now.toISOString() : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "eps.service.id": body.service_id, "eps.proposal.sponsor": body.sponsor,
    "eps.proposal.study_doc": body.study_doc ?? null,
    "eps.proposal.design_docs": body.design_docs ?? [],
    "risk.inherent_score": body.inherent_score ?? null,
    "eps.risk_assessment.delta": body.risk_assessment_delta ?? null,
  };
  // `core.risk` is an abandoned table. A new payment service adds to the
  // ENTERPRISE risk register or the register does not describe the enterprise;
  // the inherent score belongs there, not only on the proposal.
  if (typeof body.inherent_score === "number") {
    const { error: rErr } = await db.schema(scope).from("risk").upsert({
      id: `risk_eps_${body.service_id}`, service_ref: body.service_id,
      inherent_score: body.inherent_score,
      inherent_rating: body.inherent_score >= 7 ? "high" : "moderate",
      owner_id: body.sponsor, last_assessed_at: now.toISOString(),
      provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id" });
    if (rErr) return internalErrorResponse(requestId, rErr.message);
  }
  await emit(db, scope, `ev_${id}_sub`, "eps.proposal.submitted", "eps_proposal", id, payload, ctx);
  if (analysed) {
    await emit(db, scope, `ev_${id}_ana`, "eps.product_risk_analysis.drafted",
      "eps_proposal", id, payload, ctx);
    await emit(db, scope, `ev_${id}_added`, "eps.risk_assessment_service.added",
      "eps_proposal", id, payload, ctx);
  }
  if (decision) {
    await emit(db, scope, `ev_${id}_erm`, "eps.erm_review.decided", "eps_proposal", id, {
      ...payload, decision, reviewed_by: body.erm_reviewed_by,
    }, ctx);
  }
  if (activating) {
    await emit(db, scope, `ev_${id}_act`, "eps.service.activated", "eps_proposal", id, payload, ctx);
  }
  return jsonResponse({ data: { id, activated: activating } }, 201, requestId);
}

/** POST /eps/control-reviews {service_id, checklist, deficiency_found, ...} — EPS-03. */
export async function postEpsControlReview(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (body.checklist == null || !isNonEmptyString(body.service_id)) {
    return validationError(requestId, [{
      type: "missing_field", field: "checklist",
      message: "a review is against a checklist; without one it is an opinion",
    }]);
  }
  const found = body.deficiency_found === true;
  const rating = ["low", "medium", "high"].includes(String(body.rating))
    ? String(body.rating)
    : null;
  if (found && !(isNonEmptyString(body.description) && rating)) {
    // An unprioritised deficiency is one that never gets scheduled.
    return validationError(requestId, [{
      type: "missing_field", field: "rating",
      message: "a found deficiency needs a description and a rating",
    }]);
  }
  const now = new Date();
  const completing = body.complete !== false;
  const remediationDue = found
    ? new Date(now.getTime() + EPS_REMEDIATION_DAYS[rating!] * DAY_MS).toISOString()
    : null;
  const id = `epsrev_${body.service_id}`;
  const { error } = await db.schema(scope).from("eps_control_review").upsert({
    id, eps_service_id: body.service_id,
    eps_control_review_checklist: body.checklist as Any,
    eps_control_review_prior_findings: (body.prior_findings ?? []) as Any,
    eps_control_review_deficiency_found: found,
    eps_deficiency_description: found ? body.description : null,
    eps_deficiency_rating: rating,
    review_due_at: new Date(now.getTime() + EPS_CONTROL_REVIEW_DAYS * DAY_MS).toISOString(),
    opened_at: now.toISOString(),
    completed_at: completing ? now.toISOString() : null,
    remediation_due_at: remediationDue,
    remediation_opened_at: found ? now.toISOString() : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "eps.control_review.checklist": body.checklist,
    "eps.control_review.prior_findings": body.prior_findings ?? [],
    "eps.control_review.deficiency_found": found,
    "eps.deficiency.description": found ? body.description : null,
    "eps.deficiency.rating": rating,
  };
  await emit(db, scope, `ev_${id}_open`, "eps.control_review.opened",
    "eps_control_review", id, payload, ctx);
  await emit(db, scope, `ev_${id}_due`, "eps.control.review.due_at",
    "eps_control_review", id, {
      due_at: new Date(now.getTime() + EPS_CONTROL_REVIEW_DAYS * DAY_MS).toISOString(),
    }, ctx);
  if (completing) {
    await emit(db, scope, `ev_${id}_done`, "eps.control_review.completed",
      "eps_control_review", id, payload, ctx);
  }
  if (found) {
    // A review that finds and does nothing documented the problem for the next
    // reviewer. Remediation opens in the same write.
    await emit(db, scope, `ev_${id}_defdesc`, "eps.deficiency.description",
      "eps_control_review", id, payload, ctx);
    await emit(db, scope, `ev_${id}_defrate`, "eps.deficiency.rating",
      "eps_control_review", id, payload, ctx);
    await emit(db, scope, `ev_${id}_deflist`, "eps.deficiency.open_list",
      "eps_control_review", id, { ...payload, open: [body.description] }, ctx);
    await emit(db, scope, `ev_${id}_remdue`, "eps.deficiency.remediation.due_at",
      "eps_control_review", id, { ...payload, due_at: remediationDue }, ctx);
    await emit(db, scope, `ev_${id}_remopen`, "eps.deficiency_remediation.opened",
      "eps_control_review", id, payload, ctx);
  }
  return jsonResponse({ data: { id, deficiency_found: found } }, 201, requestId);
}

/** POST /eps/deployments {service_id, test_plan, rollback_plan, ...} — EPS-10. */
export async function postEpsDeployment(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.rollback_plan)) {
    // A deployment that cannot be undone is the one you most need to undo.
    return validationError(requestId, [{
      type: "missing_field", field: "rollback_plan",
      message: "a deployment with no rollback plan cannot be reversed",
    }]);
  }
  const emergency = body.emergency === true;
  if (emergency && !isNonEmptyString(body.exception_approval)) {
    // The emergency path needs MORE, not less: it is the path where the normal
    // checks were skipped, so the approval IS the record of who chose that.
    return apiError(409, "emergency_exception_unapproved", requestId, {
      title: "emergency deployment with no exception approval",
      detail: "the emergency path skips the normal gates; somebody has to own that",
    });
  }
  const defects = Array.isArray(body.defects) ? body.defects : [];
  if (defects.length > 0 && !isNonEmptyString(body.risk_acceptance)) {
    // Known defects shipped anyway is a decision somebody has to own.
    return validationError(requestId, [{
      type: "missing_field", field: "risk_acceptance",
      message: "shipping with known defects requires a recorded risk acceptance",
    }]);
  }
  const now = new Date();
  const retroDue = new Date(now.getTime() + EPS_RETRO_DAYS * DAY_MS).toISOString();
  const id = `epsdep_${body.service_id ?? "svc"}`;
  const { error } = await db.schema(scope).from("eps_deployment").upsert({
    id, eps_service_id: String(body.service_id ?? "svc"),
    eps_test_plan: isNonEmptyString(body.test_plan) ? body.test_plan : null,
    eps_test_interop_scope: (body.interop_scope ?? {}) as Any,
    eps_vendor_test_participation: body.vendor_participated === true,
    eps_test_results: (body.results ?? null) as Any,
    eps_test_defects: defects as Any,
    eps_test_risk_acceptance: isNonEmptyString(body.risk_acceptance)
      ? body.risk_acceptance
      : null,
    eps_change_rollback_plan: body.rollback_plan,
    eps_change_exception_approval: isNonEmptyString(body.exception_approval)
      ? body.exception_approval
      : null,
    emergency_exception: emergency,
    scheduled_at: now.toISOString(), retro_due_at: retroDue,
    retro_completed_at: body.retro_completed === true ? now.toISOString() : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "eps.service.id": body.service_id ?? "svc",
    "eps.test.plan": body.test_plan ?? null,
    "eps.test.interop_scope": body.interop_scope ?? {},
    "eps.vendor.test_participation": body.vendor_participated === true,
    "eps.test.results": body.results ?? null,
    "eps.test.defects": defects,
    "eps.test.risk_acceptance": body.risk_acceptance ?? null,
    "eps.change.rollback_plan": body.rollback_plan,
    "eps.change.exception_approval": body.exception_approval ?? null,
  };
  await emit(db, scope, `ev_${id}_sched`, "eps.deployment.scheduled",
    "eps_deployment", id, payload, ctx);
  await emit(db, scope, `ev_${id}_plan`, "eps.test.plan", "eps_deployment", id, payload, ctx);
  await emit(db, scope, `ev_${id}_res`, "eps.test_results.recorded",
    "eps_deployment", id, payload, ctx);
  await emit(db, scope, `ev_${id}_retrodue`, "eps.test.retro_due_at",
    "eps_deployment", id, { ...payload, due_at: retroDue }, ctx);
  if (body.retro_completed === true) {
    await emit(db, scope, `ev_${id}_retro`, "eps.test_retro.completed",
      "eps_deployment", id, payload, ctx);
  }
  if (emergency) {
    await emit(db, scope, `ev_${id}_emerg`, "eps.deployment.emergency_exception",
      "eps_deployment", id, payload, ctx);
  }
  return jsonResponse({ data: { id, emergency } }, 201, requestId);
}

/** POST /eps/wire-releases {wire_ref, originator_id, pin, ip} — EPS-06. */
export async function postWireRelease(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.wire_ref) || !isNonEmptyString(body.originator_id)) {
    return validationError(requestId, [{
      type: "missing_field", field: "originator_id",
      message: "a release names the wire and who released it",
    }]);
  }
  const pinOk = body.pin_verified === true;
  const allowlist = Array.isArray(body.ip_allowlist) ? body.ip_allowlist as string[] : [];
  // UNKNOWN IS NOT PERMISSION: with no allowlist configured the answer is NULL,
  // and a null cannot satisfy the release constraint.
  const ipAllowlisted = allowlist.length === 0
    ? null
    : allowlist.includes(String(body.ip ?? ""));
  const second = isNonEmptyString(body.second_approval) ? body.second_approval : null;
  // EPS-06 dual control. A second approval is only a second pair of eyes if it
  // is NOT the originator's: neither the originator naming themselves as the
  // second approver, nor the originator's own credential submitting the
  // release (the caller is bound to the approval it submits, as the wire
  // approve route does with ctx.tokenId). Before 2026-10-06 any non-empty
  // second_approval released the wire, including the originator's own id.
  const originator = String(body.originator_id);
  if (second !== null && (second === originator || ctx.tokenId === originator)) {
    return apiError(409, "dual_control_violation", requestId, {
      title: "wire released by its own originator",
      detail: "the second approver must be a different person from the originator",
    });
  }
  const releasable = pinOk && ipAllowlisted === true && second !== null;

  const now = new Date();
  const id = `wrel_${body.wire_ref}`;
  const { error } = await db.schema(scope).from("wire_release").upsert({
    id, wire_ref: body.wire_ref, eps_wire_originator_id: body.originator_id,
    eps_wire_release_pin_verified: pinOk,
    eps_wire_ip: isNonEmptyString(body.ip) ? body.ip : null,
    eps_wire_ip_allowlisted: ipAllowlisted,
    eps_wire_second_approval: second,
    requested_at: now.toISOString(),
    released_at: releasable ? now.toISOString() : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "eps.wire.originator_id": body.originator_id,
    "eps.wire.release_pin": pinOk, "eps.wire_ip": body.ip ?? null,
    "eps.wire.second_approval": second,
    "wire_transfer.amount": body.amount_cents ?? 0,
    "wire_transfer.beneficiary": body.beneficiary ?? null,
    ip_allowlisted: ipAllowlisted,
  };
  await emit(db, scope, `ev_${id}_req`, "eps.wire_release.requested",
    "wire_release", id, payload, ctx);
  if (ipAllowlisted === true) {
    await emit(db, scope, `ev_${id}_ip`, "eps.wire_ip.verified",
      "wire_release", id, payload, ctx);
  }
  return jsonResponse({ data: { id, released: releasable, ip_allowlisted: ipAllowlisted } }, 201, requestId);
}

/** POST /eps/ach-control-results {transfer_ref, amount_cents, checks} — EPS-06. */
export async function postAchControlResults(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const checks = (body.checks ?? {}) as Record<string, boolean>;
  if (Object.keys(checks).length === 0) {
    // "Passed" with no per-check result is one boolean standing in for five,
    // and it cannot say which check would have caught what got through.
    return validationError(requestId, [{
      type: "missing_field", field: "checks",
      message: "the individual control results are the evidence, not the verdict",
    }]);
  }
  const passed = Object.values(checks).every((v) => v === true);
  const id = `achres_${body.transfer_ref ?? "tx"}`;
  const { error } = await db.schema(scope).from("ach_control_result").upsert({
    id, ach_transfer_ref: String(body.transfer_ref ?? "tx"),
    ach_transfer_amount_cents: Number(body.amount_cents ?? 0),
    eps_client_ach_exposure_limit_cents: typeof body.exposure_limit_cents === "number"
      ? body.exposure_limit_cents
      : null,
    eps_client_ach_template_only: body.template_only === true,
    control_results: checks as Any, passed,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_res`, "ach_transfer.control_results",
    "ach_control_result", id, {
      "ach_transfer.amount": body.amount_cents ?? 0,
      "eps.client.ach_exposure_limit": body.exposure_limit_cents ?? null,
      "eps.client.ach_template_only": body.template_only === true,
      control_results: checks, passed,
    }, ctx);
  return jsonResponse({ data: { id, passed } }, 201, requestId);
}

/** POST /eps/limit-changes {partner_id, justification, approver_id?} — EPS-06. */
export async function postEpsLimitChange(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.justification)) {
    return validationError(requestId, [{
      type: "missing_field", field: "justification",
      message: "a limit change without a stated reason cannot be reviewed",
    }]);
  }
  const approver = isNonEmptyString(body.approver_id) ? String(body.approver_id) : null;
  if (approver && approver === ctx.tokenId) {
    // A limit an operator can raise for themselves is not a limit.
    return apiError(409, "self_approved_limit_change", requestId, {
      title: "limit change approved by its own requester",
      detail: "the approver must be someone other than the requester",
    });
  }
  const now = new Date();
  const id = `limchg_${body.partner_id ?? "p"}`;
  const { error } = await db.schema(scope).from("eps_limit_change").upsert({
    id, partner_id: String(body.partner_id ?? "p"), requested_by: ctx.tokenId,
    eps_limit_change_justification: body.justification,
    eps_limit_change_approver_id: approver,
    eps_client_wire_daily_limit_cents: typeof body.wire_daily_limit_cents === "number"
      ? body.wire_daily_limit_cents
      : null,
    eps_client_ach_exposure_limit_cents: typeof body.ach_exposure_limit_cents === "number"
      ? body.ach_exposure_limit_cents
      : null,
    requested_at: now.toISOString(),
    decided_at: approver ? now.toISOString() : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_req`, "eps.client_limit_change.requested",
    "eps_limit_change", id, {
      "eps.limit_change.justification": body.justification,
      "eps.limit_change.approver_id": approver,
      "eps.client.wire_daily_limit": body.wire_daily_limit_cents ?? null,
      "eps.client.ach_exposure_limit": body.ach_exposure_limit_cents ?? null,
    }, ctx);
  return jsonResponse({ data: { id, decided: approver !== null } }, 201, requestId);
}

/** POST /eps/pospay-items {issue_file, item, decision?} — EPS-06. */
export async function postPospayItem(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const decision = ["pay", "return"].includes(String(body.decision))
    ? String(body.decision)
    : null;
  const now = new Date();
  const id = `pospay_${body.item_ref ?? crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("pospay_item").upsert({
    id, eps_pospay_issue_file: String(body.issue_file ?? "issue_file"),
    eps_pospay_presented_item: (body.item ?? {}) as Any,
    // A missed deadline is a default-pay or default-return decision made by
    // nobody, which is why the deadline is a stored fact and not a convention.
    eps_pospay_decision_due_at: new Date(now.getTime() + DAY_MS).toISOString(),
    decision, decided_at: decision ? now.toISOString() : null,
    decided_by: decision ? ctx.tokenId : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_pres`, "eps.pospay_exception.presented",
    "pospay_item", id, {
      "eps.pospay.issue_file": body.issue_file ?? "issue_file",
      "eps.pospay.presented_item": body.item ?? {},
      "eps.pospay.decision.due_at": new Date(now.getTime() + DAY_MS).toISOString(),
      decision,
    }, ctx);
  return jsonResponse({ data: { id, decision } }, 201, requestId);
}
