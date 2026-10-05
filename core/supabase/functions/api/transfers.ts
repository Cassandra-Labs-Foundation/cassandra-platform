import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type BlnkConfig,
  BlnkError,
  blnkReference,
  getBalance,
  recordTransaction,
} from "../_shared/blnk.ts";
import { type AccountRow } from "./accounts.ts";
import { provenanceFor, raiseAlert } from "./bsa.ts";
import {
  apiError,
  bankErrorResponse,
  claimIdempotency,
  dollarsFromCents,
  internalErrorResponse,
  isNonEmptyString,
  jsonResponse,
  notFoundResponse,
  pageEnvelope,
  paginate,
  parseJsonBody,
  parsePageParams,
  sha256Hex,
  storeIdempotencyResponse,
  transferRequestHash,
  validationError,
  type ValidationErrorItem,
} from "./lib.ts";
import { scopeToPartner } from "./ownership.ts";
import { type PartnerContext } from "./auth.ts";
import { safeModeGate } from "./member_protection.ts";

export interface TransferRow {
  id: string;
  amount: number;
  status: string;
  originator: { account_id: string };
  beneficiary: { account_id: string };
  counterparty: unknown;
  blnk_transaction_id: string | null;
  blnk_reference: string | null;
  synced_at: string | null;
  created_at: string;
}

export interface ControlResultRef {
  control_id: string;
  decision: string;
}

type GateBlocked = { blocked: true; status: number; body: Record<string, unknown> };
type GatePassed = { blocked: false; controlResults: ControlResultRef[] };

export type GateOutcome = GateBlocked | GatePassed;

/**
 * Identifies the money-movement row being gated, so the same controls can run
 * over any rail (book transfer, wire, …) instead of only `core.transfer`.
 * `table` is where a blocking control writes the rejected status; `label` is
 * the human phrasing used in the BSA alert narrative.
 */
export interface GateResource {
  table: string;
  type: string;
  id: string;
  label: string;
  /**
   * Status a blocking control writes to this rail's row. Rails do not share a
   * vocabulary: book/wire/ACH use 'rejected', but card_authorization's CHECK
   * only permits 'declined' (cards decline, they do not reject). Writing the
   * wrong one violates the constraint and throws instead of blocking cleanly.
   */
  rejectedStatus: string;
}

/** safe_mode.restricted_types vocabulary, keyed by rail table */
const SAFE_MODE_TXN_TYPE: Record<string, string> = {
  transfer: "transfer",
  wire_transfer: "wire",
  ach_transfer: "ach",
  card_authorization: "card",
};

export const TRANSFER_RESOURCE = (id: string): GateResource => ({
  table: "transfer",
  type: "transfer",
  id,
  label: "book transfer",
  rejectedStatus: "rejected",
});

export async function runGate(
  db: SupabaseClient,
  cfg: BlnkConfig,
  resource: GateResource,
  sourceAccount: AccountRow,
  destAccount: AccountRow | null,
  amountCents: number,
  ctx?: PartnerContext,
): Promise<GateOutcome> {
  const controlResults: ControlResultRef[] = [];
  const sourceAccountId = sourceAccount.id;
  const transferId = resource.id;

  // RS-03: while safe mode is active its cap and restricted types gate BEFORE
  // the ordinary controls — resolution posture outranks them, and the decision
  // (either way) leaves safe_mode.transaction.decided evidence. This lived in
  // the book-transfer handler only, so wires, ACH and card holds sailed past an
  // active safe mode (caught by the member-protection flow). runGate is the
  // one door every rail goes through.
  const safeMode = await safeModeGate(
    db, amountCents, SAFE_MODE_TXN_TYPE[resource.table] ?? resource.type, transferId, ctx,
  );
  if (safeMode.restricted) {
    const { error: rejErr } = await db.schema("core").from(resource.table)
      .update({ status: resource.rejectedStatus })
      .eq("id", transferId);
    if (rejErr) throw new Error(`${resource.table} reject update (safe mode): ${rejErr.message}`);
    return {
      blocked: true,
      status: 423,
      body: {
        status: 423,
        type: "safe_mode_restricted",
        title: "Safe Mode Restricted",
        detail: safeMode.reason,
        doc_url: "https://api.cassandra.bank/docs/errors/safe-mode-restricted",
        resource_id: transferId,
        resource_type: resource.type,
      },
    };
  }

  // CG-VEL-01 is a per-account DAILY cap, so it must aggregate every rail the
  // member can move money on. Summing only core.transfer would let them evade
  // the cap by splitting across rails — or send unlimited wires, since wire
  // volume would never count. Both tables key the source account the same way
  // (`originator` -> {account_id}).
  // DO NOT add a partner_id predicate to the sweeps below. Every rail now
  // carries an owner, so scoping them looks like an obvious tightening — it is
  // the opposite. CTR aggregation and structuring detection are obligations of
  // the chartered credit union across every fintech it hosts, and a narrowed
  // aggregate fails OPEN: it returns fewer rows, the threshold is never
  // reached, and the control still writes a clean passing control_result. A
  // cap that never trips is indistinguishable from a cap that was never
  // exceeded. Confinement belongs at the API boundary (ownership.ts), which is
  // where the caller is; this is the bank's own view of its own book.
  const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const RAILS = ["transfer", "wire_transfer", "ach_transfer", "card_authorization"] as const;
  let velErr: { message: string } | null = null;
  const railRows: { amount: number }[] = [];
  for (const rail of RAILS) {
    let q = db.schema("core").from(rail)
      .select("amount")
      .contains("originator", { account_id: sourceAccountId })
      .in("status", [
        // book / wire / ach
        "pending_approval", "submitted", "settled", "completed",
        // card_authorization uses its own vocabulary; an open or drawn-down
        // hold is committed outbound volume for velocity purposes
        "authorized", "partially_captured", "captured",
      ])
      .gte("created_at", todayStart);
    // Exclude the in-flight row only on ITS OWN rail. Applying .neq("id", ...)
    // across rails sends a text id (tr_...) at wire_transfer.id (uuid) and
    // Postgres errors on the cast — which took down book transfers entirely.
    if (rail === resource.table) q = q.neq("id", transferId);
    const { data, error } = await q;
    if (error) { velErr = error; break; }
    railRows.push(...((data ?? []) as { amount: number }[]));
  }
  const velocityRows = railRows;

  if (velErr) throw new Error(`velocity query: ${velErr.message}`);

  const priorSum = (velocityRows ?? []).reduce(
    (sum, row) => sum + (row as { amount: number }).amount,
    0,
  );
  if (priorSum + amountCents > 2_500_000) {
    const crId = `cr_${crypto.randomUUID()}`;
    const { error: crErr } = await db.schema("core").from("control_result").insert({
      id: crId,
      // evidence written under the shared bootstrap credential is
      // `demo`: real evaluation of manufactured traffic (seed.sh)
      provenance: provenanceFor("core", ctx),
      control_id: "CG-VEL-01",
      decision: "block",
      event: transferId,
      subject_ref: sourceAccountId,
      score: null,
    });
    if (crErr) throw new Error(`control_result insert (CG-VEL-01): ${crErr.message}`);
    controlResults.push({ control_id: "CG-VEL-01", decision: "block" });

    const { error: rejErr } = await db.schema("core").from(resource.table)
      .update({ status: resource.rejectedStatus })
      .eq("id", transferId);
    if (rejErr) throw new Error(`${resource.table} reject update (velocity): ${rejErr.message}`);

    return {
      blocked: true,
      status: 422,
      body: {
        status: 422,
        type: "velocity_limit_exceeded",
        title: "Velocity Limit Exceeded",
        detail: "Daily outbound transfer volume exceeds $25,000",
        doc_url: "https://api.cassandra.bank/docs/errors/velocity-limit-exceeded",
        resource_id: transferId,
        resource_type: resource.type,
      },
    };
  }

  if (amountCents > 1_000_000) {
    const crId = `cr_${crypto.randomUUID()}`;
    const entityHash = await sha256Hex(sourceAccountId);

    const { error: crErr } = await db.schema("core").from("control_result").insert({
      id: crId,
      // evidence written under the shared bootstrap credential is
      // `demo`: real evaluation of manufactured traffic (seed.sh)
      provenance: provenanceFor("core", ctx),
      control_id: "CG-LGTXN-01",
      decision: "pass",
      event: transferId,
      subject_ref: sourceAccountId,
    });
    if (crErr) throw new Error(`control_result insert (CG-LGTXN-01): ${crErr.message}`);
    controlResults.push({ control_id: "CG-LGTXN-01", decision: "pass" });

    // raiseAlert writes the causing core.event FIRST and points the alert at it,
    // so event_id is populated (OQ-05). It used to be forced NULL by the FK.
    await raiseAlert(db, {
      ctx,
      alertType: "ctr_threshold",
      entityHash,
      causeType: resource.type,
      causeId: transferId,
      details: `${resource.label} over $10,000 (${resource.type}_id=${transferId}, amount_cents=${amountCents})`,
    });
  }

  // CG-STR-02 — OUTBOUND structuring.
  //
  // CG-STR-01 watches inflow to a destination account, but wires, ACH and card
  // have no destination row (funds leave for an @external balance), so a member
  // structuring money OUT was invisible to it. CG-VEL-01 blocks the same flow
  // only at $25k; nothing watched the $10k reportability line on the way out.
  //
  // Reuses priorSum — the cross-rail daily outflow velocity already computed —
  // so this costs no extra query. Only evaluated when the per-transaction gate
  // stayed silent, and never on a blocked payment (velocity returns above).
  if (amountCents <= 1_000_000 && priorSum + amountCents > 1_000_000) {
    const crId = `cr_${crypto.randomUUID()}`;
    const outflow = priorSum + amountCents;

    const { error: crErr } = await db.schema("core").from("control_result").insert({
      id: crId,
      // evidence written under the shared bootstrap credential is
      // `demo`: real evaluation of manufactured traffic (seed.sh)
      provenance: provenanceFor("core", ctx),
      control_id: "CG-STR-02",
      decision: "pass",
      event: transferId,
      subject_ref: sourceAccountId,
    });
    if (crErr) throw new Error(`control_result insert (CG-STR-02): ${crErr.message}`);
    controlResults.push({ control_id: "CG-STR-02", decision: "pass" });

    await raiseAlert(db, {
      ctx,
      alertType: "structuring",
      entityHash: await sha256Hex(sourceAccountId),
      causeType: resource.type,
      causeId: transferId,
      details:
        `aggregate OUTBOUND over $10,000 with no single transaction above it ` +
        `(account_id=${sourceAccountId}, daily_outflow_cents=${outflow}, ` +
        `this_${resource.type}_id=${transferId})`,
    });
  }

  // CG-STR-01 — structuring / aggregate CTR.
  //
  // CG-STR-01 catches what CG-LGTXN-01 structurally cannot: the per-transaction
  // gate sees one transfer at a time, so a member can stay under $10k on every
  // single transfer and still move a reportable amount into one account in a
  // day. Sum today's inflow to the destination and alert when the AGGREGATE
  // crosses the line. Only evaluated when the per-txn gate stayed silent
  // (amount <= $10k), so a single large transfer raises CG-LGTXN-01, not both.
  //
  // Wires have no destination account row (funds leave for @FedWire), so this
  // is inherently book-side; outbound structuring is a separate control.
  if (destAccount && amountCents <= 1_000_000) {
    const { data: inflowRows, error: inErr } = await db.schema("core").from("transfer")
      .select("amount")
      .contains("beneficiary", { account_id: destAccount.id })
      .in("status", ["pending_approval", "submitted", "settled"])
      .neq("id", transferId)
      .gte("created_at", todayStart);
    if (inErr) throw new Error(`structuring query: ${inErr.message}`);

    const priorInflow = (inflowRows ?? []).reduce(
      (sum, row) => sum + (row as { amount: number }).amount,
      0,
    );
    const aggregate = priorInflow + amountCents;

    if (aggregate > 1_000_000) {
      const crId = `cr_${crypto.randomUUID()}`;
      const { error: crErr } = await db.schema("core").from("control_result").insert({
        id: crId,
        // evidence written under the shared bootstrap credential is
        // `demo`: real evaluation of manufactured traffic (seed.sh)
        provenance: provenanceFor("core", ctx),
        control_id: "CG-STR-01",
        decision: "pass",
        event: transferId,
        subject_ref: destAccount.id,
      });
      if (crErr) throw new Error(`control_result insert (CG-STR-01): ${crErr.message}`);
      controlResults.push({ control_id: "CG-STR-01", decision: "pass" });

      await raiseAlert(db, {
      ctx,
        alertType: "structuring",
        entityHash: await sha256Hex(destAccount.id),
        causeType: resource.type,
        causeId: transferId,
        details:
          `aggregate inflow over $10,000 with no single transfer above it ` +
          `(account_id=${destAccount.id}, daily_inflow_cents=${aggregate}, ` +
          `this_${resource.type}_id=${transferId})`,
      });
    }
  }

  const blnkBal = await getBalance(cfg, sourceAccount.blnk_balance_id!);
  // Funds already held by a pending wire/ACH/card hold are spoken for. Using
  // the settled balance alone let a second hold pass this check; Blnk then
  // refused to place it and the member got a bare 502 instead of a typed
  // insufficient_funds with CG-NSF-01 evidence (caught by the partner-flow
  // suite: two $900 wires against $1,000).
  const available = typeof blnkBal.balance === "number"
    ? blnkBal.balance - (blnkBal.inflight_debit_balance ?? 0)
    : 0;

  if (available < amountCents) {
    const crId = `cr_${crypto.randomUUID()}`;
    const { error: crErr } = await db.schema("core").from("control_result").insert({
      id: crId,
      // evidence written under the shared bootstrap credential is
      // `demo`: real evaluation of manufactured traffic (seed.sh)
      provenance: provenanceFor("core", ctx),
      control_id: "CG-NSF-01",
      decision: "reject",
      event: transferId,
      subject_ref: sourceAccountId,
    });
    if (crErr) throw new Error(`control_result insert (CG-NSF-01): ${crErr.message}`);
    controlResults.push({ control_id: "CG-NSF-01", decision: "reject" });

    const { error: rejErr } = await db.schema("core").from(resource.table)
      .update({ status: resource.rejectedStatus })
      .eq("id", transferId);
    if (rejErr) throw new Error(`${resource.table} reject update (NSF): ${rejErr.message}`);

    const detail =
      `Insufficient funds: available $${dollarsFromCents(available)}, ` +
      `requested $${dollarsFromCents(amountCents)}`;

    return {
      blocked: true,
      status: 422,
      body: {
        status: 422,
        type: "insufficient_funds",
        title: "Insufficient Funds",
        detail,
        doc_url: "https://api.cassandra.bank/docs/errors/insufficient-funds",
        resource_id: transferId,
        resource_type: resource.type,
      },
    };
  }

  return { blocked: false, controlResults };
}

/**
 * Card-31 evidence trio: one settled transfer must leave (1) the mirror on the
 * transfer row, (2) a bookkeeping entry, (3) a `transfer.settled` event. The
 * mirror was always written; this records the other two.
 *
 * Ids are DETERMINISTIC (`bke_<id>`, `evt_<id>_settled`) and the writes are
 * duplicate-ignoring upserts, so the idempotency RESUME path — a retry
 * re-running settlement after a mid-flight crash — converges on the same rows
 * instead of double-counting the GL record.
 *
 * account_code_5300 "018" = NCUA 5300 Total Shares & Deposits: an on-us book
 * transfer is a within-shares reclassification (net zero at the GL level); the
 * entry records the movement against that line.
 */
/**
 * Evidence pair for a MONEY MOVEMENT: one bookkeeping entry + one event.
 * Written wherever funds actually move — settle/confirm/capture and
 * compensating reversals — and deliberately NOT for holds, voids or cancels
 * (nothing moved, the row's status is the record).
 *
 * Ids are caller-chosen but must be DETERMINISTIC for the movement, and the
 * writes ignore duplicates, so an idempotency RESUME retry converges on the
 * same rows instead of double-counting the GL.
 *
 * Amounts are MAGNITUDES; direction lives in the event code/payload
 * (`*.settled`/`*.completed`/`*.captured` = outbound or on-us,
 * `*.returned` = funds moving back). account_code_5300 "018" (Total Shares &
 * Deposits) is the demo GL line every member-money movement books against.
 */
export async function recordMovementArtifacts(
  db: SupabaseClient,
  p: {
    bkeId: string;
    evtId: string;
    code: string; // e.g. "wire_transfer.completed"
    resourceType: string;
    resourceId: string;
    amountCents: number;
    accountId: string | null;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const { error: bkeErr } = await db.schema("core").from("bookkeeping_entry").upsert({
    id: p.bkeId,
    amount: p.amountCents,
    account_code_5300: "018",
  }, { onConflict: "id", ignoreDuplicates: true });
  if (bkeErr) throw new Error(`bookkeeping_entry upsert: ${bkeErr.message}`);

  const { error: evtErr } = await db.schema("core").from("event").upsert({
    id: p.evtId,
    code: p.code,
    type: p.resourceType,
    resource_id: p.resourceId,
    // same convention as bsa_alert: sha256 of the acting account id
    entity_hash: p.accountId ? await sha256Hex(p.accountId) : null,
    payload: p.payload,
    created_at: new Date().toISOString(),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (evtErr) throw new Error(`event upsert: ${evtErr.message}`);
}

/**
 * Card-31 evidence trio for the book-transfer rail: mirror (on the row) +
 * bookkeeping entry + transfer.settled event. Thin wrapper so the original
 * deterministic ids (bke_<id>, evt_<id>_settled) stay stable.
 */
export async function recordSettlementArtifacts(
  db: SupabaseClient,
  p: {
    transferId: string;
    amountCents: number;
    sourceAccountId: string;
    destAccountId: string;
    blnkTransactionId: string | null;
  },
): Promise<void> {
  await recordMovementArtifacts(db, {
    bkeId: `bke_${p.transferId}`,
    evtId: `evt_${p.transferId}_settled`,
    code: "transfer.settled",
    resourceType: "transfer",
    resourceId: p.transferId,
    amountCents: p.amountCents,
    accountId: p.sourceAccountId,
    payload: {
      amount_cents: p.amountCents,
      source_account_id: p.sourceAccountId,
      destination_account_id: p.destAccountId,
      blnk_transaction_id: p.blnkTransactionId,
    },
  });
}

async function loadControlResults(
  db: SupabaseClient,
  transferId: string,
): Promise<ControlResultRef[]> {
  const { data, error } = await db.schema("core").from("control_result")
    .select("control_id, decision")
    .eq("event", transferId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`control_result fetch: ${error.message}`);
  return (data ?? []) as ControlResultRef[];
}

/**
 * Fill `control_results` on wire/ACH/card read rows from core.control_result —
 * the table the gate actually writes. Those tables carry a `control_results`
 * jsonb column that no writer has ever populated, so reads built on it told the
 * partner no control fired on an entry that raised CG-LGTXN-01 (caught by the
 * partner-flow suite). One query per page, keyed on event = resource id.
 */
export async function attachControlResults<
  T extends { id: string; control_results?: ControlResultRef[] | null },
>(db: SupabaseClient, rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const { data, error } = await db.schema("core").from("control_result")
    .select("event, control_id, decision")
    .in("event", rows.map((r) => r.id))
    .order("created_at", { ascending: true });
  if (error) throw new Error(`control_result fetch: ${error.message}`);
  const byEvent = new Map<string, ControlResultRef[]>();
  for (const c of (data ?? []) as (ControlResultRef & { event: string })[]) {
    const list = byEvent.get(c.event) ?? [];
    list.push({ control_id: c.control_id, decision: c.decision });
    byEvent.set(c.event, list);
  }
  for (const r of rows) r.control_results = byEvent.get(r.id) ?? [];
  return rows;
}

async function validateAccount(
  db: SupabaseClient,
  accountId: string,
): Promise<{ ok: true; account: AccountRow } | { ok: false; body: Record<string, unknown> }> {
  const { data, error } = await db.schema("core").from("account")
    .select("id, account_type, balance, blnk_ledger_id, blnk_balance_id, balance_synced_at, lock_type, status, created_at")
    .eq("id", accountId)
    .maybeSingle();

  if (error) throw new Error(`account fetch: ${error.message}`);

  if (!data) {
    return {
      ok: false,
      body: {
        status: 422,
        type: "account_not_found",
        title: "Account Not Found",
        detail: "Account not found",
        doc_url: "https://api.cassandra.bank/docs/errors/account-not-found",
        resource_id: accountId,
        resource_type: "account",
      },
    };
  }

  const account = data as AccountRow;

  if (account.status !== "open") {
    return {
      ok: false,
      body: {
        status: 422,
        type: "account_not_open",
        title: "Account Not Open",
        detail: "Account is not open",
        doc_url: "https://api.cassandra.bank/docs/errors/account-not-open",
        resource_id: accountId,
        resource_type: "account",
      },
    };
  }

  if (account.lock_type !== "none") {
    return {
      ok: false,
      body: {
        status: 422,
        type: "account_locked",
        title: "Account Locked",
        detail: "Account is locked",
        doc_url: "https://api.cassandra.bank/docs/errors/account-locked",
        resource_id: accountId,
        resource_type: "account",
      },
    };
  }

  if (!account.blnk_balance_id) {
    return {
      ok: false,
      body: {
        status: 422,
        type: "account_not_provisioned",
        title: "Account Not Provisioned",
        detail: "Account has no Blnk balance",
        doc_url: "https://api.cassandra.bank/docs/errors/account-not-provisioned",
        resource_id: accountId,
        resource_type: "account",
      },
    };
  }

  return { ok: true, account };
}

async function refreshAccountBalance(
  db: SupabaseClient,
  cfg: BlnkConfig,
  account: AccountRow,
): Promise<void> {
  const blnkBal = await getBalance(cfg, account.blnk_balance_id!);
  if (typeof blnkBal.balance !== "number") {
    throw new Error("balance response missing numeric balance");
  }
  const syncedAt = new Date().toISOString();
  const { error } = await db.schema("core").from("account")
    .update({ balance: blnkBal.balance, balance_synced_at: syncedAt })
    .eq("id", account.id);
  if (error) throw new Error(`account balance update: ${error.message}`);
}

function errorResponse(
  status: number,
  requestId: string,
  body: Record<string, unknown>,
): Response {
  return jsonResponse({ ...body, request_id: requestId }, status, requestId);
}

export async function postTransfer(
  req: Request,
  db: SupabaseClient,
  cfg: BlnkConfig,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const idempotencyKey = req.headers.get("Idempotency-Key");
  if (!idempotencyKey) {
    return validationError(requestId, [{
      type: "missing_field",
      field: "Idempotency-Key",
      message: "required header",
    }]);
  }

  const raw = await parseJsonBody(req);
  const body = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const errors: ValidationErrorItem[] = [];

  const sourceAccountId = body.source_account_id;
  const destAccountId = body.destination_account_id;
  const amountCents = body.amount_cents;
  const description = body.description;

  if (!isNonEmptyString(sourceAccountId)) {
    errors.push({ type: "missing_field", field: "source_account_id", message: "required" });
  }
  if (!isNonEmptyString(destAccountId)) {
    errors.push({ type: "missing_field", field: "destination_account_id", message: "required" });
  }
  if (!Number.isSafeInteger(amountCents) || (amountCents as number) <= 0) {
    errors.push({
      type: "invalid_value",
      field: "amount_cents",
      message: "must be a positive integer",
    });
  }
  if (
    isNonEmptyString(sourceAccountId) &&
    isNonEmptyString(destAccountId) &&
    sourceAccountId === destAccountId
  ) {
    errors.push({
      type: "invalid_value",
      field: "destination_account_id",
      message: "must differ from source_account_id",
    });
  }

  if (errors.length) return validationError(requestId, errors);

  const amount = amountCents as number;
  const sourceId = sourceAccountId as string;
  const destId = destAccountId as string;
  const desc = typeof description === "string" ? description : null;

  const requestHash = await transferRequestHash({
    source_account_id: sourceId,
    destination_account_id: destId,
    amount_cents: amount,
    description: desc,
  });

  const freshTransferId = `tr_${crypto.randomUUID()}`;
  const claim = await claimIdempotency(db, ctx.idempotencyScope, idempotencyKey, requestHash, freshTransferId, "POST /transfers");

  if (claim.kind === "replay") {
    return jsonResponse(
      claim.responseBody,
      claim.responseStatus,
      requestId,
      { "Idempotent-Replayed": "true" },
    );
  }

  if (claim.kind === "conflict") {
    return apiError(409, "idempotency_key_reused", requestId, {
      title: "Idempotency Key Reused",
      detail: "Idempotency-Key was used with a different request body",
    });
  }

  const transferId = claim.kind === "resume" ? claim.transferId : freshTransferId;

  const sourceCheck = await validateAccount(db, sourceId);
  if (!sourceCheck.ok) {
    const stored = { ...sourceCheck.body, request_id: requestId };
    await storeIdempotencyResponse(db, ctx.idempotencyScope, idempotencyKey, 422, stored);
    return errorResponse(422, requestId, sourceCheck.body);
  }

  const destCheck = await validateAccount(db, destId);
  if (!destCheck.ok) {
    const stored = { ...destCheck.body, request_id: requestId };
    await storeIdempotencyResponse(db, ctx.idempotencyScope, idempotencyKey, 422, stored);
    return errorResponse(422, requestId, destCheck.body);
  }

  const sourceAccount = sourceCheck.account;
  const destAccount = destCheck.account;

  const { data: existingTransfer, error: xferFetchErr } = await scopeToPartner(
    db.schema("core").from("transfer")
      .select("id, amount, status, originator, beneficiary, counterparty, blnk_transaction_id, blnk_reference, synced_at, created_at")
      .eq("id", transferId),
    ctx,
  ).maybeSingle();
  if (xferFetchErr) throw new Error(`transfer fetch: ${xferFetchErr.message}`);

  let transferRow = existingTransfer as TransferRow | null;
  let createdAt = transferRow?.created_at ?? new Date().toISOString();

  if (!transferRow) {
    const { error: insErr } = await db.schema("core").from("transfer").insert({
      id: transferId,
      amount,
      status: "pending_approval",
      originator: { account_id: sourceId },
      beneficiary: { account_id: destId },
      counterparty: null,
      created_at: createdAt,
      partner_id: ctx.ownerPartnerId,
    });
    if (insErr) throw new Error(`transfer insert: ${insErr.message}`);
    transferRow = {
      id: transferId,
      amount,
      status: "pending_approval",
      originator: { account_id: sourceId },
      beneficiary: { account_id: destId },
      counterparty: null,
      blnk_transaction_id: null,
      blnk_reference: null,
      synced_at: null,
      created_at: createdAt,
    };
  } else {
    createdAt = transferRow.created_at;
  }

  const controlResults: ControlResultRef[] = [];
  let artifactsWarning: string | null = null;

  if (transferRow.status === "settled") {
    controlResults.push(...await loadControlResults(db, transferId));
  } else {
    // RS-03 safe mode is checked first inside runGate, for every rail.
    const gate = await runGate(db, cfg, TRANSFER_RESOURCE(transferId), sourceAccount, destAccount, amount, ctx);
    if (gate.blocked) {
      const stored = { ...gate.body, request_id: requestId };
      await storeIdempotencyResponse(db, ctx.idempotencyScope, idempotencyKey, gate.status, stored);
      return errorResponse(gate.status, requestId, gate.body);
    }
    controlResults.push(...gate.controlResults);

    try {
      const result = await recordTransaction(cfg, {
        coreResource: { table: "transfer", id: transferId },
        amountCents: amount,
        currency: "USD",
        source: sourceAccount.blnk_balance_id!,
        destination: destAccount.blnk_balance_id!,
        description: desc ?? `book transfer ${transferId}`,
      });

      const mirror = result.mirror;

      // Best-effort breadcrumb: persist the mirror immediately so blnk_reference /
      // blnk_transaction_id survive even if the settle-status update below fails with a
      // non-Blnk error after the Blnk write has already committed.
      const { error: breadcrumbErr } = await db.schema("core").from("transfer").update({
        blnk_transaction_id: mirror.blnk_transaction_id,
        blnk_reference: mirror.blnk_reference,
        synced_at: mirror.synced_at,
      }).eq("id", transferId);
      if (breadcrumbErr) {
        console.error(`transfer breadcrumb update failed for ${transferId}: ${breadcrumbErr.message}`);
      }

      const { error: updErr } = await db.schema("core").from("transfer").update({
        status: "settled",
        blnk_transaction_id: mirror.blnk_transaction_id,
        blnk_reference: mirror.blnk_reference,
        synced_at: mirror.synced_at,
      }).eq("id", transferId);
      if (updErr) throw new Error(`transfer settle update: ${updErr.message}`);

      transferRow = {
        ...transferRow,
        status: "settled",
        blnk_transaction_id: mirror.blnk_transaction_id,
        blnk_reference: mirror.blnk_reference,
        synced_at: mirror.synced_at,
      };

      // Money has moved; evidence rows are best-effort + reconciler-recoverable.
      try {
        await recordSettlementArtifacts(db, {
          transferId,
          amountCents: amount,
          sourceAccountId: sourceId,
          destAccountId: destId,
          blnkTransactionId: mirror.blnk_transaction_id,
        });
      } catch (artErr) {
        console.error(`settlement artifacts failed for ${transferId}: ${artErr}`);
        artifactsWarning = "failed to record settlement artifacts";
      }
    } catch (e) {
      if (e instanceof BlnkError) {
        const ref = blnkReference({ table: "transfer", id: transferId });
        const syncedAt = new Date().toISOString();
        await db.schema("core").from("transfer").update({
          blnk_reference: ref,
          synced_at: syncedAt,
        }).eq("id", transferId);
        return bankErrorResponse(requestId);
      }
      throw e;
    }
  }

  const warnings: string[] = [];
  if (artifactsWarning) warnings.push(artifactsWarning);
  try {
    await refreshAccountBalance(db, cfg, sourceAccount);
  } catch {
    warnings.push("failed to refresh source account balance");
  }
  try {
    await refreshAccountBalance(db, cfg, destAccount);
  } catch {
    warnings.push("failed to refresh destination account balance");
  }

  const successBody: Record<string, unknown> = {
    id: transferId,
    status: "settled",
    amount_cents: amount,
    source_account_id: sourceId,
    destination_account_id: destId,
    blnk_transaction_id: transferRow.blnk_transaction_id,
    control_results: controlResults,
    created_at: createdAt,
  };
  if (warnings.length) successBody.meta = { warnings };

  await storeIdempotencyResponse(db, ctx.idempotencyScope, idempotencyKey, 201, successBody);
  return jsonResponse(successBody, 201, requestId);
}

const TRANSFER_COLS =
  "id, status, amount, originator, beneficiary, blnk_transaction_id, created_at";

const TRANSFER_STATUSES = [
  "pending_approval",
  "submitted",
  "settled",
  "returned",
  "rejected",
  "canceled",
];

// Ids that may be interpolated into a PostgREST `or=` filter. That filter is a
// COMMA-SEPARATED expression list, so an id containing `,` or `)` would not be
// a bad lookup — it would be a second filter term of the caller's choosing.
// Every id this API mints is `<prefix>_<uuid>`; anything else is refused before
// it reaches the query string rather than escaped after.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function transferResponse(row: TransferRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    amount_cents: row.amount,
    originator: row.originator,
    beneficiary: row.beneficiary,
    blnk_transaction_id: row.blnk_transaction_id,
    created_at: row.created_at,
  };
}

/**
 * GET /transfers — one partner's transfers, newest first.
 *
 * `?account_id=` matches EITHER leg. A transfer is not owned by one side of
 * itself: the same row is a debit to the originator and a credit to the
 * beneficiary, and an account statement that showed only the legs where the
 * account happened to be the source would silently omit every payment received.
 * Sign is therefore the caller's to derive from which leg matched — this
 * endpoint reports the transfer, not a per-account ledger view.
 */
export async function getTransfers(
  req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const { limit, after, errors } = parsePageParams(q);

  const status = q.get("status");
  if (status !== null && !TRANSFER_STATUSES.includes(status)) {
    errors.push({
      type: "invalid_value",
      field: "status",
      message: `must be one of: ${TRANSFER_STATUSES.join(", ")}`,
    });
  }
  const accountId = q.get("account_id");
  if (accountId !== null && !SAFE_ID.test(accountId)) {
    errors.push({
      type: "invalid_value",
      field: "account_id",
      message: "must be an account id: letters, digits, underscore or hyphen",
    });
  }
  if (errors.length) return validationError(requestId, errors);

  let query = scopeToPartner(
    db.schema("core").from("transfer").select(TRANSFER_COLS),
    ctx,
  )
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (status) query = query.eq("status", status);
  if (accountId) {
    // ->> rather than jsonb containment: `cs.{"account_id":"..."}` puts braces
    // and a comma inside a comma-separated filter list, which PostgREST then
    // has to be told to re-quote. The arrow operator has no such characters.
    query = query.or(
      `originator->>account_id.eq.${accountId},beneficiary->>account_id.eq.${accountId}`,
    );
  }
  if (after) query = query.lt("created_at", after);

  const { data, error } = await query;
  if (error) return internalErrorResponse(requestId, error);

  const { page, has_more, next_after } = paginate(
    (data ?? []) as unknown as Record<string, unknown>[],
    limit,
  );
  return jsonResponse(
    pageEnvelope(
      (page as unknown as TransferRow[]).map(transferResponse),
      { limit, has_more, next_after },
    ),
    200,
    requestId,
  );
}

export async function getTransfer(
  transferId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const { data, error } = await scopeToPartner(
    db.schema("core").from("transfer")
      .select(TRANSFER_COLS)
      .eq("id", transferId),
    ctx,
  ).maybeSingle();

  if (error) return internalErrorResponse(requestId, error);
  if (!data) return notFoundResponse(requestId, "transfer", transferId);

  return jsonResponse(transferResponse(data as TransferRow), 200, requestId);
}
