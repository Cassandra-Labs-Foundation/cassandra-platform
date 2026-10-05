// Cash transactions and Currency Transaction Reporting (BSA-08).
//
// This is the first thing in the core that represents CURRENCY, which is why
// it is the first thing that can owe a CTR. CG-LGTXN-01 fires on electronic
// movements and those are not CTR-reportable at all (OQ-01); the control here
// is the real one.
//
// THE DESIGN PROBLEM THIS DOMAIN FORCED INTO THE OPEN
//
// BSA-08 aggregates "per person per business day". The core had no concept of a
// person owning an account until 20260719001300, and legacy accounts still have
// no owner because nothing in the data says who they belong to. So aggregation
// has to handle currency it CANNOT attribute to anyone.
//
// There are three ways to handle that and two of them are wrong:
//
//   drop unattributable rows     -> the aggregate silently understates, and a
//                                   CTR that was owed is never detected
//   bucket each as its own person -> every unlinked account looks like a
//                                   separate individual under the threshold,
//                                   which is structuring by accident
//   surface them (this file)      -> counted, reported separately, and the day
//                                   is marked INCOMPLETE
//
// The first two are the same class of failure as fabricating the entity link:
// they turn "we do not know" into a confident wrong answer. Unattributable cash
// is a compliance FINDING — if $50k of currency moved through accounts with no
// known owner, nobody can say whether a CTR was owed, and that is exactly the
// thing an examiner asks about.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor, raiseAlert } from "./bsa.ts";
import { startRetentionFor } from "./retention.ts";
import {
  internalErrorResponse,
  isNonEmptyString,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  sha256Hex,
  validationError,
  type ValidationErrorItem,
} from "./lib.ts";

/** 31 CFR 1010.311 — aggregate currency over $10,000 in one business day. */
export const CTR_THRESHOLD_CENTS = 1_000_000;
/** 31 CFR 1010.306(a)(1) — 15 calendar days from the transaction date. */
export const CTR_FILING_DAYS = 15;

const SWEEP_LIMIT = 100;

const DIRECTIONS = ["cash_in", "cash_out"] as const;

const CASH_COLS =
  "id, direction, amount, account_id, entity_id, business_date, occurred_at, " +
  "branch_ref, teller_ref, instrument_type, provenance, created_at";

/** Cash handling is the credit union's own operation, not a fintech's. */
function requireCashActor(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/cash");
  return null;
}

async function emitCashEvent(
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
  if (error) throw new Error(`cash event (${code}): ${error.message}`);
}

export function ctrDueAt(businessDate: string): string {
  const d = new Date(`${businessDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + CTR_FILING_DAYS);
  return d.toISOString();
}

/**
 * Aggregate one business day, separating what can be attributed from what
 * cannot.
 *
 * Exported because both the recording path and the reporting endpoint need the
 * same arithmetic — a second implementation would be a second chance to drop
 * the unattributable rows.
 */
export function aggregateDay(rows: Record<string, unknown>[]): {
  attributed: Record<string, { cash_in: number; cash_out: number; ids: string[] }>;
  unattributable: { cash_in: number; cash_out: number; ids: string[] };
} {
  const attributed: Record<string, { cash_in: number; cash_out: number; ids: string[] }> = {};
  const unattributable = { cash_in: 0, cash_out: 0, ids: [] as string[] };

  for (const r of rows) {
    const amount = Number(r.amount ?? 0);
    const dir = String(r.direction);
    const entity = r.entity_id;

    if (!isNonEmptyString(entity)) {
      // NOT dropped, NOT given a synthetic identity of its own.
      if (dir === "cash_in") unattributable.cash_in += amount;
      else unattributable.cash_out += amount;
      unattributable.ids.push(String(r.id));
      continue;
    }
    const bucket = attributed[entity] ?? { cash_in: 0, cash_out: 0, ids: [] };
    if (dir === "cash_in") bucket.cash_in += amount;
    else bucket.cash_out += amount;
    bucket.ids.push(String(r.id));
    attributed[entity] = bucket;
  }
  return { attributed, unattributable };
}

/** Cash-in and cash-out are assessed SEPARATELY, never summed together. */
export function crossesThreshold(b: { cash_in: number; cash_out: number }): boolean {
  return b.cash_in > CTR_THRESHOLD_CENTS || b.cash_out > CTR_THRESHOLD_CENTS;
}

/**
 * POST /cash/transactions
 *
 * Records currency moving, then re-aggregates that person's business day and
 * opens or amends a CTR obligation if the aggregate crosses the threshold.
 *
 * The entity is resolved from the ACCOUNT when not supplied directly, which is
 * the normal teller case. If the account has no owner the transaction is still
 * recorded — with a null entity — and the day becomes incomplete.
 */
export async function postCashTransaction(
  req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireCashActor(ctx, requestId);
  if (denied) return denied;

  const body = await parseJsonBody(req).catch(() => null);
  const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};

  const errors: ValidationErrorItem[] = [];
  if (!DIRECTIONS.includes(rec.direction as typeof DIRECTIONS[number])) {
    errors.push({
      type: "invalid_value",
      field: "direction",
      message: `must be one of: ${DIRECTIONS.join(", ")}`,
    });
  }
  const amount = rec.amount_cents;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    errors.push({
      type: "invalid_value",
      field: "amount_cents",
      message: "must be a positive integer number of cents",
    });
  }
  if (!isNonEmptyString(rec.business_date) || !/^\d{4}-\d{2}-\d{2}$/.test(rec.business_date)) {
    errors.push({
      type: "invalid_value",
      field: "business_date",
      // required rather than derived: CTR aggregates per BUSINESS day, and
      // inferring it from a UTC timestamp silently moves late-day transactions
      // into the wrong reporting period
      message: "is required, as YYYY-MM-DD (the business day, not a timestamp)",
    });
  }
  if (!isNonEmptyString(rec.account_id) && !isNonEmptyString(rec.entity_id)) {
    errors.push({
      type: "missing_field",
      field: "account_id",
      message: "an account_id or an entity_id is required to record currency",
    });
  }
  if (errors.length) return validationError(requestId, errors);

  const businessDate = rec.business_date as string;
  const direction = rec.direction as string;

  // Resolve the person. Explicit entity_id wins; otherwise inherit from the
  // account. A missing owner is NOT an error — it is a recorded unknown.
  let entityId: string | null = isNonEmptyString(rec.entity_id) ? rec.entity_id : null;
  let accountUnlinked = false;
  if (entityId) {
    // An explicit person must exist. Without this lookup the insert hit the
    // cash_transaction.entity_id foreign key and the teller got a bare 500
    // (caught by the cash partner-flow suite); accounts.ts pre-checks the
    // same case for the same reason.
    const { data: ent, error: entErr } = await db.schema(scope === "sim" ? "sim" : "core")
      .from("entity").select("id").eq("id", entityId).maybeSingle();
    if (entErr) return internalErrorResponse(requestId, entErr);
    if (!ent) return notFoundResponse(requestId, "entity", entityId);
  }
  if (!entityId && isNonEmptyString(rec.account_id)) {
    const { data: acct, error: acctErr } = await db.schema(scope === "sim" ? "sim" : "core")
      .from("account").select("id, entity_id").eq("id", rec.account_id).maybeSingle();
    if (acctErr) return internalErrorResponse(requestId, acctErr);
    if (!acct) return notFoundResponse(requestId, "account", String(rec.account_id));
    const owner = (acct as unknown as Record<string, unknown>).entity_id;
    if (isNonEmptyString(owner)) entityId = owner;
    else accountUnlinked = true;
  }

  const txnId = `cash_${crypto.randomUUID()}`;
  const { error: insErr } = await db.schema(scope).from("cash_transaction").insert({
    id: txnId,
    direction,
    amount,
    account_id: isNonEmptyString(rec.account_id) ? rec.account_id : null,
    entity_id: entityId,
    business_date: businessDate,
    branch_ref: isNonEmptyString(rec.branch_ref) ? rec.branch_ref : null,
    teller_ref: isNonEmptyString(rec.teller_ref) ? rec.teller_ref : null,
    instrument_type: isNonEmptyString(rec.instrument_type) ? rec.instrument_type : null,
    provenance: provenanceFor(scope, ctx),
    partner_id: ctx.ownerPartnerId,
  });
  if (insErr) return internalErrorResponse(requestId, insErr);

  // ---- unattributable currency is a finding, raised immediately ----
  if (!entityId) {
    try {
      await raiseAlert(db, {
        ctx,
        scope,
        alertType: "unattributable_cash",
        entityHash: null,
        causeType: "cash_transaction",
        causeId: txnId,
        details:
          `currency recorded with no attributable person ` +
          `(cash_transaction_id=${txnId}, amount_cents=${amount}, ` +
          `business_date=${businessDate}, ` +
          `${accountUnlinked ? `account ${rec.account_id} has no entity_id` : "no account or entity supplied"}). ` +
          `No CTR determination can be made for this transaction.`,
      });
    } catch (e) {
      console.error(`unattributable-cash alert failed for ${txnId}: ${e}`);
    }

    return jsonResponse({
      id: txnId,
      direction,
      amount_cents: amount,
      business_date: businessDate,
      entity_id: null,
      // said plainly in the response, not only in a log
      attributable: false,
      ctr: null,
      warning:
        "recorded but UNATTRIBUTABLE: no owning entity, so this currency cannot " +
        "be included in any per-person CTR determination",
      provenance: provenanceFor(scope, ctx),
    }, 201, requestId);
  }

  // ---- re-aggregate this person's day ----
  const { data: dayRows, error: aggErr } = await db.schema(scope).from("cash_transaction")
    .select(CASH_COLS)
    .eq("entity_id", entityId)
    .eq("business_date", businessDate);
  if (aggErr) return internalErrorResponse(requestId, aggErr);

  const { attributed } = aggregateDay((dayRows ?? []) as unknown as Record<string, unknown>[]);
  const bucket = attributed[entityId] ?? { cash_in: 0, cash_out: 0, ids: [] };

  let ctr: Record<string, unknown> | null = null;
  if (crossesThreshold(bucket)) {
    const ctrId = `ctr_${entityId}_${businessDate}`;
    const nowIso = new Date().toISOString();
    const { error: ctrErr } = await db.schema(scope).from("ctr_filing").upsert({
      id: ctrId,
      entity_id: entityId,
      business_date: businessDate,
      cash_in_total: bucket.cash_in,
      cash_out_total: bucket.cash_out,
      threshold_crossed_at: nowIso,
      filing_due_at: ctrDueAt(businessDate),
      provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id" });
    if (ctrErr) return internalErrorResponse(requestId, ctrErr);

    try {
      await emitCashEvent(
        db, scope, `evt_${ctrId}_threshold`, "ctr.threshold.reached",
        "ctr_filing", ctrId,
        {
          entity_id: entityId,
          business_date: businessDate,
          cash_in_total: bucket.cash_in,
          cash_out_total: bucket.cash_out,
          filing_due_at: ctrDueAt(businessDate),
        },
        ctx,
      );
      await emitCashEvent(
        db, scope, `evt_${ctrId}_timer`, "ctr.filing.timer", "ctr_filing", ctrId,
        { due_at: ctrDueAt(businessDate), days: CTR_FILING_DAYS },
        ctx,
      );
      await raiseAlert(db, {
        ctx,
        scope,
        alertType: "ctr_currency_threshold",
        entityHash: await sha256Hex(entityId),
        causeType: "ctr_filing",
        causeId: ctrId,
        details:
          `currency aggregate over $10,000 for one person in one business day ` +
          `(entity=${entityId}, date=${businessDate}, ` +
          `cash_in=${bucket.cash_in}, cash_out=${bucket.cash_out})`,
      });
    } catch (e) {
      console.error(`ctr events failed for ${ctrId}: ${e}`);
    }

    // BSA-21: CTR records retain 5 years from the REPORT date.
    try {
      await startRetentionFor(db, "ctr", ctrId, new Date(), scope, ctx);
    } catch (e) {
      console.error(`ctr retention clock failed for ${ctrId}: ${e}`);
    }

    ctr = {
      id: ctrId,
      cash_in_total: bucket.cash_in,
      cash_out_total: bucket.cash_out,
      filing_due_at: ctrDueAt(businessDate),
      filed: false,
    };
  }

  return jsonResponse({
    id: txnId,
    direction,
    amount_cents: amount,
    business_date: businessDate,
    entity_id: entityId,
    attributable: true,
    day_totals: { cash_in: bucket.cash_in, cash_out: bucket.cash_out },
    ctr,
    provenance: provenanceFor(scope, ctx),
  }, 201, requestId);
}

/**
 * GET /cash/aggregation?business_date=YYYY-MM-DD
 *
 * The per-person view for a business day, with the unattributable residue
 * reported alongside rather than hidden.
 *
 * `complete` is the field that matters: false means some currency that day
 * could not be assigned to a person, so the per-person totals are a LOWER
 * BOUND and no clean CTR determination exists for the day.
 */
export async function getCashAggregation(
  req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireCashActor(ctx, requestId);
  if (denied) return denied;

  const q = new URL(req.url).searchParams;
  const businessDate = q.get("business_date");
  if (!businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return validationError(requestId, [{
      type: "invalid_value",
      field: "business_date",
      message: "is required, as YYYY-MM-DD",
    }]);
  }

  const { data, error } = await db.schema(scope).from("cash_transaction")
    .select(CASH_COLS)
    .eq("business_date", businessDate);
  if (error) return internalErrorResponse(requestId, error);

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const { attributed, unattributable } = aggregateDay(rows);

  const people = Object.entries(attributed).map(([entity_id, b]) => ({
    entity_id,
    cash_in: b.cash_in,
    cash_out: b.cash_out,
    transaction_count: b.ids.length,
    ctr_required: crossesThreshold(b),
  }));

  const complete = unattributable.ids.length === 0;
  return jsonResponse({
    business_date: businessDate,
    // LOWER BOUND when incomplete: stated in the payload so a consumer cannot
    // read the per-person totals as the whole picture
    complete,
    people,
    unattributable: {
      transaction_count: unattributable.ids.length,
      cash_in: unattributable.cash_in,
      cash_out: unattributable.cash_out,
      transaction_ids: unattributable.ids,
    },
    ...(complete ? {} : {
      warning:
        `${unattributable.ids.length} transaction(s) totalling ` +
        `${unattributable.cash_in + unattributable.cash_out} cents could not be ` +
        `attributed to a person; per-person totals are a lower bound and no ` +
        `complete CTR determination exists for this day`,
    }),
  }, 200, requestId);
}

/**
 * POST /cash/ctr/{id}/file {filed_by, fincen_ref}
 *
 * Both fields are required and the database enforces it too: a CTR marked filed
 * with no reference is worse than an unfiled one, because it stops the overdue
 * sweep from ever finding it again.
 */
export async function postCtrFile(
  req: Request,
  ctrId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireCashActor(ctx, requestId);
  if (denied) return denied;

  const body = await parseJsonBody(req).catch(() => null);
  const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};

  const errors: ValidationErrorItem[] = [];
  if (!isNonEmptyString(rec.filed_by)) {
    errors.push({ type: "missing_field", field: "filed_by", message: "is required" });
  }
  if (!isNonEmptyString(rec.fincen_ref)) {
    errors.push({
      type: "missing_field",
      field: "fincen_ref",
      message: "a filing with no FinCEN reference is not evidence of transmission",
    });
  }
  if (errors.length) return validationError(requestId, errors);

  const { data, error: selErr } = await db.schema(scope).from("ctr_filing")
    .select("id, entity_id, business_date, filing_due_at, filed_at, cash_in_total, cash_out_total")
    .eq("id", ctrId).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!data) return notFoundResponse(requestId, "ctr_filing", ctrId);

  const row = data as unknown as Record<string, unknown>;
  if (row.filed_at) {
    return jsonResponse({ id: ctrId, filed_at: row.filed_at }, 200, requestId, {
      "Idempotent-Replayed": "true",
    });
  }

  const nowIso = new Date().toISOString();
  // Lateness is recorded, never suppressed. A late CTR is still filed, and the
  // lateness is itself reportable.
  const late = new Date(nowIso) > new Date(String(row.filing_due_at));

  const { error: updErr } = await db.schema(scope).from("ctr_filing")
    .update({ filed_at: nowIso, filed_by: rec.filed_by, fincen_ref: rec.fincen_ref })
    .eq("id", ctrId);
  if (updErr) return internalErrorResponse(requestId, updErr);

  try {
    await emitCashEvent(db, scope, `evt_${ctrId}_filed`, "ctr.filed", "ctr_filing", ctrId, {
      filed_by: rec.filed_by,
      fincen_ref: rec.fincen_ref,
      due_at: row.filing_due_at,
      filed_at: nowIso,
      late,
    }, ctx);
  } catch (e) {
    console.error(`ctr.filed event failed for ${ctrId}: ${e}`);
  }

  return jsonResponse({
    id: ctrId,
    entity_id: row.entity_id,
    business_date: row.business_date,
    filed_at: nowIso,
    filed_by: rec.filed_by,
    fincen_ref: rec.fincen_ref,
    filed_late: late,
  }, 200, requestId);
}

/**
 * POST /cash/ctr/sweep — the NEGATIVE.
 *
 * A CTR that was owed and never filed produces no event of its own: nothing
 * happened. The 15-day deadline passing is invisible without this.
 *
 * Also reports unattributable currency, because a day with unassignable cash
 * may be concealing a CTR obligation that was never even detected — a breach
 * nobody can enumerate, which is worse than a late filing.
 */
export async function postCtrSweep(
  _req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireCashActor(ctx, requestId);
  if (denied) return denied;

  const nowIso = new Date().toISOString();
  const overdue: { id: string; due_at: string }[] = [];

  const { data, error } = await db.schema(scope).from("ctr_filing")
    .select("id, entity_id, business_date, filing_due_at, filed_at")
    .is("filed_at", null)
    .lt("filing_due_at", nowIso)
    .order("filing_due_at", { ascending: true })
    .limit(SWEEP_LIMIT);
  if (error) return internalErrorResponse(requestId, error);

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  for (const r of rows) {
    const id = String(r.id);
    try {
      await emitCashEvent(
        db, scope, `evt_${id}_overdue`, "ctr.filing.overdue", "ctr_filing", id,
        {
          due_at: r.filing_due_at,
          entity_id: r.entity_id,
          business_date: r.business_date,
          detected_at: nowIso,
        },
        ctx,
      );
      overdue.push({ id, due_at: String(r.filing_due_at) });
    } catch (e) {
      console.error(`ctr overdue event failed for ${id}: ${e}`);
    }
  }

  const { data: unattr, error: uErr } = await db.schema(scope).from("cash_transaction")
    .select("id, amount, business_date")
    .is("entity_id", null)
    .limit(SWEEP_LIMIT);
  if (uErr) return internalErrorResponse(requestId, uErr);
  const unattrRows = (unattr ?? []) as unknown as Record<string, unknown>[];

  return jsonResponse({
    swept_at: nowIso,
    overdue_filings: overdue,
    overdue_count: overdue.length,
    // surfaced by the same sweep: currency nobody can attribute is a standing
    // gap in CTR determination, not a one-off data-entry problem
    unattributable_transactions: unattrRows.length,
    unattributable_cents: unattrRows.reduce((s, r) => s + Number(r.amount ?? 0), 0),
    truncated: rows.length >= SWEEP_LIMIT || unattrRows.length >= SWEEP_LIMIT,
  }, 200, requestId);
}
