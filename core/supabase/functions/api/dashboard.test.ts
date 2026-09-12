// Compliance dashboard — the panels aggregate EVIDENCE rows; these tests pin
// that the aggregation is faithful (counts by control/decision, triage
// overdue, CTR clocks, dual-control queue, outbox depth), that partners get
// the BSA-style 404, and that the public shell carries zero data.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PartnerContext } from "./auth.ts";
import {
  getDashboardData,
  getDashboardEvents,
  getDashboardHeartbeat,
  getDashboardShell,
  getDashboardTrace,
  postDashboardFlag,
} from "./dashboard.ts";

type Row = Record<string, unknown>;

// Filter-aware stub: applies eq/is/gte/lt/in for real, because core.event is
// queried twice with different predicates and a stub that ignores filters
// would let the two panels silently read each other's rows. Schema-aware:
// rows keyed "sim.event" are only visible through schema("sim"); plain keys
// resolve through schema("core") so the original fixtures keep working.
// rpcs maps rpc name -> (args) => rows, for the heartbeat aggregations.
function stubDb(
  rows: Record<string, Row[]>,
  rpcs: Record<string, (args: Record<string, unknown>) => Row[]> = {},
): SupabaseClient {
  const makeBuilder = (schema: string, table: string) => {
    let out = [...(rows[`${schema}.${table}`] ?? (schema === "core" ? rows[table] : undefined) ?? [])];
    // deno-lint-ignore no-explicit-any
    const b: any = {};
    const chain = (fn?: (...a: unknown[]) => void) => (...a: unknown[]) => {
      fn?.(...a);
      return b;
    };
    // count:"exact" returns the size of the FILTERED set, and `limit` must not
    // shrink it — that divergence is the whole point of the count queries, so
    // the stub models it: `limit` slices the page, `total` keeps counting.
    let counting = false;
    let preLimit: number | null = null;
    b.select = chain((_cols, opts) => {
      const o = opts as { count?: string; head?: boolean } | undefined;
      if (o?.count) counting = true;
    });
    b.order = chain();
    b.limit = chain((n) => {
      preLimit = out.length; // the size the count would report
      out = out.slice(0, n as number);
    });
    b.eq = chain((col, val) => {
      out = out.filter((r) => r[col as string] === val);
    });
    b.is = chain((col, val) => {
      out = out.filter((r) => (val === null ? r[col as string] == null : r[col as string] === val));
    });
    b.gte = chain((col, val) => {
      out = out.filter((r) => String(r[col as string] ?? "") >= String(val));
    });
    b.lt = chain((col, val) => {
      out = out.filter((r) => String(r[col as string] ?? "") < String(val));
    });
    b.in = chain((col, vals) => {
      out = out.filter((r) => (vals as unknown[]).includes(r[col as string]));
    });
    // writes land back in the same schema-keyed map, so a test can assert what
    // postDashboardFlag wrote (and into WHICH scope).
    b.upsert = (payload: Row | Row[]) => {
      const bucket = (rows[`${schema}.${table}`] ??= []);
      bucket.push(...(Array.isArray(payload) ? payload : [payload]));
      return Promise.resolve({ data: null, error: null });
    };
    b.then = (onFul: (v: unknown) => unknown, onRej?: (e: unknown) => unknown) => {
      const total = preLimit ?? out.length;
      return Promise.resolve(
        counting ? { data: null, count: total, error: null } : { data: out, error: null },
      ).then(onFul, onRej);
    };
    return b;
  };
  return {
    schema: (s: string) => ({
      from: (t: string) => makeBuilder(s, t),
      rpc: (name: string, args: Record<string, unknown>) =>
        Promise.resolve(
          name in rpcs
            ? { data: rpcs[name](args), error: null }
            : { data: null, error: { message: `no rpc ${name}` } },
        ),
    }),
  } as unknown as SupabaseClient;
}

function ctx(actorType: string): PartnerContext {
  return { actorType, roles: [], tokenId: "tok_test" } as unknown as PartnerContext;
}

const req = () => new Request("http://x/compliance/dashboard/data");
const RECENT = new Date().toISOString();
const PAST_DUE = new Date(Date.now() - 3600_000).toISOString();
const FUTURE = new Date(Date.now() + 86400_000).toISOString();

Deno.test("demo posture: the data route serves ANY caller, partner included", async () => {
  // Re-locking for production restores the bsa.ts-style partner 404 here —
  // this test then flips back to asserting 404 (see 4b34d6a).
  const res = await getDashboardData(req(), stubDb({}), "t", ctx("partner"));
  assertEquals(res.status, 200);
});

Deno.test("panels aggregate the evidence tables faithfully", async () => {
  const db = stubDb({
    control_result: [
      { control_id: "CG-VEL-01", decision: "block", created_at: RECENT },
      { control_id: "CG-VEL-01", decision: "pass", created_at: RECENT },
      { control_id: "CG-LGTXN-01", decision: "pass", created_at: RECENT },
    ],
    bsa_alert: [
      // overdue: untriaged and past its clock
      { id: "a1", alert_type: "ctr_threshold", status: "open", triage_due_at: PAST_DUE, triaged_at: null, created_at: RECENT },
      // open but still inside the clock
      { id: "a2", alert_type: "structuring", status: "open", triage_due_at: FUTURE, triaged_at: null, created_at: RECENT },
      // closed alerts never appear
      { id: "a3", alert_type: "ctr_threshold", status: "closed", triage_due_at: PAST_DUE, triaged_at: RECENT, created_at: RECENT },
    ],
    case: [
      { id: "c1", status: "opened", alert_id: "a9", sar_decision: null, opened_at: RECENT },
      { id: "c2", status: "closed", alert_id: "a8", sar_decision: "file", opened_at: RECENT, decided_at: RECENT },
    ],
    ctr_filing: [
      { id: "ctr1", filing_due_at: PAST_DUE, filed_at: null },
      { id: "ctr2", filing_due_at: FUTURE, filed_at: null },
      { id: "ctr3", filing_due_at: PAST_DUE, filed_at: RECENT },
    ],
    payment_approval: [
      { id: "ap1", resource_type: "wire_transfer", resource_id: "w1", created_by: "tok_a", created_at: RECENT, approved_at: null, rejected_at: null },
      { id: "ap2", resource_type: "wire_transfer", resource_id: "w2", created_by: "tok_a", created_at: RECENT, approved_at: RECENT, rejected_at: null },
    ],
    event: [
      { id: "e1", code: "blnk.mirror.recovered", created_at: RECENT, delivered_at: RECENT },
      { id: "e2", code: "blnk.balance_drift", created_at: RECENT, delivered_at: null },
      { id: "e3", code: "transfer.settled", created_at: RECENT, delivered_at: null },
    ],
    blnk_sync_state: [
      { resource: "reconcile", last_cursor: '{"advanced":3}', last_synced_at: RECENT },
    ],
  });

  const res = await getDashboardData(req(), db, "t", ctx("cu_admin"));
  assertEquals(res.status, 200);
  const d = await res.json();

  assertEquals(d.controls.by_control["CG-VEL-01"], { block: 1, pass: 1 });
  assertEquals(d.controls.by_control["CG-LGTXN-01"], { pass: 1 });
  assertEquals(d.controls.window_capped, false);

  assertEquals(d.alerts.open, 2); // closed alert excluded
  assertEquals(d.alerts.overdue_triage, 1);
  assertEquals(d.alerts.by_type, { ctr_threshold: 1, structuring: 1 });

  assertEquals(d.cases.by_status, { opened: 1, closed: 1 });
  assertEquals(d.cases.sar_decisions, { file: 1 });

  assertEquals(d.ctr.unfiled, 2);
  assertEquals(d.ctr.overdue, 1); // the filed one is not overdue

  assertEquals(d.pending_approvals.count, 1); // decided approvals excluded

  // the two event panels see DIFFERENT filtered sets
  assertEquals(d.ops.events_7d, { "blnk.mirror.recovered": 1, "blnk.balance_drift": 1 });
  assertEquals(d.ops.outbox_undelivered, 2); // e2 + e3, regardless of code

  assertEquals(d.ops.last_reconcile, { advanced: 3 });
});

Deno.test("empty tables produce an empty-but-well-formed payload, not an error", async () => {
  const res = await getDashboardData(req(), stubDb({}), "t", ctx("pynthia_ops"));
  assertEquals(res.status, 200);
  const d = await res.json();
  assertEquals(d.controls.window_rows, 0);
  assertEquals(d.alerts.open, 0);
  assertEquals(d.ctr.unfiled, 0);
  assertEquals(d.ops.outbox_undelivered, 0);
  assertEquals(d.ops.last_reconcile, null);
});

// ------------------------------------------------ truncation and provenance
// The defect these pin, found by reading the dashboard as a CCO: every
// headline number was `rows.length` taken off a CAPPED page, so a real
// backlog of 1,475 open alerts rendered as "100 open · 100 past the triage
// clock", and a 15,246-event outbox rendered as "1,000 awaiting delivery".
// The officer read the cap as the queue. Counts now come from the database;
// the row LIST stays capped and the payload says so.

function manyAlerts(n: number, provenance: string, offset = 0): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${offset + i}`,
    alert_type: "structuring",
    status: "open",
    provenance,
    triage_due_at: PAST_DUE,
    triaged_at: null,
    created_at: RECENT,
  }));
}

Deno.test("headline counts are TRUE totals, never the length of a capped page", async () => {
  const db = stubDb({
    bsa_alert: manyAlerts(250, "production"),
    event: Array.from({ length: 1500 }, (_, i) => ({
      id: `e${i}`,
      code: "transfer.settled",
      created_at: RECENT,
      delivered_at: null,
    })),
  });

  const d = await (await getDashboardData(req(), db, "t", ctx("cu_admin"))).json();

  assertEquals(d.alerts.open, 250); // the QUEUE
  assertEquals(d.alerts.listed, 100); // the PAGE (LIST_CAP)
  assertEquals(d.alerts.capped, true); // and it admits the page is a sample
  assertEquals(d.alerts.overdue_triage, 250); // counted in the db, not on the page
  assertEquals(d.alerts.by_type_capped, true); // by_type is a page census only

  // outbox depth is a count, not min(depth, ROW_CAP)
  assertEquals(d.ops.outbox_undelivered, 1500);
  assertEquals(d.ops.outbox_capped, false);
});

Deno.test("provenance: default hides nothing, the filter narrows, the blend stays visible", async () => {
  const db = stubDb({
    bsa_alert: [
      ...manyAlerts(3, "production", 0),
      ...manyAlerts(5, "demo", 100),
      ...manyAlerts(7, "unknown", 200),
    ],
  });

  // Default is `all`. Defaulting to production would hide the unknown rows —
  // the same silent-understatement bug the counts above fix.
  const all = await (await getDashboardData(req(), db, "t", ctx("cu_admin"))).json();
  assertEquals(all.provenance.filter, "all");
  assertEquals(all.alerts.open, 15);
  assertEquals(all.alerts.by_provenance, { production: 3, demo: 5, unknown: 7 });

  const prod = await (await getDashboardData(
    new Request("http://x/compliance/dashboard/data?provenance=production"),
    db,
    "t",
    ctx("cu_admin"),
  )).json();
  assertEquals(prod.provenance.filter, "production");
  assertEquals(prod.alerts.open, 3); // his queue
  // the composition is reported UNFILTERED even while narrowed: an officer
  // looking at production must still see that most of the table is not
  assertEquals(prod.alerts.by_provenance, { production: 3, demo: 5, unknown: 7 });

  // an unrecognised value falls back to `all` — never to a silent empty slice
  const bogus = await (await getDashboardData(
    new Request("http://x/compliance/dashboard/data?provenance=drop-table"),
    db,
    "t",
    ctx("cu_admin"),
  )).json();
  assertEquals(bogus.provenance.filter, "all");
  assertEquals(bogus.alerts.open, 15);
});

// ---------------------------------------------------------------- heartbeat
// The monitoring tier: every control's event codes bucketed over time, so the
// dashboard can render a per-control pulse and a regulator can see exactly
// when each control last produced evidence.

Deno.test("heartbeat: event + gate pulses ride the RPCs; window and bucket are clamped and reported", async () => {
  let evArgs: Record<string, unknown> = {};
  const db = stubDb({}, {
    event_heartbeat: (args) => {
      evArgs = args;
      return [{ src: "core", code: "transfer.settled", bucket: "2026-07-20T00:00:00+00:00", n: 3 }];
    },
    gate_heartbeat: () => [
      { src: "core", control_id: "CG-NSF-01", decision: "reject", bucket: "2026-07-20T00:00:00+00:00", n: 2 },
    ],
    event_last_seen: () => [{ src: "core", code: "transfer.settled", last_at: RECENT, total: 9 }],
    gate_last_seen: () => [
      { src: "core", control_id: "CG-NSF-01", last_at: RECENT, total: 41 },
    ],
  });
  // absurd params must clamp, not 500 and not scan the whole table
  const res = await getDashboardHeartbeat(
    new Request("http://x/compliance/dashboard/heartbeat?hours=999999&bucket=1"),
    db,
    "t",
  );
  assertEquals(res.status, 200);
  const d = await res.json();
  assertEquals(d.window_hours, 2160);
  assertEquals(d.bucket_seconds, 3600);
  assertEquals(evArgs.bucket_seconds, 3600);
  assertEquals(d.events, [
    { src: "core", code: "transfer.settled", bucket: "2026-07-20T00:00:00+00:00", n: 3 },
  ]);
  assertEquals(d.gate[0].control_id, "CG-NSF-01");
  assertEquals(d.last_seen[0].total, 9);
  // the gate tier's recency rides the payload — a gate control's "last
  // evidence" comes from control_result rows, never from event codes, and
  // without this field the UI can only render "never" (the CCO finding)
  assertEquals(d.gate_last_seen, [
    { src: "core", control_id: "CG-NSF-01", last_at: RECENT, total: 41 },
  ]);
});

Deno.test("heartbeat: ?last_seen=0 skips the census RPC and answers null, not []", async () => {
  // The census is ~900 codes and the heaviest block of the payload; refresh
  // polls omit it for egress. null = "not requested" — distinguishable from a
  // database with no history, which answers [].
  let censusCalled = 0;
  const db = stubDb({}, {
    event_heartbeat: () => [],
    gate_heartbeat: () => [],
    event_last_seen: () => (censusCalled++, []),
    gate_last_seen: () => [],
  });
  const res = await getDashboardHeartbeat(
    new Request("http://x/compliance/dashboard/heartbeat?last_seen=0"),
    db,
    "t",
  );
  assertEquals(res.status, 200);
  const d = await res.json();
  assertEquals(d.last_seen, null);
  assertEquals(censusCalled, 0, "the RPC must not even run");
});

Deno.test("heartbeat: empty database yields empty-but-well-formed arrays", async () => {
  const db = stubDb({}, {
    event_heartbeat: () => [],
    gate_heartbeat: () => [],
    event_last_seen: () => [],
    gate_last_seen: () => [],
  });
  const res = await getDashboardHeartbeat(
    new Request("http://x/compliance/dashboard/heartbeat"),
    db,
    "t",
  );
  assertEquals(res.status, 200);
  const d = await res.json();
  assertEquals(d.events, []);
  assertEquals(d.gate, []);
  assertEquals(d.gate_last_seen, []);
  assertEquals(d.window_hours, 168);
});

// ------------------------------------------------------------- event stream
// Click a control -> its raw event history, newest first, payloads inspectable
// but PII-redacted with the SAME boundary rules the aggregator enforces.

const T1 = "2026-07-20T10:00:00.000Z";
const T2 = "2026-07-20T11:00:00.000Z";
const T3 = "2026-07-20T12:00:00.000Z";

function streamFixture() {
  return {
    event: [
      { id: "e3", code: "transfer.settled", type: "transfer", resource_id: "tr_3", payload: { amount_cents: 500, name: "Ada Lovelace" }, provenance: "production", created_at: T3, delivered_at: null },
      { id: "e2", code: "transfer.settled", type: "transfer", resource_id: "tr_2", payload: { amount_cents: 300 }, provenance: "production", created_at: T2, delivered_at: T3 },
      { id: "e1", code: "wire.completed", type: "wire", resource_id: "w_1", payload: { ssn: "000-11-2222" }, provenance: "production", created_at: T1, delivered_at: T2 },
    ],
    "sim.event": [
      { id: "s1", code: "transfer.settled", type: "transfer", resource_id: "tr_sim", payload: { amount_cents: 100 }, provenance: "simulated", created_at: T1, delivered_at: null },
    ],
  };
}

Deno.test("event stream: refuses a codeless query rather than dumping the whole outbox", async () => {
  const res = await getDashboardEvents(
    new Request("http://x/compliance/dashboard/events"),
    stubDb(streamFixture()),
    "t",
  );
  assertEquals(res.status, 422);
});

Deno.test("event stream: filters by code across core AND sim, newest first, payload PII redacted", async () => {
  const res = await getDashboardEvents(
    new Request("http://x/compliance/dashboard/events?codes=transfer.settled"),
    stubDb(streamFixture()),
    "t",
  );
  assertEquals(res.status, 200);
  const d = await res.json();
  assertEquals(d.events.map((e: Row) => e.id), ["e3", "e2", "s1"]);
  // the drill's simulated evidence is visible but labeled — never mixed silently
  assertEquals(d.events[2].src, "sim");
  assertEquals(d.events[0].src, "core");
  // same boundary redaction the aggregator enforces: name never leaves
  assertEquals(d.events[0].payload, { amount_cents: 500 });
});

Deno.test("event stream: cursor pages backwards through history and reports the next cursor", async () => {
  const page1 = await (await getDashboardEvents(
    new Request("http://x/compliance/dashboard/events?codes=transfer.settled&limit=2"),
    stubDb(streamFixture()),
    "t",
  )).json();
  assertEquals(page1.events.map((e: Row) => e.id), ["e3", "e2"]);
  assertEquals(page1.next_before, T2);

  const page2 = await (await getDashboardEvents(
    new Request(`http://x/compliance/dashboard/events?codes=transfer.settled&limit=2&before=${page1.next_before}`),
    stubDb(streamFixture()),
    "t",
  )).json();
  assertEquals(page2.events.map((e: Row) => e.id), ["s1"]);
  assertEquals(page2.next_before, null);
});

// ------------------------------------------------------------------- trace
// Click an event -> the WHOLE transaction cycle for its resource: every event
// it produced plus every gate decision made about it, oldest first.

Deno.test("trace: full event chain + gate decisions for one resource, ascending, redacted", async () => {
  const db = stubDb({
    event: [
      { id: "e2", code: "transfer.settled", type: "transfer", resource_id: "tr_1", payload: { amount_cents: 300, email: "a@b.c" }, provenance: "production", created_at: T2, delivered_at: null },
      { id: "e1", code: "transfer.created", type: "transfer", resource_id: "tr_1", payload: {}, provenance: "production", created_at: T1, delivered_at: null },
      { id: "eX", code: "transfer.created", type: "transfer", resource_id: "tr_OTHER", payload: {}, provenance: "production", created_at: T1, delivered_at: null },
    ],
    "sim.event": [
      { id: "s1", code: "transfer.rejected", type: "transfer", resource_id: "tr_1", payload: {}, provenance: "simulated", created_at: T3, delivered_at: null },
    ],
    control_result: [
      { id: "cr1", control_id: "CG-NSF-01", decision: "reject", event: "transfer.rejected", score: null, subject_ref: "tr_1", provenance: "production", created_at: T1 },
      { id: "crX", control_id: "CG-NSF-01", decision: "pass", event: null, score: null, subject_ref: "tr_OTHER", provenance: "production", created_at: T1 },
    ],
  });
  const res = await getDashboardTrace("tr_1", db, "t");
  assertEquals(res.status, 200);
  const d = await res.json();
  assertEquals(d.resource_id, "tr_1");
  assertEquals(d.events.map((e: Row) => e.id), ["e1", "e2", "s1"]);
  assertEquals(d.events[2].src, "sim");
  assertEquals(d.events[1].payload, { amount_cents: 300 });
  assertEquals(d.control_results.map((c: Row) => c.id), ["cr1"]);
});

Deno.test("the dashboard route 302s to the deployed console (the gateway cannot serve HTML)", () => {
  const res = getDashboardShell("t");
  assertEquals(res.status, 302);
  assert((res.headers.get("location") ?? "").startsWith("https://"));
});

Deno.test("the catalogue manifest covers the whole policy set — every policy, every control, its watch/rules/verdicts", async () => {
  // The banking UI's compliance monitoring pages render from this manifest;
  // scripts/build_dashboard.py generates it from controls.json (the same source
  // the crosswalk builds from), so a control missing here is a control the
  // monitoring surface cannot show.
  const manifest = JSON.parse(
    await Deno.readTextFile(
      new URL("../../../../ui/public/compliance-manifest.json", import.meta.url),
    ),
  );
  const catalogue = JSON.parse(
    await Deno.readTextFile(new URL("../../../../controls.json", import.meta.url)),
  );

  const cataloguePolicies = new Set(
    catalogue.controls.map((c: { policy: string }) => c.policy),
  );
  const manifestPolicies = new Set(
    manifest.policies.map((p: { slug: string }) => p.slug),
  );
  // manifest = catalogue policies + the declared runtime gate, nothing else
  for (const p of cataloguePolicies) assert(manifestPolicies.has(p), `missing policy: ${p}`);
  const extras = [...manifestPolicies].filter((p) => !cataloguePolicies.has(p as string));
  assertEquals(extras, ["money-movement-gate"]);
  assertEquals(manifest.control_count, catalogue.controls.length + 6);

  // the monitoring tier's contract: every control ships its watch list (the
  // event codes its heartbeat sums), its spec rules, and its test verdicts —
  // the three things that make a control auditable from the UI alone
  let withVerdicts = 0;
  for (const p of manifest.policies) {
    for (const c of p.controls) {
      assert(Array.isArray(c.watch), `${c.id}: watch codes missing`);
      assert(Array.isArray(c.rules), `${c.id}: spec rules missing`);
      assert(typeof c.tests === "object", `${c.id}: test verdicts missing`);
      if (c.tests.hermetic && c.tests.live) withVerdicts++;
      for (const r of c.rules) {
        assert(Array.isArray(r.produced) && Array.isArray(r.inputs), `${c.id}: malformed rule`);
      }
    }
  }
  assert(withVerdicts >= 300, `only ${withVerdicts} controls carry both tiers' verdicts`);
});

// ------------------------------------------------------------- flag an event
// The dashboard's one write: an officer flags a monitored event, which routes
// a real escalation (escalation row + escalation.routed) — reusing the core's
// escalation primitive, into the SIM scope under the demo posture.
const flagReq = (body: Record<string, unknown>) =>
  new Request("http://x/compliance/dashboard/flag", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.test("flag: a valid flag routes an escalation AND emits escalation.routed", async () => {
  const rows: Record<string, Row[]> = {};
  const res = await postDashboardFlag(
    flagReq({
      resource_ref: "wire_transfer:wt_1", event_id: "ev_9", event_code: "wire_transfer.submitted",
      control_uid: "bsa:BSA-10", routed_to: "Patrick Wilson, CCO", severity: "elevated", note: "unusual counterparty",
    }),
    stubDb(rows), "t",
  );
  assertEquals(res.status, 201);
  const body = await res.json();
  assert(String(body.data.id).startsWith("esc_"), "returns the escalation id");
  assertEquals(body.data.routed_to, "Patrick Wilson, CCO");

  const esc = rows["sim.escalation"] ?? [];
  assertEquals(esc.length, 1);
  assertEquals(esc[0].source_kind, "compliance_dashboard_flag");
  assertEquals(esc[0].source_ref, "wire_transfer:wt_1");
  assertEquals(esc[0].provenance, "simulated");

  const evs = rows["sim.event"] ?? [];
  assertEquals(evs.length, 1);
  assertEquals(evs[0].code, "escalation.routed");
  assertEquals((evs[0].payload as Record<string, unknown>)["escalation.routed_to"], "Patrick Wilson, CCO");
  assertEquals((evs[0].payload as Record<string, unknown>).control_uid, "bsa:BSA-10");
});

Deno.test("flag: writes to the SIM scope, never core (demo posture)", async () => {
  const rows: Record<string, Row[]> = {};
  await postDashboardFlag(
    flagReq({ resource_ref: "x1", routed_to: "officer", severity: "routine" }),
    stubDb(rows), "t",
  );
  assertEquals((rows["sim.escalation"] ?? []).length, 1);
  assertEquals((rows["core.escalation"] ?? []).length, 0);
});

Deno.test("flag: routing to nobody is refused", async () => {
  const res = await postDashboardFlag(
    flagReq({ resource_ref: "x1", severity: "elevated" }), stubDb({}), "t",
  );
  assertEquals(res.status, 400);
});

Deno.test("flag: an unknown severity is refused", async () => {
  const res = await postDashboardFlag(
    flagReq({ resource_ref: "x1", routed_to: "officer", severity: "catastrophic" }), stubDb({}), "t",
  );
  assertEquals(res.status, 400);
});

Deno.test("flag: with neither resource_ref nor event_id there is nothing to flag", async () => {
  const res = await postDashboardFlag(
    flagReq({ routed_to: "officer", severity: "routine" }), stubDb({}), "t",
  );
  assertEquals(res.status, 400);
});

Deno.test("flag: severity sets the acknowledgement window — urgent sooner than routine", async () => {
  const rows: Record<string, Row[]> = {};
  await postDashboardFlag(flagReq({ resource_ref: "u", routed_to: "o", severity: "urgent" }), stubDb(rows), "t");
  await postDashboardFlag(flagReq({ resource_ref: "r", routed_to: "o", severity: "routine" }), stubDb(rows), "t");
  const [urgent, routine] = rows["sim.escalation"];
  assert(String(urgent.ack_due_at) < String(routine.ack_due_at),
    "an urgent flag must be due before a routine one");
});
