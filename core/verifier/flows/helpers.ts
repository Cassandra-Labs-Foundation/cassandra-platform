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

/** A whole partner journey; self-skips without credentials. Steps run in order. */
export function flow(name: string, fn: (t: Deno.TestContext) => Promise<void>): void {
  Deno.test({ name, ignore: !ENABLED, fn, sanitizeOps: false, sanitizeResources: false });
}
