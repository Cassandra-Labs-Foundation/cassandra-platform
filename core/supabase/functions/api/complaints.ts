// Complaints and disputes — CO-06, FL-13, MP-04, PR-10.
//
// One register, four lenses. See the migration header for why a complaint and a
// Reg E dispute are separate nouns: they carry different clocks and only one of
// them moves money.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type BlnkConfig, BlnkError, getBalance, recordTransaction } from "../_shared/blnk.ts";
import { type EvidenceScope, provenanceFor } from "./bsa.ts";
import {
  apiError, bankErrorResponse, internalErrorResponse, isNonEmptyString, jsonResponse,
  notFoundResponse, parseJsonBody, validationError, type ValidationErrorItem,
} from "./lib.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const DAY_MS = 24 * 60 * 60 * 1000;

/** CO-06: acknowledge within 5 calendar days of receipt. */
export const ACK_DAYS = 5;
/** CO-06: an initial substantive response within 15 days. */
export const INITIAL_RESPONSE_DAYS = 15;
/** CO-06: final response within 30 days; 60 for a regulator-channel complaint. */
export const FINAL_RESPONSE_DAYS = 30;
export const REGULATOR_FINAL_RESPONSE_DAYS = 60;
/** A regulator portal sets its own response window, shorter than ours. */
export const PORTAL_RESPONSE_DAYS = 15;
/** 12 CFR 1005.11(c)(2): provisional credit within 10 business days. */
export const PROVISIONAL_CREDIT_DAYS = 10;
/** 12 CFR 1005.11(c): 45 days, or 90 for new-account / POS / foreign. */
export const INVESTIGATION_DAYS = 45;
export const EXTENDED_INVESTIGATION_DAYS = 90;

const CATEGORIES = [
  "privacy", "fair_lending", "collections", "fees", "service", "dispute", "other",
];
const CHANNELS = ["direct", "regulator", "portal", "branch", "phone", "social"];

function requireInternalActor(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/complaints");
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
  if (error) throw new Error(`complaint event (${code}): ${error.message}`);
}

const plusDays = (f: Date, d: number) => new Date(f.getTime() + d * DAY_MS).toISOString();

// ------------------------------------------------------------------ intake

/**
 * POST /complaints
 * {channel, category, narrative, member_id?, regulator?, regulator_case_id?,
 *  udaap_flag?, received_at?}
 *
 * Every clock starts HERE, at receipt — not at the point somebody opened the
 * ticket. The distinction matters: a complaint that sat in an inbox for a week
 * has already burned a week of its acknowledgement deadline, and starting the
 * clock at triage would hide exactly that.
 */
export async function postComplaint(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const errors: ValidationErrorItem[] = [];
  if (!CHANNELS.includes(String(body.channel))) {
    errors.push({
      type: "invalid_value", field: "channel", message: `must be one of ${CHANNELS.join(", ")}`,
    });
  }
  if (!CATEGORIES.includes(String(body.category))) {
    // A category is required at intake because four different policies read
    // this register by category. "Other" is available; absent is not.
    errors.push({
      type: "invalid_value", field: "category", message: `must be one of ${CATEGORIES.join(", ")}`,
    });
  }
  if (!isNonEmptyString(body.narrative)) {
    errors.push({
      type: "missing_field", field: "narrative",
      message: "a complaint with no narrative cannot be investigated or root-caused",
    });
  }
  if (body.channel === "regulator" && !isNonEmptyString(body.regulator)) {
    errors.push({
      type: "missing_field", field: "regulator",
      message: "a regulator-channel complaint must name the regulator",
    });
  }
  if (errors.length > 0) return validationError(requestId, errors);

  const receivedAt = isNonEmptyString(body.received_at) ? new Date(body.received_at) : new Date();
  const isRegulator = body.channel === "regulator";
  const finalDays = isRegulator ? REGULATOR_FINAL_RESPONSE_DAYS : FINAL_RESPONSE_DAYS;
  // A complaint arriving through a REGULATOR PORTAL carries the portal's own
  // response deadline, which is shorter than ours and set by them. Treating it
  // as an ordinary complaint means answering on our schedule and missing
  // theirs — the deadline that actually has consequences.
  const portalDueAt = (isRegulator || body.channel === "portal")
    ? plusDays(receivedAt, PORTAL_RESPONSE_DAYS)
    : null;

  const id = `cmpl_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("complaint").upsert({
    id,
    member_id: isNonEmptyString(body.member_id) ? body.member_id : null,
    // MP-04 declares `entity.contact`: a complaint the institution cannot
    // respond to is not actionable, so the contact route is captured at intake
    // rather than looked up when someone finally tries to answer.
    entity_contact: body.entity_contact ?? null,
    channel: body.channel, category: body.category, narrative: body.narrative,
    regulator: isNonEmptyString(body.regulator) ? body.regulator : null,
    regulator_case_id: isNonEmptyString(body.regulator_case_id)
      ? body.regulator_case_id
      : null,
    received_at: receivedAt.toISOString(),
    ack_due_at: plusDays(receivedAt, ACK_DAYS),
    initial_response_due_at: plusDays(receivedAt, INITIAL_RESPONSE_DAYS),
    final_response_due_at: plusDays(receivedAt, finalDays),
    udaap_flag: body.udaap_flag === true,
    portal_due_date: portalDueAt,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const payload = {
    "complaint.channel": body.channel, "complaint.category": body.category,
    "complaint.member_id": body.member_id ?? null,
    "complaint.narrative": body.narrative,
    "complaint.udaap_flag": body.udaap_flag === true,
    "complaint.regulator": body.regulator ?? null,
    "complaint.regulator_case_id": body.regulator_case_id ?? null,
    "complaint.portal_due_date": portalDueAt,
    "entity.contact": body.entity_contact ?? null,
  };
  await emit(db, scope, `ev_${id}_logged`, "complaint.logged", "complaint", id, payload, ctx);
  await emit(db, scope, `ev_${id}_recv`, "complaint.received", "complaint", id, payload, ctx);
  await emit(db, scope, `ev_${id}_ackdue`, "complaint.ack_due_at", "complaint", id, {
    ack_due_at: plusDays(receivedAt, ACK_DAYS),
  }, ctx);
  await emit(db, scope, `ev_${id}_irdue`, "complaint.initial.response.due_at",
    "complaint", id, {
      initial_response_due_at: plusDays(receivedAt, INITIAL_RESPONSE_DAYS),
    }, ctx);
  // The CHANNEL determines which policy's obligation attaches, so each is its
  // own event rather than a field somebody has to filter on.
  if (isRegulator) {
    await emit(db, scope, `ev_${id}_reg`, "complaint.regulator.received", "complaint", id, {
      "complaint.regulator": body.regulator,
      "complaint.regulator_case_id": body.regulator_case_id ?? null,
      final_response_due_at: plusDays(receivedAt, finalDays),
    }, ctx);
  } else {
    await emit(db, scope, `ev_${id}_direct`, "complaint.direct.received",
      "complaint", id, payload, ctx);
  }
  if (body.category === "privacy") {
    await emit(db, scope, `ev_${id}_priv`, "complaint.privacy.received",
      "complaint", id, payload, ctx);
  }
  return jsonResponse({ data: { id, ack_due_at: plusDays(receivedAt, ACK_DAYS) } }, 201, requestId);
}

/** POST /complaints/:id/acknowledge {acknowledged_by} */
export async function postComplaintAcknowledge(
  req: Request, complaintId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: c } = await db.schema(scope).from("complaint")
    .select("id, ack_due_at, acknowledged_at, channel").eq("id", complaintId).maybeSingle();
  if (!c) return notFoundResponse(requestId, "complaint", complaintId);

  const now = new Date();
  const { error } = await db.schema(scope).from("complaint").update({
    acknowledged_at: now.toISOString(), updated_at: now.toISOString(),
  }).eq("id", complaintId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${complaintId}_ack`, "complaint.acknowledged",
    "complaint", complaintId, {
      acknowledged_by: body.acknowledged_by ?? null,
      // whether it was LATE is part of the record. A timestamp with no verdict
      // makes the deadline unfalsifiable after the fact.
      acknowledged_late: now.toISOString() > String(c.ack_due_at),
    }, ctx);
  return jsonResponse({ data: { id: complaintId, acknowledged: true } }, 200, requestId);
}

/**
 * POST /complaints/:id/respond {stage, body_ref}
 *
 * `stage` is initial or final. They are separate obligations with separate
 * deadlines, and a system that records one "response" loses whichever the
 * institution actually missed.
 */
export async function postComplaintResponse(
  req: Request, complaintId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: c } = await db.schema(scope).from("complaint")
    .select("id, initial_response_due_at, final_response_due_at, acknowledged_at")
    .eq("id", complaintId).maybeSingle();
  if (!c) return notFoundResponse(requestId, "complaint", complaintId);

  const stage = body.stage === "final" ? "final" : "initial";
  if (!isNonEmptyString(body.body_ref)) {
    return validationError(requestId, [{
      type: "missing_field", field: "body_ref",
      message: "a response with no content is a status change",
    }]);
  }
  const now = new Date();
  const due = stage === "final" ? c.final_response_due_at : c.initial_response_due_at;
  const patch = stage === "final"
    ? { final_response_sent_at: now.toISOString() }
    : { initial_response_sent_at: now.toISOString() };
  const { error } = await db.schema(scope).from("complaint")
    .update({ ...patch, updated_at: now.toISOString() }).eq("id", complaintId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${complaintId}_${stage}`,
    stage === "final" ? "complaint.final_response.sent" : "complaint.initial_response.sent",
    "complaint", complaintId, {
      body_ref: body.body_ref, sent_late: now.toISOString() > String(due),
    }, ctx);
  return jsonResponse({ data: { id: complaintId, stage } }, 200, requestId);
}

/** POST /complaints/:id/resolve {root_cause_tag, investigation_notes} */
export async function postComplaintResolve(
  req: Request, complaintId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: c } = await db.schema(scope).from("complaint")
    .select("id, final_response_sent_at, category, udaap_flag").eq("id", complaintId).maybeSingle();
  if (!c) return notFoundResponse(requestId, "complaint", complaintId);

  if (!isNonEmptyString(body.root_cause_tag)) {
    // A complaint closed with no root cause contributes nothing to the trend
    // analysis three separate policies depend on. It is closed, not resolved.
    return validationError(requestId, [{
      type: "missing_field", field: "root_cause_tag",
      message: "a complaint resolved with no root cause cannot feed trend analysis",
    }]);
  }
  if (!c.final_response_sent_at) {
    return apiError(409, "complaint_not_answered", requestId, {
      title: "cannot resolve before the final response",
      detail: "the member has not been told the outcome",
    });
  }

  const now = new Date();
  const { error } = await db.schema(scope).from("complaint").update({
    resolved_at: now.toISOString(), root_cause_tag: body.root_cause_tag,
    investigation_notes: isNonEmptyString(body.investigation_notes)
      ? body.investigation_notes
      : null,
    updated_at: now.toISOString(),
  }).eq("id", complaintId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${complaintId}_invdone`, "complaint.investigation.completed",
    "complaint", complaintId, {
      "complaint.investigation_notes": body.investigation_notes ?? null,
      "complaint.root_cause_tag": body.root_cause_tag,
    }, ctx);
  await emit(db, scope, `ev_${complaintId}_res`, "complaint.resolved",
    "complaint", complaintId, {
      "complaint.root_cause_tag": body.root_cause_tag,
      "complaint.udaap_flag": c.udaap_flag === true,
    }, ctx);
  return jsonResponse({ data: { id: complaintId, resolved: true } }, 200, requestId);
}

// ------------------------------------------------------------ Reg E disputes

/**
 * POST /disputes
 * {complaint_id?, member_id, account_id, basis, amount_cents, extended?}
 *
 * 12 CFR 1005.11. The provisional-credit clock and the investigation clock start
 * together and run at different lengths — this is the case the separate table
 * exists for.
 */
export async function postDispute(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const amount = typeof body.amount_cents === "number" ? body.amount_cents : NaN;
  if (!isNonEmptyString(body.basis) || !Number.isFinite(amount) || amount <= 0) {
    return validationError(requestId, [{
      type: "invalid_value", field: "amount_cents",
      message: "a basis and a positive amount_cents are required",
    }]);
  }
  const notifiedAt = isNonEmptyString(body.notified_at) ? new Date(body.notified_at) : new Date();
  const investigationDays = body.extended === true
    ? EXTENDED_INVESTIGATION_DAYS
    : INVESTIGATION_DAYS;

  const id = `disp_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("dispute").upsert({
    id,
    complaint_id: isNonEmptyString(body.complaint_id) ? body.complaint_id : null,
    member_id: isNonEmptyString(body.member_id) ? body.member_id : null,
    account_id: isNonEmptyString(body.account_id) ? body.account_id : null,
    basis: body.basis, amount_cents: amount,
    notified_at: notifiedAt.toISOString(),
    provisional_credit_due_at: plusDays(notifiedAt, PROVISIONAL_CREDIT_DAYS),
    investigation_due_at: plusDays(notifiedAt, investigationDays),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_open`, "dispute.opened", "dispute", id, {
    "dispute.basis": body.basis, amount_cents: amount,
    "account.balance": body.account_balance_cents ?? null,
  }, ctx);
  await emit(db, scope, `ev_${id}_clock`, "dispute.rege_clock.started", "dispute", id, {
    investigation_due_at: plusDays(notifiedAt, investigationDays),
    days: investigationDays, extended: body.extended === true,
  }, ctx);
  await emit(db, scope, `ev_${id}_pcdue`, "dispute.provisional_credit_due_at",
    "dispute", id, {
      provisional_credit_due_at: plusDays(notifiedAt, PROVISIONAL_CREDIT_DAYS),
    }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/** POST /disputes/:id/provisional-credit {amount_cents?} */
export async function postProvisionalCredit(
  req: Request, disputeId: string, db: SupabaseClient, cfg: BlnkConfig, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: d } = await db.schema(scope).from("dispute")
    .select("id, account_id, amount_cents, provisional_credit_due_at, investigation_completed_at")
    .eq("id", disputeId).maybeSingle();
  if (!d) return notFoundResponse(requestId, "dispute", disputeId);

  const now = new Date();
  // Reg E: provisional credit is owed UNLESS the investigation finished first.
  // Posting it anyway is harmless; refusing to record why it was not posted is
  // not, so the skip is its own event.
  const amount = typeof body.amount_cents === "number" ? body.amount_cents : Number(d.amount_cents);

  // MP-04 / Reg E 1005.11(c)(2): the credit is POSTED TO THE ACCOUNT, i.e. the
  // member can spend it. This handler used to record provisional_credit_cents
  // and a "posted" event while the ledger never moved (caught by the
  // complaints partner-flow suite). The ledger move comes first, under a
  // deterministic reference so a retry dedupes instead of crediting twice.
  if (scope === "core") {
    if (!isNonEmptyString(d.account_id)) {
      return validationError(requestId, [{
        type: "missing_field", field: "account_id",
        message: "this dispute names no account, so there is nothing to credit provisionally",
      }]);
    }
    const { data: acct } = await db.schema("core").from("account")
      .select("id, blnk_balance_id").eq("id", d.account_id).maybeSingle();
    if (!acct?.blnk_balance_id) return notFoundResponse(requestId, "account", String(d.account_id));
    try {
      await recordTransaction(cfg, {
        coreResource: { table: "dispute", id: disputeId },
        leg: "provisional_credit",
        amountCents: amount,
        currency: "USD",
        source: "@ProvisionalCredit",
        destination: acct.blnk_balance_id,
        description: `Reg E provisional credit for dispute ${disputeId}`,
        allowOverdraft: true,
      });
      const bal = await getBalance(cfg, acct.blnk_balance_id);
      if (typeof bal.balance === "number") {
        await db.schema("core").from("account")
          .update({ balance: bal.balance, balance_synced_at: new Date().toISOString() })
          .eq("id", acct.id);
      }
    } catch (e) {
      if (e instanceof BlnkError) return bankErrorResponse(requestId);
      throw e;
    }
  }

  const { error } = await db.schema(scope).from("dispute").update({
    provisional_credit_posted_at: now.toISOString(),
    provisional_credit_cents: amount, updated_at: now.toISOString(),
  }).eq("id", disputeId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${disputeId}_pc`, "dispute.provisional_credit.posted",
    "dispute", disputeId, {
      amount_cents: amount,
      posted_late: now.toISOString() > String(d.provisional_credit_due_at),
    }, ctx);
  return jsonResponse({ data: { id: disputeId, amount_cents: amount } }, 200, requestId);
}

/** POST /disputes/:id/resolve {findings, correction_amount_cents?} */
export async function postDisputeResolve(
  req: Request, disputeId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: d } = await db.schema(scope).from("dispute")
    .select("id, investigation_due_at, amount_cents, provisional_credit_posted_at")
    .eq("id", disputeId).maybeSingle();
  if (!d) return notFoundResponse(requestId, "dispute", disputeId);

  if (!isNonEmptyString(body.findings)) {
    // Reg E requires the member be told the BASIS of the determination, not
    // just the outcome.
    return validationError(requestId, [{
      type: "missing_field", field: "findings",
      message: "the member must be told the basis of the determination",
    }]);
  }
  const now = new Date();
  const correction = typeof body.correction_amount_cents === "number"
    ? body.correction_amount_cents
    : 0;
  const { error } = await db.schema(scope).from("dispute").update({
    investigation_completed_at: now.toISOString(), findings: body.findings,
    correction_amount_cents: correction,
    response_sent_at: now.toISOString(), resolved_at: now.toISOString(),
    updated_at: now.toISOString(),
  }).eq("id", disputeId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${disputeId}_inv`, "dispute.investigation.completed",
    "dispute", disputeId, {
      "dispute.findings": body.findings,
      "dispute.correction_amount": correction,
      completed_late: now.toISOString() > String(d.investigation_due_at),
    }, ctx);
  await emit(db, scope, `ev_${disputeId}_resp`, "dispute.response.sent",
    "dispute", disputeId, { "dispute.findings": body.findings }, ctx);
  await emit(db, scope, `ev_${disputeId}_res`, "dispute.resolved", "dispute", disputeId, {
    "dispute.correction_amount": correction,
  }, ctx);
  return jsonResponse({ data: { id: disputeId, resolved: true } }, 200, requestId);
}

// ------------------------------------------------------------ trend / boards

/**
 * POST /complaints/trends {period, lens, threshold_bp?, cohorts?}
 *
 * CO-06, FL-13 and PR-10 all read this. Every figure is COUNTED from the
 * register; a trend report whose numbers are supplied describes what the
 * institution believes about its complaints.
 */
export async function postComplaintTrend(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const lenses = ["collections", "fair_lending", "privacy", "enterprise"];
  const lens = lenses.includes(String(body.lens)) ? String(body.lens) : "enterprise";

  const { data: rows } = await db.schema(scope).from("complaint")
    .select("id, category, root_cause_tag, udaap_flag, resolved_at, final_response_due_at, channel");
  const all = (rows ?? []).filter((c: Any) =>
    lens === "enterprise" ? true : c.category === lens
  );
  const byRoot: Record<string, number> = {};
  const byCat: Record<string, number> = {};
  for (const c of all) {
    const rc = String(c.root_cause_tag ?? "unresolved");
    byRoot[rc] = (byRoot[rc] ?? 0) + 1;
    byCat[String(c.category)] = (byCat[String(c.category)] ?? 0) + 1;
  }
  const now = new Date();
  const overdue = all.filter((c: Any) =>
    !c.resolved_at && String(c.final_response_due_at) < now.toISOString()
  ).length;

  // FL-13: the disparity is over WHO complains, computed from supplied cohort
  // counts. Like every other threshold in this repo, an unset one yields NO
  // verdict rather than a pass.
  const cohorts = (body.cohorts ?? {}) as Record<string, number>;
  const vals = Object.values(cohorts).map(Number).filter((n) => Number.isFinite(n));
  const disparity = vals.length >= 2 ? Math.max(...vals) - Math.min(...vals) : null;
  const thresholdBp = typeof body.threshold_bp === "number" ? body.threshold_bp : null;
  const breached = thresholdBp === null || disparity === null ? null : disparity > thresholdBp;

  const id = `cmtrend_${lens}_${body.period ?? "p"}`;
  const { error } = await db.schema(scope).from("complaint_trend").upsert({
    id, period: String(body.period ?? "p"), lens, total: all.length,
    by_root_cause: byRoot, by_category: byCat,
    udaap_count: all.filter((c: Any) => c.udaap_flag === true).length,
    overdue_count: overdue,
    disparity_bp: disparity, threshold_bp: thresholdBp, breached,
    cap_opened_at: breached === true ? now.toISOString() : null,
    reported_at: now.toISOString(), provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_rep`, "complaint.trend.reported", "complaint_trend", id, {
    "complaint.trend_summary": { total: all.length, by_root_cause: byRoot, overdue },
    lens, udaap_count: all.filter((c: Any) => c.udaap_flag === true).length,
  }, ctx);

  if (breached === true) {
    // FL-13: a disparity above threshold opens a corrective action plan and a
    // fair-lending remediation. A trend report that only reports is not a
    // control.
    await emit(db, scope, `ev_${id}_cap`, "analytics.cap.opened", "complaint_trend", id, {
      disparity_bp: disparity, threshold_bp: thresholdBp,
    }, ctx);
    await emit(db, scope, `ev_${id}_flrem`, "fair_lending.remediation.opened",
      "complaint_trend", id, { disparity_bp: disparity, source: "complaint_disparity" }, ctx);
  }
  return jsonResponse({
    data: { id, total: all.length, overdue_count: overdue, breached },
  }, 201, requestId);
}

/** POST /complaints/board-report {period, audience} — FL-13 / PR-10. */
export async function postComplaintBoardReport(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: trends } = await db.schema(scope).from("complaint_trend")
    .select("id, lens, total, overdue_count, udaap_count, breached, period");
  const { data: comps } = await db.schema(scope).from("complaint")
    .select("id, category, udaap_flag, resolved_at");

  const audience = body.audience === "privacy" ? "privacy" : "compliance";
  const id = `cmbrd_${audience}_${body.period ?? "p"}`;
  const payload = {
    period: body.period ?? null,
    complaints: (comps ?? []).length,
    unresolved: (comps ?? []).filter((c: Any) => !c.resolved_at).length,
    udaap: (comps ?? []).filter((c: Any) => c.udaap_flag === true).length,
    trends: (trends ?? []).length,
    "privacy.metrics_package_id": id,
    "complaint.trend_summary": (trends ?? []).map((t: Any) => ({
      lens: t.lens, total: t.total, overdue: t.overdue_count,
    })),
  };
  await emit(db, scope, `ev_${id}`,
    audience === "privacy" ? "privacy.board_report.delivered" : "compliance.board_report.delivered",
    "complaint_trend", id, payload, ctx);

  // PR-10: a MATERIAL privacy incident goes to the Board ad hoc, not in the
  // next quarterly pack. A cadence-only report cannot discharge that.
  if (body.adhoc === true || body.material_incident_id) {
    await emit(db, scope, `ev_${id}_adhoc`, "privacy.board_adhoc.delivered",
      "complaint_trend", id, {
        incident_id: body.material_incident_id ?? null, reason: "material_privacy_incident",
      }, ctx);
  }
  return jsonResponse({ data: payload }, 201, requestId);
}
