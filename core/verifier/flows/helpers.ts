// Shared harness for the partner-flow suite (core/verifier/flows/).
//
// A flow test walks one whole journey the way an integrating fintech does it —
// onboard a member, verify them, open and fund accounts, move money — against
// the DEPLOYED core, then checks what the institution is left holding. HTTP
// answers are not enough on their own: a control that silently fails to fire
// produces a clean-looking audit, so every compliance claim is also asserted on
// the database row an examiner would read.
//
//   DEMO_API_KEY                         partner key (acts as the partner)
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY   read-back of the evidence rows
//   CONTRACT_API_URL                     base URL (default: the demo instance)
//
// The suite self-skips unless all three credentials are present. Isolation is
// additive, as in the contract suite: run-unique fixtures, never /sandbox/reset.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ENABLED as API_ENABLED } from "../contract/helpers.ts";

export { api, assert, assertEq, type Any, personaName, uid } from "../contract/helpers.ts";

const DB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const DB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
export const ENABLED = API_ENABLED && DB_URL.length > 0 && DB_KEY.length > 0;

let client: SupabaseClient | null = null;
/** service-role client for reading evidence rows in the `core` schema */
export function core() {
  client ??= createClient(DB_URL, DB_KEY, { auth: { persistSession: false } });
  return client.schema("core");
}

// ------------------------------------------------------------ impersonation
//
// DEMO_API_KEY is a pynthia_ops bootstrap credential, so on its own the suite
// can only act as operations. actor() mints a real api_token for any actor and
// BSA duty role, run-scoped and labelled: the `cass_test` prefix makes the
// core stamp everything it writes as `demo` evidence (auth.ts
// TEST_TOKEN_PREFIX), and every token minted in a run is revoked when the
// flow ends. Only the sha256 is stored, as with scripts/issue-token.ts.

export type ActorType = "partner" | "cu_admin" | "pynthia_ops";
export type BsaRole = "bsa_investigator" | "bsa_officer" | "bsa_compliance" | "bsa_counsel";

const minted: string[] = [];

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mint a test token acting as `actorType` with `roles`; returns the plaintext key. */
export async function actor(actorType: ActorType, roles: BsaRole[] = []): Promise<string> {
  const inst = await core().from("instance").select("id").limit(1).single();
  if (inst.error) throw new Error(`actor: instance lookup: ${inst.error.message}`);
  let partnerId: string | null = null;
  if (actorType === "partner") {
    // THIS instance's partner: the core also hosts ptnr_drill on inst_drill,
    // and a token bound to another instance's partner authenticates as 401.
    const p = await core().from("partner").select("id")
      .eq("status", "active").eq("instance_id", inst.data.id).order("id").limit(1).single();
    if (p.error) throw new Error(`actor: partner lookup: ${p.error.message}`);
    partnerId = p.data.id;
  }
  const rand = [...crypto.getRandomValues(new Uint8Array(20))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const plaintext = `cass_test_${rand}`;
  const id = `tok_test_${actorType}_${rand.slice(0, 12)}`;
  const ins = await core().from("api_token").insert({
    id, token_hash: await sha256Hex(plaintext), token_prefix: "cass_test",
    actor_type: actorType, roles, partner_id: partnerId, instance_id: inst.data.id,
    allowed_endpoints: ["*"], allowed_tiers: ["read", "write", "realtime", "bulk"], status: "active",
  });
  if (ins.error) throw new Error(`actor: token insert: ${ins.error.message}`);
  minted.push(id);
  return plaintext;
}

async function revokeMinted(): Promise<void> {
  if (!minted.length) return;
  const ids = minted.splice(0);
  const r = await core().from("api_token").update({ status: "revoked" }).in("id", ids);
  if (r.error) console.error(`revoking test tokens ${ids.join(",")}: ${r.error.message}`);
}

/** A whole journey; self-skips without credentials. Steps run in order. */
export function flow(name: string, fn: (t: Deno.TestContext) => Promise<void>): void {
  Deno.test({
    name, ignore: !ENABLED, sanitizeOps: false, sanitizeResources: false,
    fn: async (t) => {
      try {
        await fn(t);
      } finally {
        await revokeMinted();
      }
    },
  });
}
