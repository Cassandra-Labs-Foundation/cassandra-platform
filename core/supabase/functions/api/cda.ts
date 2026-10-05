// Charitable Donation Accounts — CDA-01..CDA-14, 12 CFR 721.3(b)(2).
//
// WHY THERE IS ONE GATE AND NOT FOUR CHECKS.
//
// §721.3(b)(2) is a CONJUNCTION. Failing any single condition — segregation,
// the four agreement clauses, the 5% cap, an unexpired Board adoption —
// forfeits Part 703 relief for the whole account, not for the condition that
// failed. Four controls (CDA-01, CDA-03, CDA-05, CDA-06) each declare
// `cda.funding_gate_evaluated`, which invites four independent checks at four
// call sites. That shape fails the way runGate's sweeps would fail if they were
// partner-scoped: each check passes on its own terms while the conjunction is
// never actually evaluated.
//
// So there is ONE `evaluateFundingGate`. It evaluates every condition on every
// request and returns each verdict separately, so a refusal names the condition
// that failed rather than reporting a generic block.
//
// WHY THE CAP TEST IS PROJECTED. See the migration header: testing the CURRENT
// aggregate and then recording the funding permits every breach exactly once.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor } from "./bsa.ts";
import {
  apiError, internalErrorResponse, isNonEmptyString, jsonResponse, notFoundResponse,
  parseJsonBody, validationError, type ValidationErrorItem,
} from "./lib.ts";

/**
 * §721.3(b)(2)(iii): aggregate CDA book value may not exceed 5% of net worth.
 * Statutory, so hardcoding it is a lookup rather than a fabrication — the same
 * distinction the PCA bands turn on in capital.ts.
 */
export const CAP_LIMIT_BP = 500;

/**
 * The internal buffer below the statutory cap is the opposite kind of number:
 * PATRICK_NOTES gives 4% as a DEFAULT and CDA-06 puts the real value under
 * Board approval. It is therefore a parameter with a documented default, not a
 * constant, and the value used is recorded on every test so a later Board
 * decision does not silently rewrite history.
 */
export const DEFAULT_BUFFER_BP = 400;

/** CDA-11: distributions at or above $5,000 require a second approver. */
export const DUAL_APPROVAL_THRESHOLD_CENTS = 500_00 * 10; // $5,000

/** CDA-08 §721.3(b)(2)(iv): at least 51% of Total Return, every five years. */
export const MIN_DISTRIBUTION_COVERAGE_BP = 5100;

const CAP_CURE_DAYS = 30;
const TERMINATION_REPORT_DAYS = 30;
/** CDA-04 / CDA-10: material vendor issues escalate within 2 business days. */
const VENDOR_ESCALATION_DAYS = 2;
/** CDA-13: affiliate-fee conflicts escalate within 5 business days. */
const CONFLICT_ESCALATION_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

// deno-lint-ignore no-explicit-any
type Any = any;

function requireInternalActor(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/cda");
  return null;
}

async function emit(
  db: SupabaseClient, scope: EvidenceScope, id: string, code: string,
  resourceId: string, payload: Record<string, unknown>, ctx?: PartnerContext,
): Promise<void> {
  const { error } = await db.schema(scope).from("event").upsert({
    id, code, resource_type: "cda", resource_id: `cda:${resourceId}`,
    payload, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`cda event (${code}): ${error.message}`);
}

function plusDays(from: Date, days: number): string {
  return new Date(from.getTime() + days * DAY_MS).toISOString();
}

// ------------------------------------------------------------ CDA-01 policy

/**
 * The programme's adoption state. CDA-01 says an expired policy blocks
 * funding, trades and distributions — so this is read by the gate rather than
 * reported in a packet.
 *
 * ORDERING: the active adoption is the one with the LATEST `adopted_at`, not
 * the most recently inserted row. Two adoptions recorded in the same
 * millisecond (a backfill, a replayed request) would otherwise be ordered
 * arbitrarily and the gate could read a superseded expiry. Fourth instance of
 * the ordering-assumption class; see BLUEPRINT §5g.
 */
export async function activePolicy(
  db: SupabaseClient, scope: EvidenceScope,
): Promise<Record<string, Any> | null> {
  const { data, error } = await db.schema(scope).from("cda_policy")
    .select("id, policy_version, adopted_at, policy_expiry_at, superseded_at, board_resolution_id")
    .is("superseded_at", null)
    .order("adopted_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`cda_policy: ${error.message}`);
  return (data ?? [])[0] ?? null;
}

/**
 * Is the CDA programme permitted to act at all?
 *
 * Returns the reason it is NOT, or null. NO ADOPTION AT ALL is treated the same
 * as an EXPIRED one: a programme nobody has adopted has not satisfied CDA-01
 * either, and defaulting an absent adoption to "permitted" would make the whole
 * control unreachable on a fresh instance — the state it is most likely to be
 * in when someone first funds a CDA.
 */
export async function programmeBlockReason(
  db: SupabaseClient, scope: EvidenceScope, now: Date,
): Promise<string | null> {
  const p = await activePolicy(db, scope);
  if (!p) return "policy_not_adopted";
  if (new Date(String(p.policy_expiry_at)).getTime() <= now.getTime()) return "policy_expired";
  return null;
}

/** POST /cda/policy {policy_version, board_resolution_id, adopted_at?, term_months?} */
export async function postCdaPolicyAdoption(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const errors: ValidationErrorItem[] = [];
  if (!isNonEmptyString(body.policy_version)) {
    errors.push({ type: "missing_field", field: "policy_version", message: "is required" });
  }
  if (!isNonEmptyString(body.board_resolution_id)) {
    // CDA-01 names the prior board resolution as a required input. An adoption
    // with no resolution behind it is the assertion the control exists to check.
    errors.push({ type: "missing_field", field: "board_resolution_id", message: "is required" });
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const adoptedAt = isNonEmptyString(body.adopted_at) ? new Date(body.adopted_at) : new Date();
  const termMonths = typeof body.term_months === "number" ? body.term_months : 12;
  const expires = new Date(adoptedAt.getTime());
  expires.setUTCMonth(expires.getUTCMonth() + termMonths);

  // supersede the prior adoption rather than leaving two live ones
  const prior = await activePolicy(db, scope);
  if (prior) {
    await db.schema(scope).from("cda_policy")
      .update({ superseded_at: adoptedAt.toISOString() }).eq("id", prior.id);
  }

  const id = `cdapol_${String(body.policy_version).replace(/[^a-zA-Z0-9]/g, "")}`;
  const { data, error } = await db.schema(scope).from("cda_policy").upsert({
    id,
    policy_version: body.policy_version,
    board_resolution_id: body.board_resolution_id,
    adopted_at: adoptedAt.toISOString(),
    policy_expiry_at: expires.toISOString(),
    // re-recording an adoption reactivates it; leaving this out would let an
    // upsert of the same version silently inherit the supersession set above
    superseded_at: null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" }).select("id, policy_version, adopted_at, policy_expiry_at").maybeSingle();
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_adopt`, "cda.board_decision.recorded", id, {
    policy_version: body.policy_version,
    board_resolution_id: body.board_resolution_id,
    policy_expiry_at: expires.toISOString(),
  }, ctx);

  return jsonResponse({ data }, 201, requestId);
}

/**
 * POST /cda/policy/sweep
 *
 * CDA-01's negative half. A lapse is not self-announcing: nothing happens at
 * the moment a policy expires, so without a sweep the programme keeps
 * operating and the escalation is only produced if someone tries to fund. The
 * sweep exists so the ESCALATION is driven by the expiry rather than by the
 * next transaction.
 */
export async function postCdaPolicySweep(
  _req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;

  const now = new Date();
  const reason = await programmeBlockReason(db, scope, now);
  if (!reason) return jsonResponse({ data: { blocked: false } }, 200, requestId);

  const p = await activePolicy(db, scope);
  const id = p ? String(p.id) : "cdapol_none";
  await emit(db, scope, `ev_${id}_expired`, "cda.policy.expired", id, {
    reason, policy_expiry_at: p?.policy_expiry_at ?? null,
  }, ctx);
  await emit(db, scope, `ev_${id}_blocked`, "cda.actions.blocked", id, { reason }, ctx);
  await emit(db, scope, `ev_${id}_esc`, "cda.board_escalation.issued", id, {
    reason, actions_blocked: true,
  }, ctx);

  return jsonResponse({ data: { blocked: true, reason } }, 200, requestId);
}

// ------------------------------------------------------------ CDA-04 vendor

const QUALIFIED_REGULATORS = new Set(["sec", "occ", "state_banking", "ncua"]);

/**
 * §721.3(b)(2)(ii). Qualification is DERIVED, never supplied. A caller-supplied
 * `qualified: true` would make the control a formality — the whole obligation
 * is to check the claim against the registration evidence.
 */
export function deriveVendorQualification(
  regulator: string | null, status: string, evidenceRef: string | null,
): { qualified: boolean; reason: string | null } {
  if (!regulator || !QUALIFIED_REGULATORS.has(regulator)) {
    return { qualified: false, reason: "regulator_not_recognised" };
  }
  if (status !== "active") return { qualified: false, reason: `registration_${status}` };
  if (!evidenceRef) return { qualified: false, reason: "no_registration_evidence" };
  return { qualified: true, reason: null };
}

/** POST /cda/vendors {name, role, regulator, registration_status, registration_evidence_ref} */
export async function postCdaVendor(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const errors: ValidationErrorItem[] = [];
  if (!isNonEmptyString(body.name)) {
    errors.push({ type: "missing_field", field: "name", message: "is required" });
  }
  if (body.role !== "trustee" && body.role !== "discretionary_manager") {
    errors.push({
      type: "invalid_value", field: "role",
      message: "must be 'trustee' or 'discretionary_manager'",
    });
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const regulator = isNonEmptyString(body.regulator) ? body.regulator : null;
  const status = isNonEmptyString(body.registration_status) ? body.registration_status : "unknown";
  const evidence = isNonEmptyString(body.registration_evidence_ref)
    ? body.registration_evidence_ref
    : null;
  const { qualified, reason } = deriveVendorQualification(regulator, status, evidence);

  const now = new Date();
  const id = `cdaven_${String(body.name).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  const { data, error } = await db.schema(scope).from("cda_vendor").upsert({
    id,
    name: body.name,
    role: body.role,
    regulator,
    registration_status: status,
    registration_evidence_ref: evidence,
    qualified,
    disqualified_reason: reason,
    last_reviewed_at: now.toISOString(),
    review_due_at: plusDays(now, 365),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" }).select("id, name, qualified, disqualified_reason").maybeSingle();
  if (error) return internalErrorResponse(requestId, error.message);

  if (qualified) {
    await emit(db, scope, `ev_${id}_qual`, "cda.vendor_qualified", id, {
      regulator, registration_status: status,
    }, ctx);
  } else {
    // NOT qualified is the interesting outcome and it gets its own event. A
    // vendor that silently fails to qualify is indistinguishable from one
    // nobody assessed.
    await emit(db, scope, `ev_${id}_unqual`, "cda.vendor_issue.flagged", id, {
      vendor_issue_details: { reason, regulator, registration_status: status },
      vendor_registration_status: status,
    }, ctx);
  }
  return jsonResponse({ data }, 201, requestId);
}

/** POST /cda/vendors/:id/review {registration_status, registration_evidence_ref?} */
export async function postCdaVendorReview(
  req: Request, vendorId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: v, error: vErr } = await db.schema(scope).from("cda_vendor")
    .select("id, name, role, regulator, registration_status, registration_evidence_ref, qualified")
    .eq("id", vendorId).maybeSingle();
  if (vErr) return internalErrorResponse(requestId, vErr.message);
  if (!v) return notFoundResponse(requestId, "cda_vendor", vendorId);

  const status = isNonEmptyString(body.registration_status)
    ? body.registration_status
    : String(v.registration_status);
  const evidence = isNonEmptyString(body.registration_evidence_ref)
    ? body.registration_evidence_ref
    : (v.registration_evidence_ref as string | null);
  const { qualified, reason } = deriveVendorQualification(
    v.regulator as string | null, status, evidence,
  );

  const now = new Date();
  const lapsed = v.qualified === true && !qualified;

  const { error } = await db.schema(scope).from("cda_vendor").update({
    registration_status: status,
    registration_evidence_ref: evidence,
    qualified,
    disqualified_reason: reason,
    last_reviewed_at: now.toISOString(),
    review_due_at: plusDays(now, 365),
    updated_at: now.toISOString(),
  }).eq("id", vendorId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${vendorId}_rev_${crypto.randomUUID()}`, "cda.vendor_review.completed",
    vendorId, { registration_status: status, revalidated: qualified }, ctx);

  if (lapsed) {
    // CDA-04: a lapse detected on review escalates to the Board within 2
    // business days. The DEADLINE is carried on the event because there is no
    // separate escalation table — the due date is the enforceable part.
    await emit(db, scope, `ev_${vendorId}_lapse`, "cda.vendor_registration_lapsed", vendorId, {
      previous_status: v.registration_status, new_status: status,
    }, ctx);
    await emit(db, scope, `ev_${vendorId}_venesc`, "cda.board_escalation.issued", vendorId, {
      reason: "vendor_registration_lapsed",
      vendor_issue_details: {
        previous_status: v.registration_status, new_status: status, vendor_id: vendorId,
      },
      escalation_due_at: plusDays(now, VENDOR_ESCALATION_DAYS),
    }, ctx);
  }
  return jsonResponse({ data: { id: vendorId, qualified, reason } }, 200, requestId);
}

// --------------------------------------------------- CDA-03 / CDA-05 the CDA

/** POST /cda {id?, vendor_id?, structure_type, account_label, custodian_statement_ref} */
export async function postCda(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const errors: ValidationErrorItem[] = [];
  if (body.structure_type !== "segregated_custodial" && body.structure_type !== "spe_trust") {
    errors.push({
      type: "invalid_value", field: "structure_type",
      message: "must be 'segregated_custodial' or 'spe_trust'",
    });
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const label = isNonEmptyString(body.account_label) ? body.account_label : null;
  const custodian = isNonEmptyString(body.custodian_statement_ref)
    ? body.custodian_statement_ref
    : null;

  // §721.3(b)(2)(i) requires the account be "properly designated as a
  // charitable donation account". A label that does not say so is a label, not
  // a designation, so it does not complete the packet.
  const labelDesignates = label !== null && /charitable donation account/i.test(label);
  const packetComplete = labelDesignates && custodian !== null;

  const now = new Date();
  const id = isNonEmptyString(body.id) ? body.id : `cda_${crypto.randomUUID()}`;
  const { data, error } = await db.schema(scope).from("cda").upsert({
    id,
    vendor_id: isNonEmptyString(body.vendor_id) ? body.vendor_id : null,
    structure_type: body.structure_type,
    account_label: label,
    custodian_statement_ref: custodian,
    evidence_packet_filed_at: packetComplete ? now.toISOString() : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" })
    .select("id, structure_type, account_label, evidence_packet_filed_at, status, book_value_cents")
    .maybeSingle();
  if (error) return internalErrorResponse(requestId, error.message);

  if (packetComplete) {
    await emit(db, scope, `ev_${id}_packet`, "cda.evidence_packet.filed", id, {
      structure_type: body.structure_type, account_label: label,
      custodian_statement: custodian,
    }, ctx);
  } else {
    await emit(db, scope, `ev_${id}_packetgap`, "cda.evidence_packet.incomplete", id, {
      structure_selected: true,
      account_label_designates: labelDesignates,
      custodian_statement_present: custodian !== null,
    }, ctx);
  }
  // CDA-03 declares the funding gate as its own consequence, so filing the
  // packet re-evaluates it rather than waiting for a funding request. The gate
  // state is a property of the account, not of the request.
  await evaluateAndRecordGate(db, scope, id, 0, null, ctx);

  return jsonResponse({ data }, 201, requestId);
}

const CLAUSES = [
  ["agreement_named_charities_clause", "A_named_qualified_charities"],
  ["agreement_strategy_clause", "B_investment_strategy_and_risk"],
  ["agreement_gaap_clause", "C_gaap_accounting"],
  ["agreement_distribution_clause", "D_distribution_frequency"],
] as const;

/**
 * POST /cda/:id/agreement {clauses:{...}, amendment?:{redline_ref, board_resolution_id}}
 *
 * CDA-05. The four clauses are validated INDIVIDUALLY and the agreement is
 * validated only if all four are — the refusal has to be able to say which
 * clause is missing, which a single `validated` boolean cannot.
 */
export async function postCdaAgreement(
  req: Request, cdaId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: rec, error: recErr } = await db.schema(scope).from("cda")
    .select("id, status").eq("id", cdaId).maybeSingle();
  if (recErr) return internalErrorResponse(requestId, recErr.message);
  if (!rec) return notFoundResponse(requestId, "cda", cdaId);

  // CDA-05: "Agreement amendments require Board re-approval before taking
  // effect." Refused BEFORE anything is written: checking after the update let
  // an unapproved amendment un-validate the agreement and rewrite its strategy
  // limits while the caller was told 400 (caught by the CDA partner-flow suite).
  const amendment = body.amendment as Record<string, unknown> | undefined;
  if (amendment && !isNonEmptyString(amendment.board_resolution_id)) {
    return validationError(requestId, [{
      type: "missing_field", field: "amendment.board_resolution_id",
      message: "an amendment cannot take effect without Board re-approval",
    }]);
  }

  const supplied = (body.clauses ?? {}) as Record<string, unknown>;
  const present: Record<string, boolean> = {};
  const missing: string[] = [];
  for (const [col, name] of CLAUSES) {
    const ok = supplied[col] === true;
    present[col] = ok;
    if (!ok) missing.push(name);
  }
  const allPresent = missing.length === 0;
  const now = new Date();

  // Clause (B) carries the agreement's strategy/risk parameters. They are
  // stored on validation because CDA-07's pre-trade check must consult the
  // AGREEMENT's limits and not only the Board's overlays — two different
  // sources of authority that the corpus names separately.
  const strategyLimits = (body.strategy_limits ?? {}) as Record<string, unknown>;
  const { error } = await db.schema(scope).from("cda").update({
    ...present,
    strategy_limits: strategyLimits,
    agreement_validated_at: allPresent ? now.toISOString() : null,
    updated_at: now.toISOString(),
  }).eq("id", cdaId);
  if (error) return internalErrorResponse(requestId, error.message);

  if (allPresent) {
    await emit(db, scope, `ev_${cdaId}_agr`, "cda.agreement.validated", cdaId, {
      clauses: CLAUSES.map(([, n]) => n),
    }, ctx);
  } else {
    await emit(db, scope, `ev_${cdaId}_agrgap`, "cda.agreement.clause_missing", cdaId, {
      missing,
    }, ctx);
  }

  // The board decision is recorded against the amendment (validated above).
  if (amendment) {
    await emit(db, scope, `ev_${cdaId}_amend`, "cda.board_decision.recorded", cdaId, {
      agreement_redline: amendment.agreement_redline ?? amendment.redline_ref ?? null,
      board_resolution_id: amendment.board_resolution_id,
    }, ctx);
  }

  await evaluateAndRecordGate(db, scope, cdaId, 0, null, ctx);
  return jsonResponse({
    data: { id: cdaId, agreement_validated: allPresent, missing_clauses: missing },
  }, 200, requestId);
}

// --------------------------------------------------------- CDA-06 / the gate

export interface GateVerdict {
  permitted: boolean;
  reasons: string[];
  projected_aggregate_cents: number;
  net_worth_cents: number;
  utilization_bp: number | null;
}

async function aggregateBookValue(
  db: SupabaseClient, scope: EvidenceScope,
): Promise<number> {
  const { data, error } = await db.schema(scope).from("cda")
    .select("id, book_value_cents, status").neq("status", "closed");
  if (error) throw new Error(`cda aggregate: ${error.message}`);
  return (data ?? []).reduce((n: number, r: Any) => n + Number(r.book_value_cents ?? 0), 0);
}

async function latestNetWorth(db: SupabaseClient, scope: EvidenceScope): Promise<number | null> {
  // Reuses the capital position rather than taking net worth as a parameter.
  // A cap test against a caller-supplied net worth is a cap test against
  // whatever number makes it pass.
  const { data, error } = await db.schema(scope).from("capital_position")
    .select("id, as_of_date, net_worth_cents")
    .order("as_of_date", { ascending: false }).limit(1);
  if (error) throw new Error(`capital_position: ${error.message}`);
  const row = (data ?? [])[0];
  return row ? Number(row.net_worth_cents) : null;
}

/**
 * THE gate. Every §721.3(b)(2) condition, evaluated together.
 *
 * `requestedCents` is added to the aggregate BEFORE the comparison. Testing the
 * current aggregate and then booking the funding lets the first breach through
 * every time, because the amount under test is not yet in the number being
 * tested.
 */
export async function evaluateFundingGate(
  db: SupabaseClient, scope: EvidenceScope, cdaId: string,
  requestedCents: number, bufferBp: number | null, now: Date,
): Promise<GateVerdict> {
  const reasons: string[] = [];

  const blocked = await programmeBlockReason(db, scope, now);
  if (blocked) reasons.push(blocked);

  const { data: rec } = await db.schema(scope).from("cda")
    .select("id, evidence_packet_filed_at, agreement_validated_at, vendor_id, status")
    .eq("id", cdaId).maybeSingle();
  if (!rec) {
    reasons.push("cda_not_found");
    return {
      permitted: false, reasons, projected_aggregate_cents: 0,
      net_worth_cents: 0, utilization_bp: null,
    };
  }
  if (!rec.evidence_packet_filed_at) reasons.push("evidence_packet_not_filed");
  if (!rec.agreement_validated_at) reasons.push("agreement_clauses_unvalidated");

  // CDA-04: an unqualified trustee/manager is its own forfeiture under
  // §721.3(b)(2)(ii), so it belongs in the same conjunction. A CDA with NO
  // vendor assigned is also refused — an unassigned manager is not a qualified
  // one, and treating absence as permission is the failure this gate exists to
  // avoid.
  if (!rec.vendor_id) {
    reasons.push("no_vendor_assigned");
  } else {
    const { data: v } = await db.schema(scope).from("cda_vendor")
      .select("id, qualified").eq("id", rec.vendor_id).maybeSingle();
    if (!v || v.qualified !== true) reasons.push("vendor_not_qualified");
  }

  const current = await aggregateBookValue(db, scope);
  const projected = current + Math.max(0, requestedCents);
  const netWorth = await latestNetWorth(db, scope);

  let utilization: number | null = null;
  if (netWorth === null || netWorth <= 0) {
    // No capital position means the cap CANNOT BE TESTED. That is not the same
    // as being under the cap, and reporting it as a pass would let the one
    // §721.3(b)(2) condition with a number attached be satisfied by the
    // absence of the number.
    reasons.push("net_worth_unknown");
  } else {
    utilization = Math.floor((projected * 10000) / netWorth);
    if (utilization > CAP_LIMIT_BP) reasons.push("cap_exceeded");
    else if (utilization > (bufferBp ?? DEFAULT_BUFFER_BP)) reasons.push("internal_buffer_exceeded");
  }

  return {
    permitted: reasons.length === 0,
    reasons,
    projected_aggregate_cents: projected,
    net_worth_cents: netWorth ?? 0,
    utilization_bp: utilization,
  };
}

async function evaluateAndRecordGate(
  db: SupabaseClient, scope: EvidenceScope, cdaId: string,
  requestedCents: number, bufferBp: number | null, ctx?: PartnerContext,
): Promise<GateVerdict> {
  const now = new Date();
  const verdict = await evaluateFundingGate(db, scope, cdaId, requestedCents, bufferBp, now);
  await emit(db, scope, `ev_${cdaId}_gate_${crypto.randomUUID()}`,
    "cda.funding_gate_evaluated", cdaId, {
      permitted: verdict.permitted,
      blocked_reasons: verdict.reasons,
      projected_aggregate_cents: verdict.projected_aggregate_cents,
      utilization_bp: verdict.utilization_bp,
    }, ctx);
  return verdict;
}

/** POST /cda/:id/fundings {amount_cents, buffer_bp?} */
export async function postCdaFunding(
  req: Request, cdaId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const amount = typeof body.amount_cents === "number" ? body.amount_cents : NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    return validationError(requestId, [{
      type: "invalid_value", field: "amount_cents", message: "must be greater than zero",
    }]);
  }
  const bufferBp = typeof body.buffer_bp === "number" ? body.buffer_bp : null;

  const verdict = await evaluateAndRecordGate(db, scope, cdaId, amount, bufferBp, ctx);
  if (verdict.reasons.includes("cda_not_found")) {
    return notFoundResponse(requestId, "cda", cdaId);
  }

  const now = new Date();
  const reqId = `cdafund_${cdaId}_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("cda_funding_request").upsert({
    id: reqId,
    cda_id: cdaId,
    amount_cents: amount,
    decision: verdict.permitted ? "permitted" : "blocked",
    blocked_reasons: verdict.reasons,
    projected_aggregate_cents: verdict.projected_aggregate_cents,
    net_worth_cents: verdict.net_worth_cents,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  if (!verdict.permitted) {
    return apiError(409, "cda_funding_blocked", requestId, {
      title: "CDA funding blocked",
      detail: `§721.3(b)(2) conditions not satisfied: ${verdict.reasons.join(", ")}`,
    });
  }

  // Only NOW is the money booked, after the projected test passed.
  const { data: rec } = await db.schema(scope).from("cda")
    .select("id, book_value_cents").eq("id", cdaId).maybeSingle();
  const newBook = Number(rec?.book_value_cents ?? 0) + amount;
  const { error: updErr } = await db.schema(scope).from("cda").update({
    book_value_cents: newBook, status: "funded", updated_at: now.toISOString(),
  }).eq("id", cdaId);
  if (updErr) return internalErrorResponse(requestId, updErr.message);

  await emit(db, scope, `ev_${reqId}_funded`, "cda.funding.executed", cdaId, {
    amount_cents: amount, book_value_cents: newBook,
  }, ctx);
  return jsonResponse({
    data: { id: reqId, decision: "permitted", book_value_cents: newBook },
  }, 201, requestId);
}

/** POST /cda/cap-tests {as_of_date, buffer_bp?, certified_by?} */
export async function postCdaCapTest(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const asOf = isNonEmptyString(body.as_of_date) ? body.as_of_date : null;
  if (!asOf) {
    return validationError(requestId, [{
      type: "missing_field", field: "as_of_date", message: "is required",
    }]);
  }

  const netWorth = await latestNetWorth(db, scope);
  if (netWorth === null || netWorth <= 0) {
    // Refusing is the point. A cap test with no net worth would have to either
    // invent one or report "not breached", and both are the same lie.
    return apiError(409, "cda_cap_test_unavailable", requestId, {
      title: "cap test cannot be run",
      detail: "no capital position is recorded, so aggregate/net worth cannot be computed",
    });
  }

  const aggregate = await aggregateBookValue(db, scope);
  const bufferBp = typeof body.buffer_bp === "number" ? body.buffer_bp : DEFAULT_BUFFER_BP;
  const utilization = Math.floor((aggregate * 10000) / netWorth);
  const capBreached = utilization > CAP_LIMIT_BP;
  const bufferBreached = utilization > bufferBp;
  // the excess is measured against the STATUTORY cap, not the internal buffer
  const excess = capBreached
    ? aggregate - Math.floor((netWorth * CAP_LIMIT_BP) / 10000)
    : 0;

  const now = new Date();
  const id = `cdacap_${String(asOf).replace(/-/g, "")}`;
  const { data, error } = await db.schema(scope).from("cda_cap_test").upsert({
    id,
    as_of_date: asOf,
    aggregate_book_value_cents: aggregate,
    net_worth_cents: netWorth,
    utilization_bp: utilization,
    buffer_bp: bufferBp,
    buffer_breached: bufferBreached,
    cap_breached: capBreached,
    excess_cents: excess,
    cure_due_at: capBreached ? plusDays(now, CAP_CURE_DAYS) : null,
    certified_by: isNonEmptyString(body.certified_by) ? body.certified_by : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" }).select("id, utilization_bp, cap_breached, excess_cents, cure_due_at")
    .maybeSingle();
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_test`, "cda.cap_test.completed", id, {
    aggregate_book_value_cents: aggregate, net_worth_cents: netWorth,
    utilization_bp: utilization, cap_buffer_pct: bufferBp / 100,
  }, ctx);
  await emit(db, scope, `ev_${id}_cert`, "cda.cap.certified", id, {
    certified_by: body.certified_by ?? null, cap_breached: capBreached,
  }, ctx);
  if (bufferBreached && !capBreached) {
    await emit(db, scope, `ev_${id}_buf`, "cda.cap_buffer.breached", id, {
      utilization_bp: utilization, buffer_bp: bufferBp,
    }, ctx);
  }
  if (capBreached) {
    await emit(db, scope, `ev_${id}_brch`, "cda.cap.breached", id, {
      cap_excess_amount: excess, cure_due_at: plusDays(now, CAP_CURE_DAYS),
    }, ctx);
  }
  return jsonResponse({ data }, 201, requestId);
}

/** POST /cda/cap-tests/:id/cure {cure_plan, aggregate_book_value_cents} */
export async function postCdaCapCure(
  req: Request, testId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: t, error: tErr } = await db.schema(scope).from("cda_cap_test")
    .select("id, net_worth_cents, cap_breached, cure_due_at, cured_at").eq("id", testId).maybeSingle();
  if (tErr) return internalErrorResponse(requestId, tErr.message);
  if (!t) return notFoundResponse(requestId, "cda_cap_test", testId);
  if (t.cap_breached !== true) {
    return apiError(409, "cda_cap_not_breached", requestId, {
      title: "nothing to cure", detail: "this cap test recorded no breach",
    });
  }
  if (!isNonEmptyString(body.cure_plan)) {
    return validationError(requestId, [{
      type: "missing_field", field: "cure_plan", message: "is required",
    }]);
  }

  // The cure is only a cure if the aggregate is ACTUALLY back under the cap.
  // Marking a breach cured on the strength of a plan is how a 30-day clock
  // gets stopped without the condition being fixed.
  const aggregate = await aggregateBookValue(db, scope);
  const utilization = Math.floor((aggregate * 10000) / Number(t.net_worth_cents));
  if (utilization > CAP_LIMIT_BP) {
    await emit(db, scope, `ev_${testId}_curefail`, "cda.cap_cure.insufficient", testId, {
      utilization_bp: utilization, cure_plan: body.cure_plan,
    }, ctx);
    return apiError(409, "cda_cap_still_breached", requestId, {
      title: "cure does not clear the breach",
      detail: `aggregate is still ${utilization}bp of net worth, above the ${CAP_LIMIT_BP}bp cap`,
    });
  }

  const now = new Date();
  const { error } = await db.schema(scope).from("cda_cap_test").update({
    cure_plan: body.cure_plan, cured_at: now.toISOString(), updated_at: now.toISOString(),
  }).eq("id", testId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${testId}_cured`, "cda.cap_breach_cured", testId, {
    utilization_bp: utilization, cure_plan: body.cure_plan,
    cured_within_deadline: t.cure_due_at ? now.toISOString() <= String(t.cure_due_at) : null,
  }, ctx);
  return jsonResponse({ data: { id: testId, cured: true, utilization_bp: utilization } }, 200, requestId);
}

// -------------------------------------------------------------- CDA-07 trade

/** PUT /cda/:id/overlays/:kind {limit_bp, approved_by} */
export async function putCdaOverlay(
  req: Request, cdaId: string, kind: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const limitBp = typeof body.limit_bp === "number" ? body.limit_bp : NaN;
  const errors: ValidationErrorItem[] = [];
  if (!Number.isFinite(limitBp) || limitBp <= 0) {
    errors.push({ type: "invalid_value", field: "limit_bp", message: "must be greater than zero" });
  }
  if (!isNonEmptyString(body.approved_by)) {
    // CDA-07's overlays are Board-approved, not chosen by whoever calls the
    // endpoint. An unapproved limit is not an overlay.
    errors.push({ type: "missing_field", field: "approved_by", message: "is required" });
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const id = `cdaovl_${cdaId}_${kind}`;
  const { data, error } = await db.schema(scope).from("cda_overlay").upsert({
    id, cda_id: cdaId, kind, limit_bp: limitBp, approved_by: body.approved_by,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" }).select("id, kind, limit_bp").maybeSingle();
  if (error) return internalErrorResponse(requestId, error.message);
  return jsonResponse({ data }, 200, requestId);
}

/**
 * POST /cda/:id/trades {issuer, sector?, amount_cents}
 *
 * CDA-07 pre-trade check. An UNASSESSED overlay blocks execution exactly as a
 * breach does: Part 703 relief does not apply to a compliant CDA, so these
 * overlays are the only limits there are, and "no limit configured" is not
 * "within limits". Same rule as the wire dual-control state — unknown is not
 * permission.
 */
export async function postCdaTrade(
  req: Request, cdaId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const amount = typeof body.amount_cents === "number" ? body.amount_cents : NaN;
  if (!isNonEmptyString(body.issuer) || !Number.isFinite(amount) || amount <= 0) {
    return validationError(requestId, [
      { type: "invalid_value", field: "issuer", message: "issuer and amount_cents are required" },
    ]);
  }

  const blocked = await programmeBlockReason(db, scope, new Date());
  if (blocked) {
    return apiError(409, "cda_actions_blocked", requestId, {
      title: "CDA actions blocked", detail: `CDA-01: ${blocked}`,
    });
  }

  const { data: rec } = await db.schema(scope).from("cda")
    .select("id, book_value_cents, strategy_limits").eq("id", cdaId).maybeSingle();
  if (!rec) return notFoundResponse(requestId, "cda", cdaId);

  const { data: overlays } = await db.schema(scope).from("cda_overlay")
    .select("id, kind, limit_bp").eq("cda_id", cdaId);
  const list = overlays ?? [];

  const book = Number(rec.book_value_cents ?? 0);
  const breached: string[] = [];
  let verdict: "within_limits" | "breach" | "unassessed";
  if (list.length === 0) {
    verdict = "unassessed";
  } else {
    // Concentration is the position AFTER the trade as a share of book value.
    // Measuring it before the trade is the same defect as the current-aggregate
    // cap test: every first breach is permitted.
    const exposureBp = book > 0 ? Math.floor((amount * 10000) / (book + amount)) : 10000;
    for (const o of list) {
      if (o.kind === "single_issuer" || o.kind === "sector") {
        if (exposureBp > Number(o.limit_bp)) breached.push(String(o.kind));
      }
    }
    verdict = breached.length > 0 ? "breach" : "within_limits";
  }

  const id = `cdatrd_${cdaId}_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("cda_trade").upsert({
    id, cda_id: cdaId, issuer: body.issuer,
    sector: isNonEmptyString(body.sector) ? body.sector : null,
    amount_cents: amount, pretrade_verdict: verdict,
    breached_overlays: breached, executed: verdict === "within_limits",
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_pre`, "cda.pretrade_check.completed", cdaId, {
    verdict, breached_overlays: breached, overlay_limits: list.length,
    strategy_limits: rec.strategy_limits ?? {},
    trade_details: { issuer: body.issuer, amount_cents: amount },
  }, ctx);

  if (verdict !== "within_limits") {
    return apiError(409, "cda_pretrade_blocked", requestId, {
      title: "trade blocked by pre-trade check",
      detail: verdict === "unassessed"
        ? "no Board-approved overlay limits are configured, so the trade cannot be cleared"
        : `overlay breach: ${breached.join(", ")}`,
    });
  }
  return jsonResponse({ data: { id, verdict } }, 201, requestId);
}

/** POST /cda/:id/posttrade-checks {period} — CDA-07's monthly confirmation. */
export async function postCdaPosttradeCheck(
  req: Request, cdaId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: trades } = await db.schema(scope).from("cda_trade")
    .select("id, issuer, amount_cents, executed, pretrade_verdict").eq("cda_id", cdaId);
  const executed = (trades ?? []).filter((t: Any) => t.executed === true);
  const { data: overlays } = await db.schema(scope).from("cda_overlay")
    .select("id, kind, limit_bp").eq("cda_id", cdaId);

  // A post-trade check with no overlays to check against is reported as
  // unassessed, not as compliant.
  const assessed = (overlays ?? []).length > 0;
  const composition: Record<string, number> = {};
  for (const t of executed) {
    composition[String(t.issuer)] = (composition[String(t.issuer)] ?? 0) + Number(t.amount_cents);
  }

  await emit(db, scope, `ev_${cdaId}_post_${body.period ?? "p"}`,
    "cda.posttrade_check.completed", cdaId, {
      period: body.period ?? null,
      assessed,
      portfolio_composition: composition,
      overlay_limits: (overlays ?? []).length,
      trades_reviewed: executed.length,
    }, ctx);
  return jsonResponse({ data: { assessed, trades_reviewed: executed.length } }, 200, requestId);
}

// ------------------------------------------------- CDA-08 / CDA-11 giving

/** POST /cda/:id/windows {opened_at, closes_at, total_return_cents} */
export async function postCdaDistributionWindow(
  req: Request, cdaId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const openedAt = isNonEmptyString(body.opened_at) ? body.opened_at : new Date().toISOString();
  const closesAt = isNonEmptyString(body.closes_at)
    ? body.closes_at
    : new Date(new Date(openedAt).getTime() + 5 * 365 * DAY_MS).toISOString();
  const totalReturn = typeof body.total_return_cents === "number" ? body.total_return_cents : 0;

  const id = `cdawin_${cdaId}_${new Date(openedAt).getTime()}`;
  const { data, error } = await db.schema(scope).from("cda_distribution_window").upsert({
    id, cda_id: cdaId, opened_at: openedAt, closes_at: closesAt,
    total_return_cents: totalReturn, distributed_cents: 0, coverage_bp: 0,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" }).select("id, opened_at, closes_at, total_return_cents").maybeSingle();
  if (error) return internalErrorResponse(requestId, error.message);

  await recomputeWindowCoverage(db, scope, id, ctx);
  return jsonResponse({ data }, 201, requestId);
}

/**
 * Recompute a window's coverage and raise the shortfall alert.
 *
 * Coverage is distributed / total return WITHIN THE WINDOW. A running total
 * over all history would let a generous early window mask a later one that
 * closed short — and §721.3(b)(2)(iv) is a per-window obligation, not a
 * lifetime one.
 */
async function recomputeWindowCoverage(
  db: SupabaseClient, scope: EvidenceScope, windowId: string, ctx?: PartnerContext,
): Promise<{ coverageBp: number; short: boolean }> {
  const { data: w } = await db.schema(scope).from("cda_distribution_window")
    .select("id, cda_id, opened_at, closes_at, total_return_cents, closed_at")
    .eq("id", windowId).maybeSingle();
  if (!w) return { coverageBp: 0, short: true };

  const { data: dists } = await db.schema(scope).from("cda_distribution")
    .select("id, window_id, amount_cents, decision").eq("window_id", windowId);
  const distributed = (dists ?? [])
    .filter((d: Any) => d.decision === "executed")
    .reduce((n: number, d: Any) => n + Number(d.amount_cents), 0);

  const totalReturn = Number(w.total_return_cents ?? 0);
  // A window with no Total Return has NO coverage ratio — 0/0 is not 100%.
  // Reporting it as covered would satisfy the control by having earned nothing.
  const coverageBp = totalReturn > 0 ? Math.floor((distributed * 10000) / totalReturn) : 0;
  const short = totalReturn > 0 && coverageBp < MIN_DISTRIBUTION_COVERAGE_BP;

  await db.schema(scope).from("cda_distribution_window").update({
    distributed_cents: distributed, coverage_bp: coverageBp,
    updated_at: new Date().toISOString(),
  }).eq("id", windowId);

  // A window OPENING at 0% coverage is not a shortfall — every window starts
  // there. Alerting on creation made "shortfall" mean "a window exists", which
  // is the alert-fatigue version of a vacuous green. The condition is a
  // shortfall that is either MEASURED (some giving has happened, so the ratio
  // says something) or RUNNING OUT (inside the last year of the window, where
  // the deadline is the risk). Both halves are needed: the second is what
  // catches a window where nobody ever distributed at all.
  const closesAt = new Date(String(w.closes_at)).getTime();
  const withinFinalYear = closesAt - new Date().getTime() <= 365 * DAY_MS;
  if (short && (distributed > 0 || withinFinalYear)) {
    // The coverage is part of the event id so that a window which improves and
    // then falls short again alerts a second time. A fixed id would collapse
    // every reassessment into the first one.
    await emit(db, scope, `ev_${windowId}_short_${coverageBp}`,
      "cda.distribution_window.alert", windowId, {
        coverage_bp: coverageBp,
        required_bp: MIN_DISTRIBUTION_COVERAGE_BP,
        distribution_shortfall:
          Math.ceil((totalReturn * MIN_DISTRIBUTION_COVERAGE_BP) / 10000) - distributed,
        window_close_at: w.closes_at,
        distributions_cumulative: distributed,
        total_return_cumulative: totalReturn,
      }, ctx);
  }
  return { coverageBp, short };
}

const VALID_IRS_STATUS = new Set(["501c3", "501c19"]);
/** A US EIN is nine digits, conventionally written NN-NNNNNNN. */
const EIN_RE = /^\d{2}-?\d{7}$/;

/**
 * POST /cda/:id/distributions
 * {donee_name, donee_ein, donee_irs_status, amount_cents, proposed_by,
 *  approved_by?, window_id?, kind?}
 *
 * CDA-08 and CDA-11 in one write, because they gate the same act. Validating
 * the donee in one endpoint and enforcing dual approval in another would allow
 * a distribution that satisfied each check at a different moment.
 */
export async function postCdaDistribution(
  req: Request, cdaId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const amount = typeof body.amount_cents === "number" ? body.amount_cents : NaN;
  const errors: ValidationErrorItem[] = [];
  if (!isNonEmptyString(body.donee_name)) {
    errors.push({ type: "missing_field", field: "donee_name", message: "is required" });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    errors.push({ type: "invalid_value", field: "amount_cents", message: "must be greater than zero" });
  }
  if (!isNonEmptyString(body.proposed_by)) {
    errors.push({ type: "missing_field", field: "proposed_by", message: "is required" });
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const ein = isNonEmptyString(body.donee_ein) ? body.donee_ein : null;
  const irsStatus = isNonEmptyString(body.donee_irs_status) ? body.donee_irs_status : "unknown";
  const proposedBy = String(body.proposed_by);
  const approvedBy = isNonEmptyString(body.approved_by) ? body.approved_by : null;
  const kind = body.kind === "closing" ? "closing" : "periodic";

  // §721.3(b)(2)(iv) / 26 USC 501: a Qualified Charity is one whose EIN AND
  // IRS status are both known. Either alone is an unvalidated donee.
  const einOk = ein !== null && EIN_RE.test(ein);
  const statusOk = VALID_IRS_STATUS.has(irsStatus);
  const doneeValidated = einOk && statusOk;

  const blockReasons: string[] = [];
  const programmeBlocked = await programmeBlockReason(db, scope, new Date());
  if (programmeBlocked) blockReasons.push(programmeBlocked);
  if (!doneeValidated) {
    blockReasons.push(!einOk ? "donee_ein_invalid" : `donee_irs_status_${irsStatus}`);
  }
  // CDA-11: two CALLS by one token is not two PEOPLE. Same finding as EPS-06.
  const needsDual = amount >= DUAL_APPROVAL_THRESHOLD_CENTS;
  if (needsDual && (!approvedBy || approvedBy === proposedBy)) {
    blockReasons.push(approvedBy ? "dual_approval_self_approved" : "dual_approval_missing");
  }

  // §721.3(b)(2)(iv) measures distributions against cumulative TOTAL RETURN, so
  // the figure travels with the distribution rather than only with the window
  // recompute — a distribution event that does not carry the denominator
  // cannot be checked against the 51% rule after the fact.
  let windowTotalReturn: number | null = null;
  if (isNonEmptyString(body.window_id)) {
    const { data: w } = await db.schema(scope).from("cda_distribution_window")
      .select("id, total_return_cents").eq("id", body.window_id).maybeSingle();
    windowTotalReturn = w ? Number(w.total_return_cents ?? 0) : null;
  }

  const now = new Date();
  const id = `cdadist_${cdaId}_${crypto.randomUUID()}`;
  const decision = blockReasons.length === 0 ? "executed" : "blocked";

  const { error } = await db.schema(scope).from("cda_distribution").upsert({
    id, cda_id: cdaId,
    window_id: isNonEmptyString(body.window_id) ? body.window_id : null,
    donee_name: body.donee_name, donee_ein: ein,
    donee_irs_status: VALID_IRS_STATUS.has(irsStatus) || irsStatus === "none"
      ? irsStatus
      : "unknown",
    donee_validated: doneeValidated,
    amount_cents: amount, kind,
    proposed_by: proposedBy, approved_by: approvedBy,
    decision, blocked_reason: blockReasons[0] ?? null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_val`, "cda.donee.validated", cdaId, {
    donee_ein: ein, donee_irs_status: irsStatus, validated: doneeValidated,
  }, ctx);

  if (decision === "blocked") {
    await emit(db, scope, `ev_${id}_blk`, "cda.distribution.blocked", cdaId, {
      reasons: blockReasons, donee_name: body.donee_name,
    }, ctx);
    return apiError(409, "cda_distribution_blocked", requestId, {
      title: "distribution blocked",
      detail: blockReasons.join(", "),
    });
  }

  if (needsDual) {
    await emit(db, scope, `ev_${id}_dual`, "cda.dual_approval.recorded", cdaId, {
      distribution_amount: amount, proposed_by: proposedBy, approver_id: approvedBy,
    }, ctx);
  }
  await emit(db, scope, `ev_${id}_exec`,
    kind === "closing" ? "cda.closing_distribution.executed" : "cda.distribution.executed",
    cdaId, {
      distribution_amount: amount, donee_name: body.donee_name, donee_ein: ein,
      dual_approval: needsDual, total_return_cumulative: windowTotalReturn,
    }, ctx);
  // CDA-11 logs the sub-threshold ones too — "no dual approval recorded" must
  // not be ambiguous between "below the threshold" and "the rule was skipped".
  if (!needsDual) {
    await emit(db, scope, `ev_${id}_single`, "cda.single_approval.recorded", cdaId, {
      distribution_amount: amount, threshold_cents: DUAL_APPROVAL_THRESHOLD_CENTS,
    }, ctx);
  }

  // A distribution reduces the CDA's book value, which is what makes the cap
  // cure real: the only way back under §721.3(b)(2)(iii) is for the aggregate
  // to actually fall. If book value were left untouched, a "cured" breach
  // would be a status change with no corresponding change in the position.
  const { data: acct } = await db.schema(scope).from("cda")
    .select("id, book_value_cents").eq("id", cdaId).maybeSingle();
  if (acct) {
    await db.schema(scope).from("cda").update({
      book_value_cents: Math.max(0, Number(acct.book_value_cents ?? 0) - amount),
      updated_at: now.toISOString(),
    }).eq("id", cdaId);
  }

  if (isNonEmptyString(body.window_id)) {
    await recomputeWindowCoverage(db, scope, body.window_id, ctx);
  }
  return jsonResponse({ data: { id, decision } }, 201, requestId);
}

// ------------------------------------------------------- CDA-09 accounting

/**
 * POST /cda/:id/reconciliations {period, gl_balance_cents, custodian_balance_cents,
 *                                account_789h_mapped?}
 */
export async function postCdaReconciliation(
  req: Request, cdaId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const gl = typeof body.gl_balance_cents === "number" ? body.gl_balance_cents : NaN;
  const cust = typeof body.custodian_balance_cents === "number"
    ? body.custodian_balance_cents
    : NaN;
  if (!Number.isFinite(gl) || !Number.isFinite(cust) || !isNonEmptyString(body.period)) {
    return validationError(requestId, [{
      type: "missing_field", field: "gl_balance_cents",
      message: "period, gl_balance_cents and custodian_balance_cents are required",
    }]);
  }

  const difference = gl - cust;
  const reconciled = difference === 0;
  const id = `cdarec_${cdaId}_${body.period}`;
  const { error } = await db.schema(scope).from("cda_reconciliation").upsert({
    id, cda_id: cdaId, period: body.period,
    gl_balance_cents: gl, custodian_balance_cents: cust,
    difference_cents: difference, reconciled,
    account_789h_mapped: body.account_789h_mapped === true,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  // The event is emitted whether or not it reconciled, carrying the verdict.
  // Emitting only on success makes "reconciliation completed" mean "the books
  // agreed", and the control needs the other case to be visible.
  await emit(db, scope, `ev_${id}_rec`, "cda.reconciliation.completed", cdaId, {
    period: body.period, gl_balances: gl, custodian_statement: cust,
    difference_cents: difference, reconciled,
  }, ctx);
  if (!reconciled) {
    await emit(db, scope, `ev_${id}_diff`, "cda.reconciliation.exception", cdaId, {
      difference_cents: difference,
    }, ctx);
  }
  return jsonResponse({ data: { id, reconciled, difference_cents: difference } }, 201, requestId);
}

/** POST /cda/:id/call-report {cycle, account_789h_mapping} */
export async function postCdaCallReportMapping(
  req: Request, cdaId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.account_789h_mapping)) {
    return validationError(requestId, [{
      type: "missing_field", field: "account_789h_mapping", message: "is required",
    }]);
  }
  // The mapping is only meaningful against a GL balance. Recording a mapping
  // with nothing mapped through it is the `account_code_5300 = "018"` failure
  // in a new place (BLUEPRINT §5, decision 2).
  const { data: recs } = await db.schema(scope).from("cda_reconciliation")
    .select("id, cda_id, period, gl_balance_cents").eq("cda_id", cdaId);
  const latest = (recs ?? []).slice(-1)[0];
  if (!latest) {
    return apiError(409, "cda_call_report_unmapped", requestId, {
      title: "no GL balance to map",
      detail: "789H mapping requires a reconciliation period with a GL balance",
    });
  }

  await db.schema(scope).from("cda_reconciliation")
    .update({ account_789h_mapped: true }).eq("id", latest.id);
  await emit(db, scope, `ev_${cdaId}_789h_${body.cycle ?? "c"}`, "cda.call_report.mapped", cdaId, {
    account_789h_mapping: body.account_789h_mapping,
    gl_balances: latest.gl_balance_cents, cycle: body.cycle ?? null,
  }, ctx);
  return jsonResponse({ data: { mapped: true } }, 200, requestId);
}

/**
 * POST /cda/quarter-close {quarter, preparer_id}
 *
 * CDA-01, CDA-09, CDA-11 and CDA-13 all hang off quarter close. The packet is
 * assembled from what is IN THE TABLES — cap utilisation, window coverage,
 * exceptions — rather than from a supplied summary, because a packet whose
 * contents are supplied by the caller reports whatever the caller believes.
 */
export async function postCdaQuarterClose(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const quarter = isNonEmptyString(body.quarter) ? body.quarter : "unknown";
  if (!isNonEmptyString(body.preparer_id)) {
    return validationError(requestId, [{
      type: "missing_field", field: "preparer_id", message: "is required",
    }]);
  }
  const now = new Date();

  const { data: caps } = await db.schema(scope).from("cda_cap_test")
    .select("id, as_of_date, utilization_bp, cap_breached, cured_at")
    .order("as_of_date", { ascending: false }).limit(1);
  const cap = (caps ?? [])[0] ?? null;

  const { data: windows } = await db.schema(scope).from("cda_distribution_window")
    .select("id, coverage_bp, closes_at, closed_at");
  const { data: fundings } = await db.schema(scope).from("cda_funding_request")
    .select("id, decision, blocked_reasons");
  const { data: fees } = await db.schema(scope).from("cda_fee_payment")
    .select("id, payee, amount_cents, payee_is_affiliate, decision");
  const { data: accounts } = await db.schema(scope).from("cda")
    .select("id, book_value_cents, status");

  const exceptions = [
    ...(fundings ?? []).filter((f: Any) => f.decision === "blocked")
      .map((f: Any) => ({ kind: "funding_blocked", id: f.id, reasons: f.blocked_reasons })),
    ...(fees ?? []).filter((f: Any) => f.decision === "blocked")
      .map((f: Any) => ({ kind: "affiliate_fee_blocked", id: f.id })),
    ...(cap?.cap_breached && !cap?.cured_at
      ? [{ kind: "cap_breach_uncured", id: cap.id }]
      : []),
  ];
  const worstCoverage = (windows ?? []).length > 0
    ? Math.min(...(windows ?? []).map((w: Any) => Number(w.coverage_bp ?? 0)))
    : null;

  const packetId = `cdapkt_${quarter}`;
  await emit(db, scope, `ev_${packetId}`, "cda.board_packet.issued", packetId, {
    quarter,
    preparer_id: body.preparer_id,
    aggregate_book_value: (accounts ?? [])
      .reduce((n: number, a: Any) => n + Number(a.book_value_cents ?? 0), 0),
    cap_utilization_bp: cap?.utilization_bp ?? null,
    window_coverage_pct: worstCoverage === null ? null : worstCoverage / 100,
    portfolio_performance: { accounts: (accounts ?? []).length },
    exception_count: exceptions.length,
    exceptions,
    due_at: plusDays(now, 30),
  }, ctx);

  // CDA-13's quarterly fee review, CDA-11's quarterly valuation review.
  await emit(db, scope, `ev_${packetId}_fee`, "cda.fee_review.completed", packetId, {
    quarter, fee_payee: (fees ?? []).map((f: Any) => f.payee),
    fee_amount: (fees ?? []).reduce((n: number, f: Any) => n + Number(f.amount_cents), 0),
    affiliate_attempts: (fees ?? []).filter((f: Any) => f.payee_is_affiliate).length,
  }, ctx);

  return jsonResponse({
    data: { quarter, exception_count: exceptions.length, cap_utilization_bp: cap?.utilization_bp ?? null },
  }, 201, requestId);
}

/** POST /cda/:id/valuation-reviews {period, independent_pricing_ref, portfolio_composition} */
export async function postCdaValuationReview(
  req: Request, cdaId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.independent_pricing_ref)) {
    // CDA-11 says INDEPENDENT pricing. A valuation review marking the
    // portfolio at its own book value reviews nothing.
    return validationError(requestId, [{
      type: "missing_field", field: "independent_pricing_ref",
      message: "an independent price source is required",
    }]);
  }
  const id = `cdaval_${cdaId}_${body.period ?? "p"}`;
  const { error } = await db.schema(scope).from("cda_valuation_review").upsert({
    id, cda_id: cdaId, period: String(body.period ?? "p"),
    independent_pricing_ref: body.independent_pricing_ref,
    portfolio_composition: body.portfolio_composition ?? {},
    reviewed_by: isNonEmptyString(body.reviewed_by) ? body.reviewed_by : "unknown",
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}`, "cda.valuation_review.completed", cdaId, {
    independent_pricing: body.independent_pricing_ref,
    portfolio_composition: body.portfolio_composition ?? {},
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

// ------------------------------------------------------------- CDA-13 fees

/**
 * The blocklist is the credit union itself plus its affiliates. It is a
 * REGISTER rather than a string match, because "does this payee happen to
 * contain our name" is not the §721.3(b)(2) test — an affiliate with an
 * unrelated name is still an affiliate.
 */
export const AFFILIATE_PAYEES = new Set([
  "pynthia credit union",
  "pynthia cuso",
  "pynthia insurance services",
]);

/** POST /cda/:id/fees {payee, amount_cents} */
export async function postCdaFeePayment(
  req: Request, cdaId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const amount = typeof body.amount_cents === "number" ? body.amount_cents : NaN;
  if (!isNonEmptyString(body.payee) || !Number.isFinite(amount) || amount <= 0) {
    return validationError(requestId, [{
      type: "invalid_value", field: "payee",
      message: "payee and a positive amount_cents are required",
    }]);
  }

  const isAffiliate = AFFILIATE_PAYEES.has(String(body.payee).trim().toLowerCase());
  const decision = isAffiliate ? "blocked" : "permitted";

  const now = new Date();
  const id = `cdafee_${cdaId}_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("cda_fee_payment").upsert({
    id, cda_id: cdaId, payee: body.payee, payee_is_affiliate: isAffiliate,
    amount_cents: amount, decision, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_screen`, "cda.fee_screen.completed", cdaId, {
    fee_payee: body.payee, fee_amount: amount,
    payee_is_affiliate: isAffiliate, decision,
  }, ctx);

  if (isAffiliate) {
    // §721.3(b)(2): an affiliate fee distorts Total Return, so the block is
    // also a conflict that escalates on its own 5-business-day clock.
    await emit(db, scope, `ev_${id}_conflict`, "cda.fee_conflict.flagged", cdaId, {
      conflict_details: { payee: body.payee, amount_cents: amount },
    }, ctx);
    await emit(db, scope, `ev_${id}_esc`, "cda.conflict.escalated", cdaId, {
      conflict_details: { payee: body.payee, amount_cents: amount },
      escalation_due_at: plusDays(now, CONFLICT_ESCALATION_DAYS),
    }, ctx);
    return apiError(409, "cda_affiliate_fee_blocked", requestId, {
      title: "affiliate fee payment blocked",
      detail: `§721.3(b)(2) prohibits CDA fees to the credit union or its affiliates: ${body.payee}`,
    });
  }
  return jsonResponse({ data: { id, decision } }, 201, requestId);
}

// ------------------------------------------------------ CDA-12 termination

/** POST /cda/:id/termination {approved_by, final_accounting_ref?} */
export async function postCdaTermination(
  req: Request, cdaId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.approved_by)) {
    return validationError(requestId, [{
      type: "missing_field", field: "approved_by", message: "is required",
    }]);
  }
  const { data: rec } = await db.schema(scope).from("cda")
    .select("id, status, book_value_cents").eq("id", cdaId).maybeSingle();
  if (!rec) return notFoundResponse(requestId, "cda", cdaId);

  const now = new Date();
  const id = `cdaterm_${cdaId}`;
  const { error } = await db.schema(scope).from("cda_termination").upsert({
    id, cda_id: cdaId, approved_by: body.approved_by, approved_at: now.toISOString(),
    final_accounting_ref: isNonEmptyString(body.final_accounting_ref)
      ? body.final_accounting_ref
      : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await db.schema(scope).from("cda")
    .update({ status: "terminating", terminated_at: now.toISOString() }).eq("id", cdaId);

  await emit(db, scope, `ev_${id}_appr`, "cda.termination.approved", cdaId, {
    approved_by: body.approved_by,
  }, ctx);
  return jsonResponse({ data: { id, status: "terminating" } }, 201, requestId);
}

/**
 * POST /cda/:id/inkind {asset_class, amount_cents, determination_ref?}
 *
 * §721.3(b)(2)(vi). Permissibility is determined against the Part 703
 * permissible-investment classes; an asset class with no determination is
 * BLOCKED, not received. "We did not check" resolves to liquidate-to-cash,
 * which is the safe direction and the one the reg allows unconditionally.
 */
export const PART_703_PERMISSIBLE = new Set([
  "cash", "us_treasury", "federal_agency", "insured_deposit",
  "municipal_security", "corporate_debt_investment_grade",
]);

export async function postCdaInkindTransfer(
  req: Request, cdaId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const amount = typeof body.amount_cents === "number" ? body.amount_cents : NaN;
  if (!isNonEmptyString(body.asset_class) || !Number.isFinite(amount) || amount <= 0) {
    return validationError(requestId, [{
      type: "invalid_value", field: "asset_class",
      message: "asset_class and a positive amount_cents are required",
    }]);
  }
  const { data: term } = await db.schema(scope).from("cda_termination")
    .select("id, cda_id").eq("cda_id", cdaId).maybeSingle();
  if (!term) return notFoundResponse(requestId, "cda_termination", cdaId);

  const cls = String(body.asset_class);
  const determined = isNonEmptyString(body.determination_ref);
  // Both halves are required: the class must be permissible AND someone must
  // have documented the determination. A permissible asset with no
  // determination is an undocumented judgment, which CDA-12 write-restricts
  // to Compliance precisely so it cannot be implicit.
  const permissible = PART_703_PERMISSIBLE.has(cls) && determined;
  const decision = permissible ? "received" : "blocked_liquidate";

  const id = `cdaik_${cdaId}_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("cda_inkind_asset").upsert({
    id, termination_id: term.id, asset_class: cls, amount_cents: amount,
    permissible, determination_ref: isNonEmptyString(body.determination_ref)
      ? body.determination_ref
      : null,
    decision, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_prop`, "cda.inkind_transfer.proposed", cdaId, {
    asset_details: { asset_class: cls, amount_cents: amount },
    permissibility_determination: permissible,
    determination_ref: body.determination_ref ?? null,
    decision,
  }, ctx);
  await emit(db, scope, `ev_${id}_eval`, "cda.inkind_transfer.evaluated", cdaId, {
    permissible, decision,
  }, ctx);

  if (!permissible) {
    return apiError(409, "cda_inkind_not_permissible", requestId, {
      title: "in-kind receipt blocked",
      detail: determined
        ? `${cls} is not a permissible FCU investment under Part 703; liquidate to cash`
        : `no documented permissibility determination for ${cls}; liquidate to cash`,
    });
  }
  return jsonResponse({ data: { id, decision } }, 201, requestId);
}

/** POST /cda/:id/close {final_accounting_ref} */
export async function postCdaClose(
  req: Request, cdaId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: term } = await db.schema(scope).from("cda_termination")
    .select("id, cda_id, approved_by").eq("cda_id", cdaId).maybeSingle();
  if (!term) return notFoundResponse(requestId, "cda_termination", cdaId);
  if (!isNonEmptyString(body.final_accounting_ref)) {
    return validationError(requestId, [{
      type: "missing_field", field: "final_accounting_ref", message: "is required",
    }]);
  }

  // CDA-12: the closing distribution must satisfy >=51% of Total Return. The
  // coverage is read from the windows rather than asserted, so a close cannot
  // report a satisfied threshold that the distributions do not support.
  const { data: windows } = await db.schema(scope).from("cda_distribution_window")
    .select("id, cda_id, coverage_bp, total_return_cents").eq("cda_id", cdaId);
  const covered = (windows ?? []).length > 0
    ? Math.min(...(windows ?? []).map((w: Any) => Number(w.coverage_bp ?? 0)))
    : 0;
  const short = covered < MIN_DISTRIBUTION_COVERAGE_BP;

  const now = new Date();
  const { error } = await db.schema(scope).from("cda_termination").update({
    closing_coverage_bp: covered,
    final_accounting_ref: body.final_accounting_ref,
    report_due_at: plusDays(now, TERMINATION_REPORT_DAYS),
    report_issued_at: now.toISOString(),
    updated_at: now.toISOString(),
  }).eq("id", term.id);
  if (error) return internalErrorResponse(requestId, error.message);

  await db.schema(scope).from("cda")
    .update({ status: "closed", closed_at: now.toISOString() }).eq("id", cdaId);

  await emit(db, scope, `ev_${cdaId}_termrpt`, "cda.termination_report.issued", cdaId, {
    final_accounting: body.final_accounting_ref,
    closing_coverage_bp: covered,
    closing_threshold_met: !short,
    report_due_at: plusDays(now, TERMINATION_REPORT_DAYS),
  }, ctx);
  if (short) {
    // The close is not refused — the account is being wound up either way and
    // blocking it would strand the assets. The SHORTFALL is escalated instead,
    // which is what CDA-12's alert actually asks for.
    await emit(db, scope, `ev_${cdaId}_termshort`, "cda.board_escalation.issued", cdaId, {
      reason: "closing_distribution_short", coverage_bp: covered,
      required_bp: MIN_DISTRIBUTION_COVERAGE_BP,
    }, ctx);
  }
  return jsonResponse({
    data: { id: cdaId, closed: true, closing_coverage_bp: covered, threshold_met: !short },
  }, 200, requestId);
}

// --------------------------------------------------------- CDA-02 glossary

/** POST /cda/glossary {term, definition, citation, attested_by} */
export async function postCdaGlossaryChange(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const errors: ValidationErrorItem[] = [];
  for (const f of ["term", "definition", "citation", "attested_by"]) {
    if (!isNonEmptyString(body[f])) {
      errors.push({ type: "missing_field", field: f, message: "is required" });
    }
  }
  if (errors.length > 0) return validationError(requestId, errors);

  // The version is DERIVED from the prior active term, not supplied. A
  // caller-chosen version lets a change land at the same version it replaced,
  // and CDA-02's alert compares versions.
  const { data: prior } = await db.schema(scope).from("cda_glossary_term")
    .select("id, term, version, active").eq("term", body.term).eq("active", true);
  const priorRow = (prior ?? [])[0];
  const version = priorRow ? Number(priorRow.version) + 1 : 1;
  if (priorRow) {
    await db.schema(scope).from("cda_glossary_term")
      .update({ active: false }).eq("id", priorRow.id);
  }

  const id = `cdaglo_${String(body.term).toLowerCase().replace(/[^a-z0-9]/g, "")}_v${version}`;
  const { error } = await db.schema(scope).from("cda_glossary_term").upsert({
    id, term: body.term, definition: body.definition, citation: body.citation,
    version, attested_by: body.attested_by, active: true,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_upd`, "cda.glossary.updated", id, {
    glossary_term: body.term, glossary_citation: body.citation,
    glossary_version: version, prior_version: priorRow ? priorRow.version : null,
  }, ctx);
  await emit(db, scope, `ev_${id}_att`, "cda.glossary.attested", id, {
    glossary_term: body.term, attested_by: body.attested_by, glossary_version: version,
  }, ctx);
  return jsonResponse({ data: { id, term: body.term, version } }, 201, requestId);
}

// --------------------------------------------------- CDA-14 communications

/** POST /cda/communications {title, draft_ref} */
export async function postCdaCommunication(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.title) || !isNonEmptyString(body.draft_ref)) {
    return validationError(requestId, [{
      type: "missing_field", field: "draft_ref", message: "title and draft_ref are required",
    }]);
  }
  const id = `cdacom_${String(body.title).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24)}`;
  const { error } = await db.schema(scope).from("cda_communication").upsert({
    id, title: body.title, draft_ref: body.draft_ref,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_draft`, "cda.communication.drafted", id, {
    communication_draft: body.draft_ref,
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/**
 * POST /cda/communications/:id/approve
 * {wcag_checklist_passed, marketing_approved_by, compliance_approved_by}
 *
 * CDA-14 requires BOTH approvals and a passing checklist. The three are checked
 * together in one write for the same reason the distribution gate is: three
 * separate endpoints would let a page be approved by Marketing, fail the
 * checklist, and still carry an approval record.
 */
export async function postCdaCommunicationApproval(
  req: Request, commId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: c } = await db.schema(scope).from("cda_communication")
    .select("id, title, draft_ref, published_at").eq("id", commId).maybeSingle();
  if (!c) return notFoundResponse(requestId, "cda_communication", commId);

  const wcag = body.wcag_checklist_passed === true;
  const mkt = isNonEmptyString(body.marketing_approved_by) ? body.marketing_approved_by : null;
  const cmp = isNonEmptyString(body.compliance_approved_by) ? body.compliance_approved_by : null;
  const missing: string[] = [];
  if (!wcag) missing.push("wcag_checklist");
  if (!mkt) missing.push("marketing_approval");
  if (!cmp) missing.push("compliance_approval");

  const now = new Date();
  // A PUBLISHED communication cannot have its approval incompletely rewritten
  // — that is the row state ck_cda_comm_publish_requires_approval forbids.
  // Refuse before writing rather than letting the constraint refuse after
  // (which read as a silent no-op and a missing event on the live tier).
  if (missing.length > 0 && c.published_at) {
    await emit(db, scope, `ev_${commId}_apprgap`, "cda.communication.approval_incomplete",
      commId, { missing, wcag_checklist: wcag, published: true }, ctx);
    return apiError(409, "cda_communication_published", requestId, {
      title: "approval incomplete", detail: "published communication keeps its approval record",
    });
  }
  const { error } = await db.schema(scope).from("cda_communication").update({
    wcag_checklist_passed: wcag,
    marketing_approved_by: mkt, compliance_approved_by: cmp,
    approved_at: missing.length === 0 ? now.toISOString() : null,
    updated_at: now.toISOString(),
  }).eq("id", commId);
  if (error) return internalErrorResponse(requestId, error.message);

  if (missing.length > 0) {
    await emit(db, scope, `ev_${commId}_apprgap`, "cda.communication.approval_incomplete",
      commId, { missing, wcag_checklist: wcag }, ctx);
    return apiError(409, "cda_communication_not_approved", requestId, {
      title: "approval incomplete", detail: missing.join(", "),
    });
  }
  await emit(db, scope, `ev_${commId}_appr`, "cda.communication.approved", commId, {
    wcag_checklist: true, marketing_approved_by: mkt, compliance_approved_by: cmp,
  }, ctx);
  return jsonResponse({ data: { id: commId, approved: true } }, 200, requestId);
}

/** POST /cda/communications/:id/publish {archived_ref} */
export async function postCdaCommunicationPublish(
  req: Request, commId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: c } = await db.schema(scope).from("cda_communication")
    .select("id, approved_at, draft_ref").eq("id", commId).maybeSingle();
  if (!c) return notFoundResponse(requestId, "cda_communication", commId);
  if (!c.approved_at) {
    return apiError(409, "cda_communication_not_approved", requestId, {
      title: "publication blocked",
      detail: "CDA-14 gates publication on a completed checklist and both approvals",
    });
  }
  if (!isNonEmptyString(body.archived_ref)) {
    return validationError(requestId, [{
      type: "missing_field", field: "archived_ref",
      message: "the published artifact must be archived at publication",
    }]);
  }

  const now = new Date();
  const { error } = await db.schema(scope).from("cda_communication").update({
    published_at: now.toISOString(), archived_ref: body.archived_ref,
    updated_at: now.toISOString(),
  }).eq("id", commId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${commId}_pub`, "cda.communication.published", commId, {
    communication_draft: c.draft_ref, communication_archived: body.archived_ref,
  }, ctx);
  return jsonResponse({ data: { id: commId, published: true } }, 200, requestId);
}

// ---------------------------------------------------- CDA-11 programme audit

/** POST /cda/audit-cycles {cycle_year, findings:[{summary, remediation_owner, due_days?}]} */
export async function postCdaAuditCycle(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const year = typeof body.cycle_year === "number" ? body.cycle_year : NaN;
  if (!Number.isFinite(year)) {
    return validationError(requestId, [{
      type: "missing_field", field: "cycle_year", message: "is required",
    }]);
  }
  const findings = Array.isArray(body.findings) ? body.findings : [];
  const now = new Date();

  // Every finding is validated BEFORE the report is issued or any finding is
  // written. Validating inside the write loop issued cda.audit_report.issued
  // and persisted the earlier findings for a cycle the caller was told was
  // refused (caught by the CDA partner-flow suite).
  // A finding with no named owner has nobody to chase and would age silently.
  // It is a validation failure, not a finding with a blank field.
  const unowned = findings.findIndex((raw) => {
    const f = raw as Record<string, unknown>;
    return !isNonEmptyString(f.summary) || !isNonEmptyString(f.remediation_owner);
  });
  if (unowned >= 0) {
    return validationError(requestId, [{
      type: "missing_field", field: `findings[${unowned}].remediation_owner`,
      message: "every finding needs a summary and a named remediation owner",
    }]);
  }

  await emit(db, scope, `ev_cdaaud_${year}`, "cda.audit_report.issued", `cdaaud_${year}`, {
    cycle_year: year, finding_count: findings.length,
  }, ctx);

  const ids: string[] = [];
  for (const [i, raw] of findings.entries()) {
    const f = raw as Record<string, unknown>;
    const id = `cdafind_${year}_${i}`;
    const { error } = await db.schema(scope).from("cda_audit_finding").upsert({
      id, cycle_year: year, summary: f.summary, remediation_owner: f.remediation_owner,
      remediation_due_at: plusDays(now, typeof f.due_days === "number" ? f.due_days : 90),
      provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id" });
    if (error) return internalErrorResponse(requestId, error.message);
    ids.push(id);
    await emit(db, scope, `ev_${id}_log`, "cda.audit_finding.logged", id, {
      audit_finding: f.summary, remediation_owner: f.remediation_owner,
      remediation_due_at: plusDays(now, typeof f.due_days === "number" ? f.due_days : 90),
    }, ctx);
  }
  return jsonResponse({ data: { cycle_year: year, findings: ids } }, 201, requestId);
}

/** POST /cda/findings/:id/close {closure_evidence_ref} */
export async function postCdaFindingClose(
  req: Request, findingId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: f } = await db.schema(scope).from("cda_audit_finding")
    .select("id, remediation_due_at, closed_at, remediation_owner").eq("id", findingId).maybeSingle();
  if (!f) return notFoundResponse(requestId, "cda_audit_finding", findingId);
  if (!isNonEmptyString(body.closure_evidence_ref)) {
    return validationError(requestId, [{
      type: "missing_field", field: "closure_evidence_ref",
      message: "a finding cannot be closed without evidence of remediation",
    }]);
  }

  const now = new Date();
  const { error } = await db.schema(scope).from("cda_audit_finding").update({
    closed_at: now.toISOString(), closure_evidence_ref: body.closure_evidence_ref,
    updated_at: now.toISOString(),
  }).eq("id", findingId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${findingId}_closed`, "cda.remediation.closed", findingId, {
    remediation_owner: f.remediation_owner,
    closure_evidence: body.closure_evidence_ref,
    // whether it closed LATE is part of the record; a closure that silently
    // drops its own lateness makes the aging alert unfalsifiable
    closed_late: f.remediation_due_at
      ? now.toISOString() > String(f.remediation_due_at)
      : null,
  }, ctx);
  return jsonResponse({ data: { id: findingId, closed: true } }, 200, requestId);
}
