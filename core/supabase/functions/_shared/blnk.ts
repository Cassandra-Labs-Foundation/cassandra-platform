// blnk — shared writer client for Blnk Finance Core REST API.
//
// Writer contract: every Blnk write carries reference = table:id[:leg] and
// meta_data.core_resource so webhooks/reconcilers can route ledger events back to
// Postgres core rows, and duplicate POSTs are idempotent on reference.
// Mirrors are returned for the caller to persist; this module never touches the DB.

export interface BlnkConfig {
  apiUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

export function blnkConfigFromEnv(): BlnkConfig {
  const apiUrl = Deno.env.get("BLNK_API_URL");
  const apiKey = Deno.env.get("BLNK_API_KEY");
  const missing: string[] = [];
  if (!apiUrl) missing.push("BLNK_API_URL");
  if (!apiKey) missing.push("BLNK_API_KEY");
  if (missing.length) throw new Error(`missing env: ${missing.join(", ")}`);
  return { apiUrl: apiUrl!, apiKey: apiKey! };
}

export class BlnkError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "BlnkError";
    this.status = status;
    this.body = body;
  }
}

export interface CoreResource {
  table: string;
  id: string;
}

export function blnkReference(res: CoreResource, leg?: string): string {
  return leg ? `${res.table}:${res.id}:${leg}` : `${res.table}:${res.id}`;
}

export function customerLedgerId(): string {
  return Deno.env.get("BLNK_CUSTOMER_LEDGER_ID") ?? "ldg_7d83bb57-a8a0-4fd9-a67e-9cd5fbe0e3ba";
}

export interface BlnkTransaction {
  transaction_id: string;
  reference: string;
  status: string;
  amount?: number;
  /** Blnk's search index returns this as a STRING; the transactions API as a number */
  precise_amount?: number | string;
  precision?: number;
  currency?: string;
  source?: string;
  destination?: string;
  hash?: string;
  meta_data?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface BlnkBalance {
  balance_id: string;
  ledger_id?: string;
  currency?: string;
  balance?: number;
  credit_balance?: number;
  debit_balance?: number;
  /** money held by pending inflight debits — spoken for, not yet moved */
  inflight_debit_balance?: number;
  identity_id?: string;
  meta_data?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface TransactionMirror {
  blnk_transaction_id: string;
  blnk_reference: string;
  synced_at: string;
  // For core.card_authorization the caller maps blnk_transaction_id -> blnk_inflight_id.
}

export interface RecordTransactionParams {
  coreResource: CoreResource;
  amountCents: number;
  currency: string;
  source: string;
  destination: string;
  description: string; // Blnk rejects blank descriptions; required narration on every txn
  inflight?: boolean;
  leg?: string;
  allowOverdraft?: boolean;
  skipQueue?: boolean;
  metaData?: Record<string, unknown>;
}

export interface RecordResult {
  transaction: BlnkTransaction;
  mirror: TransactionMirror;
  deduped: boolean;
}

export interface CreateBalanceParams {
  coreResource: CoreResource;
  currency: string;
  ledgerId?: string;
  identityId?: string;
  metaData?: Record<string, unknown>;
}

export interface BalanceMirror {
  blnk_balance_id: string;
  blnk_ledger_id?: string;
  balance_synced_at: string;
}

function baseUrl(cfg: BlnkConfig): string {
  return cfg.apiUrl.replace(/\/+$/, "");
}

function fetchFn(cfg: BlnkConfig): typeof fetch {
  return cfg.fetchFn ?? globalThis.fetch;
}

function validateAmountCents(amountCents: number): void {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new RangeError(`amountCents must be a positive safe integer, got ${amountCents}`);
  }
}

function stampMeta(
  coreResource: CoreResource,
  metaData?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...metaData,
    core_resource: { table: coreResource.table, id: coreResource.id },
  };
}

function errorText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") return JSON.stringify(body);
  return String(body ?? "");
}

function isDuplicateReferenceError(status: number, body: unknown): boolean {
  if (status < 400 || status >= 500) return false;
  const text = errorText(body);
  return /referen/i.test(text) && /(exist|duplicat|used)/i.test(text);
}

async function request<T>(
  cfg: BlnkConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${baseUrl(cfg)}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-blnk-key": cfg.apiKey,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetchFn(cfg)(url, init);
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    throw new BlnkError(
      `Blnk ${method} ${path} failed: ${res.status}`,
      res.status,
      parsed,
    );
  }
  return parsed as T;
}

export async function getTransaction(
  cfg: BlnkConfig,
  transactionId: string,
): Promise<BlnkTransaction> {
  return await request<BlnkTransaction>(cfg, "GET", `/transactions/${transactionId}`);
}

export interface SearchTransactionsParams {
  q: string;
  queryBy: string;
  filterBy?: string; // Typesense filter, e.g. `parent_transaction:=txn_...`
  perPage?: number;
  page?: number; // 1-based (Typesense)
  sortBy?: string; // e.g. `created_at:desc`
}

export async function searchTransactions(
  cfg: BlnkConfig,
  p: SearchTransactionsParams,
): Promise<BlnkTransaction[]> {
  const body: Record<string, unknown> = { q: p.q, query_by: p.queryBy };
  if (p.filterBy !== undefined) body.filter_by = p.filterBy;
  if (p.perPage !== undefined) body.per_page = p.perPage;
  if (p.page !== undefined) body.page = p.page;
  if (p.sortBy !== undefined) body.sort_by = p.sortBy;
  const data = await request<{ hits?: unknown }>(cfg, "POST", "/search/transactions", body);

  const hits = data?.hits;
  if (!Array.isArray(hits)) return [];
  const out: BlnkTransaction[] = [];
  for (const hit of hits) {
    if (!hit || typeof hit !== "object") continue;
    const doc = (hit as { document?: unknown }).document;
    if (!doc || typeof doc !== "object") continue;
    const txn = doc as BlnkTransaction;
    if (typeof txn.transaction_id === "string") out.push(txn);
  }
  return out;
}

export async function getTransactionByReference(
  cfg: BlnkConfig,
  reference: string,
): Promise<BlnkTransaction | null> {
  const hits = await searchTransactions(cfg, { q: reference, queryBy: "reference" });
  // Typesense `q` matches fuzzily; the idempotency path needs an exact reference.
  return hits.find((t) => t.reference === reference) ?? null;
}

export function recordTransaction(
  cfg: BlnkConfig,
  p: RecordTransactionParams,
): Promise<RecordResult> {
  validateAmountCents(p.amountCents);
  return recordTransactionInner(cfg, p);
}

async function recordTransactionInner(
  cfg: BlnkConfig,
  p: RecordTransactionParams,
): Promise<RecordResult> {
  const reference = blnkReference(p.coreResource, p.leg);
  // Blnk rejects amount + precise_amount together; precise (integer cents) is authoritative.
  const body: Record<string, unknown> = {
    precise_amount: p.amountCents,
    precision: 100,
    currency: p.currency,
    source: p.source,
    destination: p.destination,
    reference,
    description: p.description,
    meta_data: stampMeta(p.coreResource, p.metaData),
    skip_queue: p.skipQueue ?? true,
  };
  if (p.inflight !== undefined) body.inflight = p.inflight;
  if (p.allowOverdraft !== undefined) body.allow_overdraft = p.allowOverdraft;

  const url = `${baseUrl(cfg)}/transactions`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-blnk-key": cfg.apiKey,
    },
    body: JSON.stringify(body),
  };

  const res = await fetchFn(cfg)(url, init);
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    if (isDuplicateReferenceError(res.status, parsed)) {
      // Search is an eventually-consistent index: a just-created duplicate may not be
      // indexed yet (caller retries later; the write was rejected, so retrying is safe).
      // Re-fetch by id for authoritative state. NB Blnk inflight semantics: commit/void
      // creates a CHILD transaction and the parent stays status=INFLIGHT forever, so a
      // deduped inflight parent is not terminal truth — resolve via commit/void return
      // values or child-transaction lookup (reconciler).
      const indexed = await getTransactionByReference(cfg, reference);
      if (indexed) {
        let existing = indexed;
        try {
          existing = await getTransaction(cfg, indexed.transaction_id);
        } catch {
          // fall back to the index snapshot if the by-id read is unavailable
        }
        return {
          transaction: existing,
          mirror: transactionMirror(existing),
          deduped: true,
        };
      }
    }
    throw new BlnkError(
      `Blnk POST /transactions failed: ${res.status}`,
      res.status,
      parsed,
    );
  }

  const transaction = parsed as BlnkTransaction;
  return {
    transaction,
    mirror: transactionMirror(transaction),
    deduped: false,
  };
}

export function commitInflight(
  cfg: BlnkConfig,
  transactionId: string,
  opts?: { amountCents?: number },
): Promise<BlnkTransaction> {
  if (opts?.amountCents !== undefined) validateAmountCents(opts.amountCents);
  return commitInflightInner(cfg, transactionId, opts);
}

async function commitInflightInner(
  cfg: BlnkConfig,
  transactionId: string,
  opts?: { amountCents?: number },
): Promise<BlnkTransaction> {
  const body: Record<string, unknown> = { status: "commit" };
  if (opts?.amountCents !== undefined) {
    // Integer minor units, like every other money field. Sending major units
    // meant a division whose result is a FLOAT (40001/100 = 400.01 in IEEE
    // terms) on the money path — caught by the phase-0 float guard.
    body.precise_amount = opts.amountCents;
  }
  return await inflightPut(
    cfg,
    transactionId,
    body,
  );
}

export async function voidInflight(
  cfg: BlnkConfig,
  transactionId: string,
): Promise<BlnkTransaction> {
  return await inflightPut(cfg, transactionId, { status: "void" });
}

/**
 * PUT /transactions/inflight/{id}, retried while Blnk is still applying an
 * earlier commit/void on the same hold.
 *
 * Blnk applies an inflight commit asynchronously and refuses the next commit
 * or void on that hold with 409 GEN_CONFLICT "a commit or void is already
 * queued" until it has — live-measured at up to ~3s. Merchants capture
 * incrementally and reverse straight after a capture, so surfacing that as a
 * bank_error failed real card flows at random (caught by the partner-flow
 * suite). The refused request was never applied, so retrying it is safe.
 */
const INFLIGHT_RETRY_DELAYS_MS = [250, 500, 1000, 1500, 2000, 2500];

async function inflightPut(
  cfg: BlnkConfig,
  transactionId: string,
  body: Record<string, unknown>,
): Promise<BlnkTransaction> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request<BlnkTransaction>(cfg, "PUT", `/transactions/inflight/${transactionId}`, body);
    } catch (e) {
      if (!isQueuedConflict(e) || attempt >= INFLIGHT_RETRY_DELAYS_MS.length) throw e;
      await new Promise((r) => setTimeout(r, INFLIGHT_RETRY_DELAYS_MS[attempt]));
    }
  }
}

function isQueuedConflict(e: unknown): boolean {
  if (!(e instanceof BlnkError) || e.status !== 409) return false;
  const detail = (e.body as { error_detail?: { code?: string } } | null)?.error_detail;
  return detail?.code === "GEN_CONFLICT";
}

export function transactionMirror(t: BlnkTransaction): TransactionMirror {
  return {
    blnk_transaction_id: t.transaction_id,
    blnk_reference: t.reference,
    synced_at: new Date().toISOString(),
  };
}

export async function createCustomerBalance(
  cfg: BlnkConfig,
  p: CreateBalanceParams,
): Promise<{ balance: BlnkBalance; mirror: BalanceMirror }> {
  const balance = await request<BlnkBalance>(cfg, "POST", "/balances", {
    ledger_id: p.ledgerId ?? customerLedgerId(),
    currency: p.currency,
    ...(p.identityId ? { identity_id: p.identityId } : {}),
    meta_data: stampMeta(p.coreResource, p.metaData),
  });

  return {
    balance,
    mirror: {
      blnk_balance_id: balance.balance_id,
      blnk_ledger_id: balance.ledger_id,
      balance_synced_at: new Date().toISOString(),
    },
  };
}

export async function getBalance(
  cfg: BlnkConfig,
  balanceId: string,
): Promise<BlnkBalance> {
  return await request<BlnkBalance>(cfg, "GET", `/balances/${balanceId}`);
}

export function balanceMirror(
  b: BlnkBalance,
): { balance: number | null; balance_synced_at: string } {
  return {
    balance: typeof b.balance === "number" ? b.balance : null,
    balance_synced_at: new Date().toISOString(),
  };
}

