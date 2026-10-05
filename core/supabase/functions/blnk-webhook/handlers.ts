// blnk-webhook handlers — event -> core writes.
//
// Split out of index.ts so the SAME dispatch can be driven from two places:
//   1. the live webhook (index.ts), on delivery;
//   2. the reconciler's inbox re-dispatch (blnk-reconcile), for rows that
//      arrived while a dependency was down.
// Blnk never retries a non-2xx delivery, so the re-driver is the only second
// chance an event gets — it must run the identical logic, not a copy of it.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type {
  BlnkWebhook,
  BlnkTransactionData,
  BlnkBalanceData,
  BlnkBalanceMonitorData,
  BlnkReconciliationData,
  BlnkBulkTransactionData,
  BlnkSystemErrorData,
} from "./types.ts";
import { blnkConfigFromEnv, getBalance, balanceMirror } from "../_shared/blnk.ts";
import { raiseAlert } from "../api/bsa.ts";
import { sha256Hex } from "../api/lib.ts";

const MONEY_TABLES = new Set([
  "ach_transfer", "wire_transfer", "transfer", "card_authorization",
]);

// ---- idempotency key --------------------------------------------------------
// No stable delivery id in the payload, so derive one that dedups retries of the
// SAME logical event: event + the object it concerns.
export function eventKey(event: string, data: Record<string, unknown>): string {
  // balance.monitor is RECURRING against a fixed balance: the same monitor on the
  // same balance trips again next week and that is a genuinely new alert, not a
  // redelivery. Anchoring it on balance_id alone would collapse every future trip
  // into the first one's key and silently drop it as a duplicate. Discriminate on
  // whatever per-trip identity Blnk supplies.
  if (event === "balance.monitor") {
    const monitor = (data.monitor_id as string) ?? (data.balance_id as string) ?? "novel";
    // If Blnk sends no per-trip stamp, repeat trips on one monitor DO still
    // collapse. The pg_cron balance-monitor poll is the backstop for that case.
    const trip = (data.triggered_at as string) ?? (data.created_at as string) ??
      (data.timestamp as string) ?? "notrip";
    return `${event}:${monitor}:${trip}`;
  }

  const anchor =
    (data.transaction_id as string) ??
    (data.balance_id as string) ??
    (data.identity_id as string) ??
    (data.reconciliation_id as string) ??
    (data.batch_id as string) ??
    (data.ledger_id as string) ??
    (data.reference as string) ??
    payloadFingerprint(data);
  return `${event}:${anchor}`;
}

/**
 * Last-resort anchor for an event carrying none of the known ids.
 *
 * The previous fallback was the literal string "novel", which meant EVERY such
 * event of a given type shared one key — the first one landed and every one
 * after it was dropped as a duplicate, permanently, with no retry from Blnk.
 *
 * A fingerprint of the payload preserves the property we actually want: a
 * genuine redelivery has identical bytes and dedups, while a distinct event
 * hashes differently and gets its own row. Non-cryptographic (FNV-1a) because
 * this is a dedup key, not a security boundary, and eventKey must stay sync.
 */
function payloadFingerprint(data: Record<string, unknown>): string {
  const s = JSON.stringify(data);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fp${h.toString(16).padStart(8, "0")}`;
}

// ---- routing helpers --------------------------------------------------------
export function coreRef(data: { meta_data?: { core_resource?: { table: string; id: string } } | null }) {
  const r = data?.meta_data?.core_resource;
  return r && typeof r.table === "string" && typeof r.id === "string" ? r : null;
}

const ID_COLUMN: Record<string, string> = {
  ach_transfer: "blnk_transaction_id",
  wire_transfer: "blnk_transaction_id",
  transfer: "blnk_transaction_id",
  card_authorization: "blnk_inflight_id", // card auth = inflight hold
};

/**
 * The reference OUR writers stamped, recovered from the one Blnk sends back.
 *
 * Blnk's queued flow does not round-trip a reference unchanged. `POST
 * /transactions` returns a QUEUED *parent* carrying the reference we sent; when
 * it applies, Blnk creates a CHILD transaction whose reference is the parent's
 * with `_q` appended (`parent_transaction` points back at the parent), and the
 * webhook fires for the child. Our writers only ever generate `table:id[:leg]`
 * (see `_shared/blnk.ts`), so comparing the raw event reference against
 * `blnk_reference` can NEVER match a queued move: applyTransaction throws
 * "no core row", the inbox row is marked `failed`, and — since the sweep has no
 * attempt cap — it is re-driven every 5 minutes forever.
 *
 * Live-confirmed 2026-08-11: reference `ach_transfer:<id>` came back as
 * `ach_transfer:<id>_q` on the applied child. Only the `meta_data.core_resource`
 * route worked; the documented fallback was silently dead for every queued
 * transaction.
 */
export function coreReference(reference: string): string {
  return reference.endsWith("_q") ? reference.slice(0, -2) : reference;
}

async function applyTransaction(db: SupabaseClient, d: BlnkTransactionData): Promise<void> {
  const ref = coreRef(d);
  let table = ref?.table;
  let match: Record<string, string> = ref ? { id: ref.id } : {};

  // Fallback: locate by blnk_reference across money tables (needs Phase-2 writers
  // to have stamped blnk_reference = our resource id on the row). Match BOTH
  // spellings — the canonical one writers produce, and the `_q` child spelling an
  // earlier delivery may already have written onto the row — then update by
  // whichever value the row actually holds.
  const ourRef = d.reference ? coreReference(d.reference) : undefined;
  if (!table && d.reference) {
    const candidates = [...new Set([ourRef!, d.reference])];
    for (const t of MONEY_TABLES) {
      const { data: rows } = await db.schema("core").from(t)
        .select("id,blnk_reference").in("blnk_reference", candidates).limit(1);
      if (rows && rows.length) {
        table = t;
        match = { blnk_reference: (rows[0].blnk_reference as string) ?? d.reference };
        break;
      }
    }
  }
  // An opening deposit is stamped core_resource {table:"account"} (accounts.ts).
  // There is no money row to patch — the account's balance mirror is the only
  // thing it moves, and refreshBalanceMirrors handles that after this returns.
  // Throwing here failed EVERY funded open: 224 failed inbox rows, each later
  // dead-lettered into a HIGH finding (caught by the partner-flow suite).
  if (table === "account") return;
  if (!table || !MONEY_TABLES.has(table)) {
    throw new Error(`no core row for transaction ${d.transaction_id ?? d.reference ?? "?"}`);
  }

  const isCard = table === "card_authorization";
  const patch: Record<string, unknown> = {
    synced_at: new Date().toISOString(),
    // A card authorization is ONE hold with many child moves: each capture and
    // the final void is its own Blnk transaction carrying the same
    // core_resource. Writing the event's transaction_id here replaced the hold
    // id with a capture's id, and every later capture/reverse/expire then sent
    // PUT /transactions/inflight/<capture id> and got a 502. cards.ts owns the
    // hold id; the webhook only back-fills it below when the writer never did.
    ...(isCard ? {} : { [ID_COLUMN[table]]: d.transaction_id }),
    // Stamp the CANONICAL reference, never the `_q` child spelling: writers
    // generate the un-suffixed form and the reconciler's by-reference lookups
    // expect it, so persisting `_q` here would corrupt both.
    ...(ourRef ? { blnk_reference: ourRef } : {}),
  };
  // blnk_committed_amount is deliberately NOT written here. It is a running
  // total; this event carries one capture's amount, so copying it made a
  // partly captured card read as under-captured and waved over-captures past
  // the 422 guard. cards.ts maintains the total on every capture and the
  // reconciler (blnk-reconcile/sweeps.ts) re-sums the applied children.
  const { error } = await db.schema("core").from(table).update(patch).match(match);
  if (error) throw new Error(`update ${table}: ${error.message}`);
  if (isCard && d.status === "INFLIGHT" && d.transaction_id) {
    const { error: idErr } = await db.schema("core").from(table)
      .update({ blnk_inflight_id: d.transaction_id }).match(match).is("blnk_inflight_id", null);
    if (idErr) throw new Error(`backfill ${table}.blnk_inflight_id: ${idErr.message}`);
  }

  // TODO(phase-5): on APPLIED, refresh account.balance mirror for d.source/d.destination
  //   via Blnk GET /balances/{id}; raise control_result/bsa_alert on flagged moves.
}

async function applyBalance(db: SupabaseClient, d: BlnkBalanceData): Promise<void> {
  const ref = coreRef(d);
  if (!ref || ref.table !== "account") return;
  // Link the id only — never copy the payload's balance. balance.created
  // snapshots the balance at birth (always 0) and is delivered asynchronously,
  // usually AFTER POST /accounts has posted the opening deposit and written the
  // real figure, so copying it zeroed freshly funded accounts (caught live by
  // the partner-flow suite). Moves refresh the mirror via refreshBalanceMirrors.
  const { error } = await db.schema("core").from("account")
    .update({ blnk_balance_id: d.balance_id }).eq("id", ref.id);
  if (error) throw new Error(`update account: ${error.message}`);
}

/**
 * Open a finding. Used by the failure paths (reconciliation.failed,
 * bulk_transaction.failed, system.error) — a Blnk-side failure is an operational
 * exception someone has to own, not just a log line.
 *
 * Deterministic id so a redelivery converges on one finding. `provenance` is
 * 'production': these are real events off the real instance.
 */
export async function openFinding(
  db: SupabaseClient,
  p: { key: string; description: string; severity: string; rootCause: string },
): Promise<void> {
  const { error } = await db.schema("core").from("finding").upsert({
    id: await uuidFromKey(p.key),
    description: p.description,
    severity: p.severity,
    root_cause: p.rootCause,
    status: "open",
    department: "operations",
    provenance: "production",
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`finding insert: ${error.message}`);
}

/** core.finding.id is a uuid, so derive a stable one from the dedup key. */
async function uuidFromKey(key: string): Promise<string> {
  const h = await sha256Hex(`blnk-webhook:${key}`);
  // RFC-4122 v5-shaped: version nibble 5, variant bits 10xx.
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    ((parseInt(h.slice(16, 17), 16) & 0x3 | 0x8).toString(16)) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}

/**
 * §1 — refresh the account.balance mirror after a move.
 *
 * Transaction payloads carry source/destination BALANCE IDS but not the
 * resulting balances, so without this the mirror goes stale the moment money
 * moves. Best-effort by design: Blnk never retries a non-2xx, so a credential
 * problem here must not fail the delivery. The pg_cron balance-drift check in
 * blnk-reconcile stays the authority; this is the fast path, not the guarantee.
 */
async function refreshBalanceMirrors(db: SupabaseClient, d: BlnkTransactionData): Promise<void> {
  // '@'-prefixed balances are Blnk's external/world accounts — no core row.
  const ids = [d.source, d.destination]
    .filter((b): b is string => typeof b === "string" && b.length > 0 && !b.startsWith("@"));
  if (!ids.length) return;

  let cfg;
  try {
    cfg = blnkConfigFromEnv();
  } catch {
    // BLNK_API_URL/BLNK_API_KEY not set — mirror stays for the reconciler.
    console.warn("balance mirror refresh skipped: Blnk API creds unset");
    return;
  }

  for (const id of ids) {
    try {
      const mirror = balanceMirror(await getBalance(cfg, id));
      if (mirror.balance === null) continue;
      const { error } = await db.schema("core").from("account")
        .update(mirror).eq("blnk_balance_id", id);
      if (error) console.error(`balance mirror ${id}: ${error.message}`);
    } catch (e) {
      console.error(`balance fetch ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * §2 — a tripped balance monitor becomes a BSA alert.
 *
 * Delegates to the canonical `raiseAlert` rather than writing bsa_alert here:
 * it owns the BSA-06 2-business-day triage clock and the bsa_alert.created /
 * triage.timer events. A second implementation of a compliance deadline is a
 * second thing to get wrong.
 */
async function applyBalanceMonitor(db: SupabaseClient, d: BlnkBalanceMonitorData): Promise<void> {
  if (!d.balance_id) throw new Error("balance.monitor without balance_id");

  const { data: rows, error } = await db.schema("core").from("account")
    .select("id").eq("blnk_balance_id", d.balance_id).limit(1);
  if (error) throw new Error(`account lookup: ${error.message}`);
  if (!rows?.length) throw new Error(`no account for balance ${d.balance_id}`);
  const accountId = rows[0].id as string;

  // The monitor's PURPOSE decides the alert type, and only the configuring side
  // knows it — so we read it off meta_data and fall back to a generic type
  // rather than inventing a compliance classification from the raw condition.
  const alertType = d.meta_data?.alert_type ?? "balance_monitor";
  const cond = d.condition ?? {};
  const observed = d.value ?? d.balance;

  await raiseAlert(db, {
    alertType,
    entityHash: await sha256Hex(accountId),
    details:
      `Blnk balance monitor ${d.monitor_id ?? "(unnamed)"} tripped on balance ${d.balance_id}: ` +
      `${cond.field ?? "?"} ${cond.operator ?? "?"} ${cond.value ?? "?"}` +
      (observed !== undefined ? ` (observed ${observed})` : ""),
    causeType: "account",
    // Per-trip so a later trip of the same monitor is its own alert, matching
    // the per-trip inbox key in eventKey().
    causeId: `${accountId}_${d.monitor_id ?? d.balance_id}_${d.triggered_at ?? "notrip"}`,
  });
}

/** §3 — reconciliation run finished. Advance the cursor; unmatched items are findings. */
async function applyReconciliation(
  db: SupabaseClient,
  event: string,
  d: BlnkReconciliationData,
): Promise<void> {
  const reconId = d.reconciliation_id ?? "unknown";

  const { error: syncErr } = await db.schema("core").from("blnk_sync_state").upsert({
    resource: "reconciliation",
    last_cursor: reconId,
    last_synced_at: new Date().toISOString(),
  }, { onConflict: "resource" });
  if (syncErr) throw new Error(`blnk_sync_state: ${syncErr.message}`);

  if (event === "reconciliation.failed") {
    await openFinding(db, {
      key: `reconciliation.failed:${reconId}`,
      description: `Blnk reconciliation ${reconId} failed: ${d.reason ?? d.status ?? "no reason given"}`,
      severity: "high",
      rootCause: "blnk_reconciliation_failure",
    });
    return;
  }

  // completed: unmatched items are the compliance-relevant residue.
  if (typeof d.unmatched_count === "number" && d.unmatched_count > 0) {
    await openFinding(db, {
      key: `reconciliation.unmatched:${reconId}`,
      description:
        `Blnk reconciliation ${reconId} completed with ${d.unmatched_count} unmatched item(s) ` +
        `(${d.matched_count ?? "?"} matched). Unmatched ledger items require investigation.`,
      severity: "medium",
      rootCause: "unmatched_reconciliation_items",
    });
  }

  // TODO(§3): pull the MATCHED results into core.bookkeeping_entry. Blnk stores
  // them per-transaction in meta_data.reconciled, so this needs a paged
  // transaction fetch keyed off the reconciliation id plus a bookkeeping_entry
  // mapping neither the plan nor the schema pins down yet. Cursor is advanced
  // above, so a later backfill can pick this up from last_cursor.
}

/** §4 — batch outcome. Iterate constituents through the single-transaction path. */
async function applyBulkTransaction(
  db: SupabaseClient,
  event: string,
  d: BlnkBulkTransactionData,
): Promise<"processed" | "skipped"> {
  if (event === "bulk_transaction.failed") {
    await openFinding(db, {
      key: `bulk_transaction.failed:${d.batch_id ?? "unknown"}`,
      description: `Blnk bulk transaction batch ${d.batch_id ?? "(no id)"} failed: ${
        d.reason ?? d.status ?? "no reason given"
      }`,
      severity: "high",
      rootCause: "blnk_bulk_transaction_failure",
    });
    return "processed";
  }

  if (Array.isArray(d.transactions) && d.transactions.length) {
    // One bad constituent must not strand the rest: collect and report.
    const failures: string[] = [];
    for (const t of d.transactions) {
      try {
        await applyTransaction(db, t);
      } catch (e) {
        failures.push(`${t.transaction_id ?? t.reference ?? "?"}: ${
          e instanceof Error ? e.message : String(e)
        }`);
      }
    }
    if (failures.length) throw new Error(`bulk constituents failed — ${failures.join("; ")}`);
    return "processed";
  }

  // Id-only form: resolving it means N API reads inside a webhook that must
  // return fast and is never retried. The reconciler re-polls non-terminal rows
  // anyway, so leave it to that rather than fetching here.
  if (Array.isArray(d.transaction_ids) && d.transaction_ids.length) return "skipped";
  return "skipped";
}

/** Blnk internal async failure (v0.15.0). Ours to notice — nothing else surfaces it. */
async function applySystemError(db: SupabaseClient, d: BlnkSystemErrorData): Promise<void> {
  const detail = d.error ?? d.message ?? "no detail";
  await openFinding(db, {
    key: `system.error:${d.component ?? "blnk"}:${d.reference ?? detail}`,
    description: `Blnk reported an internal processing error${
      d.component ? ` in ${d.component}` : ""
    }: ${detail}`,
    severity: "high",
    rootCause: "blnk_internal_error",
  });
}

// event -> handler. Unlisted events are stored and marked 'skipped'.
export async function dispatch(db: SupabaseClient, wh: BlnkWebhook): Promise<"processed" | "skipped"> {
  switch (wh.event) {
    case "transaction.applied":
    case "transaction.inflight":
    case "transaction.void":
    case "transaction.rejected":
    case "transaction.scheduled": {
      const d = wh.data as BlnkTransactionData;
      await applyTransaction(db, d);
      // Only an APPLIED move changes balances; holds and voids do not.
      if (wh.event === "transaction.applied") await refreshBalanceMirrors(db, d);
      return "processed";
    }
    case "balance.created":
      await applyBalance(db, wh.data as BlnkBalanceData);
      return "processed";
    case "balance.monitor":
      await applyBalanceMonitor(db, wh.data as BlnkBalanceMonitorData);
      return "processed";
    case "reconciliation.completed":
    case "reconciliation.failed":
      await applyReconciliation(db, wh.event, wh.data as BlnkReconciliationData);
      return "processed";
    case "bulk_transaction.applied":
    case "bulk_transaction.inflight":
    case "bulk_transaction.failed":
      return await applyBulkTransaction(db, wh.event, wh.data as BlnkBulkTransactionData);
    case "system.error":
      await applySystemError(db, wh.data as BlnkSystemErrorData);
      return "processed";
    default:
      return "skipped";
  }
}
