# Coverage ledger: `core/supabase/functions/api/records_admin.test.ts` → records-admin flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/records_admin.test.ts` (one row also points at `retention.test.ts`). Run them with `scripts/flow.sh -f records_admin: --no-deploy`.

Disposition key: `flow` (existing step), `added` (step written for it), `contract`, `drop`.

Flows:

- **schedule** = `records_admin: Schedule A governs the clock — add, amend effective-dated, future-dated, retire, unmatched, permanent`
- **integrity** = `records_admin: integrity tests and archive confirmations — a failed test opens a finding, a pass does not`
- **destruction** = `records_admin: destruction log — boxes reconcile against real disposals; a mismatch needs an explanation`
- **cdd** = `records_admin: CDD refresh is risk-based, and a late refresh says it was late`
- **disposition** = `records_admin: RR-07 disposition — anonymized and destroyed are different acts; a method is not a bypass`
- **governance** = `records_admin: governance — the annual review COUNTS amendments; a contact vacancy is its own state`

Every key is run-unique: classes, record ids, box ids, archive periods, profile ids, contact roles, and the review cycle year. Review ids are `rpolrev_<year>` and are upserted, so reusing a real year would overwrite the real review.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | RR-01: a schedule entry with no citation is refused | added | schedule → "RR-01: an entry with no citation (or no term) is refused naming each, and writes nothing" |
| 2 | RR-01: an amendment supersedes and inherits, and the version increments | added | schedule → "RR-01: an amendment (7 years from 2026-06-01) supersedes AT its effective date and inherits from v1" |
| 3 | RR-01/RR-09: an amendment does NOT retroactively govern | added | schedule → "RR-01/RR-09: the amendment is NOT retroactive …" (read from the effective-dated `retention_schedule_entry` rows, because `scheduleInForce` has no endpoint) |
| 4 | RR-01: a future-dated amendment does not leave a gap with no schedule | added | schedule → "RR-01: a future-dated amendment (2027) leaves no gap — today is still governed by v2" |
| 5 | RR-01: an unmatched class REFUSES rather than defaulting a retention period | added | schedule → "RR-01: an unregistered class REFUSES rather than defaulting a retention period" |
| 6 | RR-01: the clock comes from the SCHEDULE, not a constant | added | schedule → "RR-01: an entry is added (v1, 5 years from 2026-01-01) and a record's clock comes from it" (and 7 years after the amendment) |
| 7 | RR-01: a RETIRED class stops applying and refuses like an unregistered one | added | schedule → "RR-01: a RETIRED class stops applying …" (+ retiring a never-registered class is a 404) |
| 8 | RR-11: a permanent record gets no expiry and is explicitly NOT disposal eligible | added | schedule → "RR-11: a permanent record gets no expiry, is explicitly NOT eligible, and no method disposes it" |
| 9 | RR-11: a permanent record cannot be disposed by any method | added | same step (all three methods return 409 `record_permanent`), plus retention.test.ts permanent → "disposal via /retention/records/{id}/dispose is a specific 409 …" (**DEFECT**: that endpoint returns 500) |
| 10 | RR-02: a completed test needs a verdict, a sample and a certifier | added | integrity → "RR-02: a completion with no sample or certifier is refused and the test stays open" |
| 11 | RR-02: a FAILED test opens a finding; a passing one does not | added | integrity → "RR-02: a FAILED readability test opens a finding" and "RR-02: a PASSED conversion test certifies the conversion and opens no finding" |
| 12 | RR-06: an archive confirmation records the years the vendor actually confirmed | added | integrity → "RR-06: an archive confirmation records the years the vendor actually confirmed" |
| 13 | RR-04: a box marked destroyed whose records are still live is a mismatch | added | destruction → "RR-04: reconcile flags a destroyed box with live records, …". No route records a box's physical destruction, so the flow marks only its own box `destroyed_at` with service role, as the drill does (drill/firers.ts:821) |
| 14 | RR-04: a consistent box produces NO mismatch — the reconcile is not an echo | added | same step |
| 15 | RR-04: a mismatch cannot be closed without an explanation | added | destruction → "RR-04: a mismatch cannot be closed without an explanation; with one it is resolved" |
| 16 | RR-08: the refresh cycle is RISK-BASED, not one interval for everyone | added | cdd → "RR-08: high / moderate / low refresh at 12 / 36 / 60 months …" |
| 17 | RR-08: a refresh records whether it was LATE | added | cdd → "RR-08: an overdue high-risk refresh records refreshed_late: true …" and "RR-08: an on-time refresh records refreshed_late: false" |
| 18 | RR-07: anonymized and destroyed are different acts and are recorded as such | added | disposition → "anonymized keeps the analytical fields it names; destroyed keeps none …" |
| 19 | RR-07: the three disposal conditions still apply — a method is not a bypass | added | disposition → "an unexpired record is refused whatever the method", plus retention.test.ts multi → "a disposal method is not a bypass: anonymizing a held record is refused too" |
| 20 | RR-09: the amendment count is COUNTED from the schedule, not asserted | added | governance → "RR-09: the amendment count is COUNTED from Schedule A, not taken from the request". **DEFECT**: it undercounts once the table passes 1,000 rows |
| 21 | RR-12: a VACANCY is recorded as its own state | added | governance → "RR-12: a role is assigned, then VACATED …" |

Steps beyond the unit file: schedule → "a partner cannot reach records administration — every route is a 404 and writes nothing" (all 13 routes). destruction → "RR-04: reconcile flags an OPEN box whose records were all disposed" (**DEFECT**). integrity → "RR-06: an email-archive retrievability test runs under its own codes". cdd → "RR-08: a refresh needs a refresher, and an unknown profile is a 404".

Totals: flow 0, added 21, contract 0, drop 0.
