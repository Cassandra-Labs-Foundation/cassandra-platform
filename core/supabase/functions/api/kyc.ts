// KYC (cards 39-42): one adapter, several providers, an OFAC floor under all
// of them.
//
// The adapter is the seam (card 42): every provider — real or simulated —
// answers the same question the same way, so swapping providers never touches
// the verification flow. In the demo slice all three are deterministic sims.
//
// OFAC is a FLOOR control (card 41): it runs on every path and its verdict
// cannot be overridden — not by a full-trust partner attestation, not by a
// forced simulation outcome, not by provider choice. Every run leaves a
// CG-OFAC-01 control_result even on a clean pass: a screen that leaves no
// evidence is indistinguishable from a screen that never ran.
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
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
import { scopeToPartner } from "./ownership.ts";
import { provenanceFor, raiseAlert } from "./bsa.ts";
import { startRetentionFor } from "./retention.ts";
import { type PartnerContext } from "./auth.ts";

interface KycDecision {
  decision: "approved" | "denied";
  raw: Record<string, unknown>;
}

type Provider = (entityName: string, simulate: string | null) => KycDecision;

// Card 40: sims force outcomes. Absent a forced outcome the sims approve —
// the interesting denials in the demo come from the OFAC floor below.
const simProvider = (name: string): Provider => (_entityName, simulate) => ({
  decision: simulate === "deny" ? "denied" : "approved",
  raw: { provider: name, simulated: simulate ?? "default" },
});

const PROVIDERS: Record<string, Provider> = {
  alloy: simProvider("alloy"),
  socure: simProvider("socure"),
  middesk: simProvider("middesk"),
};
const DEFAULT_PROVIDER = "alloy";
const TRUST_LEVELS = ["full", "partial", "none"];

// Sandbox OFAC list: any entity whose name carries the SDN test marker hits.
function ofacScreen(entityName: string): "clear" | "hit" {
  return /\bSDN\b/i.test(entityName) ? "hit" : "clear";
}

/** POST /entities/{id}/verifications — run KYC through the adapter. */
export async function postVerification(
  req: Request,
  entityId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const raw = await parseJsonBody(req).catch(() => null);
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};

  const errors: ValidationErrorItem[] = [];
  const provider = isNonEmptyString(body.provider) ? body.provider : DEFAULT_PROVIDER;
  if (!(provider in PROVIDERS)) {
    errors.push({
      type: "invalid_value",
      field: "provider",
      message: `must be one of: ${Object.keys(PROVIDERS).join(", ")}`,
    });
  }
  const simulate = isNonEmptyString(body.simulate) ? body.simulate : null;
  if (simulate !== null && simulate !== "approve" && simulate !== "deny") {
    errors.push({ type: "invalid_value", field: "simulate", message: 'must be "approve" or "deny"' });
  }
  const attestation = body.attestation && typeof body.attestation === "object"
    ? body.attestation as Record<string, unknown>
    : null;
  let trustLevel: string | null = null;
  if (attestation) {
    if (!isNonEmptyString(attestation.trust_level) || !TRUST_LEVELS.includes(attestation.trust_level)) {
      errors.push({
        type: "invalid_value",
        field: "attestation.trust_level",
        message: `must be one of: ${TRUST_LEVELS.join(", ")}`,
      });
    } else {
      trustLevel = attestation.trust_level;
    }
  }
  if (errors.length) return validationError(requestId, errors);

  const { data: ent, error: selErr } = await scopeToPartner(
    db.schema("core").from("entity").select("id, type, name, status").eq("id", entityId),
    ctx,
  ).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!ent) return notFoundResponse(requestId, "entity", entityId);
  const entity = ent as Record<string, unknown>;

  // ---- the OFAC floor: first, always, and decisive ----
  const ofac = ofacScreen(String(entity.name ?? ""));
  const verificationId = `ver_${crypto.randomUUID()}`;
  const entityHash = await sha256Hex(entityId);

  // BSA-21: a CIP verification record retains 5 years from when it was MADE,
  // and an OFAC screen result retains 10 years. Hooked here because this is
  // the point the record comes into existence.
  try {
    await startRetentionFor(db, "cip_verification", verificationId, new Date(), "core", ctx);
    await startRetentionFor(db, "ofac_blocked", verificationId, new Date(), "core", ctx);
  } catch (retErr) {
    console.error(`verification retention clock failed: ${retErr}`);
  }

  const { error: crErr } = await db.schema("core").from("control_result").insert({
    id: `cr_${crypto.randomUUID()}`,
    // the only control_result writer that omitted this: OFAC evidence landed
    // as `unknown` for every caller, so it could never support a coverage claim
    provenance: provenanceFor("core", ctx),
    control_id: "CG-OFAC-01",
    decision: ofac === "hit" ? "reject" : "pass",
    event: verificationId,
    subject_ref: entityId,
  });
  if (crErr) return internalErrorResponse(requestId, crErr);

  let status: "approved" | "denied";
  let providerRaw: Record<string, unknown>;
  if (ofac === "hit") {
    status = "denied";
    providerRaw = { skipped: "ofac floor denied before provider ran" };
    await raiseAlert(db, {
      ctx,
      alertType: "ofac",
      entityHash,
      causeType: "verification",
      causeId: verificationId,
      details: `OFAC hit during verification (entity=${entityId}, verification=${verificationId})`,
    });
  } else if (trustLevel === "full") {
    // full-trust partner attestation stands in for a provider run — but never
    // for the screen above
    status = "approved";
    providerRaw = { attested_by: attestation?.partner ?? null, trust_level: trustLevel };
  } else {
    const run = PROVIDERS[provider](String(entity.name ?? ""), simulate);
    status = run.decision;
    providerRaw = run.raw;
  }

  const row: Record<string, unknown> = {
    id: verificationId,
    // WHO was verified. The 201 below has always returned this field; until
    // 20260727000100 there was no column to put it in, so the handler told the
    // caller which member it verified and then forgot. 179 rows had to be
    // recovered from event payloads to answer a question this row should have
    // answered itself.
    entity_id: entityId,
    type: "kyc",
    provider,
    provider_result: JSON.stringify(providerRaw),
    status,
    trust_level: trustLevel,
    ofac_result: ofac,
    match_status: ofac === "hit" ? "match" : "no_match",
  };
  const { error: insErr } = await db.schema("core").from("verification").insert(row);
  if (insErr) return internalErrorResponse(requestId, insErr);

  const { error: evtErr } = await db.schema("core").from("event").insert({
    id: `evt_${crypto.randomUUID()}`,
    code: `verification.${status}`,
    type: "verification",
    resource_id: verificationId,
    entity_hash: entityHash,
    payload: { entity_id: entityId, provider, ofac_result: ofac, trust_level: trustLevel },
    created_at: new Date().toISOString(),
  });
  if (evtErr) console.error(`event emit failed (verification.${status}): ${evtErr.message}`);

  return jsonResponse({
    id: verificationId,
    entity_id: entityId,
    type: "kyc",
    provider,
    status,
    trust_level: trustLevel,
    ofac_result: ofac,
    created_at: new Date().toISOString(),
  }, 201, requestId);
}

// ---------------------------------------------------------------- reads

/**
 * What a verification read serves.
 *
 * `provider_result` is deliberately NOT here. It is the raw provider payload —
 * for a full-trust attestation it carries the attesting partner, and for a live
 * run whatever the vendor returned. Member Services needs the DECISION and the
 * OFAC outcome, not the vendor's body, and a projection that widens by accident
 * is how third-party PII leaves a system.
 */
const VERIFICATION_READ_COLS =
  "id, entity_id, type, status, method, result, provider, ofac_result, " +
  "match_status, trust_level, expires_at, provenance, created_at";

/**
 * GET /entities/{id}/verifications
 *
 * core.verification has no partner_id, so it cannot be scoped directly. It is
 * scoped through the ENTITY instead: the caller must be able to see the member
 * before it can see what was run against them, and a partner who cannot see the
 * entity gets the entity's own 404 rather than an empty list. An empty list
 * would say "this member has never been verified", which is a different and
 * much worse claim than "no such member here".
 */
export async function getEntityVerifications(
  _req: Request,
  entityId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const { data: entity, error: entErr } = await scopeToPartner(
    db.schema("core").from("entity").select("id").eq("id", entityId),
    ctx,
  ).maybeSingle();
  if (entErr) return internalErrorResponse(requestId, entErr);
  if (!entity) return notFoundResponse(requestId, "entity", entityId);

  const { data, error } = await db.schema("core").from("verification")
    .select(VERIFICATION_READ_COLS)
    .eq("entity_id", entityId)
    .order("created_at", { ascending: false });
  if (error) return internalErrorResponse(requestId, error);

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  return jsonResponse({
    entity_id: entityId,
    verifications: rows,
    count: rows.length,
    // Says the quiet part out loud. 171 verification rows predate the entity_id
    // column (20260727000100) and could not be attributed to anyone: 170
    // estate_claimant rows verify a CLAIMANT rather than the member, and one
    // cip_documentary row points at an entity that does not exist. None of them
    // can appear in any member's list, so an empty or short list here is not
    // proof that nothing was run — and a compliance reader must not read it as
    // proof.
    unattributable_note:
      "verifications recorded before 20260727000100 may have no entity linkage " +
      "and cannot appear here",
  }, 200, requestId);
}
