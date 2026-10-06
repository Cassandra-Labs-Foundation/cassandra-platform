# Coverage ledger: `core/supabase/functions/api/dashboard.test.ts` → dashboard flows

Every `Deno.test` in the stubbed unit file is listed below with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/dashboard.test.ts`. Run them with `scripts/flow.sh -f dashboard: --no-deploy`. The flows also port sections 38
("compliance dashboard: public shell, authenticated data, partner blind") and 47 ("the monitoring dashboard is a faithful audit
surface") of `core/supabase/tests/e2e/compliance_e2e.sh`.

Disposition key: `flow` (covered by a flow step), `added` (a step written to close a gap), `contract` (HTTP shape only), `drop` (no user-observable surface).

Flow names, shortened:
- **URL** = `dashboard: the dashboard URL 302s to the deployed console; …`
- **NSF audit** = `dashboard: a CCO audits a real NSF rejection from the dashboard alone — …`
- **counts** = `dashboard: known evidence moves every panel by exactly what was added; …`
- **flag** = `dashboard: an officer flags a monitored event — …`

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | demo posture: the data route serves ANY caller, partner included | flow | URL → "demo posture: the panels load with no credential …", "demo posture: a partner token gets the same instance-wide panels …" |
| 2 | panels aggregate the evidence tables faithfully | flow | counts → "controls: …", "alerts: …", "cases: …", "CTR: …", "dual control: …". Known rows are inserted and each panel must move by exactly that delta. `ops.events_7d` (blnk.* codes) and `last_reconcile` are only checked for shape, because the flow cannot write reconcile evidence without a Blnk reconcile run |
| 3 | empty tables produce an empty-but-well-formed payload, not an error | drop | The shared instance cannot be emptied (never `/sandbox/reset`). Payload well-formedness is in URL → "… are well-formed". **Not proven:** the zero-row path (`last_reconcile: null`, all-zero counts) |
| 4 | headline counts are TRUE totals, never the length of a capped page | flow | counts → "unfiltered: open alerts and CTR clocks are the database's counts, and a capped list says it is a sample", "ops: outbox depth is the true undelivered count …". The live queue is over 100, so `listed == 100` sits beside the true total |
| 5 | provenance: default hides nothing, the filter narrows, the blend stays visible | flow | counts → "provenance: the blend sums to the unfiltered queue; ?provenance=production narrows …; junk falls back to all"; URL → default `filter: all` |
| 6 | heartbeat: event + gate pulses ride the RPCs; window and bucket are clamped and reported | flow | NSF audit → "heartbeat: the gate lane pulses CG-NSF-01 reject …" (including `gate_last_seen`), "heartbeat: absurd parameters clamp …" (**DEFECT**, intermittent 500), "heartbeat: the DEFAULT 7-day view still shows the newest pulses" (**DEFECT**) |
| 7 | heartbeat: ?last_seen=0 skips the census RPC and answers null, not [] | flow | NSF audit → "heartbeat: ?last_seen=0 skips the census and answers null, not []". The flow can see the null, but not whether the RPC was skipped |
| 8 | heartbeat: empty database yields empty-but-well-formed arrays | drop | Same reason as #3. **Not proven:** the empty-database shape |
| 9 | event stream: refuses a codeless query rather than dumping the whole outbox | flow | NSF audit → "stream: a codeless query is refused (422) …" |
| 10 | event stream: filters by code across core AND sim, newest first, payload PII redacted | flow | NSF audit → "stream: our settled transfer is inspectable …, labelled core, newest first", "stream: … ?src=core reads only the core world", "PII boundary: the member's stored entity.created carries a name, the dashboard's copy does not". Sim labelling is in flag → "the dashboard's own trace finds the escalation, labelled sim" |
| 11 | event stream: cursor pages backwards through history and reports the next cursor | flow | NSF audit → "stream: the cursor pages strictly backwards …" |
| 12 | trace: full event chain + gate decisions for one resource, ascending, redacted | flow | NSF audit → "trace: the account's cycle shows the gate's reject …; the transfer's chain carries transfer.settled" and the PII step's entity trace |
| 13 | the dashboard route 302s to the deployed console (the gateway cannot serve HTML) | flow | URL → "GET /compliance/dashboard with no credential is a 302 to the HTTPS console, never cached" |
| 14 | the catalogue manifest covers the whole policy set | drop | A static repo-consistency check of `ui/public/compliance-manifest.json` against `controls.json`, with no core runtime surface. **Not proven by any flow:** manifest completeness. It belongs in a static CI gate |
| 15 | flag: a valid flag routes an escalation AND emits escalation.routed | flow | flag → "an urgent flag … routes a named escalation …", "the escalation and its escalation.routed event are in sim …" |
| 16 | flag: writes to the SIM scope, never core (demo posture) | flow | flag → "… core's register is untouched" |
| 17 | flag: routing to nobody is refused | flow | flag → "refusals name the field and write nothing …" (`routed_to`) |
| 18 | flag: an unknown severity is refused | flow | same step (`severity`) |
| 19 | flag: with neither resource_ref nor event_id there is nothing to flag | flow | same step (`resource_ref`) |
| 20 | flag: severity sets the acknowledgement window — urgent sooner than routine | flow | flag → "an urgent flag … ack due in one day", "a routine flag is due later than an urgent one" |

**Counts:** flow 17 · added 0 · contract 0 · drop 3 (total 20).

## compliance_e2e.sh sections

| Section check | Where |
|---|---|
| 38: dashboard URL 302 with no credential, redirect to an https console | URL → first step |
| 38: preflight 204, allows X-Api-Key | URL → "the shell's cross-origin preflight …" (now on all five CORS routes) |
| 38: data loads with no credential; window_rows > 0; alerts.open > 0; outbox depth a number | URL → "demo posture: the panels load …"; counts → exact deltas instead of `> 0` |
| 38: a partner token also gets the panels (public by design) | URL → "demo posture: a partner token …" |
| 47: NSF 422 + compliant 201 | NSF audit → fixtures |
| 47: heartbeat gate lane, transfer.settled pulse, last_seen, gate_last_seen | NSF audit → "heartbeat: the gate lane pulses …" (24h window). The default-window variant is a **DEFECT** step |
| 47: stream codeless 422, our transfer inspectable, entity payloads PII-clean | NSF audit → stream steps, PII step |
| 47: trace account → CG-NSF-01 reject; trace transfer → transfer.settled | NSF audit → trace step |
| 47: open-alert headline equals the DB count; capped list consistent; blend sums; production filter; outbox depth equals the DB count | counts → "unfiltered: …", "provenance: …", "ops: …" |

## Flow steps beyond the unit file

- `cache-control: no-store` on the redirect. Every CORS route answers its preflight. A non-dashboard route still answers 401 without a key, so "public" is specific to these routes.
- `gate_last_seen` must date CG-NSF-01 at or after this run's own rejection, not merely be non-empty.
- Stream pages never repeat a row across the cursor.
- The PII check compares the stored payload (which holds `name`) with the dashboard's copy, so a passing check means redaction happened. An empty payload would not pass it.
- A flag is visible in the dashboard's own trace, labelled `sim`.

## DEFECTs (left red)

1. **The default 7-day heartbeat drops the newest pulses.** `event_heartbeat` orders oldest bucket first, and PostgREST caps the RPC result at 1000 rows, despite the SQL `limit 100000` (`core/supabase/migrations/20260722000100_dashboard_heartbeat.sql`). Live, a 168h heartbeat returns exactly 1000 rows whose newest bucket is about 2 days old, and nothing in the payload says it was cut. Step: "heartbeat: the DEFAULT 7-day view still shows the newest pulses — our settle's bucket".
2. **The all-time census (`event_last_seen`) is cut at 1000 rows**, ordered by code, so late-alphabet codes such as `wire_transfer.submitted` have no "last evidence". Step: "heartbeat: the all-time census reaches the end of the alphabet …".
3. **The clamped 90-day / 1h ceiling times out intermittently.** `event_heartbeat` at 2160h hit `canceling statement due to statement timeout` (about 8.4s) in direct RPC timing, and `/heartbeat?hours=999999&bucket=1` answered 500 on 3 of roughly 9 observed calls (one 24h heartbeat also 500d once under load). This step is flaky-red, not always red. Step: "heartbeat: absurd parameters clamp …".

## Judgement calls

- **Partner blindness is not provable, because the dashboard is public by declaration.** All five routes are `x-audience: public`, and the handler serves every caller (the demo posture, re-lock noted at 4b34d6a). The flow pins the posture as declared: a partner gets the same instance-wide panels as an anonymous caller. When production re-locks the routes, flip that step to assert 404.
- **Fixtures are written as `provenance: unknown` through the service role, and deleted in a `finally`.** That slice is frozen legacy data: the core stamps only `production` and `demo`, and the slice has no case, CTR or approval rows and no rows in the 7-day control window. Exact deltas are therefore stable while other flows run. While a run is in progress, the unfiltered queue holds up to 2 extra open alerts.
- Unfiltered headline counts are compared to a database count bracketed by two reads (db, api, db), retried up to 6 times, because the shared instance moves while the check runs.
