// Cards 45 (partner tokens) + 51 (partner confinement).
//
// Replaces the single shared X-Api-Key with per-partner scoped tokens.
//
// A request authenticates only if ALL of these hold. They are independent on
// purpose: each one alone has a plausible misconfiguration that the others
// still catch.
//
//   1. the token hashes to a live row ON THIS INSTANCE   (card 51)
//   2. the owning partner is active                      (D5)
//   3. the actor class may reach this endpoint           (D23 access matrix)
//   4. the endpoint is in the token's allowlist          (D5)
//   5. the endpoint's tier is in the token's tier list   (D14)
//
// WHAT THIS DOES NOT DO: it is not RLS. The edge function connects as
// service_role, which bypasses RLS entirely (20260702000800_core_grants.sql),
// so row-level policies confine nothing on the API path. Confinement is here,
// at the edge, plus the instance predicate baked into the lookup query.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { apiError, serviceUnavailableResponse, sha256Hex, timingSafeEqual } from "./lib.ts";

/** token_prefix of actors minted by the E2E flow harness; their evidence is `demo`. */
export const TEST_TOKEN_PREFIX = "cass_test";

/** D14 rate-limit tiers, used here as an authorization dimension. */
export type Tier = "read" | "write" | "realtime" | "bulk";

/** D23 access matrix actors. */
export type ActorType = "partner" | "cu_admin" | "pynthia_ops";

/**
 * BSA duty roles (OQ-08). A closed vocabulary gating two endpoints — not a
 * permission system. actor_type says what KIND of actor this is; a role says
 * which BSA duty it may perform. They are orthogonal: a cu_admin token with no
 * roles can reach case management's read surface but cannot triage or decide.
 */
/**
 * Named BsaRole for historical reasons; it is now the general write-restriction
 * role set. `cco` and `cfo` were added because CP-03 write-restricts capital
 * targets to the CCO and CP-05 restricts the capital plan to the CFO — roles
 * the system had no way to express. The name is left alone rather than renamed
 * across every call site in the same change that adds them.
 */
export type BsaRole =
  | "bsa_investigator"
  | "bsa_officer"
  | "bsa_compliance"
  | "bsa_counsel"
  | "cco"
  | "cfo";

/** What a route declares about itself so scope can be checked against it. */
export interface EndpointScope {
  /** stable identity, e.g. "POST /payments/wire/prepare" — never the raw path */
  endpoint: string;
  tier: Tier;
  /**
   * Actor classes permitted regardless of scope lists. Omitted means "any
   * authenticated actor whose scope allows it". Present means the endpoint is
   * restricted by CLASS — e.g. /sandbox/reset is ops-only, and no amount of
   * endpoint wildcarding lets a partner reach it.
   */
  actors?: ActorType[];
}

export interface PartnerContext {
  tokenId: string;
  tokenPrefix: string;
  actorType: ActorType;
  /** BSA duty roles this token carries. Empty for almost every token. */
  roles: BsaRole[];
  /** null for cu_admin / pynthia_ops — those actors are not a fintech */
  partnerId: string | null;
  instanceId: string;
  /**
   * The partition key for idempotency. Never null: an actor with no partner_id
   * still needs a stable namespace, or two ops actors would share one keyspace.
   *
   * Deliberately NOT the same as ownerPartnerId. This answers "who called", so
   * that two callers cannot replay each other's cached responses;
   * ownerPartnerId answers "who owns the row". An ops actor acting on behalf
   * of a partner shares that partner's ROWS but must not share its
   * idempotency keyspace, or an ops retry could collide with a partner's own.
   */
  idempotencyScope: string;
  /**
   * The partner stamped on rows this request creates. Never null, because
   * core.*.partner_id is NOT NULL — an actor with no partner of its own (ops,
   * cu_admin) resolves to the instance's sole active partner, which under D18
   * is unambiguous.
   */
  ownerPartnerId: string;
  /**
   * Provenance class for evidence this request writes.
   *
   * `demo` for anything authenticated with the shared bootstrap DEMO_API_KEY —
   * which is what analytics/seed.sh uses to manufacture control-tripping
   * traffic. The control evaluation is real; the traffic is not, and the
   * credential cannot be attributed to any actor, so the evidence must not
   * count toward coverage. See 20260719001200.
   */
  evidenceProvenance: "production" | "demo";
}

export type AuthOutcome =
  | { ok: true; ctx: PartnerContext }
  | { ok: false; response: Response };

/** Reads the bearer token, falling back to the legacy X-Api-Key header. */
export function extractToken(req: Request): string | null {
  const authz = req.headers.get("Authorization");
  if (authz) {
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  const legacy = req.headers.get("X-Api-Key");
  return legacy && legacy.length > 0 ? legacy : null;
}

/**
 * Does `granted` cover `endpoint`?
 *
 * Supports exact matches, a bare "*", and a trailing "/*" prefix match. The
 * prefix form matches on SEGMENT boundaries: "POST /payments/*" must cover
 * "POST /payments/ach" without also covering a hypothetical
 * "POST /payments-admin/purge". Substring matching here would silently widen
 * every scope that happens to be a prefix of another route.
 */
export function endpointMatches(granted: string, endpoint: string): boolean {
  if (granted === "*") return true;
  if (granted === endpoint) return true;
  if (granted.endsWith("/*")) {
    const prefix = granted.slice(0, -1); // keep the trailing slash
    return endpoint.startsWith(prefix);
  }
  return false;
}

export function scopeAllows(
  allowedEndpoints: string[],
  allowedTiers: string[],
  scope: EndpointScope,
): boolean {
  const endpointOk = allowedEndpoints.some((g) => endpointMatches(g, scope.endpoint));
  const tierOk = allowedTiers.includes(scope.tier);
  return endpointOk && tierOk;
}

interface TokenRow {
  id: string;
  token_prefix: string;
  actor_type: ActorType;
  roles?: BsaRole[] | null;
  partner_id: string | null;
  instance_id: string;
  allowed_endpoints: string[];
  allowed_tiers: string[];
  status: string;
  expires_at: string | null;
}

/**
 * 401, deliberately indistinguishable across every authentication failure.
 *
 * An unknown token, a revoked token, an expired token and a token valid on a
 * DIFFERENT instance all produce exactly this. That last case is the point of
 * card 51: if a foreign token produced a distinguishable error, an attacker
 * holding one token could enumerate which instances it is valid on and map the
 * fintech estate. The 403 below is only ever reached AFTER authentication has
 * already succeeded on this instance.
 */
function unauthorized(requestId: string): Response {
  return apiError(401, "unauthorized", requestId, {
    title: "Unauthorized",
    detail: "Invalid or missing API token",
  });
}

function forbidden(requestId: string, detail: string): Response {
  return apiError(403, "insufficient_scope", requestId, {
    title: "Insufficient Scope",
    detail,
  });
}

/**
 * The DEMO_API_KEY bootstrap credential.
 *
 * Card 45 is "replaces hardcoded creds", and this IS the hardcoded cred. It
 * survives for two concrete reasons: the card-16 outbox worker authenticates
 * to its own /sandbox/event-sink with it (events.ts), and the e2e harness
 * predates tokens. Set ALLOW_DEMO_KEY=false in any real deployment.
 */
export interface DemoKeyConfig {
  key: string | undefined;
  enabled: boolean;
}

/**
 * Authenticate and authorize one request against one route's scope.
 *
 * `instanceId` is the instance this process IS — supplied by the caller from
 * the environment rather than read from the token, since a token asserting its
 * own instance would be asserting its own validity.
 */
export async function authenticate(
  req: Request,
  db: SupabaseClient,
  scope: EndpointScope,
  instanceId: string,
  requestId: string,
  demo?: DemoKeyConfig,
): Promise<AuthOutcome> {
  const token = extractToken(req);
  if (!token) return { ok: false, response: unauthorized(requestId) };

  let row: TokenRow | null = null;

  let usedDemoKey = false;
  if (demo?.enabled && demo.key && await timingSafeEqual(token, demo.key)) {
    usedDemoKey = true;
    // Resolved into the SAME row shape and then run through the SAME actor and
    // scope checks below — not short-circuited past them. If a future endpoint
    // is restricted to actors the bootstrap key is not, it is refused like any
    // other token.
    console.warn(
      `[${requestId}] DEMO_API_KEY bootstrap credential used — set ALLOW_DEMO_KEY=false in production`,
    );
    row = {
      id: "tok_demo_bootstrap",
      token_prefix: "cass_demo",
      actor_type: "pynthia_ops",
      partner_id: null,
      instance_id: instanceId,
      allowed_endpoints: ["*"],
      allowed_tiers: ["read", "write", "realtime", "bulk"],
      status: "active",
      expires_at: null,
    };
  } else {
    const tokenHash = await sha256Hex(token);

    // The instance predicate is part of the AUTHENTICATION query, not a check
    // applied to its result: a token belonging to another instance must never
    // resolve to a row here even transiently. Same reason status is filtered in
    // SQL rather than in TypeScript.
    const { data, error } = await db.schema("core").from("api_token")
      .select(
        "id, token_prefix, actor_type, roles, partner_id, instance_id, allowed_endpoints, allowed_tiers, status, expires_at",
      )
      .eq("token_hash", tokenHash)
      .eq("instance_id", instanceId)
      .eq("status", "active")
      .maybeSingle();

    if (error) {
      // Fail CLOSED — the request does NOT proceed. But it fails as a 503,
      // because a database error is not a bad token and must not be reported
      // as one.
      //
      // This does not weaken the indistinguishable-401 property above. That
      // property exists so a token cannot be used to probe which INSTANCE it
      // is valid on; the 503 here is returned identically for every token,
      // including absent and malformed ones, so it separates no token from any
      // other. What it discloses is that the database is unreachable, which is
      // true, and is already plain from any unauthenticated route.
      console.error(`[${requestId}] token lookup failed: ${error.message}`);
      return { ok: false, response: serviceUnavailableResponse(requestId) };
    }
    if (!data) return { ok: false, response: unauthorized(requestId) };
    row = data as TokenRow;
  }

  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    return { ok: false, response: unauthorized(requestId) };
  }

  // A suspended partner's tokens stop working immediately, without having to
  // revoke each one — offboarding a fintech is a single row update.
  if (row.partner_id) {
    const { data: partner, error: pErr } = await db.schema("core").from("partner")
      .select("id, status, instance_id")
      .eq("id", row.partner_id)
      .maybeSingle();
    if (pErr) {
      console.error(`[${requestId}] partner lookup failed: ${pErr.message}`);
      return { ok: false, response: unauthorized(requestId) };
    }
    // A token whose partner is missing or belongs elsewhere is not merely
    // unscoped, it is incoherent — treat it as unauthenticated.
    if (!partner || partner.status !== "active" || partner.instance_id !== instanceId) {
      return { ok: false, response: unauthorized(requestId) };
    }
  }

  // ---- authenticated from here; failures below are 403, not 401 ----

  if (scope.actors && !scope.actors.includes(row.actor_type)) {
    return {
      ok: false,
      response: forbidden(
        requestId,
        `${scope.endpoint} is restricted to ${scope.actors.join(", ")}; this token is ${row.actor_type}`,
      ),
    };
  }

  if (!scopeAllows(row.allowed_endpoints ?? [], row.allowed_tiers ?? [], scope)) {
    return {
      ok: false,
      response: forbidden(
        requestId,
        `token is not scoped for ${scope.endpoint} (tier: ${scope.tier})`,
      ),
    };
  }

  // Rows are NOT NULL on partner_id, so every request needs an owner even when
  // the actor is not itself a fintech. Resolved from the table rather than
  // defaulted to a constant: an instance whose partner was seeded under a
  // different id must still stamp the right owner.
  let ownerPartnerId = row.partner_id;
  if (!ownerPartnerId) {
    const { data: sole, error: soleErr } = await db.schema("core").from("partner")
      .select("id")
      .eq("instance_id", instanceId)
      .eq("status", "active");
    if (soleErr) {
      // Authentication has ALREADY SUCCEEDED by this point — the token was
      // recognised, in scope, and unexpired. This query is ownership
      // resolution, and when it fails the caller's credential is not in
      // question at all. 503, for the same reason as the lookup above.
      console.error(`[${requestId}] owner partner lookup failed: ${soleErr.message}`);
      return { ok: false, response: serviceUnavailableResponse(requestId) };
    }
    const rows = (sole ?? []) as { id: string }[];
    // D18 says one instance hosts one fintech. If that ever stops holding, an
    // ops actor's writes have no unambiguous owner, and picking one would
    // silently attribute rows to the wrong fintech. Refuse instead.
    if (rows.length !== 1) {
      console.error(
        `[${requestId}] cannot resolve an owning partner: ${rows.length} active partners on ${instanceId}`,
      );
      return {
        ok: false,
        response: forbidden(
          requestId,
          "no unambiguous owning partner on this instance; this actor must act under an explicit partner",
        ),
      };
    }
    ownerPartnerId = rows[0].id;
  }

  return {
    ok: true,
    ctx: {
      tokenId: row.id,
      tokenPrefix: row.token_prefix,
      actorType: row.actor_type,
      roles: (row.roles ?? []) as BsaRole[],
      partnerId: row.partner_id,
      instanceId: row.instance_id,
      // ops/admin actors have no partner_id but still need a stable, distinct
      // idempotency namespace — the token id gives them one.
      idempotencyScope: row.partner_id ?? `token:${row.id}`,
      ownerPartnerId,
      // Test actors minted by the E2E flow harness (core/verifier/flows/) write
      // real evidence through real handlers, but it is manufactured traffic —
      // label it like the bootstrap key's, never as production. Only the
      // service role can insert api_token rows, so the prefix is not spoofable.
      evidenceProvenance: usedDemoKey || row.token_prefix.startsWith(TEST_TOKEN_PREFIX) ? "demo" : "production",
    },
  };
}

// ---------------------------------------------------------- token issuance

/**
 * Mint a new token. Returns the plaintext ONCE alongside the row to store;
 * the caller must persist `row` and hand `plaintext` to the partner. Nothing
 * anywhere writes the plaintext to the database.
 *
 * 32 bytes of CSPRNG entropy. The `cass_pt_` prefix makes a leaked token
 * greppable in logs and scannable by secret-detection tooling, which is worth
 * more than the obscurity it costs.
 */
export async function mintToken(params: {
  id: string;
  actorType: ActorType;
  partnerId: string | null;
  instanceId: string;
  allowedEndpoints: string[];
  allowedTiers: Tier[];
  expiresAt?: string | null;
}): Promise<{ plaintext: string; row: Record<string, unknown> }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const plaintext = `cass_pt_${secret}`;

  return {
    plaintext,
    row: {
      id: params.id,
      token_hash: await sha256Hex(plaintext),
      // non-secret leading slice, for logs and UIs only
      token_prefix: plaintext.slice(0, 16),
      actor_type: params.actorType,
      partner_id: params.partnerId,
      instance_id: params.instanceId,
      allowed_endpoints: params.allowedEndpoints,
      allowed_tiers: params.allowedTiers,
      status: "active",
      expires_at: params.expiresAt ?? null,
    },
  };
}

/** Signature every routed handler adapter conforms to. */
export type RouteHandler = (
  req: Request,
  params: Record<string, string>,
  requestId: string,
  ctx: PartnerContext,
) => Promise<Response>;

/**
 * One route-table entry (moved here from index.ts when the table split into
 * hand-written chrome/bespoke entries and the spec-generated routes.gen.ts —
 * both need the type, and auth.ts already owns EndpointScope).
 */
export interface Route extends EndpointScope {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
  /** Skip authentication entirely — pure-chrome surfaces only. */
  public?: true;
  /**
   * The spec's x-audience, carried through by gen_routes so the annotation
   * has a runtime consumer (route_gating.test.ts reconciles it against
   * PARTNER_SURFACE — an audience the tests don't vouch for is a lie).
   */
  audience?: "partner" | "internal" | "public";
}
