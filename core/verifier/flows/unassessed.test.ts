// Unassessed surfaces: every place a NULL is load-bearing. Two kinds of "no
// value" must never collapse into each other:
//
//   NOT BREACHED  the check ran and the answer was no
//   UNASSESSED    nobody configured what the check needs, so there IS no answer
//
// The flattering failure is a plausible default (a fabricated OFAC list
// version, an unapproved threshold, a `false` where the honest answer is
// `null`): everything downstream then looks green. This flow walks the cheap
// unassessed sites end to end as staff do them and checks the unknown is
// stated on all three surfaces an examiner can read: the API response, the
// stored row, and the compliance dashboard's trace of the resource (the
// monitoring surface, which must carry the null rather than drop it). Each
// site is also exercised WITH a configured value, to prove the null is a
// statement and not a field that is simply never set.
//
// The per-domain flows already pin the rest of the unit file (capital trigger,
// enterprise cash, CDA and investment pre-trade blocks, the unlinked legacy
// account); ledger/unassessed.md maps each one. Lending sites stay unrouted
// (the narrow-bank exclusion in CLAUDE.md) and are dropped.
// Ports core/supabase/functions/api/unassessed.test.ts (see ledger/unassessed.md).
import { actor, type Any, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

const show = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);

async function rowById(table: string, id: string): Promise<Any> {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data;
}

/** events the compliance dashboard shows for one resource (`<type>:<id>`) */
async function traced(resource: string): Promise<Any[]> {
  const r = await api("GET", `/compliance/dashboard/trace/${resource}`, undefined, { key: null });
  assertEq(r.status, 200, `dashboard trace ${resource} (${show(r)})`);
  return r.body.events as Any[];
}

/** the key is PRESENT and null: an explicit unknown, not an omitted field */
function statesNull(obj: Any, key: string, where: string) {
  assert(obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key),
    `${where}: '${key}' is stated (got ${JSON.stringify(obj).slice(0, 200)})`);
  assertEq(obj[key], null, `${where}: '${key}' is null`);
}

flow("unassessed: every unconfigured check reaches the examiner as NO verdict — in the response, the row, and the dashboard trace — and turns into a real verdict once configured", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  const run = uid();
  let entity = "";
  let name = "";

  await t.step("fixtures: the partner onboards a member to screen", async () => {
    name = personaName();
    const e = await api("POST", "/entities", {
      type: "person", name, date_of_birth: "1981-09-09", address: "12 Null Ave, Springfield, IL 62701",
    }, { key: partner });
    assertEq(e.status, 201, `entity (${show(e)})`);
    entity = String(e.body.id);
  });

  await t.step("partners cannot run or read any of these institutional checks (404)", async () => {
    const calls: [string, string, Any][] = [
      ["POST", "/bsa/ofac/screens", { subject_kind: "entity", subject_ref: entity, name }],
      ["POST", "/bsa/pep/screens", { entity_ref: entity, name }],
      ["POST", "/investment/simulations", { kind: "stress", period: `ua_${run}`, scenario: "partner", result_bp: 1 }],
      ["POST", "/investment/liquidity/report", { period: `ua_${run}_partner` }],
      ["POST", "/complaints/trends", { period: `ua_${run}_partner`, lens: "enterprise" }],
    ];
    for (const [m, p, b] of calls) {
      const r = await api(m, p, b, { key: partner });
      assertEq(r.status, 404, `${p} as a partner (${show(r)})`);
    }
  });

  await t.step("OFAC: a clean screen names NO list — null on the row and on the dashboard's ofac.cleared, never a fabricated version", async () => {
    const r = await api("POST", "/bsa/ofac/screens", { subject_kind: "entity", subject_ref: entity, name }, { key: ops });
    assertEq(r.status, 201, `screen (${show(r)})`);
    assertEq(r.body.data?.verdict, "clear", "clear against the stub");
    // the response carries no list field at all; if one is ever added it must be null
    if (r.body.data && "list_version" in r.body.data) assertEq(r.body.data.list_version, null, "response list_version");
    const id = `ofacs_entity_${entity}`;
    statesNull(await rowById("ofac_screen", id), "list_version", "ofac_screen row");
    const ev = (await traced(`ofac_screen:${id}`)).filter((e) => e.code === "ofac.cleared");
    assert(ev.length > 0, "ofac.cleared is on the dashboard trace");
    for (const e of ev) statesNull(e.payload, "ofac.list_version", "dashboard ofac.cleared");
  });

  await t.step("PEP: the screen has no list either — null on the row and on the dashboard's pep.screened", async () => {
    const r = await api("POST", "/bsa/pep/screens", { entity_ref: entity, name }, { key: ops });
    assertEq(r.status, 201, `screen (${show(r)})`);
    assertEq(r.body.data?.verdict, "clear", "clear");
    const id = `peps_${entity}`;
    statesNull(await rowById("pep_screen", id), "list_version", "pep_screen row");
    const ev = (await traced(`pep_screen:${id}`)).filter((e) => e.code === "pep.screened");
    assert(ev.length > 0, "pep.screened is on the dashboard trace");
    for (const e of ev) statesNull(e.payload, "pep.list_version", "dashboard pep.screened");
  });

  await t.step("ALM: a -9999bp stress result with no minimum is NO verdict everywhere; the same result against a minimum is breached", async () => {
    const period = `ua_${run}`;
    const r = await api("POST", "/investment/simulations", { kind: "stress", period, scenario: "nomin", result_bp: -9999 }, { key: ops });
    assertEq(r.status, 201, `simulation (${show(r)})`);
    statesNull(r.body.data, "breached", "response");
    const id = String(r.body.data.id);
    const row = await rowById("alm_simulation", id);
    statesNull(row, "minimum_bp", "alm_simulation row");
    statesNull(row, "breached", "alm_simulation row");
    assertEq(row.escalated_at, null, "nothing escalated");
    const ev = await traced(`alm_simulation:${id}`);
    const done = ev.find((e) => e.code === "stress_test.completed");
    assert(done, `stress_test.completed on the trace (${ev.map((e) => e.code)})`);
    statesNull(done.payload, "breached", "dashboard stress_test.completed");
    statesNull(done.payload, "minimum_bp", "dashboard stress_test.completed");
    assert(!ev.some((e) => e.code === "stress_test.minimum.breached"), "no breach claimed");

    const w = await api("POST", "/investment/simulations", { kind: "stress", period, scenario: "withmin", result_bp: -9999, minimum_bp: 0 }, { key: ops });
    assertEq(w.status, 201, `with a minimum (${show(w)})`);
    assertEq(w.body.data.breached, true, "configured → a real verdict");
    assert((await traced(`alm_simulation:${w.body.data.id}`)).some((e) => e.code === "stress_test.minimum.breached"), "breach on the trace");
  });

  await t.step("liquidity: a report with no minimum marketable share is NO verdict; against an unmeetable minimum it is breached", async () => {
    const r = await api("POST", "/investment/liquidity/report", { period: `ua_${run}_a` }, { key: ops });
    assertEq(r.status, 201, `report (${show(r)})`);
    statesNull(r.body.data, "breached", "response");
    assert(Number.isInteger(r.body.data.marketable_pct_bp), "the measurement itself is computed");
    const id = String(r.body.data.id);
    const row = await rowById("liquidity_report", id);
    statesNull(row, "min_marketable_bp", "liquidity_report row");
    statesNull(row, "breached", "liquidity_report row");
    const pub = (await traced(`liquidity_report:${id}`)).find((e) => e.code === "liquidity.report.published");
    assert(pub, "liquidity.report.published on the trace");
    statesNull(pub.payload, "breached", "dashboard liquidity.report.published");

    const w = await api("POST", "/investment/liquidity/report", { period: `ua_${run}_b`, min_marketable_bp: 10001 }, { key: ops });
    assertEq(w.status, 201, `with a minimum (${show(w)})`);
    assertEq(w.body.data.breached, true, "configured → a real verdict");
  });

  await t.step("complaint trend: a 700bp cohort disparity with no threshold is NO verdict and opens no CAP; with a threshold it is breached", async () => {
    const cohorts = { a: 200, b: 900 };
    const r = await api("POST", "/complaints/trends", { period: `ua_${run}_a`, lens: "enterprise", cohorts }, { key: ops });
    assertEq(r.status, 201, `trend (${show(r)})`);
    statesNull(r.body.data, "breached", "response");
    const id = String(r.body.data.id);
    const row = await rowById("complaint_trend", id);
    assertEq(row.disparity_bp, 700, "the disparity is measured");
    statesNull(row, "threshold_bp", "complaint_trend row");
    statesNull(row, "breached", "complaint_trend row");
    assertEq(row.cap_opened_at, null, "no corrective action plan");
    assert(!(await traced(`complaint_trend:${id}`)).some((e) => e.code === "analytics.cap.opened"), "no CAP on the trace");

    const w = await api("POST", "/complaints/trends", { period: `ua_${run}_b`, lens: "enterprise", cohorts, threshold_bp: 100 }, { key: ops });
    assertEq(w.status, 201, `with a threshold (${show(w)})`);
    assertEq(w.body.data.breached, true, "configured → a real verdict");
  });

  await t.step("cash over/short: with no institutional threshold the dashboard shows 'unassessed', never 'not crossed'", async () => {
    const asset = `casset_ua_${run}`;
    const a = await api("PUT", `/cash-ops/assets/${asset}`, {
      asset_type: "teller_drawer", location_id: `branch_ua_${run}`, balance_cents: 1, custodian_user_id: `teller_ua_${run}`,
    }, { key: ops });
    assertEq(a.status, 200, `register drawer (${show(a)})`);
    const r = await api("POST", `/cash-ops/assets/${asset}/overshort`, {
      custodian_user_id: `teller_ua_${run}`, business_date: "2026-07-10", amount_cents: -99_999_00,
    }, { key: ops });
    assertEq(r.status, 201, `over/short (${show(r)})`);
    const id = String(r.body.data.id);
    const ev = await rowById("event", `ev_${id}_unassessed`);
    assertEq(ev?.code, "cash.overshort.thresholds", "the threshold verdict is recorded");
    assertEq(ev.payload.verdict, "unassessed", "unassessed");
    statesNull(ev.payload, "cash.overshort.thresholds", "stored event");
    const thr = (await traced(`cash_asset:${asset}`)).filter((e) => e.code === "cash.overshort.thresholds");
    assert(thr.some((e) => e.payload?.verdict === "unassessed"), "the dashboard trace says unassessed");
    assertEq(await rowById("event", `ev_${id}_thr`), null, "no crossing claimed");
  });
});
