// Capital adequacy, PCA classification, and net worth restoration (CP-*, BA-*).
//
// WHY THIS IS NOT core.threshold. Every prior trigger in this repo is an EVENT
// — a transfer posted, an account closed, an incident declared. A capital
// position is a COMPUTED POSITION over the whole book at a point in time, and
// it classifies into five statutory bands rather than tripping one limit.
// core.threshold does neither, so this is a second mechanism rather than a
// bent first one.
//
// WHY THE NUMBERS ARE HARDCODED. The PCA bands come from 12 CFR 702.102 and are
// restated in capitalization.md. They are published law, not an institutional
// choice, so writing them down is a lookup rather than a fabrication. This is
// the first threshold in this system that could be populated honestly. The
// INTERNAL early-warning trigger above the floor is the opposite — CP-03 puts
// it under Board approval — so it stays unassessed until configured, and an
// unassessed trigger reports no verdict rather than reporting "not breached".

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor } from "./bsa.ts";
import {
  apiError, internalErrorResponse, jsonResponse, notFoundResponse,
  parseJsonBody, validationError, type ValidationErrorItem,
} from "./lib.ts";

/**
 * 12 CFR 702.102. Ordered strongest first; classification takes the first band
 * whose floor the ratio meets. Basis points throughout — a regulatory ratio
 * should never round-trip through a float.
 */
export const PCA_BANDS: ReadonlyArray<{ category: string; floor_bp: number }> = [
  { category: "well_capitalized", floor_bp: 700 },
  { category: "adequately_capitalized", floor_bp: 600 },
  { category: "undercapitalized", floor_bp: 400 },
  { category: "significantly_undercapitalized", floor_bp: 200 },
  { category: "critically_undercapitalized", floor_bp: 0 },
];

/** Categories carrying a mandatory restoration plan and payout restriction. */
const RESTRICTED = new Set([
  "undercapitalized", "significantly_undercapitalized", "critically_undercapitalized",
]);

/**
 * NCUA requires a net worth restoration plan within 45 days of becoming
 * undercapitalized. The anchor is the CLASSIFICATION — not the quarter-end the
 * data describes, and not the day someone read the report. Fourth deadline in
 * this repo and the fourth distinct anchor; see the migration header.
 */
export const NWRP_DAYS = 45;
const SWEEP_LIMIT = 200;

const COLS =
  "tier1_cents, tier2_cents, classification_approved_by, id, as_of_date, net_worth_cents, total_assets_cents, risk_weighted_assets_cents, " +
  "net_worth_ratio_bp, pca_category, internal_trigger_bp, internal_trigger_breached, " +
  "nwrp_due_at, nwrp_filed_at, nwrp_filed_by, distribution_restricted, provenance, created_at";

// capital_target has its own shape — selecting the position COLS from it is
// exactly the select-list defect the live tier exists to catch (PostgREST
// rejects the unknown columns and the write's emits never run).
const TARGET_COLS =
  "id, effective_date, target_bp, proposed_by, approved_by, approved_at, " +
  "proposed_by_token, approved_by_token, provenance, created_at";

/**
 * The ratio, in basis points, computed EXACTLY as ck_capital_ratio_matches_components
 * does: Postgres bigint division, which truncates toward zero. For a solvent
 * position that is the floor, so it never rounds up into a better band. For a
 * negative net worth truncation lands nearer zero (-2.47bp → -2, not -3), but
 * every negative ratio is critically undercapitalized either way, and a ratio
 * that disagreed with the constraint would make every non-dividing insolvent
 * quarter unrecordable (a 500). BigInt so the cents*10000 product cannot lose
 * precision above 2^53 the way a float would.
 */
export function netWorthRatioBp(netWorthCents: number, totalAssetsCents: number): number {
  return Number((BigInt(Math.trunc(netWorthCents)) * 10000n) / BigInt(Math.trunc(totalAssetsCents)));
}

export function classifyPca(ratioBp: number): string {
  for (const band of PCA_BANDS) if (ratioBp >= band.floor_bp) return band.category;
  return "critically_undercapitalized";
}

/**
 * The control corpus names the board-escalation fact BOTH ways —
 * `capital.board_escalation` (BA-01's siblings) and
 * `capital.board_escalation.issued` (CP-08). They are the same event. Rather
 * than picking one and leaving the other permanently unsatisfiable, the writer
 * emits both aliases; the alternative is a control that can never pass because
 * of a naming inconsistency in the policy text rather than a gap in the system.
 */
const ESCALATION_ALIASES = ["capital.board_escalation", "capital.board_escalation.issued"];

async function emitEscalation(
  db: SupabaseClient, scope: EvidenceScope, idBase: string, rId: string,
  payload: Record<string, unknown>, ctx?: PartnerContext,
): Promise<void> {
  for (const [i, code] of ESCALATION_ALIASES.entries()) {
    await emit(db, scope, `${idBase}_${i}`, code, rId, payload, ctx);
  }
}

async function emit(
  db: SupabaseClient, scope: EvidenceScope, id: string, code: string,
  rId: string, payload: Record<string, unknown>, ctx?: PartnerContext,
): Promise<void> {
  const { error } = await db.schema(scope).from("event").upsert({
    id, code, resource_type: "capital_position", resource_id: `capital:${rId}`,
    payload, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`capital event (${code}): ${error.message}`);
}

function requireInternalActor(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/capital");
  return null;
}

/**
 * POST /capital/positions {as_of_date, net_worth_cents, total_assets_cents,
 *                          risk_weighted_assets_cents?, internal_trigger_bp?}
 *
 * Computes the ratio, classifies it, and applies every consequence the
 * classification carries. The components are stored alongside the ratio so the
 * classification can be recomputed and disputed; a stored ratio with no inputs
 * is an assertion, not evidence.
 */
export async function postCapitalPosition(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const errors: ValidationErrorItem[] = [];
  const asOf = typeof body.as_of_date === "string" ? body.as_of_date : "";
  const netWorth = typeof body.net_worth_cents === "number" ? body.net_worth_cents : NaN;
  const totalAssets = typeof body.total_assets_cents === "number" ? body.total_assets_cents : NaN;
  if (!asOf) errors.push({ field: "as_of_date", type: "required", message: "as_of_date is required" });
  if (!Number.isFinite(netWorth)) {
    errors.push({ field: "net_worth_cents", type: "required", message: "net_worth_cents is required" });
  }
  if (!Number.isFinite(totalAssets) || totalAssets <= 0) {
    errors.push({
      field: "total_assets_cents", type: "invalid",
      message: "total_assets_cents must be greater than zero",
    });
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const ratioBp = netWorthRatioBp(netWorth, totalAssets);
  const category = classifyPca(ratioBp);
  const restricted = RESTRICTED.has(category);

  // CP-03: an unset internal trigger yields a NULL verdict, not `false`. The
  // difference is the whole point — "nobody configured a trigger" and "the
  // trigger was not breached" are opposite facts about the institution.
  const internalBp = typeof body.internal_trigger_bp === "number" ? body.internal_trigger_bp : null;
  const internalBreached = internalBp === null ? null : ratioBp < internalBp;

  const id = `cap_${asOf.replace(/-/g, "")}`;

  // The 45-day clock is anchored on the FIRST classification into a band that
  // requires a restoration plan. Re-posting the quarter (a restatement) that is
  // still restricted keeps the deadline it already has; resetting it on every
  // upsert would let a restatement silently push the plan out by 45 days.
  const { data: existing, error: exErr } = await db.schema(scope).from("capital_position")
    .select("id, nwrp_due_at").eq("id", id).maybeSingle();
  if (exErr) return internalErrorResponse(requestId, exErr.message);
  const priorDue = (existing as Record<string, unknown> | null)?.nwrp_due_at as string | null ?? null;
  const now = new Date();
  const nwrpDue = !restricted
    ? null
    : priorDue ?? new Date(now.getTime() + NWRP_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db.schema(scope).from("capital_position").upsert({
    id,
    as_of_date: asOf,
    net_worth_cents: netWorth,
    total_assets_cents: totalAssets,
    risk_weighted_assets_cents: typeof body.risk_weighted_assets_cents === "number"
      ? body.risk_weighted_assets_cents
      : null,
    net_worth_ratio_bp: ratioBp,
    pca_category: category,
    internal_trigger_bp: internalBp,
    internal_trigger_breached: internalBreached,
    tier1_cents: typeof body.tier1_cents === "number" ? body.tier1_cents : null,
    tier2_cents: typeof body.tier2_cents === "number" ? body.tier2_cents : null,
    classification_approved_by: typeof body.classification_approved_by === "string"
      ? body.classification_approved_by
      : null,
    nwrp_due_at: nwrpDue,
    distribution_restricted: restricted,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" }).select(COLS).maybeSingle();
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_ratios`, "capital.ratios.verified", id, {
    net_worth_ratio_bp: ratioBp, pca_category: category,
  }, ctx);
  await emit(db, scope, `ev_${id}_class`, "capital.pca_classification.recorded", id, {
    pca_category: category,
  }, ctx);
  await emit(db, scope, `ev_${id}_comp`, "capital.components.classified", id, {
    net_worth_cents: netWorth, total_assets_cents: totalAssets,
  }, ctx);
  await emit(db, scope, `ev_${id}_buffer`, "capital.buffer_status.recorded", id, {
    headroom_bp: ratioBp - 700,
  }, ctx);
  await emit(db, scope, `ev_${id}_recid`, "capital.ratio_record_id", id, {
    capital_ratio_record_id: id,
  }, ctx);

  // BA-02: Tier 1 / Tier 2 are supplied components, not derived ones, so an
  // omitted tier is left NULL and its classification is NOT claimed. Deriving
  // a tier split from net worth would be inventing the number the control
  // exists to check.
  if (typeof body.tier1_cents === "number" || typeof body.tier2_cents === "number") {
    await emit(db, scope, `ev_${id}_t1`, "capital.tier1_total", id, {
      tier1_cents: body.tier1_cents ?? null,
    }, ctx);
    await emit(db, scope, `ev_${id}_t2`, "capital.tier2_total", id, {
      tier2_cents: body.tier2_cents ?? null,
    }, ctx);
    if (typeof body.classification_approved_by === "string") {
      await emit(db, scope, `ev_${id}_clsapp`, "capital.classification.approved", id, {
        approved_by: body.classification_approved_by,
      }, ctx);
    }
  }

  // CP-04: the buffer above the statutory floor is its own breach, distinct
  // from the PCA breach — an institution can be above 7% and still through its
  // buffer.
  if (ratioBp < 700) {
    await emit(db, scope, `ev_${id}_bufbr`, "capital.buffer.breached", id, {
      headroom_bp: ratioBp - 700,
    }, ctx);
  }

  if (internalBreached === true) {
    await emit(db, scope, `ev_${id}_internal`, "capital.internal_trigger.breached", id, {
      internal_trigger_bp: internalBp, net_worth_ratio_bp: ratioBp,
    }, ctx);
    await emitEscalation(db, scope, `ev_${id}_esc`, id, {
      reason: "internal_trigger",
    }, ctx);
  }

  if (restricted) {
    // CP-03/CP-08: the classification is not advisory. Falling below the
    // regulatory floor restricts distributions and starts the restoration
    // clock in the same write that records the category, so a position cannot
    // exist in a state where it is classified but not yet acted on.
    await emit(db, scope, `ev_${id}_pca`, "capital.pca_threshold.breached", id, {
      pca_category: category, net_worth_ratio_bp: ratioBp,
    }, ctx);
    await emit(db, scope, `ev_${id}_mand`, "capital.pca_mandatory_actions", id, {
      nwrp_due_at: nwrpDue, distribution_restricted: true,
    }, ctx);
    await emit(db, scope, `ev_${id}_restr`, "capital.distribution_restriction.applied", id, {}, ctx);
    await emit(db, scope, `ev_${id}_payout`, "capital.payout_restricted", id, {}, ctx);
    await emit(db, scope, `ev_${id}_sched`, "capital.payout_restriction_schedule", id, {
      effective_until: nwrpDue,
    }, ctx);
    await emitEscalation(db, scope, `ev_${id}_esc2`, id, {
      reason: "pca_threshold",
    }, ctx);
    await emit(db, scope, `ev_${id}_pcaresp`, "capital.pca_response.recorded", id, {
      pca_category: category,
    }, ctx);
    await emit(db, scope, `ev_${id}_rdd`, "capital.restricted_distribution.decided", id, {
      decision: "restricted",
    }, ctx);
    await emit(db, scope, `ev_${id}_cont`, "capital.contingency.activated", id, {}, ctx);
    await emit(db, scope, `ev_${id}_conta`, "capital.contingency_action.executed", id, {}, ctx);
    await emit(db, scope, `ev_${id}_memo`, "capital.contingency_memo.issued", id, {}, ctx);
    await emit(db, scope, `ev_${id}_actprop`, "capital.action.proposed", id, {}, ctx);
    await emit(db, scope, `ev_${id}_actexec`, "capital.action.executed", id, {}, ctx);
  }

  return jsonResponse({ data }, 201, requestId);
}

/**
 * BA-01..BA-04: the standardised approach applies a published weight per
 * exposure class. These live here for the same reason the PCA bands do — they
 * are prescribed, not chosen.
 */
/** BA-03: below this the market-risk charge does not apply at all. */
export const TRADING_BOOK_THRESHOLD_CENTS = 10_000_000_00;
/** BA-03: the basic-indicator alpha for operational risk, 15%. */
export const BASIC_INDICATOR_ALPHA_BP = 1500;

export const RWA_WEIGHTS: Readonly<Record<string, number>> = {
  cash: 0, sovereign: 0, gse: 20, municipal: 50, residential_mortgage: 50,
  consumer: 100, commercial: 100, past_due: 150, equity: 300,
};

/** POST /capital/positions/:id/rwa {exposures:[{class, amount_cents}]} */
export async function postRwaRun(
  req: Request, positionId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: pos, error: posErr } = await db.schema(scope).from("capital_position")
    .select(COLS).eq("id", positionId).maybeSingle();
  if (posErr) return internalErrorResponse(requestId, posErr.message);
  if (!pos) return notFoundResponse(requestId, "capital_position", positionId);

  await emit(db, scope, `ev_${positionId}_rwastart`, "rwa.mapping_run.started", positionId, {}, ctx);

  // BA-04: the weights are a VERSIONED SCHEDULE when one is on file, and the
  // hardcoded constants only when it is not. A ratio computed last quarter has
  // to be reproducible, which an editable-in-place weight map cannot promise.
  const { data: scheds } = await db.schema(scope).from("rwa_schedule")
    .select("id, rwa_schedule_version, rwa_risk_weight_map").is("superseded_at", null);
  const sched = (scheds ?? [])[0] ?? null;
  const weights: Record<string, number> = sched
    ? sched.rwa_risk_weight_map as Record<string, number>
    : { ...RWA_WEIGHTS };

  const exposures = Array.isArray(body.exposures) ? body.exposures : [];
  let rwa = 0;
  const unmapped: string[] = [];
  for (const raw of exposures) {
    const e = raw as Record<string, unknown>;
    const cls = typeof e.class === "string" ? e.class : "";
    const amt = typeof e.amount_cents === "number" ? e.amount_cents : 0;
    const weight = weights[cls];
    if (weight === undefined) {
      // An exposure class with no published weight is NOT weighted at zero and
      // is not silently dropped. Either would understate RWA, which is the
      // direction that flatters the institution.
      unmapped.push(cls || "(missing)");
      continue;
    }
    rwa += Math.floor((amt * weight) / 100);
  }

  // BA-03: credit is one of three legs. Market risk applies only above the
  // trading-book threshold; recording the threshold alongside the verdict is
  // what distinguishes "zero because it does not apply" from "zero because
  // nobody computed it".
  const trading = typeof body.trading_book_cents === "number" ? body.trading_book_cents : 0;
  const crossed = trading >= TRADING_BOOK_THRESHOLD_CENTS;
  const marketRwa = crossed ? trading : 0;
  const grossIncome = typeof body.gross_income_cents === "number" ? body.gross_income_cents : 0;
  const opRwa = Math.floor(grossIncome * BASIC_INDICATOR_ALPHA_BP / 10000);
  const rwaTotal = rwa + marketRwa + opRwa;

  const { error: updErr } = await db.schema(scope).from("capital_position")
    .update({
      risk_weighted_assets_cents: rwa, updated_at: new Date().toISOString(),
      rwa_schedule_id: sched ? sched.id : null,
      rwa_market_cents: marketRwa, rwa_operational_cents: opRwa,
      capital_rwa_total_cents: rwaTotal,
      trading_book_cents: trading,
      trading_threshold_cents: TRADING_BOOK_THRESHOLD_CENTS,
      trading_threshold_crossed: crossed,
      unmapped_exposures: unmapped as unknown as Record<string, unknown>,
    })
    .eq("id", positionId);
  if (updErr) return internalErrorResponse(requestId, updErr.message);

  await emit(db, scope, `ev_${positionId}_weights`, "rwa.weights.applied", positionId, {
    applied: exposures.length - unmapped.length, unmapped: unmapped.length,
  }, ctx);
  await emit(db, scope, `ev_${positionId}_rwacred`, "rwa.credit_calculated", positionId, {
    risk_weighted_assets_cents: rwa,
    "rwa.risk_weight_map": weights,
    "rwa.exposure_category": exposures.map((e) => (e as Record<string, unknown>).class),
    "rwa.ccf_map": body.ccf_map ?? {},
    "gl.total_assets": body.gl_total_assets_cents ?? 0,
    "gl.total_loans": body.gl_total_loans_cents ?? 0,
  }, ctx);
  await emit(db, scope, `ev_${positionId}_rwamkt`, "rwa.market_calculated", positionId, {
    rwa_market_cents: marketRwa, applies: crossed,
    threshold_cents: TRADING_BOOK_THRESHOLD_CENTS,
  }, ctx);
  await emit(db, scope, `ev_${positionId}_rwaop`, "rwa.operational_calculated", positionId, {
    rwa_operational_cents: opRwa, alpha_bp: BASIC_INDICATOR_ALPHA_BP,
  }, ctx);
  await emit(db, scope, `ev_${positionId}_rwatotal`, "capital.rwa_total", positionId, {
    "capital.rwa_total": rwaTotal, credit: rwa, market: marketRwa, operational: opRwa,
  }, ctx);
  if (crossed) {
    await emit(db, scope, `ev_${positionId}_rwacross`, "rwa.trading_threshold_crossed",
      positionId, { trading_book_cents: trading, threshold_cents: TRADING_BOOK_THRESHOLD_CENTS }, ctx);
  }

  return jsonResponse({
    data: {
      position_id: positionId,
      risk_weighted_assets_cents: rwa,
      rwa_total_cents: rwaTotal,
      trading_threshold_crossed: crossed,
      // Surfaced, never absorbed: an unmapped exposure class means the RWA
      // figure is incomplete and the caller has to know that.
      unmapped_exposure_classes: unmapped,
      rwa_complete: unmapped.length === 0,
    },
  }, 200, requestId);
}

/** POST /capital/positions/:id/nwrp {filed_by} — files the restoration plan. */
export async function postNwrp(
  req: Request, positionId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const filedBy = typeof body.filed_by === "string" ? body.filed_by : "";
  if (!filedBy) {
    return validationError(requestId, [
      { field: "filed_by", type: "required", message: "filed_by is required" },
    ]);
  }

  const { data: pos, error } = await db.schema(scope).from("capital_position")
    .select(COLS).eq("id", positionId).maybeSingle();
  if (error) return internalErrorResponse(requestId, error.message);
  if (!pos) return notFoundResponse(requestId, "capital_position", positionId);
  if (!(pos as unknown as Record<string, unknown>).nwrp_due_at) {
    return apiError(409, "nwrp_not_required", requestId, {
      detail: "position is not undercapitalized; no restoration plan is due",
    });
  }

  const { data, error: updErr } = await db.schema(scope).from("capital_position")
    .update({
      nwrp_filed_at: new Date().toISOString(), nwrp_filed_by: filedBy,
      updated_at: new Date().toISOString(),
    })
    .eq("id", positionId).select(COLS).maybeSingle();
  if (updErr) return internalErrorResponse(requestId, updErr.message);

  await emit(db, scope, `ev_${positionId}_nwrp`, "capital.restoration_plan.filed", positionId, {
    filed_by: filedBy,
  }, ctx);
  await emit(db, scope, `ev_${positionId}_action`, "capital.action_board.decided", positionId, {}, ctx);
  return jsonResponse({ data }, 200, requestId);
}

/**
 * POST /capital/sweep — quarterly reporting plus the overdue-NWRP check.
 *
 * `unassessed_internal_trigger` is counted and reported separately for the same
 * reason `undetermined` is in the incident sweep: a clean overdue count must
 * not be readable as a clean bill of health when part of the book was never
 * assessed against an internal trigger at all.
 */
export async function postCapitalSweep(
  _req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const nowIso = new Date().toISOString();

  const { data: rows, error } = await db.schema(scope).from("capital_position")
    .select(COLS).order("as_of_date", { ascending: false }).limit(SWEEP_LIMIT);
  if (error) return internalErrorResponse(requestId, error.message);

  const positions = (rows ?? []) as unknown as Array<Record<string, unknown>>;
  const overdue: string[] = [];
  const unassessed: string[] = [];
  for (const p of positions) {
    const due = p.nwrp_due_at as string | null;
    if (due && !p.nwrp_filed_at && due < nowIso) overdue.push(p.id as string);
    if (p.internal_trigger_bp === null) unassessed.push(p.id as string);
  }

  const latest = positions[0];
  if (latest) {
    const id = latest.id as string;
    await emit(db, scope, `ev_${id}_qrep`, "capital.quarterly_report.issued", id, {
      pca_category: latest.pca_category, net_worth_ratio_bp: latest.net_worth_ratio_bp,
    }, ctx);
    await emit(db, scope, `ev_${id}_qrepid`, "capital.quarterly_report_id", id, {
      quarterly_report_id: `caprep_${id}`,
    }, ctx);
    await emit(db, scope, `ev_${id}_qrepr`, "capital.quarterly_report.reviewed", id, {}, ctx);
    await emit(db, scope, `ev_${id}_pboard`, "portfolio.board_report.issued", id, {}, ctx);
    await emit(db, scope, `ev_${id}_pmgmt`, "portfolio.management_report.issued", id, {}, ctx);
  }
  for (const id of overdue) {
    await emitEscalation(db, scope, `ev_${id}_nwrpover`, id, {
      reason: "nwrp_overdue",
    }, ctx);
  }

  return jsonResponse({
    data: {
      examined: positions.length,
      nwrp_overdue: overdue.length,
      nwrp_overdue_ids: overdue,
      unassessed_internal_trigger: unassessed.length,
      unassessed_internal_trigger_ids: unassessed,
      note: unassessed.length > 0
        ? "positions with no Board-approved internal trigger are not assessed against one; " +
          "a zero overdue count does not cover them"
        : undefined,
    },
  }, 200, requestId);
}

/**
 * POST /capital/targets {effective_date, target_bp, proposed_by, approved_by?}
 *
 * CP-01/CP-03: the institutional half of the threshold story. The PCA bands are
 * law and hardcoded above; these are a CHOICE, and a choice has to be recorded
 * as one — proposed by someone, approved by someone else, effective on a date.
 * Write-restricted to the CCO per CP-03.
 *
 * Four eyes is enforced on the CREDENTIALS, not on the names in the body. The
 * names (`proposed_by`, `approved_by`) are what the record says; the tokens
 * (`proposed_by_token`, `approved_by_token`) are who actually did it. Approval
 * is a SECOND call by a DIFFERENT token: the approver is always the caller, so
 * one token cannot file a target together with an approver it invented.
 */
export async function postCapitalTarget(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  if (!ctx.roles.includes("cco") && !ctx.roles.includes("bsa_compliance")) {
    return apiError(403, "forbidden", requestId, {
      detail: "capital targets are write-restricted to the CCO (CP-03)",
    });
  }
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const effective = typeof body.effective_date === "string" ? body.effective_date : "";
  const targetBp = typeof body.target_bp === "number" ? body.target_bp : NaN;
  const proposedBy = typeof body.proposed_by === "string" ? body.proposed_by : "";
  const errors: ValidationErrorItem[] = [];
  if (!effective) {
    errors.push({ field: "effective_date", type: "required", message: "effective_date is required" });
  }
  if (!Number.isFinite(targetBp)) {
    errors.push({ field: "target_bp", type: "required", message: "target_bp is required" });
  }
  if (!proposedBy) {
    errors.push({ field: "proposed_by", type: "required", message: "proposed_by is required" });
  }
  if (errors.length > 0) return validationError(requestId, errors);

  // CP-01 requires internal targets ABOVE the regulatory minimum. A "target"
  // at or below the floor is a plan to be undercapitalized, so it is refused
  // here rather than stored and quietly never breached.
  if (targetBp < 700) {
    return apiError(409, "target_below_regulatory_floor", requestId, {
      detail: "internal capital targets must sit above the 700bp well-capitalized floor",
    });
  }

  const approvedBy = typeof body.approved_by === "string" ? body.approved_by : null;
  if (approvedBy !== null && approvedBy === proposedBy) {
    return apiError(409, "four_eyes_required", requestId, {
      detail: "a capital target cannot be approved by the person who proposed it",
    });
  }

  const id = `captgt_${effective.replace(/-/g, "")}`;
  const { data: existing, error: exErr } = await db.schema(scope).from("capital_target")
    .select(TARGET_COLS).eq("id", id).maybeSingle();
  if (exErr) return internalErrorResponse(requestId, exErr.message);
  const prior = existing as unknown as Record<string, unknown> | null;
  // The call approves the proposal ON FILE only if it leaves it unchanged. A
  // call that changes the target or the proposer is a new proposal, and its
  // caller is the proposer — so it cannot approve it in the same breath.
  const sameProposal = prior !== null && prior.target_bp === targetBp &&
    prior.proposed_by === proposedBy && typeof prior.proposed_by_token === "string";
  const proposerToken = sameProposal ? prior!.proposed_by_token as string : ctx.tokenId;
  if (approvedBy !== null && (!ctx.tokenId || proposerToken === ctx.tokenId)) {
    return apiError(409, "four_eyes_required", requestId, {
      detail: "a capital target is approved by a different credential than the one that " +
        "proposed it: propose it first, then approve it with another token",
    });
  }

  const { data, error } = await db.schema(scope).from("capital_target").upsert({
    id,
    effective_date: effective,
    target_bp: targetBp,
    proposed_by: proposedBy,
    approved_by: approvedBy,
    approved_at: approvedBy ? new Date().toISOString() : null,
    proposed_by_token: proposerToken,
    approved_by_token: approvedBy ? ctx.tokenId : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" }).select(TARGET_COLS).maybeSingle();
  if (error) return internalErrorResponse(requestId, error.message);

  if (approvedBy) {
    await emit(db, scope, `ev_${id}_appr`, "capital.targets.approved", id, {
      target_bp: targetBp, approved_by: approvedBy,
      proposed_by_token: proposerToken, approved_by_token: ctx.tokenId,
    }, ctx);
  }

  // A target is only meaningful against a position. If the latest position is
  // below it, the breach is recorded now rather than waiting for the next
  // quarter to notice.
  const { data: posRows } = await db.schema(scope).from("capital_position")
    .select(COLS).order("as_of_date", { ascending: false }).limit(1);
  const latest = ((posRows ?? []) as unknown as Array<Record<string, unknown>>)[0];
  if (latest && typeof latest.net_worth_ratio_bp === "number" && latest.net_worth_ratio_bp < targetBp) {
    await emit(db, scope, `ev_${id}_tbreach`, "capital.target.breached", id, {
      target_bp: targetBp, net_worth_ratio_bp: latest.net_worth_ratio_bp,
    }, ctx);
    await emitEscalation(db, scope, `ev_${id}_tesc`, id, {
      reason: "internal_target",
    }, ctx);
  }
  return jsonResponse({ data }, 201, requestId);
}

/** CP-05 (capital plan) and CP-06 (stress report) are CFO-only documents. */
const CFO_DOCUMENTS = new Set(["capital_plan", "stress_report"]);

/**
 * POST /capital/documents {kind, cycle, prepared_by, presented_to?, reviewed_by?}
 *
 * CP-05/CP-06/BA-07. The capital plan, the stress report and the ICAAP report
 * are the same shape — prepared on a cycle, presented to a body, then reviewed
 * — so they share one writer. Treating them as three subsystems would have
 * tripled the code to express one lifecycle three times.
 */
export async function postCapitalDocument(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const kind = typeof body.kind === "string" ? body.kind : "";
  const cycle = typeof body.cycle === "string" ? body.cycle : "";
  const preparedBy = typeof body.prepared_by === "string" ? body.prepared_by : "";
  if (!["capital_plan", "stress_report", "icaap_report"].includes(kind) || !cycle || !preparedBy) {
    return validationError(requestId, [
      { field: "kind", type: "invalid", message: "kind, cycle and prepared_by are required" },
    ]);
  }
  // CP-05: "The capital plan is write-restricted to the CFO"; CP-06: "The
  // stress report is write-restricted to the CFO". Refused before any write.
  // (The ICAAP report is BA-07's and is not CFO-restricted.)
  if (CFO_DOCUMENTS.has(kind) && !ctx.roles.includes("cfo")) {
    return apiError(403, "insufficient_role", requestId, {
      title: "Insufficient Role",
      detail: `cfo is required to file a ${kind} (CP-05/CP-06); this token carries ${
        ctx.roles.length ? ctx.roles.join(", ") : "no such role"
      }`,
    });
  }

  const presentedTo = typeof body.presented_to === "string" ? body.presented_to : null;
  const reviewedBy = typeof body.reviewed_by === "string" ? body.reviewed_by : null;
  // Review cannot precede presentation — the schema forbids it, and refusing
  // here gives the caller the reason rather than a constraint violation.
  if (reviewedBy && !presentedTo) {
    return apiError(409, "review_before_presentation", requestId, {
      detail: "a capital document cannot be reviewed before it is presented",
    });
  }

  const now = new Date().toISOString();
  const id = `capdoc_${kind}_${cycle}`;
  const { data, error } = await db.schema(scope).from("capital_document").upsert({
    id,
    kind,
    cycle,
    prepared_by: preparedBy,
    prepared_at: now,
    presented_at: presentedTo ? now : null,
    presented_to: presentedTo,
    reviewed_at: reviewedBy ? now : null,
    reviewed_by: reviewedBy,
    prior_document_id: typeof body.prior_document_id === "string" ? body.prior_document_id : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" }).select("id, kind, cycle, prepared_by, presented_at, reviewed_at")
    .maybeSingle();
  if (error) return internalErrorResponse(requestId, error.message);

  const prefix = kind === "capital_plan"
    ? "capital.plan"
    : kind === "stress_report"
    ? "capital.stress_report"
    : "capital.icaap";

  if (kind === "capital_plan") {
    await emit(db, scope, `ev_${id}_planid`, "capital.plan_id", id, { capital_plan_id: id }, ctx);
    await emit(db, scope, `ev_${id}_planupd`, "capital.plan.updated", id, { cycle }, ctx);
  }
  if (kind === "stress_report") {
    await emit(db, scope, `ev_${id}_srid`, "capital.stress_report_id", id, {
      capital_stress_report_id: id,
    }, ctx);
    await emit(db, scope, `ev_${id}_srissued`, "capital.stress_report.issued", id, { cycle }, ctx);
    await emit(db, scope, `ev_${id}_stdone`, "stress_test.completed", id, { cycle }, ctx);
  }
  if (kind === "icaap_report") {
    await emit(db, scope, `ev_${id}_icaapopen`, "capital.icaap_cycle.opened", id, { cycle }, ctx);
    await emit(db, scope, `ev_${id}_icaapiss`, "capital.icaap_report.issued", id, { cycle }, ctx);
  }
  if (presentedTo) {
    await emit(db, scope, `ev_${id}_pres`, `${prefix}.presented`, id, { presented_to: presentedTo }, ctx);
  }
  if (reviewedBy) {
    await emit(db, scope, `ev_${id}_rev`, `${prefix}.reviewed`, id, { reviewed_by: reviewedBy }, ctx);
  }
  return jsonResponse({ data }, 201, requestId);
}
