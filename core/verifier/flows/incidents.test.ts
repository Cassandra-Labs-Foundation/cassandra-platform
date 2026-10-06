// Incident response: the SC-03 sitrep cadence an incident commander commits to
// at declaration, scaled to severity, and the EC-13 gates before anything goes
// out — the impact assessment must state the data scope AND the member impact,
// and external communications are refused without legal review and must be
// recorded verbatim.
//
// What is NOT here because another flow already proves it on the live core:
//   - the BC-05 IC-assignment clock, comms on the primary/backup channel,
//     media-needs-the-CEO, PIR and corrective actions → basel.test.ts
//     ("bcp: sev1 incident → …")
//   - determination → 72h NCUA clock → notification, the undetermined sweep,
//     and the empty-assessment refusal → deadlines.test.ts
//
// Every actor is a minted token. Incident ids are run-unique and the flow
// deletes its incidents at the end (the sweep's undetermined window is 200
// rows; every left-behind declaration pushes real ones out of it).
//
// Ported from core/supabase/functions/api/incidents.test.ts (see
// ledger/incidents.md).
import { actor, type Any, api, assert, assertEq, core, flow, uid } from "./helpers.ts";

const show = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const MIN = 60_000;

async function row(id: string): Promise<Any> {
  const r = await core().from("incident").select("*").eq("id", id).maybeSingle();
  assert(!r.error, `incident read: ${r.error?.message}`);
  return r.data;
}

async function events(id: string): Promise<Map<string, Any[]>> {
  const r = await core().from("event").select("id, code, payload").eq("resource_id", `incident:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  const m = new Map<string, Any[]>();
  for (const e of r.data ?? []) m.set(e.code, [...(m.get(e.code) ?? []), e]);
  return m;
}

async function declare(key: string, severity: string, created: string[]): Promise<string> {
  const id = `inc_flow_${uid()}`;
  const r = await api("POST", "/incidents",
    { id, title: `flow: ${severity} online banking degradation`, severity, source: "siem" }, { key });
  assertEq(r.status, 201, `declare ${severity} (${show(r)})`);
  created.push(id);
  return id;
}

async function cleanup(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const d = await core().from("incident").delete().in("id", ids);
  if (d.error) console.error(`cleanup incidents ${ids.join(",")}: ${d.error.message}`);
}

// ------------------------------------------------------------------ SC-03

flow("incidents: the IC declares a sev1 → v1 sitrep timer AND a recurring hourly cadence → a sev2/3/4 each get a slower cadence, strictly ordered", async (t) => {
  const ic = await actor("pynthia_ops");
  const created: string[] = [];
  const cadence: Record<string, number> = {};

  try {
    await t.step("SC-03: a sev1 declaration sets a RECURRING sitrep cadence of 60 minutes alongside the v1 timer", async () => {
      const id = await declare(ic, "sev1", created);
      const inc = await row(id);
      assertEq(inc.sitrep_cadence_minutes, 60, "sev1 cadence stored on the incident");
      const ev = await events(id);
      assert(ev.has("sitrep.v1_timer"), "v1 timer");
      const c = ev.get("sitrep.cadence_timer")?.[0];
      assert(c, "a cadence timer exists alongside v1 — one sitrep then silence is the failure");
      assertEq(c.payload.cadence_minutes, 60, "cadence in the evidence");
      assertEq(c.payload.severity, "sev1", "severity in the evidence");
      const gap = new Date(c.payload.next_due_at).getTime() - new Date(inc.declared_at).getTime();
      assert(Math.abs(gap - 60 * MIN) < MIN, `next sitrep due ~60m after declaration (got ${Math.round(gap / MIN)}m)`);
      cadence.sev1 = inc.sitrep_cadence_minutes;
    });

    await t.step("SC-03: the cadence scales with severity — sev1 < sev2 < sev3 < sev4, and the sev4 evidence carries its own", async () => {
      for (const sev of ["sev2", "sev3", "sev4"]) {
        const id = await declare(ic, sev, created);
        const inc = await row(id);
        const c = (await events(id)).get("sitrep.cadence_timer")?.[0];
        assert(c, `${sev} cadence timer`);
        assertEq(c.payload.cadence_minutes, inc.sitrep_cadence_minutes, `${sev}: evidence matches the row`);
        cadence[sev] = inc.sitrep_cadence_minutes;
      }
      assert(cadence.sev1 < cadence.sev2 && cadence.sev2 < cadence.sev3 && cadence.sev3 < cadence.sev4,
        `strictly slower as severity drops: ${JSON.stringify(cadence)}`);
      assertEq(cadence.sev4, 480, "sev4 reports every eight hours");
    });

    await t.step("a declaration with an unknown severity is refused — there is no cadence for it", async () => {
      const id = `inc_flow_${uid()}`;
      const r = await api("POST", "/incidents", { id, title: "flow: bad sev", severity: "sev9" }, { key: ic });
      assertEq(r.status, 400, `sev9 (${show(r)})`);
      assertEq(await row(id), null, "nothing declared");
    });
  } finally {
    await cleanup(created);
  }
});

// ------------------------------------------------------------------ EC-13

flow("incidents: sev1 data exposure → an assessment missing scope or impact is refused → the full assessment is recorded → a holding statement without legal review is refused → reviewed, it goes out verbatim → a later update keeps the reviewer", async (t) => {
  const ic = await actor("pynthia_ops");
  const partner = await actor("partner");
  const created: string[] = [];
  let id = "";

  try {
    await t.step("the IC declares a sev1", async () => {
      id = await declare(ic, "sev1", created);
      assertEq((await row(id)).assessment_completed_at, null, "not yet assessed");
    });

    await t.step("a partner cannot assess or speak for the incident (403 at the actor gate)", async () => {
      const a = await api("POST", `/incidents/${id}/assessment`, { data_scope: { members: 1 }, member_impact: "x" }, { key: partner });
      assertEq(a.status, 403, `partner assessment (${show(a)})`);
      const c = await api("POST", `/incidents/${id}/external-comms`, { holding_statement: "x", legal_reviewed_by: "y" }, { key: partner });
      assertEq(c.status, 403, `partner comms (${show(c)})`);
      const inc = await row(id);
      assertEq(inc.assessment_completed_at, null, "not assessed");
      assertEq(inc.external_comms_at, null, "nothing went out");
    });

    await t.step("an assessment or comms for an incident nobody declared is 404", async () => {
      const ghost = `inc_flow_${uid()}_ghost`;
      const a = await api("POST", `/incidents/${ghost}/assessment`, { data_scope: { members: 1 }, member_impact: "x" }, { key: ic });
      assertEq(a.status, 404, `ghost assessment (${show(a)})`);
      const c = await api("POST", `/incidents/${ghost}/external-comms`, { holding_statement: "x", legal_reviewed_by: "y" }, { key: ic });
      assertEq(c.status, 404, `ghost comms (${show(c)})`);
      assertEq((await events(ghost)).size, 0, "no evidence against a nonexistent incident");
    });

    await t.step("EC-13: an assessment with NO DATA SCOPE is refused — a status update wearing the word", async () => {
      const r = await api("POST", `/incidents/${id}/assessment`, { member_impact: "some members affected" }, { key: ic });
      assertEq(r.status, 400, `no data scope (${show(r)})`);
      assertEq((await row(id)).assessment_completed_at, null, "not assessed");
    });

    await t.step("EC-13: an assessment with NO MEMBER IMPACT is refused", async () => {
      const r = await api("POST", `/incidents/${id}/assessment`, { data_scope: { members: 1400 } }, { key: ic });
      assertEq(r.status, 400, `no member impact (${show(r)})`);
      const inc = await row(id);
      assertEq(inc.assessment_completed_at, null, "not assessed");
      assert(!(await events(id)).has("incident.assessment.completed"), "no assessment event");
    });

    await t.step("EC-13: the complete assessment records scope, impact and facts, under both event names", async () => {
      const r = await api("POST", `/incidents/${id}/assessment`, {
        data_scope: { members: 1400, fields: ["account_number"] },
        member_impact: "1,400 members' account numbers exposed",
        facts: { vector: "credential stuffing" }, detection_source: "siem",
      }, { key: ic });
      assertEq(r.status, 200, `assess (${show(r)})`);
      const inc = await row(id);
      assert(inc.assessment_completed_at, "assessment_completed_at");
      // data_scope and facts are TEXT columns on core.incident: the JSON is kept as its serialization
      const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v) as Any;
      assertEq(json(inc.data_scope)?.members, 1400, "data scope stored");
      assertEq(inc.member_impact, "1,400 members' account numbers exposed", "member impact stored");
      assertEq(json(inc.facts)?.vector, "credential stuffing", "facts stored");
      const ev = await events(id);
      const a = ev.get("incident.assessment.completed")?.[0];
      assert(a, "incident.assessment.completed");
      assertEq(a.payload["incident.data_scope"]?.members, 1400, "scope in the evidence");
      assert(ev.has("incident.reportability_assessment"), "the corpus name is emitted too (BLUEPRINT §5j)");
    });

    await t.step("EC-13: external comms with NO legal review is refused (409) — nothing goes out, nothing recorded", async () => {
      const r = await api("POST", `/incidents/${id}/external-comms`, { holding_statement: "we are investigating" }, { key: ic });
      assertEq(r.status, 409, `unreviewed comms (${show(r)})`);
      assertEq(r.body.type, "legal_review_required", "typed refusal");
      const inc = await row(id);
      assertEq(inc.external_comms_at, null, "nothing went out");
      assertEq(inc.legal_review_at, null, "no review invented");
      assert(!(await events(id)).has("incident.external_comms.recorded"), "no comms event");
    });

    await t.step("EC-13: reviewed comms with no recorded statement are refused (400) — what went out must be verbatim", async () => {
      const r = await api("POST", `/incidents/${id}/external-comms`, { legal_reviewed_by: "counsel_flow" }, { key: ic });
      assertEq(r.status, 400, `no statement (${show(r)})`);
      assertEq(r.body.errors?.[0]?.field, "holding_statement", "names the statement");
      const inc = await row(id);
      assertEq(inc.external_comms_at, null, "nothing went out");
      assertEq(inc.legal_review_at, null, "a refused request records no review");
    });

    await t.step("EC-13: reviewed comms go out with the statement verbatim, the reviewer and the plan", async () => {
      const statement = "We are investigating an incident affecting online banking.";
      const r = await api("POST", `/incidents/${id}/external-comms`,
        { holding_statement: statement, legal_reviewed_by: "counsel_flow", comms_plan: { channels: ["website"] } }, { key: ic });
      assertEq(r.status, 200, `comms (${show(r)})`);
      const inc = await row(id);
      assert(inc.external_comms_at, "external_comms_at");
      assert(inc.legal_review_at, "legal_review_at");
      assertEq(inc.legal_review_by, "counsel_flow", "reviewer recorded");
      assertEq(inc.comms_holding_statement, statement, "statement verbatim");
      assertEq(inc.comms_plan?.channels?.[0], "website", "plan recorded");
      const e = (await events(id)).get("incident.external_comms.recorded")?.[0];
      assert(e, "incident.external_comms.recorded");
      assertEq(e.payload["comms.holding_statement"], statement, "statement in the evidence");
      assertEq(e.payload["incident.legal_review"], "counsel_flow", "reviewer in the evidence");
    });

    await t.step("an updated statement after the review goes out without re-naming counsel, and the original reviewer is kept", async () => {
      const before = await row(id);
      const statement = "Online banking is restored; affected members will be contacted.";
      const r = await api("POST", `/incidents/${id}/external-comms`, { holding_statement: statement }, { key: ic });
      assertEq(r.status, 200, `follow-up comms (${show(r)})`);
      const inc = await row(id);
      assertEq(inc.comms_holding_statement, statement, "latest statement recorded");
      assertEq(inc.legal_review_by, "counsel_flow", "reviewer not erased");
      assertEq(inc.legal_review_at, before.legal_review_at, "review time not rewritten");
    });

    await t.step("BOTH statements that went out are evidenced verbatim — the follow-up does not erase the first", async () => {
      const said = ((await events(id)).get("incident.external_comms.recorded") ?? [])
        .map((e) => e.payload["comms.holding_statement"]);
      assert(said.includes("We are investigating an incident affecting online banking."), "first statement evidenced");
      // Regression guard (fixed 2026-10-06): postExternalComms emitted under a fixed id with ignoreDuplicates, so a second statement left no event. Each statement now gets its own event; the row keeps the latest
      assert(said.includes("Online banking is restored; affected members will be contacted."),
        `follow-up statement evidenced (events hold: ${JSON.stringify(said)})`);
    });
  } finally {
    await cleanup(created);
  }
});
