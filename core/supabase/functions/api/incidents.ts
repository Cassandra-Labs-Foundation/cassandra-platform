// Incident response — SC-01 (NCUA reportable cyber incidents) and the wider
// incident lifecycle.
//
// THE CLOCK. SC-01 gives 72 hours from the REPORTABILITY DETERMINATION, which
// is a LATER anchor than the previous two deadlines in this repo (SAR runs from
// detection, ECOA from application completion). Anchoring on detection here
// would be stricter than the regulation and would report false breaches.
//
// The gap that leaves is real and belongs to the regulation, not to this
// schema: nothing bounds how long determination takes, so an institution that
// never determines never breaches. `determination_due_at` is an INTERNAL
// deadline this system imposes on itself, and the sweep reports undetermined
// incidents separately from overdue notifications so the two are never
// confused. See OQ-21.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor } from "./bsa.ts";
import {
  apiError, internalErrorResponse, isNonEmptyString, jsonResponse,
  notFoundResponse, parseJsonBody, validationError, type ValidationErrorItem,
} from "./lib.ts";

/** SC-01: 72 hours from the determination. */
export const NCUA_NOTICE_HOURS = 72;
/** Internal only — the regulation sets no bound on determination itself. */
export const INTERNAL_DETERMINATION_HOURS = 24;
/** BC-05: an incident commander must be named inside this. */
export const IC_ASSIGNMENT_MINUTES = 15;
const SWEEP_LIMIT = 200;
/**
 * SC-03. The sitrep cadence scaled to severity. These are INTERNAL commitments,
 * not regulatory ones — no rule sets them — which is why they are named
 * constants here rather than nullable configuration: an unset cadence would be
 * indistinguishable from a cadence of never, and the whole point of the control
 * is that silence is the failure.
 */
export const SITREP_CADENCE_MINUTES: Record<string, number> = {
  sev1: 60, sev2: 120, sev3: 240, sev4: 480,
};

const COLS =
  "id, title, severity, source, status, detected_at, declared_at, ic_assigned_to, " +
  "ic_assigned_at, first_hour_completed_at, contained_at, restored_at, closed_at, " +
  "reportability_determined_at, reportability_determined_by, is_reportable, " +
  "reportability_rationale, ncua_notice_due_at, ncua_notified_at, determination_due_at, " +
  "member_impact_confirmed_at, member_notices_sent_at, provenance, created_at";

function requireIncidentActor(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/incidents");
  return null;
}

async function emit(
  db: SupabaseClient, scope: EvidenceScope, id: string, code: string,
  rId: string, payload: Record<string, unknown>, ctx?: PartnerContext,
): Promise<void> {
  const { error } = await db.schema(scope).from("event").upsert({
    id, code, resource_type: "incident", resource_id: `incident:${rId}`,
    payload, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`incident event (${code}): ${error.message}`);
}

/**
 * POST /incidents {title, severity, source?}
 *
 * Declaration assigns an incident commander and starts the first-hour clock.
 * `detected_at` and `declared_at` are separate because the signal arriving and
 * a human deciding it is an incident are different moments, and the gap between
 * them is itself a metric.
 */
export async function postIncident(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireIncidentActor(ctx, requestId);
  if (denied) return denied;

  const rec = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const errors: ValidationErrorItem[] = [];
  if (!isNonEmptyString(rec.title)) {
    errors.push({ type: "missing_field", field: "title", message: "is required" });
  }
  if (!isNonEmptyString(rec.severity) || !["sev1", "sev2", "sev3", "sev4"].includes(rec.severity)) {
    errors.push({ type: "invalid_value", field: "severity", message: "must be sev1..sev4" });
  }
  if (errors.length) return validationError(requestId, errors);

  // A caller-supplied id makes re-declaration CONVERGE on the same row — the
  // drill re-runs against the live database left one fresh uuid-id incident
  // per run per control, and the sweep's per-row work grew without bound
  // (1,710 rows deep before this was found).
  const id = isNonEmptyString(rec.id) ? String(rec.id) : `inc_${crypto.randomUUID()}`;
  const now = new Date();
  const detDue = new Date(now.getTime() + INTERNAL_DETERMINATION_HOURS * 3_600_000);

  const { error } = await db.schema(scope).from("incident").upsert({
    id, title: rec.title, severity: rec.severity,
    source: isNonEmptyString(rec.source) ? rec.source : null,
    // CO-11 declares these on a collections-data incident: what happened, how
    // it was found, and what data was in scope. A severity alone cannot answer
    // the reportability question the determination has to make.
    description: isNonEmptyString(rec.description) ? rec.description : null,
    detection_source: isNonEmptyString(rec.detection_source) ? rec.detection_source : null,
    data_scope: rec.data_scope ?? null,
    scope_initial: rec.data_scope ?? null,
    collections: rec.collections === true,
    status: "declared",
    detected_at: now.toISOString(),
    declared_at: now.toISOString(),
    ic_assigned_to: ctx.tokenId,
    ic_assigned_at: now.toISOString(),
    determination_due_at: detDue.toISOString(),
    // Re-DECLARING an id resets the whole lifecycle arc: a declaration is the
    // start of an incident, and a converged row still carrying last run's
    // determination made postDetermineReportability replay idempotently and
    // record nothing (SC-01 read unsupplied across 8 policies, live tier).
    // All nulled together so the determination-chain CHECKs stay satisfied.
    assessment_completed_at: null,
    reportability_determined_at: null,
    reportability_determined_by: null,
    is_reportable: null,
    reportability_rationale: null,
    ncua_notice_due_at: null,
    ncua_notified_at: null,
    legal_review_at: null,
    external_comms_at: null,
    closed_at: null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error);
  await db.schema(scope).from("incident").update({
    ic_assignment_due_at: new Date(now.getTime() + IC_ASSIGNMENT_MINUTES * 60_000).toISOString(),
    oncall_ic_rotation: String((rec as Record<string, unknown>).ic_rotation ?? "primary"),
    sitrep_cadence_minutes: SITREP_CADENCE_MINUTES[String(rec.severity)] ?? 240,
    detection_source: isNonEmptyString(rec.source) ? rec.source : null,
    scope_initial: isNonEmptyString(String((rec as Record<string, unknown>).scope_initial ?? ""))
      ? String((rec as Record<string, unknown>).scope_initial)
      : null,
  }).eq("id", id);

  try {
    await emit(db, scope, `evt_${id}_detected`, "incident.detected", id, { severity: rec.severity }, ctx);
    await emit(db, scope, `evt_${id}_signal`, "incident.signal.received", id, { source: rec.source ?? null }, ctx);
    await emit(db, scope, `evt_${id}_declared`, "incident.declared", id, { severity: rec.severity }, ctx);
    await emit(db, scope, `evt_${id}_created`, "incident.created", id, { severity: rec.severity }, ctx);
    await emit(db, scope, `evt_${id}_classified`, "incident.classified", id, { severity: rec.severity }, ctx);
    await emit(db, scope, `evt_${id}_sev`, "incident.severity.assigned", id, { severity: rec.severity }, ctx);
    await emit(db, scope, `evt_${id}_ic`, "incident.ic.assigned", id, { ic: ctx.tokenId }, ctx);
    // BC-05: assignment is a CLOCK, not just a name. An incident whose
    // commander was named four hours late was uncommanded for four hours, and
    // only the timer makes that visible after the fact.
    await emit(db, scope, `evt_${id}_ictimer`, "incident.ic_assignment_timer", id, {
      due_at: new Date(now.getTime() + IC_ASSIGNMENT_MINUTES * 60_000).toISOString(),
      "oncall.ic_rotation": (rec as Record<string, unknown>).ic_rotation ?? "primary",
      assigned_at: now.toISOString(),
    }, ctx);
    if (rec.severity === "sev1") {
      await emit(db, scope, `evt_${id}_sev1`, "incident.sev1.detected", id, {}, ctx);
    }
    // the comms clock starts at declaration
    await emit(db, scope, `evt_${id}_comms_timer`, "comms.initial_timer", id,
      { due_at: new Date(now.getTime() + 3_600_000).toISOString() }, ctx);
    await emit(db, scope, `evt_${id}_sitrep_timer`, "sitrep.v1_timer", id,
      { due_at: new Date(now.getTime() + 3_600_000).toISOString() }, ctx);
    // SC-03: v1 is not the control. An incident that issued one sitrep and then
    // went quiet is exactly what the cadence exists to catch, so the RECURRING
    // interval is declared at declaration time and scaled to severity — a sev1
    // that reports every four hours is not being managed.
    await emit(db, scope, `evt_${id}_sitrep_cadence`, "sitrep.cadence_timer", id, {
      cadence_minutes: SITREP_CADENCE_MINUTES[String(rec.severity)] ?? 240,
      severity: rec.severity, next_due_at: new Date(
        now.getTime() + (SITREP_CADENCE_MINUTES[String(rec.severity)] ?? 240) * 60_000,
      ).toISOString(),
    }, ctx);
  } catch (e) {
    console.error(`incident declare events failed for ${id}: ${e}`);
  }

  return jsonResponse({
    id, severity: rec.severity, status: "declared", ic: ctx.tokenId,
    determination_due_at: detDue.toISOString(),
    determination_note:
      "SC-01's 72-hour NCUA clock does NOT start until reportability is determined; " +
      "this internal deadline exists because the regulation bounds only the notification, " +
      "not the determination (OQ-21)",
  }, 201, requestId);
}

/** POST /incidents/{id}/first-hour {summary} — sitrep v1 + containment start. */
export async function postFirstHour(
  req: Request, id: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireIncidentActor(ctx, requestId);
  if (denied) return denied;
  const rec = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(rec.summary)) {
    return validationError(requestId, [{
      type: "missing_field", field: "summary",
      message: "the first-hour sitrep must say what is known",
    }]);
  }

  const { data, error: selErr } = await db.schema(scope).from("incident")
    .select(COLS).eq("id", id).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!data) return notFoundResponse(requestId, "incident", id);

  const now = new Date().toISOString();
  const { error } = await db.schema(scope).from("incident")
    .update({ first_hour_completed_at: now }).eq("id", id);
  if (error) return internalErrorResponse(requestId, error);

  const { error: sErr } = await db.schema(scope).from("incident_sitrep").upsert({
    id: `sitrep_${id}_1`, incident_id: id, sequence: 1,
    summary: rec.summary, issued_by: ctx.tokenId,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (sErr) return internalErrorResponse(requestId, sErr);

  try {
    await emit(db, scope, `evt_${id}_fh`, "incident.first_hour.completed", id, {}, ctx);
    await emit(db, scope, `evt_${id}_sitrep`, "sitrep.issued", id, { sequence: 1 }, ctx);
  } catch (e) {
    console.error(`first-hour events failed for ${id}: ${e}`);
  }
  return jsonResponse({ id, first_hour_completed_at: now }, 200, requestId);
}

/**
 * POST /incidents/{id}/determine {is_reportable, rationale}
 *
 * SC-01. Write-restricted to Compliance/Legal, and THIS is what starts the
 * 72-hour NCUA clock — not detection, not declaration.
 */
export async function postDetermineReportability(
  req: Request, id: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireIncidentActor(ctx, requestId);
  if (denied) return denied;

  // SC-01: "write-restricted to the CCO/Compliance-Legal"
  if (!ctx.roles.includes("bsa_compliance") && !ctx.roles.includes("bsa_counsel")) {
    return apiError(403, "insufficient_role", requestId, {
      title: "Insufficient Role",
      detail:
        "SC-01 restricts the reportability determination to Compliance or Legal; " +
        `this token carries ${ctx.roles.length ? ctx.roles.join(", ") : "no such role"}`,
    });
  }

  const rec = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const errors: ValidationErrorItem[] = [];
  if (typeof rec.is_reportable !== "boolean") {
    errors.push({ type: "invalid_value", field: "is_reportable", message: "must be true or false" });
  }
  // SC-01: a NON-reportable determination is documented with rationale. The
  // undocumented "not reportable" is the finding an examiner looks for.
  if (!isNonEmptyString(rec.rationale)) {
    errors.push({
      type: "missing_field", field: "rationale",
      message: "every reportability determination must be documented, including a decision NOT to report",
    });
  }
  if (errors.length) return validationError(requestId, errors);

  const { data, error: selErr } = await db.schema(scope).from("incident")
    .select(COLS).eq("id", id).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!data) return notFoundResponse(requestId, "incident", id);
  const row = data as unknown as Record<string, unknown>;
  if (row.reportability_determined_at) {
    return jsonResponse({ id, is_reportable: row.is_reportable }, 200, requestId, {
      "Idempotent-Replayed": "true",
    });
  }
  // EC-13 / SC-01: the assessment (data scope + member impact) is what the
  // determination is made FROM. Refuse here as a state conflict rather than
  // letting ck_incident_assessment_before_determination surface as a 500.
  const { data: assessed, error: aErr } = await db.schema(scope).from("incident")
    .select("assessment_completed_at").eq("id", id).maybeSingle();
  if (aErr) return internalErrorResponse(requestId, aErr);
  if (!assessed?.assessment_completed_at) {
    return apiError(409, "assessment_required", requestId, {
      title: "Assessment Required",
      detail: `incident ${id} has no completed assessment; record the data scope and member ` +
        "impact (POST /incidents/{id}/assessment) before determining reportability",
    });
  }

  const now = new Date();
  const reportable = rec.is_reportable === true;
  // 72 hours FROM THE DETERMINATION (SC-01), and only when reportable
  const due = reportable ? new Date(now.getTime() + NCUA_NOTICE_HOURS * 3_600_000) : null;

  const { error } = await db.schema(scope).from("incident").update({
    reportability_determined_at: now.toISOString(),
    reportability_determined_by: ctx.tokenId,
    is_reportable: reportable,
    reportability_rationale: rec.rationale,
    // the ASSESSMENT is the reasoning; the rationale is its summary. CO-11
    // declares both because a one-line rationale cannot evidence the analysis.
    reportability_assessment: isNonEmptyString(rec.assessment)
      ? rec.assessment
      : rec.rationale,
    ncua_notice_due_at: due ? due.toISOString() : null,
  }).eq("id", id);
  if (error) return internalErrorResponse(requestId, error);

  try {
    await emit(db, scope, `evt_${id}_determined`, "incident.reportability_determination", id,
      { is_reportable: reportable, determined_by: ctx.tokenId }, ctx);
    if (reportable) {
      await emit(db, scope, `evt_${id}_ncua_timer`, "incident.ncua.notice.due_at", id,
        { due_at: due!.toISOString(), hours: NCUA_NOTICE_HOURS }, ctx);
    }
  } catch (e) {
    console.error(`determination events failed for ${id}: ${e}`);
  }

  return jsonResponse({
    id, is_reportable: reportable,
    ncua_notice_due_at: due ? due.toISOString() : null,
    determined_by: ctx.tokenId,
  }, 200, requestId);
}

/** POST /incidents/{id}/notify-ncua {reference} */
export async function postNotifyNcua(
  req: Request, id: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireIncidentActor(ctx, requestId);
  if (denied) return denied;
  const rec = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data, error: selErr } = await db.schema(scope).from("incident")
    .select(COLS).eq("id", id).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!data) return notFoundResponse(requestId, "incident", id);
  const row = data as unknown as Record<string, unknown>;

  if (!row.reportability_determined_at) {
    return apiError(409, "not_determined", requestId, {
      title: "Not Determined",
      detail: `incident ${id} has no reportability determination; there is nothing to notify NCUA about`,
    });
  }
  if (row.is_reportable !== true) {
    return apiError(409, "not_reportable", requestId, {
      title: "Not Reportable",
      detail: `incident ${id} was determined NOT reportable; notifying would contradict the determination`,
    });
  }

  const now = new Date().toISOString();
  const late = new Date(now) > new Date(String(row.ncua_notice_due_at));
  const { error } = await db.schema(scope).from("incident")
    .update({ ncua_notified_at: now }).eq("id", id);
  if (error) return internalErrorResponse(requestId, error);

  try {
    await emit(db, scope, `evt_${id}_ncua`, "incident.ncua.notified", id,
      { notified_at: now, due_at: row.ncua_notice_due_at, late, reference: rec.reference ?? null }, ctx);
  } catch (e) {
    console.error(`ncua notify event failed for ${id}: ${e}`);
  }
  return jsonResponse({ id, ncua_notified_at: now, notified_late: late }, 200, requestId);
}

/** POST /incidents/{id}/member-impact {confirmed, template} */
export async function postMemberImpact(
  req: Request, id: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireIncidentActor(ctx, requestId);
  if (denied) return denied;
  const rec = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(rec.template)) {
    return validationError(requestId, [{
      type: "missing_field", field: "template",
      message: "SC-01 Appendix B: member notice requires a notice template",
    }]);
  }

  const now = new Date().toISOString();
  const { error } = await db.schema(scope).from("incident")
    .update({ member_impact_confirmed_at: now, member_notices_sent_at: now }).eq("id", id);
  if (error) return internalErrorResponse(requestId, error);

  try {
    await emit(db, scope, `evt_${id}_impact`, "incident.member_impact.confirmed", id, {}, ctx);
    await emit(db, scope, `evt_${id}_notices`, "incident.member_notices.sent", id,
      // privacy:SC-01 declares `incident.notice_template_id`, not the template's
      // display name. Emitting only the name meant the notice could not be tied
      // back to a specific approved template version after the fact.
      { member_notice_template: rec.template, notice_template_id: rec.template }, ctx);
  } catch (e) {
    console.error(`member impact events failed for ${id}: ${e}`);
  }
  return jsonResponse({ id, member_notices_sent_at: now }, 200, requestId);
}

/** POST /incidents/{id}/contain then /close. */
export async function postContainIncident(
  _req: Request, id: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireIncidentActor(ctx, requestId);
  if (denied) return denied;
  const now = new Date().toISOString();
  // 'contained' is the schema's word for this phase (declared -> responding ->
  // contained -> postmortem -> closed). This writer said 'restored', which the
  // status CHECK does not accept, so the update 23514'd and returned BEFORE
  // emitting — losing containment_at, restored_at and incident.contained
  // together, and reading four controls red across BCP, e-commerce, infosec
  // and shared-controls. Containment and restoration are both still recorded,
  // as the timestamps they are; the status is the lifecycle phase, and the
  // vocabulary belongs to the schema (the status-divergence bug class).
  const { error } = await db.schema(scope).from("incident")
    .update({ status: "contained", contained_at: now, restored_at: now }).eq("id", id);
  if (error) return internalErrorResponse(requestId, error);
  try {
    await emit(db, scope, `evt_${id}_contained`, "incident.contained", id, {}, ctx);
    await emit(db, scope, `evt_${id}_restored`, "restore.completed", id, {}, ctx);
  } catch (e) { console.error(`contain events failed: ${e}`); }
  return jsonResponse({ id, status: "contained", restored_at: now }, 200, requestId);
}

export async function postCloseIncident(
  _req: Request, id: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireIncidentActor(ctx, requestId);
  if (denied) return denied;
  const now = new Date().toISOString();
  const { data: row } = await db.schema(scope).from("incident")
    .select("id, restored_at, assessment_completed_at").eq("id", id).maybeSingle();
  const { error } = await db.schema(scope).from("incident")
    .update({ status: "closed", closed_at: now }).eq("id", id);
  if (error) return internalErrorResponse(requestId, error);
  try {
    await emit(db, scope, `evt_${id}_closed`, "incident.closed", id, {}, ctx);
    // IS-19: the postmortem is a fact about the CLOSED incident, and it can
    // only be claimed when the PIR that carries the root cause actually exists.
    // Emitting it unconditionally at closure would be the event-without-state
    // smell one more time: a postmortem nobody wrote.
    const { data: pir } = await db.schema(scope).from("pir")
      .select("id, incident_id, incident_root_cause, incident_timeline, drafted_at")
      .eq("incident_id", id).maybeSingle();
    if (pir?.drafted_at) {
      await emit(db, scope, `evt_${id}_postmortem`, "incident.postmortem.completed", id, {
        "incident.root_cause": pir.incident_root_cause,
        "incident.timeline": pir.incident_timeline,
        "incident.recovered": row?.restored_at != null,
      }, ctx);
    }
  } catch (e) { console.error(`close event failed: ${e}`); }
  return jsonResponse({ id, status: "closed" }, 200, requestId);
}

/**
 * POST /incidents/sweep — the NEGATIVES, and there are two DIFFERENT ones.
 *
 *   overdue notification  determined reportable, 72h passed, nobody notified
 *   UNDETERMINED          nobody has determined reportability at all
 *
 * The second is the one SC-01 cannot catch, because its clock never starts.
 * Reported separately so a clean "0 overdue" can never be read as "0 problems".
 */
export async function postIncidentSweep(
  _req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireIncidentActor(ctx, requestId);
  if (denied) return denied;
  const nowIso = new Date().toISOString();

  const { data: overdueRows, error } = await db.schema(scope).from("incident")
    .select(COLS).is("ncua_notified_at", null).lt("ncua_notice_due_at", nowIso).limit(SWEEP_LIMIT);
  if (error) return internalErrorResponse(requestId, error);

  const overdue = (overdueRows ?? []) as unknown as Record<string, unknown>[];
  for (const r of overdue) {
    try {
      await emit(db, scope, `evt_${r.id}_ncua_overdue`, "incident.ncua_notification.overdue",
        String(r.id), { due_at: r.ncua_notice_due_at, detected_at: nowIso }, ctx);
    } catch (e) { console.error(`ncua overdue event failed: ${e}`); }
  }

  const { data: undet, error: uErr } = await db.schema(scope).from("incident")
    .select("id, severity, determination_due_at, reportability_determined_at")
    .is("reportability_determined_at", null).limit(SWEEP_LIMIT);
  if (uErr) return internalErrorResponse(requestId, uErr);
  const undetermined = (undet ?? []) as unknown as Record<string, unknown>[];
  for (const r of undetermined) {
    try {
      await emit(db, scope, `evt_${r.id}_undetermined`, "incident.reportability_undetermined",
        String(r.id), { internal_due_at: r.determination_due_at }, ctx);
    } catch (e) { console.error(`undetermined event failed: ${e}`); }
  }

  return jsonResponse({
    swept_at: nowIso,
    ncua_overdue: overdue.length,
    // NOT a subset of overdue: these never started the 72-hour clock at all
    undetermined: undetermined.length,
    ...(undetermined.length
      ? {
        warning:
          `${undetermined.length} incident(s) have NO reportability determination. ` +
          `SC-01's 72-hour clock runs from determination, so these are neither ` +
          `overdue nor compliant — the clock has not started (OQ-21)`,
      }
      : {}),
  }, 200, requestId);
}

/**
 * POST /incidents/{id}/assessment — EC-13.
 *
 * The assessment PRECEDES the reportability determination and is a different
 * act. The determination answers "must we tell NCUA"; the assessment answers
 * "what actually happened, whose data, how many members". Collapsing them means
 * the determination is made from whatever the incident commander happened to
 * know at the time, which is the thing the 72-hour clock was supposed to buy
 * time to avoid.
 */
export async function postIncidentAssessment(
  req: Request, id: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: row } = await db.schema(scope).from("incident")
    .select("id, severity").eq("id", id).maybeSingle();
  if (!row) return notFoundResponse(requestId, "incident", id);

  if (!isNonEmptyString(body.member_impact) || body.data_scope == null) {
    // An assessment that does not say whose data and how many members is not an
    // assessment; it is a status update wearing the word.
    return validationError(requestId, [{
      type: "missing_field", field: "member_impact",
      message: "an assessment must state the data scope and the member impact",
    }]);
  }
  const now = new Date().toISOString();
  const { error } = await db.schema(scope).from("incident").update({
    data_scope: body.data_scope, facts: body.facts ?? {},
    member_impact: body.member_impact,
    scope_initial: isNonEmptyString(body.scope_initial) ? body.scope_initial : null,
    detection_source: isNonEmptyString(body.detection_source) ? body.detection_source : null,
    assessment_completed_at: now,
  }).eq("id", id);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `evt_${id}_assessed`, "incident.assessment.completed", id, {
    "incident.data_scope": body.data_scope, "incident.member_impact": body.member_impact,
    "incident.facts": body.facts ?? {},
  }, ctx);
  // The corpus names the determination `incident.reportability_assessment`; the
  // writer already emits `incident.reportability_determination`. Both are
  // emitted rather than one renamed — see BLUEPRINT §5j.
  await emit(db, scope, `evt_${id}_reportassess`, "incident.reportability_assessment", id, {
    assessment_completed_at: now, severity: row.severity,
  }, ctx);
  return jsonResponse({ id, assessment_completed_at: now }, 200, requestId);
}

/**
 * POST /incidents/{id}/external-comms {holding_statement, legal_reviewed_by}
 *
 * EC-13's gate. External communications about a breach carry legal exposure the
 * incident commander is not positioned to judge, and 2am is when that judgement
 * is worst. The refusal is the control; a warning would not stop anyone.
 */
export async function postExternalComms(
  req: Request, id: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: row } = await db.schema(scope).from("incident")
    .select("id, legal_review_at, assessment_completed_at").eq("id", id).maybeSingle();
  if (!row) return notFoundResponse(requestId, "incident", id);

  const legalBy = isNonEmptyString(body.legal_reviewed_by) ? body.legal_reviewed_by : null;
  if (!row.legal_review_at && !legalBy) {
    return apiError(409, "legal_review_required", requestId, {
      title: "external communications require legal review",
      detail: `incident ${id} has no legal review; a holding statement cannot go out`,
    });
  }
  if (!isNonEmptyString(body.holding_statement)) {
    return validationError(requestId, [{
      type: "missing_field", field: "holding_statement",
      message: "the statement that went out has to be recorded, verbatim",
    }]);
  }
  const now = new Date().toISOString();
  const { error } = await db.schema(scope).from("incident").update({
    legal_review_at: row.legal_review_at ?? now,
    legal_review_by: row.legal_review_at ? undefined : legalBy,
    comms_holding_statement: body.holding_statement,
    comms_plan: body.comms_plan ?? {},
    external_comms_at: now,
  }).eq("id", id);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `evt_${id}_extcomms`, "incident.external_comms.recorded", id, {
    "comms.holding_statement": body.holding_statement,
    "incident.comms_plan": body.comms_plan ?? {},
    "incident.legal_review": legalBy ?? row.legal_review_at,
  }, ctx);
  return jsonResponse({ id, external_comms_at: now }, 200, requestId);
}

// ------------------------------------------------ BC-15 containment discipline

/**
 * POST /incidents/{id}/containment {data_scope?, description?}
 *
 * Starting containment starts TWO clocks: the containment timer and the
 * legal-consult timer — BC-15's point is that legal is consulted DURING the
 * incident, not asked to bless the writeup afterward.
 */
export async function postIncidentContainmentStart(
  req: Request, id: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: row } = await db.schema(scope).from("incident")
    .select("id, severity, source").eq("id", id).maybeSingle();
  if (!row) return notFoundResponse(requestId, "incident", id);
  const now = new Date().toISOString();
  await emit(db, scope, `evt_${id}_containstart`, "incident.containment.started", id, {
    "incident.severity": row.severity,
    "incident.description": body.description ?? null,
    "incident.data_scope": body.data_scope ?? null,
    "incident.detection_source": row.source ?? body.detection_source ?? null,
    started_at: now,
  }, ctx);
  await emit(db, scope, `evt_${id}_containtimer`, "incident.containment_timer", id, {
    started_at: now,
  }, ctx);
  await emit(db, scope, `evt_${id}_legaltimer`, "legal.consult_timer", id, {
    started_at: now,
  }, ctx);
  return jsonResponse({ id, containment_started_at: now }, 200, requestId);
}

/** POST /incidents/{id}/legal-consult {counsel} — BC-15's second clock stops. */
export async function postIncidentLegalConsult(
  req: Request, id: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.counsel)) {
    return validationError(requestId, [{
      type: "missing_field", field: "counsel",
      message: "legal was consulted BY someone identifiable, or it was not consulted",
    }]);
  }
  const { data: row } = await db.schema(scope).from("incident")
    .select("id").eq("id", id).maybeSingle();
  if (!row) return notFoundResponse(requestId, "incident", id);
  const now = new Date().toISOString();
  await db.schema(scope).from("incident")
    .update({ legal_review_at: now, legal_review_by: body.counsel }).eq("id", id);
  await emit(db, scope, `evt_${id}_legal`, "legal.consulted", id, {
    counsel: body.counsel, at: now,
  }, ctx);
  return jsonResponse({ id, legal_consulted_at: now }, 200, requestId);
}

/** POST /incidents/{id}/vendor-tracks {vendors[]} — a vendor-origin incident
 * dispatches parallel tracks, one per vendor, and says so. */
export async function postIncidentVendorTracks(
  req: Request, id: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const vendors = Array.isArray(body.vendors) ? body.vendors.map(String) : [];
  if (vendors.length === 0) {
    return validationError(requestId, [{
      type: "missing_field", field: "vendors", message: "at least one vendor track is required",
    }]);
  }
  const { data: row } = await db.schema(scope).from("incident")
    .select("id").eq("id", id).maybeSingle();
  if (!row) return notFoundResponse(requestId, "incident", id);
  await emit(db, scope, `evt_${id}_vtracks`, "vendor.incident_tracks_dispatched", id, {
    vendors, count: vendors.length,
  }, ctx);
  return jsonResponse({ id, tracks: vendors.length }, 200, requestId);
}

// ------------------------------------------------ BC-09 failover + member comms

/** POST /incidents/{id}/failover {decided_by, target} — the decision and the
 * execution are separate facts; this records the EXECUTION. */
export async function postIncidentFailover(
  req: Request, id: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.decided_by) || !isNonEmptyString(body.target)) {
    return validationError(requestId, [{
      type: "missing_field", field: "decided_by",
      message: "decided_by and target are required — an unattributed failover is a mystery outage",
    }]);
  }
  const { data: row } = await db.schema(scope).from("incident")
    .select("id").eq("id", id).maybeSingle();
  if (!row) return notFoundResponse(requestId, "incident", id);
  await emit(db, scope, `evt_${id}_failover`, "it.failover.executed", id, {
    decided_by: body.decided_by, target: body.target,
  }, ctx);
  return jsonResponse({ id, failover: true }, 200, requestId);
}

/** POST /incidents/{id}/member-status {statement, member_impact} — BC-09: the
 * members are TOLD, with the impact stated, while it is happening. */
export async function postIncidentMemberStatus(
  req: Request, id: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.statement)) {
    return validationError(requestId, [{
      type: "missing_field", field: "statement",
      message: "the status that went to members has to be recorded, verbatim",
    }]);
  }
  const { data: row } = await db.schema(scope).from("incident")
    .select("id").eq("id", id).maybeSingle();
  if (!row) return notFoundResponse(requestId, "incident", id);
  await emit(db, scope, `evt_${id}_memberstatus`, "comms.member_status.issued", id, {
    statement: body.statement,
    "incident.member_impact": body.member_impact ?? null,
  }, ctx);
  return jsonResponse({ id, issued: true }, 200, requestId);
}
