// The shared compliance-item primitives (BLUEPRINT §5e) that domains put their
// controls on: the work item (task / request / notice / inbound
// correspondence) with its deadline and overdue sweep, the threshold with its
// observations, and the append-only attestation. A primitive is only a
// primitive if it serves controls from DIFFERENT policies with one shape, so
// every journey here runs items for several policies through the same routes.
//
// Every actor is a minted token. Work items are opened with run-unique titles
// and closed (or cancelled) before each flow ends, so the instance's overdue
// and undeadlined queues are left as the flow found them; thresholds use
// run-unique metrics and are deleted afterwards. Attestations cannot be
// deleted (the database refuses it), which the attestation flow asserts.
//
// Ported from core/supabase/functions/api/primitives.test.ts (see
// ledger/primitives.md).
import { actor, type Any, api, assert, assertEq, core, flow, uid } from "./helpers.ts";

const show = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);

function tokenIdOf(plaintext: string, actorType: string): string {
  return `tok_test_${actorType}_${plaintext.slice("cass_test_".length, "cass_test_".length + 12)}`;
}

async function row(table: string, id: string): Promise<Any> {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data;
}

async function events(type: string, id: string): Promise<Any[]> {
  const r = await core().from("event").select("id, code, payload, provenance").eq("resource_id", `${type}:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  return r.data ?? [];
}

async function rowsWithTitle(title: string): Promise<number> {
  const r = await core().from("work_item").select("id").eq("title", title);
  assert(!r.error, `work_item read: ${r.error?.message}`);
  return (r.data ?? []).length;
}

/** close every still-open item this flow opened (cleanup, not assertion) */
async function closeAll(ids: string[], key: string): Promise<void> {
  for (const id of ids) {
    const w = await row("work_item", id).catch(() => null);
    if (!w || w.closed_at) continue;
    const r = await api("POST", `/primitives/work-items/${id}/close`,
      { outcome: "withdrawn", cancelled: true }, { key });
    if (r.status !== 200) console.error(`cleanup close ${id}: ${r.status} ${show(r)}`);
  }
}

// ======================================================== C/D/F/E work items

flow("primitives: work items across four policies → bare ids and sourceless correspondence refused → a request needs its decision, an adverse one its reason → the sweep tells OVERDUE from UNDEADLINED → a late close is recorded late", async (t) => {
  const ops = await actor("pynthia_ops");
  const admin = await actor("cu_admin");
  const partner = await actor("partner");
  const run = uid();
  const opened: string[] = [];
  let request = "", undeadlined = "", overdue = "";

  try {
    await t.step("a partner cannot open, close or sweep work items (403 at the actor gate)", async () => {
      const title = `${run} partner probe`;
      const o = await api("POST", "/primitives/work-items", { control_uid: "audit:AU-01", kind: "task", title }, { key: partner });
      assertEq(o.status, 403, `partner open (${show(o)})`);
      assertEq(o.body.type, "insufficient_scope", "actor gate");
      assertEq(await rowsWithTitle(title), 0, "nothing stored");
      assertEq((await api("POST", "/primitives/work-items/wi_none/close", { outcome: "x" }, { key: partner })).status, 403, "partner close");
      assertEq((await api("POST", "/primitives/work-items/sweep", {}, { key: partner })).status, 403, "partner sweep");
    });

    await t.step("all four kinds open with ONE shape, for four different policies (audit / cash / privacy / bsa)", async () => {
      const cases: [string, string, Record<string, unknown>][] = [
        ["task", "audit:AU-01", {}],
        ["request", "cash:CP-01", {}],
        ["notice", "privacy:PR-01", {}],
        ["inbound", "bsa:BSA-01", { source_ref: "FinCEN 314(a)", received_at: "2026-07-01T00:00:00Z" }],
      ];
      for (const [kind, control, extra] of cases) {
        const r = await api("POST", "/primitives/work-items", {
          control_uid: control, kind, title: `${run} ${kind}`, due_at: "2099-08-01T00:00:00Z", ...extra,
        }, { key: ops });
        assertEq(r.status, 201, `${kind} for ${control} (${show(r)})`);
        assertEq(r.body.deadlined, true, `${kind} deadlined`);
        const id = String(r.body.id);
        opened.push(id);
        if (kind === "request") request = id;
        const w = await row("work_item", id);
        assertEq(w.kind, kind, "kind stored");
        assertEq(w.control_uid, control, "policy-qualified uid stored");
        assertEq(w.status, "open", "open");
        assertEq(w.opened_by, tokenIdOf(ops, "pynthia_ops"), "opener from the token");
        assertEq(w.provenance, "demo", "test evidence stamped demo");
        if (kind === "inbound") {
          assertEq(w.source_ref, "FinCEN 314(a)", "source recorded");
          assertEq(new Date(w.received_at).toISOString(), "2026-07-01T00:00:00.000Z", "arrival time recorded, not log time");
        }
        assert((await events("work_item", id)).some((e) => e.code === `${kind}.opened`), `${kind}.opened emitted`);
      }
    });

    await t.step("OQ-11: a bare control id ('CP-01' is both capitalization and cash) is refused as ambiguous; nothing stored", async () => {
      const title = `${run} bare`;
      const r = await api("POST", "/primitives/work-items", { control_uid: "CP-01", kind: "task", title }, { key: ops });
      assertEq(r.status, 400, `bare id (${show(r)})`);
      assertEq(r.body.errors?.[0]?.field, "control_uid", "names the field");
      assert(String(r.body.errors?.[0]?.message).includes("ambiguous"), "says why");
      assertEq(await rowsWithTitle(title), 0, "nothing stored");
    });

    await t.step("inbound correspondence must record its SOURCE and its ARRIVAL time — each absence refused, nothing stored", async () => {
      const title = `${run} 314a no source`;
      for (const missing of [{ received_at: "2026-07-01T00:00:00Z" }, { source_ref: "OCC" }, {}]) {
        const r = await api("POST", "/primitives/work-items",
          { control_uid: "bsa:BSA-01", kind: "inbound", title, ...missing }, { key: ops });
        assertEq(r.status, 400, `inbound missing ${JSON.stringify(missing)} (${show(r)})`);
      }
      assertEq(await rowsWithTitle(title), 0, "nothing stored");
    });

    await t.step("an item opened with NO deadline says so — it can never become overdue", async () => {
      const r = await api("POST", "/primitives/work-items",
        { control_uid: "third-party-risk:TR-01", kind: "task", title: `${run} vendor review` }, { key: admin });
      assertEq(r.status, 201, `undeadlined (${show(r)})`);
      assertEq(r.body.deadlined, false, "deadlined: false");
      assert(String(r.body.warning).includes("never become overdue"), "the warning is stated");
      undeadlined = String(r.body.id);
      opened.push(undeadlined);
      assertEq((await row("work_item", undeadlined)).due_at, null, "due_at null");
    });

    await t.step("a task whose deadline already passed is opened (the 2020 exam follow-up nobody did)", async () => {
      const r = await api("POST", "/primitives/work-items",
        { control_uid: "compliance:CM-01", kind: "task", title: `${run} exam follow-up`, due_at: "2020-01-01T00:00:00Z" }, { key: ops });
      assertEq(r.status, 201, `overdue task (${show(r)})`);
      overdue = String(r.body.id);
      opened.push(overdue);
    });

    await t.step("the sweep reports OUR overdue item and OUR undeadlined item separately — and the undeadlined one is NOT current", async () => {
      const r = await api("POST", "/primitives/work-items/sweep", {}, { key: ops });
      assertEq(r.status, 200, `sweep (${show(r)})`);
      const od = (r.body.overdue ?? []).map((x: Any) => x.id);
      const ud = (r.body.undeadlined ?? []).map((x: Any) => x.id);
      assert(od.includes(overdue), "the past-due task is overdue");
      assert(!od.includes(undeadlined), "an undeadlined item is never overdue");
      assert(ud.includes(undeadlined), "the undeadlined item is listed as undeadlined");
      assert(!ud.includes(overdue), "a deadlined item is not undeadlined");
      for (const id of opened.filter((x) => x !== overdue && x !== undeadlined)) {
        assert(!od.includes(id) && !ud.includes(id), `${id} (due 2099) is neither`);
      }
      assert(String(r.body.warning).includes("NOT current"), "the warning says undeadlined is not current");
      assert((await events("work_item", overdue)).some((e) => e.code === "task.overdue"), "task.overdue emitted for our item");
      assert(!(await events("work_item", undeadlined)).some((e) => e.code === "task.overdue"), "no overdue event for the undeadlined item");
    });

    await t.step("a REQUEST cannot close without saying what was decided (400 outcome); still open", async () => {
      const r = await api("POST", `/primitives/work-items/${request}/close`, {}, { key: admin });
      assertEq(r.status, 400, `no outcome (${show(r)})`);
      assertEq(r.body.errors?.[0]?.field, "outcome", "names outcome");
      assertEq((await row("work_item", request)).closed_at, null, "still open");
    });

    await t.step("an ADVERSE outcome needs a reason — 'denied' with no rationale is refused (400 rationale); still open", async () => {
      const r = await api("POST", `/primitives/work-items/${request}/close`, { outcome: "denied" }, { key: admin });
      assertEq(r.status, 400, `denied without reason (${show(r)})`);
      assertEq(r.body.errors?.[0]?.field, "rationale", "names rationale");
      assertEq((await row("work_item", request)).closed_at, null, "still open");
    });

    await t.step("the request is denied WITH a reason: decision, reason and closer recorded; on time", async () => {
      const r = await api("POST", `/primitives/work-items/${request}/close`,
        { outcome: "denied", rationale: "vault limit increase not supported by cash forecast" }, { key: admin });
      assertEq(r.status, 200, `close (${show(r)})`);
      assertEq(r.body.closed_late, false, "before its 2099 deadline");
      const w = await row("work_item", request);
      assertEq(w.status, "completed", "completed");
      assertEq(w.outcome, "denied", "outcome");
      assertEq(w.outcome_rationale, "vault limit increase not supported by cash forecast", "rationale verbatim");
      assertEq(w.closed_by, tokenIdOf(admin, "cu_admin"), "closer from the token");
      const ev = (await events("work_item", request)).find((e) => e.code === "request.completed");
      assert(ev, "request.completed emitted");
      assertEq(ev.payload.late, false, "late:false recorded");
    });

    await t.step("re-closing REPLAYS rather than re-deciding: the outcome is not rewritten", async () => {
      const r = await api("POST", `/primitives/work-items/${request}/close`, { outcome: "approved" }, { key: ops });
      assertEq(r.status, 200, `replay (${show(r)})`);
      assertEq(r.headers.get("Idempotent-Replayed"), "true", "replay header");
      assertEq(r.body.outcome, "denied", "the original decision is returned");
      const w = await row("work_item", request);
      assertEq(w.outcome, "denied", "outcome unchanged");
      assertEq(w.closed_by, tokenIdOf(admin, "cu_admin"), "closer unchanged");
    });

    await t.step("the adverse set is exactly denied / rejected / no_action: the latter two need a reason too; 'approved' does not", async () => {
      const r0 = await api("POST", "/primitives/work-items",
        { control_uid: "investment:IP-01", kind: "request", title: `${run} policy exception` }, { key: ops });
      assertEq(r0.status, 201, `open (${show(r0)})`);
      const id = String(r0.body.id);
      opened.push(id);
      for (const outcome of ["rejected", "no_action"]) {
        const r = await api("POST", `/primitives/work-items/${id}/close`, { outcome }, { key: admin });
        assertEq(r.status, 400, `${outcome} without reason (${show(r)})`);
        assertEq(r.body.errors?.[0]?.field, "rationale", `${outcome} names rationale`);
      }
      assertEq((await row("work_item", id)).closed_at, null, "still open");
      const ok = await api("POST", `/primitives/work-items/${id}/close`, { outcome: "approved" }, { key: admin });
      assertEq(ok.status, 200, `approved without reason (${show(ok)})`);
      const w = await row("work_item", id);
      assertEq(w.outcome, "approved", "approved");
      assertEq(w.outcome_rationale, null, "no reason required for a favourable outcome");
    });

    await t.step("closing the 2020 task LATE is recorded as late, never suppressed", async () => {
      const r = await api("POST", `/primitives/work-items/${overdue}/close`, { outcome: "completed" }, { key: ops });
      assertEq(r.status, 200, `late close (${show(r)})`);
      assertEq(r.body.closed_late, true, "closed_late");
      const ev = (await events("work_item", overdue)).find((e) => e.code === "task.completed");
      assert(ev, "task.completed emitted");
      assertEq(ev.payload.late, true, "late:true in the evidence");
    });

    await t.step("a closed item drops out of the next sweep", async () => {
      const r = await api("POST", "/primitives/work-items/sweep", {}, { key: ops });
      assertEq(r.status, 200, `sweep (${show(r)})`);
      assert(!(r.body.overdue ?? []).some((x: Any) => x.id === overdue), "closed item no longer overdue");
    });
  } finally {
    await closeAll(opened, ops);
  }
});

// ================================================================ thresholds

flow("primitives: thresholds for liquidity, capital and cash share one shape → a warn level on the wrong side is refused → an unconfigured limit observes as UNASSESSED → warn fires before breach, both directions, and zero is a real limit", async (t) => {
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  const run = uid();
  const created: string[] = [];
  const th = (name: string) => {
    const id = `th_${run}_${name}`;
    created.push(id);
    return id;
  };
  const put = (id: string, b: Record<string, unknown>) => api("PUT", `/primitives/thresholds/${id}`, b, { key: ops });
  const observe = (id: string, value: number) => api("POST", `/primitives/thresholds/${id}/observe`, { value }, { key: ops });
  const breachEvents = async (id: string) =>
    (await events("threshold", id)).filter((e) => e.code === "threshold.breached" || e.code === "threshold.warning");

  try {
    await t.step("a partner cannot configure or observe a threshold (403)", async () => {
      const id = th("partner");
      const r = await api("PUT", `/primitives/thresholds/${id}`,
        { control_uid: "liquidity:LQ-01", metric: `${run}.lcr`, subject_scope: "institution", limit_value: 1 }, { key: partner });
      assertEq(r.status, 403, `partner configure (${show(r)})`);
      assertEq(await row("threshold", id), null, "nothing stored");
      assertEq((await api("POST", `/primitives/thresholds/${id}/observe`, { value: 1 }, { key: partner })).status, 403, "partner observe");
    });

    await t.step("a warn level on the WRONG side of the limit is refused (it would fire after the breach); nothing stored", async () => {
      const id = th("wrongside");
      const r = await put(id, { control_uid: "liquidity:LQ-01", metric: `${run}.lcr`, subject_scope: "institution", limit_value: 100, warn_value: 120, direction: "above" });
      assertEq(r.status, 400, `wrong-side warn (${show(r)})`);
      assertEq(r.body.errors?.[0]?.field, "warn_value", "names warn_value");
      assertEq(await row("threshold", id), null, "nothing stored");
    });

    await t.step("ONE shape serves three policies: liquidity:LQ-01, capitalization:CP-01, cash:CP-01", async () => {
      for (const [name, control, scope] of [
        ["lcr", "liquidity:LQ-01", "institution"],
        ["nwr", "capitalization:CP-01", "institution"],
        ["vault", "cash:CP-01", "branch:001"],
      ]) {
        const id = th(`shape_${name}`);
        const r = await put(id, { control_uid: control, metric: `${run}.${name}`, subject_scope: scope, limit_value: 10 });
        assertEq(r.status, 200, `${control} (${show(r)})`);
        assertEq(r.body.configured, true, "configured");
        const t0 = await row("threshold", id);
        assertEq(t0.control_uid, control, "uid stored");
        assertEq(t0.metric, `${run}.${name}`, "metric stored");
        assertEq(Number(t0.limit_value), 10, "limit stored");
        assertEq(t0.set_by, tokenIdOf(ops, "pynthia_ops"), "setter from the token");
      }
    });

    await t.step("registered with NO limit: an observation keeps the real VALUE but is UNASSESSED, and raises nothing", async () => {
      const id = th("unset");
      const p = await put(id, { control_uid: "liquidity:LQ-01", metric: `${run}.unset`, subject_scope: "institution" });
      assertEq(p.status, 200, `register (${show(p)})`);
      assertEq(p.body.configured, false, "configured:false");
      assert(String(p.body.warning).includes("UNASSESSED"), "registration warns");
      const r = await observe(id, 999_999);
      assertEq(r.status, 201, `observe (${show(r)})`);
      assertEq(r.body.assessment, "unassessed", "unassessed — not within, not breach");
      assert(String(r.body.warning).includes("no configured limit"), "says why");
      const o = await row("threshold_observation", r.body.id);
      assertEq(Number(o.observed_value), 999_999, "the value is kept");
      assertEq(o.assessment, "unassessed", "stored unassessed");
      assertEq((await breachEvents(id)).length, 0, "no breach or warning event");
    });

    await t.step("ABOVE with a warn level: 7 within, 8 warns (before the breach), 11 breaches — only warn and breach raise events", async () => {
      const id = th("above");
      assertEq((await put(id, { control_uid: "cash:CP-01", metric: `${run}.above`, subject_scope: "branch:002", limit_value: 10, warn_value: 8, direction: "above" })).status, 200, "configure");
      for (const [v, want] of [[7, "within"], [8, "warn"], [11, "breach"]] as [number, string][]) {
        const r = await observe(id, v);
        assertEq(r.status, 201, `observe ${v} (${show(r)})`);
        assertEq(r.body.assessment, want, `${v} → ${want}`);
        assertEq((await row("threshold_observation", r.body.id)).assessment, want, `${v} stored ${want}`);
      }
      const ev = await breachEvents(id);
      assertEq(ev.filter((e) => e.code === "threshold.warning").length, 1, "one warning event (for 8)");
      assertEq(ev.filter((e) => e.code === "threshold.breached").length, 1, "one breach event (for 11)");
      assertEq(Number(ev.find((e) => e.code === "threshold.breached").payload.value), 11, "breach carries the value");
    });

    await t.step("BELOW (floors — liquidity, capital): 15 within, 5 breaches", async () => {
      const id = th("below");
      assertEq((await put(id, { control_uid: "capitalization:CP-01", metric: `${run}.below`, subject_scope: "institution", limit_value: 10, direction: "below" })).status, 200, "configure");
      assertEq((await observe(id, 15)).body.assessment, "within", "15 above a floor of 10 is within");
      assertEq((await observe(id, 5)).body.assessment, "breach", "5 below a floor of 10 breaches");
      assertEq((await breachEvents(id)).length, 1, "only the breach raised an event");
    });

    await t.step("a limit of ZERO is a real policy, not an absence: 1 breaches it", async () => {
      const id = th("zero");
      const p = await put(id, { control_uid: "cash:CP-01", metric: `${run}.zero`, subject_scope: "branch:003", limit_value: 0 });
      assertEq(p.status, 200, `configure (${show(p)})`);
      assertEq(p.body.configured, true, "zero is configured");
      assertEq((await observe(id, 1)).body.assessment, "breach", "1 > 0 breaches");
      assertEq((await breachEvents(id)).filter((e) => e.code === "threshold.breached").length, 1, "breach event");
    });
  } finally {
    const o = await core().from("threshold_observation").delete().in("threshold_id", created);
    if (o.error) console.error(`cleanup observations: ${o.error.message}`);
    const d = await core().from("threshold").delete().in("id", created);
    if (d.error) console.error(`cleanup thresholds: ${d.error.message}`);
  }
});

// ============================================================== attestations

flow("primitives: attestations for three policies → the attester is the AUTHENTICATED actor, never a payload claim → an empty statement or inverted period is refused → once made it cannot be edited or deleted", async (t) => {
  const director = await actor("cu_admin");
  const partner = await actor("partner");
  const run = uid();
  let first = "";

  await t.step("a partner cannot attest (403); nothing stored", async () => {
    const r = await api("POST", "/primitives/attestations",
      { control_uid: "compliance:CM-01", statement: `${run} partner` }, { key: partner });
    assertEq(r.status, 403, `partner attest (${show(r)})`);
    const q = await core().from("attestation").select("id").eq("statement", `${run} partner`);
    assertEq((q.data ?? []).length, 0, "nothing stored");
  });

  await t.step("an attestation with no statement asserts nothing — 400; an inverted period — 400; neither stored", async () => {
    const a = await api("POST", "/primitives/attestations", { control_uid: "compliance:CM-01", subject_ref: run }, { key: director });
    assertEq(a.status, 400, `no statement (${show(a)})`);
    assertEq(a.body.errors?.[0]?.field, "statement", "names statement");
    const b = await api("POST", "/primitives/attestations", {
      control_uid: "internal-controls:IC-01", statement: "controls reviewed", subject_ref: run,
      period_start: "2026-12-31", period_end: "2026-01-01",
    }, { key: director });
    assertEq(b.status, 400, `inverted period (${show(b)})`);
    assertEq(b.body.errors?.[0]?.field, "period_end", "names period_end");
    const q = await core().from("attestation").select("id").eq("subject_ref", run);
    assertEq((q.data ?? []).length, 0, "nothing stored");
  });

  await t.step("three policies attest through one shape; each records the AUTHENTICATED actor even when the payload names someone else", async () => {
    for (const control of ["director-fiduciary-duties:DF-01", "information-security:IS-01", "truth-in-savings:TIS-01"]) {
      const r = await api("POST", "/primitives/attestations", {
        control_uid: control, statement: `${run} reviewed for ${control}`, attested_by: "someone-else",
        period_start: "2026-01-01", period_end: "2026-06-30",
      }, { key: director });
      assertEq(r.status, 201, `${control} (${show(r)})`);
      assertEq(r.body.attested_by, tokenIdOf(director, "cu_admin"), "response names the token");
      const a = await row("attestation", r.body.id);
      assertEq(a.control_uid, control, "uid stored");
      assertEq(a.attested_by, tokenIdOf(director, "cu_admin"), "the payload's attested_by is ignored");
      assertEq(a.period_start, "2026-01-01", "period stored");
      assert((await events("attestation", r.body.id)).some((e) => e.code === "attestation.recorded"), "attestation.recorded");
      first ||= String(r.body.id);
    }
  });

  await t.step("append-only: the database refuses to edit or delete a made attestation", async () => {
    const u = await core().from("attestation").update({ statement: "revised after the fact" }).eq("id", first);
    assert(u.error, "an UPDATE must be refused");
    const d = await core().from("attestation").delete().eq("id", first);
    assert(d.error, "a DELETE must be refused");
    const a = await row("attestation", first);
    assert(a && String(a.statement).startsWith(run), "the original statement stands");
  });
});
