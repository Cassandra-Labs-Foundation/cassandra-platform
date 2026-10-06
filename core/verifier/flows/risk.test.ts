// Enterprise-risk flows: ERM-06 appetite breaches, ERM-07 risk acceptances,
// IC-06 control overrides and standing exceptions. Risk management registers a
// risk with an owner, the Board approves a KRI tolerance, observations are
// measured against it (inside appetite is recorded too), a breach's severity
// decides who is told, and it goes to committee with a plan. An owner asks to
// carry a risk for a bounded time; someone else decides; the sweep warns ahead
// of expiry and, on expiry, puts the risk back in breach. Overrides are
// recorded with a rationale and their REPETITION is reported; standing
// exceptions are four-eyed, time-boxed, and revert when they lapse.
// Replaces the stubbed unit tests in
// core/supabase/functions/api/risk_exceptions.test.ts (see ledger/risk_exceptions.md).
//
// SHARED-STATE DISCIPLINE. Every risk, appetite, control id and actor is
// run-unique. The acceptance and exception sweeps are instance-wide (ordered
// by expiry, 200 rows); the flow moves only ITS OWN rows' clocks, by a
// service-role update (the API has no way to move time), and deletes every row
// it created at the end so the sweeps' windows never fill with fixtures.
// Events are evidence and stay.
import { actor, type Any, api, assert, assertEq, core, flow } from "./helpers.ts";

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const DAY = 86_400_000;
const run = () => crypto.randomUUID().slice(0, 8);
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

async function rowById(table: string, id: string) {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data as Any;
}

async function rowsWhere(table: string, col: string, val: string): Promise<Any[]> {
  const r = await core().from(table).select("*").eq(col, val);
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data ?? [];
}

/** events about one resource, keyed by code (all occurrences) */
async function eventsFor(resourceType: string, id: string): Promise<Map<string, Any[]>> {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("resource_id", `${resourceType}:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  const m = new Map<string, Any[]>();
  for (const e of r.data ?? []) m.set(e.code, [...(m.get(e.code) ?? []), e]);
  return m;
}

/** service-role clock move on a row THIS flow created */
async function setClock(table: string, id: string, patch: Record<string, unknown>) {
  const r = await core().from(table).update(patch).eq("id", id);
  assert(!r.error, `clock move on ${table}/${id}: ${r.error?.message}`);
}

async function del(table: string, col: string, vals: string[]) {
  if (!vals.length) return;
  const r = await core().from(table).delete().in(col, vals);
  if (r.error) console.error(`cleanup ${table} ${vals.join(",")}: ${r.error.message}`);
}

/** a registered risk with a Board-approved KRI tolerance, owned by `owner` */
async function seedAppetite(key: string, r: string, owner: string, o: Record<string, unknown> = {}) {
  const riskId = `risk_flow_${r}`;
  const appetiteId = `rapp_flow_${r}`;
  const reg = await api("PUT", `/risk/register/${riskId}`, {
    title: "Flow consumer credit deterioration", taxonomy_category_code: "credit",
    owner_id: owner, residual_rating: "moderate", remediation_evidence: "tightening-2026",
  }, { key });
  assertEq(reg.status, 200, `register risk (${body(reg)})`);
  const ap = await api("PUT", `/risk/appetite/${appetiteId}`, {
    risk_id: riskId, taxonomy_category_code: "credit", kri_name: "delinquency_bp",
    tolerance_value: 300, direction: "above", owner_id: owner,
    document_ref: "ras-2026", approved_by: "board_flow", ...o,
  }, { key });
  assertEq(ap.status, 200, `appetite (${body(ap)})`);
  return { riskId, appetiteId };
}

// ------------------------------------------------------------ ERM-06 breaches

flow("risk: a KRI is measured against Board appetite → inside is recorded → outside opens a breach whose severity decides who is told → presented to committee with a plan", async (t) => {
  const crm = await actor("cu_admin");
  const partner = await actor("partner");
  const r = run();
  const owner = `cro_flow_${r}`;
  const riskId = `risk_flow_${r}`;
  const appetiteId = `rapp_flow_${r}`;
  const liqAppetite = `rapp_flow_liq_${r}`;
  const breaches: string[] = [];
  const observe = (appetite: string, v: number, o: Record<string, unknown> = {}) =>
    api("POST", "/risk/observations", { appetite_id: appetite, kri_value: v, ...o }, { key: crm });
  try {
    await t.step("a partner cannot reach the risk register (404) and writes nothing", async () => {
      const res = await api("PUT", `/risk/register/${riskId}`,
        { title: "x", taxonomy_category_code: "credit", owner_id: owner }, { key: partner });
      assertEq(res.status, 404, `partner (${body(res)})`);
      assertEq(await rowById("risk", riskId), null, "no risk row");
    });

    await t.step("ERM-06: a risk with no OWNER is refused (400 owner_id) — the register exists to prevent that", async () => {
      const res = await api("PUT", `/risk/register/${riskId}`,
        { title: "Unowned", taxonomy_category_code: "ops" }, { key: crm });
      assertEq(res.status, 400, `unowned (${body(res)})`);
      assert(JSON.stringify(res.body).includes("owner_id"), "owner_id named");
      assertEq(await rowById("risk", riskId), null, "no risk row");
    });

    await t.step("an appetite with no Board approval or document is refused, every missing field named", async () => {
      const res = await api("PUT", `/risk/appetite/${appetiteId}`,
        { taxonomy_category_code: "credit", kri_name: "delinquency_bp", tolerance_value: 300, owner_id: owner }, { key: crm });
      assertEq(res.status, 400, `unapproved appetite (${body(res)})`);
      const s = JSON.stringify(res.body);
      assert(s.includes("document_ref") && s.includes("approved_by"), "document_ref and approved_by named");
      assertEq(await rowById("risk_appetite", appetiteId), null, "no appetite row");
    });

    await t.step("risk management registers the owned risk and the Board-approved tolerance (300bp, above)", async () => {
      await seedAppetite(crm, r, owner);
      const risk = await rowById("risk", riskId);
      assertEq(risk.owner_id, owner, "owner recorded");
      assertEq(risk.provenance, "demo", "labelled demo");
      assertEq((await eventsFor("risk", riskId)).get("risk.registered")?.[0].payload["risk.owner_id"], owner, "risk.registered names the owner");
      const ap = await rowById("risk_appetite", appetiteId);
      assertEq(Number(ap.tolerance_value), 300, "tolerance");
      assertEq(ap.direction, "above", "direction");
      assertEq(ap.approved_by, "board_flow", "approver");
    });

    await t.step("an observation against an unknown appetite is a 404", async () => {
      const res = await observe(`rapp_flow_missing_${r}`, 10);
      assertEq(res.status, 404, `unknown appetite (${body(res)})`);
    });

    await t.step("ERM-06: 180bp is INSIDE appetite — no breach, but the check is recorded (measured ≠ never measured)", async () => {
      const res = await observe(appetiteId, 180);
      assertEq(res.status, 200, `inside (${body(res)})`);
      assertEq(res.body.data.breached, false, "not breached");
      assertEq((await rowsWhere("risk_breach", "appetite_id", appetiteId)).length, 0, "no breach row");
      const within = (await eventsFor("risk_appetite", appetiteId)).get("risk.within_appetite") ?? [];
      assertEq(within.length, 1, "risk.within_appetite recorded");
      assertEq(within[0].payload["kri.value"], 180, "with the measured value");
      assertEq(within[0].payload["risk_appetite.document"], "ras-2026", "and the appetite document");
    });

    await t.step("ERM-06: 310bp is a LOW excursion — breach opened with its three clocks, the CRO is NOT paged", async () => {
      const res = await observe(appetiteId, 310, { impact_summary: "seasonal uptick" });
      assertEq(res.status, 201, `low breach (${body(res)})`);
      assertEq(res.body.data.severity, "low", "10/300 is low");
      const id = res.body.data.id;
      breaches.push(id);
      const b = await rowById("risk_breach", id);
      assertEq(Number(b.current_excursion), 10, "excursion stored");
      assertEq(b.owner_id, owner, "owned by the appetite owner");
      assertEq(b.remediation_status, "open", "open");
      assertEq(b.provenance, "demo", "labelled demo");
      const detected = new Date(b.detected_at).getTime();
      assertEq(Math.round((new Date(b.committee_due_at).getTime() - detected) / DAY), 30, "committee due in 30 days");
      assertEq(Math.round((new Date(b.review_due_at).getTime() - detected) / DAY), 30, "monthly review clock");
      assert(new Date(b.triage_due_at).getTime() > detected, "triage clock set");
      const ev = await eventsFor("risk_breach", id);
      for (const c of ["risk_breach.detected", "risk_breach.opened", "risk_breach.triage.due_at", "risk_breach.committee_due_at", "risk_breach.review.due_at"]) {
        assert(ev.has(c), `${c} emitted`);
      }
      assert(!ev.has("risk_breach.cro.notified"), "notifying on every breach makes the notification meaningless");
    });

    await t.step("ERM-06: 700bp is CRITICAL — the CRO is notified at once, with the reason", async () => {
      const res = await observe(appetiteId, 700);
      assertEq(res.status, 201, `critical breach (${body(res)})`);
      assertEq(res.body.data.severity, "critical", "400/300 is critical");
      const id = res.body.data.id;
      breaches.push(id);
      assertEq((await rowById("risk_breach", id)).severity, "critical", "stored critical");
      const cro = (await eventsFor("risk_breach", id)).get("risk_breach.cro.notified");
      assertEq(cro?.[0].payload.reason, "severity=critical", "CRO notified, reason given");
    });

    await t.step("ERM-06: direction matters — on a 'below' appetite a LOW value breaches and a high one does not", async () => {
      const ap = await api("PUT", `/risk/appetite/${liqAppetite}`, {
        taxonomy_category_code: "liquidity", kri_name: "coverage_pct", tolerance_value: 100,
        direction: "below", owner_id: owner, document_ref: "ras-2026", approved_by: "board_flow",
      }, { key: crm });
      assertEq(ap.status, 200, `below appetite (${body(ap)})`);
      const low = await observe(liqAppetite, 50);
      assertEq(low.status, 201, `low value breaches (${body(low)})`);
      breaches.push(low.body.data.id);
      assertEq(low.body.data.severity, "high", "50/100 is high");
      const high = await observe(liqAppetite, 150);
      assertEq(high.status, 200, `high value inside (${body(high)})`);
      assertEq((await rowsWhere("risk_breach", "appetite_id", liqAppetite)).length, 1, "one breach only");
    });

    await t.step("ERM-06: a breach presented with no remediation plan is a status report — refused (400), nothing stamped", async () => {
      const res = await api("POST", `/risk/breaches/${breaches[1]}/present`, {}, { key: crm });
      assertEq(res.status, 400, `no plan (${body(res)})`);
      assert(JSON.stringify(res.body).includes("remediation_plan"), "remediation_plan named");
      assertEq((await rowById("risk_breach", breaches[1])).committee_presented_at, null, "not presented");
    });

    await t.step("presented on time with a plan: triaged, presented, reviewed, in progress — and not late", async () => {
      const res = await api("POST", `/risk/breaches/${breaches[1]}/present`,
        { remediation_plan: "tighten underwriting; weekly KRI watch" }, { key: crm });
      assertEq(res.status, 200, `present (${body(res)})`);
      const b = await rowById("risk_breach", breaches[1]);
      assert(b.committee_presented_at && b.triaged_at && b.reviewed_at, "all three stamped");
      assertEq(b.remediation_status, "in_progress", "status");
      assertEq(b.remediation_plan, "tighten underwriting; weekly KRI watch", "plan stored");
      const ev = await eventsFor("risk_breach", breaches[1]);
      assertEq(ev.get("risk_breach.committee.presented")?.[0].payload.presented_late, false, "on time");
      assert(ev.has("risk_breach.status.reviewed"), "status reviewed");
    });

    await t.step("a breach whose 30-day committee deadline has passed is recorded as presented LATE", async () => {
      // clock simulation on our own breach: the API cannot move time
      await setClock("risk_breach", breaches[0], { committee_due_at: new Date(Date.now() - 2 * DAY).toISOString() });
      const res = await api("POST", `/risk/breaches/${breaches[0]}/present`, { remediation_plan: "p" }, { key: crm });
      assertEq(res.status, 200, `late present (${body(res)})`);
      assertEq((await eventsFor("risk_breach", breaches[0])).get("risk_breach.committee.presented")?.[0].payload.presented_late,
        true, "presented_late");
    });
  } finally {
    await del("risk_breach", "id", breaches);
    await del("risk_appetite", "id", [appetiteId, liqAppetite]);
    await del("risk", "id", [riskId]);
  }
});

// ---------------------------------------------------------- ERM-07 acceptance

flow("risk: the owner asks to carry a breached risk for a bounded time → someone else decides → the sweep warns ahead of expiry → on expiry the risk is back in breach", async (t) => {
  const crm = await actor("cu_admin");
  const noRole = await actor("cu_admin");
  const cco = await actor("cu_admin", ["cco"]);
  const r = run();
  const owner = `cro_flow_${r}`;
  const { riskId, appetiteId } = { riskId: `risk_flow_${r}`, appetiteId: `rapp_flow_${r}` };
  const breaches: string[] = [];
  let acc = "";
  let breach = "";
  const request = (o: Record<string, unknown>) =>
    api("POST", "/risk/acceptances", { risk_id: riskId, owner_id: owner, rationale: "seasonal; compensating review", ...o }, { key: crm });
  const accRows = () => rowsWhere("risk_acceptance", "risk_id", riskId);
  const sweep = async () => {
    const res = await api("POST", "/risk/acceptances/sweep", {}, { key: crm });
    assertEq(res.status, 200, `sweep (${body(res)})`);
    return res.body.data;
  };
  try {
    await t.step("setup: a registered risk is in breach (critical excursion on its appetite)", async () => {
      await seedAppetite(crm, r, owner);
      const o = await api("POST", "/risk/observations", { appetite_id: appetiteId, kri_value: 700 }, { key: crm });
      assertEq(o.status, 201, `breach (${body(o)})`);
      breach = o.body.data.id;
      breaches.push(breach);
    });

    await t.step("ERM-07: an acceptance with NO expiry is refused (400 expiry_date) — no permanent exceptions by inattention", async () => {
      const res = await request({ breach_id: breach });
      assertEq(res.status, 400, `no expiry (${body(res)})`);
      assert(JSON.stringify(res.body).includes("expiry_date"), "expiry_date named");
      assertEq((await accRows()).length, 0, "nothing stored");
    });

    await t.step("ERM-07: an expiry inside the 30-day warning window cannot be revisited in time — refused (409)", async () => {
      const res = await request({ breach_id: breach, expiry_date: inDays(5) });
      assertEq(res.status, 409, `too soon (${body(res)})`);
      assertEq(res.body.type, "risk_acceptance_expiry_too_soon", "typed refusal");
      assertEq((await accRows()).length, 0, "nothing stored");
    });

    await t.step("the owner requests a 200-day acceptance: stored undecided, alert set 30 days before expiry, request evidenced", async () => {
      const res = await request({ breach_id: breach, expiry_date: inDays(200), remediation_evidence: "weekly KRI watch" });
      assertEq(res.status, 201, `request (${body(res)})`);
      acc = res.body.data.id;
      const a = await rowById("risk_acceptance", acc);
      assertEq(a.decision, null, "undecided");
      assertEq(a.breach_id, breach, "linked to the breach it covers");
      assertEq(Math.round((new Date(a.expiry_date).getTime() - new Date(a.expiry_alert_at).getTime()) / DAY), 30, "alert 30 days ahead");
      assertEq(a.provenance, "demo", "labelled demo");
      const ev = await eventsFor("risk_acceptance", acc);
      for (const c of ["risk_acceptance.requested", "risk_acceptance.decision.due_at", "risk_acceptance.expiry_alert_at"]) {
        assert(ev.has(c), `${c} emitted`);
      }
      assertEq(ev.get("risk_acceptance.requested")?.[0].payload["risk.remediation_evidence"], "weekly KRI watch", "compensating controls on the request");
    });

    await t.step("ERM-07: the decision is due 30 calendar days from the request", async () => {
      const a = await rowById("risk_acceptance", acc);
      const days = Math.round((new Date(a.decision_due_at).getTime() - new Date(a.requested_at).getTime()) / DAY);
      // Regression guard (fixed 2026-10-06): ACCEPTANCE_DECISION_DAYS was 10; ERM-07 sets
      // risk_acceptance.decision_due_at at 30 calendar days from the request.
      assertEq(days, 30, "decision_due_at − requested_at in days");
    });

    await t.step("the owner cannot grant their own acceptance (409), and nothing is decided", async () => {
      const res = await api("POST", `/risk/acceptances/${acc}/decide`, { decision: "accepted", decided_by: owner }, { key: cco });
      assertEq(res.status, 409, `self-grant (${body(res)})`);
      assertEq(res.body.type, "risk_acceptance_self_granted", "typed refusal");
      assertEq((await rowById("risk_acceptance", acc)).decision, null, "undecided");
    });

    await t.step("a decision that is neither accepted nor declined is refused (400)", async () => {
      const res = await api("POST", `/risk/acceptances/${acc}/decide`, { decision: "maybe", decided_by: "board_risk_committee" }, { key: cco });
      assertEq(res.status, 400, `bad decision (${body(res)})`);
      assertEq((await rowById("risk_acceptance", acc)).decision, null, "undecided");
    });

    await t.step("ERM-07: a staff credential without the CCO role cannot decide an acceptance (403), nothing decided", async () => {
      const res = await api("POST", `/risk/acceptances/${acc}/decide`, { decision: "accepted", decided_by: "board_risk_committee" }, { key: noRole });
      // Regression guard (fixed 2026-10-06): postRiskAcceptanceDecision checked no role at all. By user
      // decision the CCO decides acceptances at every risk level; any other staff token gets 403.
      assertEq(res.status, 403, `no-role decision (${body(res)})`);
      assertEq(res.body.type, "insufficient_role", "typed refusal");
      if (res.status === 200) {
        // undo the unauthorised grant so the CCO step below decides from a clean state
        await setClock("risk_acceptance", acc, { decision: null, decided_at: null, decided_by: null });
      }
      assertEq((await rowById("risk_acceptance", acc)).decision, null, "undecided");
    });

    await t.step("ERM-07: the credential that REQUESTED an acceptance cannot decide it, even with the CCO role (409)", async () => {
      // four eyes on credentials, not typed names: a CCO who files the request
      // is not the independent decider
      const requester = await actor("cu_admin", ["cco"]);
      const own = await api("POST", "/risk/acceptances", {
        risk_id: riskId, owner_id: owner, rationale: "requested by the CCO themself",
        breach_id: breach, expiry_date: inDays(90), remediation_evidence: "flow",
      }, { key: requester });
      assertEq(own.status, 201, `CCO files a request (${body(own)})`);
      const ownId = own.body.data.id;
      try {
        const res = await api("POST", `/risk/acceptances/${ownId}/decide`,
          { decision: "accepted", decided_by: "board_risk_committee" }, { key: requester });
        assertEq(res.status, 409, `the requester decides its own request (${body(res)})`);
        assertEq((await rowById("risk_acceptance", ownId)).decision, null, "undecided");
      } finally {
        // keep the flow's later sweep steps about the ONE acceptance under test
        await core().from("risk_acceptance").delete().eq("id", ownId);
      }
    });

    await t.step("the CCO accepts it on time: decision recorded with the decider, decided event not late", async () => {
      const res = await api("POST", `/risk/acceptances/${acc}/decide`, { decision: "accepted", decided_by: "board_risk_committee" }, { key: cco });
      assertEq(res.status, 200, `decide (${body(res)})`);
      const a = await rowById("risk_acceptance", acc);
      assertEq(a.decision, "accepted", "accepted");
      // the decider is the CREDENTIAL (fixed 2026-10-06); the typed name is only a display label
      assert(String(a.decided_by).startsWith("tok_test_cu_admin_"), `decider is the cco credential (${a.decided_by})`);
      assertEq(a.decided_by_label, "board_risk_committee", "typed name kept as a label");
      assert(a.decided_at, "decided_at stamped");
      const ev = (await eventsFor("risk_acceptance", acc)).get("risk_acceptance.decided")?.[0];
      assertEq(ev?.payload.decided_late, false, "on time");
    });

    await t.step("ERM-07 sweep, 200 days out: no alert yet, but the row is touched (a bounded sweep must not starve its tail)", async () => {
      const before = (await rowById("risk_acceptance", acc)).updated_at;
      await sweep();
      const a = await rowById("risk_acceptance", acc);
      assertEq(a.expiry_alerted_at, null, "no alert");
      assertEq(a.expired_at, null, "not expired");
      assert(new Date(a.updated_at).getTime() > new Date(before).getTime(), "updated_at advanced");
      assert(!(await eventsFor("risk_acceptance", acc)).has("risk_acceptance.expiry_alerted"), "no alert event");
    });

    await t.step("20 days from expiry (clock moved): the sweep sends the 30-day alert once, and the acceptance still stands", async () => {
      await setClock("risk_acceptance", acc, { expiry_alert_at: inDays(-10), expiry_date: inDays(20) });
      await sweep();
      await sweep();
      const a = await rowById("risk_acceptance", acc);
      assert(a.expiry_alerted_at, "expiry_alerted_at stamped");
      assertEq(a.expired_at, null, "not expired");
      const alerts = (await eventsFor("risk_acceptance", acc)).get("risk_acceptance.expiry_alerted") ?? [];
      assertEq(alerts.length, 1, "alerted exactly once across two sweeps");
      assert(alerts[0].payload.days_remaining >= 19 && alerts[0].payload.days_remaining <= 20, `days_remaining ${alerts[0].payload.days_remaining}`);
    });

    await t.step("ERM-07: the 7-day expiry warning has NOT fired 20 days out", async () => {
      // Regression guard (fixed 2026-10-06): the sweep used to emit risk_acceptance.expiry.warning together with
      // the 30-day alert; ERM-07 defines it as a separate escalation to the CCO 7 days before expiry.
      assert(!(await eventsFor("risk_acceptance", acc)).has("risk_acceptance.expiry.warning"),
        "risk_acceptance.expiry.warning emitted 20 days before expiry");
    });

    await t.step("the expiry date passes (clock moved): the sweep expires it and the risk is back in breach", async () => {
      const breachesBefore = (await rowsWhere("risk_breach", "appetite_id", appetiteId)).length;
      await setClock("risk_acceptance", acc, { expiry_alert_at: inDays(-31), expiry_date: new Date(Date.now() - 60_000).toISOString() });
      await sweep();
      const a = await rowById("risk_acceptance", acc);
      assert(a.expired_at, "expired_at stamped");
      const ev = await eventsFor("risk_acceptance", acc);
      assert(ev.has("risk_acceptance.expired"), "risk_acceptance.expired");
      assertEq(ev.get("risk_breach.opened")?.[0].payload.reason, "risk_acceptance_expired", "breach re-opened, with the reason");
      const after = await rowsWhere("risk_breach", "appetite_id", appetiteId);
      for (const b of after) if (!breaches.includes(b.id)) breaches.push(b.id);
      // Regression guard (fixed 2026-10-06): the sweep used to emit only a risk_breach.opened EVENT; ERM-07
      // requires a breach RECORD for the associated risk, one per lapsed acceptance.
      assertEq(after.length, breachesBefore + 1, "a new risk_breach row for the lapsed acceptance's risk");
    });

    await t.step("an expired acceptance is not swept again", async () => {
      const before = (await rowById("risk_acceptance", acc)).updated_at;
      await sweep();
      assertEq((await rowById("risk_acceptance", acc)).updated_at, before, "untouched once expired");
      assertEq((await eventsFor("risk_acceptance", acc)).get("risk_acceptance.expired")?.length, 1, "expired once");
    });
  } finally {
    await del("control_exception", "risk_acceptance_id", acc ? [acc] : []);
    await del("risk_acceptance", "risk_id", [riskId]);
    await del("risk_breach", "id", breaches);
    await del("risk_appetite", "id", [appetiteId]);
    await del("risk", "id", [riskId]);
  }
});

// ------------------------------------------------------------ IC-06 overrides

flow("risk: control overrides are recorded with a rationale and their REPETITION is reported → standing exceptions are four-eyed, time-boxed, warned and REVERTED when they lapse", async (t) => {
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  const cco = await actor("cu_admin", ["cco"]);
  const r = run();
  const velocity = `CG-VEL-FLOW-${r}`;
  const nsf = `CG-NSF-FLOW-${r}`;
  const operator = `ops_flow_${r}`;
  const operator2 = `ops_flow2_${r}`;
  const exCtl = `CG-EXC-FLOW-${r}`;
  const owner = `cro_flow_${r}`;
  const riskId = `risk_flow_${r}`;
  let acc = "";
  let farEx = "";
  let soonEx = "";
  const override = (o: Record<string, unknown>) =>
    api("POST", "/controls/overrides", { control_id: velocity, subject_ref: `txn_flow_${r}`, actor_ref: operator, rationale: "member verified by callback", ...o }, { key: ops });
  const exception = (o: Record<string, unknown>) =>
    api("POST", "/controls/exceptions", {
      control_id: exCtl, scope: "payroll ACH from a single employer", rationale: "employer migration",
      approver_id: "cco_flow", registered_by: operator, expires_at: inDays(100), risk_acceptance_id: acc, ...o,
    }, { key: ops });
  const exSweep = async () => {
    const res = await api("POST", "/controls/exceptions/sweep", {}, { key: ops });
    assertEq(res.status, 200, `exception sweep (${body(res)})`);
  };
  try {
    await t.step("a partner cannot record an override (404)", async () => {
      const res = await api("POST", "/controls/overrides",
        { control_id: velocity, subject_ref: "t", actor_ref: operator, rationale: "r" }, { key: partner });
      assertEq(res.status, 404, `partner (${body(res)})`);
      assertEq((await rowsWhere("control_override", "control_id", velocity)).length, 0, "no override row");
    });

    await t.step("IC-06: an override with no rationale is indistinguishable from a broken control — refused (400 rationale)", async () => {
      const res = await override({ rationale: undefined });
      assertEq(res.status, 400, `no rationale (${body(res)})`);
      assert(JSON.stringify(res.body).includes("rationale"), "rationale named");
      assertEq((await rowsWhere("control_override", "control_id", velocity)).length, 0, "no override row");
    });

    await t.step("an operator overrides the velocity control three times and the NSF control once: each recorded, the actor registered as a system principal", async () => {
      for (const n of [1, 2, 3]) {
        const res = await override({ subject_ref: `txn_flow_${r}_${n}` });
        assertEq(res.status, 201, `override ${n} (${body(res)})`);
        const ev = await eventsFor("control_override", res.body.data.id);
        assert(ev.has("control.override.invoked"), "invoked");
        assertEq(ev.get("override.recorded")?.[0].payload["override.rationale"], "member verified by callback", "recorded with rationale");
      }
      const one = await override({ control_id: nsf, actor_ref: operator2, actor_role: "supervisor" });
      assertEq(one.status, 201, `nsf override (${body(one)})`);
      const rows = await rowsWhere("control_override", "control_id", velocity);
      assertEq(rows.length, 3, "three overrides on the velocity control");
      assertEq(rows[0].provenance, "demo", "labelled demo");
      const u = await rowById("user", operator);
      assertEq(u?.role, "operator", "actor registered with a default role");
      assertEq((await rowById("user", operator2))?.role, "supervisor", "declared role kept");
    });

    await t.step("IC-06: the analytics NAME the repeatedly-overridden control rather than leaving it in a frequency table", async () => {
      const period = `flow-${r}`;
      const res = await api("POST", "/controls/overrides/analytics", { period }, { key: cco });
      assertEq(res.status, 201, `analytics (${body(res)})`);
      const rep = (res.body.data.repeatedly_overridden as Any[]);
      assertEq(rep.find((x) => x.control_id === velocity)?.count, 3, "velocity control named with its count");
      assert(!rep.some((x) => x.control_id === nsf), "a single override is not repetition");
      const ev = (await eventsFor("control_override", `covran_${period}`)).get("override.analytics.published")?.[0];
      assert(ev, "override.analytics.published");
      assertEq(ev.payload.by_control[velocity], 3, "frequency by control");
      assertEq(ev.payload.by_actor[operator], 3, "frequency by actor");
      assert((ev.payload.repeatedly_overridden as Any[]).some((x) => x.control_id === velocity), "repetition named in the report");
    });

    await t.step("setup: the deviation is backed by a decided risk acceptance", async () => {
      await seedAppetite(ops, r, owner);
      const a = await api("POST", "/risk/acceptances",
        { risk_id: riskId, owner_id: owner, rationale: "employer migration", expiry_date: inDays(120) }, { key: ops });
      assertEq(a.status, 201, `acceptance (${body(a)})`);
      acc = a.body.data.id;
    });

    await t.step("IC-06: an exception cannot be self-approved (409) and must be time-boxed (400 expires_at); nothing stored", async () => {
      const self = await exception({ approver_id: operator });
      assertEq(self.status, 409, `self-approved (${body(self)})`);
      assertEq(self.body.type, "control_exception_self_approved", "typed refusal");
      const open = await exception({ expires_at: undefined });
      assertEq(open.status, 400, `no expiry (${body(open)})`);
      assert(JSON.stringify(open.body).includes("expires_at"), "expires_at named");
      assertEq((await rowsWhere("control_exception", "control_id", exCtl)).length, 0, "no exception row");
    });

    await t.step("IC-06: a standing exception with no risk acceptance behind it is refused", async () => {
      const res = await exception({ risk_acceptance_id: undefined, control_id: `${exCtl}-NORA` });
      // Regression guard (fixed 2026-10-06): risk_acceptance_id was optional; IC-06 requires a standing exception
      // to be registered with an expiry AND a risk acceptance (exception.risk_acceptance).
      assertEq(res.status, 400, `no risk acceptance (${body(res)})`);
      assertEq((await rowsWhere("control_exception", "control_id", `${exCtl}-NORA`)).length, 0, "no exception row");
    });

    await t.step("the CCO-approved exception is registered for 100 days, and a second for 10 days", async () => {
      const far = await exception({});
      assertEq(far.status, 201, `register (${body(far)})`);
      farEx = far.body.data.id;
      const row = await rowById("control_exception", farEx);
      assertEq(row.approver_id, "cco_flow", "approver");
      assertEq(row.risk_acceptance_id, acc, "linked to the acceptance");
      assertEq(row.reverted_at, null, "in force");
      assertEq((await eventsFor("control_exception", farEx)).get("exception.registered")?.[0].payload["exception.risk_acceptance"], acc,
        "registration evidence names the acceptance");
      const soon = await exception({ expires_at: inDays(10), scope: "card velocity for one merchant" });
      assertEq(soon.status, 201, `register soon (${body(soon)})`);
      soonEx = soon.body.data.id;
    });

    await t.step("the sweep leaves the 100-day exception alone and flags the 10-day one as EXPIRING (still in force)", async () => {
      await exSweep();
      assertEq((await rowById("control_exception", farEx)).reverted_at, null, "far one in force");
      assert(!(await eventsFor("control_exception", farEx)).has("exception.expiring"), "no warning for the far one");
      assertEq((await rowById("control_exception", soonEx)).reverted_at, null, "soon one still in force");
      assert((await eventsFor("control_exception", soonEx)).has("exception.expiring"), "exception.expiring for the soon one");
    });

    await t.step("IC-06: once its expiry passes (clock moved) the exception REVERTS — the control comes back on", async () => {
      await setClock("control_exception", soonEx, { expires_at: new Date(Date.now() - 60_000).toISOString() });
      await exSweep();
      const row = await rowById("control_exception", soonEx);
      assert(row.reverted_at, "an expiry that only alerts leaves the control off indefinitely");
      assertEq((await eventsFor("control_exception", soonEx)).get("exception.reverted")?.[0].payload["control.id"], exCtl, "exception.reverted names the control");
      assertEq((await rowById("control_exception", farEx)).reverted_at, null, "the other exception is unaffected");
    });
  } finally {
    await del("control_exception", "control_id", [exCtl, `${exCtl}-NORA`]);
    await del("risk_acceptance", "risk_id", [riskId]);
    await del("risk_appetite", "id", [`rapp_flow_${r}`]);
    await del("risk", "id", [riskId]);
    await del("control_override", "control_id", [velocity, nsf]);
    await del("user", "id", [operator, operator2]);
  }
});
