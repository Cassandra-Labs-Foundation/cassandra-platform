// Internal audit (AU-03 … AU-10): the annual plan is submitted by one person
// and approved by a DIFFERENT one, the engagement starts only once the plan is
// approved and the auditor's independence is attested, the report issues only
// after fieldwork, issuing it OPENS the findings, management's response starts
// the 90-day remediation clock, and a finding closes only on a passed retest or
// an accepted risk with a written rationale. The sweep escalates findings whose
// remediation date passed unclosed.
//
// Every actor is a minted token, and segregation of duties is tested with two
// genuinely different ones. Engagement ids derive from (year, scope), so every
// flow uses a run-unique scope. Aged findings are closed before the flow ends,
// so the instance's aging queue is left as the flow found it.
//
// Ported from core/supabase/functions/api/audit.test.ts (see ledger/audit.md).
import { actor, type Any, api, assert, assertEq, core, flow, uid } from "./helpers.ts";

const show = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const DAY = 86_400_000;

function tokenIdOf(plaintext: string, actorType: string): string {
  return `tok_test_${actorType}_${plaintext.slice("cass_test_".length, "cass_test_".length + 12)}`;
}

async function row(table: string, id: string): Promise<Any> {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data;
}

/** event codes recorded against `<type>:<id>` */
async function codes(type: string, id: string): Promise<string[]> {
  const r = await core().from("event").select("code").eq("resource_id", `${type}:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  return (r.data ?? []).map((e: Any) => String(e.code));
}

/** a run-unique engagement scope; the id is aeng_<year>_<slug of scope> */
function freshScope(label: string): { scope: string; id: string } {
  const scope = `${uid()} ${label}`;
  return { scope, id: `aeng_2026_${scope.replace(/\W+/g, "_").slice(0, 24)}` };
}

// ---------------------------------------------------------------- the cycle

flow("audit: plan submitted → a DIFFERENT approver → independence attested → fieldwork → report opens findings → response starts 90 days → failed retest re-communicates → passed retest closes; accepted risk needs a rationale", async (t) => {
  const submitter = await actor("cu_admin");
  const approver = await actor("pynthia_ops");
  const partner = await actor("partner");
  const { scope, id } = freshScope("cash operations");
  let findings: string[] = [];

  await t.step("a partner cannot open an audit plan (403 at the actor gate); nothing is stored", async () => {
    const r = await api("POST", "/audit/engagements",
      { plan_cycle_year: 2026, scope, auditor_ref: "aud_flow" }, { key: partner });
    // the route's actor gate refuses before the handler's own 404 is reached
    assertEq(r.status, 403, `partner submit (${show(r)})`);
    assertEq(r.body.type, "insufficient_scope", "actor gate");
    assertEq(await row("audit_engagement", id), null, "no engagement for a partner");
  });

  await t.step("a plan with no scope or auditor is refused", async () => {
    const r = await api("POST", "/audit/engagements", { plan_cycle_year: 2026 }, { key: submitter });
    assertEq(r.status, 400, `incomplete plan (${show(r)})`);
  });

  await t.step("AU-04: submitting the plan opens the cycle and SCHEDULES the assessment, attributed to the submitter", async () => {
    const r = await api("POST", "/audit/engagements",
      { plan_cycle_year: 2026, scope, auditor_ref: "aud_flow" }, { key: submitter });
    assertEq(r.status, 201, `submit (${show(r)})`);
    assertEq(r.body.id, id, "engagement id from (year, scope)");
    const e = await row("audit_engagement", id);
    assertEq(e.status, "plan_submitted", "status");
    assertEq(e.plan_submitted_by, tokenIdOf(submitter, "cu_admin"), "submitter recorded from the token");
    assertEq(e.provenance, "demo", "test-token evidence is stamped demo");
    const c = await codes("audit_engagement", id);
    for (const code of ["audit.plan_cycle.opened", "audit.annual_plan.submitted", "audit.assessment.scheduled"]) {
      assert(c.includes(code), `${code} emitted (got ${c.join(",")})`);
    }
  });

  await t.step("AU-03/AU-04: the engagement cannot start before the plan is approved, attested or not", async () => {
    const r = await api("POST", `/audit/engagements/${id}/start`, { independence_attested: true }, { key: submitter });
    assertEq(r.status, 409, `start before approval (${show(r)})`);
    assertEq(r.body.type, "plan_not_approved", "typed refusal");
    assertEq((await row("audit_engagement", id)).started_at, null, "not started");
  });

  await t.step("AU-04: the plan's submitter cannot also approve it — 409, nothing approved", async () => {
    const r = await api("POST", `/audit/engagements/${id}/approve-plan`, {}, { key: submitter });
    assertEq(r.status, 409, `self-approval (${show(r)})`);
    assertEq(r.body.type, "four_eyes_violation", "typed refusal");
    const e = await row("audit_engagement", id);
    assertEq(e.plan_approved_at, null, "not approved");
    assertEq(e.status, "plan_submitted", "still submitted");
    assert(!(await codes("audit_engagement", id)).includes("audit.annual_plan.approved"), "no approval event");
  });

  await t.step("AU-04: a different actor approves; the record names both", async () => {
    const r = await api("POST", `/audit/engagements/${id}/approve-plan`, {}, { key: approver });
    assertEq(r.status, 200, `approve (${show(r)})`);
    const e = await row("audit_engagement", id);
    assertEq(e.status, "plan_approved", "approved");
    assertEq(e.plan_approved_by, tokenIdOf(approver, "pynthia_ops"), "approver recorded");
    assert(e.plan_approved_by !== e.plan_submitted_by, "approver is not the submitter");
    const c = await codes("audit_engagement", id);
    assert(c.includes("audit.annual_plan.approved"), "approval event");
    assert(c.includes("audit.schedule_finalized"), "schedule finalized");
  });

  await t.step("AU-03: without an independence attestation the engagement does not start (400)", async () => {
    const r = await api("POST", `/audit/engagements/${id}/start`, {}, { key: submitter });
    assertEq(r.status, 400, `unattested start (${show(r)})`);
    assertEq(r.body.errors?.[0]?.field, "independence_attested", "names the field");
    assertEq((await row("audit_engagement", id)).started_at, null, "not started");
  });

  await t.step("AU-03: attested, it starts — and starting is what grants the auditor access", async () => {
    const r = await api("POST", `/audit/engagements/${id}/start`, { independence_attested: true }, { key: submitter });
    assertEq(r.status, 200, `start (${show(r)})`);
    const e = await row("audit_engagement", id);
    assertEq(e.status, "in_progress", "in progress");
    assert(e.started_at, "started_at");
    assertEq(e.independence_attested_by, tokenIdOf(submitter, "cu_admin"), "attester recorded");
    const c = await codes("audit_engagement", id);
    assert(c.includes("audit.engagement.started"), "started event");
    assert(c.includes("auditor.access_grant"), "access granted by the start");
  });

  await t.step("AU-06: a report cannot issue before fieldwork completes — no findings are opened", async () => {
    const r = await api("POST", `/audit/engagements/${id}/issue-report`,
      { findings: [{ severity: "high", summary: "x" }] }, { key: submitter });
    assertEq(r.status, 409, `early report (${show(r)})`);
    assertEq(r.body.type, "fieldwork_incomplete", "typed refusal");
    const f = await core().from("audit_finding").select("id").eq("engagement_id", id);
    assertEq((f.data ?? []).length, 0, "no findings from an unissued report");
    assertEq((await row("audit_engagement", id)).report_issued_at, null, "not issued");
  });

  await t.step("fieldwork completes with a rating (an unknown rating is refused); the report is drafted", async () => {
    const bad = await api("POST", `/audit/engagements/${id}/complete-fieldwork`, { rating: "fine" }, { key: submitter });
    assertEq(bad.status, 400, `bad rating (${show(bad)})`);
    const r = await api("POST", `/audit/engagements/${id}/complete-fieldwork`, { rating: "needs_improvement" }, { key: submitter });
    assertEq(r.status, 200, `fieldwork (${show(r)})`);
    const e = await row("audit_engagement", id);
    assertEq(e.rating, "needs_improvement", "rating");
    assert(e.fieldwork_completed_at && e.report_drafted_at, "fieldwork + draft stamped");
    const c = await codes("audit_engagement", id);
    assert(c.includes("audit.fieldwork.completed") && c.includes("audit.report.drafted"), "fieldwork events");
    assert(!c.includes("audit.frequency_increased"), "only a POOR rating raises frequency");
  });

  await t.step("AU-06/AU-10: issuing OPENS the findings, delivers to the board and starts the 7-year retention clock", async () => {
    const r = await api("POST", `/audit/engagements/${id}/issue-report`, {
      findings: [{ severity: "high", summary: "vault dual control not evidenced" },
        { severity: "critical", summary: "teller over-limit not escalated" }],
    }, { key: submitter });
    assertEq(r.status, 200, `issue (${show(r)})`);
    assertEq(r.body.findings_opened, 2, "two findings opened");
    const e = await row("audit_engagement", id);
    assertEq(e.status, "reported", "reported");
    const issued = new Date(e.report_issued_at);
    const ret = new Date(e.retention_expires_at);
    assertEq(ret.getUTCFullYear() - issued.getUTCFullYear(), 7, "retention = issuance + 7 years");
    assertEq(ret.getUTCMonth(), issued.getUTCMonth(), "same month");
    const f = await core().from("audit_finding").select("*").eq("engagement_id", id).order("id");
    assert(!f.error, `findings read: ${f.error?.message}`);
    assertEq((f.data ?? []).length, 2, "two finding rows");
    findings = (f.data ?? []).map((x: Any) => String(x.id));
    for (const x of f.data ?? []) {
      assert(x.opened_at && x.communicated_at, `${x.id} opened + communicated`);
      assertEq(x.closed_at, null, `${x.id} open`);
      const fc = await codes("audit_finding", x.id);
      assert(fc.includes("finding.opened"), `${x.id}: finding.opened is a consequence of issuance`);
      assert(fc.includes("finding.communicated"), `${x.id}: communicated`);
    }
    const c = await codes("audit_engagement", id);
    for (const code of ["audit.report.issued", "audit.results_delivered_to_board", "audit.retention.applied"]) {
      assert(c.includes(code), `${code} emitted`);
    }
  });

  await t.step("AU-08: a response with no text is refused; with text it starts the 90-day remediation clock", async () => {
    const fid = findings[0];
    const empty = await api("POST", `/audit/findings/${fid}/respond`, {}, { key: submitter });
    assertEq(empty.status, 400, `empty response (${show(empty)})`);
    assertEq((await row("audit_finding", fid)).remediation_due_at, null, "no clock from a checkbox");
    const r = await api("POST", `/audit/findings/${fid}/respond`, { response: "dual-control log in place by Q4" }, { key: submitter });
    assertEq(r.status, 200, `respond (${show(r)})`);
    const f = await row("audit_finding", fid);
    assertEq(f.management_response, "dual-control log in place by Q4", "response verbatim");
    const days = (new Date(f.remediation_due_at).getTime() - new Date(f.management_response_at).getTime()) / DAY;
    assertEq(Math.round(days), 90, "90 days from the response");
    assert((await codes("audit_finding", fid)).includes("audit.remediation.timer"), "remediation timer event");
  });

  await t.step("AU-09: a FAILED retest does not close the finding — it goes back to management", async () => {
    const fid = findings[0];
    const r = await api("POST", `/audit/findings/${fid}/close`, { retest_result: "failed" }, { key: approver });
    assertEq(r.status, 200, `failed retest (${show(r)})`);
    assertEq(r.body.closed, false, "not closed");
    const f = await row("audit_finding", fid);
    assertEq(f.closed_at, null, "closed_at stays null");
    assertEq(f.retest_result, "failed", "retest recorded");
    const c = await codes("audit_finding", fid);
    assert(!c.includes("finding.closed"), "no closure event");
    assert(c.includes("deficiency.retest_result"), "retest evidenced");
    assert(c.includes("finding.implementation_date"), "a new implementation date is required");
    const comm = await core().from("event").select("id").eq("resource_id", `audit_finding:${fid}`).eq("code", "finding.communicated");
    assert((comm.data ?? []).length >= 2, "re-communicated on top of the original communication");
  });

  await t.step("AU-09: a PASSED retest closes it, verified by the closer", async () => {
    const fid = findings[0];
    const r = await api("POST", `/audit/findings/${fid}/close`, { retest_result: "passed" }, { key: approver });
    assertEq(r.status, 200, `passed retest (${show(r)})`);
    assertEq(r.body.closed, true, "closed");
    const f = await row("audit_finding", fid);
    assert(f.closed_at, "closed_at");
    assertEq(f.closure_verified_by, tokenIdOf(approver, "pynthia_ops"), "verifier recorded");
    assert((await codes("audit_finding", fid)).includes("finding.closed"), "closure event");
  });

  await t.step("AU-08: accepting a risk with no rationale is refused; with one it closes the finding", async () => {
    const fid = findings[1];
    const bare = await api("POST", `/audit/findings/${fid}/close`, { risk_acceptance: "accepted" }, { key: approver });
    assertEq(bare.status, 400, `bare acceptance (${show(bare)})`);
    assertEq(bare.body.errors?.[0]?.field, "rationale", "names the rationale");
    let f = await row("audit_finding", fid);
    assertEq(f.closed_at, null, "still open");
    assertEq(f.risk_acceptance_decision, null, "no decision recorded");
    const r = await api("POST", `/audit/findings/${fid}/close`,
      { risk_acceptance: "accepted", rationale: "compensating daily review; cost exceeds exposure" }, { key: approver });
    assertEq(r.status, 200, `accept (${show(r)})`);
    f = await row("audit_finding", fid);
    assert(f.closed_at, "closed");
    assertEq(f.risk_acceptance_decision, "accepted", "decision");
    assertEq(f.risk_acceptance_rationale, "compensating daily review; cost exceeds exposure", "rationale verbatim");
    const c = await codes("audit_finding", fid);
    assert(c.includes("finding.risk_acceptance.decided") && c.includes("finding.closed"), "decision + closure events");
  });
});

// ------------------------------------------------------------------ AU-07

flow("audit: a poor-rated engagement → findings answered → one remediation date passes unclosed → the sweep escalates it (critical goes further) and leaves the current one alone", async (t) => {
  const lead = await actor("pynthia_ops");
  const approver = await actor("cu_admin");
  const partner = await actor("partner");
  const { scope, id } = freshScope("lending ops");
  let aged = "", fresh = "";

  try {
    await t.step("an engagement runs to a POOR rating: the next cycle's frequency increases as a consequence", async () => {
      assertEq((await api("POST", "/audit/engagements", { plan_cycle_year: 2026, scope, auditor_ref: "aud_flow" }, { key: lead })).status, 201, "submit");
      assertEq((await api("POST", `/audit/engagements/${id}/approve-plan`, {}, { key: approver })).status, 200, "approve");
      assertEq((await api("POST", `/audit/engagements/${id}/start`, { independence_attested: true }, { key: lead })).status, 200, "start");
      const r = await api("POST", `/audit/engagements/${id}/complete-fieldwork`, { rating: "poor" }, { key: lead });
      assertEq(r.status, 200, `fieldwork (${show(r)})`);
      const c = await codes("audit_engagement", id);
      assert(c.includes("audit.poor_rating.recorded") && c.includes("audit.frequency_increased"), "poor rating → frequency increased");
    });

    await t.step("the report opens a critical and a low finding; management responds to both", async () => {
      const r = await api("POST", `/audit/engagements/${id}/issue-report`, {
        findings: [{ severity: "critical", summary: "loan file exceptions untracked" }, { severity: "low", summary: "stale procedure doc" }],
      }, { key: lead });
      assertEq(r.status, 200, `issue (${show(r)})`);
      aged = `afind_${id}_0`;
      fresh = `afind_${id}_1`;
      for (const fid of [aged, fresh]) {
        assertEq((await api("POST", `/audit/findings/${fid}/respond`, { response: "remediating" }, { key: lead })).status, 200, `respond ${fid}`);
      }
    });

    await t.step("clock simulation: the critical finding's 90-day remediation date is moved into the past", async () => {
      // The API has no way to move time; this is a service-role update to the
      // flow's own finding only.
      const u = await core().from("audit_finding").update({ remediation_due_at: new Date(Date.now() - 5 * DAY).toISOString() }).eq("id", aged);
      assert(!u.error, `backdate: ${u.error?.message}`);
    });

    await t.step("a partner cannot run the audit sweep", async () => {
      const r = await api("POST", "/audit/sweep", {}, { key: partner });
      assertEq(r.status, 403, `partner sweep (${show(r)})`);
      assert(!(await codes("audit_finding", aged)).includes("finding.aging_threshold.breached"), "a refused sweep escalates nothing");
    });

    await t.step("AU-07: the sweep escalates the aged finding — critical goes further — and the current one is untouched", async () => {
      const r = await api("POST", "/audit/sweep", {}, { key: lead });
      assertEq(r.status, 200, `sweep (${show(r)})`);
      assert(r.body.aged_findings >= 1, "at least our aged finding counted");
      assert(r.body.critical >= 1, "at least our critical counted");
      const c = await codes("audit_finding", aged);
      for (const code of ["finding.aging_threshold.breached", "finding.escalated", "finding.critical.escalated"]) {
        assert(c.includes(code), `${code} on the aged finding (got ${c.join(",")})`);
      }
      const fc = await codes("audit_finding", fresh);
      assert(!fc.includes("finding.aging_threshold.breached") && !fc.includes("finding.escalated"), "the not-yet-due finding is not escalated");
      const month = new Date().toISOString().slice(0, 7);
      assertEq((await row("event", `evt_audit_monthly_${month}`))?.code, "finding.monthly_review.recorded", "the monthly review exists for this month");
    });
  } finally {
    // leave no aged finding in the institution's queue
    for (const fid of [aged, fresh].filter(Boolean)) {
      const f = await row("audit_finding", fid);
      if (f && !f.closed_at) {
        const r = await api("POST", `/audit/findings/${fid}/close`, { retest_result: "passed" }, { key: approver });
        if (r.status !== 200) console.error(`cleanup close ${fid}: ${r.status} ${show(r)}`);
      }
    }
  }
});
