// Shared harness for the black-box contract suite (TEST-CATALOG.md).
//
// Drives the DEPLOYED core over HTTP — never imports the implementation
// (PRINCIPLES P1: the core may be regenerated in any language and this suite
// is unchanged). Auth and target come from the environment:
//
//   CONTRACT_API_URL   base URL (default: the demo instance)
//   DEMO_API_KEY       partner key (required — suite self-skips without it)
//
// Isolation model: ADDITIVE, like the live control tier. Tests create their
// own run-unique fixtures and never call the destructive /sandbox/reset —
// the demo instance is shared, and a suite that wipes it to get isolation
// would be testing against an institution that no longer exists.

// deno-lint-ignore no-explicit-any
export type Any = any;

export const API = Deno.env.get("CONTRACT_API_URL") ??
  "https://jynsipdvrgqdkeqrlzcv.functions.supabase.co/api";
export const KEY = Deno.env.get("DEMO_API_KEY") ?? "";
export const ENABLED = KEY.length > 0;

let counter = Math.floor(Math.random() * 1_000_000);
/** run-unique suffix — convergent ids would collide with prior runs' rows */
export const uid = (): string => `ct_${Date.now().toString(36)}_${++counter}`;

// Realistic display names for suite-created person fixtures. Rotates so a run
// spreads across the roster instead of stamping one label; the entity id — not
// the name — is the unique key, so a shared name across rows is fine.
const PERSONA_POOL = [
  "Elena Marsh", "James Okafor", "Diego Ramirez", "Sofia Bennett", "Aisha Khan", "Maya Patel",
  "Lucas Romano", "Chloe Nguyen", "Isaac Adeyemi", "Nora Sullivan", "Gabriel Costa", "Hannah Weiss",
  "Omar Haddad", "Ava Lindqvist", "Julian Torres", "Zoe Callahan", "Ruth Mensah", "Caleb Fry",
  "Leila Haddad", "Theo Vance", "Mira Kapoor", "Owen Slater", "Farah Aziz", "Daniel Cho",
];
let personaIdx = Math.floor(Math.random() * PERSONA_POOL.length);
/** a realistic person name for a fresh fixture, rotating through the pool */
export const personaName = (): string => PERSONA_POOL[personaIdx++ % PERSONA_POOL.length];

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: Any;
}

export async function api(
  method: string,
  path: string,
  body?: unknown,
  opts: { key?: string | null; idem?: string | null; headers?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key !== null) headers["X-Api-Key"] = opts.key ?? KEY;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idem !== null && method !== "GET") headers["Idempotency-Key"] = opts.idem ?? uid();
  // A request that never left the machine (connection refused / no local
  // port free — "error sending request") did nothing on the core, so it is
  // retried with the SAME Idempotency-Key. Parallel flow runs open many
  // connections at once and a transient local network blip otherwise fails
  // whole flows. A timeout is NOT retried: the server may have acted.
  let res: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      break;
    } catch (e) {
      const unsent = e instanceof TypeError && /error sending request|connection/i.test(e.message);
      if (!unsent || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  const text = await res.text();
  let parsed: Any = text;
  try {
    parsed = JSON.parse(text);
  } catch { /* non-JSON stays raw for the assertion message */ }
  return { status: res.status, headers: res.headers, body: parsed };
}

/** Deno.test that self-skips when the suite has no credentials. */
export function t(name: string, fn: () => Promise<void>, ignore = false): void {
  Deno.test({ name, ignore: ignore || !ENABLED, fn });
}

export function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** D12-T1 — the error envelope every non-2xx response must carry. */
export function assertErrorShape(r: ApiResponse, msg: string): void {
  for (const field of ["status", "type", "title", "detail", "doc_url", "request_id"]) {
    assert(field in (r.body ?? {}), `${msg}: error envelope missing '${field}' — got ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  assertEq(r.body.status, r.status, `${msg}: envelope status mirrors HTTP status`);
}

/** Fixture: a fresh person entity, returning its id. */
export async function mkEntity(name?: string): Promise<string> {
  const r = await api("POST", "/entities", {
    type: "person", name: name ?? personaName(), date_of_birth: "1990-01-01",
  });
  assert(r.status === 200 || r.status === 201, `mkEntity: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return String(r.body.id ?? r.body.data?.id);
}

/** Fixture: a fresh checking account for an entity, returning its id. */
export async function mkAccount(entityId: string, openingCents = 0): Promise<string> {
  const r = await api("POST", "/accounts", {
    entity_id: entityId, account_type: "checking",
    // zero is refused ("must be a positive integer") — omit when unfunded
    ...(openingCents > 0 ? { opening_deposit_cents: openingCents } : {}),
  });
  assert(r.status === 200 || r.status === 201, `mkAccount: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return String(r.body.id ?? r.body.data?.id);
}
