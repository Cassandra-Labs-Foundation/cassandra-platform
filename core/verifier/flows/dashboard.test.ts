// Compliance dashboard flows: the core's side of the monitoring surface a CCO
// or examiner reads. The HTML lives in the staff console on Vercel; the core's
// /compliance/dashboard 302s there, and the console reads five public core
// routes: /data (headline panels), /heartbeat (per-control pulse), /events
// (raw stream), /trace/{id} (one resource's whole cycle) and the one write,
// /flag. These flows prove the dashboard is a FAITHFUL audit surface: known
// evidence goes in, and the panels report exactly it, with headline numbers
// that are database totals rather than page lengths.
// Ports core/supabase/functions/api/dashboard.test.ts and sections 38 + 47 of
// core/supabase/tests/e2e/compliance_e2e.sh (see ledger/dashboard.md).
//
// SHARED-INSTANCE DISCIPLINE. Absolute totals move under other flows, so the
// counting flow measures DELTAS on the `?provenance=unknown` slice. Since
// provenance stamping landed, the core writes only `production` and `demo`;
// `unknown` holds frozen legacy rows (none in case, ctr_filing,
// payment_approval, none inside the 7-day control window), so nothing but this
// flow moves it. The fixtures are inserted as `unknown` with the service role
// and deleted in a finally. Unfiltered headline numbers are checked against a
// database count bracketed by two reads, retried while traffic moves the table.
//
// DEMO POSTURE. Every dashboard route is public (x-audience: public): no
// credential is needed and partner tokens see the same instance-wide panels.
// The flows pin that posture as it is declared; re-locking it for production
// (dashboard.ts header, 4b34d6a) flips the partner step to a 404.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { API } from "../contract/helpers.ts";
import { actor, type Any, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

const show = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PII_KEYS = ["name", "ssn", "date_of_birth", "dob", "address", "email", "phone"];

/** the sim schema (the dashboard flag writes there under the demo posture) */
function sim() {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }).schema("sim");
}

const dash = (path: string, key: string | null = null) => api("GET", `/compliance/dashboard${path}`, undefined, { key });

async function onboard(partner: string, openingCents: number): Promise<{ entity: string; account: string }> {
  const e = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1983-02-11",
    address: "47 Ledger Ln, Springfield, IL 62701",
  }, { key: partner });
  assertEq(e.status, 201, `create entity (${show(e)})`);
  const a = await api("POST", "/accounts", {
    entity_id: e.body.id, account_type: "checking", opening_deposit_cents: openingCents,
  }, { key: partner });
  assertEq(a.status, 201, `open account (${show(a)})`);
  return { entity: String(e.body.id), account: String(a.body.id) };
}

/**
 * The API number equals the database's own count. Bracketed (db, api, db) so
 * concurrent traffic cannot make a correct count look wrong; retried while the
 * table is moving. A page length (100, 1000) fails as soon as the table is
 * bigger than the page.
 */
async function faithful(label: string, apiCount: () => Promise<number>, dbCount: () => Promise<number>) {
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    const d1 = await dbCount();
    const a = await apiCount();
    const d2 = await dbCount();
    if (Math.min(d1, d2) <= a && a <= Math.max(d1, d2)) return a;
    seen.push(`db ${d1}..${d2} api ${a}`);
  }
  throw new Error(`${label}: the dashboard number is not the database count (${seen.join("; ")})`);
}

async function dbCount(table: string, f: (q: Any) => Any = (q) => q): Promise<number> {
  const r = await f(core().from(table).select("id", { count: "exact", head: true }));
  assert(!r.error, `${table} count: ${r.error?.message}`);
  return Number(r.count ?? 0);
}

// ===========================================================================
// 1. the URL, CORS and the public posture (section 38)
// ===========================================================================

flow("dashboard: the dashboard URL 302s to the deployed console; the data routes speak CORS and serve without a credential", async (t) => {
  await t.step("GET /compliance/dashboard with no credential is a 302 to the HTTPS console, never cached", async () => {
    const res = await fetch(`${API}/compliance/dashboard`, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    await res.body?.cancel();
    assertEq(res.status, 302, "redirect, not an HTML body the gateway would rewrite to text/plain");
    const loc = res.headers.get("location") ?? "";
    assert(loc.startsWith("https://"), `location is an HTTPS web host (${loc})`);
    assert(new URL(loc).pathname.replace(/\/$/, "") === "/compliance/dashboard", `lands on the console's dashboard page (${loc})`);
    assertEq(res.headers.get("cache-control"), "no-store", "the redirect is not cached");
  });

  await t.step("the shell's cross-origin preflight is answered 204 on every monitoring route and allows X-Api-Key", async () => {
    for (const p of ["data", "heartbeat", "events", "trace/acct_x", "flag"]) {
      const res = await fetch(`${API}/compliance/dashboard/${p}`, {
        method: "OPTIONS", signal: AbortSignal.timeout(30_000),
        headers: { Origin: "https://example.github.io", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-api-key" },
      });
      await res.body?.cancel();
      assertEq(res.status, 204, `${p}: preflight`);
      assertEq(res.headers.get("access-control-allow-origin"), "*", `${p}: allow-origin`);
      assert(/x-api-key/i.test(res.headers.get("access-control-allow-headers") ?? ""), `${p}: allows X-Api-Key`);
      assert(/GET/.test(res.headers.get("access-control-allow-methods") ?? ""), `${p}: allows GET`);
    }
  });

  await t.step("demo posture: the panels load with no credential, carry CORS, and are well-formed", async () => {
    const r = await dash("/data");
    assertEq(r.status, 200, `data with no key (${show(r)})`);
    assertEq(r.headers.get("access-control-allow-origin"), "*", "CORS on the data response");
    const d = r.body;
    assertEq(d.window_hours, 168, "7-day window");
    assertEq(d.caps?.aggregate_rows, 1000, "row cap reported");
    assertEq(d.caps?.list_rows, 100, "list cap reported");
    assertEq(d.provenance?.filter, "all", "default hides nothing");
    for (const panel of ["controls", "alerts", "cases", "ctr", "pending_approvals", "ops"]) assert(d[panel], `${panel} panel present`);
    assert(Number.isInteger(d.ops.outbox_undelivered), "outbox depth is a number");
    assertEq(d.ops.outbox_capped, false, "a true count is never capped");
  });

  await t.step("demo posture: a partner token gets the same instance-wide panels (public by declaration, x-audience: public)", async () => {
    const partner = await actor("partner");
    const r = await dash("/data", partner);
    assertEq(r.status, 200, `partner reads the panels (${show(r)})`);
    assertEq(Object.keys(r.body).sort().join(","), Object.keys((await dash("/data")).body).sort().join(","), "same payload shape as anonymous");
  });

  await t.step("public is specific to the dashboard: an ordinary route still refuses a missing credential", async () => {
    const r = await api("GET", "/accounts", undefined, { key: null });
    assertEq(r.status, 401, `no key on /accounts (${show(r)})`);
  });
});

// ===========================================================================
// 2. audit a real violation from the dashboard alone (section 47, first half)
// ===========================================================================

flow("dashboard: a CCO audits a real NSF rejection from the dashboard alone — heartbeat pulse, raw stream, and the account's trace", async (t) => {
  const partner = await actor("partner");
  let a = { entity: "", account: "" };
  let b = { entity: "", account: "" };
  let okId = "";
  let nsfAt = 0;

  await t.step("fixtures: two members; an over-balance transfer is rejected at the gate (422) and a compliant one settles (201)", async () => {
    a = await onboard(partner, 200_000);
    b = await onboard(partner, 100_000);
    nsfAt = Date.now() - 5_000;
    const nsf = await api("POST", "/transfers", {
      source_account_id: a.account, destination_account_id: b.account, amount_cents: 500_000, description: "dashboard: nsf",
    }, { key: partner });
    assertEq(nsf.status, 422, `NSF rejected (${show(nsf)})`);
    assertEq(nsf.body.type, "insufficient_funds", "typed refusal");
    const ok = await api("POST", "/transfers", {
      source_account_id: a.account, destination_account_id: b.account, amount_cents: 10_000, description: "dashboard: ok",
    }, { key: partner });
    assertEq(ok.status, 201, `compliant transfer (${show(ok)})`);
    okId = String(ok.body.id);
    const cr = await core().from("control_result").select("control_id, decision").eq("subject_ref", a.account);
    assert((cr.data ?? []).some((c: Any) => c.control_id === "CG-NSF-01" && c.decision === "reject"), "the gate wrote CG-NSF-01 reject evidence");
  });

  await t.step("heartbeat: the gate lane pulses CG-NSF-01 reject (core), and gate_last_seen dates it at or after our rejection", async () => {
    const r = await dash("/heartbeat?hours=24");
    assertEq(r.status, 200, `heartbeat (${show(r)})`);
    const d = r.body;
    assert(d.gate.some((g: Any) => g.control_id === "CG-NSF-01" && g.decision === "reject" && g.src === "core" && g.n > 0),
      "CG-NSF-01 reject pulses on the gate lane");
    assert(d.events.some((e: Any) => e.code === "transfer.settled" && e.n > 0), "transfer.settled pulses in the event lanes");
    assert((d.last_seen ?? []).some((s: Any) => s.code === "transfer.settled" && s.total > 0), "last_seen carries transfer.settled history");
    // the gate tier's recency comes from control_result rows; without it every
    // gate control rendered "LAST EVIDENCE: never" beside a live sparkline
    const g = (d.gate_last_seen ?? []).find((s: Any) => s.control_id === "CG-NSF-01" && s.src === "core");
    assert(g && g.total > 0, `gate_last_seen names CG-NSF-01 (${JSON.stringify(g)})`);
    assert(new Date(g.last_at).getTime() >= nsfAt, `last evidence is ours or newer (${g.last_at})`);
  });

  await t.step("heartbeat: the DEFAULT 7-day view still shows the newest pulses — our settle's bucket", async () => {
    // event_heartbeat is ordered oldest bucket first and PostgREST caps every
    // RPC result at 1000 rows, so once a week of activity exceeds 1000
    // (code, bucket) pairs the NEWEST buckets are the ones silently dropped.
    const r = await dash("/heartbeat");
    assertEq(r.status, 200, `default heartbeat (${show(r)})`);
    const bucketMs = r.body.bucket_seconds * 1000;
    const ourBucket = Math.floor(nsfAt / bucketMs) * bucketMs;
    const settled = r.body.events.filter((e: Any) => e.code === "transfer.settled" && e.src === "core")
      .map((e: Any) => new Date(e.bucket).getTime());
    // Regression guard (fixed 2026-10-06, migration 20261006000100): the 7-day heartbeat was truncated at 1000 rows (PostgREST max-rows) oldest-first, so the newest pulses — today's — are missing and nothing says so
    assert(settled.includes(ourBucket),
      `transfer.settled pulses in our bucket ${new Date(ourBucket).toISOString()} (events: ${r.body.events.length} rows, newest bucket ${r.body.events.map((e: Any) => e.bucket).sort().at(-1)})`);
  });

  await t.step("heartbeat: the all-time census reaches the end of the alphabet — every code has a 'last evidence'", async () => {
    const r = await dash("/heartbeat");
    assertEq(r.status, 200, `default heartbeat (${show(r)})`);
    const last = await core().from("event").select("code").not("code", "is", null).order("code", { ascending: false }).limit(1).single();
    assert(!last.error, `max code: ${last.error?.message}`);
    // Regression guard (fixed 2026-10-06): event_last_seen was also cut at 1000 rows (ordered by code), so codes late in the alphabet have no "last evidence" at all
    assert((r.body.last_seen ?? []).some((s: Any) => s.code === last.data!.code && s.src === "core"),
      `the census reaches '${last.data!.code}' (got ${(r.body.last_seen ?? []).length} rows, last '${(r.body.last_seen ?? []).at(-1)?.code}')`);
  });

  await t.step("heartbeat: absurd parameters clamp to 30 days, at most 720 buckets, and the payload reports what was used", async () => {
    const r = await dash("/heartbeat?hours=999999&bucket=1");
    // Regression guard (fixed 2026-10-06): the 90-day ceiling hit the statement
    // timeout (~8s cold → 500). The window now caps at 30 days, and the bucket
    // widens so a window never holds more than 720 buckets.
    assertEq(r.status, 200, `clamped (${show(r)})`);
    assertEq(r.body.window_hours, 720, "window clamps to 30 days");
    assertEq(r.body.bucket_seconds, 3600, "30 days at one hour is exactly 720 buckets");
    const short = await dash("/heartbeat?hours=24&bucket=1");
    assertEq(short.body.bucket_seconds, 3600, "a short window keeps the one-hour floor");
  });

  await t.step("heartbeat: ?last_seen=0 skips the census and answers null, not []", async () => {
    const slim = await dash("/heartbeat?last_seen=0");
    assertEq(slim.status, 200, "slim poll");
    assertEq(slim.body.last_seen, null, "census not requested → null");
    assert(Array.isArray(slim.body.gate_last_seen), "gate recency still rides the slim poll");
    assertEq(slim.body.window_hours, 168, "default window");
  });

  await t.step("stream: a codeless query is refused (422), not a dump of the whole outbox", async () => {
    const r = await dash("/events");
    assertEq(r.status, 422, `codeless (${show(r)})`);
  });

  await t.step("stream: our settled transfer is inspectable with its payload, labelled core, newest first", async () => {
    const r = await dash("/events?codes=transfer.settled&limit=50");
    assertEq(r.status, 200, `stream (${show(r)})`);
    const ours = r.body.events.find((e: Any) => e.resource_id === okId);
    assert(ours, "our transfer.settled is in the newest 50");
    assert(ours.payload && typeof ours.payload === "object", "payload inspectable");
    assertEq(ours.src, "core", "labelled core");
    const ts = r.body.events.map((e: Any) => String(e.created_at));
    assert(ts.every((x: string, i: number) => i === 0 || ts[i - 1] >= x), "newest first");
  });

  await t.step("stream: the cursor pages strictly backwards; ?src=core reads only the core world", async () => {
    const p1 = await dash("/events?codes=transfer.settled&limit=2&src=core");
    assertEq(p1.status, 200, "page 1");
    assertEq(p1.body.events.length, 2, "a full page");
    assert(p1.body.events.every((e: Any) => e.src === "core"), "core only");
    assertEq(p1.body.next_before, p1.body.events[1].created_at, "cursor is the last row's created_at");
    const p2 = await dash(`/events?codes=transfer.settled&limit=2&src=core&before=${encodeURIComponent(p1.body.next_before)}`);
    assertEq(p2.status, 200, "page 2");
    assert(p2.body.events.length > 0, "history continues");
    assert(p2.body.events.every((e: Any) => String(e.created_at) < String(p1.body.next_before)), "strictly older");
    const ids1 = new Set(p1.body.events.map((e: Any) => e.id));
    assert(!p2.body.events.some((e: Any) => ids1.has(e.id)), "no row repeats across pages");
  });

  await t.step("trace: the account's cycle shows the gate's reject about it; the transfer's chain carries transfer.settled", async () => {
    const acct = await dash(`/trace/${a.account}`);
    assertEq(acct.status, 200, `account trace (${show(acct)})`);
    assert(acct.body.control_results.some((c: Any) => c.control_id === "CG-NSF-01" && c.decision === "reject"),
      "the reject is in the account's trace");
    assert(acct.body.control_results.every((c: Any) => c.subject_ref === a.account), "only decisions about this account");
    const tr = await dash(`/trace/${okId}`);
    assertEq(tr.status, 200, "transfer trace");
    assert(tr.body.events.some((e: Any) => e.code === "transfer.settled"), "transfer.settled in the chain");
    assert(tr.body.events.every((e: Any) => e.resource_id === okId), "only this transfer's events");
    const ts = tr.body.events.map((e: Any) => String(e.created_at));
    assert(ts.every((x: string, i: number) => i === 0 || ts[i - 1] <= x), "oldest first");
  });

  await t.step("PII boundary: the member's stored entity.created carries a name, the dashboard's copy does not", async () => {
    const raw = await core().from("event").select("id, payload").eq("code", "entity.created").eq("resource_id", a.entity);
    assert(!raw.error, `event read: ${raw.error?.message}`);
    assert((raw.data ?? []).some((e: Any) => e.payload && "name" in e.payload), `the stored payload holds the name (${JSON.stringify(raw.data)})`);
    const tr = await dash(`/trace/${a.entity}`);
    assertEq(tr.status, 200, "entity trace");
    const created = tr.body.events.filter((e: Any) => e.code === "entity.created");
    assert(created.length > 0, "entity.created is in the trace");
    for (const e of created) {
      const leaked = PII_KEYS.filter((k) => e.payload && k in e.payload);
      assertEq(leaked.join(","), "", "no PII key crosses the dashboard");
    }
    const st = await dash("/events?codes=entity.created&limit=50");
    assertEq(st.status, 200, "entity stream");
    const withPayload = st.body.events.filter((e: Any) => e.payload && typeof e.payload === "object");
    assert(withPayload.length > 0, "the stream has payloads to inspect");
    assert(!withPayload.some((e: Any) => PII_KEYS.some((k) => k in e.payload)), "the stream redacts too");
  });
});

// ===========================================================================
// 3. headline counts are true totals and the panels reflect known evidence
//    (stub tests 2-5; section 38 panels; section 47 second half)
// ===========================================================================

flow("dashboard: known evidence moves every panel by exactly what was added; headline numbers are database totals, not page lengths", async (t) => {
  const partner = await actor("partner");
  const run = uid();
  const now = Date.now();
  const past = new Date(now - HOUR).toISOString();
  const future = new Date(now + DAY).toISOString();
  const recent = new Date(now).toISOString();
  const ids = {
    crs: [`cr_${run}_1`, `cr_${run}_2`, `cr_${run}_3`],
    ctlA: `CG-DASH-${run}-A`, ctlB: `CG-DASH-${run}-B`,
    alertOverdue: `alert_${run}_overdue`, alertOpen: `alert_${run}_open`, alertClosed: `alert_${run}_closed`,
    caseOpen: `case_${run}_open`, caseDecided: `case_${run}_decided`,
    ctrOverdue: "", ctrDue: "", ctrFiled: "",
    apPending: `appr_${run}_pending`, apDone: `appr_${run}_done`,
  };
  let before: Any = null;
  let after: Any = null;
  const unknownSlice = async () => {
    const r = await dash("/data?provenance=unknown");
    assertEq(r.status, 200, `unknown slice (${show(r)})`);
    assertEq(r.body.provenance.filter, "unknown", "filter echoed");
    return r.body;
  };

  try {
    await t.step("snapshot the unknown-provenance slice, then insert known evidence into it", async () => {
      const m = await onboard(partner, 10_000);
      ids.ctrOverdue = `ctr_${m.entity}_1990-01-01`;
      ids.ctrDue = `ctr_${m.entity}_1990-01-02`;
      ids.ctrFiled = `ctr_${m.entity}_1990-01-03`;
      before = await unknownSlice();
      const ins = async (table: string, rows: Any[]) => {
        const r = await core().from(table).insert(rows);
        assert(!r.error, `${table} fixture insert: ${r.error?.message}`);
      };
      await ins("control_result", [
        { id: ids.crs[0], control_id: ids.ctlA, decision: "block", subject_ref: m.account, provenance: "unknown", created_at: recent },
        { id: ids.crs[1], control_id: ids.ctlA, decision: "pass", subject_ref: m.account, provenance: "unknown", created_at: recent },
        { id: ids.crs[2], control_id: ids.ctlB, decision: "pass", subject_ref: m.account, provenance: "unknown", created_at: recent },
      ]);
      const alert = (id: string, extra: Any) => ({
        id, alert_type: "structuring", details: `dashboard flow fixture ${run}`, provenance: "unknown", ...extra,
      });
      await ins("bsa_alert", [
        alert(ids.alertOverdue, { status: "open", triage_due_at: past, triaged_at: null }),
        alert(ids.alertOpen, { status: "open", triage_due_at: future, triaged_at: null }),
        alert(ids.alertClosed, { status: "closed", triage_due_at: past, triaged_at: recent }),
      ]);
      await ins("case", [
        { id: ids.caseOpen, type: "investigation", status: "opened", alert_id: ids.alertOverdue, opened_at: recent, provenance: "unknown" },
        { id: ids.caseDecided, type: "investigation", status: "closed", alert_id: ids.alertClosed, sar_decision: "file",
          opened_at: recent, decided_at: recent, provenance: "unknown" },
      ]);
      const ctr = (id: string, date: string, extra: Any) => ({
        id, entity_id: m.entity, business_date: date, cash_in_total: 1_100_000, cash_out_total: 0,
        threshold_crossed_at: recent, provenance: "unknown", ...extra,
      });
      await ins("ctr_filing", [
        ctr(ids.ctrOverdue, "1990-01-01", { filing_due_at: past, filed_at: null }),
        ctr(ids.ctrDue, "1990-01-02", { filing_due_at: future, filed_at: null }),
        ctr(ids.ctrFiled, "1990-01-03", { filing_due_at: past, filed_at: recent, filed_by: "dashboard-flow", fincen_ref: `DASH-${run}` }),
      ]);
      await ins("payment_approval", [
        { id: ids.apPending, resource_type: "wire_transfer", resource_id: `wt_${run}_1`, created_by: "tok_dashboard_flow", basis: "dashboard flow fixture", provenance: "unknown" },
        { id: ids.apDone, resource_type: "wire_transfer", resource_id: `wt_${run}_2`, created_by: "tok_dashboard_flow",
          approved_by: "tok_dashboard_flow_2", approved_at: recent, basis: "dashboard flow fixture", provenance: "unknown" },
      ]);
      after = await unknownSlice();
    });

    await t.step("controls: the window grows by exactly 3 and by_control counts each decision of our controls", async () => {
      assertEq(after.controls.window_rows - before.controls.window_rows, 3, "window_rows delta");
      const a = after.controls.by_control[ids.ctlA] ?? {};
      assertEq(`${a.block}/${a.pass}/${Object.keys(a).length}`, "1/1/2", "control A: exactly one block and one pass");
      const b = after.controls.by_control[ids.ctlB] ?? {};
      assertEq(`${b.pass}/${Object.keys(b).length}`, "1/1", "control B: exactly one pass");
      assertEq(after.controls.window_capped, after.controls.window_rows > after.controls.window_listed, "capped flag consistent");
    });

    await t.step("alerts: two more open, one more past its triage clock; the closed alert is not counted or listed", async () => {
      assertEq(after.alerts.open - before.alerts.open, 2, "open delta (closed excluded)");
      assertEq(after.alerts.overdue_triage - before.alerts.overdue_triage, 1, "overdue delta (inside-the-clock excluded)");
      assertEq(after.alerts.by_provenance.unknown - before.alerts.by_provenance.unknown, 2, "the blend's unknown share moved by 2");
      const listed = after.alerts.list.map((a: Any) => a.id);
      assert(listed.includes(ids.alertOverdue), "the overdue alert leads the list (earliest clock first)");
      assert(!listed.includes(ids.alertClosed), "closed alerts never appear");
    });

    await t.step("cases: two more, one opened and one closed with a SAR 'file' decision, both in the recent list", async () => {
      assertEq(after.cases.total - before.cases.total, 2, "case total delta");
      const d = (k: string, o: Any, p: Any) => (o?.[k] ?? 0) - (p?.[k] ?? 0);
      assertEq(d("opened", after.cases.by_status, before.cases.by_status), 1, "opened +1");
      assertEq(d("closed", after.cases.by_status, before.cases.by_status), 1, "closed +1");
      assertEq(d("file", after.cases.sar_decisions, before.cases.sar_decisions), 1, "SAR file decisions +1");
      const recentIds = after.cases.recent.map((c: Any) => c.id);
      assert(recentIds.includes(ids.caseOpen) && recentIds.includes(ids.caseDecided), "both cases in recent");
    });

    await t.step("CTR: three more filings, two unfiled, one past its 15-day clock; the filed one is never 'overdue'", async () => {
      assertEq(after.ctr.total - before.ctr.total, 3, "ctr total delta");
      assertEq(after.ctr.unfiled - before.ctr.unfiled, 2, "unfiled delta");
      assertEq(after.ctr.overdue - before.ctr.overdue, 1, "overdue delta (the filed past-due one excluded)");
      const due = after.ctr.due_next.map((c: Any) => c.id);
      assert(due.includes(ids.ctrOverdue) && due.includes(ids.ctrDue), "both unfiled are due next");
      assert(!due.includes(ids.ctrFiled), "the filed one is not");
    });

    await t.step("dual control: one more payment awaiting a second approver; the approved one is not in the queue", async () => {
      assertEq(after.pending_approvals.count - before.pending_approvals.count, 1, "pending delta");
      const q = after.pending_approvals.list.map((a: Any) => a.id);
      assert(q.includes(ids.apPending), "pending approval listed");
      assert(!q.includes(ids.apDone), "decided approval excluded");
    });

    await t.step("unfiltered: open alerts and CTR clocks are the database's counts, and a capped list says it is a sample", async () => {
      const open = await faithful("alerts.open",
        async () => (await dash("/data")).body.alerts.open,
        () => dbCount("bsa_alert", (q) => q.eq("status", "open")));
      assert(open >= 2, "our fixtures are in the unfiltered queue");
      await faithful("alerts.overdue_triage",
        async () => (await dash("/data")).body.alerts.overdue_triage,
        () => dbCount("bsa_alert", (q) => q.eq("status", "open").is("triaged_at", null).lt("triage_due_at", new Date().toISOString())));
      await faithful("ctr.unfiled",
        async () => (await dash("/data")).body.ctr.unfiled,
        () => dbCount("ctr_filing", (q) => q.is("filed_at", null)));
      const a = (await dash("/data")).body.alerts;
      assert(a.listed <= 100, `listed within the list cap (${a.listed})`);
      assertEq(a.capped, a.open > a.listed, "capped iff the queue is larger than the page");
      assertEq(a.by_type_capped, a.open > a.listed, "by_type admits it is a page census");
      if (a.open > 100) assertEq(a.listed, 100, "a queue over 100 lists a full page, and reports the true total beside it");
    });

    await t.step("provenance: the blend sums to the unfiltered queue; ?provenance=production narrows but keeps the blend; junk falls back to all", async () => {
      const all = (await dash("/data")).body;
      const sum = Object.values(all.alerts.by_provenance as Record<string, number>).reduce((n, x) => n + x, 0);
      // equality can be broken by a concurrent alert landing between the counts; retry once
      let ok = sum === all.alerts.open;
      if (!ok) {
        const again = (await dash("/data")).body;
        ok = Object.values(again.alerts.by_provenance as Record<string, number>).reduce((n, x) => n + x, 0) === again.alerts.open;
      }
      assert(ok, `by_provenance sums to the open queue (${JSON.stringify(all.alerts.by_provenance)} vs ${all.alerts.open})`);
      const prod = (await dash("/data?provenance=production")).body;
      assertEq(prod.provenance.filter, "production", "filter echoed");
      assertEq(prod.alerts.open, prod.alerts.by_provenance.production, "the narrowed queue is the production share");
      assert(prod.alerts.by_provenance.unknown >= 2 && prod.alerts.by_provenance.demo >= 0, "the blend is still reported unfiltered");
      const junk = (await dash("/data?provenance=drop-table")).body;
      assertEq(junk.provenance.filter, "all", "an unrecognised value falls back to all, never a silent empty slice");
    });

    await t.step("ops: outbox depth is the true undelivered count, not min(depth, 1000)", async () => {
      const depth = await faithful("ops.outbox_undelivered",
        async () => (await dash("/data")).body.ops.outbox_undelivered,
        () => dbCount("event", (q) => q.is("delivered_at", null)));
      assert(Number.isInteger(depth), "a number");
    });
  } finally {
    // fixtures out, children first; failures are logged, never silently kept
    const del = async (table: string, idsToDrop: string[]) => {
      const live = idsToDrop.filter(Boolean);
      if (!live.length) return;
      const r = await core().from(table).delete().in("id", live);
      if (r.error) console.error(`cleanup ${table} ${live.join(",")}: ${r.error.message}`);
    };
    await del("case", [ids.caseOpen, ids.caseDecided]);
    await del("bsa_alert", [ids.alertOverdue, ids.alertOpen, ids.alertClosed]);
    await del("ctr_filing", [ids.ctrOverdue, ids.ctrDue, ids.ctrFiled]);
    await del("payment_approval", [ids.apPending, ids.apDone]);
    await del("control_result", ids.crs);
  }
});

// ===========================================================================
// 4. the dashboard's one write: flag an event (demo posture → sim scope)
// ===========================================================================

flow("dashboard: an officer flags a monitored event — a real escalation in the SIM scope, acknowledgement window by severity, and refusals write nothing", async (t) => {
  const run = uid();
  const ref = `transfer:dashboard_flag_${run}`;
  let urgent: Any = null;

  await t.step("an urgent flag (no credential, demo posture) routes a named escalation: 201, esc_ id, ack due in one day", async () => {
    const at = Date.now();
    const r = await api("POST", "/compliance/dashboard/flag", {
      resource_ref: ref, event_id: `ev_${run}`, event_code: "transfer.settled", control_uid: "bsa:BSA-10",
      routed_to: "Patrick Wilson, CCO", severity: "urgent", note: "unusual counterparty",
    }, { key: null });
    assertEq(r.status, 201, `flag (${show(r)})`);
    urgent = r.body.data;
    assert(String(urgent.id).startsWith("esc_"), "escalation id");
    assertEq(urgent.routed_to, "Patrick Wilson, CCO", "routed to a named person");
    const due = new Date(urgent.ack_due_at).getTime() - at;
    assert(Math.abs(due - DAY) < 5 * 60_000, `urgent ack due ~1 day out (${urgent.ack_due_at})`);
  });

  await t.step("the escalation and its escalation.routed event are in sim, labelled simulated; core's register is untouched", async () => {
    const esc = await sim().from("escalation").select("*").eq("id", urgent.id).maybeSingle();
    assert(!esc.error && esc.data, `sim.escalation row (${esc.error?.message})`);
    assertEq(esc.data.source_kind, "compliance_dashboard_flag", "source kind");
    assertEq(esc.data.source_ref, ref, "names what was flagged");
    assertEq(esc.data.severity, "urgent", "severity");
    assertEq(esc.data.provenance, "simulated", "simulated, never production evidence");
    assertEq(esc.data.acknowledged_at, null, "awaiting acknowledgement");
    const ev = await sim().from("event").select("*").eq("id", `ev_${urgent.id}_routed`).maybeSingle();
    assert(!ev.error && ev.data, `sim escalation.routed event (${ev.error?.message})`);
    assertEq(ev.data.code, "escalation.routed", "code");
    assertEq(ev.data.payload["escalation.routed_to"], "Patrick Wilson, CCO", "routed_to in the payload");
    assertEq(ev.data.payload.control_uid, "bsa:BSA-10", "names the control");
    assertEq(ev.data.payload.flagged_event, `ev_${run}`, "names the flagged event");
    const c = await core().from("escalation").select("id").eq("id", urgent.id).maybeSingle();
    assertEq(c.data, null, "nothing written to core.escalation");
  });

  await t.step("the dashboard's own trace finds the escalation, labelled sim", async () => {
    const r = await dash(`/trace/escalation:${urgent.id}`);
    assertEq(r.status, 200, `trace (${show(r)})`);
    const e = r.body.events.find((x: Any) => x.code === "escalation.routed");
    assert(e, "escalation.routed in the trace");
    assertEq(e.src, "sim", "labelled as the sim world, never mixed silently");
  });

  await t.step("a routine flag is due later than an urgent one", async () => {
    const r = await api("POST", "/compliance/dashboard/flag", { resource_ref: `${ref}_routine`, routed_to: "officer", severity: "routine" }, { key: null });
    assertEq(r.status, 201, `routine flag (${show(r)})`);
    assert(String(r.body.data.ack_due_at) > String(urgent.ack_due_at), "routine ack after urgent ack");
  });

  await t.step("refusals name the field and write nothing: no recipient, unknown severity, nothing to flag", async () => {
    const cases: [Any, string][] = [
      [{ resource_ref: `${ref}_bad1`, severity: "elevated" }, "routed_to"],
      [{ resource_ref: `${ref}_bad2`, routed_to: "officer", severity: "catastrophic" }, "severity"],
      [{ routed_to: "officer", severity: "routine" }, "resource_ref"],
    ];
    for (const [b, field] of cases) {
      const r = await api("POST", "/compliance/dashboard/flag", b, { key: null });
      assertEq(r.status, 400, `${field} (${show(r)})`);
      assert((r.body.errors ?? []).some((e: Any) => e.field === field), `names ${field}`);
    }
    const left = await sim().from("escalation").select("id").in("source_ref", [`${ref}_bad1`, `${ref}_bad2`]);
    assertEq((left.data ?? []).length, 0, "no escalation written by a refused flag");
  });
});
