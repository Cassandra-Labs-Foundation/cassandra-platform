# Coverage ledger: `core/supabase/functions/api/complaints.test.ts` → complaint and dispute flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/complaints.test.ts`. Run them with `scripts/flow.sh -f complaints: --no-deploy`.

Disposition key:

- `flow`: covered by a step that already existed.
- `added`: a flow step written to cover it.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`.
- `drop`: no user-observable surface, or reachable only by fault injection.

The five flows are: **lifecycle** (`complaints: direct fee complaint …`), **regulator** (`complaints: a regulator complaint must name the regulator …`),
**late** (`complaints: a complaint left past every deadline …`), **dispute** (`complaints: Reg E dispute …`) and **trends** (`complaints: the trend is COUNTED …`).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | CO-06: every clock starts at RECEIPT, not at triage | added | lifecycle → "log a complaint that sat in the inbox for 3 days: every clock anchors on the SUPPLIED receipt time" (received_at, ack +5d, initial +15d, final +30d on the row) |
| 2 | CO-06: a complaint with no valid CATEGORY is refused | added | lifecycle → "intake refuses a complaint with no valid category or no narrative — field named, nothing written" |
| 3 | CO-06: a complaint with no narrative is refused | added | same step |
| 4 | CO-06: a regulator complaint must name the regulator and gets the longer clock | added | regulator → "a regulator-channel complaint that does not name the regulator is refused" and "a CFPB complaint: 60-day final clock, a 15-day portal deadline …" |
| 5 | PR-10: a privacy complaint raises its own event, a fees one does not | added | regulator → "PR-10: a privacy complaint raises complaint.privacy.received"; lifecycle → "intake evidence: … no regulator/privacy events" |
| 6 | CO-06: acknowledgement records whether it was LATE | added | late → "the acknowledgement is recorded as LATE"; the on-time case in lifecycle → "acknowledge inside the window …" |
| 7 | CO-06: initial and final responses are SEPARATE obligations | added | lifecycle → "the INITIAL response is its own obligation …" and "the FINAL response tells the member the outcome"; lateness of each in late → "initial and final responses are each recorded as LATE …" |
| 8 | CO-06: a response with no content is refused | added | lifecycle → "a response with no content is refused — it would only be a status change" |
| 9 | CO-06: resolving with NO ROOT CAUSE is refused | added | lifecycle → "resolving with NO root cause is refused — it would empty the trend analysis" |
| 10 | CO-06: a complaint cannot be resolved before the member is told | added | lifecycle → "it cannot be resolved before the member is told the outcome (409), and nothing changes" |
| 11 | CO-06: a fully handled complaint resolves and carries its root cause | added | lifecycle → "resolve with a root cause: resolved, root cause + notes on the row and the event trail" |
| 12 | MP-04: a dispute carries its OWN clocks, distinct from the complaint's | added | dispute → "open the dispute, notified 12 days ago: 10-day provisional-credit and 45-day investigation clocks" |
| 13 | MP-04: the extended investigation window is 90 days, not 45 | added | dispute → "a new-account / POS / foreign dispute gets the EXTENDED 90-day investigation window" |
| 14 | MP-04: provisional credit posts an AMOUNT and records lateness | added | dispute → "post provisional credit after the 10-day deadline …"; plus "the provisional credit reaches the member's balance" (DEFECT, red) |
| 15 | MP-04: a dispute cannot be closed without findings | added | dispute → "a dispute cannot be closed without findings …" and "resolve with findings: …" |
| 16 | FL-13: the trend is COUNTED from the register, not supplied | added | trends → "enterprise trend: totals are counted from the register — a supplied total is ignored" |
| 17 | FL-13: an unresolved complaint past its deadline counts as OVERDUE | added | same step (a 90-day-old unresolved fixture; overdue_count checked against the register) |
| 18 | FL-13: a disparity above threshold opens a CAP and a remediation | added | trends → "FL-13: a cohort disparity above the threshold breaches, opens a CAP and a fair-lending remediation" |
| 19 | FL-13: an unset threshold yields NO verdict and opens nothing | added | trends → "FL-13: with NO threshold set, the same disparity yields no verdict and opens nothing" |
| 20 | FL-13: the lens filters — a privacy lens does not count fee complaints | added | trends → "the lens filters: a privacy trend counts privacy complaints only" |
| 21 | PR-10: a material privacy incident delivers an AD HOC board report | added | trends → "PR-10: the quarterly privacy Board pack is delivered — with no ad hoc report" and "PR-10: a MATERIAL privacy incident goes to the Board ad hoc …" |

**Counts:** flow 0 · added 21 · contract 0 · drop 0 (total 21).

## Flow steps beyond the unit file

- **Access:** a partner token gets 404 on `/complaints`, `/complaints/trends` and `/disputes`. These routes self-gate with `requireInternalActor`.
- **Refusals write nothing:** each refused intake, dispute and resolve is checked against the database, not only the status code.
- **Portal channel:** a `portal` complaint carries the 15-day portal deadline and keeps the 30-day final clock.
- **Provenance:** complaint, dispute and trend rows and their events are labelled `demo` when a test actor writes them.
- **Unknown ids:** acting on a complaint or dispute that does not exist returns 404.
- **Provisional credit (DEFECT, red):** after `POST /disputes/{id}/provisional-credit` the member's balance must rise by the credited amount. The handler only records `provisional_credit_cents`.
- **Observed:** live `core.complaint.portal_due_date` is a `date` column. `core_schema.sql` created the table first, so the later `timestamptz` declaration was a no-op. The flow compares calendar dates.
