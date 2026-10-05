// Investment portfolio — IP-02..IP-17.
//
// Builds the securities book BLUEPRINT §0 named as a missing entity. See the
// migration header for the four design decisions; the two that shape most of
// this file are that a TRADE and a POSITION are different nouns, and that
// segregation of duties here is THREE roles rather than two.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor } from "./bsa.ts";
import {
  apiError, internalErrorResponse, isNonEmptyString, jsonResponse, notFoundResponse,
  parseJsonBody, selectAll, validationError, type ValidationErrorItem,
} from "./lib.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const DAY_MS = 24 * 60 * 60 * 1000;

/** IP-05: credit analysis goes stale after a year. */
export const CREDIT_REANALYSIS_DAYS = 365;
/** IP-09: repo collateral is re-valued daily. */
const REPO_REVALUATION_DAYS = 1;
/** IP-15: the required document set must be attached within this window. */
const DOCUMENT_ATTACHMENT_DAYS = 30;

/**
 * IP-14: the segregation matrix. Which pairs of trade steps one actor may not
 * hold at once, and the version it was decided under — so a violation can be
 * checked against the matrix that was in force, not today's.
 */
export const SOD_MATRIX_VERSION = "sod-v1";
export const SOD_INCOMPATIBLE: ReadonlyArray<[string, string]> = [
  ["execution", "confirmation"],
  ["execution", "settlement"],
];

/**
 * The actor's role. `core.user` is one of the 22 ABANDONED TABLES: a role
 * register keyed by actor reference. It models a SYSTEM PRINCIPAL and the
 * duties it may hold — not a person, not employment. That is the same line
 * `records_contact` and `core.insider` sit on, and it is what makes the
 * segregation matrix checkable without inventing an HR record.
 */
export async function userRole(
  db: SupabaseClient, scope: EvidenceScope, actorRef: string,
): Promise<string | null> {
  const { data } = await db.schema(scope).from("user")
    .select("id, role").eq("id", actorRef).maybeSingle();
  return data ? String(data.role) : null;
}

/** PUT /investment/users/:id {role} */
export async function putUserRole(
  req: Request, userId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const roles = ["execution", "confirmation", "settlement", "oversight"];
  if (!roles.includes(String(body.role))) {
    return validationError(requestId, [{
      type: "invalid_value", field: "role", message: `must be one of ${roles.join(", ")}`,
    }]);
  }
  const { error } = await db.schema(scope).from("user").upsert({
    id: userId, role: body.role, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  return jsonResponse({ data: { id: userId, role: body.role } }, 200, requestId);
}

/** IP-15: what a completed trade file must contain. */
export const REQUIRED_TRADE_DOCUMENTS = [
  "trade_ticket", "confirmation", "pre_purchase_analysis", "safekeeping_receipt",
];

function requireInternalActor(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/investment");
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
  if (error) throw new Error(`investment event (${code}): ${error.message}`);
}

const plusDays = (f: Date, d: number) => new Date(f.getTime() + d * DAY_MS).toISOString();

/**
 * Every row matching a filter, not the first page of it. PostgREST caps an
 * unbounded select at 1000 rows and says nothing, so a filtered register that
 * feeds a count or a comparison is walked by `id` like `selectAll` does.
 */
async function selectAllWhere(
  db: SupabaseClient, scope: EvidenceScope, table: string, columns: string,
  // deno-lint-ignore no-explicit-any
  where: (q: any) => any, pageSize = 1000,
): Promise<Any[]> {
  const rows: Any[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await where(db.schema(scope).from(table).select(columns))
      .order("id", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`${table} read: ${error.message}`);
    const page = (data ?? []) as Any[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

/** An exact row count. Counting a fetched page under-reports past 1000. */
async function countWhere(
  db: SupabaseClient, scope: EvidenceScope, table: string,
  // deno-lint-ignore no-explicit-any
  where: (q: any) => any = (q) => q,
): Promise<number> {
  const { count, error } = await where(
    db.schema(scope).from(table).select("id", { count: "exact", head: true }),
  );
  if (error) throw new Error(`${table} count: ${error.message}`);
  return Number(count ?? 0);
}

/**
 * The identity a duty is performed under is the AUTHENTICATED caller, never a
 * name typed into the body. A body field naming the actor is kept only as an
 * assertion the caller makes about itself: when it names someone else, the
 * call is refused, because segregation of duties checked against a string the
 * caller chose separates nothing.
 */
function actingIdentity(ctx: PartnerContext, claimed: string | null): {
  actor: string; mismatch: boolean;
} {
  const actor = ctx.tokenId;
  return { actor, mismatch: claimed !== null && claimed !== actor };
}

function actorMismatchResponse(requestId: string, field: string, step: string): Response {
  return apiError(409, "trade_sod_violation", requestId, {
    title: "segregation of duties",
    detail: `${field} must be the authenticated caller — a ${step} is performed under the caller's own credential, not a name supplied in the request`,
  });
}

/** A text-era 'true'/'false' and a real boolean read the same. */
function asBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "t" ? true : s === "false" || s === "f" ? false : null;
}

// ------------------------------------------------------ IP-03 permissibility

/** The instrument-list entry in force. Effective-dated, like every schedule. */
export async function instrumentEntryInForce(
  db: SupabaseClient, scope: EvidenceScope, instrumentClass: string, at: Date,
): Promise<Record<string, Any> | null> {
  const { data } = await db.schema(scope).from("instrument_list")
    .select("id, instrument_class, permissible, citation, max_maturity_months, min_rating, version, effective_at, superseded_at")
    .eq("instrument_class", instrumentClass)
    .order("effective_at", { ascending: false });
  const iso = at.toISOString();
  for (const row of data ?? []) {
    if (String(row.effective_at) > iso) continue;
    if (row.superseded_at && String(row.superseded_at) <= iso) continue;
    return row;
  }
  return null;
}

/** POST /investment/instrument-list {instrument_class, permissible, citation, ...} */
export async function postInstrumentListEntry(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.instrument_class) || !isNonEmptyString(body.citation) ||
      typeof body.permissible !== "boolean") {
    return validationError(requestId, [{
      type: "missing_field", field: "citation",
      message: "instrument_class, an explicit permissible flag and a citation are required",
    }]);
  }
  const now = new Date();
  const effectiveAt = isNonEmptyString(body.effective_at) ? body.effective_at : now.toISOString();
  const cls = String(body.instrument_class);
  const prior = await instrumentEntryInForce(db, scope, cls, new Date(effectiveAt));
  const version = prior ? Number(prior.version) + 1 : 1;
  if (prior) {
    await db.schema(scope).from("instrument_list")
      .update({ superseded_at: effectiveAt }).eq("id", prior.id);
  }

  const id = `instr_${cls}_v${version}`;
  const { error } = await db.schema(scope).from("instrument_list").upsert({
    id, instrument_class: cls, permissible: body.permissible, citation: body.citation,
    max_maturity_months: typeof body.max_maturity_months === "number"
      ? body.max_maturity_months
      : null,
    min_rating: isNonEmptyString(body.min_rating) ? body.min_rating : null,
    version, effective_at: effectiveAt, superseded_at: null,
    reviewed_by: isNonEmptyString(body.reviewed_by) ? body.reviewed_by : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_rev`, "instrument_list.review.completed",
    "instrument_list", id, {
      instrument_class: cls, permissible: body.permissible, citation: body.citation, version,
    }, ctx);
  // IP-03: a change to the list IS the regulatory-change analysis being logged.
  await emit(db, scope, `ev_${id}_reg`, "regulatory.change_analysis.logged",
    "instrument_list", id, {
      instrument_class: cls, version, prior_version: prior ? prior.version : null,
    }, ctx);
  return jsonResponse({ data: { id, version } }, 201, requestId);
}

// ------------------------------------------------------ IP-08 intermediaries

const APPROVED_REGULATORS = new Set(["sec", "finra", "occ", "federal_reserve"]);

/** POST /investment/intermediaries {name, kind, regulator, registration_status} */
export async function postIntermediary(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const kinds = ["broker_dealer", "safekeeper", "both"];
  if (!isNonEmptyString(body.name) || !kinds.includes(String(body.kind))) {
    return validationError(requestId, [{
      type: "invalid_value", field: "kind", message: `name and a kind in ${kinds.join("/")}`,
    }]);
  }
  const regulator = isNonEmptyString(body.regulator) ? body.regulator : null;
  const status = isNonEmptyString(body.registration_status) ? body.registration_status : "unknown";
  // Approval is DERIVED, like the CDA trustee's. A supplied approval flag is
  // the assertion the control exists to check.
  const approved = regulator !== null && APPROVED_REGULATORS.has(regulator) && status === "active";
  const reason = approved
    ? null
    : (!regulator || !APPROVED_REGULATORS.has(regulator))
    ? "regulator_not_recognised"
    : `registration_${status}`;

  const now = new Date();
  const id = `interm_${String(body.name).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  const { error } = await db.schema(scope).from("intermediary").upsert({
    id, name: body.name, kind: body.kind, regulator, registration_status: status,
    approved, disqualified_reason: reason,
    last_reviewed_at: now.toISOString(), review_due_at: plusDays(now, 365),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_rev`, "intermediary.review.completed", "intermediary", id, {
    approved, regulator, registration_status: status, disqualified_reason: reason,
  }, ctx);
  return jsonResponse({ data: { id, approved } }, 201, requestId);
}

/** POST /investment/safekeeping/reconcile {intermediary_id, holdings} */
export async function postSafekeepingReconciliation(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.intermediary_id)) {
    return validationError(requestId, [{
      type: "missing_field", field: "intermediary_id",
      message: "a safekeeping statement is reconciled against one custodian",
    }]);
  }
  const custodian = String(body.intermediary_id);

  // The custodian's statement is compared against OUR book — the part of it
  // held AT THIS CUSTODIAN. A reconciliation that reports the custodian's
  // numbers back is not a reconciliation, and one compared against every
  // position in the book reports other custodians' holdings as breaks.
  //
  // core.position records no custodian; the only link from a holding to where
  // it is kept is the executed trade's intermediary. What we hold there is the
  // net par of the executed trades booked through it.
  const trades = await selectAllWhere(db, scope, "trade", "id, security_id, side, par_cents",
    (q) => q.eq("intermediary_id", custodian).eq("decision", "executed"));
  const net = new Map<string, number>();
  for (const t of trades) {
    const sec = String(t.security_id);
    const d = t.side === "sell" ? -Number(t.par_cents ?? 0) : Number(t.par_cents ?? 0);
    net.set(sec, (net.get(sec) ?? 0) + d);
  }
  const ours = new Map<string, number>();
  for (const [sec, par] of net) if (par > 0) ours.set(sec, par);

  const theirs = (body.holdings ?? {}) as Record<string, number>;
  const breaks: { security_id: string; ours: number; theirs: number }[] = [];
  for (const [sec, par] of ours) {
    const t = Number(theirs[sec] ?? 0);
    if (t !== par) breaks.push({ security_id: sec, ours: par, theirs: t });
  }
  for (const [sec, par] of Object.entries(theirs)) {
    if (!ours.has(sec)) breaks.push({ security_id: sec, ours: 0, theirs: Number(par) });
  }

  const id = `skrec_${custodian}_${crypto.randomUUID()}`;
  await emit(db, scope, `ev_${id}`, "safekeeping.reconciliation.completed",
    "intermediary", custodian, {
      positions_compared: ours.size, breaks: breaks.length, break_detail: breaks.slice(0, 10),
    }, ctx);
  return jsonResponse({ data: { breaks: breaks.length } }, 200, requestId);
}

// ------------------------------------------------------------ IP-05 credit

/** POST /investment/credit-files {issuer_ref, internal_rating, analysis_ref, approved_by} */
export async function postCreditFile(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const errors: ValidationErrorItem[] = [];
  for (const f of ["issuer_ref", "internal_rating", "analysis_ref", "approved_by"]) {
    if (!isNonEmptyString(body[f])) {
      // IP-05 requires the credit union's OWN analysis. A file carrying only an
      // external rating is reliance on a rating agency, which is the thing the
      // control exists to prevent.
      errors.push({ type: "missing_field", field: f, message: "is required" });
    }
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const now = new Date();
  const id = `cfile_${body.issuer_ref}`;
  const { error } = await db.schema(scope).from("credit_file").upsert({
    id, issuer_ref: body.issuer_ref, internal_rating: body.internal_rating,
    external_rating: isNonEmptyString(body.external_rating) ? body.external_rating : null,
    analysis_ref: body.analysis_ref, approved_by: body.approved_by,
    approved_at: now.toISOString(),
    reanalysis_due_at: plusDays(now, CREDIT_REANALYSIS_DAYS),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_appr`, "credit_file.approved", "credit_file", id, {
    issuer_ref: body.issuer_ref, internal_rating: body.internal_rating,
    approved_by: body.approved_by,
  }, ctx);
  await emit(db, scope, `ev_${id}_rating`, "credit_file.internal_rating", "credit_file", id, {
    internal_rating: body.internal_rating, external_rating: body.external_rating ?? null,
  }, ctx);
  await emit(db, scope, `ev_${id}_due`, "credit_file.reanalysis_due_at", "credit_file", id, {
    reanalysis_due_at: plusDays(now, CREDIT_REANALYSIS_DAYS),
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/** POST /investment/credit-files/:id/reanalyse {internal_rating, analysis_ref} */
export async function postCreditFileReanalysis(
  req: Request, fileId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: f } = await db.schema(scope).from("credit_file")
    .select("id, issuer_ref, internal_rating, reanalysis_due_at").eq("id", fileId).maybeSingle();
  if (!f) return notFoundResponse(requestId, "credit_file", fileId);
  if (!isNonEmptyString(body.analysis_ref)) {
    return validationError(requestId, [{
      type: "missing_field", field: "analysis_ref",
      message: "a re-analysis without the analysis is a date change",
    }]);
  }
  const now = new Date();
  const newRating = isNonEmptyString(body.internal_rating)
    ? body.internal_rating
    : String(f.internal_rating);
  const { error } = await db.schema(scope).from("credit_file").update({
    internal_rating: newRating, analysis_ref: body.analysis_ref,
    reanalysed_at: now.toISOString(),
    reanalysis_due_at: plusDays(now, CREDIT_REANALYSIS_DAYS),
    updated_at: now.toISOString(),
  }).eq("id", fileId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${fileId}_re`, "credit_file.reanalysis.completed",
    "credit_file", fileId, {
      internal_rating: newRating, prior_rating: f.internal_rating,
      completed_late: f.reanalysis_due_at
        ? now.toISOString() > String(f.reanalysis_due_at)
        : null,
    }, ctx);
  return jsonResponse({ data: { id: fileId, internal_rating: newRating } }, 200, requestId);
}

/**
 * POST /investment/securities/:id/downgrade {new_rating, reviewed_by?, board_notified?}
 *
 * IP-05. A downgrade is not itself the control — the REVIEW is. A downgrade
 * recorded and never reviewed is exactly the state that must remain visible,
 * so the review is a separate act with its own evidence.
 */
export async function postSecurityDowngrade(
  req: Request, securityId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: sec } = await db.schema(scope).from("security")
    .select("id, issuer_ref, external_rating, instrument_class").eq("id", securityId).maybeSingle();
  if (!sec) return notFoundResponse(requestId, "security", securityId);
  if (!isNonEmptyString(body.new_rating)) {
    return validationError(requestId, [{
      type: "missing_field", field: "new_rating", message: "is required",
    }]);
  }

  const now = new Date();
  const reviewedBy = isNonEmptyString(body.reviewed_by) ? body.reviewed_by : null;
  const { error } = await db.schema(scope).from("security").update({
    external_rating: body.new_rating, downgraded_at: now.toISOString(),
    downgrade_reviewed_at: reviewedBy ? now.toISOString() : null,
    downgrade_reviewed_by: reviewedBy, updated_at: now.toISOString(),
  }).eq("id", securityId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${securityId}_dg`, "security.downgraded", "security", securityId, {
    from: sec.external_rating, to: body.new_rating, issuer_ref: sec.issuer_ref,
  }, ctx);
  if (reviewedBy) {
    await emit(db, scope, `ev_${securityId}_dgrev`, "security.downgrade.reviewed",
      "security", securityId, {
        reviewed_by: reviewedBy, rating: body.new_rating,
        disposition: body.disposition ?? "hold",
      }, ctx);
    // IP-05: a downgrade below investment grade goes to the Board. Notifying on
    // every downgrade would make the notification meaningless.
    if (body.board_notified === true || String(body.new_rating).startsWith("B")) {
      await emit(db, scope, `ev_${securityId}_board`, "board.notification.sent",
        "security", securityId, {
          reason: "credit_downgrade", rating: body.new_rating, issuer_ref: sec.issuer_ref,
        }, ctx);
    }
  }
  return jsonResponse({ data: { id: securityId, reviewed: reviewedBy !== null } }, 200, requestId);
}

// -------------------------------------------------------- IP-07 the limits

/** The limit in force for a scope. */
export async function limitInForce(
  db: SupabaseClient, scope: EvidenceScope, kind: string, ref: string, at: Date,
): Promise<Record<string, Any> | null> {
  const { data } = await db.schema(scope).from("limit_set")
    .select("id, scope_kind, scope_ref, limit_bp_of_capital, warning_bp_of_capital, effective_at, superseded_at")
    .eq("scope_kind", kind).eq("scope_ref", ref)
    .order("effective_at", { ascending: false });
  const iso = at.toISOString();
  for (const row of data ?? []) {
    if (String(row.effective_at) > iso) continue;
    if (row.superseded_at && String(row.superseded_at) <= iso) continue;
    return row;
  }
  return null;
}

/** PUT /investment/limits {scope_kind, scope_ref, limit_bp_of_capital, approved_by} */
export async function putLimitSet(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const limit = typeof body.limit_bp_of_capital === "number" ? body.limit_bp_of_capital : NaN;
  const warn = typeof body.warning_bp_of_capital === "number" ? body.warning_bp_of_capital : null;
  const kinds = ["issuer", "instrument_class", "intermediary", "sector"];
  if (!kinds.includes(String(body.scope_kind)) || !isNonEmptyString(body.scope_ref) ||
      !Number.isFinite(limit) || limit <= 0 || !isNonEmptyString(body.approved_by)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "limit_bp_of_capital",
      message: "scope_kind, scope_ref, a positive limit and approved_by are required",
    }]);
  }
  if (warn !== null && warn >= limit) {
    // A warning at or above the limit never fires before the limit does, which
    // makes it decoration.
    return validationError(requestId, [{
      type: "invalid_value", field: "warning_bp_of_capital",
      message: "the warning level must be below the limit",
    }]);
  }
  const now = new Date();
  const effectiveAt = isNonEmptyString(body.effective_at) ? body.effective_at : now.toISOString();
  const id = `limit_${body.scope_kind}_${body.scope_ref}_${new Date(effectiveAt).getTime()}`;
  const { error } = await db.schema(scope).from("limit_set").upsert({
    id, scope_kind: body.scope_kind, scope_ref: body.scope_ref,
    limit_bp_of_capital: limit, warning_bp_of_capital: warn,
    approved_by: body.approved_by, effective_at: effectiveAt,
    last_reviewed_at: now.toISOString(), provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_rev`, "limit_set.review.completed", "limit_set", id, {
    scope_kind: body.scope_kind, scope_ref: body.scope_ref,
    limit_bp_of_capital: limit, warning_bp_of_capital: warn,
  }, ctx);
  return jsonResponse({ data: { id } }, 200, requestId);
}

async function netWorthCents(db: SupabaseClient, scope: EvidenceScope): Promise<number | null> {
  const { data } = await db.schema(scope).from("capital_position")
    .select("id, as_of_date, net_worth_cents")
    .order("as_of_date", { ascending: false }).limit(1);
  const row = (data ?? [])[0];
  return row ? Number(row.net_worth_cents) : null;
}

// --------------------------------------------------------- IP-11/14 trading

export interface TradeGateVerdict {
  /** the class and issuer the gate judged — the security master's, not the ticket's */
  instrument_class: string;
  issuer_ref: string;
  permissibility: "permissible" | "prohibited" | "unassessed";
  limit: "within" | "warning" | "breached" | "unassessed";
  reasons: string[];
  projected_par_cents: number;
  exposure_bp: number | null;
}

/**
 * THE TRADE GATE — permissibility, issuer concentration, counterparty
 * approval and segregation of duties, evaluated together.
 *
 * Concentration is measured on the PROJECTED position (current + this trade).
 * Testing the current holding and then booking permits every first breach —
 * the same defect the CDA cap and the cash device limit avoid, and the third
 * place in this repo the projection matters.
 */
export async function evaluateTradeGate(
  db: SupabaseClient, scope: EvidenceScope,
  t: {
    security_id: string; instrument_class: string; issuer_ref: string;
    intermediary_id: string | null; par_cents: number; side: string;
    executed_by: string; maturity_months?: number | null;
  },
  now: Date,
): Promise<TradeGateVerdict> {
  const reasons: string[] = [];

  // Classify by the SECURITY MASTER. The ticket's instrument_class and
  // issuer_ref are what the trader says the security is; the gate exists to
  // check that, so a ticket that relabels a prohibited security as a
  // permitted class must not be able to choose its own verdict. A ticket that
  // disagrees with the master is refused outright, and the master's labels
  // are the ones every check below is run against.
  const { data: sec } = await db.schema(scope).from("security")
    .select("id, issuer_ref, instrument_class").eq("id", t.security_id).maybeSingle();
  let instrumentClass = t.instrument_class;
  let issuerRef = t.issuer_ref;
  if (!sec) {
    reasons.push("security_not_in_master");
  } else {
    if (sec.instrument_class != null) {
      if (String(sec.instrument_class) !== t.instrument_class) {
        reasons.push("instrument_class_disagrees_with_security_master");
      }
      instrumentClass = String(sec.instrument_class);
    }
    if (sec.issuer_ref != null) {
      if (String(sec.issuer_ref) !== t.issuer_ref) {
        reasons.push("issuer_disagrees_with_security_master");
      }
      issuerRef = String(sec.issuer_ref);
    }
  }

  // IP-14: only an actor the role register holds for EXECUTION may execute.
  // `executed_by` here is the authenticated caller (postTrade binds it).
  const role = await userRole(db, scope, t.executed_by);
  if (role !== "execution") reasons.push("executor_not_registered_for_execution");

  const entry = await instrumentEntryInForce(db, scope, instrumentClass, now);
  let permissibility: TradeGateVerdict["permissibility"];
  if (!entry) {
    // An instrument class not on the list is NOT permissible by default. 12
    // CFR 703 is a permitted-list regime, not a prohibited-list one, so
    // absence means no.
    permissibility = "unassessed";
    reasons.push("instrument_class_not_on_list");
  } else if (entry.permissible !== true) {
    permissibility = "prohibited";
    reasons.push("instrument_prohibited");
  } else {
    permissibility = "permissible";
    if (entry.max_maturity_months != null && t.maturity_months != null &&
        t.maturity_months > Number(entry.max_maturity_months)) {
      permissibility = "prohibited";
      reasons.push("maturity_exceeds_list_limit");
    }
  }

  // counterparty
  if (!t.intermediary_id) {
    reasons.push("no_intermediary");
  } else {
    const { data: im } = await db.schema(scope).from("intermediary")
      .select("id, approved, kind").eq("id", t.intermediary_id).maybeSingle();
    if (!im || im.approved !== true) reasons.push("intermediary_not_approved");
  }

  // concentration, on the PROJECTED position. Only this issuer's securities
  // and their positions are read: a whole-book read is capped at 1000 rows by
  // PostgREST and would sum an arbitrary subset once the book passes it.
  const { data: issuerSecs } = await db.schema(scope).from("security")
    .select("id").eq("issuer_ref", issuerRef);
  const secIds = (issuerSecs ?? []).map((s: Any) => String(s.id));
  let held = 0;
  if (secIds.length > 0) {
    const { data: positions } = await db.schema(scope).from("position")
      .select("id, security_id, par_cents").in("security_id", secIds);
    for (const p of positions ?? []) held += Number(p.par_cents ?? 0);
  }
  const delta = t.side === "buy" ? t.par_cents : -t.par_cents;
  const projected = held + delta;

  const nw = await netWorthCents(db, scope);
  const limit = await limitInForce(db, scope, "issuer", issuerRef, now);
  let limitVerdict: TradeGateVerdict["limit"];
  let exposureBp: number | null = null;
  if (!limit || nw === null || nw <= 0) {
    // No limit configured, or no capital position to measure against, means
    // the concentration is UNKNOWN. Unknown is not within-limit.
    limitVerdict = "unassessed";
    reasons.push(!limit ? "no_issuer_limit_set" : "net_worth_unknown");
  } else {
    exposureBp = Math.floor((projected * 10000) / nw);
    if (exposureBp > Number(limit.limit_bp_of_capital)) {
      limitVerdict = "breached";
      reasons.push("issuer_limit_breached");
    } else if (limit.warning_bp_of_capital != null &&
               exposureBp > Number(limit.warning_bp_of_capital)) {
      limitVerdict = "warning";
    } else {
      limitVerdict = "within";
    }
  }

  return {
    instrument_class: instrumentClass, issuer_ref: issuerRef,
    permissibility, limit: limitVerdict, reasons, projected_par_cents: projected, exposure_bp: exposureBp,
  };
}

/**
 * POST /investment/trades
 * {security_id, instrument_class, issuer_ref, intermediary_id, side, par_cents,
 *  price_bp, executed_by, trade_date, maturity_months?, checklist_completed?}
 */
export async function postTrade(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const par = typeof body.par_cents === "number" ? body.par_cents : NaN;
  const errors: ValidationErrorItem[] = [];
  for (const f of ["security_id", "instrument_class", "issuer_ref", "executed_by"]) {
    if (!isNonEmptyString(body[f])) {
      errors.push({ type: "missing_field", field: f, message: "is required" });
    }
  }
  if (!Number.isFinite(par) || par <= 0) {
    errors.push({ type: "invalid_value", field: "par_cents", message: "must be greater than zero" });
  }
  if (body.side !== "buy" && body.side !== "sell") {
    errors.push({ type: "invalid_value", field: "side", message: "must be buy or sell" });
  }
  if (errors.length > 0) return validationError(requestId, errors);

  // IP-14: the executing trader IS the caller. `executed_by` stays on the
  // ticket as the caller's statement of who it is; a ticket naming someone
  // else is refused at the gate (recorded, like every other refusal).
  const { actor, mismatch } = actingIdentity(ctx, String(body.executed_by));

  const now = new Date();
  const verdict = await evaluateTradeGate(db, scope, {
    security_id: String(body.security_id), instrument_class: String(body.instrument_class),
    issuer_ref: String(body.issuer_ref),
    intermediary_id: isNonEmptyString(body.intermediary_id) ? body.intermediary_id : null,
    par_cents: par, side: String(body.side), executed_by: actor,
    maturity_months: typeof body.maturity_months === "number" ? body.maturity_months : null,
  }, now);
  if (mismatch) verdict.reasons.push("executed_by_is_not_the_caller");
  // A security the master does not hold cannot be traded, and a trade row
  // naming it cannot be written (trade_security_id_fkey): answer 404, as the
  // downgrade and fair-value routes do, before anything is recorded.
  if (verdict.reasons.includes("security_not_in_master")) {
    return notFoundResponse(requestId, "security", String(body.security_id));
  }

  // IP-11: the pre-purchase checklist is a precondition, not a formality.
  const checklistDone = body.checklist_completed === true;
  if (!checklistDone) verdict.reasons.push("pre_purchase_checklist_incomplete");

  const permitted = verdict.reasons.length === 0;
  const id = `trade_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("trade").upsert({
    id, security_id: body.security_id,
    intermediary_id: isNonEmptyString(body.intermediary_id) ? body.intermediary_id : null,
    side: body.side, par_cents: par,
    price_bp: typeof body.price_bp === "number" ? body.price_bp : 10000,
    trade_date: isNonEmptyString(body.trade_date)
      ? body.trade_date
      : now.toISOString().slice(0, 10),
    executed_by: mismatch ? body.executed_by : actor,
    // IP-02/IP-05/IP-11 read these off the trade: what was bought, what it
    // settled for, and what the price was supported by. A trade recording only
    // par cannot evidence that the price was reasonable.
    instrument_type: isNonEmptyString(body.instrument_type) ? body.instrument_type : null,
    settlement_amount_cents: typeof body.settlement_amount_cents === "number"
      ? body.settlement_amount_cents
      : null,
    valuation_support: isNonEmptyString(body.valuation_support) ? body.valuation_support : null,
    permissibility_verdict: verdict.permissibility,
    limit_verdict: verdict.limit,
    decision: permitted ? "executed" : "blocked",
    blocked_reasons: verdict.reasons,
    checklist_completed_at: checklistDone ? now.toISOString() : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_perm`, "trade.permissibility.checked", "trade", id, {
    verdict: verdict.permissibility, instrument_class: verdict.instrument_class,
  }, ctx);
  if (checklistDone) {
    await emit(db, scope, `ev_${id}_chk`, "trade.checklist.completed", "trade", id, {
      security_id: body.security_id,
    }, ctx);
  } else {
    await emit(db, scope, `ev_${id}_chkexc`, "trade.checklist_exception_raised", "trade", id, {
      reason: "checklist not completed before execution",
    }, ctx);
  }
  if (verdict.limit === "warning") {
    await emit(db, scope, `ev_${id}_warn`, "trade.limit_warning.issued", "trade", id, {
      exposure_bp: verdict.exposure_bp, issuer_ref: verdict.issuer_ref,
    }, ctx);
  }

  if (!permitted) {
    await emit(db, scope, `ev_${id}_blk`, "trade.limit.blocked", "trade", id, {
      reasons: verdict.reasons, exposure_bp: verdict.exposure_bp,
    }, ctx);
    if (verdict.permissibility !== "permissible") {
      await emit(db, scope, `ev_${id}_prohib`, "trade.blocked_prohibited", "trade", id, {
        instrument_class: verdict.instrument_class, verdict: verdict.permissibility,
      }, ctx);
    }
    if (verdict.reasons.includes("intermediary_not_approved") ||
        verdict.reasons.includes("no_intermediary")) {
      await emit(db, scope, `ev_${id}_interm`, "trade.intermediary.blocked", "trade", id, {
        intermediary_id: body.intermediary_id ?? null,
      }, ctx);
    }
    if (verdict.limit === "breached") {
      await emit(db, scope, `ev_${id}_conc`, "concentration.limit_exceeded", "trade", id, {
        issuer_ref: verdict.issuer_ref, exposure_bp: verdict.exposure_bp,
      }, ctx);
      // IP-07: a breach opens a waiver case rather than being silently refused
      // — the refusal is right, but the Board may still need to decide.
      await emit(db, scope, `ev_${id}_waiver`, "concentration.waiver.opened", "trade", id, {
        issuer_ref: verdict.issuer_ref, exposure_bp: verdict.exposure_bp,
      }, ctx);
    }
    return apiError(409, "trade_blocked", requestId, {
      title: "trade blocked", detail: verdict.reasons.join(", "),
    });
  }

  // POSITION is updated only after the gate passes.
  const posId = `pos_${body.security_id}`;
  const { data: pos } = await db.schema(scope).from("position")
    .select("id, par_cents, book_value_cents").eq("id", posId).maybeSingle();
  const delta = body.side === "buy" ? par : -par;
  const newPar = Math.max(0, Number(pos?.par_cents ?? 0) + delta);
  await db.schema(scope).from("position").upsert({
    id: posId, security_id: body.security_id, par_cents: newPar,
    book_value_cents: newPar, booked_at: now.toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });

  await emit(db, scope, `ev_${posId}_booked`, "position.booked", "position", posId, {
    security_id: body.security_id, par_cents: newPar, trade_id: id,
  }, ctx);
  await emit(db, scope, `ev_${id}_step`, "trade.step.recorded", "trade", id, {
    step: "executed", actor,
  }, ctx);
  await emit(db, scope, `ev_${id}_appr`, "trade.approval.requested", "trade", id, {
    security_id: body.security_id, par_cents: par,
  }, ctx);

  // IP-15: the required document set is declared at execution with its clock.
  for (const doc of REQUIRED_TRADE_DOCUMENTS) {
    await db.schema(scope).from("document").upsert({
      id: `doc_${id}_${doc}`, subject_kind: "trade", subject_ref: id, doc_type: doc,
      attachment_due_at: plusDays(now, DOCUMENT_ATTACHMENT_DAYS),
      provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id", ignoreDuplicates: true });
  }
  await emit(db, scope, `ev_${id}_docs`, "document.required_set", "trade", id, {
    required: REQUIRED_TRADE_DOCUMENTS,
    attachment_due_at: plusDays(now, DOCUMENT_ATTACHMENT_DAYS),
  }, ctx);
  return jsonResponse({ data: { id, decision: "executed" } }, 201, requestId);
}

/**
 * POST /investment/trades/:id/confirm {confirmed_by, confirmation_ref, counterparty_par_cents}
 *
 * IP-14. The confirmation is the ONLY independent evidence that the trade the
 * book records is the trade the counterparty thinks happened. Matching it
 * against the counterparty's own figures is the control; storing the reference
 * alone would confirm nothing.
 */
export async function postTradeConfirmation(
  req: Request, tradeId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: t } = await db.schema(scope).from("trade")
    .select("id, executed_by, par_cents, decision").eq("id", tradeId).maybeSingle();
  if (!t) return notFoundResponse(requestId, "trade", tradeId);

  const claimed = isNonEmptyString(body.confirmed_by) ? body.confirmed_by : null;
  if (!claimed) {
    return validationError(requestId, [{
      type: "missing_field", field: "confirmed_by", message: "is required",
    }]);
  }
  // IP-14: the confirmer is the authenticated caller. Segregation is checked
  // against WHO IS CALLING, so the executing trader's own credential is
  // refused here whatever name the body carries.
  const { actor: by, mismatch } = actingIdentity(ctx, claimed);
  await db.schema(scope).from("trade").update({
    step_attempted: "confirmation", ticket: `tkt_${tradeId}`,
    updated_at: new Date().toISOString(),
  }).eq("id", tradeId);
  if (by === t.executed_by) {
    // Three-role separation: the trader who executed cannot confirm.
    const vid = `sodv_${tradeId}_confirm`;
    await db.schema(scope).from("sod_violation").upsert({
      id: vid, subject_kind: "trade", subject_ref: tradeId,
      role_a: "execution", role_b: "confirmation", actor_ref: by,
      detected_at: new Date().toISOString(), provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id" });
    await emit(db, scope, `ev_${vid}`, "sod.violation.logged", "trade", tradeId, {
      role_a: "execution", role_b: "confirmation", actor_ref: by,
      "user.id": by, "user.role": await userRole(db, scope, by),
      "sod.matrix_version": SOD_MATRIX_VERSION,
      "trade.step_attempted": "confirmation", "trade.ticket": `tkt_${tradeId}`,
    }, ctx);
    await emit(db, scope, `ev_${tradeId}_sodblk`, "trade.sod.blocked", "trade", tradeId, {
      reason: "executing trader cannot confirm their own trade",
    }, ctx);
    return apiError(409, "trade_sod_violation", requestId, {
      title: "segregation of duties", detail: "the executing trader cannot confirm this trade",
    });
  }
  if (mismatch) return actorMismatchResponse(requestId, "confirmed_by", "confirmation");

  const cpPar = typeof body.counterparty_par_cents === "number"
    ? body.counterparty_par_cents
    : null;
  const matched = cpPar !== null && cpPar === Number(t.par_cents);
  const now = new Date();
  const { error } = await db.schema(scope).from("trade").update({
    confirmed_by: by, confirmation_ref: body.confirmation_ref ?? null,
    confirmation_matched: matched, updated_at: now.toISOString(),
  }).eq("id", tradeId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${tradeId}_conf`, "trade.confirmation.received",
    "trade", tradeId, { confirmed_by: by, confirmation_ref: body.confirmation_ref ?? null }, ctx);
  if (matched) {
    await emit(db, scope, `ev_${tradeId}_match`, "trade.confirmation_matched",
      "trade", tradeId, { par_cents: t.par_cents }, ctx);
  } else {
    await emit(db, scope, `ev_${tradeId}_disc`, "trade.confirmation_discrepancy.flagged",
      "trade", tradeId, { ours: t.par_cents, theirs: cpPar }, ctx);
  }
  await emit(db, scope, `ev_${tradeId}_step2`, "trade.step.recorded", "trade", tradeId, {
    step: "confirmed", actor: by,
  }, ctx);
  return jsonResponse({ data: { id: tradeId, matched } }, 200, requestId);
}

/** POST /investment/trades/:id/reconcile {settled_by} */
export async function postTradeReconciliation(
  req: Request, tradeId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: t } = await db.schema(scope).from("trade")
    .select("id, executed_by, confirmed_by, confirmation_matched").eq("id", tradeId).maybeSingle();
  if (!t) return notFoundResponse(requestId, "trade", tradeId);
  const claimed = isNonEmptyString(body.settled_by) ? body.settled_by : null;
  if (!claimed) {
    return validationError(requestId, [{
      type: "missing_field", field: "settled_by", message: "is required",
    }]);
  }
  // IP-14: the settler is the authenticated caller, as for the confirmation.
  const { actor: by, mismatch } = actingIdentity(ctx, claimed);
  await db.schema(scope).from("trade").update({
    step_attempted: "settlement", ticket: `tkt_${tradeId}`,
    updated_at: new Date().toISOString(),
  }).eq("id", tradeId);
  if (by === t.executed_by) {
    const vid = `sodv_${tradeId}_settle`;
    await db.schema(scope).from("sod_violation").upsert({
      id: vid, subject_kind: "trade", subject_ref: tradeId,
      role_a: "execution", role_b: "settlement", actor_ref: by,
      detected_at: new Date().toISOString(), provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id" });
    await emit(db, scope, `ev_${vid}`, "sod.violation.logged", "trade", tradeId, {
      role_a: "execution", role_b: "settlement", actor_ref: by,
      "user.id": by, "user.role": await userRole(db, scope, by),
      "sod.matrix_version": SOD_MATRIX_VERSION,
      "trade.step_attempted": "settlement", "trade.ticket": `tkt_${tradeId}`,
    }, ctx);
    return apiError(409, "trade_sod_violation", requestId, {
      title: "segregation of duties", detail: "the executing trader cannot settle this trade",
    });
  }
  if (mismatch) return actorMismatchResponse(requestId, "settled_by", "settlement");
  const now = new Date();
  await db.schema(scope).from("trade").update({
    settled_by: by, reconciled_at: now.toISOString(), updated_at: now.toISOString(),
  }).eq("id", tradeId);

  await emit(db, scope, `ev_${tradeId}_recon`, "trade.reconciliation.completed",
    "trade", tradeId, {
      settled_by: by, confirmation_matched: asBool(t.confirmation_matched),
    }, ctx);
  await emit(db, scope, `ev_${tradeId}_step3`, "trade.step.recorded", "trade", tradeId, {
    step: "settled", actor: by,
  }, ctx);
  return jsonResponse({ data: { id: tradeId, reconciled: true } }, 200, requestId);
}

/** POST /investment/trade-exceptions {trade_id?, kind, detail, raised_by, approved_by?} */
export async function postTradeException(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.kind) || !isNonEmptyString(body.raised_by)) {
    return validationError(requestId, [{
      type: "missing_field", field: "raised_by", message: "kind and raised_by are required",
    }]);
  }
  const approvedBy = isNonEmptyString(body.approved_by) ? body.approved_by : null;
  if (approvedBy && approvedBy === body.raised_by) {
    return apiError(409, "trade_exception_self_approved", requestId, {
      title: "exception self-approved",
      detail: "the person raising a trade exception cannot approve it",
    });
  }
  const now = new Date();
  const id = `texc_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("trade_exception").upsert({
    id, trade_id: isNonEmptyString(body.trade_id) ? body.trade_id : null,
    kind: body.kind, detail: body.detail ?? {}, raised_by: body.raised_by,
    approved_by: approvedBy, approved_at: approvedBy ? now.toISOString() : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_log`, "trade.exception.logged", "trade_exception", id, {
    kind: body.kind, raised_by: body.raised_by,
  }, ctx);
  if (approvedBy) {
    await emit(db, scope, `ev_${id}_appr`, "trade.exception.approved",
      "trade_exception", id, { approved_by: approvedBy, kind: body.kind }, ctx);
  }
  return jsonResponse({ data: { id } }, 201, requestId);
}

// ------------------------------------------------------------- IP-09 repo

/**
 * POST /investment/repos
 * {intermediary_id, direction, principal_cents, collateral_value_cents,
 *  required_margin_bp}
 */
export async function postRepoAgreement(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const principal = typeof body.principal_cents === "number" ? body.principal_cents : NaN;
  const collateral = typeof body.collateral_value_cents === "number"
    ? body.collateral_value_cents
    : NaN;
  const required = typeof body.required_margin_bp === "number" ? body.required_margin_bp : NaN;
  if (!Number.isFinite(principal) || principal <= 0 || !Number.isFinite(collateral) ||
      !Number.isFinite(required)) {
    return validationError(requestId, [{
      type: "missing_field", field: "collateral_value_cents",
      message: "principal_cents, collateral_value_cents and required_margin_bp are required",
    }]);
  }
  const actual = Math.trunc(((collateral - principal) * 10000) / principal);
  const shortfall = actual < required;

  // 12 CFR 703.13: the counterparty must be approved for repo.
  let blockedReason: string | null = null;
  if (isNonEmptyString(body.intermediary_id)) {
    const { data: im } = await db.schema(scope).from("intermediary")
      .select("id, approved").eq("id", body.intermediary_id).maybeSingle();
    if (!im || im.approved !== true) blockedReason = "intermediary_not_approved";
  } else {
    blockedReason = "no_intermediary";
  }

  const now = new Date();
  const id = `repo_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("repo_agreement").upsert({
    id, intermediary_id: isNonEmptyString(body.intermediary_id) ? body.intermediary_id : null,
    direction: body.direction === "reverse_repo" ? "reverse_repo" : "repo",
    principal_cents: principal, collateral_value_cents: collateral,
    required_margin_bp: required, actual_margin_bp: actual,
    revaluation_due_at: plusDays(now, REPO_REVALUATION_DAYS),
    decision: blockedReason ? "blocked" : "booked", blocked_reason: blockedReason,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  if (blockedReason) {
    await emit(db, scope, `ev_${id}_blk`, "repo.blocked_rule_violation", "repo_agreement", id, {
      reason: blockedReason,
    }, ctx);
    return apiError(409, "repo_blocked", requestId, {
      title: "repo blocked", detail: blockedReason,
    });
  }
  await emit(db, scope, `ev_${id}_booked`, "repo.booked", "repo_agreement", id, {
    principal_cents: principal, collateral_value_cents: collateral, actual_margin_bp: actual,
  }, ctx);
  await emit(db, scope, `ev_${id}_mark`, "repo.collateral_marked", "repo_agreement", id, {
    collateral_value_cents: collateral, actual_margin_bp: actual,
  }, ctx);
  await emit(db, scope, `ev_${id}_revdue`, "repo.collateral_revaluation_due_at",
    "repo_agreement", id, { revaluation_due_at: plusDays(now, REPO_REVALUATION_DAYS) }, ctx);

  if (shortfall) {
    // A margin shortfall that produces no CALL is a measurement, not a control.
    await emit(db, scope, `ev_${id}_short`, "repo.margin_shortfall.detected",
      "repo_agreement", id, { actual_margin_bp: actual, required_margin_bp: required }, ctx);
    await db.schema(scope).from("repo_agreement")
      .update({ margin_call_issued_at: now.toISOString() }).eq("id", id);
    await emit(db, scope, `ev_${id}_call`, "repo.margin_call.issued", "repo_agreement", id, {
      shortfall_bp: required - actual,
      additional_collateral_cents:
        Math.ceil((principal * (required - actual)) / 10000),
    }, ctx);
  }
  return jsonResponse({ data: { id, actual_margin_bp: actual, shortfall } }, 201, requestId);
}

// ------------------------------------------------------ IP-10 valuation

/** POST /investment/securities/:id/fair-value {fair_value_cents, source, amortized_cost_cents?} */
export async function postFairValue(
  req: Request, securityId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  // An unknown security is 404 before anything is written or emitted, as a
  // downgrade is: fair-value and impairment evidence about a security nobody
  // holds is evidence of nothing.
  const { data: sec } = await db.schema(scope).from("security")
    .select("id").eq("id", securityId).maybeSingle();
  if (!sec) return notFoundResponse(requestId, "security", securityId);

  const fv = typeof body.fair_value_cents === "number" ? body.fair_value_cents : NaN;
  if (!Number.isFinite(fv) || !isNonEmptyString(body.source)) {
    // A fair value with no source is a number somebody typed. The hierarchy is
    // the whole point of the measurement.
    return validationError(requestId, [{
      type: "missing_field", field: "source",
      message: "fair_value_cents and its source are required",
    }]);
  }
  const now = new Date();
  const cost = typeof body.amortized_cost_cents === "number" ? body.amortized_cost_cents : null;
  const { error } = await db.schema(scope).from("security").update({
    fair_value_cents: fv, fair_value_at: now.toISOString(),
    fair_value_source: body.source,
    amortized_cost_cents: cost, updated_at: now.toISOString(),
  }).eq("id", securityId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${securityId}_fv`, "security.fair_value.updated",
    "security", securityId, {
      fair_value_cents: fv, source: body.source, amortized_cost_cents: cost,
    }, ctx);

  // IP-10: an other-than-temporary impairment analysis runs when fair value is
  // below cost. Running it only when someone remembers is how an impairment
  // goes unrecognised for a reporting period.
  if (cost !== null && fv < cost) {
    const impairment = cost - fv;
    await db.schema(scope).from("security")
      .update({ otti_recognised_cents: impairment }).eq("id", securityId);
    await emit(db, scope, `ev_${securityId}_otti`, "security.otti_analysis.completed",
      "security", securityId, {
        impairment_cents: impairment, fair_value_cents: fv, amortized_cost_cents: cost,
        conclusion: "other_than_temporary",
      }, ctx);
  } else {
    await emit(db, scope, `ev_${securityId}_ottiok`, "security.otti_analysis.completed",
      "security", securityId, {
        impairment_cents: 0, conclusion: "no_impairment",
      }, ctx);
  }
  // the position's market value follows the security's fair value
  await db.schema(scope).from("position")
    .update({ market_value_cents: fv, updated_at: now.toISOString() })
    .eq("security_id", securityId);
  await emit(db, scope, `ev_${securityId}_posan`, "position.analytics.updated",
    "security", securityId, { market_value_cents: fv }, ctx);
  return jsonResponse({ data: { id: securityId, fair_value_cents: fv } }, 200, requestId);
}

// -------------------------------------------------- IP-06 / IP-17 liquidity

/** POST /investment/liquidity/classify {security_id, liquidity_class} */
export async function postLiquidityClassification(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const classes = ["level_1", "level_2", "level_3"];
  if (!isNonEmptyString(body.security_id) || !classes.includes(String(body.liquidity_class))) {
    return validationError(requestId, [{
      type: "invalid_value", field: "liquidity_class",
      message: `security_id and a class in ${classes.join("/")}`,
    }]);
  }
  await db.schema(scope).from("security").update({
    liquidity_class: body.liquidity_class, updated_at: new Date().toISOString(),
  }).eq("id", body.security_id);
  await emit(db, scope, `ev_${body.security_id}_liq`, "position.liquidity.classified",
    "security", String(body.security_id), { liquidity_class: body.liquidity_class }, ctx);
  return jsonResponse({ data: { security_id: body.security_id } }, 200, requestId);
}

/** POST /investment/liquidity/report {period, min_marketable_bp?} */
export async function postLiquidityReport(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  // The figures are COMPUTED from the book, never supplied — the WHOLE book,
  // paged past PostgREST's 1000-row cap.
  const positions = await selectAll<Any>(db, scope, "position", "id, security_id, par_cents");
  const secs = await selectAll<Any>(db, scope, "security", "id, liquidity_class");
  const cls = new Map<string, string>();
  for (const s of secs) cls.set(String(s.id), String(s.liquidity_class ?? "level_3"));

  const buckets = { level_1: 0, level_2: 0, level_3: 0 } as Record<string, number>;
  for (const p of positions) {
    const k = cls.get(String(p.security_id)) ?? "level_3";
    buckets[k] = (buckets[k] ?? 0) + Number(p.par_cents ?? 0);
  }
  const total = buckets.level_1 + buckets.level_2 + buckets.level_3;
  const marketableBp = total > 0
    ? Math.floor(((buckets.level_1 + buckets.level_2) * 10000) / total)
    : 0;
  const minBp = typeof body.min_marketable_bp === "number" ? body.min_marketable_bp : null;
  const breached = minBp === null ? null : marketableBp < minBp;

  const now = new Date();
  const id = `liqrep_${body.period ?? "p"}`;
  const { error } = await db.schema(scope).from("liquidity_report").upsert({
    id, period: String(body.period ?? "p"),
    level_1_cents: buckets.level_1, level_2_cents: buckets.level_2,
    level_3_cents: buckets.level_3, marketable_pct_bp: marketableBp,
    min_marketable_bp: minBp, breached, published_at: now.toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_pub`, "liquidity.report.published", "liquidity_report", id, {
    marketable_pct_bp: marketableBp, min_marketable_bp: minBp, breached,
    level_1_cents: buckets.level_1, level_3_cents: buckets.level_3,
  }, ctx);
  return jsonResponse({ data: { id, marketable_pct_bp: marketableBp, breached } }, 201, requestId);
}

/** POST /investment/cfp {level, changed_by, execution_plan_ref?, trigger_detail?} */
export async function postCfpLevelChange(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const levels = ["normal", "heightened", "stress", "crisis"];
  const level = String(body.level);
  if (!levels.includes(level) || !isNonEmptyString(body.changed_by)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "level", message: `a level in ${levels.join("/")} and changed_by`,
    }]);
  }
  if (level !== "normal" && !isNonEmptyString(body.execution_plan_ref)) {
    // Activating a contingency level without the plan that says what to do is
    // an alarm with no procedure behind it.
    return validationError(requestId, [{
      type: "missing_field", field: "execution_plan_ref",
      message: "activating a contingency level requires the execution plan",
    }]);
  }
  const now = new Date();
  const id = `cfp_${level}_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("cfp_state").upsert({
    id, level, changed_at: now.toISOString(), changed_by: body.changed_by,
    trigger_detail: body.trigger_detail ?? {},
    execution_plan_ref: isNonEmptyString(body.execution_plan_ref)
      ? body.execution_plan_ref
      : null,
    investment_test_completed_at: body.investment_test_completed === true
      ? now.toISOString()
      : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_lvl`, "cfp.level.changed", "cfp_state", id, {
    level, changed_by: body.changed_by, trigger_detail: body.trigger_detail ?? {},
  }, ctx);
  if (level !== "normal") {
    await emit(db, scope, `ev_${id}_act`, "liquidity.cfp.activated", "cfp_state", id, {
      level, execution_plan_ref: body.execution_plan_ref,
    }, ctx);
    await emit(db, scope, `ev_${id}_plan`, "cfp.execution_plan.documented", "cfp_state", id, {
      execution_plan_ref: body.execution_plan_ref,
    }, ctx);
    await emit(db, scope, `ev_${id}_stress`, "liquidity.stress.declared", "cfp_state", id, {
      level,
    }, ctx);
  }
  if (body.investment_test_completed === true) {
    await emit(db, scope, `ev_${id}_test`, "cfp.investment_test.completed", "cfp_state", id, {
      level, execution_plan_ref: body.execution_plan_ref,
    }, ctx);
    // IP-17: a contingency test that finds nothing still opens a finding row
    // saying so — otherwise "tested and clean" and "never tested" look alike.
    await emit(db, scope, `ev_${id}_finding`, "finding.opened", "cfp_state", id, {
      source: "cfp_investment_test", severity: body.test_findings ? "material" : "none",
      findings: body.test_findings ?? [],
    }, ctx);
    await emit(db, scope, `ev_${id}_findrep`, "finding.remediation.reported",
      "cfp_state", id, { remediation: body.test_remediation ?? "none required" }, ctx);
  }
  return jsonResponse({ data: { id, level } }, 201, requestId);
}

// --------------------------------------------- IP-04 / IP-12 ALM and stress

/** POST /investment/simulations {kind, period, scenario, result_bp, minimum_bp?} */
export async function postAlmSimulation(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const kinds = ["irr", "stress", "portfolio_stress"];
  const result = typeof body.result_bp === "number" ? body.result_bp : NaN;
  if (!kinds.includes(String(body.kind)) || !Number.isFinite(result) ||
      !isNonEmptyString(body.scenario)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "kind",
      message: `kind in ${kinds.join("/")}, a scenario and result_bp are required`,
    }]);
  }
  const minBp = typeof body.minimum_bp === "number" ? body.minimum_bp : null;
  const breached = minBp === null ? null : result < minBp;
  const now = new Date();
  const id = `alm_${body.kind}_${body.period ?? "p"}_${body.scenario}`;
  const { error } = await db.schema(scope).from("alm_simulation").upsert({
    id, kind: body.kind, period: String(body.period ?? "p"), scenario: body.scenario,
    result_bp: result, minimum_bp: minBp, breached,
    escalated_at: breached === true ? now.toISOString() : null,
    completed_at: now.toISOString(), provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const code = body.kind === "irr"
    ? "alm.irr_simulation.completed"
    : body.kind === "portfolio_stress"
    ? "portfolio.stress_test.completed"
    : "stress_test.completed";
  await emit(db, scope, `ev_${id}_done`, code, "alm_simulation", id, {
    scenario: body.scenario, result_bp: result, minimum_bp: minBp, breached,
  }, ctx);
  if (breached === true) {
    await emit(db, scope, `ev_${id}_brch`, "stress_test.minimum.breached",
      "alm_simulation", id, { result_bp: result, minimum_bp: minBp }, ctx);
    await emit(db, scope, `ev_${id}_esc`, "stress_test.remediation.escalated",
      "alm_simulation", id, { result_bp: result, minimum_bp: minBp }, ctx);
  }
  return jsonResponse({ data: { id, breached } }, 201, requestId);
}

/** POST /investment/reports {period, audience} — IP-02 / IP-12 reporting. */
export async function postPortfolioReport(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  // Assembled from the book, like every other packet in this repo — all of
  // it: an unpaged read stops at PostgREST's 1000 rows and the board would be
  // shown a count over an arbitrary subset.
  const positions = await selectAll<Any>(db, scope, "position", "id, par_cents, market_value_cents");
  const tradesBlocked = await countWhere(db, scope, "trade", (q) => q.eq("decision", "blocked"));
  const exceptions = await countWhere(db, scope, "trade_exception");

  const audience = body.audience === "board" ? "board" : "management";
  const id = `portrep_${audience}_${body.period ?? "p"}`;
  const payload = {
    period: body.period ?? null,
    positions: positions.length,
    par_cents: positions.reduce((n: number, p: Any) => n + Number(p.par_cents ?? 0), 0),
    trades_blocked: tradesBlocked,
    exceptions,
  };
  await emit(db, scope, `ev_${id}`,
    audience === "board" ? "portfolio.board_report.issued" : "portfolio.management_report.issued",
    "position", id, payload, ctx);
  return jsonResponse({ data: payload }, 201, requestId);
}

/** POST /investment/performance {period, portfolio_return_bp, benchmark_ref, benchmark_return_bp} */
export async function postPerformanceMeasurement(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const ret = typeof body.portfolio_return_bp === "number" ? body.portfolio_return_bp : NaN;
  const bench = typeof body.benchmark_return_bp === "number" ? body.benchmark_return_bp : NaN;
  if (!Number.isFinite(ret) || !Number.isFinite(bench) || !isNonEmptyString(body.benchmark_ref)) {
    // A return with no benchmark cannot be assessed. IP-13's control is the
    // COMPARISON, not the number.
    return validationError(requestId, [{
      type: "missing_field", field: "benchmark_ref",
      message: "a portfolio return is meaningless without the benchmark it is measured against",
    }]);
  }
  const id = `perf_${body.period ?? "p"}`;
  const { error } = await db.schema(scope).from("performance_measurement").upsert({
    id, period: String(body.period ?? "p"), portfolio_return_bp: ret,
    benchmark_ref: body.benchmark_ref, benchmark_return_bp: bench,
    attribution: body.attribution ?? {},
    target_risk_reviewed_at: new Date().toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_attr`, "performance.attribution.completed",
    "performance_measurement", id, {
      portfolio_return_bp: ret, benchmark_return_bp: bench,
      excess_bp: ret - bench, attribution: body.attribution ?? {},
    }, ctx);
  await emit(db, scope, `ev_${id}_risk`, "performance.target_risk.reviewed",
    "performance_measurement", id, { benchmark_ref: body.benchmark_ref }, ctx);
  return jsonResponse({ data: { id, excess_bp: ret - bench } }, 201, requestId);
}
