// blnk-reconcile sweeps — the heartbeat's actual work, importable for tests.
//
// Blnk is ledger source of truth; core.* holds cached mirrors. Blnk Cloud
// shipped self-serve global webhooks in July 2026, but these sweeps do not
// become optional: global webhooks are never retried on a non-2xx, so any
// delivery we fail to accept is gone for good. The push is the fast path; this
// pull is the guarantee. When a sweep advances a mirror it emits a durable
// blnk.mirror.recovered event: the recovery itself is evidence, and the card-16
// outbox delivers it like any other event.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getTransaction,
  getTransactionByReference,
  getBalance,
  searchTransactions,
  BlnkError,
  type BlnkConfig,
  type BlnkTransaction,
} from "../_shared/blnk.ts";
import { dispatch, openFinding } from "../blnk-webhook/handlers.ts";
import type { BlnkWebhook } from "../blnk-webhook/types.ts";

/**
 * Prefix every Blnk-issued balance id carries (`bln_<uuid>`).
 *
 * Used to tell a real mirror from a fixture placeholder. Kept as a constant so
 * the drift sweep and its test agree on what "could have come from Blnk" means.
 */
export const BLNK_BALANCE_ID_PREFIX = "bln_";

export const TXN_TABLES = ["ach_transfer", "wire_transfer", "transfer"] as const;
export const MIRROR_TABLES = [
  // opening deposits are stamped core_resource {table:"account"} (accounts.ts);
  // without it every funded open would read as an "unknown table" orphan
  "account",
  "ach_transfer",
  "wire_transfer",
  "transfer",
  "card_authorization",
] as const;

interface CardAuthRow {
  id: string;
  amount: number;
  status: string;
  blnk_inflight_id: string;
  blnk_committed_amount: number | null;
}

interface AccountRow {
  id: string;
  balance: number;
  blnk_balance_id: string;
}

export interface SweepError {
  table: string;
  id: string;
  error: string;
}

export function errMsg(e: unknown): string {
  if (e instanceof BlnkError || e instanceof Error) return e.message;
  return String(e);
}

// The mirror advance IS the recovered webhook: had Blnk been able to push, a
// transaction.* webhook would have carried this transition. Deterministic id
// keyed on (row, target status) makes re-sweeps idempotent.
async function emitMirrorRecovered(
  db: SupabaseClient,
  table: string,
  rowId: string,
  from: string,
  to: string,
  blnkTransactionId: string,
  errors: SweepError[],
): Promise<void> {
  const { error } = await db.schema("core").from("event").upsert({
    id: `evt_recon_${rowId}_${to.toLowerCase()}`,
    code: "blnk.mirror.recovered",
    type: "reconciliation",
    resource_id: `${table}:${rowId}`,
    payload: {
      table,
      id: rowId,
      from,
      to,
      blnk_transaction_id: blnkTransactionId,
    },
    created_at: new Date().toISOString(),
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) errors.push({ table: "event", id: rowId, error: error.message });
}

// A row examined against Blnk is synced even when nothing changed. Touching
// synced_at makes the oldest-first sweep window ROTATE: without it,
// permanently-inflight holds (live card auths, unresolved wires) monopolize
// the limit-25 window forever and fresh drops are never reached.
async function touchSynced(
  db: SupabaseClient,
  table: string,
  rowId: string,
  now: string,
  errors: SweepError[],
): Promise<void> {
  const { error } = await db.schema("core").from(table)
    .update({ synced_at: now }).eq("id", rowId);
  if (error) errors.push({ table, id: rowId, error: error.message });
}

// INFLIGHT parents stay INFLIGHT forever; terminal state lives in child txns.
async function resolveInflightChildren(
  cfg: BlnkConfig,
  parentTxnId: string,
): Promise<"VOID" | "APPLIED" | null> {
  const children = await searchTransactions(cfg, {
    q: "*",
    queryBy: "reference",
    filterBy: `parent_transaction:=${parentTxnId}`,
    perPage: 50,
  });
  if (children.length === 0) return null;
  if (children.some((c) => c.status === "VOID")) return "VOID";
  if (children.some((c) => c.status === "APPLIED")) return "APPLIED";
  return null;
}

/**
 * Blnk's search index serves `precise_amount` as a STRING ("30000"). Summing
 * only numbers made every partially captured hold re-sum to 0, and the sweep
 * then "repaired" the correct running total to 0 every run — live, on every
 * partial card capture (caught by the partner-flow suite).
 */
export function centsOf(v: unknown): number {
  if (typeof v === "number") return Number.isInteger(v) ? v : 0;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return 0;
}

function sumAppliedAmount(children: { status: string; precise_amount?: unknown }[]): number {
  return children
    .filter((c) => c.status === "APPLIED")
    .reduce((sum, c) => sum + centsOf(c.precise_amount), 0);
}

/**
 * Blnk's search index serves `created_at` as epoch SECONDS (1791071339), not
 * an ISO string. The missing-mirror sweep skipped anything that was not a
 * string, so it had examined nothing since 2026-07-15 and never once emitted
 * blnk.missing_mirror. Normalised to ISO; null when unusable.
 */
export function isoOf(v: unknown): string | null {
  let ms: number;
  if (typeof v === "number") ms = v < 1e12 ? v * 1000 : v;
  else if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    ms = n < 1e12 ? n * 1000 : n;
  } else if (typeof v === "string") ms = Date.parse(v);
  else return null;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// sweepTxnTable is GONE with core.<rail>.blnk_status (migration 20260817000500).
// It read that column, wrote that column, and touched nothing else — it never
// advanced a rail's business `status`, so nothing downstream ever acted on
// what it learned. A mirror maintained only by the code that maintains it is
// not evidence; the rails' own `status` is, and blnk-webhook plus
// sweepStuckRows keep the transaction ids that let anyone re-derive ledger
// state on demand.

export async function sweepCardAuthorization(
  db: SupabaseClient,
  cfg: BlnkConfig,
  errors: SweepError[],
  onSwept: (n: number) => void,
  onAdvanced: () => void,
): Promise<void> {
  const table = "card_authorization";
  // Selection keys on the BUSINESS status now that blnk_status is gone, and
  // that is the better predicate anyway: an open hold is one this core still
  // believes is open, not one whose ledger mirror happens to read INFLIGHT.
  const { data, error } = await db.schema("core").from(table)
    .select("id, amount, status, blnk_inflight_id, blnk_committed_amount")
    .not("blnk_inflight_id", "is", null)
    .in("status", ["authorized", "partially_captured"])
    .order("synced_at", { ascending: true, nullsFirst: true })
    .limit(25);

  if (error) {
    errors.push({ table, id: "*", error: error.message });
    return;
  }

  const rows = (data ?? []) as CardAuthRow[];
  onSwept(rows.length);

  for (const row of rows) {
    try {
      const now = new Date().toISOString();
      const children = await searchTransactions(cfg, {
        q: "*",
        queryBy: "reference",
        filterBy: `parent_transaction:=${row.blnk_inflight_id}`,
        perPage: 50,
      });

      if (children.length === 0) {
        await touchSynced(db, table, row.id, now, errors);
        continue;
      }

      // The ledger released the hold while this core still shows it open. We
      // deliberately do NOT guess a business status: a void is a reversal or
      // an expiry depending on who decided, and those are different terminal
      // states with different meanings in a dispute. Previously this wrote
      // blnk_status='VOID' — recording the divergence in a column no code
      // read, which is indistinguishable from not noticing. Emit it instead.
      if (children.some((c) => c.status === "VOID")) {
        const { error: evtErr } = await db.schema("core").from("event").upsert({
          id: `evt_${row.id}_hold_released`,
          code: "blnk.hold_released_upstream",
          type: "reconciliation",
          resource_id: `${table}:${row.id}`,
          payload: {
            blnk_inflight_id: row.blnk_inflight_id,
            core_status: row.status,
            detail: "Blnk voided the hold; this core still shows it open. " +
              "Resolve as a reversal or an expiry — they are not the same event.",
          },
          created_at: now,
        }, { onConflict: "id", ignoreDuplicates: true });
        if (evtErr) errors.push({ table: "event", id: row.id, error: evtErr.message });
        else onAdvanced();
        await touchSynced(db, table, row.id, now, errors);
        continue;
      }

      // The one mirror on this row that IS read: cards.ts sizes the remaining
      // capture from blnk_committed_amount, so a drift here lets a merchant
      // over- or under-capture.
      const committed = sumAppliedAmount(children);
      if (committed !== (row.blnk_committed_amount ?? 0)) {
        const { error: updErr } = await db.schema("core").from(table).update({
          blnk_committed_amount: committed,
          synced_at: now,
        }).eq("id", row.id);
        if (updErr) errors.push({ table, id: row.id, error: updErr.message });
        else {
          onAdvanced();
          await emitMirrorRecovered(
            db, table, row.id,
            String(row.blnk_committed_amount ?? 0), String(committed),
            row.blnk_inflight_id, errors,
          );
        }
      } else {
        await touchSynced(db, table, row.id, now, errors);
      }
    } catch (e) {
      errors.push({ table, id: row.id, error: errMsg(e) });
    }
  }
}

export async function sweepBalances(
  db: SupabaseClient,
  cfg: BlnkConfig,
  errors: SweepError[],
  onSwept: (n: number) => void,
  onDrift: () => void,
): Promise<void> {
  const table = "account";
  // Only ids Blnk could have issued. The drill seeds live `ptnr_drill` accounts
  // with placeholder balance ids ("b" from the account.closed firer, "bal_1".."bal_l"
  // from the base fixtures) because api/wires.ts rejects an account whose
  // blnk_balance_id is null — so they cannot simply be nulled out. Without this
  // filter each one is a permanent `GET /balances/{id}` 404, re-swept every 5
  // minutes and growing with every drill run: 22 of them by 2026-08-11. A real
  // drift would then surface as error #23 in a channel that is always already
  // failing, which is precisely how the inbox backlog alarm decayed into noise.
  // TWO PASSES, and the order is the whole point.
  //
  // PRIORITY: accounts whose balance moved AFTER the mirror was last synced —
  // the only accounts whose mirror can actually be wrong. Since the FBO
  // position is a roll-up of these balances (20260817000100), one of these
  // sitting unswept is the position itself being wrong, not a stale display
  // value. Round-robin alone gave them a ~6.4h worst case (25 rows / 5 min
  // against 1,907 accounts); this makes it one run.
  //
  // TAIL: the original oldest-first pass, kept as the backstop. It is what
  // catches drift this process could not have predicted — a balance moved in
  // Blnk by something that is not our writer — which is drift the priority
  // query, keyed on OUR rail rows, is blind to by construction.
  const priority: AccountRow[] = [];
  const { data: pending, error: pErr } = await db.schema("core")
    .rpc("accounts_pending_resync", { p_limit: 25 });
  if (pErr) errors.push({ table, id: "*", error: `accounts_pending_resync: ${pErr.message}` });
  else priority.push(...((pending ?? []) as AccountRow[]));

  const remaining = Math.max(0, 25 - priority.length);
  let tail: AccountRow[] = [];
  if (remaining > 0) {
    const { data, error } = await db.schema("core").from(table)
      .select("id, balance, blnk_balance_id")
      .like("blnk_balance_id", `${BLNK_BALANCE_ID_PREFIX}%`)
      .order("balance_synced_at", { ascending: true, nullsFirst: true })
      .limit(remaining + priority.length);
    if (error) {
      errors.push({ table, id: "*", error: error.message });
      if (priority.length === 0) return;
    } else {
      const seen = new Set(priority.map((r) => r.id));
      tail = ((data ?? []) as AccountRow[]).filter((r) => !seen.has(r.id)).slice(0, remaining);
    }
  }

  const rows = [...priority, ...tail];
  onSwept(rows.length);

  for (const row of rows) {
    try {
      const blnkBal = await getBalance(cfg, row.blnk_balance_id);
      const actual = blnkBal.balance;
      if (typeof actual !== "number") {
        errors.push({ table, id: row.id, error: "balance response missing numeric balance" });
        continue;
      }

      const now = new Date().toISOString();
      if (actual !== row.balance) {
        const { error: updErr } = await db.schema("core").from(table).update({
          balance: actual,
          balance_synced_at: now,
        }).eq("id", row.id);
        if (updErr) {
          errors.push({ table, id: row.id, error: updErr.message });
          continue;
        }

        const { error: evtErr } = await db.schema("core").from("event").insert({
          id: crypto.randomUUID(),
          code: "blnk.balance_drift",
          type: "reconciliation",
          resource_id: row.id,
          payload: {
            blnk_balance_id: row.blnk_balance_id,
            mirrored: row.balance,
            actual,
          },
          created_at: now,
        });
        if (evtErr) errors.push({ table: "event", id: row.id, error: evtErr.message });
        else onDrift();
      } else {
        const { error: updErr } = await db.schema("core").from(table).update({
          balance_synced_at: now,
        }).eq("id", row.id);
        if (updErr) errors.push({ table, id: row.id, error: updErr.message });
      }
    } catch (e) {
      errors.push({ table, id: row.id, error: errMsg(e) });
    }
  }
}

async function emitMissingMirror(
  db: SupabaseClient,
  txn: BlnkTransaction,
  txnId: string,
  coreResource: { table?: string; id?: string } | undefined,
  reason: string,
  errors: SweepError[],
  onMissing: () => void,
): Promise<void> {
  const { data: existing, error: dedupErr } = await db.schema("core").from("event")
    .select("id")
    .eq("code", "blnk.missing_mirror")
    .eq("resource_id", txnId)
    .limit(1);

  if (dedupErr) {
    errors.push({ table: "event", id: txnId, error: dedupErr.message });
    return;
  }
  if (existing && existing.length > 0) return;

  const createdAt = isoOf(txn.created_at);
  const { error: insErr } = await db.schema("core").from("event").insert({
    id: crypto.randomUUID(),
    code: "blnk.missing_mirror",
    type: "reconciliation",
    resource_id: txnId,
    payload: {
      reason,
      transaction_id: txnId,
      reference: txn.reference ?? null,
      core_resource: coreResource ?? null,
      created_at: createdAt,
    },
    created_at: new Date().toISOString(),
  });
  if (insErr) {
    errors.push({ table: "event", id: txnId, error: insErr.message });
    return;
  }
  onMissing();
}

// Recovery for rows whose Blnk write may have landed but whose mirror update never
// did (crash between recordTransaction and the settle update): they carry a
// blnk_reference breadcrumb with no blnk_transaction_id, so every other sweep
// keys past them (they had no transaction id for the retired status sweep to
// fetch, and none for the missing-mirror walk to match against). Resolve via
// get-by-reference; flag unresolved stale rows for ops.
export async function sweepStuckRows(
  db: SupabaseClient,
  cfg: BlnkConfig,
  errors: SweepError[],
  onSwept: (n: number) => void,
  onRecovered: () => void,
): Promise<void> {
  const staleMs = 30 * 60 * 1000;
  for (const table of TXN_TABLES) {
    const { data, error } = await db.schema("core").from(table)
      .select("id, blnk_reference, synced_at")
      .is("blnk_transaction_id", null)
      .not("blnk_reference", "is", null)
      .limit(25);

    if (error) {
      errors.push({ table, id: "*", error: error.message });
      continue;
    }

    const rows = (data ?? []) as { id: string; blnk_reference: string; synced_at: string | null }[];
    onSwept(rows.length);

    for (const row of rows) {
      try {
        const txn = await getTransactionByReference(cfg, row.blnk_reference);
        const now = new Date().toISOString();
        if (txn) {
          const { error: updErr } = await db.schema("core").from(table).update({
            blnk_transaction_id: txn.transaction_id,
            synced_at: now,
          }).eq("id", row.id);
          if (updErr) errors.push({ table, id: row.id, error: updErr.message });
          else onRecovered();
          continue;
        }
        // Not in Blnk: the write never landed. Flag for ops once the breadcrumb is stale
        // (a live client retry may still resume it) — deduped like missing_mirror events.
        const ageMs = row.synced_at ? Date.now() - Date.parse(row.synced_at) : Infinity;
        if (ageMs > staleMs) {
          const resourceId = `${table}:${row.id}`;
          const { data: existing, error: dedupErr } = await db.schema("core").from("event")
            .select("id").eq("code", "blnk.stuck_row").eq("resource_id", resourceId).limit(1);
          if (dedupErr) {
            errors.push({ table: "event", id: resourceId, error: dedupErr.message });
            continue;
          }
          if (existing && existing.length > 0) continue;
          const { error: insErr } = await db.schema("core").from("event").insert({
            id: crypto.randomUUID(),
            code: "blnk.stuck_row",
            type: "reconciliation",
            resource_id: resourceId,
            payload: { table, id: row.id, blnk_reference: row.blnk_reference, synced_at: row.synced_at },
            created_at: now,
          });
          if (insErr) errors.push({ table: "event", id: resourceId, error: insErr.message });
        }
      } catch (e) {
        errors.push({ table, id: row.id, error: errMsg(e) });
      }
    }
  }
}

export async function sweepMissingMirrors(
  db: SupabaseClient,
  cfg: BlnkConfig,
  errors: SweepError[],
  onSwept: (n: number) => void,
  onMissing: () => void,
): Promise<void> {
  const { data: cursorRow, error: cursorErr } = await db.schema("core").from("blnk_sync_state")
    .select("last_cursor")
    .eq("resource", "missing_mirror")
    .maybeSingle();

  if (cursorErr) {
    errors.push({ table: "blnk_sync_state", id: "missing_mirror", error: cursorErr.message });
    return;
  }

  const effectiveCursor = (typeof cursorRow?.last_cursor === "string" && cursorRow.last_cursor)
    ? cursorRow.last_cursor
    : new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const cursorMs = Date.parse(effectiveCursor);

  const collected: BlnkTransaction[] = [];
  let newestSeen: string | null = null;
  let fetchedAny = false;
  // Grace window: a txn's mirror write may still be in flight on the command
  // path — too-young txns are neither examined nor cursor-advanced past, so the
  // next run picks them up instead of flagging a false missing_mirror.
  const eligibleMaxMs = Date.now() - 2 * 60 * 1000;

  try {
    const perPage = 100;
    for (let page = 1; page <= 5; page++) {
      const txns = await searchTransactions(cfg, {
        q: "*",
        queryBy: "reference",
        sortBy: "created_at:desc",
        perPage,
        page,
      });

      if (txns.length === 0) break;
      fetchedAny = true;

      let oldestMsOnPage = Infinity;
      for (const txn of txns) {
        const createdAt = isoOf(txn.created_at);
        if (createdAt === null) continue;
        const ms = Date.parse(createdAt);

        if (ms < oldestMsOnPage) oldestMsOnPage = ms;
        if (ms > eligibleMaxMs) continue; // too young — leave for the next run
        if (newestSeen === null || ms > Date.parse(newestSeen)) newestSeen = createdAt;
        if (ms >= cursorMs) collected.push(txn);
      }

      if (txns.length < perPage) break;
      if (oldestMsOnPage < cursorMs) break;
    }
  } catch (e) {
    errors.push({ table: "blnk_search", id: "*", error: errMsg(e) });
    return;
  }

  onSwept(collected.length);

  for (const txn of collected) {
    const txnId = txn.transaction_id;

    if (isoOf(txn.created_at) === null) {
      errors.push({ table: "blnk_search", id: txnId, error: "unparseable created_at" });
      continue;
    }

    const parentTxn = txn.parent_transaction;
    if (typeof parentTxn === "string" && parentTxn.length > 0) continue;

    const metaData = txn.meta_data;
    if (metaData?.synthetic === true) continue;

    const coreResourceRaw = metaData?.core_resource;
    const coreResource = (coreResourceRaw && typeof coreResourceRaw === "object")
      ? coreResourceRaw as { table?: string; id?: string }
      : undefined;

    if (!coreResource?.table || !coreResource?.id) {
      await emitMissingMirror(db, txn, txnId, coreResource, "no core_resource", errors, onMissing);
      continue;
    }

    if (!(MIRROR_TABLES as readonly string[]).includes(coreResource.table)) {
      await emitMissingMirror(db, txn, txnId, coreResource, "unknown table", errors, onMissing);
      continue;
    }

    const { data, error } = await db.schema("core").from(coreResource.table)
      .select("id")
      .eq("id", coreResource.id)
      .maybeSingle();

    if (error) {
      errors.push({ table: coreResource.table, id: coreResource.id, error: error.message });
      continue;
    }

    if (data === null) {
      await emitMissingMirror(db, txn, txnId, coreResource, "row missing", errors, onMissing);
    }
  }

  const now = new Date().toISOString();
  const newCursor = fetchedAny && newestSeen ? newestSeen : effectiveCursor;
  const { error: upsertErr } = await db.schema("core").from("blnk_sync_state").upsert({
    resource: "missing_mirror",
    last_cursor: newCursor,
    last_synced_at: now,
    updated_at: now,
  });
  if (upsertErr) {
    errors.push({ table: "blnk_sync_state", id: "missing_mirror", error: upsertErr.message });
  }
}

// ---- inbox re-dispatch (TODO §5b) -------------------------------------------
//
// The webhook always 200s once the delivery is safely STORED, marking the row
// `received` and then `processed`/`failed` by outcome. Anything still
// `received` past the grace period never finished dispatching (function
// timeout, cold dependency), and `failed` rows failed on a condition that may
// since have cleared — a monitor trip whose account row had not been written
// yet, for instance.
//
// Blnk never retries a delivery, so this sweep is the ONLY second chance those
// events get. It re-runs the identical dispatch the webhook uses, which is why
// that logic lives in blnk-webhook/handlers.ts rather than inside the HTTP
// entrypoint.

/** Grace period before a non-terminal inbox row is considered stalled. */
export const INBOX_STALE_MINUTES = 10;
/** Rows re-dispatched per run. Bounded like every other sweep. */
export const INBOX_LIMIT = 50;
/** Failed-inbox depth that stops being noise and starts being an incident. */
export const INBOX_FAILED_ALERT_THRESHOLD = 25;
/**
 * Re-dispatch failures before a row is parked as `dead_letter`.
 *
 * Retrying is right for a failure that MAY clear — a monitor trip whose account
 * row had not been written yet. It is wrong for one that never can: a synthetic
 * id with no core row, an unusable payload. Without a cap the second kind is
 * re-driven every 5 minutes forever (two July 2026 test rows did exactly that
 * for three and a half weeks) and permanently inflates the `failed` count that
 * trips blnk.inbox_backlog, so the backlog alarm decays into noise right when
 * real traffic needs it. Five spans ~25 minutes at the 5-minute cron.
 */
export const INBOX_MAX_ATTEMPTS = 5;

interface InboxRow {
  id: string;
  event: string;
  payload: { event?: string; data?: Record<string, unknown> } | null;
  status: string;
  attempts: number | null;
}

/**
 * Record a failed re-dispatch, parking the row once it is out of attempts.
 *
 * Dead-lettering is loud on purpose: the row stops being retried, so the only
 * thing left carrying it is a finding somebody owns. Reuses blnk-webhook's
 * openFinding rather than writing `finding` here — a second implementation of
 * "this needs an owner" is a second thing to get wrong.
 */
async function recordInboxFailure(
  db: SupabaseClient,
  errors: SweepError[],
  row: InboxRow,
  msg: string,
): Promise<void> {
  const table = "blnk_event";
  const attempts = (row.attempts ?? 0) + 1;
  const dead = attempts >= INBOX_MAX_ATTEMPTS;

  const { error: updErr } = await db.schema("core").from(table).update({
    status: dead ? "dead_letter" : "failed",
    error: msg,
    attempts,
    processed_at: new Date().toISOString(),
  }).eq("id", row.id);
  if (updErr) errors.push({ table, id: row.id, error: updErr.message });

  if (dead) {
    try {
      await openFinding(db, {
        key: `inbox.dead_letter:${row.id}`,
        description:
          `Blnk inbox event ${row.id} (${row.event}) failed ${attempts} re-dispatch ` +
          `attempts and was parked as dead_letter. Last error: ${msg}. ` +
          `Blnk never retries, so this delivery is lost unless it is replayed by hand.`,
        severity: "high",
        rootCause: "blnk_inbox_dead_letter",
      });
    } catch (e) {
      errors.push({ table: "finding", id: row.id, error: errMsg(e) });
    }
  }
  errors.push({ table, id: row.id, error: msg });
}

export async function sweepInbox(
  db: SupabaseClient,
  errors: SweepError[],
  onSwept: (n: number) => void,
  onRedispatched: () => void,
): Promise<void> {
  const table = "blnk_event";
  const cutoff = new Date(Date.now() - INBOX_STALE_MINUTES * 60_000).toISOString();

  // 'dead_letter' is deliberately absent: it is terminal, and re-including it
  // would restore exactly the forever-retry this cap exists to stop.
  const { data, error } = await db.schema("core").from(table)
    .select("id, event, payload, status, attempts")
    .in("status", ["received", "failed"])
    .lt("received_at", cutoff)
    .order("received_at", { ascending: true })
    .limit(INBOX_LIMIT);

  if (error) {
    errors.push({ table, id: "*", error: error.message });
    return;
  }

  const rows = (data ?? []) as InboxRow[];
  onSwept(rows.length);

  for (const row of rows) {
    // The stored payload IS the webhook body; re-dispatch is idempotent because
    // every handler underneath upserts on a deterministic id.
    const wh = row.payload;
    if (!wh?.event || typeof wh.data !== "object" || wh.data === null) {
      // An unusable payload can never become usable, so this counts as an
      // attempt like any other failure. Previously it just `continue`d, which
      // left the row swept — and skipped — on every single run, forever.
      await recordInboxFailure(db, errors, row, "inbox row has unusable payload");
      continue;
    }

    try {
      const outcome = await dispatch(db, wh as BlnkWebhook);
      const { error: updErr } = await db.schema("core").from(table).update({
        status: outcome,
        error: null,
        processed_at: new Date().toISOString(),
      }).eq("id", row.id);
      if (updErr) {
        errors.push({ table, id: row.id, error: updErr.message });
        continue;
      }
      onRedispatched();
    } catch (e) {
      await recordInboxFailure(db, errors, row, errMsg(e));
    }
  }

  // Depth check runs regardless of what this batch did: a backlog draining at
  // INBOX_LIMIT per run while new failures arrive faster is exactly the
  // condition that stays invisible if you only look at one batch.
  // dead_letter counts toward the backlog too: parking a row stops the retry
  // churn, it does not mean the delivery arrived. A growing dead-letter pile is
  // precisely an incident, and excluding it would let the cap hide the backlog
  // it was added to make legible.
  const { count, error: cntErr } = await db.schema("core").from(table)
    .select("id", { count: "exact", head: true })
    .in("status", ["failed", "dead_letter"]);
  if (cntErr) {
    errors.push({ table, id: "*", error: cntErr.message });
    return;
  }
  if ((count ?? 0) >= INBOX_FAILED_ALERT_THRESHOLD) {
    const { error: evtErr } = await db.schema("core").from("event").insert({
      id: crypto.randomUUID(),
      code: "blnk.inbox_backlog",
      type: "reconciliation",
      resource_id: "blnk_event",
      payload: { failed_count: count, threshold: INBOX_FAILED_ALERT_THRESHOLD },
      created_at: new Date().toISOString(),
    });
    if (evtErr) errors.push({ table: "event", id: "blnk.inbox_backlog", error: evtErr.message });
  }
}
