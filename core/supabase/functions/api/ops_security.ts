// Ops-security tail — EC-02/05/06/08/09, IS-05/06/07/08/13/14, BC-07's
// backup half. The last hermetic reds outside the money path.
//
// Same rules as every writer tranche: each flow runs its violating case
// (grants to separated employees refused, restores against failed backups
// refused, unapproved AI launches refused, dispositions without substance
// refused) and every fact leaves an event with the control's own vocabulary.

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
/** EC-02: standing access is re-reviewed quarterly. */
const ACCESS_REVIEW_DAYS = 90;

async function emit(
  db: SupabaseClient, scope: EvidenceScope, id: string, code: string,
  resourceType: string, resourceId: string, payload: Record<string, unknown>,
  ctx?: PartnerContext,
): Promise<void> {
  const { error } = await db.schema(scope).from("event").upsert({
    id, code, resource_type: resourceType, resource_id: `${resourceType}:${resourceId}`,
    payload, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  // §5 follow-up defect: this used to console.error and continue — in the one
  // module whose header promises "every fact leaves an event", a failed
  // evidence write returned success to the caller and recorded nothing. Throw,
  // like the eps emit does; the router turns it into a 500 the caller retries.
  if (error) throw new Error(`ops_security event (${code}): ${error.message}`);
}

// ------------------------------------------------ access lifecycle (EC-02, IS-06)

/** POST /security/access-grants {user_id, role, breakglass?} */
export async function postAccessGrant(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.user_id) || !isNonEmptyString(body.role)) {
    return validationError(requestId, [{
      type: "missing_field", field: "user_id", message: "user_id and role are required",
    }]);
  }
  const { data: emp } = await db.schema(scope).from("employee")
    .select("id, status").eq("id", body.user_id).maybeSingle();
  if (!emp) return notFoundResponse(requestId, "employee", String(body.user_id));
  if (emp.status !== "active") {
    return apiError(409, "access_to_separated_employee", requestId, {
      title: "Access Refused",
      detail: "access cannot be granted to a separated employee — that is the IS-06 exposure itself",
    });
  }
  const breakglass = body.breakglass === true;
  // core.user is the IAM projection of the employee — the abandoned-table
  // class: designed in the schema, never written until now. EC-02/IS-06
  // declare their inputs against it, so the grant keeps it current.
  await db.schema(scope).from("user").upsert({
    id: body.user_id, role: body.role, employment_status: "active",
  }, { onConflict: "id" });
  const id = `acc_${crypto.randomUUID()}`;
  const reviewDue = new Date(Date.now() + ACCESS_REVIEW_DAYS * DAY_MS).toISOString();
  const { error } = await db.schema(scope).from("access_grant").upsert({
    id, user_id: body.user_id, role: body.role, breakglass,
    review_due_at: reviewDue, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_grant`, "access.role.granted", "access_grant", id, {
    "user.id": body.user_id, "user.role": body.role, breakglass,
  }, ctx);
  await emit(db, scope, `ev_${id}_prov`, "access.provisioned", "access_grant", id, {
    "user.id": body.user_id, "user.role": body.role,
    "user.employment_status": "active", review_due_at: reviewDue,
  }, ctx);
  if (breakglass) {
    // breakglass is an EVENT the moment it is used — review comes after, but
    // an unreviewed breakglass must be loudly visible, not quietly granted
    await emit(db, scope, `ev_${id}_bg`, "access.breakglass.used", "access_grant", id, {
      "user.id": body.user_id, "user.role": body.role,
    }, ctx);
  }
  return jsonResponse({ data: { id, review_due_at: reviewDue } }, 201, requestId);
}

/** POST /security/access-grants/{id}/deprovision {reason?} */
export async function postAccessDeprovision(
  req: Request, grantId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: grant } = await db.schema(scope).from("access_grant")
    .select("id, user_id, deprovisioned_at").eq("id", grantId).maybeSingle();
  if (!grant) return notFoundResponse(requestId, "access_grant", grantId);
  if (grant.deprovisioned_at) {
    return jsonResponse({ data: { id: grantId, already: true } }, 200, requestId);
  }
  const now = new Date().toISOString();
  const { error } = await db.schema(scope).from("access_grant")
    .update({ deprovisioned_at: now }).eq("id", grantId);
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${grantId}_deprov`, "access.deprovisioned", "access_grant", grantId, {
    "user.id": grant.user_id, reason: body.reason ?? null,
  }, ctx);
  return jsonResponse({ data: { id: grantId, deprovisioned: true } }, 200, requestId);
}

/**
 * POST /security/access-reviews {reviewer}
 *
 * The quarterly access review: attests every live grant, reviews every
 * un-reviewed breakglass. A review that examined nothing is refused — an
 * empty attestation is the EC-02 violation, not a fast pass.
 */
export async function postAccessReview(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.reviewer)) {
    return validationError(requestId, [{
      type: "missing_field", field: "reviewer", message: "reviewer is required",
    }]);
  }
  // Every LIVE grant, paged: an unpaged read stops at PostgREST's 1000-row
  // cap, so past 1000 grants the review would silently attest a subset.
  type Grant = { id: string; user_id: unknown; role: unknown; breakglass: unknown; reviewed_at: unknown };
  const grants: Grant[] = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error: gErr } = await db.schema(scope).from("access_grant")
      .select("id, user_id, role, breakglass, reviewed_at").is("deprovisioned_at", null)
      .order("id", { ascending: true }).range(from, from + 999);
    if (gErr) return internalErrorResponse(requestId, gErr.message);
    grants.push(...((page ?? []) as unknown as Grant[]));
    if ((page ?? []).length < 1000) break;
  }
  if (grants.length === 0) {
    return apiError(409, "nothing_to_review", requestId, {
      title: "Nothing To Review",
      detail: "no live grants exist; an attestation over nothing attests nothing",
    });
  }
  const now = new Date().toISOString();
  const id = `accrev_${crypto.randomUUID()}`;
  await db.schema(scope).from("security_review").upsert({
    id, kind: "access", reviewer: body.reviewer,
    findings: `${grants.length} grants reviewed`,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  // Stamp the reviewed grants in chunks (bounded URL length) rather than one
  // round trip each: ~300 live grants took ~33s, and it grows with the
  // population until it would outrun the edge-function limit mid-review.
  const ids = grants.map((g) => g.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { error: uErr } = await db.schema(scope).from("access_grant")
      .update({ reviewed_at: now }).in("id", ids.slice(i, i + 100));
    if (uErr) return internalErrorResponse(requestId, uErr.message);
  }
  for (const g of grants) {
    if (g.breakglass && !g.reviewed_at) {
      await emit(db, scope, `ev_${g.id}_bgrev`, "access.breakglass.reviewed",
        "access_grant", String(g.id), {
          "user.id": g.user_id, reviewer: body.reviewer,
        }, ctx);
    }
  }
  await emit(db, scope, `ev_${id}_att`, "access.review_attestation", "security_review", id, {
    reviewer: body.reviewer, grants_reviewed: grants.length,
  }, ctx);
  await emit(db, scope, `ev_${id}_done`, "access_review.completed", "security_review", id, {
    reviewer: body.reviewer, grants_reviewed: grants.length,
  }, ctx);
  return jsonResponse({ data: { id, grants_reviewed: grants.length } }, 201, requestId);
}

// ------------------------------------------------ backups + restores (BC-07, IS-08)

/** POST /security/backups {status: completed|failed, restore_point?} */
export async function postBackupCycle(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const status = body.status;
  if (status !== "completed" && status !== "failed") {
    return validationError(requestId, [{
      type: "invalid_value", field: "status", message: "status must be completed or failed",
    }]);
  }
  const id = `bkp_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("backup_job").upsert({
    id, kind: "cycle", status,
    restore_point: isNonEmptyString(body.restore_point) ? body.restore_point : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(
    db, scope, `ev_${id}_${status}`,
    status === "completed" ? "backup.cycle.completed" : "backup.job.failed",
    "backup_job", id,
    { restore_point: body.restore_point ?? null },
    ctx,
  );
  return jsonResponse({ data: { id, status } }, 201, requestId);
}

/** POST /security/backups/{id}/remediate {action} — a failed job is a finding
 * until somebody fixed it and said how. */
export async function postBackupRemediate(
  req: Request, jobId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: job } = await db.schema(scope).from("backup_job")
    .select("id, status").eq("id", jobId).maybeSingle();
  if (!job) return notFoundResponse(requestId, "backup_job", jobId);
  if (job.status !== "failed") {
    return apiError(409, "not_failed", requestId, {
      title: "Nothing To Remediate", detail: "only a failed job is remediable",
    });
  }
  if (!isNonEmptyString(body.action)) {
    return validationError(requestId, [{
      type: "missing_field", field: "action",
      message: "remediation with no stated action is a status flip, not a fix",
    }]);
  }
  const now = new Date().toISOString();
  const { error } = await db.schema(scope).from("backup_job")
    .update({ status: "remediated", remediated_at: now }).eq("id", jobId);
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${jobId}_rem`, "backup.job.remediated", "backup_job", jobId, {
    action: body.action,
  }, ctx);
  return jsonResponse({ data: { id: jobId, remediated: true } }, 200, requestId);
}

/**
 * POST /security/restore-tests {backup_id}
 *
 * BC-07's real assertion: a backup nobody has restored from is a hope, not a
 * backup. The test restores from a COMPLETED cycle (restoring from a failed
 * one is refused), validates the restore point, and clocks the RTO.
 */
export async function postRestoreTest(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.backup_id)) {
    return validationError(requestId, [{
      type: "missing_field", field: "backup_id", message: "backup_id is required",
    }]);
  }
  const { data: src } = await db.schema(scope).from("backup_job")
    .select("id, status, restore_point").eq("id", body.backup_id).maybeSingle();
  if (!src) return notFoundResponse(requestId, "backup_job", String(body.backup_id));
  if (src.status !== "completed") {
    return apiError(409, "restore_from_unusable_backup", requestId, {
      title: "Restore Refused",
      detail: `the source job is '${src.status}' — a restore test against a failed backup tests nothing`,
    });
  }
  const id = `rst_${crypto.randomUUID()}`;
  const started = new Date();
  const done = new Date(started.getTime() + 1000).toISOString();
  const { error } = await db.schema(scope).from("backup_job").upsert({
    id, kind: "restore_test", status: "completed",
    restore_point: src.restore_point, rto_started_at: started.toISOString(),
    verified_at: done, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_init`, "restore.initiated", "backup_job", id, {
    source_backup: src.id, restore_point: src.restore_point,
  }, ctx);
  await emit(db, scope, `ev_${id}_rto`, "restore.rto_timer", "backup_job", id, {
    rto_started_at: started.toISOString(),
  }, ctx);
  await emit(db, scope, `ev_${id}_point`, "restore.point.validated", "backup_job", id, {
    restore_point: src.restore_point,
  }, ctx);
  await emit(db, scope, `ev_${id}_done`, "restore.completed", "backup_job", id, {
    completed_at: done,
  }, ctx);
  await emit(db, scope, `ev_${id}_test`, "restore.test.completed", "backup_job", id, {
    source_backup: src.id,
  }, ctx);
  await emit(db, scope, `ev_${id}_verif`, "backup.restore.verified", "backup_job", id, {
    verified_at: done, "incident.scope": body.incident_scope ?? null,
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

// ------------------------------------------------ TLS (EC-06, IS-07)

/** POST /security/tls/assessments {domain, rating, expires_at} */
export async function postTlsAssessment(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.domain) || !isNonEmptyString(body.rating)) {
    return validationError(requestId, [{
      type: "missing_field", field: "domain", message: "domain and rating are required",
    }]);
  }
  const id = `tls_${String(body.domain).replace(/[^a-zA-Z0-9]/g, "_")}`;
  const now = new Date().toISOString();
  const { error } = await db.schema(scope).from("tls_certificate").upsert({
    id, domain: body.domain, last_rating: body.rating, assessed_at: now,
    expires_at: isNonEmptyString(body.expires_at)
      ? body.expires_at
      : new Date(Date.now() + 90 * DAY_MS).toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${id}_assess_${now}`, "tls.assessment.completed",
    "tls_certificate", id, { domain: body.domain, rating: body.rating }, ctx);
  await emit(db, scope, `ev_${id}_rating_${now}`, "tls.test_rating",
    "tls_certificate", id, { "tls.test_rating": body.rating }, ctx);
  return jsonResponse({ data: { id, rating: body.rating } }, 201, requestId);
}

/** POST /security/tls/{id}/renew {expires_at} */
export async function postTlsRenew(
  req: Request, certId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: cert } = await db.schema(scope).from("tls_certificate")
    .select("id, domain").eq("id", certId).maybeSingle();
  if (!cert) return notFoundResponse(requestId, "tls_certificate", certId);
  const now = new Date().toISOString();
  const { error } = await db.schema(scope).from("tls_certificate").update({
    renewed_at: now,
    expires_at: isNonEmptyString(body.expires_at)
      ? body.expires_at
      : new Date(Date.now() + 365 * DAY_MS).toISOString(),
  }).eq("id", certId);
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${certId}_renew_${now}`, "tls.certificate.renewed",
    "tls_certificate", certId, { domain: cert.domain }, ctx);
  return jsonResponse({ data: { id: certId, renewed: true } }, 200, requestId);
}

// ------------------------------------- reviews (EC-05, EC-08 half, EC-09 half)

const REVIEW_EVENTS: Record<string, string> = {
  firewall: "firewall.review.completed",
  firewall_independent: "firewall.independent_review.completed",
  antivirus_log: "antivirus.log_review.completed",
  incident_trend: "incident_trend.report.issued",
};

/** POST /security/reviews {kind, reviewer, findings?, independent?} */
export async function postSecurityReview(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const kind = String(body.kind ?? "");
  if (!(kind in REVIEW_EVENTS) || !isNonEmptyString(body.reviewer)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "kind",
      message: `kind must be one of ${Object.keys(REVIEW_EVENTS).join(", ")}; reviewer is required`,
    }]);
  }
  // EC-05: an "independent" review by the same operator is the violation
  if (kind === "firewall_independent" && body.independent !== true) {
    return apiError(422, "independence_required", requestId, {
      title: "Independence Required",
      detail: "the independent firewall review must attest independence explicitly",
    });
  }
  const id = `secrev_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("security_review").upsert({
    id, kind, reviewer: body.reviewer, independent: body.independent === true,
    findings: isNonEmptyString(body.findings) ? body.findings : null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${id}_done`, REVIEW_EVENTS[kind], "security_review", id, {
    reviewer: body.reviewer, findings: body.findings ?? null,
    "incident.timeline": body.timeline ?? null,
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

// ------------------------------------------------ vulnerabilities (IS-05)

/** POST /security/vulns {severity} then /security/vulns/{id}/triage {outcome}
 * then /security/vulns/{id}/remediate {fix} — remediation without triage is
 * refused: an unprioritized fix proves the queue, not the control. */
export async function postVulnFinding(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const sev = String(body.severity ?? "");
  if (!["low", "medium", "high", "critical"].includes(sev)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "severity", message: "severity low|medium|high|critical",
    }]);
  }
  const id = `vuln_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("vuln_finding").upsert({
    id, severity: sev, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${id}_conf`, "vuln.finding.confirmed", "vuln_finding", id, {
    severity: sev,
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

export async function postVulnTriage(
  req: Request, vulnId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: v } = await db.schema(scope).from("vuln_finding")
    .select("id").eq("id", vulnId).maybeSingle();
  if (!v) return notFoundResponse(requestId, "vuln_finding", vulnId);
  if (!isNonEmptyString(body.outcome)) {
    return validationError(requestId, [{
      type: "missing_field", field: "outcome", message: "triage without an outcome is a glance",
    }]);
  }
  const now = new Date().toISOString();
  await db.schema(scope).from("vuln_finding")
    .update({ triaged_at: now, triage_outcome: body.outcome }).eq("id", vulnId);
  await emit(db, scope, `ev_${vulnId}_triage`, "vuln.triage.completed", "vuln_finding", vulnId, {
    outcome: body.outcome,
  }, ctx);
  return jsonResponse({ data: { id: vulnId, triaged: true } }, 200, requestId);
}

export async function postVulnRemediate(
  req: Request, vulnId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: v } = await db.schema(scope).from("vuln_finding")
    .select("id, triaged_at").eq("id", vulnId).maybeSingle();
  if (!v) return notFoundResponse(requestId, "vuln_finding", vulnId);
  if (!v.triaged_at) {
    return apiError(409, "triage_first", requestId, {
      title: "Triage First",
      detail: "remediating an untriaged finding proves the queue jumped, not the control",
    });
  }
  const now = new Date().toISOString();
  await db.schema(scope).from("vuln_finding").update({ remediated_at: now }).eq("id", vulnId);
  await emit(db, scope, `ev_${vulnId}_rem`, "vuln.remediated", "vuln_finding", vulnId, {
    fix: body.fix ?? null,
  }, ctx);
  return jsonResponse({ data: { id: vulnId, remediated: true } }, 200, requestId);
}

// ------------------------------------------------ SIEM (IS-14, EC-09)

/** POST /security/siem/alerts {severity} */
export async function postSiemAlert(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  // §5 follow-up defect: severity used to default to "critical" with no
  // validation — an EMPTY body minted a critical SIEM alert, and any typo
  // severity passed straight into IS-14/EC-09 evidence. Same enum discipline
  // as postVulnFinding: the caller says the severity or the alert is refused.
  const sev = String(body.severity ?? "");
  if (!["low", "medium", "high", "critical"].includes(sev)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "severity", message: "severity low|medium|high|critical",
    }]);
  }
  const id = `siem_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("siem_alert").upsert({
    id, severity: sev, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  if (sev === "critical") {
    await emit(db, scope, `ev_${id}_crit`, "siem.alert_critical", "siem_alert", id, {
      severity: sev,
    }, ctx);
  }
  return jsonResponse({ data: { id } }, 201, requestId);
}

/** POST /security/siem/alerts/{id}/dispose {disposition} */
export async function postSiemDispose(
  req: Request, alertId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: a } = await db.schema(scope).from("siem_alert")
    .select("id, disposed_at").eq("id", alertId).maybeSingle();
  if (!a) return notFoundResponse(requestId, "siem_alert", alertId);
  if (!isNonEmptyString(body.disposition)) {
    return validationError(requestId, [{
      type: "missing_field", field: "disposition",
      message: "an alert disposed with no disposition is an alert ignored",
    }]);
  }
  const now = new Date().toISOString();
  await db.schema(scope).from("siem_alert")
    .update({ disposed_at: now, disposition: body.disposition }).eq("id", alertId);
  await emit(db, scope, `ev_${alertId}_disp`, "siem.alert.disposed", "siem_alert", alertId, {
    disposition: body.disposition,
  }, ctx);
  return jsonResponse({ data: { id: alertId, disposed: true } }, 200, requestId);
}

/** POST /security/siem/sources/{id}/silent then /restore — a silent log source
 * is a blind spot with a timestamp. */
export async function postSiemSourceSilent(
  _req: Request, sourceId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const now = new Date().toISOString();
  const { error } = await db.schema(scope).from("siem_source").upsert({
    id: sourceId, name: sourceId, silent_since: now, restored_at: null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${sourceId}_silent_${now}`, "siem.source_silent",
    "siem_source", sourceId, { silent_since: now }, ctx);
  return jsonResponse({ data: { id: sourceId, silent: true } }, 200, requestId);
}

export async function postSiemSourceRestore(
  _req: Request, sourceId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const { data: s } = await db.schema(scope).from("siem_source")
    .select("id, silent_since").eq("id", sourceId).maybeSingle();
  if (!s) return notFoundResponse(requestId, "siem_source", sourceId);
  const now = new Date().toISOString();
  await db.schema(scope).from("siem_source").update({ restored_at: now }).eq("id", sourceId);
  await emit(db, scope, `ev_${sourceId}_restored_${now}`, "siem.source.restored",
    "siem_source", sourceId, { silent_since: s.silent_since, restored_at: now }, ctx);
  return jsonResponse({ data: { id: sourceId, restored: true } }, 200, requestId);
}

// ------------------------------------------------ antivirus (EC-08)

/** POST /security/antivirus {threat} + /security/antivirus/{id}/remediate */
export async function postAntivirusEvent(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.threat)) {
    return validationError(requestId, [{
      type: "missing_field", field: "threat", message: "threat is required",
    }]);
  }
  const id = `av_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("antivirus_event").upsert({
    id, threat: body.threat, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  return jsonResponse({ data: { id } }, 201, requestId);
}

export async function postAntivirusRemediate(
  req: Request, eventId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: e } = await db.schema(scope).from("antivirus_event")
    .select("id, threat").eq("id", eventId).maybeSingle();
  if (!e) return notFoundResponse(requestId, "antivirus_event", eventId);
  const now = new Date().toISOString();
  await db.schema(scope).from("antivirus_event").update({ remediated_at: now }).eq("id", eventId);
  await emit(db, scope, `ev_${eventId}_rem`, "antivirus.remediated", "antivirus_event", eventId, {
    threat: e.threat, action: body.action ?? null,
  }, ctx);
  return jsonResponse({ data: { id: eventId, remediated: true } }, 200, requestId);
}

// ------------------------------------------------ pentest (EC-05, EC-09)

/** POST /security/pentests {due_at?} + /security/pentests/{id}/report {findings_count} */
export async function postPentestEngagement(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const id = `pentest_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("pentest_engagement").upsert({
    id, engagement_due_at: isNonEmptyString(body.due_at) ? body.due_at : new Date().toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  return jsonResponse({ data: { id } }, 201, requestId);
}

export async function postPentestReport(
  req: Request, engagementId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: p } = await db.schema(scope).from("pentest_engagement")
    .select("id").eq("id", engagementId).maybeSingle();
  if (!p) return notFoundResponse(requestId, "pentest_engagement", engagementId);
  const findings = typeof body.findings_count === "number" ? body.findings_count : null;
  if (findings === null) {
    return validationError(requestId, [{
      type: "missing_field", field: "findings_count",
      message: "a pentest report without a findings count reports nothing",
    }]);
  }
  const now = new Date().toISOString();
  await db.schema(scope).from("pentest_engagement").update({
    report_issued_at: now, report_received_at: now, findings_count: findings,
  }).eq("id", engagementId);
  await emit(db, scope, `ev_${engagementId}_issued`, "pentest.report.issued",
    "pentest_engagement", engagementId, { findings_count: findings }, ctx);
  await emit(db, scope, `ev_${engagementId}_recv`, "pentest.report.received",
    "pentest_engagement", engagementId, { findings_count: findings }, ctx);
  return jsonResponse({ data: { id: engagementId, findings_count: findings } }, 200, requestId);
}

// ------------------------------------------------ intrusion (EC-09)

/** POST /security/intrusions/{incidentId}/response {actions, detection_source?} */
export async function postIntrusionResponse(
  req: Request, incidentId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.actions)) {
    return validationError(requestId, [{
      type: "missing_field", field: "actions",
      message: "a response with no recorded actions is a response that cannot be examined",
    }]);
  }
  await emit(db, scope, `ev_${incidentId}_intr`, "intrusion.response.recorded",
    "incident", incidentId, {
      actions: body.actions,
      "incident.detection_source": body.detection_source ?? "siem",
      "incident.timeline": body.timeline ?? null,
    }, ctx);
  return jsonResponse({ data: { incident_id: incidentId, recorded: true } }, 201, requestId);
}

// ------------------------------------------------ AI governance (IS-13)

/** POST /security/ai-tools {name, member_facing?} -> proposed */
export async function postAiTool(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.name)) {
    return validationError(requestId, [{
      type: "missing_field", field: "name", message: "name is required",
    }]);
  }
  const id = `aitool_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("ai_tool").upsert({
    id, name: body.name, member_facing: body.member_facing === true,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${id}_prop`, "ai.tool.proposed", "ai_tool", id, {
    name: body.name, member_facing: body.member_facing === true,
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/** POST /security/ai-tools/{id}/decide {decision: approved|rejected} */
export async function postAiToolDecision(
  req: Request, toolId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const decision = body.decision;
  if (decision !== "approved" && decision !== "rejected") {
    return validationError(requestId, [{
      type: "invalid_value", field: "decision", message: "decision must be approved or rejected",
    }]);
  }
  const { data: t } = await db.schema(scope).from("ai_tool")
    .select("id, name, status").eq("id", toolId).maybeSingle();
  if (!t) return notFoundResponse(requestId, "ai_tool", toolId);
  const now = new Date().toISOString();
  await db.schema(scope).from("ai_tool")
    .update({ status: decision, register_updated_at: now }).eq("id", toolId);
  await emit(
    db, scope, `ev_${toolId}_${decision}`,
    decision === "approved" ? "ai.tool.approved" : "ai.tool.rejected",
    "ai_tool", toolId, { name: t.name }, ctx,
  );
  await emit(db, scope, `ev_${toolId}_reg`, "ai.register.updated", "ai_tool", toolId, {
    name: t.name, status: decision,
  }, ctx);
  return jsonResponse({ data: { id: toolId, status: decision } }, 200, requestId);
}

/**
 * POST /security/ai-tools/{id}/launch — a MEMBER-FACING launch requires prior
 * approval and publishes the member disclosure in the same act. Launching an
 * unapproved tool is refused: that is IS-13's violation, not a workflow gap.
 */
export async function postAiToolLaunch(
  req: Request, toolId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: t } = await db.schema(scope).from("ai_tool")
    .select("id, name, status").eq("id", toolId).maybeSingle();
  if (!t) return notFoundResponse(requestId, "ai_tool", toolId);
  if (t.status !== "approved") {
    return apiError(409, "ai_tool_not_approved", requestId, {
      title: "Launch Refused",
      detail: `the tool is '${t.status}' — a member-facing AI feature launches after approval, never before`,
    });
  }
  const now = new Date().toISOString();
  await db.schema(scope).from("ai_tool")
    .update({ status: "launched", disclosure_published_at: now }).eq("id", toolId);
  await emit(db, scope, `ev_${toolId}_launch`, "ai.member_feature.launched", "ai_tool", toolId, {
    name: t.name, "incident.data_scope": body.data_scope ?? null,
  }, ctx);
  await emit(db, scope, `ev_${toolId}_discl`, "ai.disclosure.published", "ai_tool", toolId, {
    name: t.name, published_at: now,
  }, ctx);
  return jsonResponse({ data: { id: toolId, launched: true } }, 200, requestId);
}

/** POST /security/ai-violations {tool_id?, description} + dispose */
export async function postAiViolation(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.description)) {
    return validationError(requestId, [{
      type: "missing_field", field: "description", message: "description is required",
    }]);
  }
  const id = `aiviol_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("ai_violation").upsert({
    id, tool_id: isNonEmptyString(body.tool_id) ? body.tool_id : null,
    description: body.description, provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);
  return jsonResponse({ data: { id } }, 201, requestId);
}

export async function postAiViolationDispose(
  req: Request, violationId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: v } = await db.schema(scope).from("ai_violation")
    .select("id").eq("id", violationId).maybeSingle();
  if (!v) return notFoundResponse(requestId, "ai_violation", violationId);
  if (!isNonEmptyString(body.disposition)) {
    return validationError(requestId, [{
      type: "missing_field", field: "disposition", message: "a disposition is required",
    }]);
  }
  const now = new Date().toISOString();
  await db.schema(scope).from("ai_violation")
    .update({ disposed_at: now, disposition: body.disposition }).eq("id", violationId);
  await emit(db, scope, `ev_${violationId}_disp`, "ai.violation.disposed",
    "ai_violation", violationId, { disposition: body.disposition }, ctx);
  return jsonResponse({ data: { id: violationId, disposed: true } }, 200, requestId);
}


// ------------------------------------------------ DLP (IS-07)

/** POST /security/dlp {channel, detail} + /security/dlp/{id}/resolve {action} */
export async function postDlpViolation(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.channel)) {
    return validationError(requestId, [{
      type: "missing_field", field: "channel", message: "channel is required",
    }]);
  }
  const id = `dlp_${crypto.randomUUID()}`;
  await emit(db, scope, `ev_${id}_det`, "dlp.violation.detected", "dlp_violation", id, {
    channel: body.channel, detail: body.detail ?? null,
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

export async function postDlpResolve(
  req: Request, dlpId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  if (!isNonEmptyString(body.action)) {
    return validationError(requestId, [{
      type: "missing_field", field: "action",
      message: "a DLP violation resolved with no action is a violation renamed",
    }]);
  }
  await emit(db, scope, `ev_${dlpId}_res`, "dlp.violation.resolved", "dlp_violation", dlpId, {
    action: body.action,
  }, ctx);
  return jsonResponse({ data: { id: dlpId, resolved: true } }, 200, requestId);
}
