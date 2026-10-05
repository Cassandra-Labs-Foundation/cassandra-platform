import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const enc = new TextEncoder();

/**
 * The service-role client every handler reads and writes through.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is injected by the Edge Runtime and CANNOT be
 * overridden: `supabase secrets set` refuses any name beginning with
 * SUPABASE_. That is fine right up until the injected key is itself broken —
 * a mis-issued service-role JWT whose `iat` runs ahead of the database's clock
 * is rejected by PostgREST as "JWT issued at future", and then every query in
 * the process fails with no way to substitute a working credential.
 *
 * CORE_SERVICE_ROLE_KEY is that way out: a settable name, checked first, and
 * unset in a healthy deployment. It is not a second credential to rotate — it
 * is the override that has to exist because the primary one cannot be set.
 */
export function createDb(): SupabaseClient {
  const key = Deno.env.get("CORE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    key,
    { auth: { persistSession: false } },
  );
}

export function createRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

// Constant-time comparison via digest so key length/content can't be timed.
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Is this a syntactically valid UUID?
 *
 * core.wire_transfer and core.ach_transfer key on `uuid`; every other readable
 * table keys on `text`. That difference is invisible until someone fetches a
 * malformed id: PostgREST passes it straight to Postgres, which raises a cast
 * error rather than returning no rows, and the handler's error branch turns
 * that into a 500. A caller who typos an id gets "an unexpected error
 * occurred" where the text-keyed tables all say "not found".
 *
 * Checked BEFORE the query rather than caught after it, so the database is
 * never asked a question that cannot parse.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function docUrl(type: string): string {
  return `https://api.cassandra.bank/docs/errors/${type.replace(/_/g, "-")}`;
}

export interface ApiErrorOptions {
  resourceId?: string;
  resourceType?: string;
  detail?: string;
  title?: string;
}

export function apiError(
  status: number,
  type: string,
  requestId: string,
  opts: ApiErrorOptions = {},
): Response {
  const body = {
    status,
    type,
    title: opts.title ?? type.replace(/_/g, " "),
    detail: opts.detail ?? type.replace(/_/g, " "),
    doc_url: docUrl(type),
    request_id: requestId,
    ...(opts.resourceId !== undefined ? { resource_id: opts.resourceId } : {}),
    ...(opts.resourceType !== undefined ? { resource_type: opts.resourceType } : {}),
  };
  return jsonResponse(body, status, requestId);
}

export interface ValidationErrorItem {
  type: string;
  field: string;
  message: string;
}

export function validationError(requestId: string, errors: ValidationErrorItem[]): Response {
  return jsonResponse({ status: 400, type: "validation_error", request_id: requestId, errors }, 400, requestId);
}

// Card 03: one version constant, stamped on EVERY response by the single
// response builder below. Major bumped to 4 by card 45: the shared X-Api-Key
// is gone, which is a breaking change for every existing caller.
export const API_VERSION = "4.0.0";

export function jsonResponse(
  body: unknown,
  status = 200,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "X-Request-Id": requestId,
      "X-API-Version": API_VERSION,
      ...extraHeaders,
    },
  });
}

export function misconfiguredResponse(requestId: string, message: string): Response {
  return apiError(500, "misconfigured", requestId, {
    title: "Misconfigured",
    detail: message,
  });
}

export function notFoundResponse(
  requestId: string,
  resourceType: string,
  resourceId: string,
): Response {
  return apiError(404, "not_found", requestId, {
    title: "Not Found",
    detail: `${resourceType} not found`,
    resourceType,
    resourceId,
  });
}

export function methodNotAllowedResponse(requestId: string): Response {
  return apiError(405, "method_not_allowed", requestId, {
    title: "Method Not Allowed",
    detail: "HTTP method not allowed for this route",
  });
}

export function bankErrorResponse(requestId: string): Response {
  return apiError(502, "bank_error", requestId, {
    title: "Bank Error",
    detail: "The banking service is temporarily unavailable",
  });
}

/**
 * 503, for a dependency that failed AFTER the request was already understood.
 *
 * Distinct from 401 deliberately. A database that cannot be reached is not a
 * credential that is wrong, and reporting it as one sends whoever is on call
 * to rotate a key that was never the problem — which is exactly what happened
 * when a bad service-role JWT surfaced as "Invalid or missing API token" on
 * every route at once.
 *
 * Distinct from 500 too: 500 says this request will fail the same way if you
 * send it again, and that is not what a transient dependency outage means.
 */
export function serviceUnavailableResponse(requestId: string, detail?: string): Response {
  return apiError(503, "service_unavailable", requestId, {
    title: "Service Unavailable",
    detail: detail ?? "A required backend service is temporarily unavailable",
  });
}

export function internalErrorResponse(requestId: string, err?: unknown): Response {
  if (err !== undefined) {
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    console.error(`[${requestId}] internal error: ${msg}`);
  }
  return apiError(500, "internal_error", requestId, {
    title: "Internal Error",
    detail: "An unexpected error occurred",
  });
}

export async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function dollarsFromCents(cents: number): string {
  return (cents / 100).toFixed(2); // float-ok: display-only, never serialized as money
}

// ---- cursor pagination (D16) ------------------------------------------------

/**
 * The `?limit=` / `?after=` pair every list endpoint accepts, parsed once.
 *
 * Shared rather than re-derived per endpoint because the bound matters: `limit`
 * is what stands between a caller and a full table scan, and three hand-written
 * copies of the same ceiling drift into two ceilings and an unbounded one. The
 * caller adds the returned `errors` to its own before deciding, so a bad cursor
 * and a bad domain filter come back in ONE 400 rather than whichever the
 * endpoint happened to check first.
 */
export interface PageParams {
  limit: number;
  after: string | null;
  errors: ValidationErrorItem[];
}

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;

export function parsePageParams(q: URLSearchParams): PageParams {
  const errors: ValidationErrorItem[] = [];

  const after = q.get("after");
  if (after !== null && Number.isNaN(Date.parse(after))) {
    errors.push({ type: "invalid_value", field: "after", message: "must be an ISO-8601 timestamp" });
  }

  let limit = PAGE_LIMIT_DEFAULT;
  const rawLimit = q.get("limit");
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > PAGE_LIMIT_MAX) {
      errors.push({
        type: "invalid_value",
        field: "limit",
        message: `must be an integer between 1 and ${PAGE_LIMIT_MAX}`,
      });
    } else limit = n;
  }

  return { limit, after, errors };
}

/**
 * Split an over-fetched result (limit + 1 rows) into a page and its cursor.
 *
 * The over-fetch is how `has_more` stays honest without a second count query:
 * ask for one more row than the caller wanted, and its presence IS the answer.
 *
 * THE THROW IS THE POINT. `has_more: true` with `next_after: null` is not a
 * degraded response, it is an unanswerable one: the caller is told there is
 * another page and handed nothing to ask for it with, so a correct client
 * loops on page 1 forever and an incorrect one stops early and under-reports.
 * That shipped on GET /accounts because core.account.created_at was nullable
 * and Postgres sorts NULLS FIRST under DESC — a 200 with a well-formed body
 * and a dead cursor, which no status code and no schema check would flag.
 *
 * A 500 here is strictly better than that. The invariant is enforced where the
 * envelope is BUILT rather than in a test per endpoint, so it covers the list
 * endpoints that do not exist yet — which is the only kind of coverage that
 * survives someone adding one. 20260725000100 removes the cause; this makes
 * the symptom impossible to serve if a nullable cursor ever returns.
 */
export function paginate<T extends Record<string, unknown>>(
  rows: T[],
  limit: number,
  cursorField = "created_at",
): { page: T[]; has_more: boolean; next_after: unknown } {
  const has_more = rows.length > limit;
  const page = has_more ? rows.slice(0, limit) : rows;
  const next_after = has_more && page.length ? page[page.length - 1][cursorField] : null;

  if (has_more && (next_after === null || next_after === undefined)) {
    throw new Error(
      `pagination cursor is null: the last row of this page has no ${cursorField}, ` +
        `so has_more cannot be honoured. The cursor column must be NOT NULL — ` +
        `see scripts/check_cursor_columns.py.`,
    );
  }

  return { page, has_more, next_after };
}

/**
 * The list envelope every paginated endpoint returns.
 *
 * `{data, pagination: {...}}`, which is what core-api.yaml has specified all
 * along via the Pagination schema. The implementations had drifted to a FLAT
 * `{data, limit, has_more, next_after}` — spec and code disagreeing about the
 * shape of every list response in the API. Built here rather than spelled out
 * per endpoint so the next list endpoint cannot drift a third way.
 */
export function pageEnvelope(
  data: unknown[],
  page: { limit: number; has_more: boolean; next_after: unknown },
): Record<string, unknown> {
  return {
    data,
    pagination: {
      limit: page.limit,
      has_more: page.has_more,
      next_after: page.next_after,
    },
  };
}

// ---- idempotency (D6) -------------------------------------------------------

export interface TransferIdempotencyPayload {
  source_account_id: string;
  destination_account_id: string;
  amount_cents: number;
  description: string | null;
}

export async function transferRequestHash(payload: TransferIdempotencyPayload): Promise<string> {
  const canonical = JSON.stringify({
    source_account_id: payload.source_account_id,
    destination_account_id: payload.destination_account_id,
    amount_cents: payload.amount_cents,
    description: payload.description ?? null,
  });
  return await sha256Hex(canonical);
}

export interface AccountIdempotencyPayload {
  account_type: string;
  opening_deposit_cents: number | null;
  entity_id: string | null;
}

export async function accountRequestHash(payload: AccountIdempotencyPayload): Promise<string> {
  const canonical = JSON.stringify({
    account_type: payload.account_type,
    opening_deposit_cents: payload.opening_deposit_cents ?? null,
    entity_id: payload.entity_id ?? null,
  });
  return await sha256Hex(canonical);
}

export interface IdempotencyRow {
  idempotency_key: string;
  endpoint: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  blnk_reference: string | null;
}

export type IdempotencyClaim =
  | { kind: "fresh"; transferId: string }
  | { kind: "replay"; responseStatus: number; responseBody: unknown }
  | { kind: "resume"; transferId: string }
  | { kind: "in_progress" }
  | { kind: "conflict" };

/**
 * How long a claim with no stored response is treated as STILL RUNNING rather
 * than crashed. Inside the window a same-key retry is told to come back
 * (`in_progress`); after it, the claim is resumed as crash recovery. Concurrent
 * retries used to resume immediately and race the original: a duplicate
 * insert (500) and a duplicate Blnk post (502), though the money moved once
 * (caught by the ledger partner-flow suite).
 */
export const IDEMPOTENCY_IN_FLIGHT_SECS = 60;

/** 409 for a same-key retry that arrives while the original is still running. */
export function idempotencyInProgressResponse(requestId: string): Response {
  const res = apiError(409, "idempotency_request_in_progress", requestId, {
    title: "Request In Progress",
    detail: "A request with this Idempotency-Key is still being processed; retry shortly",
  });
  res.headers.set("Retry-After", "1");
  return res;
}

/**
 * Claim an Idempotency-Key for one partner.
 *
 * `partnerId` partitions the keyspace and is NOT optional (card 45). The key
 * alone used to be the primary key, so two partners sending the same
 * Idempotency-Key — 'order-42' and the like, derived from their own order
 * numbers — collided, and the second one replayed the FIRST one's cached
 * response body: account ids, amounts, counterparties. Every lookup below
 * therefore filters on both columns; filtering on the key alone would restore
 * the leak even with the composite primary key in place.
 */
export async function claimIdempotency(
  db: SupabaseClient,
  partnerId: string,
  idempotencyKey: string,
  requestHash: string,
  transferId: string,
  endpoint: string,
): Promise<IdempotencyClaim> {
  const { error: insErr } = await db.schema("core").from("idempotency_keys").insert({
    partner_id: partnerId,
    idempotency_key: idempotencyKey,
    endpoint,
    request_hash: requestHash,
    blnk_reference: transferId,
    response_status: null,
  });

  if (!insErr) return { kind: "fresh", transferId };

  if (insErr.code !== "23505") {
    throw new Error(`idempotency insert: ${insErr.message}`);
  }

  const { data, error: fetchErr } = await db.schema("core").from("idempotency_keys")
    .select("idempotency_key, endpoint, request_hash, response_status, response_body, blnk_reference, created_at")
    .eq("partner_id", partnerId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (fetchErr) throw new Error(`idempotency fetch: ${fetchErr.message}`);
  if (!data) return { kind: "fresh", transferId };

  const row = data as IdempotencyRow;
  if (row.request_hash !== requestHash) return { kind: "conflict" };

  if (row.response_status !== null && row.response_status !== undefined) {
    return {
      kind: "replay",
      responseStatus: row.response_status,
      responseBody: row.response_body,
    };
  }

  const claimedAt = Date.parse(String((row as IdempotencyRow & { created_at?: string }).created_at ?? ""));
  if (Number.isFinite(claimedAt) && Date.now() - claimedAt < IDEMPOTENCY_IN_FLIGHT_SECS * 1000) {
    return { kind: "in_progress" };
  }

  const resumeId = row.blnk_reference ?? transferId;
  return { kind: "resume", transferId: resumeId };
}

export async function storeIdempotencyResponse(
  db: SupabaseClient,
  partnerId: string,
  idempotencyKey: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  const { error } = await db.schema("core").from("idempotency_keys")
    .update({ response_status: responseStatus, response_body: responseBody })
    // both columns: without the partner predicate this writes one partner's
    // response body onto every partner's row that happens to share the key
    .eq("partner_id", partnerId)
    .eq("idempotency_key", idempotencyKey);
  if (error) throw new Error(`idempotency update: ${error.message}`);
}

/**
 * Every row of a register, not the first page of it.
 *
 * PostgREST caps an unbounded select at its max-rows (1000 here) and says
 * nothing — the response is a normal 200 with 1000 rows. A handler that counts
 * or sums a register that way under-reports silently once the register passes
 * the cap (caught live by the partner-flow suite: the cash KRI and the
 * examiner records package both stopped at 1000). Pages by `id` so the walk is
 * stable while rows are being added.
 */
export async function selectAll<T = Record<string, unknown>>(
  db: SupabaseClient,
  schema: string,
  table: string,
  columns: string,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db.schema(schema).from(table).select(columns)
      .order("id", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`${table} read: ${error.message}`);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
