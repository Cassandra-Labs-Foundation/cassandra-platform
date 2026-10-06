// flow-runner: lane kri — shares instance state only with its lane (see scripts/flow.sh)
// People flows: the personnel facts HR declares and every control that hangs
// off them — hiring, CP-07 coaching, CP-12 training coverage, BA-08 capital
// training, EC-02 access grants with their quarterly review clock and
// breakglass visibility, the quarterly access review, and separation, which
// must revoke cash custody (CP-05) and deprovision access (IS-06) in the same
// act. Ports the user-observable behaviour of
// core/supabase/functions/api/hr.test.ts and the access half of
// core/supabase/functions/api/ops_security.test.ts (see ledger/hr.md and
// ledger/ops_security.md).
//
// SHARED-STATE DISCIPLINE. Every employee is run-unique and is separated before
// its flow ends (separation also deprovisions its access grants), so no fixture
// stays an active cash handler in the CP-12 denominator or a live grant in the
// access-review population. Two writes are instance-wide by nature:
//   * the CP-12 figure is only observable on the KRI publication, which is
//     computed over every active cash handler; the KRI is published under a
//     run-unique period, and the step asserts the figure equals the coverage
//     recomputed from the registers at that moment;
//   * POST /security/access-reviews attests EVERY live grant at once (that is
//     the control). It stamps reviewed_at on other flows' and the live tier's
//     grants exactly as a real quarterly review would; there is no scoped
//     variant. Assertions are on this flow's grants only.
import { actor, type Any, api, assert, assertEq, core, flow } from "./helpers.ts";
import { API } from "../contract/helpers.ts";

const RUN = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
let seq = 0;
const rid = (p: string) => `${p}_flow_${RUN}_${++seq}`;

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const DAY = 86_400_000;
const ms = (s: unknown) => Date.parse(String(s));

async function rowById(table: string, id: string): Promise<Any> {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data;
}

async function eventsFor(resourceType: string, id: string): Promise<Any[]> {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("resource_id", `${resourceType}:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  return r.data ?? [];
}
const codesFor = async (resourceType: string, id: string) =>
  (await eventsFor(resourceType, id)).map((e) => String(e.code));

async function grantsOf(userId: string): Promise<Any[]> {
  const r = await core().from("access_grant").select("*").eq("user_id", userId);
  assert(!r.error, `access_grant read: ${r.error?.message}`);
  return r.data ?? [];
}

/** CP-12 recomputed from the registers: trained active cash handlers / active cash handlers */
async function coverageNow(course = "cash_handling"): Promise<number | null> {
  const h = await core().from("employee").select("id").eq("cash_handler", true).eq("status", "active");
  assert(!h.error, `employee read: ${h.error?.message}`);
  const handlers = (h.data ?? []).map((e: Any) => String(e.id));
  if (handlers.length === 0) return null;
  const t = await core().from("training").select("assignee_id").eq("curriculum_id", course).eq("completion_status", "completed");
  assert(!t.error, `training read: ${t.error?.message}`);
  const trained = new Set((t.data ?? []).map((r: Any) => String(r.assignee_id)));
  return Math.round((handlers.filter((x) => trained.has(x)).length / handlers.length) * 1000) / 10;
}

/**
 * The access review updates every live grant one row at a time, and the live
 * population only grows (the live tier never deprovisions its grants): with
 * ~300 live grants it answered in ~33s, past the shared 30s client timeout.
 * The review is called with a longer timeout so the step proves what it
 * attests; its duration is reported, not asserted (see ledger/ops_security.md).
 */
async function slowPost(path: string, payload: unknown, key: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "X-Api-Key": key, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: Any = text;
  try { parsed = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, body: parsed, ms: Date.now() - t0 };
}

const hire = (key: string, o: Record<string, unknown>) => api("POST", "/hr/employees", o, { key });

// ============================================================ the employee lifecycle

flow("people: HR hires a teller → access provisioned with a quarterly review clock → custody granted → coached, trained, assigned capital training → separates: custody revoked and access deprovisioned in the same act", async (t) => {
  const hr = await actor("cu_admin");
  const partner = await actor("partner");
  const teller = rid("emp_teller");
  const peer = rid("emp_peer"); // a second cash handler, never trained
  const clerk = rid("emp_clerk"); // not a cash handler
  let consoleGrant = "";
  let breakglassGrant = "";
  let liveCustody = "";
  let rotatedCustody = "";
  const hired: string[] = [];

  try {
    await t.step("a partner cannot declare personnel or grant access, and nothing is written", async () => {
      const r = await hire(partner, { id: teller, name: "Fintech Fred", role: "teller" });
      assert(r.status === 403 || r.status === 404, `partner hire refused (${r.status} ${body(r)})`);
      assertEq(await rowById("employee", teller), null, "no employee");
      const g = await api("POST", "/security/access-grants", { user_id: teller, role: "teller_console" }, { key: partner });
      assert(g.status === 403 || g.status === 404, `partner grant refused (${g.status})`);
    });

    await t.step("an employee needs a name and a role — 400, nothing stored", async () => {
      const noRole = await hire(hr, { id: teller, name: "Pat Teller" });
      assertEq(noRole.status, 400, `no role (${body(noRole)})`);
      const noName = await hire(hr, { id: teller, role: "teller" });
      assertEq(noName.status, 400, `no name (${body(noName)})`);
      assertEq(await rowById("employee", teller), null, "nothing stored");
    });

    await t.step("HR hires a cash-handling teller, a second cash handler and a non-cash clerk: active, each hire an event", async () => {
      for (const [id, role, cash] of [[teller, "teller", true], [peer, "teller", true], [clerk, "clerk", false]] as const) {
        const r = await hire(hr, { id, name: `Flow ${id}`, role, cash_handler: cash });
        assertEq(r.status, 201, `hire ${id} (${body(r)})`);
        hired.push(id);
        const row = await rowById("employee", id);
        assertEq(row.status, "active", "active");
        assertEq(row.cash_handler, cash, "cash handler flag");
        assertEq(row.provenance, "demo", "demo evidence");
        assert((await codesFor("employee", id)).includes("employee.hired"), "hired event");
      }
    });

    await t.step("IS-06: access for someone HR never declared is 404", async () => {
      const r = await api("POST", "/security/access-grants", { user_id: rid("emp_never"), role: "teller_console" }, { key: hr });
      assertEq(r.status, 404, `undeclared user (${body(r)})`);
    });

    await t.step("EC-02: the teller gets console access and a breakglass DB grant — each with a 90-day review clock; breakglass is loudly visible", async () => {
      const c = await api("POST", "/security/access-grants", { user_id: teller, role: "teller_console" }, { key: hr });
      assertEq(c.status, 201, `console grant (${body(c)})`);
      consoleGrant = c.body.data.id;
      const b = await api("POST", "/security/access-grants", { user_id: teller, role: "prod_db", breakglass: true }, { key: hr });
      assertEq(b.status, 201, `breakglass grant (${body(b)})`);
      breakglassGrant = b.body.data.id;
      for (const id of [consoleGrant, breakglassGrant]) {
        const row = await rowById("access_grant", id);
        assertEq(row.user_id, teller, "grantee");
        assertEq(row.deprovisioned_at, null, "live");
        assert(Math.abs(ms(row.review_due_at) - ms(row.granted_at) - 90 * DAY) < 120_000, "quarterly review clock");
        const codes = await codesFor("access_grant", id);
        assert(codes.includes("access.role.granted") && codes.includes("access.provisioned"), "granted + provisioned events");
      }
      assertEq((await rowById("access_grant", breakglassGrant)).breakglass, true, "breakglass flag");
      assert((await codesFor("access_grant", breakglassGrant)).includes("access.breakglass.used"), "breakglass is an event the moment it is granted");
      assert(!(await codesFor("access_grant", consoleGrant)).includes("access.breakglass.used"), "an ordinary grant is not breakglass");
      assertEq((await rowById("user", teller))?.employment_status, "active", "the IAM projection follows HR");
    });

    await t.step("CP-05 fixture: the teller holds a live vault key and a combination that was already rotated out", async () => {
      const k = await api("POST", "/cash-ops/custody", { employee_id: teller, kind: "key", asset_id: rid("casset_vault") }, { key: hr });
      assertEq(k.status, 201, `key custody (${body(k)})`);
      liveCustody = k.body.data.id;
      const c = await api("POST", "/cash-ops/custody", { employee_id: teller, kind: "combination", asset_id: rid("casset_vault") }, { key: hr });
      assertEq(c.status, 201, `combination custody (${body(c)})`);
      rotatedCustody = c.body.data.id;
      // rotation has no API; the earlier revocation is applied by the service role
      const u = await core().from("cash_custody").update({ revoked_at: "2026-01-01T00:00:00.000Z", revoke_reason: "rotation" }).eq("id", rotatedCustody);
      assert(!u.error, `rotate fixture: ${u.error?.message}`);
    });

    await t.step("CP-07: coaching with no notes is a checkbox and is refused; an unknown employee is 404; with notes it is recorded", async () => {
      const blank = await api("POST", `/hr/employees/${teller}/coaching`, { cause_type: "over_short" }, { key: hr });
      assertEq(blank.status, 400, `no notes (${body(blank)})`);
      const ghost = await api("POST", `/hr/employees/${rid("emp_ghost")}/coaching`, { notes: "n" }, { key: hr });
      assertEq(ghost.status, 404, `unknown employee (${body(ghost)})`);
      const r = await api("POST", `/hr/employees/${teller}/coaching`, {
        cause_type: "over_short", cause_id: rid("os"), notes: "reviewed drawer procedure",
      }, { key: hr });
      assertEq(r.status, 201, `coaching (${body(r)})`);
      const row = await rowById("hr_action", r.body.data.id);
      assertEq(row.employee_id, teller, "employee");
      assertEq(row.kind, "coaching", "kind");
      assertEq(row.notes, "reviewed drawer procedure", "notes");
      assert((await codesFor("hr_action", r.body.data.id)).includes("hr.coaching.recorded"), "coaching event");
      const hist = await core().from("hr_action").select("id").eq("employee_id", teller);
      assertEq((hist.data ?? []).length, 1, "the refused coaching left no hr_action");
    });

    await t.step("training completion lands on the shared training table; an unknown employee cannot be trained into existence", async () => {
      const ghost = await api("POST", `/hr/employees/${rid("emp_ghost")}/training`, { course: "cash_handling" }, { key: hr });
      assertEq(ghost.status, 404, `ghost trainee (${body(ghost)})`);
      for (const id of [teller, clerk]) {
        const r = await api("POST", `/hr/employees/${id}/training`, { course: "cash_handling" }, { key: hr });
        assertEq(r.status, 201, `train ${id} (${body(r)})`);
        const row = await rowById("training", r.body.data.id);
        assertEq(row.assignee_id, id, "assignee");
        assertEq(row.completion_status, "completed", "completed");
        assert((await codesFor("training", r.body.data.id)).includes("training.completed"), "completion event");
      }
    });

    await t.step("CP-12: the KRI's training coverage is COMPUTED over active cash handlers — a caller-supplied figure is ignored", async () => {
      const period = `flow_${RUN}`;
      const r = await api("POST", "/cash-ops/kri", { period, "training.coverage_pct": 100, training_coverage_pct: 100 }, { key: hr });
      assertEq(r.status, 201, `KRI (${body(r)})`);
      const expected = await coverageNow();
      const pub = await rowById("event", `ev_cashkri_${period}_pub`);
      assertEq(pub?.code, "cash.kri.published", "published");
      const got = pub.payload["training.coverage_pct"];
      assert(typeof got === "number", `coverage is a number while cash handlers exist (got ${got})`);
      // the peer is an untrained active cash handler, so coverage cannot be 100
      assert(got < 100, `an untrained cash handler keeps coverage under 100 (got ${got})`);
      // concurrent hires/separations can move the institution-wide figure by a hair
      assert(Math.abs(got - (expected ?? -1)) <= 5, `coverage ${got} matches the registers (${expected})`);
    });

    await t.step("BA-08: a capital training assignment carries the annual clock, is a training row in 'assigned' status, and emits training.capital", async () => {
      const bad = await api("POST", "/hr/training-assignments", { curriculum: "capital" }, { key: hr });
      assertEq(bad.status, 400, `no assignee (${body(bad)})`);
      const ghost = await api("POST", "/hr/training-assignments", { curriculum: "capital", assignee_id: rid("emp_ghost") }, { key: hr });
      assertEq(ghost.status, 404, `unknown assignee (${body(ghost)})`);
      const r = await api("POST", "/hr/training-assignments", { curriculum: "capital", assignee_id: teller }, { key: hr });
      assertEq(r.status, 201, `assign (${body(r)})`);
      const asg = r.body.data;
      assert(Math.abs(ms(asg.annual_due_at) - Date.now() - 365 * DAY) < 5 * 60_000, "due in 365 days");
      const trn = await rowById("training", `trn_${teller}_capital`);
      assertEq(trn?.completion_status, "assigned", "assigned training row");
      const codes = await codesFor("training_assignment", asg.id);
      assert(codes.includes("training.assignment.created") && codes.includes("training.capital"), "assignment + training.capital events");
    });

    await t.step("CP-05 + IS-06: the teller separates — live custody revoked, the rotated one untouched, every grant deprovisioned, the IAM projection follows", async () => {
      const r = await api("POST", `/hr/employees/${teller}/separate`, { reason: "flow: resigned" }, { key: hr });
      assertEq(r.status, 200, `separate (${body(r)})`);
      assertEq(r.body.data.custodies_revoked, 1, "one live custody revoked");
      const emp = await rowById("employee", teller);
      assertEq(emp.status, "separated", "separated");
      assert(emp.separated_at, "separated_at");
      const live = await rowById("cash_custody", liveCustody);
      assert(live.revoked_at, "a separated employee still holding vault keys is the exposure");
      assertEq(live.revoke_reason, "employee_separated", "revoke reason");
      const rotated = await rowById("cash_custody", rotatedCustody);
      assertEq(rotated.revoke_reason, "rotation", "the earlier revocation is not rewritten");
      assertEq(ms(rotated.revoked_at), ms("2026-01-01T00:00:00.000Z"), "nor re-stamped");
      assert((await codesFor("cash_custody", liveCustody)).includes("cash.custody.revoked"), "revocation event");
      assert(!(await codesFor("cash_custody", rotatedCustody)).includes("cash.custody.revoked"), "no second revocation event");
      const codes = await codesFor("employee", teller);
      assert(codes.includes("employee.separated") && codes.includes("cash.coverage.updated"), "separated + coverage events");
      for (const g of await grantsOf(teller)) {
        assert(g.deprovisioned_at, `grant ${g.id} deprovisioned`);
        assert((await codesFor("access_grant", g.id)).includes("access.deprovisioned"), `grant ${g.id} deprovisioned event`);
      }
      assertEq((await rowById("user", teller))?.employment_status, "separated", "IAM projection separated");
    });

    await t.step("IS-06: no new access for the separated teller — 409, no grant written", async () => {
      const before = (await grantsOf(teller)).length;
      const r = await api("POST", "/security/access-grants", { user_id: teller, role: "teller_console" }, { key: hr });
      assertEq(r.status, 409, `grant to separated (${body(r)})`);
      assertEq(r.body.type, "access_to_separated_employee", "typed refusal");
      assertEq((await grantsOf(teller)).length, before, "no grant written");
    });
  } finally {
    for (const id of hired) {
      await api("POST", `/hr/employees/${id}/separate`, { reason: "flow: fixture cleanup" }, { key: hr }).catch(() => {});
    }
  }
});

// ============================================================ EC-02 review

flow("people: EC-02 — the CISO's quarterly access review attests every live grant, reviews unreviewed breakglass once, and a deprovisioned grant stays out", async (t) => {
  const ciso = await actor("cu_admin");
  const partner = await actor("partner");
  const eng = rid("emp_eng");
  let bg = "";
  let ro = "";
  let gone = "";

  try {
    await t.step("an engineer is hired with a breakglass grant, a read-only grant and a grant later revoked", async () => {
      const h = await hire(ciso, { id: eng, name: `Flow ${eng}`, role: "engineer" });
      assertEq(h.status, 201, `hire (${body(h)})`);
      const g = async (role: string, breakglass = false) => {
        const r = await api("POST", "/security/access-grants", { user_id: eng, role, breakglass }, { key: ciso });
        assertEq(r.status, 201, `grant ${role} (${body(r)})`);
        return String(r.body.data.id);
      };
      bg = await g("prod_db", true);
      ro = await g("reporting_ro");
      gone = await g("deploy");
    });

    await t.step("a grant is deprovisioned with a reason; a second deprovision replays; an unknown grant is 404", async () => {
      const r = await api("POST", `/security/access-grants/${gone}/deprovision`, { reason: "role change" }, { key: ciso });
      assertEq(r.status, 200, `deprovision (${body(r)})`);
      const row = await rowById("access_grant", gone);
      assert(row.deprovisioned_at, "deprovisioned");
      const again = await api("POST", `/security/access-grants/${gone}/deprovision`, {}, { key: ciso });
      assertEq(again.status, 200, `replay (${body(again)})`);
      assertEq(again.body.data.already, true, "reported as already deprovisioned");
      assertEq(ms((await rowById("access_grant", gone)).deprovisioned_at), ms(row.deprovisioned_at), "not re-stamped");
      const ev = (await eventsFor("access_grant", gone)).filter((e) => e.code === "access.deprovisioned");
      assertEq(ev.length, 1, "one deprovisioning event");
      assertEq(ev[0].payload.reason, "role change", "carries the reason");
      const ghost = await api("POST", `/security/access-grants/${rid("acc_ghost")}/deprovision`, {}, { key: ciso });
      assertEq(ghost.status, 404, `unknown grant (${body(ghost)})`);
    });

    await t.step("a partner cannot run the review; a review with no reviewer is refused", async () => {
      const p = await api("POST", "/security/access-reviews", { reviewer: "x" }, { key: partner });
      assert(p.status === 403 || p.status === 404, `partner review refused (${p.status})`);
      const r = await api("POST", "/security/access-reviews", {}, { key: ciso });
      assertEq(r.status, 400, `no reviewer (${body(r)})`);
      assertEq((await rowById("access_grant", bg)).reviewed_at, null, "nothing reviewed");
    });

    await t.step("the review attests every live grant — ours included, the deprovisioned one not — and reviews the breakglass exactly once", async () => {
      const reviewer = rid("ciso");
      const r = await slowPost("/security/access-reviews", { reviewer }, ciso);
      assertEq(r.status, 201, `review (${body(r)})`);
      console.log(`access review: ${r.body.data.grants_reviewed} live grants attested in ${r.ms}ms`);
      assert(r.body.data.grants_reviewed >= 2, `reviewed at least our two live grants (${r.body.data.grants_reviewed})`);
      const sr = await rowById("security_review", r.body.data.id);
      assertEq(sr.kind, "access", "access review row");
      assertEq(sr.reviewer, reviewer, "reviewer");
      assertEq(sr.findings, `${r.body.data.grants_reviewed} grants reviewed`, "findings state the count");
      assert((await rowById("access_grant", bg)).reviewed_at, "breakglass grant reviewed");
      assert((await rowById("access_grant", ro)).reviewed_at, "ordinary grant reviewed");
      assertEq((await rowById("access_grant", gone)).reviewed_at, null, "a deprovisioned grant is not attested");
      const bgRev = (await eventsFor("access_grant", bg)).filter((e) => e.code === "access.breakglass.reviewed");
      assertEq(bgRev.length, 1, "breakglass reviewed once");
      assertEq(bgRev[0].payload.reviewer, reviewer, "by this reviewer");
      assert(!(await codesFor("access_grant", ro)).includes("access.breakglass.reviewed"), "ordinary grant has no breakglass review");
      const codes = await codesFor("security_review", r.body.data.id);
      assert(codes.includes("access.review_attestation") && codes.includes("access_review.completed"), "attestation + completion events");
    });
  } finally {
    await api("POST", `/hr/employees/${eng}/separate`, { reason: "flow: fixture cleanup" }, { key: ciso }).catch(() => {});
  }
});
