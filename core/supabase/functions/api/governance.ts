// The governance calendar (Tier D).
//
// 83 of the catalogue's triggers are time-based and all the same shape, so this
// is one register rather than 83 implementations — the same generalisation
// core.payment_approval made for four-eyes.
//
// WHY TIER D IS HONEST. A board review genuinely is due annually. Firing
// `governance.board_cycle.opened` when the year turns is the obligation
// actually arriving, not a simulation of one. That is the whole difference
// between this tier and Tier C, where the trigger has to be invented.
//
// THE TWO THINGS THIS FILE REFUSES TO GUESS
//
//   1. WHEN a cycle starts. An obligation with no anchor is UNSCHEDULED. It
//      never comes due, and the sweep says so explicitly rather than letting it
//      sit silently among the not-due ones. Those are different statements:
//      "not due yet" is a determination, "unscheduled" is the absence of one.
//
//   2. WHICH obligations exist. The 83 triggers are a menu, not a register.
//      Registering all of them automatically would assert the institution has
//      83 live obligations, which nobody has said. Registration is explicit and
//      the coverage gap is reportable.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor } from "./bsa.ts";
import {
  apiError,
  internalErrorResponse,
  isNonEmptyString,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  validationError,
  type ValidationErrorItem,
} from "./lib.ts";

export const CADENCES = [
  "annual",
  "semiannual",
  "quarterly",
  "monthly",
  "weekly",
  "daily",
  "ad_hoc",
] as const;
export type Cadence = typeof CADENCES[number];

const SWEEP_LIMIT = 200;

const OBLIGATION_COLS =
  "id, control_uid, trigger_code, title, owner_role, cadence, anchor_date, " +
  "next_due_at, last_completed_at, last_completed_by, provenance, created_at";

/**
 * Advance a due date by one cadence period.
 *
 * `ad_hoc` returns null: it has no period, so there is no next occurrence to
 * compute. Treating it as annual would invent a cadence the policy did not
 * state.
 */
export function advance(from: Date, cadence: Cadence): Date | null {
  const d = new Date(from.getTime());
  switch (cadence) {
    case "annual":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      return d;
    case "semiannual":
      d.setUTCMonth(d.getUTCMonth() + 6);
      return d;
    case "quarterly":
      d.setUTCMonth(d.getUTCMonth() + 3);
      return d;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d;
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      return d;
    case "daily":
      d.setUTCDate(d.getUTCDate() + 1);
      return d;
    case "ad_hoc":
      return null;
  }
}

/**
 * First due date from an anchor.
 *
 * The anchor IS the first occurrence — an annual obligation anchored on
 * 2026-01-01 is due 2026-01-01, not 2027-01-01. Advancing on registration would
 * silently skip the first cycle.
 */
export function firstDue(anchorDate: string): string {
  return new Date(`${anchorDate}T00:00:00.000Z`).toISOString();
}

/** Governance obligations belong to the institution, not to a fintech. */
function requireGovernanceActor(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/governance");
  return null;
}

async function emitGovernanceEvent(
  db: SupabaseClient,
  scope: EvidenceScope,
  id: string,
  code: string,
  obligationId: string,
  payload: Record<string, unknown>,
  ctx?: PartnerContext,
): Promise<void> {
  const { error } = await db.schema(scope).from("event").upsert({
    id,
    code,
    resource_type: "obligation",
    resource_id: `obligation:${obligationId}`,
    payload,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`governance event (${code}): ${error.message}`);
}

/**
 * POST /governance/obligations
 * {control_uid, trigger_code, title, cadence, anchor_date?, owner_role?}
 *
 * `anchor_date` is optional on purpose. Registering without one records that
 * the obligation EXISTS while stating that nobody has said when its cycle
 * starts — which is more useful than either refusing the registration or
 * inventing a start date.
 */
export async function postObligation(
  req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireGovernanceActor(ctx, requestId);
  if (denied) return denied;

  const body = await parseJsonBody(req).catch(() => null);
  const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};

  const errors: ValidationErrorItem[] = [];
  for (const f of ["control_uid", "trigger_code", "title"]) {
    if (!isNonEmptyString(rec[f])) {
      errors.push({ type: "missing_field", field: f, message: "is required" });
    }
  }
  if (!CADENCES.includes(rec.cadence as Cadence)) {
    errors.push({
      type: "invalid_value",
      field: "cadence",
      message: `must be one of: ${CADENCES.join(", ")}`,
    });
  }
  if (rec.anchor_date !== undefined && rec.anchor_date !== null) {
    if (!isNonEmptyString(rec.anchor_date) || !/^\d{4}-\d{2}-\d{2}$/.test(rec.anchor_date)) {
      errors.push({
        type: "invalid_value",
        field: "anchor_date",
        message: "must be YYYY-MM-DD, or omitted to register the obligation as unscheduled",
      });
    }
  }
  // control_uid must be the policy-qualified form, because control_id alone is
  // ambiguous for CP-01..CP-10 (OQ-11)
  if (isNonEmptyString(rec.control_uid) && !rec.control_uid.includes(":")) {
    errors.push({
      type: "invalid_value",
      field: "control_uid",
      message:
        "must be the policy-qualified uid (e.g. 'bsa:BSA-16'); a bare control_id " +
        "is ambiguous because ids are not unique across policies",
    });
  }
  if (errors.length) return validationError(requestId, errors);

  const cadence = rec.cadence as Cadence;
  const anchored = isNonEmptyString(rec.anchor_date);
  const nextDue = anchored ? firstDue(rec.anchor_date as string) : null;
  const id = `oblig_${String(rec.control_uid).replace(/[:]/g, "_")}_${rec.trigger_code}`;

  const { error } = await db.schema(scope).from("obligation").upsert({
    id,
    control_uid: rec.control_uid,
    trigger_code: rec.trigger_code,
    title: rec.title,
    owner_role: isNonEmptyString(rec.owner_role) ? rec.owner_role : null,
    cadence,
    anchor_date: anchored ? rec.anchor_date : null,
    next_due_at: nextDue,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error);

  return jsonResponse({
    id,
    control_uid: rec.control_uid,
    trigger_code: rec.trigger_code,
    cadence,
    anchor_date: anchored ? rec.anchor_date : null,
    next_due_at: nextDue,
    // said in the response rather than inferred from a null
    scheduled: anchored,
    ...(anchored ? {} : {
      warning:
        "registered UNSCHEDULED: the cadence is known but no anchor date was " +
        "supplied, so this obligation will never come due until one is set",
    }),
  }, 201, requestId);
}

/**
 * POST /governance/obligations/{id}/complete {completed_by, note?}
 *
 * Advances from the DUE date, not from the completion date. Completing a
 * quarterly review two months late makes the next one due three months after it
 * was DUE, not three months after it was done — otherwise chronic lateness
 * silently stretches the cadence until the obligation quietly stops recurring.
 */
export async function postObligationComplete(
  req: Request,
  obligationId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireGovernanceActor(ctx, requestId);
  if (denied) return denied;

  const body = await parseJsonBody(req).catch(() => null);
  const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (!isNonEmptyString(rec.completed_by)) {
    return validationError(requestId, [{
      type: "missing_field",
      field: "completed_by",
      message: "a completion with no attributed actor is not evidence it happened",
    }]);
  }

  const { data, error: selErr } = await db.schema(scope).from("obligation")
    .select(OBLIGATION_COLS).eq("id", obligationId).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!data) return notFoundResponse(requestId, "obligation", obligationId);

  const row = data as unknown as Record<string, unknown>;
  if (!row.next_due_at) {
    return apiError(409, "obligation_unscheduled", requestId, {
      title: "Obligation Unscheduled",
      detail:
        `obligation ${obligationId} has no anchor date, so it has no due date to ` +
        `complete against; set one before recording completion`,
    });
  }

  const dueAt = new Date(String(row.next_due_at));
  const nowIso = new Date().toISOString();
  const wasLate = new Date(nowIso) > dueAt;

  // advance from DUE, not from now
  const nextDue = advance(dueAt, row.cadence as Cadence);

  const { error: updErr } = await db.schema(scope).from("obligation")
    .update({
      last_completed_at: nowIso,
      last_completed_by: rec.completed_by,
      last_completion_note: rec.note ?? null,
      next_due_at: nextDue ? nextDue.toISOString() : null,
      // an ad_hoc obligation has no next occurrence, so it also loses its
      // anchor — the constraint requires the two to agree
      anchor_date: nextDue ? row.anchor_date : null,
    })
    .eq("id", obligationId);
  if (updErr) return internalErrorResponse(requestId, updErr);

  const { error: logErr } = await db.schema(scope).from("obligation_completion").insert({
    id: `oblcomp_${obligationId}_${dueAt.toISOString().slice(0, 10)}`,
    obligation_id: obligationId,
    due_at: dueAt.toISOString(),
    completed_at: nowIso,
    completed_by: rec.completed_by,
    note: rec.note ?? null,
    was_late: wasLate,
    provenance: provenanceFor(scope, ctx),
  });
  if (logErr) return internalErrorResponse(requestId, logErr);

  try {
    await emitGovernanceEvent(
      db, scope, `evt_${obligationId}_${dueAt.toISOString().slice(0, 10)}_completed`,
      "governance.obligation.completed", obligationId,
      {
        control_uid: row.control_uid,
        trigger_code: row.trigger_code,
        due_at: dueAt.toISOString(),
        completed_by: rec.completed_by,
        was_late: wasLate,
        next_due_at: nextDue ? nextDue.toISOString() : null,
      },
      ctx,
    );
  } catch (e) {
    console.error(`obligation completion event failed for ${obligationId}: ${e}`);
  }

  return jsonResponse({
    id: obligationId,
    due_at: dueAt.toISOString(),
    completed_at: nowIso,
    completed_by: rec.completed_by,
    completed_late: wasLate,
    next_due_at: nextDue ? nextDue.toISOString() : null,
  }, 200, requestId);
}

/**
 * POST /governance/calendar/sweep
 *
 * Fires the catalogue's own trigger event for every obligation that has come
 * due, and separately reports the two absences:
 *
 *   OVERDUE     the CURRENT cycle came due and nobody completed that cycle
 *               (a late completion of an earlier cycle does not count).
 *   UNSCHEDULED registered but never anchored, so it can never come due at all.
 *               The more dangerous of the two, because an unscheduled
 *               obligation looks exactly like a satisfied one from a distance.
 */
export async function postCalendarSweep(
  _req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireGovernanceActor(ctx, requestId);
  if (denied) return denied;

  const nowIso = new Date().toISOString();
  const fired: { id: string; trigger_code: string; due_at: string }[] = [];
  const overdue: { id: string; trigger_code: string; due_at: string; days_late: number }[] = [];

  const { data, error } = await db.schema(scope).from("obligation")
    .select(OBLIGATION_COLS)
    .lte("next_due_at", nowIso)
    .order("next_due_at", { ascending: true })
    .limit(SWEEP_LIMIT);
  if (error) return internalErrorResponse(requestId, error);
  const dueRows = (data ?? []) as unknown as Record<string, unknown>[];

  // Overdue is judged PER DUE CYCLE: the cycle due at `next_due_at` has passed
  // and there is no completion logged AGAINST THAT CYCLE. `last_completed_at`
  // is not evidence for it — completing the January cycle late (today) says
  // nothing about the April cycle, and comparing the two timestamps hid an
  // April cycle 18 months past due. The completion log is keyed per cycle
  // (`oblcomp_<obligation>_<due day>`), so one batched read answers it.
  const cycleKey = (id: string, dueAt: string) => `oblcomp_${id}_${dueAt.slice(0, 10)}`;
  const completedCycles = new Set<string>();
  if (dueRows.length) {
    const { data: done, error: cErr } = await db.schema(scope).from("obligation_completion")
      .select("id")
      .in("id", dueRows.map((r) => cycleKey(String(r.id), String(r.next_due_at))));
    if (cErr) return internalErrorResponse(requestId, cErr);
    for (const c of (done ?? []) as unknown as { id: string }[]) completedCycles.add(String(c.id));
  }

  // One batched upsert for every due/overdue event instead of two round trips
  // per obligation: the sweep made ~140 sequential calls over the live
  // calendar and took minutes. Event ids are deterministic per obligation and
  // cycle, so ignoreDuplicates keeps it idempotent exactly as before.
  const events: Record<string, unknown>[] = [];
  const provenance = provenanceFor(scope, ctx);
  const eventRow = (id: string, code: string, obligationId: string, payload: Record<string, unknown>) => ({
    id, code, resource_type: "obligation", resource_id: `obligation:${obligationId}`, payload, provenance,
  });
  for (const r of dueRows) {
    const id = String(r.id);
    const dueAt = String(r.next_due_at);
    const dueDay = dueAt.slice(0, 10);
    // The catalogue's OWN trigger code, so the control genuinely starts.
    events.push(eventRow(`evt_${id}_${dueDay}_due`, String(r.trigger_code), id,
      { control_uid: r.control_uid, due_at: dueAt, cadence: r.cadence }));
    fired.push({ id, trigger_code: String(r.trigger_code), due_at: dueAt });

    const isOverdue = Date.parse(dueAt) < Date.parse(nowIso) &&
      !completedCycles.has(cycleKey(id, dueAt));
    if (isOverdue) {
      const daysLate = Math.floor((Date.parse(nowIso) - Date.parse(dueAt)) / 86_400_000);
      events.push(eventRow(`evt_${id}_${dueDay}_overdue`, "governance.obligation.overdue", id,
        { control_uid: r.control_uid, due_at: dueAt, days_late: daysLate }));
      overdue.push({ id, trigger_code: String(r.trigger_code), due_at: dueAt, days_late: daysLate });
    }
  }
  if (events.length) {
    const { error: evErr } = await db.schema(scope).from("event")
      .upsert(events, { onConflict: "id", ignoreDuplicates: true });
    if (evErr) return internalErrorResponse(requestId, evErr);
  }

  const { data: unsched, error: uErr } = await db.schema(scope).from("obligation")
    .select("id, control_uid, trigger_code, cadence")
    .is("anchor_date", null)
    .limit(SWEEP_LIMIT);
  if (uErr) return internalErrorResponse(requestId, uErr);
  const unscheduled = (unsched ?? []) as unknown as Record<string, unknown>[];

  return jsonResponse({
    swept_at: nowIso,
    fired,
    fired_count: fired.length,
    overdue,
    overdue_count: overdue.length,
    // NOT a subset of overdue: these never became due at all
    unscheduled: unscheduled.map((u) => ({
      id: u.id,
      control_uid: u.control_uid,
      trigger_code: u.trigger_code,
      cadence: u.cadence,
    })),
    unscheduled_count: unscheduled.length,
    ...(unscheduled.length
      ? {
        warning:
          `${unscheduled.length} obligation(s) have no anchor date and can never ` +
          `come due; they are NOT satisfied and NOT overdue — nobody has said ` +
          `when their cycle starts (OQ-15)`,
      }
      : {}),
    truncated: dueRows.length >= SWEEP_LIMIT,
  }, 200, requestId);
}

/** GET /governance/obligations — the register, with its gaps stated. */
export async function getObligations(
  _req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
  scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireGovernanceActor(ctx, requestId);
  if (denied) return denied;

  const { data, error } = await db.schema(scope).from("obligation")
    .select(OBLIGATION_COLS)
    .order("next_due_at", { ascending: true })
    .limit(500);
  if (error) return internalErrorResponse(requestId, error);

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const scheduled = rows.filter((r) => r.anchor_date);
  return jsonResponse({
    obligations: rows,
    total: rows.length,
    scheduled: scheduled.length,
    unscheduled: rows.length - scheduled.length,
  }, 200, requestId);
}
