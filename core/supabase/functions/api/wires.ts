import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type AccountRow } from "./accounts.ts";
import { attachControlResults, type GateResource, recordMovementArtifacts, runGate } from "./transfers.ts";
import {
  type BlnkConfig,
  BlnkError,
  commitInflight,
  recordTransaction,
  transactionMirror,
  voidInflight,
} from "../_shared/blnk.ts";
import {
  apiError,
  bankErrorResponse,
  claimIdempotency,
  internalErrorResponse,
  isNonEmptyString,
  isUuid,
  jsonResponse,
  notFoundResponse,
  pageEnvelope,
  paginate,
  parseJsonBody,
  parsePageParams,
  sha256Hex,
  storeIdempotencyResponse,
  validationError,
  type ValidationErrorItem,
  idempotencyInProgressResponse,
} from "./lib.ts";
import { scopeToPartner } from "./ownership.ts";
import { DUAL_CONTROL_STATUSES, openApproval, wireDualControl } from "./eps.ts";
import { provenanceFor } from "./bsa.ts";
import { startRetentionFor } from "./retention.ts";
import { type PartnerContext } from "./auth.ts";

// Outbound wires leave the customer balance for the Fed settlement rail. Blnk
// auto-creates `@`-prefixed external balances on first reference, so there is
// nothing to provision here (integration plan §3).
const FEDWIRE_BALANCE = "@FedWire";

// core.account carries no currency column; the demo slice is USD-only, matching
// accounts.ts / transfers.ts.
const CURRENCY = "USD";

// This core is domestic-only (Fedwire). An international beneficiary is refused
// at the edge rather than held and failed downstream: placing an inflight hold
// for a wire that can never be sent strands the customer's funds until someone
// notices. Detected by the markers an international instruction actually
// carries — a SWIFT/BIC routing code, or a non-US beneficiary country.
function internationalMarker(beneficiary: Record<string, unknown>): string | null {
  if (isNonEmptyString(beneficiary.swift_code)) return "beneficiary.swift_code";
  if (isNonEmptyString(beneficiary.bic)) return "beneficiary.bic";
  const country = beneficiary.country;
  if (isNonEmptyString(country) && country.trim().toUpperCase() !== "US") {
    return `beneficiary.country=${country}`;
  }
  return null;
}

const WIRE_RESOURCE = (id: string): GateResource => ({
  table: "wire_transfer",
  type: "wire_transfer",
  id,
  label: "outbound wire",
  rejectedStatus: "rejected",
});

export interface WireRow {
  id: string;
  amount: number;
  status: string;
  beneficiary: unknown;
  purpose: string | null;
  imad: string | null;
  originator?: { account_id?: string } | null;
  return_reason?: string | null;
  blnk_transaction_id: string | null;
  blnk_reference: string | null;
  created_at: string;
}

function wireResponse(
  row: WireRow,
  controlResults?: { control_id: string; decision: string }[],
): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    amount_cents: row.amount,
    beneficiary: row.beneficiary,
    purpose: row.purpose,
    imad: row.imad,
    return_reason: row.return_reason ?? null,
    blnk_transaction_id: row.blnk_transaction_id,
    control_results: controlResults ?? [],
    created_at: row.created_at,
  };
}

/**
 * POST /payments/wire/prepare
 *
 * Phase 1 of the two-phase wire. Creates the `core.wire_transfer` row and an
 * *inflight* Blnk transaction, which holds the funds in the customer's
 * `inflight_debit_balance` without moving them. Money only actually moves on
 * confirm — this is what satisfies the dual-control requirement (integration
 * plan §4): the funds cannot leave until a second call commits them.
 */
export async function postWirePrepare(
  req: Request,
  db: SupabaseClient,
  cfg: BlnkConfig,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const idempotencyKey = req.headers.get("Idempotency-Key");
  if (!idempotencyKey) {
    return apiError(400, "idempotency_key_required", requestId, {
      title: "Idempotency Key Required",
      detail: "POST /payments/wire/prepare requires an Idempotency-Key header",
    });
  }

  const body = await parseJsonBody(req);
  if (body === null || typeof body !== "object") {
    return validationError(requestId, [
      { type: "invalid_value", field: "body", message: "must be a JSON object" },
    ]);
  }
  const b = body as Record<string, unknown>;
  const sourceAccountId = b.source_account_id;
  const amountCents = b.amount_cents;
  const beneficiary = b.beneficiary;
  const purpose = b.purpose;

  const errors: ValidationErrorItem[] = [];
  if (!isNonEmptyString(sourceAccountId)) {
    errors.push({ type: "missing_field", field: "source_account_id", message: "is required" });
  }
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) {
    errors.push({
      type: "invalid_value",
      field: "amount_cents",
      message: "must be a positive integer number of cents",
    });
  }
  if (beneficiary === null || typeof beneficiary !== "object" || Array.isArray(beneficiary)) {
    errors.push({ type: "invalid_value", field: "beneficiary", message: "must be an object" });
  }
  if (purpose !== undefined && typeof purpose !== "string") {
    errors.push({ type: "invalid_value", field: "purpose", message: "must be a string" });
  }
  if (errors.length) return validationError(requestId, errors);

  const amount = amountCents as number;
  const sourceId = sourceAccountId as string;
  const purposeText = typeof purpose === "string" ? purpose : null;

  // Refuse before the idempotency claim: an unsendable wire should not consume
  // a key or create a row.
  const marker = internationalMarker(beneficiary as Record<string, unknown>);
  if (marker) {
    return apiError(422, "international_wire_not_supported", requestId, {
      title: "International Wire Not Supported",
      detail: `this core sends domestic (Fedwire) wires only; saw ${marker}`,
    });
  }

  const requestHash = await sha256Hex(
    JSON.stringify({
      source_account_id: sourceId,
      amount_cents: amount,
      beneficiary,
      purpose: purposeText,
    }),
  );

  const freshWireId = crypto.randomUUID();
  const claim = await claimIdempotency(
    db, ctx.idempotencyScope,
    idempotencyKey,
    requestHash,
    freshWireId,
    "POST /payments/wire/prepare",
  );

  if (claim.kind === "replay") {
    return jsonResponse(claim.responseBody, claim.responseStatus, requestId, {
      "Idempotent-Replayed": "true",
    });
  }
  if (claim.kind === "in_progress") return idempotencyInProgressResponse(requestId);
  if (claim.kind === "conflict") {
    return apiError(409, "idempotency_key_reused", requestId, {
      title: "Idempotency Key Reused",
      detail: "Idempotency-Key was used with a different request body",
    });
  }

  // A resumed claim reuses the id from the interrupted attempt so the Blnk
  // `reference` stays stable and we cannot double-hold the same funds.
  const wireId = claim.kind === "resume" ? claim.transferId : freshWireId;

  const { data: account, error: acctErr } = await db.schema("core").from("account")
    .select("id, account_type, balance, blnk_ledger_id, blnk_balance_id, balance_synced_at, lock_type, status, created_at")
    .eq("id", sourceId)
    .maybeSingle();
  if (acctErr) return internalErrorResponse(requestId, acctErr);
  if (!account) return notFoundResponse(requestId, "account", sourceId);
  if (!account.blnk_balance_id) {
    return apiError(409, "account_not_provisioned", requestId, {
      title: "Account Not Provisioned",
      detail: "source account has no Blnk balance yet",
    });
  }

  const { error: insErr } = await db.schema("core").from("wire_transfer").upsert({
    id: wireId,
    amount,
    // records whose money is leaving: needed for audit and for the per-account
    // daily velocity aggregate, which spans rails.
    originator: { account_id: sourceId },
    beneficiary,
    purpose: purposeText,
    status: "pending_approval",
    partner_id: ctx.ownerPartnerId,
    // EPS-06: wire dual control is REQUIRED, unconditionally. Recorded on the
    // row at creation so a wire can never reach `completed` without it — see
    // ck_wire_dual_control_before_complete.
    dual_control_status: "required",
    created_by: ctx.tokenId,
  });
  if (insErr) return internalErrorResponse(requestId, insErr);

  // Compliance gate runs BEFORE any money is held. A wire is a money-movement
  // path like any other: CTR reporting, NSF and the velocity cap all apply, and
  // a rail that skips them would let a large wire settle with no BSA alert.
  // A wire has no destination account row (funds leave for @FedWire), hence null.
  let gate;
  try {
    gate = await runGate(db, cfg, WIRE_RESOURCE(wireId), account as AccountRow, null, amount, ctx);
  } catch (err) {
    return internalErrorResponse(requestId, err);
  }
  if (gate.blocked) {
    await storeIdempotencyResponse(db, ctx.idempotencyScope, idempotencyKey, gate.status, gate.body);
    return jsonResponse(gate.body, gate.status, requestId);
  }

  let mirror;
  try {
    const result = await recordTransaction(cfg, {
      coreResource: { table: "wire_transfer", id: wireId },
      amountCents: amount,
      currency: CURRENCY,
      source: account.blnk_balance_id,
      destination: FEDWIRE_BALANCE,
      description: purposeText ?? "outbound wire",
      inflight: true,
    });
    mirror = result.mirror;
  } catch (err) {
    // Leave the row in pending_approval with no Blnk id; the reconciler's
    // non-terminal sweep will retry or surface it. 502 is not stored against
    // the idempotency claim, so the caller can safely retry the same key.
    if (err instanceof BlnkError) return bankErrorResponse(requestId);
    return internalErrorResponse(requestId, err);
  }

  const { data: updated, error: updErr } = await db.schema("core").from("wire_transfer")
    .update({
      status: "submitted",
      blnk_transaction_id: mirror.blnk_transaction_id,
      blnk_reference: mirror.blnk_reference,
      synced_at: mirror.synced_at,
    })
    .eq("id", wireId)
    .select("id, amount, status, beneficiary, purpose, imad, dual_control_status, created_by, blnk_transaction_id, blnk_reference, created_at")
    .single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  // The maker-checker record. Opened here rather than at confirm so the
  // originator is captured at the moment they originated, not inferred later.
  try {
    await openApproval(db, {
      resourceType: "wire_transfer",
      resourceId: wireId,
      createdBy: ctx.tokenId,
      decision: wireDualControl(),
      ctx,
    });
  } catch (apprErr) {
    console.error(`wire approval record failed for ${wireId}: ${apprErr}`);
  }

  // EPS-06's second declared trigger, same reasoning as ach_transfer.created.
  try {
    await db.schema("core").from("event").upsert({
      id: `evt_${wireId}_submitted`,
      code: "wire_transfer.submitted",
      resource_type: "wire_transfer",
      resource_id: `wire_transfer:${wireId}`,
      payload: {
        amount_cents: amount,
        dual_control_status: "required",
        created_by: ctx.tokenId,
      },
      provenance: provenanceFor("core", ctx),
    }, { onConflict: "id", ignoreDuplicates: true });
  } catch (evtErr) {
    console.error(`wire_transfer.submitted event failed for ${wireId}: ${evtErr}`);
  }

  // BSA-21: wire transfer records retain 5 years from when the record was made.
  try {
    await startRetentionFor(db, "wire_transfer", wireId, new Date(), "core", ctx);
  } catch (e) {
    console.error(`wire retention clock failed for ${wireId}: ${e}`);
  }

  const responseBody = wireResponse(updated as WireRow, gate.controlResults);
  await storeIdempotencyResponse(db, ctx.idempotencyScope, idempotencyKey, 201, responseBody);
  return jsonResponse(responseBody, 201, requestId);
}

/**
 * POST /payments/wire/{id}/confirm — commit the inflight hold. Blnk permits a
 * partial commit (up to the held amount), so an optional `amount_cents` lets a
 * wire settle for less than it was prepared for.
 */
export async function postWireConfirm(
  req: Request,
  wireId: string,
  db: SupabaseClient,
  cfg: BlnkConfig,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  return await resolveInflight(req, wireId, db, cfg, requestId, ctx, "confirm");
}

/** POST /payments/wire/{id}/cancel — void the hold and release the funds. */
export async function postWireCancel(
  req: Request,
  wireId: string,
  db: SupabaseClient,
  cfg: BlnkConfig,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  return await resolveInflight(req, wireId, db, cfg, requestId, ctx, "cancel");
}

async function resolveInflight(
  req: Request,
  wireId: string,
  db: SupabaseClient,
  cfg: BlnkConfig,
  requestId: string,
  ctx: PartnerContext,
  action: "confirm" | "cancel",
): Promise<Response> {
  const { data: wire, error: selErr } = await scopeToPartner(
    db.schema("core").from("wire_transfer")
      // dual_control_status is load-bearing: the EPS-06 check below reads it,
      // and PostgREST returns only listed columns. Omitting it made the check
      // read undefined — an unconfirmable wire, approved or not. The fake
      // returns whole rows regardless of select list, so only live traffic
      // could catch this.
      .select("id, amount, status, beneficiary, purpose, imad, originator, dual_control_status, blnk_transaction_id, blnk_reference, created_at")
      .eq("id", wireId),
    ctx,
  ).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!wire) return notFoundResponse(requestId, "wire_transfer", wireId);

  // Only a submitted (held) wire can be resolved. Re-confirming a completed
  // wire is a no-op replay rather than an error, so retries stay safe.
  if (wire.status === (action === "confirm" ? "completed" : "canceled")) {
    return jsonResponse(wireResponse(wire as WireRow), 200, requestId, {
      "Idempotent-Replayed": "true",
    });
  }
  if (wire.status !== "submitted") {
    return apiError(409, "invalid_state", requestId, {
      title: "Invalid State",
      detail: `wire_transfer ${wireId} is ${wire.status}; only 'submitted' can be ${action}ed`,
    });
  }
  if (!wire.blnk_transaction_id) {
    return apiError(409, "not_held", requestId, {
      title: "Not Held",
      detail: "wire has no inflight Blnk transaction to resolve",
    });
  }

  // EPS-06. The prepare/confirm split was two CALLS, not two PEOPLE — anyone
  // holding a token could prepare and immediately confirm. A wire may only be
  // confirmed once a DIFFERENT actor has approved it.
  if (action === "confirm") {
    const dcs = (wire as Record<string, unknown>).dual_control_status;
    if (dcs === "rejected") {
      return apiError(409, "dual_control_rejected", requestId, {
        title: "Dual Control Rejected",
        detail: `wire ${wireId} was rejected by its second approver and cannot be confirmed`,
      });
    }
    if (dcs !== "approved" && dcs !== "not_required") {
      return apiError(409, "dual_control_required", requestId, {
        title: "Dual Control Required",
        detail:
          `wire ${wireId} needs a second approver before it can be confirmed ` +
          `(EPS-06); POST /payments/wire/${wireId}/approve as a different actor`,
      });
    }
  }

  let partialCents: number | undefined;
  if (action === "confirm") {
    const body = await parseJsonBody(req).catch(() => null);
    const raw = body && typeof body === "object"
      ? (body as Record<string, unknown>).amount_cents
      : undefined;
    if (raw !== undefined) {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > wire.amount) {
        return validationError(requestId, [{
          type: "invalid_value",
          field: "amount_cents",
          message: `must be a positive integer no greater than the held amount (${wire.amount})`,
        }]);
      }
      partialCents = raw;
    }
  }

  let blnkTxn;
  try {
    blnkTxn = action === "confirm"
      ? await commitInflight(cfg, wire.blnk_transaction_id, { amountCents: partialCents })
      : await voidInflight(cfg, wire.blnk_transaction_id);
  } catch (err) {
    if (err instanceof BlnkError) return bankErrorResponse(requestId);
    return internalErrorResponse(requestId, err);
  }

  // A partial confirm is TERMINAL — the wire settles for less. Blnk keeps the
  // unconfirmed remainder held in inflight_debit_balance after a partial
  // commit, so without this void it is stranded forever: member money that is
  // neither spendable nor releasable. Found by the conservation sweep ($600
  // residue). Best-effort: the commit is final either way, and the sweep's
  // inflight-residue check surfaces a failed release.
  if (action === "confirm" && partialCents !== undefined && partialCents < wire.amount) {
    // The void can race the commit inside Blnk and fail transiently; a single
    // best-effort attempt let the remainder strand anyway (caught by the
    // conservation sweep flaking with the exact pre-fix signature). Retry with
    // a short backoff; if it still fails, log loudly — the sweep's residue
    // check is the tripwire for a stranded hold.
    let released = false;
    for (let attempt = 1; attempt <= 3 && !released; attempt++) {
      try {
        await voidInflight(cfg, wire.blnk_transaction_id);
        released = true;
      } catch (voidErr) {
        if (attempt === 3) {
          console.error(`remainder release failed for wire ${wireId} after ${attempt} attempts: ${voidErr}`);
        } else {
          await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
    }
  }

  const mirror = transactionMirror(blnkTxn);
  const { data: updated, error: updErr } = await db.schema("core").from("wire_transfer")
    .update({
      status: action === "confirm" ? "completed" : "canceled",
      synced_at: mirror.synced_at,
    })
    .eq("id", wireId)
    .select("id, amount, status, beneficiary, purpose, imad, dual_control_status, created_by, blnk_transaction_id, blnk_reference, created_at")
    .single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  // Confirm COMMITS the hold — money moved; a cancel voids it — nothing did.
  // Best-effort: the commit is already final, so evidence failure must not 500.
  if (action === "confirm") {
    const movedCents = partialCents ?? (wire.amount as number);
    try {
      await recordMovementArtifacts(db, {
        bkeId: `bke_${wireId}_completed`,
        evtId: `evt_${wireId}_completed`,
        code: "wire_transfer.completed",
        resourceType: "wire_transfer",
        resourceId: wireId,
        amountCents: movedCents,
        accountId: (wire.originator as { account_id?: string } | null)?.account_id ?? null,
        payload: {
          amount_cents: movedCents,
          held_cents: wire.amount,
          blnk_transaction_id: wire.blnk_transaction_id,
        },
      });
    } catch (artErr) {
      console.error(`wire movement artifacts failed for ${wireId}: ${artErr}`);
    }
  }

  return jsonResponse(wireResponse(updated as WireRow), 200, requestId);
}


/**
 * POST /payments/wire/{id}/reject — the network refused the wire (card 38).
 *
 * 'rejected' has been in the wire_transfer status CHECK since the core schema,
 * but the only way to reach it was a runGate block at prepare — i.e. WE refused
 * it. There was no path for the Fed or the beneficiary bank refusing a wire we
 * successfully submitted, which is the far more common rejection in practice
 * (bad beneficiary account, closed institution, OFAC hit downstream).
 *
 * Distinct from all three neighbouring transitions, and the distinctions are
 * load-bearing rather than cosmetic:
 *   cancel — we withdrew it            (submitted -> canceled)
 *   reject — the network refused it    (submitted -> rejected)
 *   return — it settled, then came back (completed -> returned, via reversal)
 * Reject and cancel both void the hold and move no money, so they are ledger
 * -identical; they stay separate states because "our decision" and "their
 * decision" answer different questions in a Reg J / UCC 4A dispute.
 */
export async function postWireReject(
  req: Request,
  wireId: string,
  db: SupabaseClient,
  cfg: BlnkConfig,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const cols =
    "id, amount, status, beneficiary, purpose, imad, originator, return_reason, blnk_transaction_id, blnk_reference, created_at";
  const { data: wire, error: selErr } = await scopeToPartner(
    db.schema("core").from("wire_transfer")
      .select(cols)
      .eq("id", wireId),
    ctx,
  ).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!wire) return notFoundResponse(requestId, "wire_transfer", wireId);

  if (wire.status === "rejected") {
    return jsonResponse(wireResponse(wire as WireRow), 200, requestId, {
      "Idempotent-Replayed": "true",
    });
  }
  // Only an in-flight submission can be rejected. A completed wire that comes
  // back is a RETURN — it needs a compensating reversal, not a void, because
  // the funds already left.
  if (wire.status !== "submitted") {
    return apiError(409, "invalid_state", requestId, {
      title: "Invalid State",
      detail:
        `wire_transfer ${wireId} is ${wire.status}; only a submitted wire can be rejected — ` +
        `a completed wire must be returned`,
    });
  }
  if (!wire.blnk_transaction_id) {
    return apiError(409, "not_held", requestId, {
      title: "Not Held",
      detail: "wire has no inflight Blnk transaction to release",
    });
  }

  const body = await parseJsonBody(req).catch(() => null);
  const rawReason = body && typeof body === "object"
    ? (body as Record<string, unknown>).reason
    : undefined;
  if (!isNonEmptyString(rawReason)) {
    return validationError(requestId, [{
      type: "missing_field",
      field: "reason",
      message: "a rejection reason is required (e.g. beneficiary account closed)",
    }]);
  }

  try {
    await voidInflight(cfg, wire.blnk_transaction_id);
  } catch (err) {
    if (err instanceof BlnkError) return bankErrorResponse(requestId);
    return internalErrorResponse(requestId, err);
  }

  const { data: updated, error: updErr } = await db.schema("core").from("wire_transfer")
    .update({
      status: "rejected",
      // shares the column with the return trail; both are "why this wire did
      // not end up where it was sent"
      return_reason: rawReason,
      synced_at: new Date().toISOString(),
    })
    .eq("id", wireId)
    .select(cols)
    .single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  // No bookkeeping entry — the hold was voided, nothing moved. The event fires
  // because a rejection releases held funds and the originator's downstream
  // systems need to know the wire is dead rather than still in flight.
  try {
    await recordMovementArtifacts(db, {
      bkeId: `bke_${wireId}_rejected`,
      evtId: `evt_${wireId}_rejected`,
      code: "wire_transfer.rejected",
      resourceType: "wire_transfer",
      resourceId: wireId,
      amountCents: 0,
      accountId: (wire.originator as { account_id?: string } | null)?.account_id ?? null,
      payload: {
        reason: rawReason,
        released_cents: wire.amount,
        blnk_transaction_id: wire.blnk_transaction_id,
      },
    });
  } catch (artErr) {
    console.error(`wire rejection artifacts failed for ${wireId}: ${artErr}`);
  }

  return jsonResponse(wireResponse(updated as WireRow), 200, requestId);
}


// ------------------------------------------------------------- wire returns
//
// Card 37: "a return request resolves to RETURNED or COMPLETED with reasons."
// Two-step, matching the schema's state machine (`return_requested` sits
// between `completed` and `returned`): a completed wire cannot simply be
// voided — the funds already left for @FedWire — so requesting a return holds
// the claim open, and only an ACCEPTED resolution posts a compensating
// reversal (@FedWire -> the originating member balance, leg ":return"). A
// REJECTED resolution restores `completed` and keeps the reason trail. Both
// paths stay append-only: settled history is never mutated.

const RETURN_COLS =
  "id, amount, status, beneficiary, purpose, imad, originator, return_reason, blnk_transaction_id, blnk_reference, created_at";

/** POST /payments/wire/{id}/return — request the return of a completed wire. */
export async function postWireReturn(
  req: Request,
  wireId: string,
  db: SupabaseClient,
  cfg: BlnkConfig,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const body = await parseJsonBody(req).catch(() => null);
  const reason = body && typeof body === "object"
    ? (body as Record<string, unknown>).reason
    : undefined;
  if (!isNonEmptyString(reason)) {
    return validationError(requestId, [{
      type: "missing_field",
      field: "reason",
      message: "a return reason is required (e.g. beneficiary fraud claim)",
    }]);
  }

  const { data: wire, error: selErr } = await scopeToPartner(
    db.schema("core").from("wire_transfer")
      .select(RETURN_COLS)
      .eq("id", wireId),
    ctx,
  ).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!wire) return notFoundResponse(requestId, "wire_transfer", wireId);

  if (wire.status === "return_requested") {
    return jsonResponse(wireResponse(wire as WireRow), 200, requestId, {
      "Idempotent-Replayed": "true",
    });
  }
  if (wire.status !== "completed") {
    return apiError(409, "invalid_state", requestId, {
      title: "Invalid State",
      detail:
        `wire_transfer ${wireId} is ${wire.status}; only a completed wire can be returned — a held wire should be canceled`,
    });
  }

  const { data: updated, error: updErr } = await db.schema("core").from("wire_transfer")
    .update({ status: "return_requested", return_reason: reason })
    .eq("id", wireId)
    .select(RETURN_COLS)
    .single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  return jsonResponse(wireResponse(updated as WireRow), 200, requestId);
}

/**
 * POST /payments/wire/{id}/return/resolve — settle the pending return claim.
 * `{outcome: "accepted"}` reverses the funds and lands `returned`;
 * `{outcome: "rejected", reason?}` restores `completed`, appending why.
 */
export async function postWireReturnResolve(
  req: Request,
  wireId: string,
  db: SupabaseClient,
  cfg: BlnkConfig,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const body = await parseJsonBody(req).catch(() => null);
  const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const outcome = rec.outcome;
  if (outcome !== "accepted" && outcome !== "rejected") {
    return validationError(requestId, [{
      type: "invalid_value",
      field: "outcome",
      message: 'must be "accepted" or "rejected"',
    }]);
  }

  const { data: wire, error: selErr } = await scopeToPartner(
    db.schema("core").from("wire_transfer")
      .select(RETURN_COLS)
      .eq("id", wireId),
    ctx,
  ).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!wire) return notFoundResponse(requestId, "wire_transfer", wireId);

  if (wire.status === "returned") {
    return jsonResponse(wireResponse(wire as WireRow), 200, requestId, {
      "Idempotent-Replayed": "true",
    });
  }
  if (wire.status !== "return_requested") {
    return apiError(409, "invalid_state", requestId, {
      title: "Invalid State",
      detail: `wire_transfer ${wireId} is ${wire.status}; only 'return_requested' can be resolved`,
    });
  }

  if (outcome === "rejected") {
    const why = isNonEmptyString(rec.reason) ? rec.reason : "unspecified";
    const trail = `${wire.return_reason ?? "return requested"} | rejected: ${why}`;
    const { data: updated, error: updErr } = await db.schema("core").from("wire_transfer")
      .update({ status: "completed", return_reason: trail })
      .eq("id", wireId)
      .select(RETURN_COLS)
      .single();
    if (updErr) return internalErrorResponse(requestId, updErr);
    return jsonResponse(wireResponse(updated as WireRow), 200, requestId);
  }

  // accepted: undo with a compensating entry, never by mutating the original
  const originatorAccountId = (wire.originator as { account_id?: string } | null)?.account_id;
  if (!originatorAccountId) {
    return apiError(409, "not_reversible", requestId, {
      title: "Not Reversible",
      detail: "completed wire has no originator account to credit back",
    });
  }
  const { data: acct, error: acctErr } = await db.schema("core").from("account")
    .select("id, blnk_balance_id")
    .eq("id", originatorAccountId)
    .maybeSingle();
  if (acctErr) return internalErrorResponse(requestId, acctErr);
  if (!acct?.blnk_balance_id) {
    return apiError(409, "not_reversible", requestId, {
      title: "Not Reversible",
      detail: "originating account has no Blnk balance to credit back",
    });
  }

  let mirror;
  try {
    const reversal = await recordTransaction(cfg, {
      coreResource: { table: "wire_transfer", id: wireId },
      // ":return" leg keeps the reference distinct from the original wire's,
      // so the reversal cannot be deduped away as a duplicate of it
      leg: "return",
      amountCents: wire.amount as number,
      currency: CURRENCY,
      source: FEDWIRE_BALANCE,
      destination: acct.blnk_balance_id as string,
      description: `wire return (${wire.return_reason ?? "unspecified"})`,
    });
    mirror = reversal.mirror;
  } catch (err) {
    if (err instanceof BlnkError) return bankErrorResponse(requestId);
    return internalErrorResponse(requestId, err);
  }

  const { data: updated, error: updErr } = await db.schema("core").from("wire_transfer")
    .update({ status: "returned", synced_at: mirror.synced_at })
    .eq("id", wireId)
    .select(RETURN_COLS)
    .single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  // The reversal moved money back — it gets its own evidence pair.
  try {
    await recordMovementArtifacts(db, {
      bkeId: `bke_${wireId}_returned`,
      evtId: `evt_${wireId}_returned`,
      code: "wire_transfer.returned",
      resourceType: "wire_transfer",
      resourceId: wireId,
      amountCents: wire.amount as number,
      accountId: originatorAccountId,
      payload: {
        amount_cents: wire.amount,
        reason: wire.return_reason ?? null,
        blnk_transaction_id: mirror.blnk_transaction_id,
      },
    });
  } catch (artErr) {
    console.error(`wire return artifacts failed for ${wireId}: ${artErr}`);
  }

  return jsonResponse(wireResponse(updated as WireRow), 200, requestId);
}

// ---------------------------------------------------------------- reads

/**
 * The columns a wire read serves. `dual_control_status` is here and absent
 * from wireResponse because it is the whole point of reading a wire back:
 * GET /eps/pending-approvals hands out a resource_id and nothing else, and
 * without this field there is no way to tell an approved wire from one still
 * waiting. `partner_id` is selected but never returned — scopeToPartner
 * filters on it, and echoing a tenant key to the tenant serves nothing.
 */
const WIRE_READ_COLS =
  "id, amount, beneficiary, purpose, imad, status, dual_control_status, return_reason, " +
  "control_results, blnk_transaction_id, blnk_reference, created_at";

const WIRE_STATUSES = [
  "pending_approval",
  "submitted",
  "completed",
  "return_requested",
  "returned",
  "rejected",
  "canceled",
];

type WireReadRow = WireRow & {
  dual_control_status: string;
  control_results?: { control_id: string; decision: string }[] | null;
};

/**
 * Reuses wireResponse so a wire has ONE shape whether it arrives from a POST
 * or a GET, then adds the two fields only a reader needs. Divergent read and
 * write shapes for the same resource is the drift this avoids.
 */
function wireReadResponse(row: WireReadRow): Record<string, unknown> {
  return {
    ...wireResponse(row, row.control_results ?? []),
    dual_control_status: row.dual_control_status,
  };
}

/** GET /wire-transfers */
export async function getWireTransfers(
  req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const { limit, after, errors } = parsePageParams(q);

  const status = q.get("status");
  if (status !== null && !WIRE_STATUSES.includes(status)) {
    errors.push({
      type: "invalid_value",
      field: "status",
      message: `must be one of: ${WIRE_STATUSES.join(", ")}`,
    });
  }
  const dualControl = q.get("dual_control_status");
  if (dualControl !== null && !DUAL_CONTROL_STATUSES.includes(dualControl)) {
    errors.push({
      type: "invalid_value",
      field: "dual_control_status",
      message: `must be one of: ${DUAL_CONTROL_STATUSES.join(", ")}`,
    });
  }
  if (errors.length) return validationError(requestId, errors);

  let query = scopeToPartner(
    db.schema("core").from("wire_transfer").select(WIRE_READ_COLS),
    ctx,
  )
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (status) query = query.eq("status", status);
  if (dualControl) query = query.eq("dual_control_status", dualControl);
  if (after) query = query.lt("created_at", after);

  const { data, error } = await query;
  if (error) return internalErrorResponse(requestId, error);

  const { page, has_more, next_after } = paginate(
    (data ?? []) as unknown as Record<string, unknown>[],
    limit,
  );
  return jsonResponse(
    pageEnvelope((await attachControlResults(db, page as unknown as WireReadRow[])).map(wireReadResponse), {
      limit,
      has_more,
      next_after,
    }),
    200,
    requestId,
  );
}

/**
 * GET /wire-transfers/{id}
 *
 * 404 rather than 403 when the wire belongs to another partner: whether a
 * given id exists on this instance is itself the thing a foreign caller must
 * not learn. Same rule OWN-01 pins for accounts.
 */
export async function getWireTransfer(
  _req: Request,
  wireId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  // 404, not 400: an id that cannot be a uuid is an id that does not exist,
  // and answering the two cases identically is what keeps "does this id exist"
  // unlearnable — the same reason the cross-partner case below is 404.
  if (!isUuid(wireId)) return notFoundResponse(requestId, "wire_transfer", wireId);

  const { data, error } = await scopeToPartner(
    db.schema("core").from("wire_transfer").select(WIRE_READ_COLS).eq("id", wireId),
    ctx,
  ).maybeSingle();
  if (error) return internalErrorResponse(requestId, error);
  if (!data) return notFoundResponse(requestId, "wire_transfer", wireId);
  const [row] = await attachControlResults(db, [data as unknown as WireReadRow]);
  return jsonResponse(wireReadResponse(row), 200, requestId);
}
