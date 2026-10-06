# Coverage ledger: `core/supabase/functions/api/audit.test.ts` → audit flows

Every `Deno.test` in the stubbed unit file is listed below with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/audit.test.ts`. Run them with `scripts/flow.sh -f audit: --no-deploy`.

Disposition key: `flow` (covered by a flow step), `added` (a step written to close a gap), `contract` (HTTP shape only), `drop` (no user-observable surface).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | AU-04: submitting the plan opens the cycle and schedules the assessment | flow | `audit: plan submitted → a DIFFERENT approver → …` → "AU-04: submitting the plan opens the cycle and SCHEDULES the assessment, attributed to the submitter" |
| 2 | AU-04: the plan's submitter cannot also approve it | flow | same flow → "AU-04: the plan's submitter cannot also approve it — 409, nothing approved", then "a different actor approves; the record names both". Two genuinely different minted tokens (cu_admin submitter, pynthia_ops approver) |
| 3 | AU-03/AU-04: no start before approval, and no start without independence | flow | same flow → "the engagement cannot start before the plan is approved", "without an independence attestation the engagement does not start (400)", "attested, it starts — and starting is what grants the auditor access" |
| 4 | AU-06: a report cannot issue before fieldwork completes | flow | same flow → "AU-06: a report cannot issue before fieldwork completes — no findings are opened" |
| 5 | AU-06/AU-10: issuing OPENS the findings and starts the retention clock | flow | same flow → "AU-06/AU-10: issuing OPENS the findings, delivers to the board and starts the 7-year retention clock" |
| 6 | AU-08: the management response starts the 90-day remediation clock | flow | same flow → "AU-08: a response with no text is refused; with text it starts the 90-day remediation clock" |
| 7 | AU-09: a failed retest cannot close the finding — it re-communicates | flow | same flow → "AU-09: a FAILED retest does not close the finding — it goes back to management", then "a PASSED retest closes it" |
| 8 | AU-08: accepting a risk without a rationale is refused; with one it closes | flow | same flow → "AU-08: accepting a risk with no rationale is refused; with one it closes the finding" |
| 9 | AU-07: the sweep escalates a finding whose remediation date passed unclosed | flow | `audit: a poor-rated engagement → … the sweep escalates it` → "AU-07: the sweep escalates the aged finding — critical goes further — and the current one is untouched". The remediation date is moved into the past by a service-role update to the flow's own finding (clock simulation). The response counts are instance-wide, so they are asserted as `>= 1`; the per-finding events are asserted exactly. The monthly-review event is keyed per month, so the flow asserts it exists for the current month, not that this sweep wrote it |
| 10 | a partner token cannot reach the audit routes at all | flow | first flow → "a partner cannot open an audit plan (403 at the actor gate); nothing is stored"; second flow → "a partner cannot run the audit sweep". Live, the route's `x-actors` gate answers 403 `insufficient_scope` before the handler's own 404 is reachable |

**Counts:** flow 10 · added 0 · contract 0 · drop 0 (total 10).

## Flow steps beyond the unit file

- An incomplete plan (no scope / auditor) is 400; an unknown fieldwork rating is 400.
- AU-04: a `poor` rating records `audit.poor_rating.recorded` and `audit.frequency_increased`; a `needs_improvement` rating does not raise frequency.
- Every audit row written by a test token is stamped `demo` provenance.
- Hygiene: the sweep flow closes its findings (passed retest) in a `finally`, so no aged finding is left in the institution's queue.
