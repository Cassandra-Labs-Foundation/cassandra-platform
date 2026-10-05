// BSA/AML programme — BSA-03..BSA-19.
//
// ⚠ READ THE MIGRATION HEADER BEFORE QUOTING ANY OFAC CONTROL AS GREEN.
// The screening MECHANISM is real and testable. The screen underneath it is
// still the OQ-02 stub: no list, no `list_version`, no 50%-rule derivation.
// Green here means the plumbing works, not that anything would be detected.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor, raiseAlert } from "./bsa.ts";
import {
  apiError, internalErrorResponse, isNonEmptyString, isUuid, jsonResponse, notFoundResponse,
  parseJsonBody, validationError,
} from "./lib.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 31 CFR 1010.415: the monetary-instrument log band. */
export const MI_LOG_FLOOR_CENTS = 3_000_00;
export const MI_CTR_FLOOR_CENTS = 10_000_00;
/** 31 CFR 1010.410(f): the Travel Rule attaches at $3,000. */
export const TRAVEL_RULE_FLOOR_CENTS = 3_000_00;
/** 31 CFR 1010.350: FBAR at an aggregate over $10,000. */
export const FBAR_THRESHOLD_CENTS = 10_000_00;
/** 314(a): search and respond within 14 days of the request. */
const FINCEN_314A_DAYS = 14;
/** BSA-14: an urgent escalation is acknowledged same day, routine within 3. */
const ACK_DAYS_URGENT = 1;
const ACK_DAYS_ROUTINE = 3;
/** EDD must complete within 30 days of the trigger. */
const EDD_DAYS = 30;
/** A regulatory change is assessed for applicability within 30 days. */
const REG_CHANGE_ASSESSMENT_DAYS = 30;

/** Categories where onboarding requires senior sign-off, not just EDD. */
const SENIOR_APPROVAL_CATEGORIES = new Set(["pep", "correspondent", "privately_owned_atm"]);

function requireInternalActor(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/bsa");
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
  if (error) throw new Error(`bsa event (${code}): ${error.message}`);
}

const plusDays = (f: Date, d: number) => new Date(f.getTime() + d * DAY_MS).toISOString();

// -------------------------------------------------------------- OFAC (BSA-05)

/**
 * THE SCREEN. Unchanged from OQ-02 and deliberately so — this is a stub and the
 * whole point of exposing it as one function is that its poverty is visible in
 * one place rather than implied across five call sites.
 */
export function ofacMatch(name: string): "clear" | "potential_match" {
  return /\bSDN\b/i.test(name) ? "potential_match" : "clear";
}

/**
 * Place an OFAC hold: the screen row, its hold + escalation events, and the BSA
 * alert that routes it to adjudication. ONE implementation for every screening
 * path — CIP and monetary-instrument sales used to write a hold with no alert
 * (nobody was told) and, for instruments, after the sale had completed (caught
 * by the BSA-program partner-flow suite).
 */
async function placeOfacHold(
  db: SupabaseClient, scope: EvidenceScope, ctx: PartnerContext,
  subjectKind: string, subjectRef: string, name: string, now: Date,
): Promise<string> {
  const id = `ofacs_${subjectKind}_${subjectRef}`;
  const { error } = await db.schema(scope).from("ofac_screen").upsert({
    id, subject_kind: subjectKind, subject_ref: subjectRef, screened_name: name,
    list_version: null, verdict: "potential_match", screened_at: now.toISOString(),
    hold_placed_at: now.toISOString(), escalated_at: now.toISOString(),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) throw new Error(`ofac_screen hold (${id}): ${error.message}`);
  const payload = {
    "ofac.subject_ref": subjectRef, "ofac.screened_name": name,
    "ofac.list_version": null, verdict: "potential_match",
  };
  await emit(db, scope, `ev_${id}_hold`, "ofac.hold.placed", "ofac_screen", id, payload, ctx);
  await emit(db, scope, `ev_${id}_esc`, "ofac.escalated", "ofac_screen", id, payload, ctx);
  await raiseAlert(db, {
    ctx, scope, alertType: "ofac", entityHash: subjectRef,
    causeType: subjectKind, causeId: subjectRef,
    details: `OFAC potential match on ${name}; hold placed`,
  });
  return id;
}

/**
 * POST /bsa/ofac/screens {subject_kind, subject_ref, name}
 *
 * BSA-05. Writes evidence on EVERY run including clean passes — "screened and
 * clear" and "never screened" must not produce the same log. A match places a
 * hold, which is what makes this a control rather than a lookup.
 */
export async function postOfacScreen(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const kinds = [
    "entity", "loan_party", "wire_beneficiary", "ach_counterparty", "monetary_instrument",
  ];
  if (!kinds.includes(String(body.subject_kind)) || !isNonEmptyString(body.name) ||
      !isNonEmptyString(body.subject_ref)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "subject_kind",
      message: `subject_kind in ${kinds.join("/")}, subject_ref and name are required`,
    }]);
  }

  const now = new Date();
  const verdict = ofacMatch(String(body.name));
  const id = `ofacs_${body.subject_kind}_${body.subject_ref}`;
  const payload = {
    "ofac.subject_ref": body.subject_ref, "ofac.screened_name": body.name,
    "ofac.list_version": null, verdict,
  };

  if (verdict === "clear") {
    const { error } = await db.schema(scope).from("ofac_screen").upsert({
      id, subject_kind: body.subject_kind, subject_ref: body.subject_ref,
      screened_name: body.name,
      // NULL, always. See the header — the screen cannot name its list.
      list_version: null,
      verdict, screened_at: now.toISOString(),
      hold_placed_at: null, escalated_at: null,
      provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id" });
    if (error) return internalErrorResponse(requestId, error.message);
    await emit(db, scope, `ev_${id}_screened`, "ofac.screened", "ofac_screen", id, payload, ctx);
    await emit(db, scope, `ev_${id}_clear`, "ofac.cleared", "ofac_screen", id, payload, ctx);
    return jsonResponse({ data: { id, verdict } }, 201, requestId);
  }

  try {
    await placeOfacHold(db, scope, ctx, String(body.subject_kind), String(body.subject_ref), String(body.name), now);
  } catch (e) {
    return internalErrorResponse(requestId, e instanceof Error ? e.message : String(e));
  }
  await emit(db, scope, `ev_${id}_screened`, "ofac.screened", "ofac_screen", id, payload, ctx);
  return apiError(409, "ofac_hold", requestId, {
    title: "OFAC hold placed",
    detail: `potential match on '${body.name}'; the subject is blocked pending review`,
  });
}

/** POST /bsa/ofac/screens/:id/release {released_by, determination} */
export async function postOfacRelease(
  req: Request, screenId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: s } = await db.schema(scope).from("ofac_screen")
    .select("id, verdict, hold_placed_at, subject_ref").eq("id", screenId).maybeSingle();
  if (!s) return notFoundResponse(requestId, "ofac_screen", screenId);
  if (!s.hold_placed_at) {
    return apiError(409, "ofac_no_hold", requestId, {
      title: "nothing to release", detail: "this screen placed no hold",
    });
  }
  if (!isNonEmptyString(body.released_by) || !isNonEmptyString(body.determination)) {
    // Releasing an OFAC hold is a DECISION with a named owner. A release with
    // no determination is the hold quietly disappearing.
    return validationError(requestId, [{
      type: "missing_field", field: "determination",
      message: "releasing a hold requires a named releaser and a determination",
    }]);
  }
  const now = new Date();
  const { error } = await db.schema(scope).from("ofac_screen").update({
    hold_released_at: now.toISOString(), released_by: body.released_by,
  }).eq("id", screenId);
  if (error) return internalErrorResponse(requestId, error.message);
  await emit(db, scope, `ev_${screenId}_rel`, "ofac.hold.released", "ofac_screen", screenId, {
    released_by: body.released_by, determination: body.determination,
  }, ctx);
  return jsonResponse({ data: { id: screenId, released: true } }, 200, requestId);
}

// --------------------------------------------------- BSA-04/17/18 EDD and PEP

/** POST /bsa/edd {entity_ref, category, trigger_reason} */
export async function postEddProfile(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const cats = [
    "msb", "correspondent", "pep", "cash_intensive", "nonresident_alien", "privately_owned_atm",
  ];
  if (!cats.includes(String(body.category)) || !isNonEmptyString(body.entity_ref) ||
      !isNonEmptyString(body.trigger_reason)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "category",
      message: `category in ${cats.join("/")}, entity_ref and trigger_reason are required`,
    }]);
  }
  const now = new Date();
  const senior = SENIOR_APPROVAL_CATEGORIES.has(String(body.category));
  const id = `edd_${body.entity_ref}_${body.category}`;
  const { error } = await db.schema(scope).from("edd_profile").upsert({
    id, entity_ref: body.entity_ref, category: body.category,
    trigger_reason: body.trigger_reason,
    opened_at: now.toISOString(), due_at: plusDays(now, EDD_DAYS),
    senior_approval_required: senior,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_trig`, "risk.trigger_edd", "edd_profile", id, {
    "edd.category": body.category, "edd.trigger_reason": body.trigger_reason,
    "risk.rating": "high", due_at: plusDays(now, EDD_DAYS),
  }, ctx);
  await emit(db, scope, `ev_${id}_open`, "edd.opened", "edd_profile", id, {
    "edd.category": body.category, senior_approval_required: senior,
  }, ctx);
  return jsonResponse({ data: { id, senior_approval_required: senior } }, 201, requestId);
}

/** POST /bsa/edd/:id/complete {findings, approved_by?} */
export async function postEddCompletion(
  req: Request, eddId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: e } = await db.schema(scope).from("edd_profile")
    .select("id, category, senior_approval_required, due_at, entity_ref")
    .eq("id", eddId).maybeSingle();
  if (!e) return notFoundResponse(requestId, "edd_profile", eddId);
  if (!isNonEmptyString(body.findings)) {
    return validationError(requestId, [{
      type: "missing_field", field: "findings",
      message: "EDD completed with no findings is a status change",
    }]);
  }
  if (e.senior_approval_required === true && !isNonEmptyString(body.approved_by)) {
    // BSA-17: a correspondent or PEP relationship is not opened by the analyst
    // who reviewed it.
    return apiError(409, "edd_senior_approval_required", requestId, {
      title: "senior approval required",
      detail: `category '${e.category}' cannot be approved without senior sign-off`,
    });
  }

  const now = new Date();
  const { error } = await db.schema(scope).from("edd_profile").update({
    completed_at: now.toISOString(), findings: body.findings,
    approved_by: isNonEmptyString(body.approved_by) ? body.approved_by : null,
    approver_id: isNonEmptyString(body.approved_by) ? body.approved_by : null,
    updated_at: now.toISOString(),
  }).eq("id", eddId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${eddId}_done`, "edd.completed", "edd_profile", eddId, {
    "edd.category": e.category, findings: body.findings,
    completed_late: now.toISOString() > String(e.due_at),
  }, ctx);
  await emit(db, scope, `ev_${eddId}_cat`, "edd.category.approved", "edd_profile", eddId, {
    "edd.category": e.category, approved_by: body.approved_by ?? null,
  }, ctx);
  // BSA-17: EDD is not one-and-done. Completing it schedules the next refresh,
  // because a high-risk relationship reviewed once and never again is the
  // failure the category exists to prevent.
  await emit(db, scope, `ev_${eddId}_refresh`, "edd.refresh.completed", "edd_profile", eddId, {
    "edd.category": e.category, next_refresh_due_at: plusDays(now, 365),
    "edd.approver_id": body.approved_by ?? null,
  }, ctx);
  await emit(db, scope, `ev_${eddId}_approver`, "edd.approver_id", "edd_profile", eddId, {
    "edd.approver_id": body.approved_by ?? null, "edd.category": e.category,
  }, ctx);
  if (e.category === "pep") {
    await emit(db, scope, `ev_${eddId}_peprefresh`, "pep.refresh.completed",
      "edd_profile", eddId, {
        "edd.approver_id": body.approved_by ?? null,
        next_screen_due_at: plusDays(now, 365),
      }, ctx);
    await emit(db, scope, `ev_${eddId}_peddone`, "edd.pep.completed", "edd_profile", eddId, {
      "edd.approver_id": body.approved_by ?? null, findings: body.findings,
    }, ctx);
  }
  return jsonResponse({ data: { id: eddId, completed: true } }, 200, requestId);
}

/** POST /bsa/pep/screens {entity_ref, name, pep_category?} */
export async function postPepScreen(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.entity_ref) || !isNonEmptyString(body.name)) {
    return validationError(requestId, [{
      type: "missing_field", field: "name", message: "entity_ref and name are required",
    }]);
  }
  // Same stub shape as OFAC, and same honesty: no list, so no list_version.
  const hit = isNonEmptyString(body.pep_category) || /\bPEP\b/i.test(String(body.name));
  const now = new Date();
  const id = `peps_${body.entity_ref}`;

  let eddId: string | null = null;
  if (hit) {
    // A PEP hit that opens no EDD is a hit nobody acted on. The EDD is created
    // HERE rather than left to a downstream process, because "flagged" with no
    // follow-up is the failure mode.
    eddId = `edd_${body.entity_ref}_pep`;
    await db.schema(scope).from("edd_profile").upsert({
      id: eddId, entity_ref: body.entity_ref, category: "pep",
      trigger_reason: `PEP screen hit: ${body.pep_category ?? "name match"}`,
      opened_at: now.toISOString(), due_at: plusDays(now, EDD_DAYS),
      senior_approval_required: true,
      provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id", ignoreDuplicates: true });
  }

  const { error } = await db.schema(scope).from("pep_screen").upsert({
    id, entity_ref: body.entity_ref, screened_name: body.name,
    list_version: null, verdict: hit ? "hit" : "clear",
    pep_category: isNonEmptyString(body.pep_category) ? body.pep_category : null,
    screened_at: now.toISOString(), edd_profile_id: eddId,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_scr`, "pep.screened", "pep_screen", id, {
    "pep.verdict": hit ? "hit" : "clear", "pep.list_version": null,
  }, ctx);
  if (hit) {
    await emit(db, scope, `ev_${id}_desig`, "pep.designated", "pep_screen", id, {
      "pep.category": body.pep_category ?? "name_match", entity_ref: body.entity_ref,
    }, ctx);
    await emit(db, scope, `ev_${id}_eddpep`, "edd.pep.opened", "pep_screen", id, {
      edd_profile_id: eddId, "edd.category": "pep",
    }, ctx);
    await emit(db, scope, `ev_${id}_hit`, "pep.hit", "pep_screen", id, {
      "pep.category": body.pep_category ?? "name_match", edd_profile_id: eddId,
    }, ctx);
    // BSA-18: a PEP relationship is re-screened on a cycle. Screening once at
    // onboarding misses the member who BECOMES a PEP, which is the common case.
    await emit(db, scope, `ev_${id}_refresh`, "pep.refresh.scheduled", "pep_screen", id, {
      next_screen_due_at: plusDays(now, 365), "pep.category": body.pep_category ?? "name_match",
    }, ctx);
    await emit(db, scope, `ev_${id}_edd`, "risk.trigger_edd", "pep_screen", id, {
      "edd.category": "pep", "risk.rating": "high",
    }, ctx);
  }
  return jsonResponse({ data: { id, verdict: hit ? "hit" : "clear" } }, 201, requestId);
}

// ------------------------------------------------- BSA-09 monetary instruments

/**
 * POST /bsa/monetary-instruments
 * {instrument_type, amount_cents, purchaser_name, purchaser_id_type?, ...}
 *
 * 31 CFR 1010.415. The log attaches between $3,000 and $10,000 in CASH. Below
 * that nothing attaches; at $10,000 a CTR does instead. Getting the band wrong
 * in either direction is the failure: logging everything buries the reportable
 * ones, logging nothing misses them.
 */
export async function postMonetaryInstrument(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const types = ["cashiers_check", "money_order", "travelers_check", "bank_draft"];
  const amount = typeof body.amount_cents === "number" ? body.amount_cents : NaN;
  if (!types.includes(String(body.instrument_type)) || !Number.isFinite(amount) ||
      amount <= 0 || !isNonEmptyString(body.purchaser_name)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "instrument_type",
      message: "instrument_type, a positive amount_cents and purchaser_name are required",
    }]);
  }

  const logRequired = amount >= MI_LOG_FLOOR_CENTS && amount < MI_CTR_FLOOR_CENTS;
  const idType = isNonEmptyString(body.purchaser_id_type) ? body.purchaser_id_type : null;
  const idNumber = isNonEmptyString(body.purchaser_id_number) ? body.purchaser_id_number : null;
  const verified = logRequired ? (idType !== null && idNumber !== null) : true;

  if (logRequired && !verified) {
    // The whole point of the log is that an instrument in the reportable band
    // is not anonymous. Refusing is the control.
    return apiError(409, "monetary_instrument_id_required", requestId, {
      title: "identification required",
      detail: `a cash purchase of ${amount} requires verified identification (31 CFR 1010.415)`,
    });
  }

  const now = new Date();
  // BSA-05: screened pre-execution, like every payment party. A hit refuses
  // the sale — screening after the row was written sold the instrument and
  // left only an event behind.
  if (ofacMatch(String(body.purchaser_name)) !== "clear") {
    const ref = isNonEmptyString(body.purchaser_ref) ? body.purchaser_ref : String(body.purchaser_name);
    try {
      await placeOfacHold(db, scope, ctx, "monetary_instrument", ref, String(body.purchaser_name), now);
    } catch (e) {
      return internalErrorResponse(requestId, e instanceof Error ? e.message : String(e));
    }
    return apiError(409, "ofac_hold", requestId, {
      title: "OFAC hold placed",
      detail: `potential match on '${body.purchaser_name}'; the sale is refused pending review`,
    });
  }
  const id = `mi_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("monetary_instrument").upsert({
    id, instrument_type: body.instrument_type, amount_cents: amount,
    purchased_at: isNonEmptyString(body.purchased_at) ? body.purchased_at : now.toISOString(),
    purchaser_ref: isNonEmptyString(body.purchaser_ref) ? body.purchaser_ref : null,
    purchaser_name: body.purchaser_name,
    purchaser_id_type: idType, purchaser_id_number: idNumber,
    purchaser_dob: isNonEmptyString(body.purchaser_dob) ? body.purchaser_dob : null,
    log_required: logRequired, id_verified: verified,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_pur`, "monetary_instrument.purchased",
    "monetary_instrument", id, {
      "monetary_instrument.type": body.instrument_type,
      "monetary_instrument.amount": amount,
      "monetary_instrument.log_required": logRequired,
    }, ctx);
  if (logRequired) {
    // The corpus names this fact three ways (OQ-22 alias class): BSA-09 says
    // `mi.log_entry.created` and `mi.central_log.updated`, the trigger
    // vocabulary says `monetary_instrument.logged`. One act, three names.
    await emit(db, scope, `ev_${id}_mientry`, "mi.log_entry.created",
      "monetary_instrument", id, {
        "mi.amount": amount, "mi.purchaser_id": idNumber, "mi.instrument_type": body.instrument_type,
      }, ctx);
    await emit(db, scope, `ev_${id}_micentral`, "mi.central_log.updated",
      "monetary_instrument", id, { "mi.amount": amount, log_required: true }, ctx);
    await emit(db, scope, `ev_${id}_log`, "monetary_instrument.logged",
      "monetary_instrument", id, {
        "monetary_instrument.purchaser_id": idNumber,
        "monetary_instrument.amount": amount, id_verified: true,
      }, ctx);
  } else if (amount >= MI_CTR_FLOOR_CENTS) {
    // At and above $10,000 the CTR obligation replaces the log. Saying so
    // explicitly stops the absence of a log row reading as a gap.
    await emit(db, scope, `ev_${id}_ctr`, "monetary_instrument.ctr_band",
      "monetary_instrument", id, {
        "monetary_instrument.amount": amount, ctr_required: true,
      }, ctx);
  }
  // BSA-05: the purchaser was screened above; a reportable sale records that
  // it cleared (a hit never reaches this point).
  if (logRequired) {
    await emit(db, scope, `ev_${id}_ofac`, "ofac.cleared",
      "monetary_instrument", id, { verdict: "clear", "ofac.list_version": null }, ctx);
  }
  return jsonResponse({ data: { id, log_required: logRequired } }, 201, requestId);
}

// ---------------------------------------------------------------- BSA-13 FBAR

/** POST /bsa/fbar/accounts {account_ref, country, institution_name, max_value_cents, year} */
export async function postFbarAccount(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const maxV = typeof body.max_value_cents === "number" ? body.max_value_cents : NaN;
  const year = typeof body.reporting_year === "number" ? body.reporting_year : NaN;
  if (!isNonEmptyString(body.account_ref) || !isNonEmptyString(body.country) ||
      !Number.isFinite(maxV) || !Number.isFinite(year)) {
    return validationError(requestId, [{
      type: "missing_field", field: "max_value_cents",
      message: "account_ref, country, max_value_cents and reporting_year are required",
    }]);
  }
  const id = `fbara_${body.account_ref}_${year}`;
  const { error } = await db.schema(scope).from("fbar_account").upsert({
    id, account_ref: body.account_ref, country: body.country,
    institution_name: isNonEmptyString(body.institution_name)
      ? body.institution_name
      : "unknown",
    max_value_cents: maxV, reporting_year: year,
    added_at: new Date().toISOString(), provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_add`, "fbar.account.added", "fbar_account", id, {
    "fbar.country": body.country, "fbar.max_value": maxV, reporting_year: year,
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/**
 * POST /bsa/fbar/filings {reporting_year, filed_by?, bsa_efiling_ref?}
 *
 * The threshold is on the AGGREGATE of all foreign accounts, not on any one of
 * them. A per-account test is the classic FBAR error: five accounts of $3,000
 * each are reportable and none of them individually is.
 */
export async function postFbarFiling(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const year = typeof body.reporting_year === "number" ? body.reporting_year : NaN;
  if (!Number.isFinite(year)) {
    return validationError(requestId, [{
      type: "missing_field", field: "reporting_year", message: "is required",
    }]);
  }
  const { data: accts } = await db.schema(scope).from("fbar_account")
    .select("id, reporting_year, max_value_cents").eq("reporting_year", year);
  const aggregate = (accts ?? []).reduce((n: number, a: Any) => n + Number(a.max_value_cents), 0);
  const required = aggregate > FBAR_THRESHOLD_CENTS;

  const filedBy = isNonEmptyString(body.filed_by) ? body.filed_by : null;
  const ref = isNonEmptyString(body.bsa_efiling_ref) ? body.bsa_efiling_ref : null;
  if (filedBy && !ref) {
    return validationError(requestId, [{
      type: "missing_field", field: "bsa_efiling_ref",
      message: "a filing with no BSA E-Filing reference cannot be evidenced",
    }]);
  }

  const dueAt = new Date(Date.UTC(year + 1, 3, 15)).toISOString();
  const id = `fbar_${year}`;
  const { error } = await db.schema(scope).from("fbar_filing").upsert({
    id, reporting_year: year, aggregate_max_cents: aggregate,
    threshold_cents: FBAR_THRESHOLD_CENTS, required, due_at: dueAt,
    filed_at: filedBy ? new Date().toISOString() : null,
    filed_by: filedBy, bsa_efiling_ref: ref,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_timer`, "fbar.filing.timer", "fbar_filing", id, {
    due_at: dueAt, reporting_year: year, required,
    "fbar.aggregate": aggregate, "fbar.threshold": FBAR_THRESHOLD_CENTS,
  }, ctx);
  if (!required) {
    // A NIL determination is a result. Without it, "no FBAR filed" and "nobody
    // looked" are the same record.
    await emit(db, scope, `ev_${id}_nil`, "fbar.nil.determined", "fbar_filing", id, {
      "fbar.aggregate": aggregate, "fbar.threshold": FBAR_THRESHOLD_CENTS,
      reporting_year: year,
    }, ctx);
  }
  if (filedBy) {
    await emit(db, scope, `ev_${id}_filed`, "fbar.filed", "fbar_filing", id, {
      "fbar.efiling_ref": ref, filed_by: filedBy, "fbar.aggregate": aggregate,
    }, ctx);
  }
  return jsonResponse({ data: { id, required, aggregate_max_cents: aggregate } }, 201, requestId);
}

// --------------------------------------------- BSA-11 / BSA-19 inbound filings

/** POST /bsa/314a {reference, received_at?} */
export async function post314aRequest(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.reference)) {
    return validationError(requestId, [{
      type: "missing_field", field: "reference", message: "is required",
    }]);
  }
  const receivedAt = isNonEmptyString(body.received_at)
    ? new Date(body.received_at)
    : new Date();
  const id = `filing_314a_${body.reference}`;
  const { error } = await db.schema(scope).from("filing").upsert({
    id, kind: "fincen_314a", reference: body.reference,
    received_at: receivedAt.toISOString(),
    response_due_at: plusDays(receivedAt, FINCEN_314A_DAYS),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_recv`, "regulator.request.received", "filing", id, {
    kind: "fincen_314a", reference: body.reference,
    response_due_at: plusDays(receivedAt, FINCEN_314A_DAYS),
  }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/** POST /bsa/314a/:id/respond {match_count, responded_by} */
export async function post314aResponse(
  req: Request, filingId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: f } = await db.schema(scope).from("filing")
    .select("id, reference, response_due_at").eq("id", filingId).maybeSingle();
  if (!f) return notFoundResponse(requestId, "filing", filingId);

  const matches = typeof body.match_count === "number" ? body.match_count : NaN;
  if (!Number.isFinite(matches) || !isNonEmptyString(body.responded_by)) {
    // 314(a) requires a response even when there are NO matches. "No match" and
    // "did not search" are the same to FinCEN unless the negative is reported.
    return validationError(requestId, [{
      type: "missing_field", field: "match_count",
      message: "a 314(a) response requires a match count — including zero",
    }]);
  }
  const now = new Date();
  const { error } = await db.schema(scope).from("filing").update({
    searched_at: now.toISOString(), match_count: matches,
    responded_at: now.toISOString(), responded_by: body.responded_by,
  }).eq("id", filingId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${filingId}_resp`, "filing.fincen_314a", "filing", filingId, {
    reference: f.reference, "filing.match_count": matches,
    responded_by: body.responded_by,
    responded_late: now.toISOString() > String(f.response_due_at),
  }, ctx);
  return jsonResponse({ data: { id: filingId, match_count: matches } }, 200, requestId);
}

/** POST /bsa/regulatory-changes {kind, reference, issued_by, effective_at} */
export async function postRegulatoryChange(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const kinds = ["gto", "special_measure", "advisory", "rule_change"];
  if (!kinds.includes(String(body.kind)) || !isNonEmptyString(body.reference)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "kind",
      message: `kind in ${kinds.join("/")} and a reference are required`,
    }]);
  }
  const now = new Date();
  const id = `regchg_${body.reference}`;
  const { error } = await db.schema(scope).from("regulatory_change").upsert({
    id, kind: body.kind, reference: body.reference,
    issued_by: isNonEmptyString(body.issued_by) ? body.issued_by : "FinCEN",
    received_at: now.toISOString(),
    effective_at: isNonEmptyString(body.effective_at) ? body.effective_at : now.toISOString(),
    assessment_due_at: plusDays(now, REG_CHANGE_ASSESSMENT_DAYS),
    applicability: isNonEmptyString(body.applicability) ? body.applicability : null,
    assessed_at: isNonEmptyString(body.applicability) ? now.toISOString() : null,
    assessed_by: isNonEmptyString(body.assessed_by) ? body.assessed_by : null,
    controls_updated: Array.isArray(body.controls_updated) ? body.controls_updated : [],
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_ident`, "regulatory.change.identified",
    "regulatory_change", id, {
      kind: body.kind, reference: body.reference, issued_by: body.issued_by ?? "FinCEN",
    }, ctx);
  await emit(db, scope, `ev_${id}_req`, "regulatory.change_required", "regulatory_change", id, {
    kind: body.kind, reference: body.reference,
    assessment_due_at: plusDays(now, REG_CHANGE_ASSESSMENT_DAYS),
  }, ctx);
  // BSA-19: the assessment is a RECORD with its own retention clock — the
  // evidence that a GTO was considered outlives the GTO.
  await db.schema(scope).from("record").upsert({
    id: `rec_regchg_${body.reference}`, record_class: "regulatory_assessment",
    subject_ref: String(body.reference), retention_anchor: now.toISOString(),
    // NOT NULL on the live schema — the assessment anchors on its own creation
    retention_anchor_kind: "creation",
    retention_expires_at: plusDays(now, 365 * 5),
    legal_hold_flag: false, disposed_at: null,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  await emit(db, scope, `ev_${id}_rec`, "record.created", "record",
    `rec_regchg_${body.reference}`, {
      record_class: "regulatory_assessment", subject_ref: body.reference,
    }, ctx);
  if (isNonEmptyString(body.applicability)) {
    // An assessment that does not say whether it APPLIES has not been done.
    // Recording "not applicable" is as much a result as "applies".
    await emit(db, scope, `ev_${id}_assess`, "regulatory.change.assessed",
      "regulatory_change", id, {
        applicability: body.applicability,
        controls_updated: body.controls_updated ?? [],
      }, ctx);
    // "Assessed" and "implemented" are different facts. A change assessed as
    // APPLICABLE and never implemented is the gap; a change assessed as NOT
    // applicable is implemented by definition, and saying so closes it.
    await emit(db, scope, `ev_${id}_impl`, "regulatory.change_implemented",
      "regulatory_change", id, {
        applicability: body.applicability,
        controls_updated: body.controls_updated ?? [],
        implemented: Array.isArray(body.controls_updated) && body.controls_updated.length > 0
          ? true
          : String(body.applicability).startsWith("not applicable"),
      }, ctx);
  }
  return jsonResponse({ data: { id } }, 201, requestId);
}

// ------------------------------------------------------- BSA-14 escalation

/** POST /bsa/escalations {source_kind, source_ref, severity, routed_to} */
export async function postEscalation(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const sevs = ["routine", "elevated", "urgent"];
  if (!sevs.includes(String(body.severity)) || !isNonEmptyString(body.routed_to) ||
      !isNonEmptyString(body.source_ref)) {
    return validationError(requestId, [{
      type: "invalid_value", field: "severity",
      message: `severity in ${sevs.join("/")}, source_ref and routed_to are required`,
    }]);
  }
  const now = new Date();
  // Severity sets the acknowledgement window. One window for everything means
  // the urgent ones wait as long as the routine ones.
  const ackDays = body.severity === "urgent" ? ACK_DAYS_URGENT : ACK_DAYS_ROUTINE;
  const id = `esc_${crypto.randomUUID()}`;
  const { error } = await db.schema(scope).from("escalation").upsert({
    id,
    source_kind: isNonEmptyString(body.source_kind) ? body.source_kind : "bsa_alert",
    source_ref: body.source_ref, severity: body.severity,
    routed_to: body.routed_to, routed_at: now.toISOString(),
    ack_due_at: plusDays(now, ackDays),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${id}_routed`, "escalation.routed", "escalation", id, {
    "escalation.severity": body.severity, "escalation.routed_to": body.routed_to,
    ack_due_at: plusDays(now, ackDays),
  }, ctx);
  return jsonResponse({ data: { id, ack_due_at: plusDays(now, ackDays) } }, 201, requestId);
}

/** POST /bsa/escalations/:id/acknowledge {acknowledged_by, disposition?} */
export async function postEscalationAck(
  req: Request, escId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: e } = await db.schema(scope).from("escalation")
    .select("id, ack_due_at, severity, routed_to").eq("id", escId).maybeSingle();
  if (!e) return notFoundResponse(requestId, "escalation", escId);
  if (!isNonEmptyString(body.acknowledged_by)) {
    return validationError(requestId, [{
      type: "missing_field", field: "acknowledged_by", message: "is required",
    }]);
  }
  const now = new Date();
  const closing = isNonEmptyString(body.disposition);
  const { error } = await db.schema(scope).from("escalation").update({
    acknowledged_at: now.toISOString(), acknowledged_by: body.acknowledged_by,
    closed_at: closing ? now.toISOString() : null,
    disposition: closing ? body.disposition : null,
  }).eq("id", escId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${escId}_ack`, "escalation.acknowledged", "escalation", escId, {
    acknowledged_by: body.acknowledged_by,
    acknowledged_late: now.toISOString() > String(e.ack_due_at),
  }, ctx);
  if (closing) {
    await emit(db, scope, `ev_${escId}_closed`, "escalation.closed", "escalation", escId, {
      disposition: body.disposition,
    }, ctx);
    // BSA-14: closing an escalation publishes what will be DONE about it. A
    // disposition with no action plan closes the ticket, not the issue.
    await emit(db, scope, `ev_${escId}_plan`, "escalation.action_plan.published",
      "escalation", escId, {
        disposition: body.disposition,
        action_plan: body.action_plan ?? body.disposition,
      }, ctx);
  }
  return jsonResponse({ data: { id: escId, closed: closing } }, 200, requestId);
}


// ------------------------------------ BSA-03 CIP, BSA-10 Travel Rule, filings

/**
 * POST /bsa/cip {entity_ref, name, id_type, id_number, dob, address}
 *
 * BSA-03. CIP is four elements (name, DOB, address, identification number) and
 * an OFAC screen. A verification that collected three of the four is not a
 * partial CIP — it is a failed one, so the outcome is DENIED rather than
 * "completed with gaps".
 */
export async function postCipVerification(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.entity_ref) || !isNonEmptyString(body.name)) {
    return validationError(requestId, [{
      type: "missing_field", field: "entity_ref",
      message: "entity_ref and name are required",
    }]);
  }
  const now = new Date();
  const id = `cipv_${body.entity_ref}`;
  // The four CIP elements are stored on the ENTITY. Holding them only on the
  // verification would mean the member record cannot answer "who is this",
  // which is what every downstream control asks of it.
  // Only the elements SUPPLIED are written, and an existing member keeps its
  // status and owner: an upsert of every field (missing ones as null) let a
  // denied CIP wipe the member's date of birth and reset them to pending
  // (caught by the BSA-program partner-flow suite).
  const supplied: Record<string, unknown> = { name: body.name };
  if (isNonEmptyString(body.dob)) supplied.date_of_birth = body.dob;
  if (body.address != null) supplied.address = body.address;
  if (isNonEmptyString(body.tin)) supplied.tin = body.tin;
  const { data: existingEntity, error: entSelErr } = await db.schema(scope).from("entity")
    .select("id").eq("id", String(body.entity_ref)).maybeSingle();
  if (entSelErr) return internalErrorResponse(requestId, entSelErr.message);
  const { error: entErr } = existingEntity
    ? await db.schema(scope).from("entity").update(supplied).eq("id", String(body.entity_ref))
    : await db.schema(scope).from("entity").insert({
      id: String(body.entity_ref), type: "person", ...supplied,
      // no provenance: core.entity predates the column (evidence tables carry
      // it; the member record does not). partner_id IS on the member record
      // and is NOT NULL.
      status: "pending", partner_id: ctx.ownerPartnerId,
    });
  if (entErr) return internalErrorResponse(requestId, entErr.message);
  const elements = {
    name: isNonEmptyString(body.name),
    dob: isNonEmptyString(body.dob),
    address: isNonEmptyString(body.address),
    id_number: isNonEmptyString(body.id_number),
  };
  const missing = Object.entries(elements).filter(([, v]) => !v).map(([k]) => k);

  await emit(db, scope, `ev_${id}_created`, "verification.created", "verification", id, {
    "verification.entity_ref": body.entity_ref, elements_present: 4 - missing.length,
  }, ctx);

  // the OFAC screen is part of CIP, not a separate step someone might skip
  const verdict = ofacMatch(String(body.name));
  if (verdict === "clear") {
    await db.schema(scope).from("ofac_screen").upsert({
      id: `ofacs_entity_${body.entity_ref}`, subject_kind: "entity",
      subject_ref: body.entity_ref, screened_name: body.name, list_version: null,
      verdict, screened_at: now.toISOString(), hold_placed_at: null, escalated_at: null,
      provenance: provenanceFor(scope, ctx),
    }, { onConflict: "id" });
  } else {
    try {
      await placeOfacHold(db, scope, ctx, "entity", String(body.entity_ref), String(body.name), now);
    } catch (e) {
      return internalErrorResponse(requestId, e instanceof Error ? e.message : String(e));
    }
  }
  await emit(db, scope, `ev_${id}_ofac`,
    verdict === "clear" ? "ofac.cleared" : "ofac.hold.placed", "verification", id, {
      verdict, "ofac.list_version": null,
    }, ctx);

  if (missing.length > 0 || verdict !== "clear") {
    await emit(db, scope, `ev_${id}_denied`, "verification.denied", "verification", id, {
      missing_elements: missing, ofac_verdict: verdict,
    }, ctx);
    return apiError(409, "cip_incomplete", requestId, {
      title: "CIP not satisfied",
      detail: missing.length > 0
        ? `missing required elements: ${missing.join(", ")}`
        : "OFAC hold placed",
    });
  }
  // entity_id exists as of 20260727000100 and is written here directly. It
  // used to not, and the workaround was the deterministic id (cipv_<entity_ref>)
  // plus the event payload — because sending a phantom column fails the WHOLE
  // upsert (PGRST204), which is how BSA-03's evidence row silently never landed
  // live while every event still emitted. The id stays deterministic for
  // idempotency; the linkage no longer has to be decoded from it.
  // Checked for the same reason as the originator row: this IS the evidence.
  const { error: verErr } = await db.schema(scope).from("verification").upsert({
    id,
    entity_id: String(body.entity_ref),
    type: "cip_documentary",
    method: "documentary",
    result: "verified",
    provider: isNonEmptyString(body.provider) ? body.provider : "internal",
    provider_result: isNonEmptyString(body.provider_result) ? body.provider_result : "match",
    // BSA-03 declares both: WHETHER the identifying data matched, and how much
    // weight the result carries. A CIP that records only "verified" cannot
    // distinguish a documentary match from a thin non-documentary one.
    match_status: isNonEmptyString(body.match_status) ? body.match_status : "full_match",
    trust_level: isNonEmptyString(body.trust_level) ? body.trust_level : "high",
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (verErr) return internalErrorResponse(requestId, verErr.message);
  await emit(db, scope, `ev_${id}_done`, "verification.completed", "verification", id, {
    "verification.entity_ref": body.entity_ref, elements_present: 4,
    "entity.date_of_birth": body.dob, "entity.address": body.address,
    "entity.tin": body.tin ?? null, "verification.method": "documentary",
    "verification.result": "verified",
    "verification.type": "cip_documentary",
    "verification.provider_result": body.provider_result ?? "match",
    "verification.provider": body.provider ?? "internal",
  }, ctx);
  // BSA-04: CIP completing opens the CDD profile and the beneficial-owner
  // certification. A CDD profile that appears later, by a separate process, is
  // the gap 31 CFR 1010.230 exists to close.
  await db.schema(scope).from("cdd_profile").upsert({
    id: `cdd_${body.entity_ref}`, entity_id: body.entity_ref,
    risk_tier: isNonEmptyString(body.risk_tier) ? body.risk_tier : "low",
    last_refreshed_at: now.toISOString(),
    refresh_due_at: plusDays(now, 365 * 5),
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  await emit(db, scope, `ev_${id}_cdd`, "cdd.profile.created", "cdd_profile",
    `cdd_${body.entity_ref}`, {
      "cdd.entity_ref": body.entity_ref, "cdd.risk_tier": body.risk_tier ?? "low",
    }, ctx);
  await emit(db, scope, `ev_${id}_bo`, "cdd.bo.certified", "cdd_profile",
    `cdd_${body.entity_ref}`, {
      // a legal-entity customer certifies its beneficial owners; a natural
      // person has none, and saying so is the certification
      beneficial_owners: body.beneficial_owners ?? [],
      certified: true, entity_type: body.entity_type ?? "person",
    }, ctx);
  return jsonResponse({ data: { id, verified: true } }, 201, requestId);
}

/**
 * POST /bsa/travel-rule {wire_ref, amount_cents, originator, beneficiary}
 *
 * BSA-10 / 31 CFR 1010.410(f). At $3,000 and above the wire must carry
 * originator AND beneficiary records. This is the control BLUEPRINT §5a names
 * as reachable-but-not-implemented: the core could SAY `wire_transfer.submitted`
 * but kept none of the records. It keeps them now.
 */
export async function postTravelRuleRecord(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const claimed = typeof body.amount_cents === "number" ? body.amount_cents : NaN;
  if (!isNonEmptyString(body.wire_ref) || !Number.isFinite(claimed)) {
    return validationError(requestId, [{
      type: "missing_field", field: "wire_ref",
      message: "wire_ref and amount_cents are required",
    }]);
  }
  // The record attaches to a REAL wire at its REAL amount. Trusting the
  // caller's figure let $2,999 be claimed on a $5,000 wire to skip the
  // originator requirement, and kept records for wires that never existed
  // (caught by the BSA-program partner-flow suite).
  if (!isUuid(String(body.wire_ref))) return notFoundResponse(requestId, "wire_transfer", String(body.wire_ref));
  const { data: wire, error: wireErr } = await db.schema(scope).from("wire_transfer")
    .select("id, amount").eq("id", String(body.wire_ref)).maybeSingle();
  if (wireErr) return internalErrorResponse(requestId, wireErr.message);
  if (!wire) return notFoundResponse(requestId, "wire_transfer", String(body.wire_ref));
  const amount = Number((wire as Any).amount);
  if (claimed !== amount) {
    return apiError(409, "travel_rule_amount_mismatch", requestId, {
      title: "Amount does not match the wire",
      detail: `wire ${body.wire_ref} is for ${amount}; the record claimed ${claimed}`,
    });
  }
  const attaches = amount >= TRAVEL_RULE_FLOOR_CENTS;
  const orig = (body.originator ?? null) as Record<string, unknown> | null;
  const bene = (body.beneficiary ?? null) as Record<string, unknown> | null;
  const complete = !attaches || (
    orig !== null && bene !== null &&
    isNonEmptyString(orig.name) && isNonEmptyString(orig.address) &&
    isNonEmptyString(bene.name)
  );

  await emit(db, scope, `ev_tr_${body.wire_ref}_created`, "wire_transfer.created",
    "wire_transfer", String(body.wire_ref), {
      "wire_transfer.amount": amount, travel_rule_attaches: attaches,
    }, ctx);

  if (!complete) {
    // Refusing is the control. A wire above the threshold with no originator
    // record is exactly what the Travel Rule exists to prevent.
    await emit(db, scope, `ev_tr_${body.wire_ref}_gap`, "wire_transfer.record.missing",
      "wire_transfer", String(body.wire_ref), {
        originator_present: orig !== null, beneficiary_present: bene !== null,
      }, ctx);
    return apiError(409, "travel_rule_incomplete", requestId, {
      title: "Travel Rule records incomplete",
      detail: "a wire at or above $3,000 requires originator and beneficiary records",
    });
  }
  // `core.originator` is another of the 22 abandoned tables. The Travel Rule
  // record has to be a ROW, not a payload: 31 CFR 1010.410(f) requires it be
  // RETAINED for five years and retrievable, which an event payload is not.
  // Checked, not fire-and-forget: this row IS the retained record. A wire
  // whose retention write fails but whose events emit anyway would read as
  // retained on every dashboard while nothing is retrievable in five years.
  const { error: retainErr } = await db.schema(scope).from("originator").upsert({
    id: `orig_${body.wire_ref}`,
    name: orig?.name ?? null, address: orig?.address ?? null,
    reference: orig?.account ?? orig?.reference ?? null,
    routing_number: orig?.routing_number ?? null,
    beneficiary_name: bene?.name ?? null,
    beneficiary_reference: bene?.account ?? null,
    wire_ref: body.wire_ref, amount_cents: amount,
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id" });
  if (retainErr) return internalErrorResponse(requestId, retainErr.message);
  await emit(db, scope, `ev_tr_${body.wire_ref}_ret`, "wire_transfer.record.retained",
    "wire_transfer", String(body.wire_ref), {
      "wire_transfer.originator": orig, "wire_transfer.beneficiary": bene,
      "wire_transfer.amount": amount,
    }, ctx);
  return jsonResponse({ data: { wire_ref: body.wire_ref, retained: true } }, 201, requestId);
}

/** POST /bsa/cmir/:id/file {filed_by, fincen_ref} — BSA-12. */
export async function postCmirFiling(
  req: Request, cmirId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const { data: c } = await db.schema(scope).from("cmir_filing")
    .select("id, amount_cents, identified_at, shipment_id").eq("id", cmirId).maybeSingle();
  if (!c) return notFoundResponse(requestId, "cmir_filing", cmirId);
  if (!isNonEmptyString(body.filed_by) || !isNonEmptyString(body.fincen_ref)) {
    return validationError(requestId, [{
      type: "missing_field", field: "fincen_ref",
      message: "a filing with no FinCEN reference cannot be evidenced",
    }]);
  }
  const now = new Date();
  // FinCEN Form 105 is due at the time of the crossing; the clock is on the
  // identification, which is when the institution knew.
  const dueAt = plusDays(new Date(String(c.identified_at)), 15);
  const { error } = await db.schema(scope).from("cmir_filing").update({
    filed_at: now.toISOString(), filed_by: body.filed_by, fincen_ref: body.fincen_ref,
  }).eq("id", cmirId);
  if (error) return internalErrorResponse(requestId, error.message);

  await emit(db, scope, `ev_${cmirId}_timer`, "cmir.filing.timer", "cmir_filing", cmirId, {
    due_at: dueAt, "cmir.amount": c.amount_cents,
  }, ctx);
  await emit(db, scope, `ev_${cmirId}_filed`, "cmir.filed", "cmir_filing", cmirId, {
    "cmir.fincen_ref": body.fincen_ref, filed_by: body.filed_by,
    filed_late: now.toISOString() > dueAt,
  }, ctx);
  return jsonResponse({ data: { id: cmirId, filed: true } }, 200, requestId);
}

/**
 * POST /bsa/sar/:caseId/lifecycle
 * {stage, filed_by?, fincen_ref?, requester?}
 *
 * BSA-07. Three facts the case machinery did not record: the 30-day filing
 * TIMER, a CONTINUING-activity filing at 120 days, and a refusal to disclose
 * the SAR's existence. The last is a control in the opposite direction from
 * everything else here — the obligation is to NOT tell someone.
 */
export async function postSarLifecycle(
  req: Request, caseId: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  // The case must exist: timers, continuing filings and disclosure refusals
  // were recorded against any id at all (caught by the BSA-program flow suite).
  const { data: sarCase, error: caseErr } = await db.schema(scope).from("case")
    .select("id").eq("id", caseId).maybeSingle();
  if (caseErr) return internalErrorResponse(requestId, caseErr.message);
  if (!sarCase) return notFoundResponse(requestId, "case", caseId);

  const now = new Date();
  const stage = String(body.stage ?? "timer");

  if (stage === "timer") {
    await emit(db, scope, `ev_sar_${caseId}_timer`, "sar.filing.timer", "case", caseId, {
      due_at: plusDays(now, 30), "sar.case_id": caseId,
    }, ctx);
    await emit(db, scope, `ev_sar_${caseId}_conttimer`, "sar.continuing_timer",
      "case", caseId, { due_at: plusDays(now, 120), "sar.case_id": caseId }, ctx);
    return jsonResponse({ data: { case_id: caseId, stage } }, 200, requestId);
  }

  if (stage === "continuing") {
    if (!isNonEmptyString(body.fincen_ref) || !isNonEmptyString(body.filed_by)) {
      return validationError(requestId, [{
        type: "missing_field", field: "fincen_ref",
        message: "a continuing SAR filing needs its FinCEN reference",
      }]);
    }
    await emit(db, scope, `ev_sar_${caseId}_cont`, "sar.continuing.filed", "case", caseId, {
      "sar.fincen_ref": body.fincen_ref, filed_by: body.filed_by,
    }, ctx);
    return jsonResponse({ data: { case_id: caseId, stage } }, 200, requestId);
  }

  if (stage === "disclosure_request") {
    // 31 CFR 1020.320(e): SAR confidentiality. The request is logged and
    // DECLINED — recording the refusal is the evidence that the obligation was
    // honoured, and a request that leaves no trace cannot demonstrate that.
    if (!isNonEmptyString(body.requester)) {
      return validationError(requestId, [{
        type: "missing_field", field: "requester", message: "is required",
      }]);
    }
    await emit(db, scope, `ev_sar_${caseId}_discreq`, "sar.disclosure_request.received",
      "case", caseId, { requester: body.requester }, ctx);
    await emit(db, scope, `ev_sar_${caseId}_discdec`, "sar.disclosure.declined",
      "case", caseId, {
        requester: body.requester,
        basis: "31 CFR 1020.320(e) — SAR confidentiality",
      }, ctx);
    return jsonResponse({ data: { case_id: caseId, declined: true } }, 200, requestId);
  }

  return validationError(requestId, [{
    type: "invalid_value", field: "stage",
    message: "stage must be timer, continuing or disclosure_request",
  }]);
}

/** POST /bsa/ctr/exemptions/review {entity_ref, decision, reviewed_by} — BSA-08. */
export async function postCtrExemptionReview(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  if (!isNonEmptyString(body.entity_ref) || !isNonEmptyString(body.reviewed_by)) {
    return validationError(requestId, [{
      type: "missing_field", field: "entity_ref",
      message: "entity_ref and reviewed_by are required",
    }]);
  }
  const id = `ctrex_${body.entity_ref}`;
  await emit(db, scope, `ev_${id}_rev`, "ctr.exemption.reviewed", "entity",
    String(body.entity_ref), {
      decision: body.decision ?? "retained", reviewed_by: body.reviewed_by,
      // an exemption retained without re-verifying eligibility is the failure
      // this annual review exists to catch
      eligibility_reverified: body.eligibility_reverified === true,
    }, ctx);
  return jsonResponse({ data: { id } }, 201, requestId);
}

/** POST /bsa/ofac/annual-report {reporting_year, filed_by, blocked_count} — BSA-05. */
export async function postOfacAnnualReport(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};

  const year = typeof body.reporting_year === "number" ? body.reporting_year : NaN;
  if (!Number.isFinite(year) || !isNonEmptyString(body.filed_by)) {
    return validationError(requestId, [{
      type: "missing_field", field: "reporting_year",
      message: "reporting_year and filed_by are required",
    }]);
  }
  // The counts are COUNTED from the screen register, not supplied — and for
  // THIS reporting year: property blocked as of June 30 (31 CFR 501.603), and
  // holds released during the year. Counting the whole register put every
  // hold ever placed into every year's report (caught by the flow suite).
  const asOf = new Date(Date.UTC(year, 5, 30, 23, 59, 59, 999));
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
  const { data: screens, error: scrErr } = await db.schema(scope).from("ofac_screen")
    .select("id, verdict, hold_placed_at, hold_released_at")
    // `lt` also drops rows with no hold (NULL never compares)
    .lt("hold_placed_at", yearEnd.toISOString());
  if (scrErr) return internalErrorResponse(requestId, scrErr.message);
  const at = (v: unknown) => new Date(String(v));
  const held = (screens ?? []).filter((s: Any) =>
    at(s.hold_placed_at) <= asOf && (!s.hold_released_at || at(s.hold_released_at) > asOf));
  const rejected = (screens ?? []).filter((s: Any) =>
    s.hold_released_at && at(s.hold_released_at) >= yearStart && at(s.hold_released_at) < yearEnd);

  const id = `ofacann_${year}`;
  await emit(db, scope, `ev_${id}_blocked`, "ofac.blocked", "ofac_screen", id, {
    reporting_year: year, blocked_count: held.length,
  }, ctx);
  await emit(db, scope, `ev_${id}_rejected`, "ofac.rejected", "ofac_screen", id, {
    reporting_year: year, rejected_count: rejected.length,
  }, ctx);
  await emit(db, scope, `ev_${id}_filed`, "ofac.annual_report.filed", "ofac_screen", id, {
    reporting_year: year, filed_by: body.filed_by,
    blocked_count: held.length, rejected_count: rejected.length,
    // the report says WHAT LIST it screened against. It is null, and the
    // report saying so is the point.
    "ofac.list_version": null,
  }, ctx);
  return jsonResponse({ data: { id, blocked: held.length } }, 201, requestId);
}
