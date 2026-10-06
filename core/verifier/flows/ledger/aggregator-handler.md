# Coverage ledger: aggregator/handler.test.ts → aggregator, isolation and origination flows

Source: `core/supabase/functions/aggregator/handler.test.ts` (13 tests). Flows: `core/verifier/flows/aggregator.test.ts` (run with `scripts/flow.sh -f aggregator: --no-deploy`). Rows already mapped in `ledger/origination.md` point there. The cu_admin overview and search rows are already covered by `core/verifier/flows/isolation.test.ts`.

Disposition key: `flow` = covered by a ported bash §40 check; `added` = a flow step written to close a gap the bash script left; `origination` / `isolation` = already proven by that flow file; `partial` = proven through a different surface than the stub names.

Flows: **I** = `aggregator: an instance ingests its events — attributed from the token, deduped, PII refused, append-only`; **B** = `aggregator: the BSA approver raises one CTR per large event and a lookback-owed structuring flag`; **R** = `aggregator: a partner's $11k transfer crosses the outbox into the aggregator once and raises one CTR there`; **H** = `aggregator: health reports consumer lag and ingest gap, and a stalled consumer writes an alarm`; **IS** = `isolation: the CU admin reads across every fintech's instance at the aggregator and writes nothing`.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | ingest stamps instance_id from the TOKEN and defaults schema_version | flow + added | I → "a batch lands: …" (token attribution, default 1, explicit 2 kept); I → "redelivery dedups by event_id: …" (the `onConflict: event_id` half: one row, the first payload wins); R → "the outbox delivers it: …" (real outbox event, `inst_local`, schema_version 1) and "another sweep does not deliver it twice" |
| 2 | raw PII in a payload is refused with a NAMED 400 — identity crosses only as entity_hash | added | I → "raw PII in any payload refuses the WHOLE batch with a named 400 …" (also: the clean event in the same batch is not stored, and `ssn` / `date_of_birth` / `email` are refused too) |
| 3 | GET /health runs the SQL health check (card 61) | flow | H → "health answers over the wire …", "the real bsa_approver is live …", "a consumer that has fallen behind and gone idle is named stalled — and the trip WROTE an alert" (uses a run-unique probe cursor instead of rewinding the shared one; probe and alarm are removed after) |
| 4 | /auth/token exchanges a valid client secret for a 300s JWT | origination | `ledger/origination.md` row 1 |
| 5 | /auth/token: wrong secret and unknown instance are the SAME 401 | origination | `ledger/origination.md` row 2 |
| 6 | cu_admin reads across instances; an instance token cannot (card 52) | isolation | IS → "card 52: the admin overview spans instances, including other fintechs'" and "an INSTANCE credential is refused the cross-fintech view (D23)" |
| 7 | cu_admin writes are refused wholesale — read-only by credential class (card 52) | origination + isolation + added | `/originations` leg: `ledger/origination.md` row 3. `/events/ingest` leg: IS → "an admin WRITE is refused wholesale, by credential class". Consumer-run leg: added in I → "the cu_admin credential cannot ingest or drive a consumer — read-only by class". The stub's `/consumers/payment_hub/run` path no longer exists, so the leg uses `bsa_approver`. |
| 8 | cross-fintech search: cu_admin by entity_hash only; instance tokens refused (card 54) | isolation + added | IS → "card 54: the cross-fintech search finds the member by hash, …" (400 without a hash), "an INSTANCE credential is refused …" (403). Added: B → "the CU sees the instance's activity and alerts by hash in the cross-fintech search" (event_count, money_cents and the structuring flag for a run-unique hash, plus the instance's own 403) |
| 9 | GET /fbo reads the TOKEN's instance — no path parameter to read another's | origination | `ledger/origination.md` row 4 |
| 10 | a clean origination returns 201 pending (card 66) | origination | `ledger/origination.md` row 5 |
| 11 | a stale payment hub is a 503 WITH Retry-After (card 66) | origination | `ledger/origination.md` row 6 (partial there: the SQL gate is exercised, not the HTTP 503 mapping) |
| 12 | saga exits route to accept/reject; resolved twice is a 409 (card 67) | origination | `ledger/origination.md` row 7 |
| 13 | POST /consumers/{name}/run drives exactly the named consumer (cards 56-58) | flow + added | B → "the consumer run route drives the approver and reports what it did", "a $11k event raises exactly one ctr_threshold alert …", "three sub-threshold drips aggregate into ONE structuring flag …", "re-running the consumer mints no second alert …"; R → "the approver raises exactly one ctr_threshold for it, however often it runs"; added: B → "only the bsa_approver can be driven: unknown and retired consumers are 404" (`rm_rf`, `payment_hub`) |

Counts: 13 rows. 6 `origination`, 1 `isolation`, 2 `flow`, 2 `flow + added`, 1 `added`, 1 `isolation + added`. Row 7 spans origination, isolation and added.

## Also ported from bash §40 (no stub row)

- The append-only event log: I → "the event log is append-only: an update and a delete are both refused by the database".
- The position is a view: I → "the FBO position is a VIEW: a direct write is refused, …" (also: the live program's view row equals `aggregator.member_share_cents`). Correction: the view lists every credentialed instance, so a new instance reads one row at 0, not no row.
- Cards 56/57 (payment_hub cursor, exactly-once apply) are retired with the accumulator (migration 20260817000100) and are not ported.

## Bash §41 (analytics tail): what is and is not exercised live

Flow **T** = `aggregator: the daily analytics tail is alive — archive watermark, 5300 rows and SAR lookbacks keep up`.

- Not driven: `analytics/archive.sh`, `bsa_reporter.sh`, `report_5300.sh`, and the DuckDB spanning query (`agg_events_cold/hot/all`, the "no double-count" check). They need the local DuckDB CLI and the Parquet files. The flow runner has no `--allow-run` or `--allow-read`, and running `archive.sh` would advance the shared `aggregator.archive_watermark`. The idempotency checks for the reporters re-run are not driven either.
- Exercised: the Postgres evidence the daily schedule should leave. T → "the archive watermark never runs ahead of the log" (green); "the archive job stamped liveness within two days", "the 5300 reporter left a recent row for the live instance" and "every structuring flag that owes a lookback has a SAR candidate within two days" are **red: DEFECT** (see below).

## Defect found

- **The analytics tail has not run since 2026-08-17.** Commit `b4964da` deleted every step after `actions/checkout` from `.github/workflows/aggregator-reporters.yml`. The daily run still reports success in about 8s and does nothing. Live evidence: `aggregator.archive_watermark.archived_at` = 2026-08-17 07:13Z, the newest `aggregator.report_5300.as_of` = 2026-08-17, and 11 of 33 entities with a lookback-owed structuring flag inside the 90-day horizon have no `sar_candidate`. No flag from before 2026-08-17 is uncovered. Assertions: `aggregator.test.ts` T steps (`assert(age < 2 * DAY …)`, `assert(Date.now() - Date.parse(latest) < 2 * DAY …)`, `assertEq(owed.length, 0 …)`).
