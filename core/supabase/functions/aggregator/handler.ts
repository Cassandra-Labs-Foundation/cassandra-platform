// aggregator — request handling for the cross-fintech layer (D18/D19/D23).
// Card 51.
//
// Split from index.ts for the same reason card 18 extracted sweeps.ts: logic
// behind Deno.serve cannot be imported by a test without binding a port.
//
// SCOPE: this is the authentication BOUNDARY only, plus the one endpoint
// needed to exercise it (event ingest, per D4/D21 — instances push their
// outbox here). It is not the full aggregator: the BSA Approver consumer (D27)
// is a separate card, as is cross-fintech search (card 54). D27's other three
// consumers never existed in this shape — payment_hub was retired with the
// accumulator (migration 20260817000100) and the BSA and 5300 reporters run as
// scheduled scripts rather than cursor consumers; see the D27 note in
// core/architecture-decisions.md. What exists here is the thing card 51
// actually asserts — that a partner key is rejected at the aggregator.
//
// Auth: instance JWT (D19). Deliberately NOT the partner token table; see
// auth.ts for why that is a class distinction rather than a scope one.

import { looksLikePartnerToken, signInstanceJwt, verifyInstanceJwt } from "./auth.ts";

const API_VERSION = "4.0.0";

function jsonResponse(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "X-Request-Id": requestId,
      "X-API-Version": API_VERSION,
    },
  });
}

function apiError(
  status: number,
  type: string,
  requestId: string,
  title: string,
  detail: string,
): Response {
  return jsonResponse({
    status,
    type,
    title,
    detail,
    doc_url: `https://api.cassandra.bank/docs/errors/${type.replace(/_/g, "-")}`,
    request_id: requestId,
  }, status, requestId);
}

function extractBearer(req: Request): string | null {
  const authz = req.headers.get("Authorization");
  if (authz) {
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  // X-Api-Key is how a partner integration would mistakenly reach for this,
  // so it is read purely to be refused with a useful message below.
  return req.headers.get("X-Api-Key");
}

export async function handleAggregator(
  req: Request,
  deps: {
    jwtSecret: string | undefined;
    // deno-lint-ignore no-explicit-any
    db: any;
    now?: number;
  },
  requestId: string,
): Promise<Response> {
  // Card 64: /auth/token is the ONE pre-auth route — it exchanges a
  // per-instance client secret for a 300s instance JWT, so the long-lived
  // secret rides exactly one endpoint and everything else sees only its
  // 5-minute derivative. The mTLS half of card 64 is platform-blocked:
  // Supabase terminates TLS at its edge and does not forward client
  // certificates, so it is documented as unenforceable here, not simulated.
  {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "aggregator") parts.shift();
    if (req.method === "POST" && parts.join("/") === "auth/token") {
      return await issueToken(req, deps, requestId);
    }
  }

  const token = extractBearer(req);
  if (!token) {
    return apiError(
      401,
      "unauthorized",
      requestId,
      "Unauthorized",
      "an instance JWT is required",
    );
  }

  // Card 51's headline assertion, and deliberately the FIRST thing checked —
  // ahead of both the config check and signature verification. A partner token
  // is refused here as a matter of credential class, so the answer must not
  // depend on the aggregator's own configuration: were the JWT secret unset, a
  // partner would otherwise receive a 500 that both hints at server internals
  // and obscures the real reason their key does not work.
  if (looksLikePartnerToken(token)) {
    return apiError(
      403,
      "partner_token_not_valid_here",
      requestId,
      "Partner Token Not Valid Here",
      "partner tokens are confined to their own instance and are never accepted at the aggregator (D23); " +
        "instances authenticate with a short-lived instance JWT (D19)",
    );
  }

  if (!deps.jwtSecret) {
    return apiError(
      500,
      "misconfigured",
      requestId,
      "Misconfigured",
      "server misconfigured: AGGREGATOR_JWT_SECRET unset",
    );
  }

  const verified = await verifyInstanceJwt(token, deps.jwtSecret, deps.now);
  if (!verified.ok) {
    return apiError(
      401,
      "unauthorized",
      requestId,
      "Unauthorized",
      "instance JWT rejected",
    );
  }

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "aggregator") parts.shift();
  const path = "/" + parts.join("/");

  // Card 52: cu_admin READS across instances and WRITES nothing. The gate
  // sits before every route so a new write route cannot forget it: admins
  // may only GET.
  const role = verified.claims.role ?? "instance";
  if (role === "cu_admin" && req.method !== "GET") {
    return apiError(
      403,
      "admin_read_only",
      requestId,
      "Admin Is Read-Only",
      "the cu_admin credential reads across instances and writes nothing (card 52)",
    );
  }

  // Card 52: the cross-instance overview — one row per instance.
  if (req.method === "GET" && /^\/admin\/overview\/?$/.test(path)) {
    if (role !== "cu_admin") {
      return apiError(
        403,
        "cu_admin_only",
        requestId,
        "CU Admin Only",
        "cross-instance reads require the cu_admin credential",
      );
    }
    const { data, error } = await deps.db.schema("aggregator").rpc("admin_overview");
    if (error) {
      console.error(`[${requestId}] admin_overview failed: ${error.message}`);
      return apiError(500, "internal_error", requestId, "Internal Error", "overview failed");
    }
    return jsonResponse({ instances: data }, 200, requestId);
  }

  // Card 54: cross-fintech search — by entity_hash only (identity never
  // crosses the boundary, so identity cannot be the search key), and
  // cu_admin only: an instance reading another instance's activity is the
  // contamination D23 forbids, so this succeeds at the aggregator and
  // nowhere else.
  if (req.method === "GET" && /^\/search\/?$/.test(path)) {
    if (role !== "cu_admin") {
      return apiError(
        403,
        "cu_admin_only",
        requestId,
        "CU Admin Only",
        "cross-fintech search requires the cu_admin credential",
      );
    }
    const hash = url.searchParams.get("entity_hash");
    if (!hash) {
      return apiError(
        400,
        "validation_error",
        requestId,
        "Validation Error",
        "entity_hash query parameter is required",
      );
    }
    const { data, error } = await deps.db.schema("aggregator")
      .rpc("search_entity", { p_hash: hash });
    if (error) {
      console.error(`[${requestId}] search_entity failed: ${error.message}`);
      return apiError(500, "internal_error", requestId, "Internal Error", "search failed");
    }
    return jsonResponse(data, 200, requestId);
  }

  if (req.method === "POST" && /^\/events\/ingest\/?$/.test(path)) {
    return await ingestEvents(req, deps.db, verified.claims.instance_id, requestId);
  }

  // Card 61: the three gaps in one answer (staleness / ingest gap; delivery
  // gap is measured instance-side by the outbox). The underlying SQL function
  // also WRITES a consumer_stalled alert when it trips — an alarm, not a
  // dashboard.
  if (req.method === "GET" && /^\/health\/?$/.test(path)) {
    const { data, error } = await deps.db.schema("aggregator").rpc("health");
    if (error) {
      console.error(`[${requestId}] health failed: ${error.message}`);
      return apiError(500, "internal_error", requestId, "Internal Error", "health check failed");
    }
    return jsonResponse(data, 200, requestId);
  }

  // Card 65: FBO reads. Since migration 20260817000100 this is DERIVED state,
  // not consumer-built: position = the sum of that program's open member share
  // balances, available = position minus held AND captured reserves, plus a
  // `mirror` block saying how stale the balances underneath it are. The old
  // `inbound_cents` is gone with the apply step it was waiting on. The instance
  // is ALWAYS the token's; there is no path parameter to read someone else's
  // FBO.
  if (req.method === "GET" && /^\/fbo\/?$/.test(path)) {
    const { data, error } = await deps.db.schema("aggregator")
      .rpc("fbo_read", { p_instance: verified.claims.instance_id });
    if (error) {
      console.error(`[${requestId}] fbo_read failed: ${error.message}`);
      return apiError(500, "internal_error", requestId, "Internal Error", "fbo read failed");
    }
    return jsonResponse(data, 200, requestId);
  }

  // Card 66: a clean origination reserves and returns pending; unmaintained
  // state is a 503 WITH Retry-After — the caller is told when trying again is
  // reasonable, not just that now is not the time. What "unmaintained" means
  // moved with the position: the gate used to ask whether payment_hub had run,
  // and now asks whether blnk-reconcile has, because the roll-up depends on the
  // balance mirror rather than on a consumer applying deltas.
  if (req.method === "POST" && /^\/originations\/?$/.test(path)) {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return apiError(400, "validation_error", requestId, "Validation Error", "body must be JSON");
    }
    const amount = body?.amount_cents;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      return apiError(
        400,
        "validation_error",
        requestId,
        "Validation Error",
        "amount_cents must be a positive integer",
      );
    }
    const { data, error } = await deps.db.schema("aggregator")
      .rpc("originate", { p_instance: verified.claims.instance_id, p_amount: amount });
    if (error) {
      console.error(`[${requestId}] originate failed: ${error.message}`);
      return apiError(500, "internal_error", requestId, "Internal Error", "origination failed");
    }
    if (data?.error === "consumer_stale") {
      const res = apiError(
        503,
        "consumer_stale",
        requestId,
        "Consumer Stale",
        String(data.detail ?? "reserving against unmaintained state"),
      );
      res.headers.set("Retry-After", String(data.retry_after_secs ?? 120));
      return res;
    }
    if (data?.error === "insufficient_available") {
      return apiError(
        409,
        "insufficient_available",
        requestId,
        "Insufficient Available Balance",
        `requested ${data.requested_cents} cents against ${data.available_balance_cents} available`,
      );
    }
    return jsonResponse(data, 201, requestId);
  }

  // Card 67: the saga's two exits.
  const sagaMatch = path.match(/^\/originations\/([^/]+)\/(accept|reject)\/?$/);
  if (req.method === "POST" && sagaMatch) {
    const fn = sagaMatch[2] === "accept" ? "accept_origination" : "reject_origination";
    // Scoped to the caller's instance (from the verified claims): another
    // instance's origination is not_found, never resolvable (D23).
    const { data, error } = await deps.db.schema("aggregator").rpc(fn, {
      p_id: sagaMatch[1],
      p_instance: verified.claims.instance_id,
    });
    if (error) {
      console.error(`[${requestId}] ${fn} failed: ${error.message}`);
      return apiError(500, "internal_error", requestId, "Internal Error", `${fn} failed`);
    }
    if (data?.error === "not_found") {
      return apiError(404, "not_found", requestId, "Not Found", "no such origination");
    }
    if (data?.error) {
      return apiError(
        409,
        "conflict",
        requestId,
        "Conflict",
        `origination is ${data.status ?? "not in a resolvable state"}`,
      );
    }
    return jsonResponse(data, 200, requestId);
  }

  // Cards 56-58: run a consumer on demand (the cron drives them in
  // production; this is how tests and operators run one deterministically).
  // payment_hub is GONE (migration 20260817000100): the FBO position became a
  // roll-up of member balances, so there is no longer a consumer applying
  // deltas to it. The route is not kept as a no-op — a consumer endpoint that
  // returns 200 having done nothing is how the position stayed wrong for a
  // year while its liveness looked healthy.
  const runMatch = path.match(/^\/consumers\/(bsa_approver)\/run\/?$/);
  if (req.method === "POST" && runMatch) {
    const fn = "run_bsa_approver";
    const { data, error } = await deps.db.schema("aggregator").rpc(fn, { batch: 200 });
    if (error) {
      console.error(`[${requestId}] ${fn} failed: ${error.message}`);
      return apiError(500, "internal_error", requestId, "Internal Error", `${fn} failed`);
    }
    return jsonResponse(data, 200, requestId);
  }

  return apiError(404, "not_found", requestId, "Not Found", `no aggregator route for ${path}`);
}

// The PII rule, enforced at the door as well as by the table's check
// constraint: identity travels as entity_hash (or ciphertext), never as
// plaintext. Belt here for a NAMED 400; suspenders in the schema for writers
// that bypass this handler.
const RAW_PII_KEYS = ["name", "ssn", "date_of_birth", "dob", "address", "email", "phone"];

/**
 * POST /events/ingest — an instance pushes outbox events (D4/D21).
 *
 * The stored `instance_id` comes from the VERIFIED JWT CLAIMS, never from the
 * request body. Trusting a body field would let any instance holding a valid
 * token write events attributed to another instance, which is exactly the
 * cross-fintech contamination D23 exists to prevent.
 */
async function ingestEvents(
  req: Request,
  // deno-lint-ignore no-explicit-any
  db: any,
  instanceId: string,
  requestId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(400, "validation_error", requestId, "Validation Error", "body must be JSON");
  }

  const events = (body as { events?: unknown })?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return apiError(
      400,
      "validation_error",
      requestId,
      "Validation Error",
      "events must be a non-empty array",
    );
  }

  const rows = events.map((e) => {
    const ev = e as Record<string, unknown>;
    return {
      event_id: ev.id,
      instance_id: instanceId, // from the token, never the body
      code: ev.code,
      resource_id: ev.resource_id,
      entity_hash: ev.entity_hash ?? null,
      payload: ev.payload ?? {},
      schema_version: typeof ev.schema_version === "number" ? ev.schema_version : 1,
    };
  });

  if (rows.some((r) => typeof r.event_id !== "string" || !r.event_id)) {
    return apiError(
      400,
      "validation_error",
      requestId,
      "Validation Error",
      "every event requires a string id",
    );
  }

  for (const r of rows) {
    const payload = r.payload as Record<string, unknown>;
    const leaked = RAW_PII_KEYS.find((k) => payload && typeof payload === "object" && k in payload);
    if (leaked) {
      return apiError(
        400,
        "raw_pii_refused",
        requestId,
        "Raw PII Refused",
        `event ${r.event_id} carries plaintext '${leaked}' in its payload; ` +
          "identity crosses the instance boundary only as entity_hash or ciphertext (card 55)",
      );
    }
  }

  // D4: dedup at the aggregator via the event_id unique constraint. At-least-
  // once delivery from the instance outbox means redelivery is normal, not
  // exceptional, so a repeat is a no-op rather than an error.
  const { error } = await db.schema("aggregator").from("event")
    .upsert(rows, { onConflict: "event_id", ignoreDuplicates: true });
  if (error) {
    console.error(`[${requestId}] ingest failed: ${error.message}`);
    return apiError(500, "internal_error", requestId, "Internal Error", "ingest failed");
  }

  return jsonResponse({ ingested: rows.length, instance_id: instanceId }, 200, requestId);
}

/**
 * POST /auth/token (card 64) — exchange a per-instance client secret for a
 * 300s instance JWT. The stored value is sha256(secret); the plaintext exists
 * only in the caller's config and on this one request. Wrong instance and
 * wrong secret are the SAME 401 — this endpoint confirms nothing about which
 * instance ids exist.
 */
async function issueToken(
  req: Request,
  deps: {
    jwtSecret: string | undefined;
    // deno-lint-ignore no-explicit-any
    db: any;
    now?: number;
  },
  requestId: string,
): Promise<Response> {
  if (!deps.jwtSecret) {
    return apiError(
      500,
      "misconfigured",
      requestId,
      "Misconfigured",
      "server misconfigured: AGGREGATOR_JWT_SECRET unset",
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError(400, "validation_error", requestId, "Validation Error", "body must be JSON");
  }
  const instanceId = body?.instance_id;
  const secret = body?.client_secret;
  if (typeof instanceId !== "string" || !instanceId || typeof secret !== "string" || !secret) {
    return apiError(
      400,
      "validation_error",
      requestId,
      "Validation Error",
      "instance_id and client_secret are required",
    );
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  // role is in the select because the JWT MINTS it — the select-list lesson
  const { data, error } = await deps.db.schema("aggregator").from("instance_credential")
    .select("instance_id, client_secret_hash, role").eq("instance_id", instanceId).maybeSingle();
  if (error) {
    console.error(`[${requestId}] credential lookup failed: ${error.message}`);
    return apiError(500, "internal_error", requestId, "Internal Error", "token issuance failed");
  }
  if (!data || data.client_secret_hash !== hash) {
    return apiError(
      401,
      "unauthorized",
      requestId,
      "Unauthorized",
      "instance credentials rejected",
    );
  }

  const now = Math.floor((deps.now ?? Date.now()) / 1000);
  const role = data.role === "cu_admin" ? "cu_admin" as const : "instance" as const;
  const jwt = await signInstanceJwt(
    { instance_id: instanceId, iat: now, exp: now + 300, role },
    deps.jwtSecret,
  );
  return jsonResponse(
    { access_token: jwt, token_type: "Bearer", expires_in: 300, instance_id: instanceId, role },
    200,
    requestId,
  );
}
