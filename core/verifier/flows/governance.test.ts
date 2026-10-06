// Governance calendar flows: the institution's recurring obligations (board
// reviews, independent testing, annual training) as one register. Staff
// register an obligation against a policy-qualified control, the calendar sweep
// fires the catalogue's own trigger when it comes due and names what is
// overdue, and completion advances the cycle from the DUE date. The two
// absences are kept apart: OVERDUE (came due, nobody did it) and UNSCHEDULED
// (nobody said when the cycle starts). Replaces the stubbed unit tests in
// core/supabase/functions/api/governance.test.ts (see ledger/governance.md).
//
// SHARED-STATE DISCIPLINE. The register and the sweep are instance-wide. Every
// obligation here hangs off a run-unique control_uid (`flowtest:GOV-<run>`)
// with a `flowtest.*` trigger code, so the events the sweep fires for it can
// never count as evidence for a real control. Assertions read only this run's
// rows; the obligations and their completion log are deleted at the end of the
// flow (events are evidence and stay). The sweep also re-fires the 69 real
// obligations, but their due events already exist and are deduplicated by id.
import { actor, type Any, api, assert, assertEq, core, flow } from "./helpers.ts";

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const run = () => crypto.randomUUID().slice(0, 8);

async function obligationRow(id: string) {
  const r = await core().from("obligation").select("*").eq("id", id).maybeSingle();
  assert(!r.error, `obligation read: ${r.error?.message}`);
  return r.data as Any;
}

async function completions(id: string): Promise<Any[]> {
  const r = await core().from("obligation_completion").select("*").eq("obligation_id", id);
  assert(!r.error, `obligation_completion read: ${r.error?.message}`);
  return r.data ?? [];
}

async function obligationEvents(id: string): Promise<Any[]> {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("resource_id", `obligation:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  return r.data ?? [];
}

const oblId = (controlUid: string, trigger: string) => `oblig_${controlUid.replace(/:/g, "_")}_${trigger}`;

async function cleanup(ids: string[]) {
  if (!ids.length) return;
  const c = await core().from("obligation_completion").delete().in("obligation_id", ids);
  if (c.error) console.error(`cleanup obligation_completion: ${c.error.message}`);
  const o = await core().from("obligation").delete().in("id", ids);
  if (o.error) console.error(`cleanup obligation ${ids.join(",")}: ${o.error.message}`);
}

const day = (iso: string | null) => (iso ?? "").slice(0, 10);

// ------------------------------------------- anchored → due → overdue → done

flow("governance: staff register a quarterly obligation → the sweep fires its own trigger and names it overdue → completion is attributed, logged late, and advances from the DUE date", async (t) => {
  const staff = await actor("cu_admin");
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  const r = run();
  const control = `flowtest:GOV-${r}`;
  const trigger = `flowtest.review_cycle.opened`;
  const id = oblId(control, trigger);
  const created = [id];
  const register = (key: string, o: Record<string, unknown>) =>
    api("POST", "/governance/obligations", {
      control_uid: control, trigger_code: trigger, title: "Flow quarterly review",
      cadence: "quarterly", ...o,
    }, { key });
  try {
    await t.step("a partner can neither see nor touch the calendar (403 on all four routes) and nothing is written", async () => {
      const calls = [
        await register(partner, { anchor_date: "2025-01-01" }),
        await api("GET", "/governance/obligations", undefined, { key: partner }),
        await api("POST", `/governance/obligations/${id}/complete`, { completed_by: "p" }, { key: partner }),
        await api("POST", "/governance/calendar/sweep", {}, { key: partner }),
      ];
      for (const c of calls) assertEq(c.status, 403, `partner (${body(c)})`);
      assertEq(await obligationRow(id), null, "no obligation row");
    });

    await t.step("a bare control_id is refused as ambiguous; an unknown cadence and a malformed anchor are refused, not defaulted", async () => {
      const bare = await api("POST", "/governance/obligations",
        { control_uid: `GOV-${r}`, trigger_code: trigger, title: "t", cadence: "annual" }, { key: staff });
      assertEq(bare.status, 400, `bare control_id (${body(bare)})`);
      assert(JSON.stringify(bare.body).includes("ambiguous"), "the refusal says why");
      assertEq(await obligationRow(oblId(`GOV-${r}`, trigger)), null, "no row for the bare id");
      const cad = await register(staff, { cadence: "fortnightly" });
      assertEq(cad.status, 400, `fortnightly (${body(cad)})`);
      assert(JSON.stringify(cad.body).includes("cadence"), "cadence named");
      const anc = await register(staff, { anchor_date: "01/01/2025" });
      assertEq(anc.status, 400, `bad anchor (${body(anc)})`);
      assert(JSON.stringify(anc.body).includes("anchor_date"), "anchor_date named");
      assertEq(await obligationRow(id), null, "nothing registered");
    });

    await t.step("staff register it anchored 2025-01-01: the anchor IS the first due date, scheduled, labelled demo", async () => {
      const res = await register(staff, { anchor_date: "2025-01-01", owner_role: "cco" });
      assertEq(res.status, 201, `register (${body(res)})`);
      assertEq(res.body.id, id, "deterministic id from control + trigger");
      assertEq(res.body.scheduled, true, "scheduled");
      assertEq(res.body.warning, undefined, "no warning when anchored");
      assertEq(day(res.body.next_due_at), "2025-01-01", "first due = anchor, not anchor + 1 quarter");
      const row = await obligationRow(id);
      assertEq(day(row.next_due_at), "2025-01-01", "stored due date");
      assertEq(row.anchor_date, "2025-01-01", "anchor stored");
      assertEq(row.owner_role, "cco", "owner role stored");
      assertEq(row.last_completed_at, null, "never completed");
      assertEq(row.provenance, "demo", "test-actor evidence labelled demo");
    });

    await t.step("the register lists it, counted as scheduled", async () => {
      const res = await api("GET", "/governance/obligations", undefined, { key: ops });
      assertEq(res.status, 200, `list (${body(res)})`);
      const mine = (res.body.obligations as Any[]).find((o) => o.id === id);
      assert(mine, "our obligation is in the register");
      assertEq(mine.cadence, "quarterly", "cadence");
      assertEq(res.body.scheduled + res.body.unscheduled, res.body.total, "scheduled + unscheduled = total");
    });

    await t.step("the sweep fires the CATALOGUE's trigger code (not a generic 'due') and names it OVERDUE with days late", async () => {
      const res = await api("POST", "/governance/calendar/sweep", {}, { key: staff });
      assertEq(res.status, 200, `sweep (${body(res)})`);
      const fired = (res.body.fired as Any[]).find((f) => f.id === id);
      assertEq(fired?.trigger_code, trigger, "fired under its own trigger");
      const over = (res.body.overdue as Any[]).find((o) => o.id === id);
      assert(over, "reported overdue");
      assert(over.days_late > 300, `days_late ${over.days_late} counts from 2025-01-01`);
      assert(!(res.body.unscheduled as Any[]).some((u) => u.id === id), "an anchored obligation is never 'unscheduled'");
      const ev = await obligationEvents(id);
      const due = ev.find((e) => e.id === `evt_${id}_2025-01-01_due`);
      assertEq(due?.code, trigger, "due event carries the declared trigger");
      assertEq(due?.payload.control_uid, control, "and names the control");
      assertEq(due?.provenance, "demo", "labelled demo");
      const od = ev.find((e) => e.id === `evt_${id}_2025-01-01_overdue`);
      assertEq(od?.code, "governance.obligation.overdue", "overdue is its own event");
    });

    await t.step("re-sweeping does not pile up: one due event and one overdue event per due date", async () => {
      const res = await api("POST", "/governance/calendar/sweep", {}, { key: ops });
      assertEq(res.status, 200, `re-sweep (${body(res)})`);
      const ev = await obligationEvents(id);
      assertEq(ev.filter((e) => e.code === trigger).length, 1, "one due event");
      assertEq(ev.filter((e) => e.code === "governance.obligation.overdue").length, 1, "one overdue event");
    });

    await t.step("completion with no attributed actor is refused (400 completed_by) and changes nothing", async () => {
      const res = await api("POST", `/governance/obligations/${id}/complete`, { note: "anonymous" }, { key: staff });
      assertEq(res.status, 400, `no completed_by (${body(res)})`);
      assertEq(res.body.errors?.[0]?.field, "completed_by", "field named");
      const row = await obligationRow(id);
      assertEq(row.last_completed_at, null, "not completed");
      assertEq(day(row.next_due_at), "2025-01-01", "not advanced");
      assertEq((await completions(id)).length, 0, "nothing logged");
    });

    await t.step("completing an unknown obligation is a 404", async () => {
      const res = await api("POST", `/governance/obligations/oblig_flowtest_missing_${r}/complete`,
        { completed_by: "internal_audit" }, { key: staff });
      assertEq(res.status, 404, `unknown (${body(res)})`);
    });

    await t.step("internal audit completes it 21 months late: next due is 2025-04-01 (one quarter after it was DUE), completion logged late", async () => {
      const res = await api("POST", `/governance/obligations/${id}/complete`,
        { completed_by: "internal_audit_flow", note: "clean opinion" }, { key: staff });
      assertEq(res.status, 200, `complete (${body(res)})`);
      assertEq(res.body.completed_late, true, "late");
      assertEq(day(res.body.due_at), "2025-01-01", "the cycle it satisfied");
      assertEq(day(res.body.next_due_at), "2025-04-01", "advanced from DUE, not from today");
      const row = await obligationRow(id);
      assertEq(day(row.next_due_at), "2025-04-01", "stored next due");
      assertEq(row.last_completed_by, "internal_audit_flow", "attributed");
      assertEq(row.last_completion_note, "clean opinion", "note kept");
      const log = await completions(id);
      assertEq(log.length, 1, "one completion logged");
      assertEq(log[0].was_late, true, "lateness STORED on the log");
      assertEq(day(log[0].due_at), "2025-01-01", "log names the due date");
      assertEq(log[0].provenance, "demo", "labelled demo");
      const ev = (await obligationEvents(id)).find((e) => e.code === "governance.obligation.completed");
      assertEq(ev?.payload.was_late, true, "completion event says late");
      assertEq(ev?.payload.completed_by, "internal_audit_flow", "and who");
    });

    await t.step("the next cycle (due 2025-04-01) is itself past due and nobody did it: the sweep fires it and names it OVERDUE", async () => {
      const res = await api("POST", "/governance/calendar/sweep", {}, { key: staff });
      assertEq(res.status, 200, `sweep (${body(res)})`);
      const fired = (res.body.fired as Any[]).find((f) => f.id === id);
      assertEq(day(fired?.due_at), "2025-04-01", "the April cycle opened");
      // DEFECT: governance.ts postCalendarSweep tests `last_completed_at < due_at`, so completing the
      // January cycle late (today) hides the April cycle — 18 months past due, never done — from the overdue list.
      assert((res.body.overdue as Any[]).some((o) => o.id === id),
        "the April 2025 cycle is past due with no completion against it, so it is overdue");
    });
  } finally {
    await cleanup(created);
  }
});

// -------------------------------------------------- unscheduled ≠ overdue

flow("governance: an obligation registered with no anchor is reported UNSCHEDULED (never overdue, never completable) until staff anchor it", async (t) => {
  const staff = await actor("cu_admin");
  const r = run();
  const control = `flowtest:GOV-U-${r}`;
  const trigger = "flowtest.board_cycle.opened";
  const id = oblId(control, trigger);
  const adhocControl = `flowtest:GOV-A-${r}`;
  const adhocTrigger = "flowtest.adhoc_review.opened";
  const adhoc = oblId(adhocControl, adhocTrigger);
  const created = [id, adhoc];
  const sweep = async () => {
    const res = await api("POST", "/governance/calendar/sweep", {}, { key: staff });
    assertEq(res.status, 200, `sweep (${body(res)})`);
    return res.body as Any;
  };
  try {
    await t.step("registered with a cadence but no anchor: 201, scheduled=false, and the response SAYS it will never come due", async () => {
      const res = await api("POST", "/governance/obligations",
        { control_uid: control, trigger_code: trigger, title: "Flow annual board review", cadence: "annual" },
        { key: staff });
      assertEq(res.status, 201, `register (${body(res)})`);
      assertEq(res.body.scheduled, false, "unscheduled");
      assertEq(res.body.next_due_at, null, "no due date");
      assert(String(res.body.warning).includes("never come due"), "stated, not implied");
      const row = await obligationRow(id);
      assertEq(row.anchor_date, null, "recorded as existing, with no anchor");
      assertEq(row.next_due_at, null, "and no due date");
    });

    await t.step("it cannot be completed — there is no cycle to satisfy (409 obligation_unscheduled), nothing logged", async () => {
      const res = await api("POST", `/governance/obligations/${id}/complete`, { completed_by: "secretary" }, { key: staff });
      assertEq(res.status, 409, `complete unscheduled (${body(res)})`);
      assertEq(res.body.type, "obligation_unscheduled", "typed refusal");
      assertEq((await completions(id)).length, 0, "no fabricated cycle");
      assertEq((await obligationRow(id)).last_completed_at, null, "not completed");
    });

    await t.step("the sweep reports it UNSCHEDULED — separately from overdue, never fired — and names the state in its warning", async () => {
      const b = await sweep();
      assert((b.unscheduled as Any[]).some((u) => u.id === id), "listed unscheduled");
      assert(!(b.overdue as Any[]).some((o) => o.id === id), "not overdue");
      assert(!(b.fired as Any[]).some((f) => f.id === id), "never fired");
      assert(String(b.warning).includes("NOT satisfied and NOT overdue"), "the unscheduled state is named");
      assertEq((await obligationEvents(id)).length, 0, "no event for an obligation that never came due");
    });

    await t.step("staff anchor it in the future: now scheduled, not due, and off the unscheduled list", async () => {
      const res = await api("POST", "/governance/obligations",
        { control_uid: control, trigger_code: trigger, title: "Flow annual board review", cadence: "annual", anchor_date: "2099-01-01" },
        { key: staff });
      assertEq(res.status, 201, `anchor (${body(res)})`);
      assertEq(res.body.scheduled, true, "scheduled");
      assertEq(day((await obligationRow(id)).next_due_at), "2099-01-01", "due on the anchor");
      const b = await sweep();
      assert(!(b.unscheduled as Any[]).some((u) => u.id === id), "no longer unscheduled");
      assert(!(b.fired as Any[]).some((f) => f.id === id), "not due yet, not fired");
      assert(!(b.overdue as Any[]).some((o) => o.id === id), "not overdue");
    });

    await t.step("an ad_hoc obligation has no next occurrence: completing it leaves no due date rather than inventing one", async () => {
      const reg = await api("POST", "/governance/obligations",
        { control_uid: adhocControl, trigger_code: adhocTrigger, title: "Flow ad hoc review", cadence: "ad_hoc", anchor_date: "2026-01-15" },
        { key: staff });
      assertEq(reg.status, 201, `register ad_hoc (${body(reg)})`);
      const res = await api("POST", `/governance/obligations/${adhoc}/complete`, { completed_by: "cco_flow" }, { key: staff });
      assertEq(res.status, 200, `complete ad_hoc (${body(res)})`);
      assertEq(res.body.next_due_at, null, "no invented next occurrence");
      const row = await obligationRow(adhoc);
      assertEq(row.next_due_at, null, "no next due");
      assertEq(row.last_completed_by, "cco_flow", "completion kept");
      assertEq((await completions(adhoc)).length, 1, "logged");
    });

    await t.step("a COMPLETED ad_hoc obligation is not reported as 'unscheduled … NOT satisfied'", async () => {
      const b = await sweep();
      // DEFECT (judgement call on ad_hoc semantics): governance.ts postObligationComplete nulls the anchor of a
      // completed ad_hoc obligation, so the sweep lists it under `unscheduled` with a warning that it is "NOT satisfied".
      assert(!(b.unscheduled as Any[]).some((u) => u.id === adhoc),
        "a satisfied one-off obligation is reported as never scheduled and not satisfied");
    });
  } finally {
    await cleanup(created);
  }
});
