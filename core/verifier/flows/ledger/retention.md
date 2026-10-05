# Coverage ledger: `core/supabase/functions/api/retention.test.ts` → retention flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/retention.test.ts`. Run them with `scripts/flow.sh -f retention: --no-deploy`.

Disposition key:

- `flow`: covered by a flow step written for this area.
- `added`: a flow step written specifically to close the gap the unit test pinned.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`. Not written here.
- `drop`: no user-observable behaviour, or unsafe/unreachable on the shared demo core.

Flows:

- **closure** = `retention: an account closes → clocks start → early disposal refused → hold outranks the date → authorized release`
- **multi** = `retention: two matters hold one expired record → both must release → the sweep schedules but never destroys → certified disposal`
- **permanent** = `retention: a permanent record is never destroyed — the retention endpoint refuses it cleanly`

Expired records are reached without fabricated anchors: a run-unique Schedule A class with a 0-year term, classified through `POST /records/classify`.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | each record class retains for the period BSA-21 states | flow | closure → "closure starts BOTH closure-anchored clocks …" (5 years for cip_identity / beneficial_owner, exact). The SAR, wire and 10-year OFAC classes are written by other subsystems' flows, not reachable from this area |
| 2 | the anchor differs by class, not just the period | flow | closure → same step: `retention_anchor_kind = account_closure`, anchored at the `account.closed` event, not at opening |
| 3 | expiry is anchor + period, and leap years do not shift it | flow | closure → same step asserts expiry = anchor + 5 calendar years to the millisecond. The 29 Feb case needs a chosen closure date; the core stamps "now", so it is not reachable live |
| 4 | an unknown record class throws rather than defaulting to some period | drop | internal helper (`expiresAt`); its user-facing equivalents are #14 and records_admin "unregistered class REFUSES" |
| 5 | closing an account starts the clock on closure-anchored records | flow | closure → "closure starts BOTH closure-anchored clocks …" (rows + `record.retention_clock_set` / `.expires_at` / `record.retention_anchor` events) |
| 6 | re-closing cannot re-anchor and extend retention | added | closure → "closed is final, so a second closure cannot re-anchor and EXTEND retention" |
| 7 | (a) a record inside its retention period cannot be destroyed | added | closure → "(a) a record inside its five years cannot be destroyed …" and "released but still inside its five years …" |
| 8 | (b) a legal hold blocks destruction even after expiry | added | multi → "expired AND approved AND certified, but held …" |
| 9 | a held AND unexpired record reports the HOLD, not the date | added | closure → "a record both held AND unexpired reports the HOLD, naming the matter to chase" |
| 10 | (c) destruction without an approver or a certificate is refused | added | closure → "(c) disposal without an approver or a certificate is refused naming both …" (+ unknown record 404) |
| 11 | all three conditions met: the record is destroyed and certified | added | multi → "all three conditions met: the record is destroyed, approved, certified and logged" |
| 12 | re-disposing replays rather than destroying twice | added | multi → "re-disposing replays rather than destroying twice" |
| 13 | placing a hold flags in-scope records in the same request | added | closure → "a class-scoped hold flags its in-scope record in the same request — and only that one" |
| 14 | a hold naming an unknown record class is refused | added | closure → "a hold must name what it covers, and a scope class outside the schedule is refused" |
| 15 | a hold must name what it covers | added | same step (and a hold with no matter_id) |
| 16 | releasing a hold without written authorization is refused | added | closure → "release without written authorization is refused and the hold stays live" (+ unknown hold 404) |
| 17 | release marks the hold released and resumes the schedule | added | closure → "an authorized release clears the hold, the flag and the membership, and resumes the schedule" (+ re-release replays) |
| 18 | the sweep schedules but destroys nothing | added | multi → "the sweep (operations) schedules what is eligible, … and destroys NOTHING". The live core already holds 150+ expired records, so the sweep is truncated at 100 and this run's unheld record is only asserted as scheduled when it is not truncated |
| 19 | a clean sweep reports zero rather than silence | drop | a clean sweep is unreachable on the shared core (150+ pre-existing expired records). The sweep step does assert `eligible_count == eligible.length` and a boolean `truncated` |
| 20 | a partner cannot see or touch retention at all | added | closure → "a partner cannot see or touch retention at all …". Live answer is **403** from the `x-actors` gate (auth.ts), not the handler's 404, which sits behind it as defence in depth |
| 21 | aged records live in sim — a five-year clock cannot be waited out | drop | the `sim` scope is not reachable through the deployed API. The flows reach expiry honestly through a 0-year schedule instead |
| 22 | every row the sim path writes is stamped simulated | drop | same: no API path writes the `sim` scope |
| 23 | the core path never writes into sim | added | closure → "a closure stamped by a demo credential is demo evidence, not production". **DEFECT**: `setRetentionClocks` takes no ctx, so these rows are stamped `production` |

Steps beyond the unit file: closure → "a hold placed by a demo credential is labelled demo evidence" (**DEFECT**), and permanent → "disposal via /retention/records/{id}/dispose is a specific 409, not a database error" (**DEFECT**: it returns 500).

Totals: flow 4, added 15, contract 0, drop 4.
