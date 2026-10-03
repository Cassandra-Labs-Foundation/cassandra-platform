import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type AccountRow } from "./accounts.ts";
import { type EvidenceScope, provenanceFor } from "./bsa.ts";
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
  jsonResponse,
  notFoundResponse,
  pageEnvelope,
  paginate,
  parsePageParams,
  parseJsonBody,
  sha256Hex,
  storeIdempotencyResponse,
  validationError,
  type ValidationErrorItem,
} from "./lib.ts";
import { scopeToPartner } from "./ownership.ts";
import { type PartnerContext } from "./auth.ts";

const CARD_NETWORK_BALANCE = "@CardNetwork";
const CURRENCY = "USD";

const CARD_RESOURCE = (id: string): GateResource => ({
  table: "card_authorization",
  type: "card_authorization",
  id,
  label: "card authorization",
  rejectedStatus: "declined",
});

export interface CardAuthRow {
  id: string;
  amount: number;
  status: string;
  merchant: string | null;
  decline_reason: string | null;
  blnk_inflight_id: string | null;
  blnk_committed_amount: number | null;
  originator?: { account_id?: string } | null;
  blnk_reference: string | null;
  created_at: string;
}

const CARD_COLS =
  "id, amount, status, merchant, decline_reason, originator, blnk_inflight_id, blnk_committed_amount, blnk_reference, created_at";

function cardResponse(
  row: CardAuthRow,
  controlResults?: { control_id: string; decision: string }[],
): Record<string, unknown> {
  const captured = row.blnk_committed_amount ?? 0;
  // Once the hold is gone there is nothing left to capture, so the remainder is
  // zero REGARDLESS of the arithmetic. Deriving it from amount - captured alone
  // reported a reversed or expired $1,000 auth as still having $1,000
  // available: the hold had been voided in Blnk, but the API kept advertising
  // it as capturable. 'declined' never placed a hold at all.
  const holdReleased = row.status === "reversed" || row.status === "expired" ||
    row.status === "declined";
  return {
    id: row.id,
    status: row.status,
    amount_cents: row.amount,
    captured_cents: captured,
    // what is still held and could yet be captured or released
    remaining_cents: holdReleased ? 0 : Math.max(0, row.amount - captured),
    merchant: row.merchant,
    decline_reason: row.decline_reason,
    blnk_inflight_id: row.blnk_inflight_id,
    control_results: controlResults ?? [],
    created_at: row.created_at,
  };
}

/**
 * POST /payments/card/authorize
 *
 * Places an authorization hold. Unlike wires/ACH this hold is routinely settled
 * for LESS than the authorized amount (tip adjustments, partial shipment), and
 * may be captured across SEVERAL calls — so the hold is not a single
 * commit-or-void, it is drawn down incrementally. See postCardCapture.
 */
export async function postCardAuthorize(
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
      detail: "POST /payments/card/authorize requires an Idempotency-Key header",
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
  const merchant = b.merchant;

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
  if (!isNonEmptyString(merchant)) {
    errors.push({ type: "missing_field", field: "merchant", message: "is required" });
  }
  if (errors.length) return validationError(requestId, errors);

  const amount = amountCents as number;
  const sourceId = sourceAccountId as string;
  const merchantName = merchant as string;

  const requestHash = await sha256Hex(
    JSON.stringify({ source_account_id: sourceId, amount_cents: amount, merchant: merchantName }),
  );

  const freshId = `cauth_${crypto.randomUUID()}`;
  const claim = await claimIdempotency(
    db, ctx.idempotencyScope,
    idempotencyKey,
    requestHash,
    freshId,
    "POST /payments/card/authorize",
  );

  if (claim.kind === "replay") {
    return jsonResponse(claim.responseBody, claim.responseStatus, requestId, {
      "Idempotent-Replayed": "true",
    });
  }
  if (claim.kind === "conflict") {
    return apiError(409, "idempotency_key_reused", requestId, {
      title: "Idempotency Key Reused",
      detail: "Idempotency-Key was used with a different request body",
    });
  }

  const authId = claim.kind === "resume" ? claim.transferId : freshId;

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

  const { error: insErr } = await db.schema("core").from("card_authorization").upsert({
    id: authId,
    amount,
    originator: { account_id: sourceId },
    merchant: merchantName,
    status: "authorized",
    blnk_committed_amount: 0,
    partner_id: ctx.ownerPartnerId,
  });
  if (insErr) return internalErrorResponse(requestId, insErr);

  // Gate before the hold, same as every other rail.
  let gate;
  try {
    gate = await runGate(db, cfg, CARD_RESOURCE(authId), account as AccountRow, null, amount, ctx);
  } catch (err) {
    return internalErrorResponse(requestId, err);
  }
  if (gate.blocked) {
    // A gate rejection is a DECLINE in card terms; record why on the row so the
    // decline reason survives for the compliance/ops record.
    await db.schema("core").from("card_authorization")
      .update({
        status: "declined",
        decline_reason: String((gate.body as Record<string, unknown>).type ?? "declined"),
      })
      .eq("id", authId);
    await storeIdempotencyResponse(db, ctx.idempotencyScope, idempotencyKey, gate.status, gate.body);
    return jsonResponse(gate.body, gate.status, requestId);
  }

  let mirror;
  try {
    const result = await recordTransaction(cfg, {
      coreResource: { table: "card_authorization", id: authId },
      amountCents: amount,
      currency: CURRENCY,
      source: account.blnk_balance_id,
      destination: CARD_NETWORK_BALANCE,
      description: `card authorization — ${merchantName}`,
      inflight: true,
    });
    mirror = result.mirror;
  } catch (err) {
    if (err instanceof BlnkError) return bankErrorResponse(requestId);
    return internalErrorResponse(requestId, err);
  }

  const { data: updated, error: updErr } = await db.schema("core").from("card_authorization")
    .update({
      // for card the inflight transaction id lands in blnk_inflight_id, not
      // blnk_transaction_id (see 20260702000500 column comment)
      blnk_inflight_id: mirror.blnk_transaction_id,
      blnk_reference: mirror.blnk_reference,
      synced_at: mirror.synced_at,
    })
    .eq("id", authId)
    .select(CARD_COLS)
    .single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  const responseBody = cardResponse(updated as CardAuthRow, gate.controlResults);
  await storeIdempotencyResponse(db, ctx.idempotencyScope, idempotencyKey, 201, responseBody);
  return jsonResponse(responseBody, 201, requestId);
}

/**
 * POST /payments/card/{id}/capture
 *
 * Draws down the hold. Partial and INCREMENTAL: callable repeatedly until the
 * authorized amount is exhausted. Each call commits only the increment, and the
 * running total lives in blnk_committed_amount, so the row moves
 * authorized -> partially_captured -> captured. Over-capture is rejected rather
 * than clamped: silently capturing less than asked would misstate settlement.
 */
export async function postCardCapture(
  req: Request,
  authId: string,
  db: SupabaseClient,
  cfg: BlnkConfig,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const { data: auth, error: selErr } = await scopeToPartner(
    db.schema("core").from("card_authorization")
      .select(CARD_COLS)
      .eq("id", authId),
    ctx,
  ).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!auth) return notFoundResponse(requestId, "card_authorization", authId);

  const row = auth as CardAuthRow;
  if (row.status === "captured") {
    return jsonResponse(cardResponse(row), 200, requestId, { "Idempotent-Replayed": "true" });
  }
  if (row.status !== "authorized" && row.status !== "partially_captured") {
    return apiError(409, "invalid_state", requestId, {
      title: "Invalid State",
      detail: `card_authorization ${authId} is ${row.status}; only an open hold can be captured`,
    });
  }
  if (!row.blnk_inflight_id) {
    return apiError(409, "not_held", requestId, {
      title: "Not Held",
      detail: "authorization has no inflight Blnk transaction to capture",
    });
  }

  const alreadyCaptured = row.blnk_committed_amount ?? 0;
  const remaining = row.amount - alreadyCaptured;

  const body = await parseJsonBody(req).catch(() => null);
  const raw = body && typeof body === "object"
    ? (body as Record<string, unknown>).amount_cents
    : undefined;
  // default: capture the whole remaining hold
  const increment = raw === undefined ? remaining : raw;

  if (typeof increment !== "number" || !Number.isInteger(increment) || increment <= 0) {
    return validationError(requestId, [{
      type: "invalid_value",
      field: "amount_cents",
      message: "must be a positive integer number of cents",
    }]);
  }
  if (increment > remaining) {
    return apiError(422, "capture_exceeds_authorization", requestId, {
      title: "Capture Exceeds Authorization",
      detail:
        `cannot capture ${increment} cents; only ${remaining} of the ` +
        `${row.amount} authorization remains held`,
    });
  }

  let blnkTxn;
  try {
    blnkTxn = await commitInflight(cfg, row.blnk_inflight_id, { amountCents: increment });
  } catch (err) {
    if (err instanceof BlnkError) return bankErrorResponse(requestId);
    return internalErrorResponse(requestId, err);
  }

  const captured = alreadyCaptured + increment;
  const mirror = transactionMirror(blnkTxn);
  const { data: updated, error: updErr } = await db.schema("core").from("card_authorization")
    .update({
      status: captured >= row.amount ? "captured" : "partially_captured",
      blnk_committed_amount: captured,
      synced_at: mirror.synced_at,
    })
    .eq("id", authId)
    .select(CARD_COLS)
    .single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  // Each capture is its own money movement, so each gets its own evidence
  // pair. The id embeds the post-capture RUNNING TOTAL: a resume retry of the
  // same capture converges on the same rows (same total), while a further
  // incremental capture (new total) gets fresh ones. The entry books the
  // DELTA — summing a card's entries must equal what actually moved.
  try {
    await recordMovementArtifacts(db, {
      bkeId: `bke_${authId}_captured_c${captured}`,
      evtId: `evt_${authId}_captured_c${captured}`,
      code: "card_authorization.captured",
      resourceType: "card_authorization",
      resourceId: authId,
      amountCents: increment,
      accountId: (row.originator as { account_id?: string } | null)?.account_id ?? null,
      payload: {
        captured_cents: increment,
        captured_total_cents: captured,
        remaining_cents: row.amount - captured,
        merchant: row.merchant,
        blnk_transaction_id: mirror.blnk_transaction_id,
      },
    });
  } catch (artErr) {
    console.error(`card movement artifacts failed for ${authId}: ${artErr}`);
  }

  return jsonResponse(cardResponse(updated as CardAuthRow), 200, requestId);
}

/**
 * POST /payments/card/{id}/expire — the uncaptured hold aged out (card 44).
 *
 * 'expired' has been in the status CHECK since 20260718000300 and postCardReverse
 * already treats it as terminal, but nothing ever SET it: an auth the merchant
 * never captured sat 'authorized' forever, holding member funds and pinning the
 * amount inside the CG-VEL-01 daily aggregate (which counts open holds).
 *
 * Ledger-identical to a reversal — both void the inflight and release the
 * remainder — but kept a separate terminal state because the cause differs and
 * the ops side reads them differently: a reversal is someone's decision, an
 * expiry is the absence of one. Collapsing them would make "merchants who never
 * capture" unqueryable.
 */
export async function postCardExpire(
  // unused: an expiry carries no caller-supplied reason — that is what makes it
  // an expiry rather than a reversal. Kept in the signature so every rail
  // transition has one shape for the simulate dispatcher to call.
  _req: Request,
  authId: string,
  db: SupabaseClient,
  cfg: BlnkConfig,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const { data: auth, error: selErr } = await scopeToPartner(
    db.schema("core").from("card_authorization")
      .select(CARD_COLS)
      .eq("id", authId),
    ctx,
  ).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!auth) return notFoundResponse(requestId, "card_authorization", authId);

  const row = auth as CardAuthRow;
  if (row.status === "expired") {
    return jsonResponse(cardResponse(row), 200, requestId, { "Idempotent-Replayed": "true" });
  }
  // A fully captured auth has no hold left to age out, and a reversed one was
  // already released deliberately — neither is an expiry.
  if (row.status !== "authorized" && row.status !== "partially_captured") {
    return apiError(409, "invalid_state", requestId, {
      title: "Invalid State",
      detail: `card_authorization ${authId} is ${row.status}; only an open hold can expire`,
    });
  }
  if (!row.blnk_inflight_id) {
    return apiError(409, "not_held", requestId, {
      title: "Not Held",
      detail: "authorization has no inflight Blnk transaction to expire",
    });
  }

  try {
    await voidInflight(cfg, row.blnk_inflight_id);
  } catch (err) {
    if (err instanceof BlnkError) return bankErrorResponse(requestId);
    return internalErrorResponse(requestId, err);
  }

  const captured = row.blnk_committed_amount ?? 0;
  const released = row.amount - captured;

  const { data: updated, error: updErr } = await db.schema("core").from("card_authorization")
    .update({
      status: "expired",
      decline_reason: "authorization_expired",
      synced_at: new Date().toISOString(),
    })
    .eq("id", authId)
    .select(CARD_COLS)
    .single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  // Unlike a capture, an expiry books no bookkeeping entry against the member —
  // the released remainder never left. The EVENT still matters: releasing a hold
  // changes available balance, and a partially-captured auth expiring is the
  // only signal that the uncaptured remainder is now permanently unclaimable.
  try {
    await recordMovementArtifacts(db, {
      bkeId: `bke_${authId}_expired`,
      evtId: `evt_${authId}_expired`,
      code: "card_authorization.expired",
      resourceType: "card_authorization",
      resourceId: authId,
      amountCents: 0,
      accountId: (row.originator as { account_id?: string } | null)?.account_id ?? null,
      payload: {
        released_cents: released,
        captured_total_cents: captured,
        merchant: row.merchant,
      },
    });
  } catch (artErr) {
    console.error(`card expiry artifacts failed for ${authId}: ${artErr}`);
  }

  return jsonResponse(cardResponse(updated as CardAuthRow), 200, requestId);
}

/**
 * POST /payments/card/{id}/reverse
 *
 * Voids the remaining hold. Allowed from partially_captured too — releasing the
 * uncaptured remainder is the normal end state for an under-captured auth; what
 * was already captured stays captured.
 */
export async function postCardReverse(
  req: Request,
  authId: string,
  db: SupabaseClient,
  cfg: BlnkConfig,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const { data: auth, error: selErr } = await scopeToPartner(
    db.schema("core").from("card_authorization")
      .select(CARD_COLS)
      .eq("id", authId),
    ctx,
  ).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!auth) return notFoundResponse(requestId, "card_authorization", authId);

  const row = auth as CardAuthRow;
  if (row.status === "reversed" || row.status === "expired") {
    return jsonResponse(cardResponse(row), 200, requestId, { "Idempotent-Replayed": "true" });
  }
  if (row.status !== "authorized" && row.status !== "partially_captured") {
    return apiError(409, "invalid_state", requestId, {
      title: "Invalid State",
      detail: `card_authorization ${authId} is ${row.status}; only an open hold can be reversed`,
    });
  }
  if (!row.blnk_inflight_id) {
    return apiError(409, "not_held", requestId, {
      title: "Not Held",
      detail: "authorization has no inflight Blnk transaction to reverse",
    });
  }

  const body = await parseJsonBody(req).catch(() => null);
  const rawReason = body && typeof body === "object"
    ? (body as Record<string, unknown>).reason
    : undefined;

  try {
    await voidInflight(cfg, row.blnk_inflight_id);
  } catch (err) {
    if (err instanceof BlnkError) return bankErrorResponse(requestId);
    return internalErrorResponse(requestId, err);
  }

  const { data: updated, error: updErr } = await db.schema("core").from("card_authorization")
    .update({
      status: "reversed",
      decline_reason: isNonEmptyString(rawReason) ? rawReason : row.decline_reason,
      synced_at: new Date().toISOString(),
    })
    .eq("id", authId)
    .select(CARD_COLS)
    .single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  return jsonResponse(cardResponse(updated as CardAuthRow), 200, requestId);
}

/**
 * POST /cards {member_ref, spend_controls?}
 *
 * OQ-24: THE CARD ISSUANCE WRITER THAT DID NOT EXIST. `cards.ts` had authorize,
 * capture, expire and reverse — every operation that assumes a card already
 * exists, and nothing that creates one. Every card in the system was implicitly
 * pre-existing, so any control declaring `card.id` or `card.spend_controls` as
 * a required input could never be satisfied no matter how correct its own logic
 * was. Found because EPS-05 and EPS-07 were built, correct, and still red.
 *
 * The general shape is worth naming: a subsystem can look complete because all
 * its VERBS are present, while the noun they operate on has no origin.
 */
/** Issuance and reissue are staff operations — 404 semantics for partners,
 * matching the route-gating convention for internal-audience routes. */
function requireInternalActor(ctx: PartnerContext, requestId: string): Response | null {
  if (ctx.actorType === "partner") return notFoundResponse(requestId, "route", "/cards");
  return null;
}

export async function postIssueCard(
  req: Request, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const memberRef = typeof body.member_ref === "string" ? body.member_ref : "";
  if (!memberRef) {
    return validationError(requestId, [
      { field: "member_ref", type: "required", message: "member_ref is required" },
    ]);
  }

  // Spend controls default to a named baseline rather than NULL. A card with no
  // spend controls at all is not a safer default than a restrictive one, and a
  // NULL here is indistinguishable from "nobody configured it".
  const spendControls = typeof body.spend_controls === "string"
    ? body.spend_controls
    : "default_baseline";

  const id = `card_${memberRef}_${spendControls}`;
  const { data, error } = await db.schema(scope).from("card").upsert({
    id,
    status: "active",
    spend_controls: spendControls,
  }, { onConflict: "id" }).select("id, status, spend_controls").maybeSingle();
  if (error) return internalErrorResponse(requestId, error.message);

  const { error: evErr } = await db.schema(scope).from("event").upsert({
    id: `ev_${id}_issued`,
    code: "card.issued",
    resource_type: "card",
    resource_id: `card:${id}`,
    payload: { member_ref: memberRef, spend_controls: spendControls },
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (evErr) return internalErrorResponse(requestId, evErr.message);

  return jsonResponse({ data }, 201, requestId);
}

/**
 * POST /cards/:member/reissue {ship_to_address_id}
 *
 * MP-02. A reissue requested while an address change is still inside its hold
 * window is the account-takeover pattern: change the address, then have the
 * card follow it. The reissue is RECORDED AND BLOCKED rather than refused
 * outright — a refusal with no row leaves the pattern invisible to the
 * red-flags review, which is the thing that is supposed to catch it.
 */
export async function postCardReissue(
  req: Request, memberRef: string, db: SupabaseClient, requestId: string,
  ctx: PartnerContext, scope: EvidenceScope = "core",
): Promise<Response> {
  const denied = requireInternalActor(ctx, requestId);
  if (denied) return denied;
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const { data: holds } = await db.schema(scope).from("member_address_change")
    .select("id, hold_expires_at, member_ref").eq("member_ref", memberRef);
  const now = new Date();
  const onHold = (holds ?? []).some((h: Record<string, unknown>) =>
    typeof h.hold_expires_at === "string" && new Date(h.hold_expires_at) > now
  );

  const id = `card_${memberRef}_reissue`;
  const { error } = await db.schema(scope).from("card").upsert({
    id, status: onHold ? "blocked" : "active", spend_controls: "default_baseline",
    reissue_request: true,
    ship_to_address_id: typeof body.ship_to_address_id === "string"
      ? body.ship_to_address_id
      : null,
    address_hold_blocked: onHold,
  }, { onConflict: "id" });
  if (error) return internalErrorResponse(requestId, error.message);

  const { error: evErr } = await db.schema(scope).from("event").upsert({
    id: `ev_${id}_req`, code: "card.request_during_address_hold",
    resource_type: "card", resource_id: `card:${id}`,
    payload: {
      "card.reissue_request": true, member_ref: memberRef,
      on_hold: onHold, blocked: onHold,
    },
    provenance: provenanceFor(scope, ctx),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (evErr) return internalErrorResponse(requestId, evErr.message);

  return jsonResponse({ data: { id, blocked: onHold } }, 201, requestId);
}

// ---------------------------------------------------------------- reads

/**
 * Cards need no extra read columns: CARD_COLS already carries everything
 * cardResponse derives, including the hold arithmetic that makes
 * remaining_cents honest on a reversed or expired auth. Reusing it verbatim
 * keeps a card the same shape whether it arrives from authorize or from here.
 */
const CARD_STATUSES = [
  "authorized",
  "partially_captured",
  "captured",
  "declined",
  "reversed",
  "expired",
];

/** GET /cards */
export async function getCards(
  req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const { limit, after, errors } = parsePageParams(q);

  const status = q.get("status");
  if (status !== null && !CARD_STATUSES.includes(status)) {
    errors.push({
      type: "invalid_value",
      field: "status",
      message: `must be one of: ${CARD_STATUSES.join(", ")}`,
    });
  }
  if (errors.length) return validationError(requestId, errors);

  let query = scopeToPartner(
    db.schema("core").from("card_authorization").select(`${CARD_COLS}, control_results`),
    ctx,
  )
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (status) query = query.eq("status", status);
  if (after) query = query.lt("created_at", after);

  const { data, error } = await query;
  if (error) return internalErrorResponse(requestId, error);

  const { page, has_more, next_after } = paginate(
    (data ?? []) as unknown as Record<string, unknown>[],
    limit,
  );
  const rows = await attachControlResults(db, page as unknown as (CardAuthRow & {
    control_results?: { control_id: string; decision: string }[] | null;
  })[]);
  return jsonResponse(
    pageEnvelope(rows.map((r) => cardResponse(r, r.control_results ?? [])), {
      limit,
      has_more,
      next_after,
    }),
    200,
    requestId,
  );
}

/** GET /cards/{id}. 404 across partners, as on the other rails. */
export async function getCard(
  _req: Request,
  cardId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const { data, error } = await scopeToPartner(
    db.schema("core").from("card_authorization")
      .select(`${CARD_COLS}, control_results`).eq("id", cardId),
    ctx,
  ).maybeSingle();
  if (error) return internalErrorResponse(requestId, error);
  if (!data) return notFoundResponse(requestId, "card_authorization", cardId);
  const [row] = await attachControlResults(db, [data as unknown as CardAuthRow & {
    control_results?: { control_id: string; decision: string }[] | null;
  }]);
  return jsonResponse(cardResponse(row, row.control_results ?? []), 200, requestId);
}
