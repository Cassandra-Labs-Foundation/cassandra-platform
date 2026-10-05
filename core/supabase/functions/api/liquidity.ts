// Liquidity — LQ-02, LQ-03, LQ-04, LQ-05, LQ-07, LQ-09.
//
// See the migration header. The one thing to carry in from it: the STATUTORY
// asset tier (§741.12) is derived and NOT NULL; every INSTITUTIONAL threshold
// — LAR bands, mismatch limits, survival horizon, headroom floor — is nullable
// and paired to its verdict. An unconfigured band produces "unassessed", never
// "within band". This is the capital pattern, predicted and confirmed.

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

/** NCUA §741.12 asset-size thresholds. STATUTORY — these are in the rule. */
export const CFP_REQUIRED_ASSETS_CENTS = 50_000_000_00;
export const FEDERAL_ACCESS_REQUIRED_ASSETS_CENTS = 250_000_000_00;
/** LQ-09: how often a facility must be proven to actually work. */
export const FACILITY_TEST_DAYS = 365;

/**
 * §741.12's tier, DERIVED from total assets. Never accepted from a caller: it
 * is a fact about the regulation applied to a number this system already holds,
 * and letting a caller assert it would let them assert out of an obligation.
 */
export function assetTier(totalAssetsCents: number): string {
  if (totalAssetsCents >= FEDERAL_ACCESS_REQUIRED_ASSETS_CENTS) return "over_250m";
  if (totalAssetsCents >= CFP_REQUIRED_ASSETS_CENTS) return "mid";
  return "under_50m";
}

/**
 * The band a ratio falls in, or NULL when no bands are configured.
 *
 * Returning "adequate" for an unconfigured system would be the flattering
 * error: an institution that never set a band reads as one that never breached.
 */
export function larBand(
  valueBp: number,
  cfg: { critical_bp: number; warning_bp: number; target_bp: number } | null,
): string | null {
  if (!cfg) return null;
  if (valueBp < cfg.critical_bp) return "critical";
  if (valueBp < cfg.warning_bp) return "warning";
  if (valueBp < cfg.target_bp) return "adequate";
  return "target";
}

function requireInternalActor(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/liquidity");
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
  if (error) throw new Error(`liquidity event (${code}): ${error.message}`);
}

/**
 * One past the highest version ever issued in a versioned register —
 * superseded rows included, so a new version can never collide with (and
 * overwrite) one already on file.
 */
async function nextVersion(
  db: SupabaseClient, scope: EvidenceScope, table: "lar_band_config" | "stress_assumption_set",
): Promise<number> {
  const { data, error } = await db.schema(scope).from(table)
    .select("version").order("version", { ascending: false }).limit(1);
  if (error) throw new Error(`${table} version read: ${error.message}`);
  return Number((data ?? [])[0]?.version ?? 0) + 1;
}

// --------------------------------------------------------------- LQ-03 bands

/** POST /liquidity/lar-bands {critical_bp, warning_bp, target_bp, approved_by} */
export async function postLarBandConfig(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const crit = Number(body.critical_bp), warn = Number(body.warning_bp);
  const tgt = Number(body.target_bp);
  if (!(crit < warn && warn < tgt) || !isNonEmptyString(body.approved_by)) {
    // Bands that cross are not bands, and an unapproved band is a suggestion.
    return validationError(requestId, [{
      type: "invalid_value", field: "critical_bp",
      message: "bands must be strictly ordered and approved by someone",
    }]);
  }
  const now = new Date();
  // Versioned, never overwritten: positions cite band_config_id, so the config
  // they were banded under must survive a re-approval. The next version is
  // one past the highest EVER issued (superseded rows included) — counting
  // only the unsuperseded rows always yields v2 once a config exists, and an
  // upsert on that id silently replaced the config in force.
  let version: number;
  try {
    version = await nextVersion(db, scope, "lar_band_config");
  } catch (e) {
    return internalErrorResponse(requestId, String(e));
  }
  const { data: prior } = await db.schema(scope).from("lar_band_config")
    .select("id").is("superseded_at", null);
  const id = `larcfg_v${version}`;
  const { error } = await db.schema(scope).from("lar_band_config").insert({
    id, version, critical_bp: crit, warning_bp: warn, target_bp: tgt,
    approved_by: body.approved_by, effective_at: now.toISOString(),
    superseded_at: null, provenance: provenanceFor(scope, ctx),
  });
  if (error) return internalErrorResponse(requestId, error.message);
  // supersede only once the new version is safely on file
  for (const p of prior ?? []) {
    await db.schema(scope).from("lar_band_config")
      .update({ superseded_at: now.toISOString() }).eq("id", p.id);
  }
  return jsonResponse({ data: { id, version } }, 201, requestId);
}

/**
 * POST /liquidity/positions {as_of_date, liquid_assets_cents, total_assets_cents, ...}
 *
 * LQ-03 and the anchor for LQ-02 and LQ-07.
 */
export async function postLiquidityPosition(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const total = Number(body.total_assets_cents ?? 0);
  const liquid = Number(body.liquid_assets_cents ?? 0);
  if (!(total > 0) || body.haircut_table == null) {
    // A ratio with no haircut table is a ratio nobody can reproduce.
    return validationError(requestId, [{
      type: "missing_field", field: "haircut_table",
      message: "total assets and the haircut table applied are both required",
    }]);
  }
  const larBp = Math.round((liquid / total) * 10000);
  const { data: cfgs } = await db.schema(scope).from("lar_band_config")
    .select("id, critical_bp, warning_bp, target_bp").is("superseded_at", null);
  const cfg = (cfgs ?? [])[0] ?? null;
  const band = larBand(larBp, cfg as Any);

  // the immediately preceding day's position, read directly (an unbounded
  // read of the whole register is capped at 1000 rows by PostgREST)
  const { data: priors } = await db.schema(scope).from("liquidity_position")
    .select("id, as_of_date, lar_current_band").lt("as_of_date", String(body.as_of_date))
    .order("as_of_date", { ascending: false }).limit(1);
  const prior = (priors ?? [])[0];

  const now = new Date();
  const id = `liqpos_${body.as_of_date}`;
  const { error } = await db.schema(scope).from("liquidity_position").upsert({
    id, as_of_date: body.as_of_date,
    gl_balances: (body.gl_balances ?? {}) as Any,
    liquidity_liquid_assets_cents: liquid,
    liquidity_total_assets_cents: total,
    liquidity_haircut_table: body.haircut_table as Any,
    liquidity_behavioral_assumptions: (body.behavioral_assumptions ?? {}) as Any,
    lar_value_bp: larBp,
    // STATUTORY: derived, never supplied.
    asset_tier: assetTier(total),
    band_config_id: cfg ? cfg.id : null,
    lar_current_band: band,
    lar_prior_band: prior ? prior.lar_current_band : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "lar.value": larBp, "lar.current_band": band, "lar.prior_band": prior?.lar_current_band ?? null,
    "liquidity.liquid_assets": liquid, "liquidity.total_assets": total,
    "liquidity.haircut_table": body.haircut_table,
    asset_tier: assetTier(total),
    // The honest form of an unconfigured system. See the module header.
    verdict: band ?? "unassessed",
  };
  await emit(db, scope, `ev_${id}_lar`, "lar.computed", "liquidity_position", id, payload, ctx);
  if (band && prior && prior.lar_current_band !== band) {
    await emit(db, scope, `ev_${id}_bandchg`, "alert.lar_band_change",
      "liquidity_position", id, { from: prior.lar_current_band, to: band }, ctx);
    await emit(db, scope, `ev_${id}_bandalert`, "lar.band_alert.issued",
      "liquidity_position", id, payload, ctx);
  } else if (band) {
    await emit(db, scope, `ev_${id}_bandalert`, "lar.band_alert.issued",
      "liquidity_position", id, payload, ctx);
  }
  if (band === "critical") {
    await emit(db, scope, `ev_${id}_crit`, "lar.critical.breached",
      "liquidity_position", id, payload, ctx);
  }
  return jsonResponse({
    data: { id, lar_value_bp: larBp, band, verdict: band ?? "unassessed", asset_tier: assetTier(total) },
  }, 201, requestId);
}

// ------------------------------------------------------------ LQ-02 mismatch

/** POST /liquidity/positions/:id/mismatch {gaps, limit?, disposition?} */
export async function postMaturityMismatch(
  req: Request, positionId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: pos } = await db.schema(scope).from("liquidity_position")
    .select("id, as_of_date").eq("id", positionId).maybeSingle();
  if (!pos) return notFoundResponse(requestId, "liquidity_position", positionId);

  const gaps = (body.gaps ?? {}) as Record<string, number>;
  const limit = (body.limit ?? null) as Record<string, number> | null;
  // INSTITUTIONAL: no limit means no breach verdict, not "no breach".
  let breachedBucket: string | null = null;
  let magnitude: number | null = null;
  if (limit) {
    for (const [bucket, gap] of Object.entries(gaps)) {
      const cap = limit[bucket];
      if (typeof cap === "number" && Math.abs(gap) > Math.abs(cap)) {
        breachedBucket = bucket;
        magnitude = Math.abs(gap) - Math.abs(cap);
        break;
      }
    }
  }
  const disposed = isNonEmptyString(body.disposition);
  if (breachedBucket && disposed && !isNonEmptyString(body.dispositioned_by)) {
    return validationError(requestId, [{
      type: "missing_field", field: "dispositioned_by",
      message: "a disposition is a decision and needs an owner",
    }]);
  }
  const now = new Date();
  const id = `mism_${positionId}`;
  const { error } = await db.schema(scope).from("maturity_mismatch").upsert({
    id, position_id: positionId, as_of_date: pos.as_of_date,
    mismatch_current_gaps: gaps as Any, mismatch_limit: limit as Any,
    mismatch_breached_bucket: breachedBucket,
    mismatch_breach_magnitude_cents: magnitude,
    intraday_recomputed_at: body.intraday === true ? now.toISOString() : null,
    funding_draw_amount_cents: typeof body.draw_amount_cents === "number"
      ? body.draw_amount_cents
      : null,
    funding_shortfall_estimate_cents: typeof body.shortfall_estimate_cents === "number"
      ? body.shortfall_estimate_cents
      : null,
    dispositioned_at: disposed ? now.toISOString() : null,
    dispositioned_by: disposed ? body.dispositioned_by : null,
    disposition: disposed ? body.disposition : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "mismatch.current_gaps": gaps, "mismatch.limit": limit,
    "mismatch.breached_bucket": breachedBucket,
    "mismatch.breach_magnitude": magnitude,
    "gl.balances": body.gl_balances ?? {},
    "liquidity.behavioral_assumptions": body.behavioral_assumptions ?? {},
    "funding.draw_amount": body.draw_amount_cents ?? null,
    "funding.shortfall_estimate": body.shortfall_estimate_cents ?? null,
    verdict: limit ? (breachedBucket ? "breached" : "within") : "unassessed",
  };
  await emit(db, scope, `ev_${id}_gap`, "mismatch.gap_computed",
    "maturity_mismatch", id, payload, ctx);
  if (body.intraday === true) {
    await emit(db, scope, `ev_${id}_intra`, "mismatch.intraday_recomputed",
      "maturity_mismatch", id, payload, ctx);
  }
  if (breachedBucket) {
    await emit(db, scope, `ev_${id}_alert`, "alert.mismatch_breach",
      "maturity_mismatch", id, payload, ctx);
  }
  if (disposed) {
    await emit(db, scope, `ev_${id}_disp`, "mismatch.breach.dispositioned",
      "maturity_mismatch", id, {
        ...payload, disposition: body.disposition, by: body.dispositioned_by,
      }, ctx);
  }
  return jsonResponse({ data: { id, breached_bucket: breachedBucket } }, 201, requestId);
}

// ----------------------------------------------------- LQ-04 / LQ-05 stress

/** POST /liquidity/stress-assumptions {set, behavioral_assumptions, rationale?, approver_id?} */
export async function postStressAssumptions(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: prior } = await db.schema(scope).from("stress_assumption_set")
    .select("id, version").is("superseded_at", null);
  // A change (there is a set in force) must be owned. The version number itself
  // is one past the highest ever issued — see nextVersion.
  if ((prior ?? []).length > 0 && !(isNonEmptyString(body.rationale) && isNonEmptyString(body.approver_id))) {
    // A survival horizon recomputed under quietly-changed assumptions is the
    // failure LQ-05 describes: the number improves and nothing records why.
    return validationError(requestId, [{
      type: "missing_field", field: "rationale",
      message: "changing a stress assumption needs a rationale and an approver",
    }]);
  }
  let version: number;
  try {
    version = await nextVersion(db, scope, "stress_assumption_set");
  } catch (e) {
    return internalErrorResponse(requestId, String(e));
  }
  const now = new Date();
  const id = `stressassm_v${version}`;
  // insert, never upsert: the prior set must stay intact so a run computed
  // under it stays reproducible (LQ-05)
  const { error } = await db.schema(scope).from("stress_assumption_set").insert({
    id, version, stress_set: isNonEmptyString(body.set) ? body.set : "baseline",
    stress_behavioral_assumptions: (body.behavioral_assumptions ?? {}) as Any,
    stress_baas_shock_params: (body.baas_shock_params ?? {}) as Any,
    stress_intraday_profile: (body.intraday_profile ?? {}) as Any,
    stress_assumption_value: (body.assumption_value ?? {}) as Any,
    stress_change_rationale: isNonEmptyString(body.rationale) ? body.rationale : null,
    stress_approver_id: isNonEmptyString(body.approver_id) ? body.approver_id : null,
    superseded_at: null, provenance: provenanceFor(scope, ctx),
  });
  if (error) return internalErrorResponse(requestId, error.message);
  for (const p of prior ?? []) {
    await db.schema(scope).from("stress_assumption_set")
      .update({ superseded_at: now.toISOString() }).eq("id", p.id);
  }

  // Versioned, not edited: the prior set stays readable so a number computed
  // last quarter can still be reproduced.
  // One event per change. The suffix keeps the id unique even if a version
  // number is ever reissued (a deleted version row), which would otherwise
  // suppress this change's evidence as a duplicate of an earlier one.
  await emit(db, scope, `ev_${id}_ver_${now.getTime()}`, "stress.assumption_versioned",
    "stress_assumption_set", id, {
      "stress.set": body.set ?? "baseline", version,
      "stress.behavioral_assumptions": body.behavioral_assumptions ?? {},
      "stress.baas_shock_params": body.baas_shock_params ?? {},
      "stress.intraday_profile": body.intraday_profile ?? {},
      "stress.assumption_value": body.assumption_value ?? {},
      "stress.change_rationale": body.rationale ?? null,
      "stress.approver_id": body.approver_id ?? null,
    }, ctx);
  return jsonResponse({ data: { id, version } }, 201, requestId);
}

/** POST /liquidity/stress-runs {period, kind, survival_days, threshold_days?} */
export async function postStressRun(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: sets } = await db.schema(scope).from("stress_assumption_set")
    .select("id, version").is("superseded_at", null);
  const set = (sets ?? [])[0];
  if (!set) {
    // A stress run with no assumption set is a number with no provenance.
    return validationError(requestId, [{
      type: "missing_field", field: "assumption_set",
      message: "no current stress assumption set; a run would have no provenance",
    }]);
  }
  const adhoc = body.kind === "adhoc";
  if (adhoc && !isNonEmptyString(body.trigger_reason)) {
    // An unexplained rerun is indistinguishable from re-running until the
    // number improved.
    return validationError(requestId, [{
      type: "missing_field", field: "trigger_reason",
      message: "an ad-hoc rerun must say what triggered it",
    }]);
  }
  // INSTITUTIONAL: nullable threshold, paired verdict.
  const threshold = typeof body.threshold_days === "number" ? body.threshold_days : null;
  const days = Number(body.survival_days ?? 0);
  const below = threshold === null ? null : days < threshold;

  const now = new Date();
  const id = `stressrun_${body.period ?? "p"}_${adhoc ? "adhoc" : "sched"}`;
  const { error } = await db.schema(scope).from("liquidity_stress_run").upsert({
    id, period: String(body.period ?? "p"), assumption_set_id: set.id,
    kind: adhoc ? "adhoc" : "scheduled",
    trigger_reason: isNonEmptyString(body.trigger_reason) ? body.trigger_reason : null,
    survival_days_combined: days,
    survival_threshold_days: threshold, survival_below_threshold: below,
    ewi_value: (body.ewi_value ?? {}) as Any,
    pack_issued_at: now.toISOString(), provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "survival.days_combined": days, "stress.set": set.id,
    "ewi.value": body.ewi_value ?? {},
    "stress.behavioral_assumptions": body.behavioral_assumptions ?? {},
    "stress.assumption_value": body.assumption_value ?? {},
    "liquidity.haircut_table": body.haircut_table ?? {},
    verdict: threshold === null ? "unassessed" : (below ? "below" : "above"),
  };
  await emit(db, scope, `ev_${id}_surv`, "survival.computed",
    "liquidity_stress_run", id, payload, ctx);
  if (adhoc) {
    await emit(db, scope, `ev_${id}_adhoc`, "survival.adhoc_computed",
      "liquidity_stress_run", id, payload, ctx);
    await emit(db, scope, `ev_${id}_rerun`, "stress.adhoc_rerun.issued",
      "liquidity_stress_run", id, { ...payload, trigger: body.trigger_reason }, ctx);
  }
  if (below === true) {
    await emit(db, scope, `ev_${id}_below`, "survival.below_threshold",
      "liquidity_stress_run", id, payload, ctx);
  }
  await emit(db, scope, `ev_${id}_pack`, "stress.pack.issued",
    "liquidity_stress_run", id, { ...payload, "stress.pack": id }, ctx);
  return jsonResponse({ data: { id, survival_days: days, below_threshold: below } }, 201, requestId);
}

// ---------------------------------------------------------------- LQ-09

/** POST /liquidity/facilities {name, kind, test_script, contacts} */
export async function postFacility(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const kinds = ["fhlb", "discount_window", "clf", "correspondent"];
  if (!kinds.includes(String(body.kind)) || !isNonEmptyString(body.name)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "kind", message: `kind must be one of ${kinds.join("/")}`,
    }]);
  }
  const tested = body.tested === true;
  if (tested && !isNonEmptyString(body.test_script)) {
    // Recording a test outcome with no script means the next person cannot
    // repeat it, which makes the outcome unverifiable.
    return validationError(requestId, [{
      type: "missing_field", field: "test_script",
      message: "a facility test needs the script it was run from",
    }]);
  }
  const now = new Date();
  const id = `fac_${body.kind}`;
  const { error } = await db.schema(scope).from("liquidity_facility").upsert({
    id, name: body.name, kind: body.kind,
    facility_contacts: (body.contacts ?? {}) as Any,
    facility_collateral_schedule: (body.collateral_schedule ?? {}) as Any,
    facility_test_script: isNonEmptyString(body.test_script) ? body.test_script : null,
    last_tested_at: tested ? now.toISOString() : null,
    test_due_at: new Date(now.getTime() + FACILITY_TEST_DAYS * DAY_MS).toISOString(),
    test_outcome: tested ? String(body.test_outcome ?? "drew successfully") : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  if (tested) {
    // A facility that has never been drawn is a facility nobody knows works.
    // A facility is retested every year: each test is its own evidence, so the
    // event id carries the test time (a fixed id was suppressed as a duplicate
    // on every test after the first).
    await emit(db, scope, `ev_${id}_test_${now.getTime()}`, "facility.test.completed",
      "liquidity_facility", id, {
        "facility.contacts": body.contacts ?? {},
        "facility.test_script": body.test_script,
        "facility.collateral_schedule": body.collateral_schedule ?? {},
        outcome: body.test_outcome ?? "drew successfully",
      }, ctx);
  }
  return jsonResponse({ data: { id, tested } }, 201, requestId);
}

/** POST /liquidity/facilities/:id/collateral {pledge_schedule, unencumbered_cents, floor?} */
export async function postCollateralPosition(
  req: Request, facilityId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: fac } = await db.schema(scope).from("liquidity_facility")
    .select("id").eq("id", facilityId).maybeSingle();
  if (!fac) return notFoundResponse(requestId, "liquidity_facility", facilityId);

  if (body.eligibility_rules == null) {
    // Headroom computed without the eligibility rules is headroom against
    // collateral the facility may not accept.
    return validationError(requestId, [{
      type: "missing_field", field: "eligibility_rules",
      message: "headroom needs the rules that decide what counts",
    }]);
  }
  const unenc = Number(body.unencumbered_cents ?? 0);
  const pledged = Number(body.pledged_cents ?? 0);
  const headroom = unenc - pledged;
  // INSTITUTIONAL: nullable floor, paired verdict.
  const floor = typeof body.floor_cents === "number" ? body.floor_cents : null;
  const low = floor === null ? null : headroom < floor;

  const now = new Date();
  const recompute = body.recompute === true;
  const id = `coll_${facilityId}_${body.as_of_date ?? "d"}`;
  const { error } = await db.schema(scope).from("collateral_position").upsert({
    id, facility_id: facilityId, as_of_date: body.as_of_date ?? "2026-07-19",
    collateral_pledge_schedule: (body.pledge_schedule ?? {}) as Any,
    collateral_eligibility_rules: body.eligibility_rules as Any,
    collateral_unencumbered_balance_cents: unenc,
    headroom_cents: headroom,
    collateral_move_detail: (body.move_detail ?? null) as Any,
    recomputed_at: recompute ? now.toISOString() : null,
    headroom_floor_cents: floor, headroom_low: low,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "collateral.unencumbered_balance": unenc,
    "collateral.pledge_schedule": body.pledge_schedule ?? {},
    "collateral.eligibility_rules": body.eligibility_rules,
    "collateral.move_detail": body.move_detail ?? null,
    headroom_cents: headroom,
    verdict: floor === null ? "unassessed" : (low ? "low" : "adequate"),
  };
  await emit(db, scope, `ev_${id}_hr`, "collateral.headroom_computed",
    "collateral_position", id, payload, ctx);
  if (recompute) {
    await emit(db, scope, `ev_${id}_re`, "collateral.headroom_rechecked",
      "collateral_position", id, payload, ctx);
  }
  if (low === true) {
    await emit(db, scope, `ev_${id}_low`, "alert.headroom_low",
      "collateral_position", id, payload, ctx);
  }
  return jsonResponse({ data: { id, headroom_cents: headroom, low } }, 201, requestId);
}

// ------------------------------------------------------------- LQ-07 packs

/** POST /liquidity/packs {cadence, period, position_id} */
export async function postLiquidityPack(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const cadences = ["daily", "weekly", "board"];
  if (!cadences.includes(String(body.cadence))) {
    return validationError(requestId, [{
      type: "invalid_value", field: "cadence", message: `one of ${cadences.join("/")}`,
    }]);
  }
  // Every figure is anchored on the latest position, read with an explicit
  // order — never "row [0]" of an unordered (and 1000-row-capped) register.
  const { data: pos } = await db.schema(scope).from("liquidity_position")
    .select("id, lar_value_bp, lar_current_band, as_of_date")
    .order("as_of_date", { ascending: false }).limit(1);
  const latest = (pos ?? [])[0] as Any;
  // the maturity gaps are the latest position's own mismatch
  const { data: mism } = latest
    ? await db.schema(scope).from("maturity_mismatch")
      .select("id, mismatch_current_gaps").eq("position_id", latest.id).limit(1)
    : { data: [] as Any[] };
  // the most recent headroom on or before the position's as-of date
  let collQ = db.schema(scope).from("collateral_position").select("id, headroom_cents, as_of_date");
  if (latest) collQ = collQ.lte("as_of_date", latest.as_of_date);
  const { data: coll } = await collQ.order("as_of_date", { ascending: false }).limit(1);
  // the most recent stress run (runs carry a period label, not a date)
  const { data: runs } = await db.schema(scope).from("liquidity_stress_run")
    .select("id, survival_days_combined").order("created_at", { ascending: false }).limit(1);

  // The pack is ASSEMBLED from the positions, not re-entered. A board deck
  // whose numbers were typed in separately is a second source of truth, and the
  // two diverge on exactly the day it matters.
  const contents = {
    "lar.value": latest?.lar_value_bp ?? null,
    "lar.current_band": latest?.lar_current_band ?? null,
    "mismatch.current_gaps": (mism ?? [])[0]?.mismatch_current_gaps ?? {},
    "collateral.headroom_computed": (coll ?? [])[0]?.headroom_cents ?? null,
    "survival.days_combined": (runs ?? [])[0]?.survival_days_combined ?? null,
    "concentration.top10": body.concentration_top10 ?? [],
    "ewi.ceo_summary": body.ceo_summary ?? null,
    "report.weekly_deltas": body.weekly_deltas ?? {},
    "policy.limit_registry": body.limit_registry ?? [],
    "stress.pack": (runs ?? [])[0]?.id ?? null,
  };
  const now = new Date();
  const id = `liqpack_${body.cadence}_${body.period ?? "p"}`;
  const { error } = await db.schema(scope).from("liquidity_pack").upsert({
    id, cadence: body.cadence, period: String(body.period ?? "p"),
    position_id: latest?.id ?? null, contents: contents as Any,
    published_at: now.toISOString(), published_by: ctx.tokenId,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const code = body.cadence === "daily"
    ? "report.daily_pack.published"
    : body.cadence === "weekly"
    ? "report.weekly_digest.published"
    : "report.board_deck.published";
  await emit(db, scope, `ev_${id}_pub`, code, "liquidity_pack", id, contents, ctx);
  return jsonResponse({ data: { id, cadence: body.cadence } }, 201, requestId);
}

// ---------------------------------------- LQ-06/08/11/13/17 — the ops tail

/** POST /liquidity/alco-review {ratios, reviewed_by} — the ALCO looked at the
 * numbers and it is on the record (shared with BA-08 and LQ-17). */
export async function postAlcoRatioReview(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.reviewed_by)) {
    return validationError(requestId, [{
      type: "missing_field", field: "reviewed_by", message: "reviewed_by is required",
    }]);
  }
  const id = `alco_${crypto.randomUUID()}`;
  await emit(db, scope, `ev_${id}_rev`, "alco.ratio_review.logged", "alco_review", id, {
    reviewed_by: body.reviewed_by, ratios: body.ratios ?? null,
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/**
 * POST /liquidity/concentration {as_of, top_depositor_pct_bp, limit_pct_bp?, waiver?}
 *
 * LQ-06: the depositor file posts, the concentration is COMPUTED against the
 * limit, and a breach demands a waiver DECISION — present or refused, never
 * silent. An unset limit reports unassessed (the institutional-threshold
 * rule), not "not breached".
 */
export async function postLiquidityConcentration(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const pct = typeof body.top_depositor_pct_bp === "number" ? body.top_depositor_pct_bp : null;
  if (pct === null) {
    return validationError(requestId, [{
      type: "missing_field", field: "top_depositor_pct_bp", message: "is required",
    }]);
  }
  const limit = typeof body.limit_pct_bp === "number" ? body.limit_pct_bp : null;
  const breached = limit !== null && pct > limit;
  const id = `lqconc_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("liquidity_concentration").upsert({
    id, as_of: isNonEmptyString(body.as_of) ? body.as_of : new Date().toISOString().slice(0, 10),
    top_depositor_pct_bp: pct, limit_pct_bp: limit, breached,
    waiver_decision: isNonEmptyString(body.waiver_decision) ? body.waiver_decision : null,
    waiver_decided_by: isNonEmptyString(body.waiver_decided_by) ? body.waiver_decided_by : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  if (limit === null) {
    await emit(db, scope, `ev_${id}_unassessed`, "liquidity.concentration.computed",
      "liquidity_concentration", id, { top_depositor_pct_bp: pct, verdict: "unassessed" }, ctx);
  } else if (breached) {
    await emit(db, scope, `ev_${id}_breach`, "liquidity.concentration.breached",
      "liquidity_concentration", id, { top_depositor_pct_bp: pct, limit_pct_bp: limit }, ctx);
    if (!isNonEmptyString(body.waiver_decision) || !isNonEmptyString(body.waiver_decided_by)) {
      return apiError(409, "waiver_decision_required", requestId, {
        title: "Waiver Decision Required",
        detail: "a breached concentration demands a waiver decision with a decider — silence is not a waiver",
      });
    }
    await emit(db, scope, `ev_${id}_waiver`, "concentration.waiver.decided",
      "liquidity_concentration", id, {
        decision: body.waiver_decision, decided_by: body.waiver_decided_by,
      }, ctx);
  }
  return jsonResponse({ data: { id, breached } }, 201, requestId);
}

/** POST /liquidity/eod-tieout {as_of, gl_total_cents, subledger_total_cents} —
 * LQ-08: the tie-out is the control; a variance is DETECTED, not explained away. */
export async function postEodTieout(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const gl = typeof body.gl_total_cents === "number" ? body.gl_total_cents : null;
  const sub = typeof body.subledger_total_cents === "number" ? body.subledger_total_cents : null;
  if (gl === null || sub === null) {
    return validationError(requestId, [{
      type: "missing_field", field: "gl_total_cents",
      message: "gl_total_cents and subledger_total_cents are required",
    }]);
  }
  const variance = gl - sub;
  const id = `tieout_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("dq_tieout").upsert({
    id, as_of: isNonEmptyString(body.as_of) ? body.as_of : new Date().toISOString().slice(0, 10),
    gl_total_cents: gl, subledger_total_cents: sub, variance_cents: variance,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  if (variance !== 0) {
    await emit(db, scope, `ev_${id}_var`, "dq.variance.detected", "dq_tieout", id, {
      variance_cents: variance, gl_total_cents: gl, subledger_total_cents: sub,
    }, ctx);
  }
  await emit(db, scope, `ev_${id}_done`, "dq.tieout.completed", "dq_tieout", id, {
    variance_cents: variance,
  }, ctx);
  return jsonResponse({ data: { id, variance_cents: variance } }, 201, requestId);
}

/** POST /liquidity/model-reviews {model, reviewer, outcome} — LQ-08's model half. */
export async function postModelReview(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.model) || !isNonEmptyString(body.reviewer) || !isNonEmptyString(body.outcome)) {
    return validationError(requestId, [{
      type: "missing_field", field: "model", message: "model, reviewer and outcome are required",
    }]);
  }
  const id = `modrev_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("model_review").upsert({
    id, model: body.model, reviewer: body.reviewer, outcome: body.outcome,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${id}_done`, "model.review.completed", "model_review", id, {
    model: body.model, outcome: body.outcome,
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/** POST /liquidity/ncua-notifications {kind} + /{id}/ack {ack_ref} — LQ-11:
 * the notification and the acknowledgment are separate facts with a gap that
 * is itself a metric. */
export async function postNcuaNotification(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.kind)) {
    return validationError(requestId, [{
      type: "missing_field", field: "kind", message: "kind is required",
    }]);
  }
  const id = `ncua_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("ncua_notification").upsert({
    id, kind: body.kind, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${id}_sent`, "ncua.notification.sent", "ncua_notification", id, {
    kind: body.kind,
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

export async function postNcuaAck(
  req: Request, notifId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: n } = await db.schema(scope).from("ncua_notification")
    .select("id, kind").eq("id", notifId).maybeSingle();
  if (!n) return notFoundResponse(requestId, "ncua_notification", notifId);
  if (!isNonEmptyString(body.ack_ref)) {
    return validationError(requestId, [{
      type: "missing_field", field: "ack_ref",
      message: "an acknowledgment without a reference is a feeling, not a record",
    }]);
  }
  const now = new Date().toISOString();
  await db.schema(scope).from("ncua_notification")
    .update({ ack_received_at: now, ack_ref: body.ack_ref }).eq("id", notifId);
  await emit(db, scope, `ev_${notifId}_ack`, "ncua.ack.logged", "ncua_notification", notifId, {
    ack_ref: body.ack_ref, kind: n.kind,
  }, ctx);
  return jsonResponse({ data: { id: notifId, acked: true } }, 200, requestId);
}

/** POST /liquidity/regulator-requests {regulator} + /{id}/respond {response_ref}
 * + /{id}/verify-contacts — LQ-13. */
export async function postRegulatorRequest(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.regulator)) {
    return validationError(requestId, [{
      type: "missing_field", field: "regulator", message: "regulator is required",
    }]);
  }
  const id = `regreq_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("regulator_request").upsert({
    id, regulator: body.regulator, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  return jsonResponse({ data: { id } }, 201, requestId);
}

export async function postRegulatorResponse(
  req: Request, reqId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: r } = await db.schema(scope).from("regulator_request")
    .select("id, regulator").eq("id", reqId).maybeSingle();
  if (!r) return notFoundResponse(requestId, "regulator_request", reqId);
  if (!isNonEmptyString(body.response_ref)) {
    return validationError(requestId, [{
      type: "missing_field", field: "response_ref",
      message: "the response that went out has to be referenced",
    }]);
  }
  const now = new Date().toISOString();
  await db.schema(scope).from("regulator_request")
    .update({ responded_at: now, response_ref: body.response_ref }).eq("id", reqId);
  await emit(db, scope, `ev_${reqId}_resp`, "regulator.response.sent", "regulator_request", reqId, {
    regulator: r.regulator, response_ref: body.response_ref,
  }, ctx);
  return jsonResponse({ data: { id: reqId, responded: true } }, 200, requestId);
}

export async function postRegulatorContactsVerify(
  req: Request, reqId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: r } = await db.schema(scope).from("regulator_request")
    .select("id").eq("id", reqId).maybeSingle();
  if (!r) return notFoundResponse(requestId, "regulator_request", reqId);
  const now = new Date().toISOString();
  await db.schema(scope).from("regulator_request")
    .update({ contacts_verified_at: now }).eq("id", reqId);
  await emit(db, scope, `ev_${reqId}_contacts`, "regulator.contacts.verified",
    "regulator_request", reqId, { verified_by: body.verified_by ?? null }, ctx);
  return jsonResponse({ data: { id: reqId, verified: true } }, 200, requestId);
}

/**
 * POST /liquidity/wholesale {as_of, amount_cents, rate_bp, market_rate_bp?, listing_decision?}
 *
 * LQ-17: the exposure is COMPUTED and the rate is compared to market — paying
 * above market for wholesale funds is the pricing violation the alert names.
 */
export async function postWholesaleExposure(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const amount = typeof body.amount_cents === "number" ? body.amount_cents : null;
  const rate = typeof body.rate_bp === "number" ? body.rate_bp : null;
  if (amount === null || rate === null) {
    return validationError(requestId, [{
      type: "missing_field", field: "amount_cents",
      message: "amount_cents and rate_bp are required",
    }]);
  }
  const market = typeof body.market_rate_bp === "number" ? body.market_rate_bp : null;
  const violation = market !== null && rate > market;
  const id = `whsl_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("wholesale_exposure").upsert({
    id, as_of: isNonEmptyString(body.as_of) ? body.as_of : new Date().toISOString().slice(0, 10),
    amount_cents: amount, rate_bp: rate, market_rate_bp: market,
    pricing_violation: violation,
    listing_decision: isNonEmptyString(body.listing_decision) ? body.listing_decision : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_comp`, "wholesale.exposure_computed", "wholesale_exposure", id, {
    amount_cents: amount, rate_bp: rate, market_rate_bp: market,
  }, ctx);
  if (violation) {
    await emit(db, scope, `ev_${id}_viol`, "alert.wholesale_pricing_violation",
      "wholesale_exposure", id, { rate_bp: rate, market_rate_bp: market }, ctx);
  }
  if (isNonEmptyString(body.listing_decision)) {
    await emit(db, scope, `ev_${id}_listing`, "wholesale.listing_decisioned",
      "wholesale_exposure", id, { decision: body.listing_decision }, ctx);
  }
  return jsonResponse({ data: { id, pricing_violation: violation } }, 201, requestId);
}
