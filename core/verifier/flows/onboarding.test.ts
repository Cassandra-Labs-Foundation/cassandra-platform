// Onboarding flows: the part of a fintech's integration that happens before
// any money moves. A partner creates the people and organizations behind its
// accounts (all four entity types), records who owns a business, walks members
// through their lifecycle, verifies them through the KYC adapter (with the OFAC
// floor underneath every path), and gives their accounts routable numbers.
//
// Ported from core/supabase/tests/e2e/compliance_e2e.sh sections 27 (entities),
// 28 (account numbers) and 29 (KYC + OFAC floor). Every step acts as a real
// partner (a cass_test partner token, not the ops bootstrap key) and checks the
// row an examiner would read, not only the HTTP answer.
import { actor, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

// --------------------------------------------------------------- local helpers
//
// actor("partner") picks "the first active partner", but the live core also
// hosts ptnr_drill on a different instance, and a token whose partner is on
// another instance authenticates as 401. Mint the partner token against the
// partner that belongs to THIS instance instead — same labelling and the same
// revoke-on-exit discipline as helpers.ts.

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function homePartner(): Promise<{ instanceId: string; partnerId: string }> {
  const inst = await core().from("instance").select("id").limit(1).single();
  if (inst.error) throw new Error(`instance lookup: ${inst.error.message}`);
  const p = await core().from("partner").select("id")
    .eq("status", "active").eq("instance_id", inst.data.id).order("id").limit(1).single();
  if (p.error) throw new Error(`partner lookup: ${p.error.message}`);
  return { instanceId: inst.data.id, partnerId: p.data.id };
}

/** A wildcard partner token for this instance's partner; revoked by the caller. */
async function mintPartner(minted: string[]): Promise<string> {
  const { instanceId, partnerId } = await homePartner();
  const rand = [...crypto.getRandomValues(new Uint8Array(20))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const plaintext = `cass_test_${rand}`;
  const id = `tok_test_onb_${rand.slice(0, 12)}`;
  const ins = await core().from("api_token").insert({
    id, token_hash: await sha256Hex(plaintext), token_prefix: "cass_test",
    actor_type: "partner", roles: [], partner_id: partnerId, instance_id: instanceId,
    allowed_endpoints: ["*"], allowed_tiers: ["read", "write", "realtime", "bulk"], status: "active",
  });
  if (ins.error) throw new Error(`token insert: ${ins.error.message}`);
  minted.push(id);
  return plaintext;
}

async function revoke(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const r = await core().from("api_token").update({ status: "revoked" }).in("id", ids.splice(0));
  if (r.error) console.error(`revoking onboarding tokens: ${r.error.message}`);
}

const show = (b: unknown) => JSON.stringify(b).slice(0, 300);

/** events recorded for one resource, oldest first */
async function eventsFor(resourceId: string): Promise<{ code: string; payload: Record<string, unknown> }[]> {
  const r = await core().from("event").select("code, payload, created_at")
    .eq("resource_id", resourceId).order("created_at", { ascending: true });
  assert(!r.error, `event read: ${r.error?.message}`);
  return (r.data ?? []) as { code: string; payload: Record<string, unknown> }[];
}

/** the Luhn check digit for an 11-digit body (doubling from the rightmost) */
function luhnDigit(body: string): number {
  let t = 0;
  [...body].reverse().forEach((ch, i) => {
    let d = Number(ch);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    t += d;
  });
  return (10 - (t % 10)) % 10;
}

function abaValid(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = [...routing].map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

// =============================================================================
// 27 — entities: all four types, the lifecycle machine, beneficial owners
// =============================================================================

flow("onboarding: a partner onboards a member and a business with its beneficial owner", async (t) => {
  const minted: string[] = [];
  try {
    const partner = await mintPartner(minted);
    const as = { key: partner };
    const run = uid();
    let person = "";
    let business = "";

    await t.step("create a person: 201, starts PENDING, owned by the partner, entity.created logged", async () => {
      const r = await api("POST", "/entities", {
        type: "person", name: personaName(), date_of_birth: "1990-01-01",
        address: "12 Elm St, Springfield, IL 62701",
      }, as);
      assertEq(r.status, 201, `create person (${show(r.body)})`);
      assertEq(r.body.status, "pending", "a new member starts pending");
      assertEq(r.body.type, "person", "type discriminator");
      assert(String(r.body.id).startsWith("ent_"), `entity id shape (${r.body.id})`);
      person = String(r.body.id);

      const { partnerId } = await homePartner();
      const row = await core().from("entity").select("status, type, partner_id").eq("id", person).single();
      assertEq(row.data?.status, "pending", "entity row status");
      assertEq(row.data?.partner_id, partnerId, "the entity belongs to the partner that created it");
      const ev = await eventsFor(person);
      assert(ev.some((e) => e.code === "entity.created"), `entity.created emitted (${show(ev)})`);
    });

    await t.step("each type's identifying minimum is enforced: missing fields are 400 by field", async () => {
      const bad: [Record<string, unknown>, string][] = [
        [{ type: "person", name: "No DOB" }, "date_of_birth"],
        [{ type: "business", name: "No TIN LLC" }, "tin"],
        [{ type: "trust", name: "No Jurisdiction Trust" }, "jurisdiction"],
        [{ type: "llc", name: "Unknown Type" }, "type"],
        [{ name: "No Type At All" }, "type"],
      ];
      for (const [body, field] of bad) {
        const r = await api("POST", "/entities", body, as);
        assertEq(r.status, 400, `${show(body)} must be refused`);
        assert(
          (r.body.errors ?? []).some((e: { field: string }) => e.field === field),
          `${show(body)}: error names '${field}' (${show(r.body.errors)})`,
        );
      }
    });

    await t.step("business, trust and joint all create with their required fields", async () => {
      const bodies = [
        { type: "business", name: `Riverside Provisions LLC ${run}`, tin: "12-3456789" },
        { type: "trust", name: `Bellweather Family Trust ${run}`, jurisdiction: "MA" },
        { type: "joint", name: `Ada & Grace Bellweather ${run}` },
      ];
      for (const body of bodies) {
        const r = await api("POST", "/entities", body, as);
        assertEq(r.status, 201, `${body.type} creates (${show(r.body)})`);
        assertEq(r.body.type, body.type, "type round-trips");
        assertEq(r.body.status, "pending", `${body.type} starts pending`);
        const row = await core().from("entity").select("type").eq("id", r.body.id).single();
        assertEq(row.data?.type, body.type, `${body.type} row persisted`);
        if (body.type === "business") business = String(r.body.id);
      }
    });

    await t.step("activate the person: pending -> active, entity.activated logged", async () => {
      const r = await api("POST", `/entities/${person}/transition`, { to: "active" }, as);
      assertEq(r.status, 200, `activate (${show(r.body)})`);
      assertEq(r.body.status, "active", "response status");
      const row = await core().from("entity").select("status").eq("id", person).single();
      assertEq(row.data?.status, "active", "entity row status");
      const ev = await eventsFor(person);
      const act = ev.filter((e) => e.code === "entity.activated");
      assertEq(act.length, 1, "exactly one entity.activated for this member");
      assertEq(act[0].payload?.from, "pending", "event records where it came from");
    });

    await t.step("an illegal transition (active -> pending) is a 409 and leaves no event", async () => {
      const before = (await eventsFor(person)).length;
      const r = await api("POST", `/entities/${person}/transition`, { to: "pending" }, as);
      assertEq(r.status, 409, `illegal transition (${show(r.body)})`);
      assertEq(r.body.type, "invalid_state", "typed invalid_state");
      const row = await core().from("entity").select("status").eq("id", person).single();
      assertEq(row.data?.status, "active", "status untouched");
      assertEq((await eventsFor(person)).length, before, "a refused transition emits nothing");
    });

    await t.step("the business records the person as a 25% beneficial owner", async () => {
      const r = await api("POST", `/entities/${business}/owners`,
        { owner_entity_id: person, ownership_percent: 25 }, as);
      assertEq(r.status, 200, `add owner (${show(r.body)})`);
      assertEq(r.body.owners?.[0]?.entity_id, person, "owner on the response");
      assertEq(r.body.owners?.[0]?.percent, 25, "percent on the response");
      const row = await core().from("entity").select("owners").eq("id", business).single();
      const owners = (row.data?.owners ?? []) as { entity_id: string; percent: number }[];
      assertEq(owners.length, 1, "one owner persisted on the business");
      assertEq(owners[0].entity_id, person, "persisted owner is the person");
      assertEq(owners[0].percent, 25, "persisted percent");
      const ev = await eventsFor(business);
      assert(ev.some((e) => e.code === "entity.owner.added" && e.payload?.owner_entity_id === person),
        `entity.owner.added logged (${show(ev)})`);
    });

    await t.step("ownership percent is bounded (0, 100] with at most 2 decimals", async () => {
      for (const percent of [0, -5, 101, 25.55555]) {
        const r = await api("POST", `/entities/${business}/owners`,
          { owner_entity_id: person, ownership_percent: percent }, as);
        assertEq(r.status, 400, `percent ${percent} refused (${show(r.body)})`);
      }
      const row = await core().from("entity").select("owners").eq("id", business).single();
      assertEq((row.data?.owners ?? []).length, 1, "no refused owner leaked into the record");
    });

    await t.step("a person cannot have beneficial owners: 409", async () => {
      const r = await api("POST", `/entities/${person}/owners`,
        { owner_entity_id: business, ownership_percent: 25 }, as);
      assertEq(r.status, 409, `owner on a person (${show(r.body)})`);
      const row = await core().from("entity").select("owners").eq("id", person).single();
      assertEq((row.data?.owners ?? []).length, 0, "the person's owners stay empty");
    });

    await t.step("the unified list filters by type and refuses an unknown type", async () => {
      const r = await api("GET", "/entities?type=business&limit=50", undefined, as);
      assertEq(r.status, 200, "list");
      assert(r.body.data.length > 0, "businesses listed");
      assert(r.body.data.every((e: { type: string }) => e.type === "business"),
        `only businesses (${show(r.body.data.map((e: { type: string }) => e.type))})`);
      assert(r.body.data.some((e: { id: string }) => e.id === business), "our business is on the page");

      const mixed = await api("GET", "/entities?limit=50", undefined, as);
      const types = new Set(mixed.body.data.map((e: { type: string }) => e.type));
      assert(types.size > 1, `no filter -> mixed types (${[...types]})`);

      const bad = await api("GET", "/entities?type=llc", undefined, as);
      assertEq(bad.status, 400, "unknown type filter refused");
      assert((bad.body.errors ?? []).some((e: { field: string }) => e.field === "type"), "error names 'type'");
    });

    await t.step("the lifecycle walks active -> disabled -> active -> archived; archived is terminal", async () => {
      for (const to of ["disabled", "active", "archived"]) {
        const r = await api("POST", `/entities/${person}/transition`, { to }, as);
        assertEq(r.status, 200, `-> ${to} (${show(r.body)})`);
      }
      const back = await api("POST", `/entities/${person}/transition`, { to: "active" }, as);
      assertEq(back.status, 409, "archived -> active refused");
      const codes = (await eventsFor(person)).map((e) => e.code);
      for (const c of ["entity.disabled", "entity.archived"]) {
        assert(codes.includes(c), `${c} logged (${codes})`);
      }
      assertEq(codes.filter((c) => c === "entity.activated").length, 2,
        "re-activation is its own event, not deduped");
      const row = await core().from("entity").select("status").eq("id", person).single();
      assertEq(row.data?.status, "archived", "entity row is archived");
    });
  } finally {
    await revoke(minted);
  }
});

// =============================================================================
// 27 (locks + account machine) and 28 — an account's lock and its numbers
// =============================================================================

flow("onboarding: an account is locked for review, unlocked, numbered, and its numbers retired", async (t) => {
  const minted: string[] = [];
  try {
    const partner = await mintPartner(minted);
    const as = { key: partner };
    let account = "";
    const numbers: { id: string; routing: string; number: string }[] = [];

    await t.step("open an account for a new member", async () => {
      const e = await api("POST", "/entities", {
        type: "person", name: personaName(), date_of_birth: "1987-06-01",
      }, as);
      assertEq(e.status, 201, `entity (${show(e.body)})`);
      const a = await api("POST", "/accounts", { entity_id: e.body.id, account_type: "checking" }, as);
      assertEq(a.status, 201, `account (${show(a.body)})`);
      account = String(a.body.id);
    });

    await t.step("a compliance lock leaves the account open and is logged with its reason", async () => {
      const r = await api("POST", `/accounts/${account}/lock`, { lock_type: "compliance", reason: "BSA review" }, as);
      assertEq(r.status, 200, `lock (${show(r.body)})`);
      assertEq(r.body.status, "open", "status on the response");
      assertEq(r.body.lock_type, "compliance", "lock on the response");
      const row = await core().from("account").select("status, lock_type").eq("id", account).single();
      assertEq(row.data?.status, "open", "a lock must not touch status");
      assertEq(row.data?.lock_type, "compliance", "lock persisted");
      const ev = (await eventsFor(account)).filter((e) => e.code === "account.locked");
      assertEq(ev.length, 1, "account.locked logged once");
      assertEq(ev[0].payload?.reason, "BSA review", "the reason is in the log");
    });

    await t.step("unlock restores none and is logged too", async () => {
      const r = await api("POST", `/accounts/${account}/lock`, { lock_type: "none" }, as);
      assertEq(r.status, 200, `unlock (${show(r.body)})`);
      const row = await core().from("account").select("status, lock_type").eq("id", account).single();
      assertEq(row.data?.lock_type, "none", "lock cleared");
      assertEq(row.data?.status, "open", "still open");
      const ev = (await eventsFor(account)).filter((e) => e.code === "account.unlocked");
      assertEq(ev.length, 1, "account.unlocked logged");
      assertEq(ev[0].payload?.previous_lock, "compliance", "the log says what was lifted");
    });

    await t.step("mint a partner number: 12 digits, Luhn-valid, not under 000, ABA routing", async () => {
      const r = await api("POST", `/accounts/${account}/numbers`, {}, as);
      assertEq(r.status, 201, `mint (${show(r.body)})`);
      const n = String(r.body.account_number);
      assert(/^\d{12}$/.test(n), `12 digits (${n})`);
      assert(!n.startsWith("000"), `partner numbers never use the CU-direct prefix (${n})`);
      assertEq(Number(n[11]), luhnDigit(n.slice(0, 11)), `Luhn check digit (${n})`);
      assert(abaValid(String(r.body.routing_number)), `routing ${r.body.routing_number} passes the ABA checksum`);
      assertEq(r.body.status, "active", "minted active");
      numbers.push({ id: String(r.body.id), routing: String(r.body.routing_number), number: n });

      const row = await core().from("account_number").select("account_id, status, account_number")
        .eq("id", r.body.id).single();
      assertEq(row.data?.account_id, account, "bound to the account");
      assertEq(row.data?.status, "active", "row active");
      assertEq(row.data?.account_number, n, "row carries the number");
    });

    await t.step("a CU-direct number mints under the reserved 000 prefix", async () => {
      const r = await api("POST", `/accounts/${account}/numbers`, { cu_direct: true }, as);
      assertEq(r.status, 201, `mint cu_direct (${show(r.body)})`);
      const n = String(r.body.account_number);
      assert(n.startsWith("000"), `CU-direct prefix (${n})`);
      assertEq(Number(n[11]), luhnDigit(n.slice(0, 11)), `Luhn check digit (${n})`);
      numbers.push({ id: String(r.body.id), routing: String(r.body.routing_number), number: n });
    });

    await t.step("one account carries many distinct pairs, listed on the account", async () => {
      const r3 = await api("POST", `/accounts/${account}/numbers`, {}, as);
      assertEq(r3.status, 201, "third mint");
      numbers.push({ id: String(r3.body.id), routing: String(r3.body.routing_number), number: String(r3.body.account_number) });
      const list = await api("GET", `/accounts/${account}/numbers`, undefined, as);
      assertEq(list.status, 200, "list numbers");
      const pairs = list.body.data.map((x: { routing_number: string; account_number: string }) =>
        `${x.routing_number}:${x.account_number}`);
      assertEq(pairs.length, 3, `three numbers on the account (${pairs})`);
      assertEq(new Set(pairs).size, 3, "all pairs distinct");
      for (const n of numbers) assert(pairs.includes(`${n.routing}:${n.number}`), `${n.number} listed`);
    });

    await t.step("minting on an unknown account is a 404", async () => {
      const r = await api("POST", `/accounts/acct_${uid()}/numbers`, {}, as);
      assertEq(r.status, 404, `unknown account (${show(r.body)})`);
    });

    await t.step("a number walks active -> disabled -> active -> canceled, each step logged", async () => {
      const n = numbers[0];
      for (const to of ["disabled", "active", "canceled"]) {
        const r = await api("POST", `/account-numbers/${n.id}/transition`, { to }, as);
        assertEq(r.status, 200, `-> ${to} (${show(r.body)})`);
        assertEq(r.body.status, to, "status on the response");
      }
      const codes = (await eventsFor(n.id)).map((e) => e.code);
      assertEq(codes.join(","), "account_number.disabled,account_number.activated,account_number.canceled",
        "the number's history is in the log");
    });

    await t.step("canceled is forever: no reactivation, and the pair is never reissued", async () => {
      const n = numbers[0];
      for (const to of ["active", "disabled"]) {
        const r = await api("POST", `/account-numbers/${n.id}/transition`, { to }, as);
        assertEq(r.status, 409, `canceled -> ${to} (${show(r.body)})`);
        assertEq(r.body.type, "invalid_state", "typed invalid_state");
      }
      const row = await core().from("account_number").select("status").eq("id", n.id).single();
      assertEq(row.data?.status, "canceled", "row still canceled");
      const same = await core().from("account_number").select("id")
        .eq("routing_number", n.routing).eq("account_number", n.number);
      assertEq((same.data ?? []).length, 1, "exactly one row ever holds this pair");
    });

    await t.step("the account machine: frozen and back, then closed for good — each step logged", async () => {
      for (const to of ["frozen", "open", "closed"]) {
        const r = await api("POST", `/accounts/${account}/transition`, { to }, as);
        assertEq(r.status, 200, `-> ${to} (${show(r.body)})`);
      }
      const back = await api("POST", `/accounts/${account}/transition`, { to: "open" }, as);
      assertEq(back.status, 409, "closed -> open refused");
      const codes = (await eventsFor(account)).map((e) => e.code);
      for (const c of ["account.frozen", "account.opened", "account.closed"]) {
        assert(codes.includes(c), `${c} logged (${codes})`);
      }
      const row = await core().from("account").select("status").eq("id", account).single();
      assertEq(row.data?.status, "closed", "account row closed");
    });
  } finally {
    await revoke(minted);
  }
});

// =============================================================================
// 29 — KYC through the adapter, and the OFAC floor nothing can override
// =============================================================================

flow("onboarding: KYC through the adapter — sims, attestations, providers, and the OFAC floor", async (t) => {
  const minted: string[] = [];
  try {
    const partner = await mintPartner(minted);
    const as = { key: partner };
    let applicant = "";
    let sdn = "";
    const runs: string[] = [];

    await t.step("create the applicant", async () => {
      const r = await api("POST", "/entities", {
        type: "person", name: personaName(), date_of_birth: "1992-03-03",
      }, as);
      assertEq(r.status, 201, `applicant (${show(r.body)})`);
      applicant = String(r.body.id);
    });

    let cleanVer = "";
    await t.step("a default run goes through the adapter (alloy) and approves", async () => {
      const r = await api("POST", `/entities/${applicant}/verifications`, {}, as);
      assertEq(r.status, 201, `run (${show(r.body)})`);
      assertEq(r.body.provider, "alloy", "default provider");
      assertEq(r.body.status, "approved", "decision");
      assertEq(r.body.ofac_result, "clear", "OFAC cleared");
      assert(String(r.body.id).startsWith("ver_"), "verification id");
      cleanVer = String(r.body.id);
      runs.push(cleanVer);
      const row = await core().from("verification")
        .select("entity_id, provider, status, ofac_result, match_status").eq("id", cleanVer).single();
      assertEq(row.data?.entity_id, applicant, "who was verified is recorded");
      assertEq(row.data?.provider, "alloy", "provider recorded");
      assertEq(row.data?.status, "approved", "decision recorded");
      assertEq(row.data?.match_status, "no_match", "screen outcome recorded");
      const ev = await eventsFor(cleanVer);
      assert(ev.some((e) => e.code === "verification.approved"), `verification.approved logged (${show(ev)})`);
    });

    await t.step("a clean pass still leaves CG-OFAC-01 evidence", async () => {
      const cr = await core().from("control_result").select("decision, subject_ref")
        .eq("event", cleanVer).eq("control_id", "CG-OFAC-01");
      assertEq((cr.data ?? []).length, 1, "one OFAC control_result for the run");
      assertEq(cr.data![0].decision, "pass", "pass");
      assertEq(cr.data![0].subject_ref, applicant, "names the member screened");
    });

    await t.step("the OFAC evidence a test token writes is labelled demo, not production", async () => {
      // Regression guard (bug found by this flow, fixed 2026-10-03): kyc.ts:118 inserts the CG-OFAC-01 control_result with no provenance, so it lands 'unknown' instead of provenanceFor(ctx) ('demo' for a cass_test token)
      const cr = await core().from("control_result").select("provenance")
        .eq("event", cleanVer).eq("control_id", "CG-OFAC-01").single();
      assertEq(cr.data?.provenance, "demo", "CG-OFAC-01 provenance under a cass_test token");
    });

    await t.step("simulations force the outcome: deny denies, approve approves", async () => {
      for (const [simulate, expected] of [["deny", "denied"], ["approve", "approved"]]) {
        const r = await api("POST", `/entities/${applicant}/verifications`, { simulate }, as);
        assertEq(r.status, 201, `simulate ${simulate} (${show(r.body)})`);
        assertEq(r.body.status, expected, `simulate=${simulate}`);
        runs.push(String(r.body.id));
        const row = await core().from("verification").select("status").eq("id", r.body.id).single();
        assertEq(row.data?.status, expected, `${simulate} persisted`);
        const ev = await eventsFor(String(r.body.id));
        assert(ev.some((e) => e.code === `verification.${expected}`), `verification.${expected} logged`);
      }
    });

    await t.step("a partner attestation records its trust level", async () => {
      const r = await api("POST", `/entities/${applicant}/verifications`,
        { attestation: { partner: "fintech-x", trust_level: "partial" } }, as);
      assertEq(r.status, 201, `attested run (${show(r.body)})`);
      assertEq(r.body.trust_level, "partial", "trust level on the response");
      runs.push(String(r.body.id));
      const row = await core().from("verification").select("trust_level").eq("id", r.body.id).single();
      assertEq(row.data?.trust_level, "partial", "trust level persisted");
    });

    await t.step("alloy, socure and middesk all work through the one adapter", async () => {
      for (const provider of ["alloy", "socure", "middesk"]) {
        const r = await api("POST", `/entities/${applicant}/verifications`, { provider }, as);
        assertEq(r.status, 201, `${provider} (${show(r.body)})`);
        assertEq(r.body.provider, provider, "provider on the response");
        runs.push(String(r.body.id));
        const row = await core().from("verification").select("provider").eq("id", r.body.id).single();
        assertEq(row.data?.provider, provider, `${provider} persisted`);
      }
    });

    await t.step("bad inputs are refused, never silently defaulted — and leave no record", async () => {
      const before = await core().from("verification").select("id").eq("entity_id", applicant);
      const bad: [Record<string, unknown>, string][] = [
        [{ provider: "experian" }, "provider"],
        [{ attestation: { partner: "fintech-x", trust_level: "absolute" } }, "attestation.trust_level"],
        [{ simulate: "maybe" }, "simulate"],
      ];
      for (const [body, field] of bad) {
        const r = await api("POST", `/entities/${applicant}/verifications`, body, as);
        assertEq(r.status, 400, `${show(body)} refused`);
        assert((r.body.errors ?? []).some((e: { field: string }) => e.field === field),
          `error names '${field}' (${show(r.body.errors)})`);
      }
      const after = await core().from("verification").select("id").eq("entity_id", applicant);
      assertEq((after.data ?? []).length, (before.data ?? []).length, "no verification row for a refused run");
    });

    await t.step("the member's verification history shows every run, newest first", async () => {
      const r = await api("GET", `/entities/${applicant}/verifications`, undefined, as);
      assertEq(r.status, 200, "history");
      const ids = r.body.verifications.map((v: { id: string }) => v.id);
      assertEq(r.body.count, runs.length, `count matches the runs made (${ids.length})`);
      for (const id of runs) assert(ids.includes(id), `${id} in history`);
      assertEq(ids[ids.length - 1], runs[0], "the first run is oldest");
      assert(!("provider_result" in r.body.verifications[0]), "raw provider payload is not served");
    });

    await t.step("an SDN-listed applicant is denied on a plain run, with the hit evidenced", async () => {
      const e = await api("POST", "/entities", {
        type: "person", name: `Viktor Sokolov SDN ${uid()}`, date_of_birth: "1980-01-01",
      }, as);
      assertEq(e.status, 201, "sdn entity");
      sdn = String(e.body.id);
      const r = await api("POST", `/entities/${sdn}/verifications`, {}, as);
      assertEq(r.status, 201, `run (${show(r.body)})`);
      assertEq(r.body.status, "denied", "OFAC hit denies");
      assertEq(r.body.ofac_result, "hit", "hit reported");
      const cr = await core().from("control_result").select("decision")
        .eq("event", r.body.id).eq("control_id", "CG-OFAC-01");
      assertEq(cr.data?.map((c) => c.decision).join(","), "reject", "CG-OFAC-01 reject recorded");
      const row = await core().from("verification").select("status, match_status").eq("id", r.body.id).single();
      assertEq(row.data?.status, "denied", "denial persisted");
      assertEq(row.data?.match_status, "match", "match persisted");
    });

    await t.step("neither a full-trust attestation nor a forced approve gets past the floor", async () => {
      const attempts = [
        { attestation: { partner: "fintech-x", trust_level: "full" } },
        { simulate: "approve" },
        { provider: "socure", simulate: "approve" },
      ];
      for (const body of attempts) {
        const r = await api("POST", `/entities/${sdn}/verifications`, body, as);
        assertEq(r.status, 201, `${show(body)} (${show(r.body)})`);
        assertEq(r.body.status, "denied", `${show(body)}: the floor beats it`);
        const cr = await core().from("control_result").select("decision")
          .eq("event", r.body.id).eq("control_id", "CG-OFAC-01");
        assertEq(cr.data?.map((c) => c.decision).join(","), "reject", `${show(body)}: reject recorded`);
      }
      const approved = await core().from("verification").select("id")
        .eq("entity_id", sdn).eq("status", "approved");
      assertEq((approved.data ?? []).length, 0, "the SDN applicant was never approved by any path");
    });

    await t.step("each OFAC hit raised a BSA alert naming the applicant, labelled demo", async () => {
      const alerts = await core().from("bsa_alert").select("id, status, provenance")
        .eq("alert_type", "ofac").like("details", `%${sdn}%`);
      assert(!alerts.error, `bsa_alert read: ${alerts.error?.message}`);
      assertEq((alerts.data ?? []).length, 4, "one ofac alert per screened run (4 runs)");
      for (const a of alerts.data!) {
        assertEq(a.status, "open", `${a.id} open for triage`);
        assertEq(a.provenance, "demo", `${a.id} is test-actor evidence`);
      }
    });
  } finally {
    await revoke(minted);
  }
});

// A partner whose create request times out retries it with the same
// Idempotency-Key. The spec (create_entity) promises the retry replays the
// first member rather than minting a duplicate, and that reusing the key for a
// DIFFERENT member is a 409 — a duplicate person record is a CIP problem, not
// a cosmetic one.
flow("onboarding: a retried member create replays; the same key for someone else is refused", async (t) => {
  const partner = await actor("partner");
  const key = `flow-ent-${crypto.randomUUID()}`;
  // run-unique: persona names rotate, so the "exactly one" check must not
  // count a namesake from an earlier run
  const person = { type: "person", name: `${personaName()} ${uid().slice(-6)}`, date_of_birth: "1985-02-03" };
  let firstId = "";

  await t.step("the first create succeeds", async () => {
    const r = await api("POST", "/entities", person, { key: partner, idem: key });
    assertEq(r.status, 201, `create (${JSON.stringify(r.body).slice(0, 200)})`);
    firstId = String(r.body.id);
  });

  await t.step("the retry with the same key and body replays the same member", async () => {
    const r = await api("POST", "/entities", person, { key: partner, idem: key });
    assertEq(r.status, 201, `retry (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(String(r.body.id), firstId, "same member, not a duplicate");
    assertEq(r.headers.get("Idempotent-Replayed"), "true", "marked as a replay");
  });

  await t.step("the same key for a different person is refused 409", async () => {
    const r = await api("POST", "/entities", { ...person, name: `${person.name} Jr` }, { key: partner, idem: key });
    assertEq(r.status, 409, `reuse (${JSON.stringify(r.body).slice(0, 200)})`);
    assertEq(r.body.type, "idempotency_key_reused", "typed refusal");
  });

  await t.step("exactly one member exists under that name", async () => {
    const rows = await core().from("entity").select("id").eq("name", person.name).eq("date_of_birth", "1985-02-03");
    assertEq((rows.data ?? []).length, 1, "one entity row");
  });
});
