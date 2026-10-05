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
import { provenanceFor, raiseAlert } from "./bsa.ts";
import { achDualControl, clientLimitFor, DUAL_CONTROL_STATUSES, openApproval } from "./eps.ts";
import { type PartnerContext } from "./auth.ts";

// Outbound ACH debits leave the customer balance for the ACH network. Blnk
// auto-creates `@`-prefixed external balances on first reference.
const ACH_NETWORK_BALANCE = "@ACHNetwork";
const CURRENCY = "USD";

// Standard NACHA-ish settlement windows; free text in the schema, constrained
// here so the writer cannot invent values the ops side does not expect.
const WINDOWS = ["same_day", "next_day", "two_day"] as const;

/**
 * The NACHA return codes this core recognises (card 35). Not the full R01–R85
 * book — the ones a simulation actually needs to drive, plus every code whose
 * handling differs from "void the hold and stop".
 *
 * Constrained rather than free text because the return code is what the
 * compliance side keys off: an unrecognised code silently falls out of the
 * unauthorized-return sweep below, which is precisely the class that must never
 * be missed.
 */
const RETURN_CODES: Record<string, string> = {
  R01: "insufficient funds",
  R02: "account closed",
  R03: "no account / unable to locate account",
  R04: "invalid account number structure",
  R05: "unauthorized debit to consumer account",
  R06: "returned per ODFI request",
  R07: "authorization revoked by customer",
  R08: "payment stopped",
  R09: "uncollected funds",
  R10: "customer advises originator is not known / not authorized",
  R16: "account frozen",
  R20: "non-transaction account",
  R29: "corporate customer advises not authorized",
};

/**
 * Returns that assert the debit was never authorized. These are not ordinary
 * "the money wasn't there" returns — each is a customer or corporate claim of
 * an unauthorized entry, which is a BSA-reportable signal and carries a
 * Reg E / UCC 4A dispute clock. They raise an alert; R01-class returns do not.
 */
const UNAUTHORIZED_RETURN_CODES = new Set(["R05", "R07", "R10", "R29"]);

/**
 * Notification-of-change codes and the counterparty fields each one corrects.
 * A NOC is administrative: the entry it rides on settles normally and the money
 * moves. The C-code obliges the ODFI to correct its stored details for FUTURE
 * entries, so what matters here is capturing WHICH fields the RDFI corrected.
 */
const NOC_CODES: Record<string, string[]> = {
  C01: ["account_number"],
  C02: ["routing_number"],
  C03: ["routing_number", "account_number"],
  C05: ["transaction_code"],
  C06: ["account_number", "transaction_code"],
  C07: ["routing_number", "account_number", "transaction_code"],
  C08: ["receiving_dfi_identification"],
  C09: ["individual_identification_number"],
  C13: ["addenda_format"],
};

const ACH_RESOURCE = (id: string): GateResource => ({
  table: "ach_transfer",
  type: "ach_transfer",
  id,
  label: "outbound ACH",
  rejectedStatus: "rejected",
});

export interface AchRow {
  id: string;
  amount: number;
  status: string;
  counterparty: unknown;
  window: string | null;
  originator?: { account_id?: string } | null;
  return_reason: string | null;
  noc: { code?: string; corrections?: Record<string, unknown> } | null;
  blnk_transaction_id: string | null;
  blnk_reference: string | null;
  created_at: string;
}

function achResponse(
  row: AchRow,
  controlResults?: { control_id: string; decision: string }[],
): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    amount_cents: row.amount,
    counterparty: row.counterparty,
    window: row.window,
    return_reason: row.return_reason ?? null,
    // present on a settled entry too: a NOC corrects future entries, it does
    // not undo this one
    noc: row.noc ?? null,
    blnk_transaction_id: row.blnk_transaction_id,
    control_results: controlResults ?? [],
    created_at: row.created_at,
  };
}

/**
 * POST /payments/ach
 *
 * Submits an outbound ACH debit. Like wires this is two-phase on Blnk inflight:
 * submission places a HOLD, and the funds only actually move when the batch
 * settles. That matters for ACH specifically because a submitted entry can
 * still be returned (R01 insufficient funds, R02 account closed, …) days later
 * — holding rather than moving keeps the ledger honest until settlement.
 */
export async function postAch(
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
      detail: "POST /payments/ach requires an Idempotency-Key header",
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
  const counterparty = b.counterparty;
  const window = b.window;

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
  if (counterparty === null || typeof counterparty !== "object" || Array.isArray(counterparty)) {
    errors.push({ type: "invalid_value", field: "counterparty", message: "must be an object" });
  }
  if (window !== undefined && !WINDOWS.includes(window as typeof WINDOWS[number])) {
    errors.push({
      type: "invalid_value",
      field: "window",
      message: `must be one of: ${WINDOWS.join(", ")}`,
    });
  }
  if (errors.length) return validationError(requestId, errors);

  const amount = amountCents as number;
  const sourceId = sourceAccountId as string;
  const windowText = typeof window === "string" ? window : "next_day";

  const requestHash = await sha256Hex(
    JSON.stringify({
      source_account_id: sourceId,
      amount_cents: amount,
      counterparty,
      window: windowText,
    }),
  );

  const freshAchId = crypto.randomUUID();
  const claim = await claimIdempotency(
    db, ctx.idempotencyScope,
    idempotencyKey,
    requestHash,
    freshAchId,
    "POST /payments/ach",
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

  // A resumed claim reuses the interrupted attempt's id so the Blnk `reference`
  // stays stable and the same entry cannot be double-held.
  const achId = claim.kind === "resume" ? claim.transferId : freshAchId;

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

  // EPS-06 assessment happens BEFORE the row is written, so the status is
  // recorded at creation rather than patched on afterwards.
  let dualControl;
  try {
    dualControl = achDualControl(amount, await clientLimitFor(db, ctx.ownerPartnerId));
  } catch (limitErr) {
    return internalErrorResponse(requestId, limitErr);
  }

  const { error: insErr } = await db.schema("core").from("ach_transfer").upsert({
    id: achId,
    amount,
    // records whose money is leaving: needed for audit and for the per-account
    // daily aggregates (CG-VEL-01 velocity, CG-STR-01 structuring).
    originator: { account_id: sourceId },
    counterparty,
    window: windowText,
    status: "pending_approval",
    partner_id: ctx.ownerPartnerId,
    dual_control_status: dualControl.status,
    created_by: ctx.tokenId,
  });
  if (insErr) return internalErrorResponse(requestId, insErr);

  // EPS-06: only OPEN an approval when one is actually required. An unassessed
  // batch gets no approval record, because there is nothing to approve against
  // — that is the point of it being unassessed rather than required.
  if (dualControl.status === "required") {
    try {
      await openApproval(db, {
        resourceType: "ach_transfer",
        resourceId: achId,
        createdBy: ctx.tokenId,
        decision: dualControl,
        ctx,
      });
    } catch (apprErr) {
      console.error(`ach approval record failed for ${achId}: ${apprErr}`);
    }
  }

  // Gate before the hold: an ACH debit is a money-movement rail like any other,
  // so CTR / NSF / velocity all apply. A rail that skips them would let a large
  // ACH settle with no BSA alert.
  let gate;
  try {
    gate = await runGate(db, cfg, ACH_RESOURCE(achId), account as AccountRow, null, amount, ctx);
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
      coreResource: { table: "ach_transfer", id: achId },
      amountCents: amount,
      currency: CURRENCY,
      source: account.blnk_balance_id,
      destination: ACH_NETWORK_BALANCE,
      description: `outbound ACH (${windowText})`,
      inflight: true,
    });
    mirror = result.mirror;
  } catch (err) {
    // Row stays pending_approval with no Blnk id; the reconciler's non-terminal
    // sweep surfaces it. 502 is not stored, so the same key can be retried.
    if (err instanceof BlnkError) return bankErrorResponse(requestId);
    return internalErrorResponse(requestId, err);
  }

  const cols =
    "id, amount, status, counterparty, window, originator, return_reason, noc, blnk_transaction_id, blnk_reference, created_at";
  const { data: updated, error: updErr } = await db.schema("core").from("ach_transfer")
    .update({
      status: "submitted",
      blnk_transaction_id: mirror.blnk_transaction_id,
      blnk_reference: mirror.blnk_reference,
      synced_at: mirror.synced_at,
    })
    .eq("id", achId)
    .select(cols)
    .single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  // EPS-06's declared trigger. The entry really is created here; the core has
  // simply never said so, which is why EPS-06 scored unreachable.
  try {
    await db.schema("core").from("event").upsert({
      id: `evt_${achId}_created`,
      code: "ach_transfer.created",
      resource_type: "ach_transfer",
      resource_id: `ach_transfer:${achId}`,
      payload: {
        amount_cents: amount,
        window: windowText,
        dual_control_status: dualControl.status,
        dual_control_basis: dualControl.basis,
      },
      provenance: provenanceFor("core", ctx),
    }, { onConflict: "id", ignoreDuplicates: true });
  } catch (evtErr) {
    console.error(`ach_transfer.created event failed for ${achId}: ${evtErr}`);
  }

  const responseBody = achResponse(updated as AchRow, gate.controlResults);
  await storeIdempotencyResponse(db, ctx.idempotencyScope, idempotencyKey, 201, responseBody);
  return jsonResponse(responseBody, 201, requestId);
}

/** POST /payments/ach/{id}/settle — commit the hold; the batch cleared. */
export async function postAchSettle(
  req: Request,
  achId: string,
  db: SupabaseClient,
  cfg: BlnkConfig,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  return await resolveAch(req, achId, db, cfg, requestId, ctx, "settle");
}

/**
 * POST /payments/ach/{id}/return — void the hold; the RDFI returned the entry.
 * Distinct from settle because the money never moves, and the return reason
 * (R01, R02, …) is retained for the ops/compliance record.
 */
export async function postAchReturn(
  req: Request,
  achId: string,
  db: SupabaseClient,
  cfg: BlnkConfig,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  return await resolveAch(req, achId, db, cfg, requestId, ctx, "return");
}

async function resolveAch(
  req: Request,
  achId: string,
  db: SupabaseClient,
  cfg: BlnkConfig,
  requestId: string,
  ctx: PartnerContext,
  action: "settle" | "return",
): Promise<Response> {
  const cols =
    "id, amount, status, counterparty, window, originator, return_reason, noc, blnk_transaction_id, blnk_reference, created_at";
  const { data: ach, error: selErr } = await scopeToPartner(
    db.schema("core").from("ach_transfer")
      .select(cols)
      .eq("id", achId),
    ctx,
  ).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!ach) return notFoundResponse(requestId, "ach_transfer", achId);

  const terminal = action === "settle" ? "settled" : "returned";

  // Re-resolving an already-resolved entry replays rather than erroring, so
  // duplicate settlement notifications from the network stay safe.
  if (ach.status === terminal) {
    return jsonResponse(achResponse(ach as AchRow), 200, requestId, {
      "Idempotent-Replayed": "true",
    });
  }
  // An ACH return can legitimately arrive AFTER settlement — R01s and
  // unauthorized-debit returns come back days later. So 'settled' is a valid
  // starting point for a return, though not for a settle.
  const allowed = action === "settle" ? ["submitted"] : ["submitted", "settled"];
  if (!allowed.includes(ach.status)) {
    return apiError(409, "invalid_state", requestId, {
      title: "Invalid State",
      detail:
        `ach_transfer ${achId} is ${ach.status}; only ${allowed.map((s) => `'${s}'`).join(" or ")} can be ${action}ed`,
    });
  }
  const isPostSettlementReturn = action === "return" && ach.status === "settled";
  if (!ach.blnk_transaction_id) {
    return apiError(409, "not_held", requestId, {
      title: "Not Held",
      detail: "ACH entry has no inflight Blnk transaction to resolve",
    });
  }

  let returnReason: string | null = null;
  if (action === "return") {
    const body = await parseJsonBody(req).catch(() => null);
    const raw = body && typeof body === "object"
      ? (body as Record<string, unknown>).return_reason
      : undefined;
    if (raw !== undefined && !isNonEmptyString(raw)) {
      return validationError(requestId, [{
        type: "invalid_value",
        field: "return_reason",
        message: "must be a non-empty string (e.g. R01)",
      }]);
    }
    // An unrecognised code is refused rather than stored: it would pass through
    // to the row, read like a real return code to anyone querying it, and be
    // invisible to the unauthorized-return sweep that keys on this exact set.
    if (isNonEmptyString(raw) && !(raw in RETURN_CODES)) {
      return validationError(requestId, [{
        type: "invalid_value",
        field: "return_reason",
        message: `unrecognised NACHA return code; must be one of: ${Object.keys(RETURN_CODES).join(", ")}`,
      }]);
    }
    returnReason = isNonEmptyString(raw) ? raw : null;
  }

  let blnkTxn;
  try {
    if (isPostSettlementReturn) {
      // The hold was already committed, so there is nothing left to void: the
      // funds have moved. Undo it with a compensating entry in the opposite
      // direction rather than mutating settled history, which keeps the ledger
      // append-only and leaves both legs visible to an auditor.
      const originatorAccountId = (ach.originator as { account_id?: string } | null)?.account_id;
      if (!originatorAccountId) {
        return apiError(409, "not_reversible", requestId, {
          title: "Not Reversible",
          detail: "settled ACH entry has no originator account to credit back",
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
      const reversal = await recordTransaction(cfg, {
        // ':return' leg keeps the reference unique, so the reversal cannot be
        // mistaken for a duplicate of the original entry
        coreResource: { table: "ach_transfer", id: achId },
        leg: "return",
        amountCents: ach.amount as number,
        currency: CURRENCY,
        source: ACH_NETWORK_BALANCE,
        destination: acct.blnk_balance_id as string,
        description: `ACH return${returnReason ? ` (${returnReason})` : ""}`,
        inflight: false,
      });
      blnkTxn = reversal.transaction;
    } else {
      blnkTxn = action === "settle"
        ? await commitInflight(cfg, ach.blnk_transaction_id)
        : await voidInflight(cfg, ach.blnk_transaction_id);
    }
  } catch (err) {
    if (err instanceof BlnkError) return bankErrorResponse(requestId);
    return internalErrorResponse(requestId, err);
  }

  const mirror = transactionMirror(blnkTxn);
  const patch: Record<string, unknown> = {
    status: terminal,
    synced_at: mirror.synced_at,
  };
  // Dedicated column since 20260719000500. This used to be mangled into
  // `window` ('next_day return:R01'), which corrupted the settlement window and
  // made the code unqueryable without a LIKE.
  if (returnReason) patch.return_reason = returnReason;

  const { data: updated, error: updErr } = await db.schema("core").from("ach_transfer")
    .update(patch)
    .eq("id", achId)
    .select(cols)
    .single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  // Evidence pair only where money MOVED: a settle commits the hold; a
  // post-settlement return moves it back via the compensating reversal. A
  // pre-settlement return merely voids the hold — nothing to book. Best-effort:
  // the ledger action is already final, so evidence failure must not 500.
  const movedMoney = action === "settle" || isPostSettlementReturn;
  if (movedMoney) {
    const verb = action === "settle" ? "settled" : "returned";
    try {
      await recordMovementArtifacts(db, {
        bkeId: `bke_${achId}_${verb}`,
        evtId: `evt_${achId}_${verb}`,
        code: `ach_transfer.${verb}`,
        resourceType: "ach_transfer",
        resourceId: achId,
        amountCents: ach.amount as number,
        accountId: (ach.originator as { account_id?: string } | null)?.account_id ?? null,
        payload: {
          amount_cents: ach.amount,
          ...(verb === "returned" ? { reason: returnReason ?? null } : {}),
          blnk_transaction_id: mirror.blnk_transaction_id,
        },
      });
    } catch (artErr) {
      console.error(`ach movement artifacts failed for ${achId}: ${artErr}`);
    }
  }

  // An unauthorized-return claim is a compliance event in its own right,
  // independent of whether money moved: R10 on a still-held entry is the same
  // customer assertion as R10 after settlement. Raised here rather than in
  // runGate because the gate authorises money LEAVING — by return time the
  // decision it governs is already made, and re-running it would double-count
  // this entry in the CG-VEL-01 daily aggregate (which already includes
  // 'settled' rows).
  if (returnReason && UNAUTHORIZED_RETURN_CODES.has(returnReason)) {
    const originatorAccountId = (ach.originator as { account_id?: string } | null)?.account_id;
    try {
      await raiseAlert(db, {
      ctx,
        alertType: "unauthorized_ach_return",
        entityHash: originatorAccountId ? await sha256Hex(originatorAccountId) : null,
        causeType: "ach_transfer",
        causeId: achId,
        details:
          `unauthorized ACH return ${returnReason} (${RETURN_CODES[returnReason]}) ` +
          `on ach_transfer_id=${achId}, amount_cents=${ach.amount}`,
      });
    } catch (alertErr) {
      // Best-effort like the movement artifacts: the return itself is already
      // final on the ledger and must not be undone by an evidence failure.
      console.error(`unauthorized-return alert failed for ${achId}: ${alertErr}`);
    }
  }

  return jsonResponse(achResponse(updated as AchRow), 200, requestId);
}

/**
 * POST /payments/ach/{id}/noc — record a notification of change.
 *
 * A NOC is NOT a return, and this endpoint deliberately writes no status. The
 * RDFI accepted and posted the entry; the C-code says the details were wrong
 * and obliges the ODFI to correct them for FUTURE entries (NACHA: within 6
 * banking days). Modelling it as a status change would report the member's
 * money as returned when it in fact settled.
 *
 * No Blnk call for the same reason: there is no hold to void and nothing to
 * commit. What it does produce is a durable event, because "we were told the
 * account number was wrong and did nothing" is the audit finding this exists to
 * prevent.
 */
export async function postAchNoc(
  req: Request,
  achId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const cols =
    "id, amount, status, counterparty, window, originator, return_reason, noc, blnk_transaction_id, blnk_reference, created_at";
  const { data: ach, error: selErr } = await scopeToPartner(
    db.schema("core").from("ach_transfer")
      .select(cols)
      .eq("id", achId),
    ctx,
  ).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!ach) return notFoundResponse(requestId, "ach_transfer", achId);

  const body = await parseJsonBody(req).catch(() => null);
  const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const code = rec.code;
  const corrections = rec.corrections;

  const errors: ValidationErrorItem[] = [];
  if (!isNonEmptyString(code)) {
    errors.push({ type: "missing_field", field: "code", message: "is required (e.g. C01)" });
  } else if (!(code in NOC_CODES)) {
    errors.push({
      type: "invalid_value",
      field: "code",
      message: `unrecognised NOC code; must be one of: ${Object.keys(NOC_CODES).join(", ")}`,
    });
  }
  if (corrections !== undefined && (corrections === null || typeof corrections !== "object" || Array.isArray(corrections))) {
    errors.push({ type: "invalid_value", field: "corrections", message: "must be an object" });
  }
  if (errors.length) return validationError(requestId, errors);

  const nocCode = code as string;
  const expected = NOC_CODES[nocCode];
  const given = corrections as Record<string, unknown> | undefined ?? {};

  // The code determines WHICH fields are being corrected, so a C01 carrying a
  // routing_number is a contradiction — one of the two is wrong and silently
  // keeping both would leave the ODFI correcting a field the RDFI never named.
  const unexpected = Object.keys(given).filter((k) => !expected.includes(k));
  if (unexpected.length) {
    return validationError(requestId, [{
      type: "invalid_value",
      field: "corrections",
      message: `${nocCode} corrects ${expected.join(", ")}; got unexpected ${unexpected.join(", ")}`,
    }]);
  }

  // A NOC on an entry that never reached the network has nothing to correct.
  if (ach.status === "pending_approval" || ach.status === "rejected") {
    return apiError(409, "invalid_state", requestId, {
      title: "Invalid State",
      detail: `ach_transfer ${achId} is ${ach.status}; a NOC only arrives for an entry that reached the RDFI`,
    });
  }

  const noc = {
    code: nocCode,
    received_at: new Date().toISOString(),
    corrections: given,
  };

  const { data: updated, error: updErr } = await db.schema("core").from("ach_transfer")
    .update({ noc })
    .eq("id", achId)
    .select(cols)
    .single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  // Deterministic id keyed on the code: a redelivered NOC for the same code
  // converges on one event, a genuinely different correction gets its own.
  try {
    await recordMovementArtifacts(db, {
      bkeId: `bke_${achId}_noc_${nocCode}`,
      evtId: `evt_${achId}_noc_${nocCode}`,
      code: "ach_transfer.noc.received",
      resourceType: "ach_transfer",
      resourceId: achId,
      // zero: a NOC moves no money. The bookkeeping row exists so the event has
      // the same evidence shape as every other rail transition, not because
      // there is a debit to book.
      amountCents: 0,
      accountId: (ach.originator as { account_id?: string } | null)?.account_id ?? null,
      payload: {
        noc_code: nocCode,
        corrects: expected,
        corrections: given,
        status_unchanged: ach.status,
      },
    });
  } catch (artErr) {
    console.error(`ach noc artifacts failed for ${achId}: ${artErr}`);
  }

  return jsonResponse(achResponse(updated as AchRow), 200, requestId);
}

// ---------------------------------------------------------------- reads

/**
 * `dual_control_status` is included for the same reason as on wires: an entry
 * id from GET /eps/pending-approvals is otherwise unresolvable. `window` comes
 * along because an ACH entry's settlement window is what tells an operator
 * whether a submitted entry is late or merely not due yet.
 */
const ACH_READ_COLS =
  "id, amount, counterparty, window, status, dual_control_status, return_reason, noc, " +
  "control_results, blnk_transaction_id, blnk_reference, created_at";

const ACH_STATUSES = [
  "pending_approval",
  "submitted",
  "settled",
  "returned",
  "rejected",
  "canceled",
];

type AchReadRow = AchRow & {
  dual_control_status: string;
  control_results?: { control_id: string; decision: string }[] | null;
};

function achReadResponse(row: AchReadRow): Record<string, unknown> {
  return {
    ...achResponse(row, row.control_results ?? []),
    dual_control_status: row.dual_control_status,
  };
}

/** GET /ach-transfers */
export async function getAchTransfers(
  req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const { limit, after, errors } = parsePageParams(q);

  const status = q.get("status");
  if (status !== null && !ACH_STATUSES.includes(status)) {
    errors.push({
      type: "invalid_value",
      field: "status",
      message: `must be one of: ${ACH_STATUSES.join(", ")}`,
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
    db.schema("core").from("ach_transfer").select(ACH_READ_COLS),
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
    pageEnvelope((await attachControlResults(db, page as unknown as AchReadRow[])).map(achReadResponse), {
      limit,
      has_more,
      next_after,
    }),
    200,
    requestId,
  );
}

/** GET /ach-transfers/{id}. 404 across partners, as on wires. */
export async function getAchTransfer(
  _req: Request,
  achId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  // As on wires: ach_transfer keys on uuid, so a malformed id is a cast error
  // in Postgres rather than an empty result. 404 before it gets there.
  if (!isUuid(achId)) return notFoundResponse(requestId, "ach_transfer", achId);

  const { data, error } = await scopeToPartner(
    db.schema("core").from("ach_transfer").select(ACH_READ_COLS).eq("id", achId),
    ctx,
  ).maybeSingle();
  if (error) return internalErrorResponse(requestId, error);
  if (!data) return notFoundResponse(requestId, "ach_transfer", achId);
  const [row] = await attachControlResults(db, [data as unknown as AchReadRow]);
  return jsonResponse(achReadResponse(row), 200, requestId);
}
