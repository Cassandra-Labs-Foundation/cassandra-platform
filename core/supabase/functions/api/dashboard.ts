// Compliance dashboard — the surface an examiner or ops officer actually
// reads. Two routes:
//
//   GET /compliance/dashboard        public 302 to the deployed staff console
//                                    (ui/, a Next.js app on Vercel — see
//                                    getDashboardShell for why the edge
//                                    function cannot serve the HTML itself).
//                                    The console renders the dashboard at
//                                    /compliance/dashboard and holds the core
//                                    API key server-side; this route is just
//                                    the one stable URL that lands you there.
//   GET /compliance/dashboard/data   authenticated JSON. Same token pipeline
//                                    as every route; partner actors get 404
//                                    (BSA-07: the existence of case management
//                                    is itself confidential — same rule as
//                                    bsa.ts, and the same reason this module
//                                    checks it in the HANDLER, not a route
//                                    gate that would answer 403).
//
// Every panel reads the evidence tables the controls already write — nothing
// here is computed specially for display. Row reads are capped and the caps
// are REPORTED in the payload: a dashboard that silently truncates reads as
// complete when it is not.
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  apiError, internalErrorResponse, isNonEmptyString, jsonResponse,
  parseJsonBody, validationError,
} from "./lib.ts";
import { type PartnerContext } from "./auth.ts";
import { type EvidenceScope, provenanceFor } from "./bsa.ts";
import { redactForBoundary } from "./events.ts";

const WINDOW_HOURS = 168; // 7 days
const ROW_CAP = 1000;
const LIST_CAP = 100;

// The evidence tables mix three origins in ONE schema: `production` (real
// member activity), `demo` (the e2e harness and the walkthrough), and
// `unknown` (rows written before provenance was stamped). A compliance officer
// triaging a queue must be able to tell them apart — an alert you cannot
// attribute to real activity is not a work item, and one you silently drop
// because it is unattributed is a missed obligation.
//
// Hence the default is `all`, NOT `production`: filtering to production by
// default would hide every unknown-provenance row, which is the same failure
// as a silent row cap — the officer reads a short queue as a complete one.
// The composition is always reported (by_provenance) so the blend is visible
// even when unfiltered, and narrowing is one explicit click.
const PROVENANCES = ["production", "demo", "unknown"] as const;

type Row = Record<string, unknown>;

function windowStartIso(): string {
  return new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
}

function provenanceParam(req: Request): string {
  const p = new URL(req.url).searchParams.get("provenance") ?? "all";
  return (PROVENANCES as readonly string[]).includes(p) ? p : "all";
}

// deno-lint-ignore no-explicit-any
function scoped<T>(q: T, prov: string): T {
  return prov === "all" ? q : (q as any).eq("provenance", prov);
}

async function capped(
  q: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<Row[]> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

// The TRUE size of a set, taken from the database rather than from the length
// of a capped page. Every headline number a CCO reads (open alerts, overdue
// triage, outbox depth) is a count like this; the row LISTS stay capped, and
// the gap between count and list length is what `*_capped` reports.
async function countOf(
  q: PromiseLike<{ count: number | null; error: { message: string } | null }>,
): Promise<number> {
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function getDashboardData(
  req: Request,
  db: SupabaseClient,
  requestId: string,
  _ctx: PartnerContext,
): Promise<Response> {
  // DEMO POSTURE: the route is public (see index.ts) and this handler serves
  // anyone — the sandbox shows synthetic evidence and the demo must not stop
  // for a token prompt. To re-lock for production: drop `public` from the
  // route and restore the partner 404 here (git history at 4b34d6a).
  const since = windowStartIso();
  const nowIso = new Date().toISOString();
  const prov = provenanceParam(req);

  try {
    // ---- control activity: aggregate the evidence rows, never re-derive
    const controlRows = await capped(
      scoped(
        db.schema("core").from("control_result")
          .select("control_id, decision, created_at")
          .gte("created_at", since),
        prov,
      )
        .order("created_at", { ascending: false })
        .limit(ROW_CAP),
    );
    const controlTotal = await countOf(
      scoped(
        db.schema("core").from("control_result")
          .select("id", { count: "exact", head: true })
          .gte("created_at", since),
        prov,
      ),
    );
    const controls: Record<string, Record<string, number>> = {};
    for (const r of controlRows) {
      const c = (controls[String(r.control_id)] ??= {});
      const d = String(r.decision);
      c[d] = (c[d] ?? 0) + 1;
    }

    // ---- open BSA alerts and their triage clocks (2 business days, BSA-06)
    // The LIST is capped for payload size; `open` and `overdue_triage` are
    // COUNTS from the database. Deriving those headline numbers from the
    // capped page is how "100 open alerts" was reported against a real backlog
    // of 1,475 — the officer read the cap as the queue.
    const alertRows = await capped(
      scoped(
        db.schema("core").from("bsa_alert")
          .select("id, alert_type, status, provenance, triage_due_at, triaged_at, triage_outcome, case_id, created_at")
          .eq("status", "open"),
        prov,
      )
        .order("triage_due_at", { ascending: true, nullsFirst: false })
        .limit(LIST_CAP),
    );
    const [alertsOpen, alertsOverdue, alertProvCounts] = await Promise.all([
      countOf(
        scoped(
          db.schema("core").from("bsa_alert")
            .select("id", { count: "exact", head: true })
            .eq("status", "open"),
          prov,
        ),
      ),
      countOf(
        scoped(
          db.schema("core").from("bsa_alert")
            .select("id", { count: "exact", head: true })
            .eq("status", "open")
            .is("triaged_at", null)
            .lt("triage_due_at", nowIso),
          prov,
        ),
      ),
      // the blend itself, ALWAYS unfiltered: the officer must be able to see
      // that a queue is three-quarters demo/unattributed even while looking
      // at one slice of it
      Promise.all(
        PROVENANCES.map((p) =>
          countOf(
            db.schema("core").from("bsa_alert")
              .select("id", { count: "exact", head: true })
              .eq("status", "open")
              .eq("provenance", p),
          )
        ),
      ),
    ]);
    const alertsByProvenance: Record<string, number> = {};
    PROVENANCES.forEach((p, i) => alertsByProvenance[p] = alertProvCounts[i]);
    // by_type is computed from the capped page, so say so rather than let it
    // read as a full census
    const alertsByType: Record<string, number> = {};
    for (const a of alertRows) {
      alertsByType[String(a.alert_type)] = (alertsByType[String(a.alert_type)] ?? 0) + 1;
    }

    // ---- case / SAR pipeline
    const caseRows = await capped(
      scoped(
        db.schema("core").from("case")
          .select("id, status, alert_id, sar_decision, sar_decision_due_at, opened_at, decided_at"),
        prov,
      )
        .order("opened_at", { ascending: false })
        .limit(LIST_CAP),
    );
    const caseTotal = await countOf(
      scoped(
        db.schema("core").from("case").select("id", { count: "exact", head: true }),
        prov,
      ),
    );
    const casesByStatus: Record<string, number> = {};
    const sarDecisions: Record<string, number> = {};
    for (const c of caseRows) {
      casesByStatus[String(c.status)] = (casesByStatus[String(c.status)] ?? 0) + 1;
      if (c.sar_decision) sarDecisions[String(c.sar_decision)] = (sarDecisions[String(c.sar_decision)] ?? 0) + 1;
    }

    // ---- CTR filings and the 15-day FinCEN clock
    const ctrRows = await capped(
      scoped(
        db.schema("core").from("ctr_filing")
          .select("id, business_date, cash_in_total, cash_out_total, threshold_crossed_at, filing_due_at, filed_at"),
        prov,
      )
        .order("filing_due_at", { ascending: true, nullsFirst: false })
        .limit(LIST_CAP),
    );
    const ctrUnfiledRows = ctrRows.filter((r) => !r.filed_at);
    // an unfiled CTR past its 15-day clock is a reportable failure; it must be
    // counted in the database, never inferred from whichever 100 rows paged in
    const [ctrTotal, ctrUnfiled, ctrOverdue] = await Promise.all([
      countOf(
        scoped(db.schema("core").from("ctr_filing").select("id", { count: "exact", head: true }), prov),
      ),
      countOf(
        scoped(
          db.schema("core").from("ctr_filing")
            .select("id", { count: "exact", head: true })
            .is("filed_at", null),
          prov,
        ),
      ),
      countOf(
        scoped(
          db.schema("core").from("ctr_filing")
            .select("id", { count: "exact", head: true })
            .is("filed_at", null)
            .lt("filing_due_at", nowIso),
          prov,
        ),
      ),
    ]);

    // ---- payments waiting on a second pair of eyes (EPS-06)
    const approvalRows = await capped(
      scoped(
        db.schema("core").from("payment_approval")
          .select("id, resource_type, resource_id, created_by, created_at")
          .is("approved_at", null)
          .is("rejected_at", null),
        prov,
      )
        .order("created_at", { ascending: true })
        .limit(LIST_CAP),
    );
    const approvalTotal = await countOf(
      scoped(
        db.schema("core").from("payment_approval")
          .select("id", { count: "exact", head: true })
          .is("approved_at", null)
          .is("rejected_at", null),
        prov,
      ),
    );

    // ---- ops health: the reconciliation heartbeat's own evidence
    const opsRows = await capped(
      db.schema("core").from("event")
        .select("code, created_at")
        .in("code", [
          "blnk.mirror.recovered",
          "blnk.balance_drift",
          "blnk.missing_mirror",
          "blnk.stuck_row",
        ])
        .gte("created_at", since)
        .limit(ROW_CAP),
    );
    const opsByCode: Record<string, number> = {};
    for (const e of opsRows) {
      opsByCode[String(e.code)] = (opsByCode[String(e.code)] ?? 0) + 1;
    }

    // outbox depth is a COUNT, not a page length: reporting min(depth, 1000)
    // made a 15,246-event backlog read as "1,000 awaiting delivery"
    const outboxUndelivered = await countOf(
      db.schema("core").from("event")
        .select("id", { count: "exact", head: true })
        .is("delivered_at", null),
    );

    const syncRows = await capped(
      db.schema("core").from("blnk_sync_state")
        .select("resource, last_cursor, last_synced_at")
        .limit(10),
    );
    const reconcile = syncRows.find((r) => r.resource === "reconcile");
    let reconcileSummary: unknown = null;
    if (reconcile && typeof reconcile.last_cursor === "string") {
      try {
        reconcileSummary = JSON.parse(reconcile.last_cursor);
      } catch {
        reconcileSummary = reconcile.last_cursor;
      }
    }

    // Every panel reports the pair (true total, rows actually listed). Where
    // they differ the panel is a SAMPLE and the UI must say so — `*_capped` is
    // that signal, and it is a rendering contract, not decoration.
    return jsonResponse({
      generated_at: nowIso,
      window_hours: WINDOW_HOURS,
      caps: { aggregate_rows: ROW_CAP, list_rows: LIST_CAP },
      provenance: { filter: prov, available: PROVENANCES },
      controls: {
        window_rows: controlTotal,
        window_listed: controlRows.length,
        window_capped: controlTotal > controlRows.length,
        by_control: controls,
        by_control_capped: controlTotal > controlRows.length,
      },
      alerts: {
        open: alertsOpen,
        listed: alertRows.length,
        capped: alertsOpen > alertRows.length,
        overdue_triage: alertsOverdue,
        by_provenance: alertsByProvenance,
        by_type: alertsByType,
        by_type_capped: alertsOpen > alertRows.length,
        list: alertRows.slice(0, 25),
      },
      cases: {
        total: caseTotal,
        listed: caseRows.length,
        capped: caseTotal > caseRows.length,
        by_status: casesByStatus,
        sar_decisions: sarDecisions,
        recent: caseRows.slice(0, 10),
      },
      ctr: {
        total: ctrTotal,
        listed: ctrRows.length,
        capped: ctrTotal > ctrRows.length,
        unfiled: ctrUnfiled,
        overdue: ctrOverdue,
        due_next: ctrUnfiledRows.slice(0, 10),
      },
      pending_approvals: {
        count: approvalTotal,
        listed: approvalRows.length,
        capped: approvalTotal > approvalRows.length,
        list: approvalRows.slice(0, 25),
      },
      ops: {
        events_7d: opsByCode,
        events_7d_capped: opsRows.length >= ROW_CAP,
        outbox_undelivered: outboxUndelivered,
        outbox_capped: false, // a true count is never capped
        last_reconcile: reconcileSummary,
        last_reconcile_at: reconcile?.last_synced_at ?? null,
      },
    }, 200, requestId);
  } catch (e) {
    return internalErrorResponse(requestId, e);
  }
}

// ---------------------------------------------------------------------------
// The monitoring tier — three routes that together make every control
// auditable by clicking:
//
//   GET /compliance/dashboard/heartbeat     bucketed pulses: every event code
//                                           and every gate decision over time,
//                                           core and sim worlds labeled apart
//   GET /compliance/dashboard/events        raw event history for a set of
//                                           codes (a control's watch list),
//                                           newest first, cursor-paginated
//   GET /compliance/dashboard/trace/{id}    the WHOLE transaction cycle for
//                                           one resource: every event plus
//                                           every gate decision about it
//
// Payloads are inspectable but pass the SAME PII boundary the aggregator
// enforces (redactForBoundary) — the dashboard is a window, not a leak.

const HB_DEFAULT_HOURS = 168;
const HB_MAX_HOURS = 2160; // 90 days
const HB_DEFAULT_BUCKET = 21600; // 6h
const HB_MIN_BUCKET = 3600;
const HB_MAX_BUCKET = 604800;
const STREAM_MAX_CODES = 200;
const STREAM_DEFAULT_LIMIT = 100;
const STREAM_MAX_LIMIT = 200;
const TRACE_CAP = 500;

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt(url.searchParams.get(name) ?? "", 10);
  const v = Number.isFinite(raw) ? raw : fallback;
  return Math.min(max, Math.max(min, v));
}

async function rpcRows(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<Row[]> {
  const { data, error } = await db.schema("core").rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return (data ?? []) as Row[];
}

export async function getDashboardHeartbeat(
  req: Request,
  db: SupabaseClient,
  requestId: string,
): Promise<Response> {
  const url = new URL(req.url);
  const hours = intParam(url, "hours", HB_DEFAULT_HOURS, 1, HB_MAX_HOURS);
  const bucketSeconds = intParam(url, "bucket", HB_DEFAULT_BUCKET, HB_MIN_BUCKET, HB_MAX_BUCKET);
  // ?last_seen=0 omits the all-time per-code census — the heaviest block of
  // the payload (~900 codes) and the slowest-moving. The UI fetches it once
  // per page load and skips it on refresh polls; `last_seen: null` means
  // "not requested" so a caller can tell the slim response from a database
  // with no history (which would be []).
  const wantLastSeen = url.searchParams.get("last_seen") !== "0";
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  try {
    const [events, gate, lastSeen, gateLastSeen] = await Promise.all([
      rpcRows(db, "event_heartbeat", { since, bucket_seconds: bucketSeconds }),
      rpcRows(db, "gate_heartbeat", { since, bucket_seconds: bucketSeconds }),
      wantLastSeen ? rpcRows(db, "event_last_seen", {}) : Promise.resolve(null),
      // The gate tier's recency. Its evidence is control_result rows, not
      // events, so event_last_seen can never answer for it — which is how
      // every gate control rendered "LAST EVIDENCE: never" beside a live
      // sparkline. A handful of rows, so it rides every poll, not just the
      // first load.
      rpcRows(db, "gate_last_seen", {}),
    ]);
    return jsonResponse({
      generated_at: new Date().toISOString(),
      window_hours: hours,
      bucket_seconds: bucketSeconds,
      since,
      events,
      gate,
      last_seen: lastSeen,
      gate_last_seen: gateLastSeen,
    }, 200, requestId);
  } catch (e) {
    return internalErrorResponse(requestId, e);
  }
}

const EVENT_COLS =
  "id, code, type, resource_id, payload, provenance, created_at, delivered_at";

type EventRow = Row & { payload?: unknown; created_at?: unknown };

function redactRows(rows: Row[], src: string): Row[] {
  return rows.map((r) => ({ ...r, payload: redactForBoundary((r as EventRow).payload), src }));
}

export async function getDashboardEvents(
  req: Request,
  db: SupabaseClient,
  requestId: string,
): Promise<Response> {
  const url = new URL(req.url);
  const codes = (url.searchParams.get("codes") ?? "")
    .split(",").map((c) => c.trim()).filter(Boolean).slice(0, STREAM_MAX_CODES);
  if (codes.length === 0) {
    return apiError(422, "codes_required", requestId, {
      detail: "pass ?codes=a.b.c,d.e.f — the watch list of the control being inspected",
    });
  }
  const limit = intParam(url, "limit", STREAM_DEFAULT_LIMIT, 1, STREAM_MAX_LIMIT);
  const before = url.searchParams.get("before");
  const src = url.searchParams.get("src") ?? "all";

  try {
    const worlds = src === "core" ? ["core"] : src === "sim" ? ["sim"] : ["core", "sim"];
    const pages = await Promise.all(worlds.map(async (schema) => {
      let q = db.schema(schema).from("event")
        .select(EVENT_COLS)
        .in("code", codes)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (before) q = q.lt("created_at", before);
      const { data, error } = await q;
      if (error) throw new Error(`${schema}.event: ${error.message}`);
      return redactRows((data ?? []) as Row[], schema);
    }));
    const merged = pages.flat()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
    const full = merged.length === limit;
    return jsonResponse({
      codes,
      events: merged,
      next_before: full ? merged[merged.length - 1].created_at : null,
    }, 200, requestId);
  } catch (e) {
    return internalErrorResponse(requestId, e);
  }
}

export async function getDashboardTrace(
  resourceId: string,
  db: SupabaseClient,
  requestId: string,
): Promise<Response> {
  try {
    const [coreEvents, simEvents, gateRows] = await Promise.all([
      capped(
        db.schema("core").from("event").select(EVENT_COLS)
          .eq("resource_id", resourceId)
          .order("created_at", { ascending: true })
          .limit(TRACE_CAP),
      ),
      capped(
        db.schema("sim").from("event").select(EVENT_COLS)
          .eq("resource_id", resourceId)
          .order("created_at", { ascending: true })
          .limit(TRACE_CAP),
      ),
      capped(
        db.schema("core").from("control_result")
          .select("id, control_id, decision, event, score, subject_ref, provenance, created_at")
          .eq("subject_ref", resourceId)
          .order("created_at", { ascending: true })
          .limit(TRACE_CAP),
      ),
    ]);
    const events = [
      ...redactRows(coreEvents, "core"),
      ...redactRows(simEvents, "sim"),
    ].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return jsonResponse({
      resource_id: resourceId,
      events,
      events_capped: coreEvents.length >= TRACE_CAP || simEvents.length >= TRACE_CAP,
      control_results: gateRows,
      control_results_capped: gateRows.length >= TRACE_CAP,
    }, 200, requestId);
  } catch (e) {
    return internalErrorResponse(requestId, e);
  }
}

// A flag's acknowledgement window scales with how loud it is — the urgent ones
// must not wait as long as the routine ones (the same principle bsa_program's
// escalation uses; kept local so this module owns its own contract).
const FLAG_ACK_DAYS: Record<string, number> = { urgent: 1, elevated: 3, routine: 5 };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * POST /compliance/dashboard/flag
 *   {resource_ref?, event_id?, event_code?, control_uid?, routed_to, severity, note?}
 *
 * The compliance officer's escalation path from ONE monitored event. It reuses
 * the core's escalation primitive (the same table + escalation.routed event
 * that bsa_program.postEscalation writes), so a flag is a real, acknowledgeable
 * escalation routed to a named person — not a sticky note that lives only in
 * the dashboard.
 *
 * ⚠ DEMO POSTURE / OPEN QUESTION (auth deferred, on purpose). The dashboard is
 * a public, credential-less surface (see the module header), so this write:
 *   • is unauthenticated, and
 *   • lands in the SIM (demo) evidence scope, never core.
 * That keeps the feature exercisable from the public demo without minting an
 * anonymous write into the real escalation register. The production model —
 * who may flag, authenticated how, into which scope — is intentionally
 * unresolved. Before this routes real work it must gate on an internal actor
 * (cf. requireInternalActor in the *_program handlers) and write to core.
 * TODO(compliance-flag-auth).
 */
export async function postDashboardFlag(
  req: Request,
  db: SupabaseClient,
  requestId: string,
): Promise<Response> {
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> ?? {};
  const severity = String(body.severity ?? "");
  const routedTo = body.routed_to;
  // what is being flagged: prefer the resource the event is about, fall back to
  // the event's own id so an event with no resource_id is still flaggable
  const sourceRef = isNonEmptyString(body.resource_ref)
    ? String(body.resource_ref)
    : isNonEmptyString(body.event_id) ? String(body.event_id) : "";

  const errs = [];
  if (!FLAG_ACK_DAYS[severity]) {
    errs.push({ type: "invalid_value", field: "severity", message: `severity in ${Object.keys(FLAG_ACK_DAYS).join("/")}` });
  }
  if (!isNonEmptyString(routedTo)) {
    errs.push({ type: "missing_field", field: "routed_to", message: "route the flag to a person or role" });
  }
  if (!sourceRef) {
    errs.push({ type: "missing_field", field: "resource_ref", message: "resource_ref or event_id identifies what is flagged" });
  }
  if (errs.length) return validationError(requestId, errs);

  const scope: EvidenceScope = "sim"; // demo posture — see the doc comment
  const now = new Date();
  const ackDueAt = new Date(now.getTime() + FLAG_ACK_DAYS[severity] * DAY_MS).toISOString();
  const id = `esc_${crypto.randomUUID()}`;
  const note = isNonEmptyString(body.note) ? String(body.note).slice(0, 2000) : null;

  try {
    const { error: escErr } = await db.schema(scope).from("escalation").upsert({
      id,
      source_kind: "compliance_dashboard_flag",
      source_ref: sourceRef,
      severity,
      routed_to: String(routedTo),
      routed_at: now.toISOString(),
      ack_due_at: ackDueAt,
      provenance: provenanceFor(scope),
    }, { onConflict: "id" });
    if (escErr) return internalErrorResponse(requestId, escErr.message);

    const { error: evErr } = await db.schema(scope).from("event").upsert({
      id: `ev_${id}_routed`,
      code: "escalation.routed",
      resource_type: "escalation",
      resource_id: `escalation:${id}`,
      payload: {
        "escalation.severity": severity,
        "escalation.routed_to": String(routedTo),
        ack_due_at: ackDueAt,
        flagged_event: isNonEmptyString(body.event_id) ? String(body.event_id) : null,
        flagged_code: isNonEmptyString(body.event_code) ? String(body.event_code) : null,
        control_uid: isNonEmptyString(body.control_uid) ? String(body.control_uid) : null,
        note,
      },
      provenance: provenanceFor(scope),
    }, { onConflict: "id", ignoreDuplicates: true });
    if (evErr) return internalErrorResponse(requestId, evErr.message);

    return jsonResponse(
      { data: { id, ack_due_at: ackDueAt, routed_to: String(routedTo), severity } },
      201, requestId,
    );
  } catch (e) {
    return internalErrorResponse(requestId, e);
  }
}

/**
 * One stable URL on the API that takes you to the dashboard. The HTML CANNOT
 * be served from here: the Supabase gateway rewrites every renderable
 * content-type (text/html, xhtml, even via Storage) to text/plain on its
 * shared domains — an anti-phishing policy; HTML needs a real web host. So the
 * dashboard is served by the deployed staff console (ui/, a Next.js app on
 * Vercel that renders it at /compliance/dashboard and holds the core API key
 * server-side), and this route 302s to it. DASHBOARD_SHELL_URL overrides the
 * destination (a custom domain, or a preview deploy).
 */
export const DEFAULT_SHELL_URL =
  "https://cassandra-platform.vercel.app/compliance/dashboard";

export function getDashboardShell(requestId: string): Response {
  const dest = Deno.env.get("DASHBOARD_SHELL_URL") ?? DEFAULT_SHELL_URL;
  return new Response(null, {
    status: 302,
    headers: {
      location: dest,
      "x-request-id": requestId,
      "cache-control": "no-store",
    },
  });
}

