// Charitable Donation Account flows (CDA-01..CDA-14, 12 CFR 721.3(b)(2)).
//
// A CDA is the credit union's OWN programme, run by staff: the Board adopts the
// policy, Compliance qualifies the trustee and files the structure evidence,
// operations funds the account, trades it, gives from it and winds it up. A
// partner never sees any of it. So every flow acts as a credit-union staff
// token (cu_admin + bsa_compliance), and the first flow proves a partner gets
// 404 on the surface. Replaces core/supabase/functions/api/cda.test.ts (see
// ledger/cda.md).
//
// THE PROGRAMME IS A SINGLETON. The Board adoption (core.cda_policy), the net
// worth (core.capital_position) and the 5% cap (aggregate over every open CDA)
// are instance-wide by design. So:
//   * flows that need a live programme adopt a run-unique policy version and
//     RESTORE the adoption that was active before them when they end (a
//     service-role write, like the token revocation in helpers.ts). On the demo
//     instance the seeded adoption is deliberately expired; it is put back.
//   * funding amounts are computed from the live net worth and the aggregate of
//     every other open CDA, never hardcoded, and every funded CDA is terminated
//     and closed at the end so the instance aggregate returns to where it was.
//   * the capital position is NEVER written: moving it would rewrite the
//     instance's PCA story. The one breach scenario that needs net worth to
//     fall is staged on the flow's OWN cap-test row (see the cap flow).
import { actor, type Any, api, assert, assertEq, core, flow } from "./helpers.ts";

/** assertEq is strict (===); arrays and objects compare by value here */
const assertSame = (actual: unknown, expected: unknown, msg: string) =>
  assertEq(JSON.stringify(actual), JSON.stringify(expected), msg);

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 400);
const run = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

const ALL_CLAUSES = {
  agreement_named_charities_clause: true, agreement_strategy_clause: true,
  agreement_gaap_clause: true, agreement_distribution_clause: true,
};
const CHARITY = { donee_ein: "12-3456789", donee_irs_status: "501c3" };

async function rowById(table: string, id: string) {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data as Any;
}

async function rows(table: string, col: string, val: string) {
  const r = await core().from(table).select("*").eq(col, val).order("created_at");
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return (r.data ?? []) as Any[];
}

/** CDA events are stamped resource_id = "cda:<resource>" (cda.ts emit()) */
async function events(resource: string, code: string) {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("resource_id", `cda:${resource}`).eq("code", code);
  assert(!r.error, `event read: ${r.error?.message}`);
  return (r.data ?? []) as Any[];
}

// ------------------------------------------------------------- the programme

const FLOW_POLICY_PREFIX = "cdapol_flow";

/** The adoptions active before this flow touched anything (restored at the end). */
async function snapshotPolicy(): Promise<string[]> {
  const live = await core().from("cda_policy").select("id")
    .is("superseded_at", null).not("id", "like", `${FLOW_POLICY_PREFIX}%`);
  assert(!live.error, `cda_policy read: ${live.error?.message}`);
  if ((live.data ?? []).length > 0) return live.data!.map((p: Any) => String(p.id));
  // a previous run died before restoring: the instance's own adoption is the
  // latest non-flow one
  const last = await core().from("cda_policy").select("id")
    .not("id", "like", `${FLOW_POLICY_PREFIX}%`).order("adopted_at", { ascending: false }).limit(1);
  return (last.data ?? []).map((p: Any) => String(p.id));
}

async function restorePolicy(snapshot: string[]): Promise<void> {
  const now = new Date().toISOString();
  const a = await core().from("cda_policy").update({ superseded_at: now })
    .is("superseded_at", null).like("id", `${FLOW_POLICY_PREFIX}%`);
  if (a.error) console.error(`restoring cda_policy (supersede flow adoptions): ${a.error.message}`);
  if (snapshot.length) {
    const b = await core().from("cda_policy").update({ superseded_at: null }).in("id", snapshot);
    if (b.error) console.error(`restoring cda_policy ${snapshot.join(",")}: ${b.error.message}`);
  }
}

function monthsFrom(d: Date, months: number): Date {
  const x = new Date(d.getTime());
  x.setUTCMonth(x.getUTCMonth() + months);
  return x;
}

/** Board adopts `version`, `monthsAgo` months back, on the default 12-month term. */
async function adopt(staff: string, version: string, monthsAgo: number) {
  const adoptedAt = monthsFrom(new Date(), -monthsAgo);
  const r = await api("POST", "/cda/policy", {
    policy_version: version, board_resolution_id: `board-${version}`,
    adopted_at: adoptedAt.toISOString(),
  }, { key: staff });
  assertEq(r.status, 201, `adopt ${version} (${body(r)})`);
  return { id: String(r.body.data.id), adoptedAt, expiresAt: monthsFrom(adoptedAt, 12) };
}

async function latestNetWorth(): Promise<number> {
  const r = await core().from("capital_position").select("net_worth_cents")
    .order("as_of_date", { ascending: false }).limit(1);
  assert(!r.error && (r.data ?? []).length === 1, `capital_position read: ${r.error?.message}`);
  return Number(r.data![0].net_worth_cents);
}

/** what the gate sums: book value over every CDA that is not closed */
async function aggregateBook(): Promise<number> {
  const r = await core().from("cda").select("book_value_cents").neq("status", "closed");
  assert(!r.error, `cda aggregate read: ${r.error?.message}`);
  return (r.data ?? []).reduce((n: number, x: Any) => n + Number(x.book_value_cents ?? 0), 0);
}

/** a regulated trustee with registration evidence: qualifies */
async function qualifiedTrustee(staff: string, tag: string): Promise<string> {
  const r = await api("POST", "/cda/vendors", {
    name: `Northgate Trust ${tag}`, role: "trustee", regulator: "occ",
    registration_status: "active", registration_evidence_ref: `occ-cert-${tag}`,
  }, { key: staff });
  assertEq(r.status, 201, `onboard trustee (${body(r)})`);
  assertEq(r.body.data.qualified, true, "trustee qualifies on its evidence");
  return String(r.body.data.id);
}

/** structure + designation + custodial statement filed, all four clauses validated */
async function compliantCda(staff: string, id: string, vendorId: string): Promise<string> {
  const c = await api("POST", "/cda", {
    id, vendor_id: vendorId, structure_type: "segregated_custodial",
    account_label: "Pynthia Charitable Donation Account", custodian_statement_ref: `cust-${id}`,
  }, { key: staff });
  assertEq(c.status, 201, `create CDA (${body(c)})`);
  assert(c.body.data.evidence_packet_filed_at, "evidence packet filed");
  const a = await api("POST", `/cda/${id}/agreement`, { clauses: ALL_CLAUSES }, { key: staff });
  assertEq(a.status, 200, `agreement (${body(a)})`);
  assertEq(a.body.data.agreement_validated, true, "all four clauses validate");
  return id;
}

async function fund(staff: string, cdaId: string, amount: number, extra: Record<string, unknown> = {}) {
  return await api("POST", `/cda/${cdaId}/fundings`, { amount_cents: amount, ...extra }, { key: staff });
}

/** wind up every CDA this flow funded, so the instance aggregate is restored and nothing is left 'funded' */
async function closeFunded(staff: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    const rec = await core().from("cda").select("status, book_value_cents").eq("id", id).maybeSingle();
    if (!rec.data || rec.data.status === "closed" || rec.data.status === "proposed") continue;
    const t = await api("POST", `/cda/${id}/termination`, { approved_by: "flow-cleanup" }, { key: staff });
    const c = await api("POST", `/cda/${id}/close`, { final_accounting_ref: "flow-cleanup" }, { key: staff });
    if (c.status !== 200) console.error(`closing ${id}: termination ${t.status}, close ${c.status} ${body(c)}`);
  }
}

/** 2% of net worth, after proving the rest of the instance leaves room for it under the 4% buffer */
async function headroomFunding(): Promise<{ netWorth: number; others: number; amount: number }> {
  const netWorth = await latestNetWorth();
  const others = await aggregateBook();
  const amount = Math.floor((netWorth * 200) / 10000);
  assert(
    others + amount <= Math.floor((netWorth * 390) / 10000),
    `precondition: other open CDAs hold ${others} of ${netWorth} net worth — no room for a 2% funding`,
  );
  return { netWorth, others, amount };
}

// ===================================================================== CDA-01

flow("cda: Board adoption gates the programme — expired adoption blocks and is recorded → sweep escalates → re-adoption anchored on its date → compliant funding books", async (t) => {
  const staff = await actor("cu_admin", ["bsa_compliance"]);
  const partner = await actor("partner");
  const r = run();
  const snapshot = await snapshotPolicy();
  const cda = `cda_flow_${r}_main`;
  const empty = `cda_flow_${r}_empty`;
  let vendor = "";
  let expired = { id: "", adoptedAt: new Date(), expiresAt: new Date() };
  let funding = 0;
  let othersBefore = 0;

  try {
    await t.step("a partner cannot reach the CDA programme: 404 on every surface, nothing written", async () => {
      const pol = await api("POST", "/cda/policy", {
        policy_version: `flow-${r}-partner`, board_resolution_id: "b",
      }, { key: partner });
      assertEq(pol.status, 404, `partner adopt (${body(pol)})`);
      const c = await api("POST", "/cda", {
        id: `cda_flow_${r}_partner`, structure_type: "spe_trust", account_label: "Charitable Donation Account",
      }, { key: partner });
      assertEq(c.status, 404, `partner create (${body(c)})`);
      const f = await fund(partner, "cda_main", 100);
      assertEq(f.status, 404, `partner fund (${body(f)})`);
      const s = await api("POST", "/cda/policy/sweep", {}, { key: partner });
      assertEq(s.status, 404, `partner sweep (${body(s)})`);
      assertEq(await rowById("cda_policy", `${FLOW_POLICY_PREFIX}${r}partner`), null, "no adoption recorded");
      assertEq(await rowById("cda", `cda_flow_${r}_partner`), null, "no CDA created");
    });

    await t.step("Compliance qualifies a trustee and files a compliant CDA (labelled, segregated, four clauses)", async () => {
      vendor = await qualifiedTrustee(staff, r);
      await compliantCda(staff, cda, vendor);
      const row = await rowById("cda", cda);
      assertEq(row.status, "proposed", "unfunded");
      assertEq(row.book_value_cents, 0, "nothing booked");
      assertEq(row.provenance, "demo", "test-actor evidence is labelled demo");
      assertEq((await events(cda, "cda.evidence_packet.filed")).length, 1, "packet-filed event");
      assertEq((await events(cda, "cda.agreement.validated")).length, 1, "agreement-validated event");
    });

    await t.step("a BACKDATED adoption is already expired: its expiry runs from adoption, not from today", async () => {
      expired = await adopt(staff, `flow-${r}-backdated`, 24);
      const p = await rowById("cda_policy", expired.id);
      assertEq(Date.parse(p.adopted_at), expired.adoptedAt.getTime(), "adoption date as supplied");
      assertEq(Date.parse(p.policy_expiry_at), expired.expiresAt.getTime(), "expiry = adoption + 12 months");
      assert(Date.parse(p.policy_expiry_at) < Date.now(), "so it has already lapsed");
      assertEq(p.superseded_at, null, "it is the active adoption");
      for (const id of snapshot) {
        assert((await rowById("cda_policy", id)).superseded_at, `prior adoption ${id} superseded, not left live`);
      }
      const ev = await rowById("event", `ev_${expired.id}_adopt`);
      assertEq(ev?.code, "cda.board_decision.recorded", "board decision recorded");
    });

    await t.step("with the policy lapsed, a compliant funding is refused AND recorded; nothing is booked", async () => {
      const f = await fund(staff, cda, 100_000);
      assertEq(f.status, 409, `funding (${body(f)})`);
      assertEq(f.body.type, "cda_funding_blocked", "typed refusal");
      assert(String(f.body.detail).includes("policy_expired"), "the refusal names the condition");
      const reqs = await rows("cda_funding_request", "cda_id", cda);
      assertEq(reqs.length, 1, "the blocked request is on the record");
      assertEq(reqs[0].decision, "blocked", "decision");
      assertSame(reqs[0].blocked_reasons, ["policy_expired"], "the ONLY failing condition is the lapse");
      assertEq((await rowById("cda", cda)).book_value_cents, 0, "no money booked");
    });

    await t.step("trades and distributions are blocked by the lapse too", async () => {
      const tr = await api("POST", `/cda/${cda}/trades`, { issuer: "US Treasury", amount_cents: 10_000 }, { key: staff });
      assertEq(tr.status, 409, `trade (${body(tr)})`);
      assertEq(tr.body.type, "cda_actions_blocked", "trade refused as a programme block");
      assertEq((await rows("cda_trade", "cda_id", cda)).length, 0, "no trade row");
      const d = await api("POST", `/cda/${cda}/distributions`, {
        donee_name: `Lapsed Food Bank ${r}`, ...CHARITY, amount_cents: 10_000, proposed_by: `ops_${r}`,
      }, { key: staff });
      assertEq(d.status, 409, `distribution (${body(d)})`);
      const dist = (await rows("cda_distribution", "cda_id", cda))[0];
      assertEq(dist?.decision, "blocked", "distribution recorded as blocked");
      assertEq(dist?.blocked_reason, "policy_expired", "blocked by the lapse");
      assertEq((await events(cda, "cda.distribution.executed")).length, 0, "nothing given");
    });

    await t.step("the gate reports EVERY failed condition at once, not just the first", async () => {
      const c = await api("POST", "/cda", {
        id: empty, structure_type: "spe_trust", account_label: "Investment Sub-Account",
      }, { key: staff });
      assertEq(c.status, 201, `create (${body(c)})`);
      const f = await fund(staff, empty, 100_000);
      assertEq(f.status, 409, `funding (${body(f)})`);
      const reasons: string[] = (await rows("cda_funding_request", "cda_id", empty))[0]?.blocked_reasons ?? [];
      for (const want of ["policy_expired", "evidence_packet_not_filed", "agreement_clauses_unvalidated", "no_vendor_assigned"]) {
        assert(reasons.includes(want), `expected ${want} in ${JSON.stringify(reasons)}`);
      }
    });

    await t.step("the sweep escalates the lapse to the Board without waiting for a transaction", async () => {
      const s = await api("POST", "/cda/policy/sweep", {}, { key: staff });
      assertEq(s.status, 200, `sweep (${body(s)})`);
      assertEq(s.body.data.blocked, true, "programme blocked");
      assertEq(s.body.data.reason, "policy_expired", "reason");
      assertEq((await rowById("event", `ev_${expired.id}_expired`))?.code, "cda.policy.expired", "policy.expired");
      assertEq((await rowById("event", `ev_${expired.id}_blocked`))?.code, "cda.actions.blocked", "actions.blocked");
      const esc = await rowById("event", `ev_${expired.id}_esc`);
      assertEq(esc?.code, "cda.board_escalation.issued", "board escalation issued");
      assertEq(esc?.payload?.actions_blocked, true, "escalation says actions are blocked");
      assertEq(esc?.provenance, "demo", "demo-labelled");
    });

    let live = { id: "", adoptedAt: new Date(), expiresAt: new Date() };
    await t.step("re-adoption eleven months ago: live for one more month, expiry anchored on ADOPTION", async () => {
      live = await adopt(staff, `flow-${r}-live`, 11);
      const p = await rowById("cda_policy", live.id);
      assertEq(Date.parse(p.policy_expiry_at), live.expiresAt.getTime(), "expiry = adoption + 12 months");
      assert(
        Date.parse(p.policy_expiry_at) < monthsFrom(new Date(), 2).getTime(),
        "NOT twelve months from today — an expiry that re-anchors to the write can never lapse",
      );
      assert((await rowById("cda_policy", expired.id)).superseded_at, "the lapsed adoption is superseded");
    });

    await t.step("a live adoption produces NO escalation — the sweep is not an echo", async () => {
      const s = await api("POST", "/cda/policy/sweep", {}, { key: staff });
      assertEq(s.status, 200, `sweep (${body(s)})`);
      assertEq(s.body.data.blocked, false, "programme live");
      assertEq(await rowById("event", `ev_${live.id}_esc`), null, "no escalation for the live adoption");
      assertEq(await rowById("event", `ev_${live.id}_expired`), null, "no expiry event");
    });

    await t.step("a fully compliant funding is permitted and books the money", async () => {
      const h = await headroomFunding();
      othersBefore = h.others;
      funding = h.amount;
      const f = await fund(staff, cda, funding);
      assertEq(f.status, 201, `funding (${body(f)})`);
      assertEq(f.body.data.decision, "permitted", "decision");
      assertEq(f.body.data.book_value_cents, funding, "book value on the response");
      const row = await rowById("cda", cda);
      assertEq(row.book_value_cents, funding, "book value booked");
      assertEq(row.status, "funded", "status");
      const req = await rowById("cda_funding_request", String(f.body.data.id));
      assertEq(req.decision, "permitted", "funding request recorded as permitted");
      assertSame(req.blocked_reasons, [], "no failing condition");
      assertEq(Number(req.projected_aggregate_cents), othersBefore + funding, "the cap was tested on the PROJECTED aggregate");
      assertEq(Number(req.net_worth_cents), h.netWorth, "against the latest capital position");
      const ev = await rowById("event", `ev_${f.body.data.id}_funded`);
      assertEq(ev?.code, "cda.funding.executed", "funding executed event");
      assertEq(ev?.payload?.amount_cents, funding, "event carries the amount");
    });
  } finally {
    await closeFunded(staff, [cda]);
    await restorePolicy(snapshot);
  }
});

// ===================================================================== CDA-06

flow("cda: the 5% cap — the projected test refuses the first breach, the 4% buffer refuses first, refusals are recorded; a breach is cured only when the aggregate falls", async (t) => {
  const staff = await actor("cu_admin", ["bsa_compliance"]);
  const r = run();
  const snapshot = await snapshotPolicy();
  const cda = `cda_flow_${r}_cap`;
  let netWorth = 0;
  let funded = 0;
  let testId = "";

  try {
    await t.step("a live programme with a funded CDA at 2% of net worth", async () => {
      await adopt(staff, `flow-${r}-live`, 1);
      await compliantCda(staff, cda, await qualifiedTrustee(staff, r));
      const h = await headroomFunding();
      netWorth = h.netWorth;
      funded = h.amount;
      const f = await fund(staff, cda, funded);
      assertEq(f.status, 201, `funding (${body(f)})`);
    });

    await t.step("over the 4% buffer but under the 5% cap: refused by the BUFFER, recorded, nothing booked", async () => {
      const agg = await aggregateBook();
      const amount = Math.floor((netWorth * 450) / 10000) - agg; // projected 4.5%
      const f = await fund(staff, cda, amount);
      assertEq(f.status, 409, `funding (${body(f)})`);
      const req = (await rows("cda_funding_request", "cda_id", cda)).find((x) => Number(x.amount_cents) === amount);
      assert(req, "the refused request is recorded");
      assertEq(req.decision, "blocked", "decision");
      assert(req.blocked_reasons.includes("internal_buffer_exceeded"), `buffer refuses (${req.blocked_reasons})`);
      assert(!req.blocked_reasons.includes("cap_exceeded"), "the statutory cap was not what refused it");
      assertEq((await rowById("cda", cda)).book_value_cents, funded, "book value unchanged");
    });

    await t.step("a funding whose PROJECTED aggregate breaks 5% is refused, though today's aggregate is far under", async () => {
      const agg = await aggregateBook();
      assert(agg * 10000 / netWorth <= 400, "the CURRENT aggregate is under the buffer — testing it would permit this");
      const amount = Math.floor((netWorth * 550) / 10000) - agg; // projected 5.5%
      const f = await fund(staff, cda, amount);
      assertEq(f.status, 409, `funding (${body(f)})`);
      assert(String(f.body.detail).includes("cap_exceeded"), "refusal names the cap");
      const req = (await rows("cda_funding_request", "cda_id", cda)).find((x) => Number(x.amount_cents) === amount);
      assert(req, "a blocked funding is RECORDED — a gate that logs only what it permitted is unauditable");
      assertEq(req.decision, "blocked", "decision");
      assert(req.blocked_reasons.includes("cap_exceeded"), `cap_exceeded (${req.blocked_reasons})`);
      assertEq(Number(req.projected_aggregate_cents), agg + amount, "the amount under test is inside the number tested");
      assertEq((await rowById("cda", cda)).book_value_cents, funded, "and no money moved");
    });

    await t.step("the cap test records utilisation against the latest net worth, and flags a breached buffer", async () => {
      // a run-unique as_of_date in the past: the test is ours alone and never
      // becomes the "latest" cap test the quarter-close packet reads
      const day = new Date(Date.UTC(1950, 0, 1) + Math.floor(Math.random() * 18000) * 86_400_000);
      const asOf = day.toISOString().slice(0, 10);
      const agg = await aggregateBook();
      const c = await api("POST", "/cda/cap-tests", { as_of_date: asOf, buffer_bp: 100, certified_by: `cfo_${r}` }, { key: staff });
      assertEq(c.status, 201, `cap test (${body(c)})`);
      testId = String(c.body.data.id);
      const row = await rowById("cda_cap_test", testId);
      assertEq(Number(row.aggregate_book_value_cents), agg, "aggregate over every open CDA");
      assertEq(Number(row.net_worth_cents), netWorth, "net worth read from the capital position, not supplied");
      assertEq(row.utilization_bp, Math.floor((agg * 10000) / netWorth), "utilisation");
      assertEq(row.cap_breached, false, "under the statutory cap");
      assertEq(row.buffer_breached, true, "over the 1% buffer this test was run with");
      assertEq(row.cure_due_at, null, "no cure clock without a breach");
      assertEq((await rowById("event", `ev_${testId}_test`))?.code, "cda.cap_test.completed", "test event");
      assertEq((await rowById("event", `ev_${testId}_cert`))?.payload?.certified_by, `cfo_${r}`, "certification event");
      assertEq((await rowById("event", `ev_${testId}_buf`))?.code, "cda.cap_buffer.breached", "buffer breach raised");
      const cure = await api("POST", `/cda/cap-tests/${testId}/cure`, { cure_plan: "nothing to cure" }, { key: staff });
      assertEq(cure.status, 409, `cure an unbreached test (${body(cure)})`);
      assertEq(cure.body.type, "cda_cap_not_breached", "nothing to cure");
    });

    let stagedNw = 0;
    await t.step("net worth falls (staged on THIS test's row): a cure PLAN alone does not clear the breach", async () => {
      // The instance's capital position is shared and is never written by a
      // flow, so the fall in net worth that turns a compliant aggregate into a
      // breach is applied to this flow's own cap-test row: aggregate now 6%.
      const agg = await aggregateBook();
      stagedNw = Math.floor((agg * 10000) / 600);
      const cap = Math.floor((stagedNw * 500) / 10000);
      const up = await core().from("cda_cap_test").update({
        net_worth_cents: stagedNw, utilization_bp: Math.floor((agg * 10000) / stagedNw),
        cap_breached: true, excess_cents: agg - cap,
        cure_due_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      }).eq("id", testId);
      assert(!up.error, `staging the breach: ${up.error?.message}`);

      const c = await api("POST", `/cda/cap-tests/${testId}/cure`, { cure_plan: "we will reduce it" }, { key: staff });
      assertEq(c.status, 409, `plan-only cure (${body(c)})`);
      assertEq(c.body.type, "cda_cap_still_breached", "typed refusal");
      assertEq((await rowById("cda_cap_test", testId)).cured_at, null, "the breach stays open");
      assertEq((await rowById("event", `ev_${testId}_curefail`))?.code, "cda.cap_cure.insufficient", "insufficient cure recorded");
      assertEq(await rowById("event", `ev_${testId}_cured`), null, "no cured event");
    });

    await t.step("distributing genuinely reduces book value, and only then does the cure land", async () => {
      const agg = await aggregateBook();
      const give = agg - Math.floor((stagedNw * 450) / 10000); // back to ~4.5%
      assert(give > 0 && give <= funded, `the distribution fits this CDA's book (${give} of ${funded})`);
      const d = await api("POST", `/cda/${cda}/distributions`, {
        donee_name: `Riverside Food Bank ${r}`, ...CHARITY, amount_cents: give,
        proposed_by: `ops_${r}_a`, approved_by: `ops_${r}_b`,
      }, { key: staff });
      assertEq(d.status, 201, `distribution (${body(d)})`);
      assertEq((await rowById("cda", cda)).book_value_cents, funded - give, "book value fell by the gift");

      const c = await api("POST", `/cda/cap-tests/${testId}/cure`, { cure_plan: `distributed ${give}` }, { key: staff });
      assertEq(c.status, 200, `cure (${body(c)})`);
      assertEq(c.body.data.cured, true, "cured");
      const row = await rowById("cda_cap_test", testId);
      assert(row.cured_at, "cured_at recorded");
      assertEq(row.cure_plan, `distributed ${give}`, "cure plan kept");
      const ev = await rowById("event", `ev_${testId}_cured`);
      assertEq(ev?.code, "cda.cap_breach_cured", "cured event");
      assertEq(ev?.payload?.cured_within_deadline, true, "inside the 30-day clock");
    });
  } finally {
    await closeFunded(staff, [cda]);
    await restorePolicy(snapshot);
  }
});

// ===================================================================== CDA-04

flow("cda: trustee qualification is derived from evidence — a claimed qualification is ignored; a lapse found on review escalates on a 2-day clock and blocks funding; a no-change review is silent", async (t) => {
  const staff = await actor("cu_admin", ["bsa_compliance"]);
  const r = run();
  let vendor = "";
  const cda = `cda_flow_${r}_vendor`;

  await t.step("qualification is derived: only a recognised regulator + active registration + evidence qualifies", async () => {
    const cases: [string, Record<string, unknown>, boolean, string | null][] = [
      ["occ-active-cert", { regulator: "occ", registration_status: "active", registration_evidence_ref: "c" }, true, null],
      ["occ-lapsed-cert", { regulator: "occ", registration_status: "lapsed", registration_evidence_ref: "c" }, false, "registration_lapsed"],
      ["sec-active-noevidence", { regulator: "sec", registration_status: "active" }, false, "no_registration_evidence"],
      ["noregulator-active-cert", { registration_status: "active", registration_evidence_ref: "c" }, false, "regulator_not_recognised"],
      ["tradebody-active-cert", { regulator: "some_trade_body", registration_status: "active", registration_evidence_ref: "c" }, false, "regulator_not_recognised"],
    ];
    for (const [tag, fields, qualified, reason] of cases) {
      const v = await api("POST", "/cda/vendors", { name: `Vendor ${tag} ${r}`, role: "discretionary_manager", ...fields }, { key: staff });
      assertEq(v.status, 201, `${tag} (${body(v)})`);
      const row = await rowById("cda_vendor", String(v.body.data.id));
      assertEq(row.qualified, qualified, `${tag}: qualified`);
      assertEq(row.disqualified_reason, reason, `${tag}: reason`);
    }
  });

  await t.step("a caller cannot qualify a vendor by claiming it", async () => {
    const v = await api("POST", "/cda/vendors", {
      name: `Sketchy LLC ${r}`, role: "trustee", qualified: true, registration_status: "active",
    }, { key: staff });
    assertEq(v.status, 201, `onboard (${body(v)})`);
    const id = String(v.body.data.id);
    assertEq((await rowById("cda_vendor", id)).qualified, false, "the supplied qualified:true is ignored");
    const flagged = await events(id, "cda.vendor_issue.flagged");
    assertEq(flagged.length, 1, "the failure to qualify is its own event");
    assertEq(flagged[0].payload?.vendor_issue_details?.reason, "regulator_not_recognised", "flag says why");
    assertEq((await events(id, "cda.vendor_qualified")).length, 0, "no qualified event");
  });

  await t.step("a review that changes nothing completes and does NOT escalate", async () => {
    vendor = await qualifiedTrustee(staff, r);
    await compliantCda(staff, cda, vendor);
    const rv = await api("POST", `/cda/vendors/${vendor}/review`, {
      registration_status: "active", registration_evidence_ref: `occ-cert-${r}`,
    }, { key: staff });
    assertEq(rv.status, 200, `review (${body(rv)})`);
    assertEq(rv.body.data.qualified, true, "still qualified");
    assertEq((await events(vendor, "cda.vendor_review.completed")).length, 1, "review recorded");
    assertEq(await rowById("event", `ev_${vendor}_venesc`), null, "no escalation");
  });

  await t.step("a lapse found on review escalates to the Board with its 2-day clock", async () => {
    const before = Date.now();
    const rv = await api("POST", `/cda/vendors/${vendor}/review`, { registration_status: "lapsed" }, { key: staff });
    assertEq(rv.status, 200, `review (${body(rv)})`);
    assertEq(rv.body.data.qualified, false, "disqualified");
    const row = await rowById("cda_vendor", vendor);
    assertEq(row.qualified, false, "row disqualified");
    assertEq(row.disqualified_reason, "registration_lapsed", "reason");
    assertEq((await rowById("event", `ev_${vendor}_lapse`))?.code, "cda.vendor_registration_lapsed", "lapse event");
    const esc = await rowById("event", `ev_${vendor}_venesc`);
    assertEq(esc?.code, "cda.board_escalation.issued", "board escalation");
    assertEq(esc?.payload?.reason, "vendor_registration_lapsed", "escalation reason");
    const due = Date.parse(esc?.payload?.escalation_due_at);
    assert(due >= before + 2 * 86_400_000 - 60_000 && due <= Date.now() + 2 * 86_400_000 + 60_000, `2-day clock (${esc?.payload?.escalation_due_at})`);
  });

  await t.step("an unqualified trustee blocks funding — §721.3(b)(2)(ii) is in the conjunction", async () => {
    const f = await fund(staff, cda, 100_000);
    assertEq(f.status, 409, `funding (${body(f)})`);
    const req = (await rows("cda_funding_request", "cda_id", cda))[0];
    assert(req.blocked_reasons.includes("vendor_not_qualified"), `vendor_not_qualified in ${req.blocked_reasons}`);
    assertEq((await rowById("cda", cda)).book_value_cents, 0, "nothing booked");
  });
});

// ============================================================ CDA-03 / CDA-05

flow("cda: structure and agreement — an undesignated label or missing statement leaves the packet unfiled; a missing clause names itself and blocks funding; an amendment needs a Board resolution", async (t) => {
  const staff = await actor("cu_admin", ["bsa_compliance"]);
  const r = run();
  const vendor = await qualifiedTrustee(staff, r);
  const bad = `cda_flow_${r}_badlabel`;
  const nostmt = `cda_flow_${r}_nostmt`;
  const cda = `cda_flow_${r}_agr`;

  await t.step("a label that does not DESIGNATE the account does not file the packet", async () => {
    const c = await api("POST", "/cda", {
      id: bad, vendor_id: vendor, structure_type: "spe_trust",
      account_label: "Investment Sub-Account", custodian_statement_ref: "c",
    }, { key: staff });
    assertEq(c.status, 201, `create (${body(c)})`);
    assertEq((await rowById("cda", bad)).evidence_packet_filed_at, null, "packet not filed");
    const gap = await events(bad, "cda.evidence_packet.incomplete");
    assertEq(gap.length, 1, "incomplete-packet event");
    assertEq(gap[0].payload?.account_label_designates, false, "it says the label is the gap");
    assertEq((await events(bad, "cda.evidence_packet.filed")).length, 0, "no filed event");
    const gate = await events(bad, "cda.funding_gate_evaluated");
    assert(gate.some((g) => (g.payload?.blocked_reasons ?? []).includes("evidence_packet_not_filed")), "filing re-evaluates the gate");
  });

  await t.step("a designated label with no custodial statement is still incomplete", async () => {
    const c = await api("POST", "/cda", {
      id: nostmt, vendor_id: vendor, structure_type: "segregated_custodial",
      account_label: "Charitable Donation Account",
    }, { key: staff });
    assertEq(c.status, 201, `create (${body(c)})`);
    assertEq((await rowById("cda", nostmt)).evidence_packet_filed_at, null, "packet not filed");
    const gap = await events(nostmt, "cda.evidence_packet.incomplete");
    assertEq(gap[0]?.payload?.account_label_designates, true, "label is fine");
    assertEq(gap[0]?.payload?.custodian_statement_present, false, "the statement is the gap");
  });

  await t.step("a missing clause names ITSELF — the refusal is per-clause", async () => {
    const c = await api("POST", "/cda", {
      id: cda, vendor_id: vendor, structure_type: "segregated_custodial",
      account_label: "Charitable Donation Account", custodian_statement_ref: `cust-${r}`,
    }, { key: staff });
    assertEq(c.status, 201, `create (${body(c)})`);
    const a = await api("POST", `/cda/${cda}/agreement`, {
      clauses: { ...ALL_CLAUSES, agreement_gaap_clause: false },
    }, { key: staff });
    assertEq(a.status, 200, `agreement (${body(a)})`);
    assertEq(a.body.data.agreement_validated, false, "not validated");
    assertSame(a.body.data.missing_clauses, ["C_gaap_accounting"], "names the missing clause only");
    const row = await rowById("cda", cda);
    assertEq(row.agreement_validated_at, null, "row unvalidated");
    assertEq(row.agreement_gaap_clause, false, "clause C recorded absent");
    assertEq(row.agreement_named_charities_clause, true, "clause A recorded present");
    assertSame((await events(cda, "cda.agreement.clause_missing"))[0]?.payload?.missing, ["C_gaap_accounting"], "clause-missing event");
  });

  await t.step("an unvalidated agreement blocks funding", async () => {
    const f = await fund(staff, cda, 100_000);
    assertEq(f.status, 409, `funding (${body(f)})`);
    const req = (await rows("cda_funding_request", "cda_id", cda))[0];
    assert(req.blocked_reasons.includes("agreement_clauses_unvalidated"), `agreement_clauses_unvalidated in ${req.blocked_reasons}`);
    assert(!req.blocked_reasons.includes("evidence_packet_not_filed"), "the packet is not the problem");
  });

  await t.step("all four clauses validate the agreement", async () => {
    const a = await api("POST", `/cda/${cda}/agreement`, { clauses: ALL_CLAUSES, strategy_limits: { max_equity_bp: 6000 } }, { key: staff });
    assertEq(a.status, 200, `agreement (${body(a)})`);
    assertEq(a.body.data.agreement_validated, true, "validated");
    const row = await rowById("cda", cda);
    assert(row.agreement_validated_at, "validated_at recorded");
    assertSame(row.strategy_limits, { max_equity_bp: 6000 }, "clause B's limits stored for the pre-trade check");
  });

  await t.step("an amendment with no Board resolution is refused — and does not take effect", async () => {
    const before = await rowById("cda", cda);
    const a = await api("POST", `/cda/${cda}/agreement`, {
      clauses: { ...ALL_CLAUSES, agreement_gaap_clause: false },
      strategy_limits: { max_equity_bp: 9000 },
      amendment: { redline_ref: `r-${r}` },
    }, { key: staff });
    assertEq(a.status, 400, `unapproved amendment (${body(a)})`);
    assert(JSON.stringify(a.body).includes("amendment.board_resolution_id"), "names the missing resolution");
    const after = await rowById("cda", cda);
    // DEFECT: postCdaAgreement writes the amended clauses/limits (and un-validates the agreement) BEFORE refusing the missing Board resolution
    assertEq(after.agreement_validated_at, before.agreement_validated_at, "the refused amendment did not un-validate the agreement");
    assertEq(after.agreement_gaap_clause, true, "the refused amendment did not drop clause C");
    assertSame(after.strategy_limits, { max_equity_bp: 6000 }, "the refused amendment did not rewrite the strategy limits");
  });

  await t.step("an amendment WITH a Board resolution records the Board decision", async () => {
    const a = await api("POST", `/cda/${cda}/agreement`, {
      clauses: ALL_CLAUSES, amendment: { redline_ref: `r-${r}`, board_resolution_id: `board-amend-${r}` },
    }, { key: staff });
    assertEq(a.status, 200, `approved amendment (${body(a)})`);
    assertEq(a.body.data.agreement_validated, true, "still validated");
    const ev = await rowById("event", `ev_${cda}_amend`);
    assertEq(ev?.code, "cda.board_decision.recorded", "board decision recorded against the amendment");
    assertEq(ev?.payload?.board_resolution_id, `board-amend-${r}`, "names the resolution");
    assertEq(ev?.payload?.agreement_redline, `r-${r}`, "and the redline");
  });
});

// ===================================================================== CDA-07

flow("cda: pre-trade overlays — no overlay means unassessed and blocked; an unapproved limit is refused; concentration is measured after the trade", async (t) => {
  const staff = await actor("cu_admin", ["bsa_compliance"]);
  const r = run();
  const snapshot = await snapshotPolicy();
  const cda = `cda_flow_${r}_trade`;
  let book = 0;

  try {
    await t.step("a live programme with a funded CDA", async () => {
      await adopt(staff, `flow-${r}-live`, 1);
      await compliantCda(staff, cda, await qualifiedTrustee(staff, r));
      book = (await headroomFunding()).amount;
      const f = await fund(staff, cda, book);
      assertEq(f.status, 201, `funding (${body(f)})`);
    });

    await t.step("with NO overlay configured a trade is unassessed and blocked, not permitted", async () => {
      const tr = await api("POST", `/cda/${cda}/trades`, { issuer: "Anything", amount_cents: 100_000 }, { key: staff });
      assertEq(tr.status, 409, `trade (${body(tr)})`);
      assertEq(tr.body.type, "cda_pretrade_blocked", "typed refusal");
      const row = (await rows("cda_trade", "cda_id", cda))[0];
      assertEq(row?.pretrade_verdict, "unassessed", "verdict");
      assertEq(row?.executed, false, "not executed");
      const pre = await events(cda, "cda.pretrade_check.completed");
      assertEq(pre.length, 1, "the check still COMPLETED — it ran and reported cannot-clear");
      assertEq(pre[0].payload?.verdict, "unassessed", "event verdict");
    });

    await t.step("an overlay with no Board approval is refused — the limits are Board-set", async () => {
      const o = await api("PUT", `/cda/${cda}/overlays/single_issuer`, { limit_bp: 9999 }, { key: staff });
      assertEq(o.status, 400, `unapproved overlay (${body(o)})`);
      assertEq(await rowById("cda_overlay", `cdaovl_${cda}_single_issuer`), null, "no overlay stored");
    });

    await t.step("a 25% single-issuer overlay: a trade inside it executes, the first breach is refused", async () => {
      const o = await api("PUT", `/cda/${cda}/overlays/single_issuer`, { limit_bp: 2500, approved_by: `board-${r}` }, { key: staff });
      assertEq(o.status, 200, `overlay (${body(o)})`);
      assertEq((await rowById("cda_overlay", `cdaovl_${cda}_single_issuer`))?.approved_by, `board-${r}`, "approval recorded");

      const okAmt = Math.floor(book / 5); // 1/6 of the post-trade position, under 25%
      const ok = await api("POST", `/cda/${cda}/trades`, { issuer: "US Treasury", amount_cents: okAmt }, { key: staff });
      assertEq(ok.status, 201, `trade inside limits (${body(ok)})`);
      assertEq(ok.body.data.verdict, "within_limits", "verdict");
      const okRow = await rowById("cda_trade", String(ok.body.data.id));
      assertEq(okRow.executed, true, "executed");

      const badAmt = book * 2; // 2/3 of the post-trade position
      const bad = await api("POST", `/cda/${cda}/trades`, { issuer: "Single Corp", amount_cents: badAmt }, { key: staff });
      assertEq(bad.status, 409, `breaching trade (${body(bad)})`);
      assert(String(bad.body.detail).includes("single_issuer"), "refusal names the overlay");
      const badRow = (await rows("cda_trade", "cda_id", cda)).find((x) => x.issuer === "Single Corp");
      assertEq(badRow?.pretrade_verdict, "breach", "breach verdict");
      assertEq(badRow?.executed, false, "not executed");
      assertSame(badRow?.breached_overlays, ["single_issuer"], "names the breached overlay");
    });
  } finally {
    await closeFunded(staff, [cda]);
    await restorePolicy(snapshot);
  }
});

// ============================================================ CDA-08 / CDA-11

flow("cda: giving — the donee must be a Qualified Charity; $5,000+ needs a second approver; sub-threshold gifts are logged as single approval; window coverage drives the 51% alert", async (t) => {
  const staff = await actor("cu_admin", ["bsa_compliance"]);
  const r = run();
  const snapshot = await snapshotPolicy();
  const cda = `cda_flow_${r}_give`;
  const give = (fields: Record<string, unknown>) =>
    api("POST", `/cda/${cda}/distributions`, fields, { key: staff });
  const distByDonee = async (name: string) =>
    (await rows("cda_distribution", "cda_id", cda)).find((d) => d.donee_name === name);

  try {
    await t.step("a live programme with a funded CDA", async () => {
      await adopt(staff, `flow-${r}-live`, 1);
      await compliantCda(staff, cda, await qualifiedTrustee(staff, r));
      const f = await fund(staff, cda, (await headroomFunding()).amount);
      assertEq(f.status, 201, `funding (${body(f)})`);
    });

    await t.step("a donee with no EIN or IRS status is not a Qualified Charity: blocked, nothing given", async () => {
      const name = `Unknown Foundation ${r}`;
      const d = await give({ donee_name: name, amount_cents: 100_000, proposed_by: `ops_${r}_a` });
      assertEq(d.status, 409, `distribution (${body(d)})`);
      const row = await distByDonee(name);
      assertEq(row?.decision, "blocked", "recorded as blocked");
      assertEq(row?.donee_validated, false, "donee unvalidated");
      assertEq(row?.blocked_reason, "donee_ein_invalid", "reason");
      assertEq((await events(cda, "cda.distribution.executed")).length, 0, "nothing executed");
    });

    await t.step("an EIN with no IRS determination is still unvalidated", async () => {
      const name = `Maybe Charity ${r}`;
      const d = await give({ donee_name: name, donee_ein: "12-3456789", donee_irs_status: "none", amount_cents: 100_000, proposed_by: `ops_${r}_a` });
      assertEq(d.status, 409, `distribution (${body(d)})`);
      const row = await distByDonee(name);
      assertEq(row?.donee_validated, false, "unvalidated");
      assertEq(row?.decision, "blocked", "blocked");
      assertEq(row?.blocked_reason, "donee_irs_status_none", "reason names the missing determination");
    });

    await t.step("a $5,000 distribution self-approved by its proposer is refused; with NO approver too", async () => {
      const self = `Self Approved Fund ${r}`;
      const d = await give({ donee_name: self, ...CHARITY, amount_cents: 500_000, proposed_by: `ops_${r}_a`, approved_by: `ops_${r}_a` });
      assertEq(d.status, 409, `self-approved (${body(d)})`);
      assertEq((await distByDonee(self))?.blocked_reason, "dual_approval_self_approved", "reason");
      const none = `Unapproved Fund ${r}`;
      const n = await give({ donee_name: none, ...CHARITY, amount_cents: 500_000, proposed_by: `ops_${r}_a` });
      assertEq(n.status, 409, `no approver (${body(n)})`);
      assertEq((await distByDonee(none))?.blocked_reason, "dual_approval_missing", "reason");
      assertEq((await events(cda, "cda.dual_approval.recorded")).length, 0, "no dual approval recorded");
    });

    await t.step("a sub-threshold distribution needs one approver and is still logged as single approval", async () => {
      const name = `Small Gift Pantry ${r}`;
      const book = Number((await rowById("cda", cda)).book_value_cents);
      const d = await give({ donee_name: name, ...CHARITY, amount_cents: 499_999, proposed_by: `ops_${r}_a` });
      assertEq(d.status, 201, `distribution (${body(d)})`);
      const id = String(d.body.data.id);
      assertEq((await rowById("cda_distribution", id)).decision, "executed", "executed");
      assertEq((await rowById("event", `ev_${id}_single`))?.code, "cda.single_approval.recorded", "single approval logged");
      assertEq(await rowById("event", `ev_${id}_dual`), null, "no dual approval claimed");
      assertEq((await rowById("event", `ev_${id}_exec`))?.code, "cda.distribution.executed", "executed event");
      assertEq((await rowById("cda", cda)).book_value_cents, book - 499_999, "book value reduced");
    });

    await t.step("a $5,000+ distribution with a second approver executes and records the dual approval", async () => {
      const name = `Riverside Food Bank ${r}`;
      const d = await give({ donee_name: name, ...CHARITY, amount_cents: 500_000, proposed_by: `ops_${r}_a`, approved_by: `ops_${r}_b` });
      assertEq(d.status, 201, `distribution (${body(d)})`);
      const dual = await rowById("event", `ev_${d.body.data.id}_dual`);
      assertEq(dual?.code, "cda.dual_approval.recorded", "dual approval recorded");
      assertEq(dual?.payload?.approver_id, `ops_${r}_b`, "names the second approver");
    });

    await t.step("a window with no Total Return has NO coverage — 0/0 is not 100% — and raises nothing yet", async () => {
      const w = await api("POST", `/cda/${cda}/windows`, {
        opened_at: "2026-01-01T00:00:00.000Z", closes_at: "2031-01-01T00:00:00.000Z", total_return_cents: 0,
      }, { key: staff });
      assertEq(w.status, 201, `window (${body(w)})`);
      const row = await rowById("cda_distribution_window", String(w.body.data.id));
      assertEq(row.coverage_bp, 0, "coverage 0, not 10000");
      assertEq((await events(String(w.body.data.id), "cda.distribution_window.alert")).length, 0, "a window opening at 0% is not a shortfall");
    });

    await t.step("a window short of 51% raises its shortfall alert with the amount", async () => {
      const w = await api("POST", `/cda/${cda}/windows`, {
        opened_at: "2026-02-01T00:00:00.000Z", closes_at: "2031-02-01T00:00:00.000Z", total_return_cents: 20_000_000,
      }, { key: staff });
      assertEq(w.status, 201, `window (${body(w)})`);
      const winId = String(w.body.data.id);
      const d = await give({
        donee_name: `Window Short Shelter ${r}`, ...CHARITY, amount_cents: 6_000_000,
        proposed_by: `ops_${r}_a`, approved_by: `ops_${r}_b`, window_id: winId,
      });
      assertEq(d.status, 201, `distribution (${body(d)})`);
      const exec = await rowById("event", `ev_${d.body.data.id}_exec`);
      assertEq(exec?.payload?.total_return_cumulative, 20_000_000, "the gift carries the window's Total Return");
      const row = await rowById("cda_distribution_window", winId);
      assertEq(Number(row.distributed_cents), 6_000_000, "distributed within the window");
      assertEq(row.coverage_bp, 3000, "30% coverage");
      const alert = await events(winId, "cda.distribution_window.alert");
      assertEq(alert.length, 1, "30% coverage alerts");
      assertEq(alert[0].payload?.coverage_bp, 3000, "alert coverage");
      // 51% of $200k is $102k; $60k distributed leaves a $42k shortfall
      assertEq(alert[0].payload?.distribution_shortfall, 4_200_000, "alert carries the shortfall");
    });

    await t.step("a window ABOVE 51% raises no alert", async () => {
      const w = await api("POST", `/cda/${cda}/windows`, {
        opened_at: "2026-03-01T00:00:00.000Z", closes_at: "2031-03-01T00:00:00.000Z", total_return_cents: 10_000_000,
      }, { key: staff });
      assertEq(w.status, 201, `window (${body(w)})`);
      const winId = String(w.body.data.id);
      const d = await give({
        donee_name: `Window Full Shelter ${r}`, ...CHARITY, amount_cents: 6_000_000,
        proposed_by: `ops_${r}_a`, approved_by: `ops_${r}_b`, window_id: winId,
      });
      assertEq(d.status, 201, `distribution (${body(d)})`);
      assertEq((await rowById("cda_distribution_window", winId)).coverage_bp, 6000, "60% coverage");
      assertEq((await events(winId, "cda.distribution_window.alert")).length, 0, "no alert above 51%");
    });
  } finally {
    await closeFunded(staff, [cda]);
    await restorePolicy(snapshot);
  }
});

// ===================================================================== CDA-13

flow("cda: affiliate fees — a fee to the credit union or an affiliate is blocked and escalated as a conflict; a third-party fee is permitted silently", async (t) => {
  const staff = await actor("cu_admin", ["bsa_compliance"]);
  const r = run();
  const cda = `cda_flow_${r}_fees`;
  const feeRow = async (payee: string) =>
    (await rows("cda_fee_payment", "cda_id", cda)).find((f) => f.payee === payee);

  await t.step("a CDA under management", async () => {
    await compliantCda(staff, cda, await qualifiedTrustee(staff, r));
  });

  await t.step("a fee to the credit union is blocked and escalated on a 5-business-day clock", async () => {
    const f = await api("POST", `/cda/${cda}/fees`, { payee: "Pynthia Credit Union", amount_cents: 40_000 }, { key: staff });
    assertEq(f.status, 409, `fee (${body(f)})`);
    assertEq(f.body.type, "cda_affiliate_fee_blocked", "typed refusal");
    const row = await feeRow("Pynthia Credit Union");
    assertEq(row?.decision, "blocked", "blocked on the record");
    assertEq(row?.payee_is_affiliate, true, "affiliate derived from the register");
    const screen = await events(cda, "cda.fee_screen.completed");
    assert(screen.some((e) => e.payload?.decision === "blocked"), "the screen completed with a block");
    const esc = await events(cda, "cda.conflict.escalated");
    assertEq(esc.length, 1, "conflict escalated");
    assert(esc[0].payload?.escalation_due_at, "escalation clock carried");
    assertEq((await events(cda, "cda.fee_conflict.flagged")).length, 1, "conflict flagged");
  });

  await t.step("the affiliate test is case- and whitespace-insensitive", async () => {
    const f = await api("POST", `/cda/${cda}/fees`, { payee: "  PYNTHIA CUSO ", amount_cents: 100 }, { key: staff });
    assertEq(f.status, 409, `fee (${body(f)})`);
    const row = await feeRow("  PYNTHIA CUSO ");
    assertEq(row?.payee_is_affiliate, true, "still an affiliate");
    assertEq(row?.decision, "blocked", "blocked");
  });

  await t.step("a third-party fee is permitted and raises NO conflict", async () => {
    const before = (await events(cda, "cda.conflict.escalated")).length;
    const f = await api("POST", `/cda/${cda}/fees`, { payee: "Northgate Trust", amount_cents: 12_500 }, { key: staff });
    assertEq(f.status, 201, `fee (${body(f)})`);
    assertEq(f.body.data.decision, "permitted", "decision");
    const row = await rowById("cda_fee_payment", String(f.body.data.id));
    assertEq(row.payee_is_affiliate, false, "not an affiliate");
    assertEq((await rowById("event", `ev_${f.body.data.id}_screen`))?.payload?.decision, "permitted", "screen completed");
    assertEq((await events(cda, "cda.conflict.escalated")).length, before, "no new conflict");
  });
});

// ===================================================================== CDA-12

flow("cda: termination — an in-kind asset with no documented determination is liquidated; a non-Part-703 class is blocked even with one; close issues the report and escalates a short closing distribution", async (t) => {
  const staff = await actor("cu_admin", ["bsa_compliance"]);
  const r = run();
  const cda = `cda_flow_${r}_term`;
  const term = `cdaterm_${cda}`;
  const asset = async (cls: string) =>
    (await rows("cda_inkind_asset", "termination_id", term)).find((a) => a.asset_class === cls);

  await t.step("a CDA under management; in-kind receipt before termination is refused", async () => {
    await compliantCda(staff, cda, await qualifiedTrustee(staff, r));
    const ik = await api("POST", `/cda/${cda}/inkind-transfers`, { asset_class: "us_treasury", amount_cents: 1_000_000, determination_ref: "d" }, { key: staff });
    assertEq(ik.status, 404, `in-kind before termination (${body(ik)})`);
  });

  await t.step("the Board approves termination: the CDA is terminating", async () => {
    const tm = await api("POST", `/cda/${cda}/termination`, { approved_by: `board-${r}` }, { key: staff });
    assertEq(tm.status, 201, `termination (${body(tm)})`);
    assertEq((await rowById("cda", cda)).status, "terminating", "status");
    assertEq((await rowById("cda_termination", term))?.approved_by, `board-${r}`, "approval recorded");
    assertEq((await rowById("event", `ev_${term}_appr`))?.code, "cda.termination.approved", "termination event");
  });

  await t.step("an in-kind asset with no documented determination is liquidated, not received", async () => {
    const ik = await api("POST", `/cda/${cda}/inkind-transfers`, { asset_class: "us_treasury", amount_cents: 1_000_000 }, { key: staff });
    assertEq(ik.status, 409, `in-kind (${body(ik)})`);
    assertEq(ik.body.type, "cda_inkind_not_permissible", "typed refusal");
    const row = await asset("us_treasury");
    assertEq(row?.decision, "blocked_liquidate", "liquidate to cash");
    assertEq(row?.permissible, false, "a permissible CLASS with no determination is not permissible");
  });

  await t.step("a non-Part-703 asset class is blocked even with a determination; the proposal is still recorded", async () => {
    const ik = await api("POST", `/cda/${cda}/inkind-transfers`, { asset_class: "private_equity_fund", amount_cents: 500_000, determination_ref: `d-${r}` }, { key: staff });
    assertEq(ik.status, 409, `in-kind (${body(ik)})`);
    const row = await asset("private_equity_fund");
    assertEq(row?.decision, "blocked_liquidate", "blocked");
    assertEq(row?.determination_ref, `d-${r}`, "the determination is on the record");
    const prop = await events(cda, "cda.inkind_transfer.proposed");
    assert(prop.some((e) => e.payload?.asset_details?.asset_class === "private_equity_fund" && e.payload?.decision === "blocked_liquidate"),
      "the refusal is the evidence: proposed event names the class and the decision");
  });

  await t.step("a permissible class WITH a documented determination is received", async () => {
    const ik = await api("POST", `/cda/${cda}/inkind-transfers`, { asset_class: "federal_agency", amount_cents: 250_000, determination_ref: `d2-${r}` }, { key: staff });
    assertEq(ik.status, 201, `in-kind (${body(ik)})`);
    assertEq(ik.body.data.decision, "received", "received");
    assertEq((await asset("federal_agency"))?.permissible, true, "permissible");
  });

  await t.step("close: final accounting required; the report issues and a short closing distribution escalates", async () => {
    const bare = await api("POST", `/cda/${cda}/close`, {}, { key: staff });
    assertEq(bare.status, 400, `close without final accounting (${body(bare)})`);
    assert((await rowById("cda", cda)).status !== "closed", "not closed by a refused request");
    const c = await api("POST", `/cda/${cda}/close`, { final_accounting_ref: `fa-${r}` }, { key: staff });
    assertEq(c.status, 200, `close (${body(c)})`);
    assertEq(c.body.data.threshold_met, false, "no giving: the 51% closing threshold is not met");
    const row = await rowById("cda", cda);
    assertEq(row.status, "closed", "closed");
    const tr = await rowById("cda_termination", term);
    assertEq(tr.final_accounting_ref, `fa-${r}`, "final accounting kept");
    assertEq(tr.closing_coverage_bp, 0, "closing coverage read from the windows");
    assert(tr.report_issued_at && tr.report_due_at, "termination report issued with its 30-day due date");
    assertEq((await rowById("event", `ev_${cda}_termrpt`))?.payload?.closing_threshold_met, false, "report event");
    const esc = await rowById("event", `ev_${cda}_termshort`);
    assertEq(esc?.code, "cda.board_escalation.issued", "shortfall escalated, not swallowed");
    assertEq(esc?.payload?.reason, "closing_distribution_short", "reason");
  });
});

// ===================================================================== CDA-14

flow("cda: member communications — publication needs BOTH approvals and a passing WCAG checklist, and the artifact archived at publication", async (t) => {
  const staff = await actor("cu_admin", ["bsa_compliance"]);
  const r = run();
  let comm = "";

  await t.step("Marketing drafts a CDA programme page", async () => {
    const c = await api("POST", "/cda/communications", { title: `${r} CDA Program`, draft_ref: `draft-${r}` }, { key: staff });
    assertEq(c.status, 201, `draft (${body(c)})`);
    comm = String(c.body.data.id);
    assertEq((await rowById("cda_communication", comm))?.draft_ref, `draft-${r}`, "draft stored");
    assertEq((await rowById("event", `ev_${comm}_draft`))?.code, "cda.communication.drafted", "drafted event");
  });

  await t.step("publication is blocked without BOTH approvals", async () => {
    const partial = await api("POST", `/cda/communications/${comm}/approval`, {
      wcag_checklist_passed: true, marketing_approved_by: `mktg_${r}`,
    }, { key: staff });
    assertEq(partial.status, 409, `partial approval (${body(partial)})`);
    assert(String(partial.body.detail).includes("compliance_approval"), "names the missing approval");
    const pub = await api("POST", `/cda/communications/${comm}/publish`, { archived_ref: `a-${r}` }, { key: staff });
    assertEq(pub.status, 409, `publish unapproved (${body(pub)})`);
    const row = await rowById("cda_communication", comm);
    assertEq(row.approved_at, null, "not approved");
    assertEq(row.published_at, null, "not published");
    assertEq(await rowById("event", `ev_${comm}_pub`), null, "no published event");
  });

  await t.step("a failing WCAG checklist blocks even with both approvals", async () => {
    const res = await api("POST", `/cda/communications/${comm}/approval`, {
      wcag_checklist_passed: false, marketing_approved_by: `mktg_${r}`, compliance_approved_by: `cmp_${r}`,
    }, { key: staff });
    assertEq(res.status, 409, `failing checklist (${body(res)})`);
    assertEq(res.body.detail, "wcag_checklist", "the checklist is the only gap");
    assertEq((await rowById("cda_communication", comm)).approved_at, null, "not approved");
  });

  await t.step("both approvals + checklist approve; publishing requires the archive reference", async () => {
    const ok = await api("POST", `/cda/communications/${comm}/approval`, {
      wcag_checklist_passed: true, marketing_approved_by: `mktg_${r}`, compliance_approved_by: `cmp_${r}`,
    }, { key: staff });
    assertEq(ok.status, 200, `approval (${body(ok)})`);
    assertEq((await rowById("event", `ev_${comm}_appr`))?.code, "cda.communication.approved", "approved event");
    const noArchive = await api("POST", `/cda/communications/${comm}/publish`, {}, { key: staff });
    assertEq(noArchive.status, 400, `publish without archive (${body(noArchive)})`);
    assertEq((await rowById("cda_communication", comm)).published_at, null, "still unpublished");
    const pub = await api("POST", `/cda/communications/${comm}/publish`, { archived_ref: `a-${r}` }, { key: staff });
    assertEq(pub.status, 200, `publish (${body(pub)})`);
    const row = await rowById("cda_communication", comm);
    assert(row.published_at, "the row records publication");
    assertEq(row.archived_ref, `a-${r}`, "archived at publication");
    assertEq(row.marketing_approved_by, `mktg_${r}`, "marketing approver on the record");
    assertEq(row.compliance_approved_by, `cmp_${r}`, "compliance approver on the record");
    assertEq((await rowById("event", `ev_${comm}_pub`))?.payload?.communication_archived, `a-${r}`, "published event");
  });
});

// ===================================================================== CDA-02

flow("cda: glossary — the version is derived from the prior active term, never supplied; a definition with no citation is refused", async (t) => {
  const staff = await actor("cu_admin", ["bsa_compliance"]);
  const r = run();
  const term = `Total Return ${r}`;

  await t.step("two changes to a term land as v1 then v2, whatever version the caller claims", async () => {
    for (const [def, want] of [["d1", 1], ["d2", 2]] as const) {
      const g = await api("POST", "/cda/glossary", {
        term, definition: def, citation: "12 CFR 721.3(b)(2)", attested_by: `cmp_${r}`, version: 99,
      }, { key: staff });
      assertEq(g.status, 201, `glossary change (${body(g)})`);
      assertEq(g.body.data.version, want, "derived version");
    }
    const all = await rows("cda_glossary_term", "term", term);
    assertSame(all.map((x) => x.version).sort(), [1, 2], "two versions on file");
    const active = all.filter((x) => x.active === true);
    assertEq(active.length, 1, "exactly one active definition");
    assertEq(active[0].version, 2, "the latest");
    assertEq(active[0].definition, "d2", "with the latest text");
    const id2 = String(active[0].id);
    assertEq((await rowById("event", `ev_${id2}_upd`))?.payload?.prior_version, 1, "update event names the prior version");
    assertEq((await rowById("event", `ev_${id2}_att`))?.payload?.attested_by, `cmp_${r}`, "attestation event");
  });

  await t.step("a definition with no citation is refused and nothing is written", async () => {
    const aff = `Affiliate ${r}`;
    const g = await api("POST", "/cda/glossary", { term: aff, definition: "d", attested_by: `cmp_${r}` }, { key: staff });
    assertEq(g.status, 400, `no citation (${body(g)})`);
    assert(JSON.stringify(g.body).includes("citation"), "names the citation");
    assertEq((await rows("cda_glossary_term", "term", aff)).length, 0, "no term stored");
  });
});

// ===================================================================== CDA-11

flow("cda: programme audit — every finding needs a named owner; a finding cannot close without evidence; a late closure is recorded as late", async (t) => {
  const staff = await actor("cu_admin", ["bsa_compliance"]);
  // cycle_year is the finding's id namespace (cdafind_<year>_<i>), so run-unique
  const yearBad = 100_000 + Math.floor(Math.random() * 1_000_000_000);
  const year = yearBad + 1;
  const finding = `cdafind_${year}_0`;

  await t.step("a finding with no named owner is refused, not stored blank — and no report is issued", async () => {
    const a = await api("POST", "/cda/audit-cycles", { cycle_year: yearBad, findings: [{ summary: "something" }] }, { key: staff });
    assertEq(a.status, 400, `ownerless finding (${body(a)})`);
    assert(JSON.stringify(a.body).includes("remediation_owner"), "names the missing owner");
    assertEq((await rows("cda_audit_finding", "cycle_year", String(yearBad))).length, 0, "no finding stored");
    // DEFECT: postCdaAuditCycle emits cda.audit_report.issued BEFORE validating the findings, so a refused cycle leaves a report on the record
    assertEq(await rowById("event", `ev_cdaaud_${yearBad}`), null, "a refused audit cycle issues no audit report");
  });

  await t.step("an audit cycle logs its finding with an owner and a due date", async () => {
    const a = await api("POST", "/cda/audit-cycles", {
      cycle_year: year,
      // already past due: the remediation window closed yesterday
      findings: [{ summary: "cap evidence not retained", remediation_owner: "controller_01", due_days: -1 }],
    }, { key: staff });
    assertEq(a.status, 201, `audit cycle (${body(a)})`);
    assertSame(a.body.data.findings, [finding], "finding id");
    const row = await rowById("cda_audit_finding", finding);
    assertEq(row.remediation_owner, "controller_01", "owner");
    assert(Date.parse(row.remediation_due_at) < Date.now(), "due date in the past");
    assertEq((await rowById("event", `ev_cdaaud_${year}`))?.payload?.finding_count, 1, "audit report issued");
    assertEq((await rowById("event", `ev_${finding}_log`))?.code, "cda.audit_finding.logged", "finding logged");
  });

  await t.step("a finding cannot be closed without evidence", async () => {
    const bare = await api("POST", `/cda/findings/${finding}/close`, {}, { key: staff });
    assertEq(bare.status, 400, `close without evidence (${body(bare)})`);
    assertEq((await rowById("cda_audit_finding", finding)).closed_at, null, "still open");
  });

  await t.step("closing with evidence after the due date records the lateness", async () => {
    const c = await api("POST", `/cda/findings/${finding}/close`, { closure_evidence_ref: "pack-1" }, { key: staff });
    assertEq(c.status, 200, `close (${body(c)})`);
    const row = await rowById("cda_audit_finding", finding);
    assert(row.closed_at, "closed");
    assertEq(row.closure_evidence_ref, "pack-1", "evidence kept");
    const ev = await rowById("event", `ev_${finding}_closed`);
    assertEq(ev?.code, "cda.remediation.closed", "closure event");
    assertEq(ev?.payload?.closed_late, true, "lateness is part of the record");
  });
});
