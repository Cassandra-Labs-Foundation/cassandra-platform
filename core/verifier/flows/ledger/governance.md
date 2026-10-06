# Coverage ledger: `core/supabase/functions/api/governance.test.ts` → governance flows

Each `Deno.test` in the stubbed unit file is listed below with the place where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/governance.test.ts`. Run them with `scripts/flow.sh -f governance: --no-deploy`.

Disposition key: `flow` (an existing step covers it), `added` (a step written to close the gap), `contract` (HTTP shape only), `drop` (no user-observable surface).

There are two flows. **anchored** is `governance: staff register a quarterly obligation …` and **unscheduled** is `governance: an obligation registered with no anchor …`.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | each cadence advances by its own period | added | anchored → "internal audit completes it 21 months late: next due is 2025-04-01 …" (quarterly) and unscheduled → "an ad_hoc obligation has no next occurrence …". The annual, semiannual, monthly, weekly and daily arithmetic is not exercised live, because it is pure date math with no extra behaviour. |
| 2 | ad_hoc has no next occurrence and does not invent one | added | unscheduled → "an ad_hoc obligation has no next occurrence: completing it leaves no due date …" |
| 3 | the anchor IS the first occurrence, not the one after it | added | anchored → "staff register it anchored 2025-01-01: the anchor IS the first due date …" |
| 4 | an obligation can be registered WITHOUT an anchor, and says so | added | unscheduled → "registered with a cadence but no anchor: 201, scheduled=false, and the response SAYS it will never come due" |
| 5 | an anchored obligation gets a real due date | added | anchored → "staff register it anchored 2025-01-01 …"; unscheduled → "staff anchor it in the future …" |
| 6 | a bare control_id is refused — ids are not unique across policies | added | anchored → "a bare control_id is refused as ambiguous; …" |
| 7 | an unknown cadence is refused rather than defaulted | added | same step (also covers a malformed anchor) |
| 8 | completion advances from the DUE date, not from when it was done | added | anchored → "internal audit completes it 21 months late …" |
| 9 | every completion is appended to the log, not just the latest | added | anchored → same step (log row with `was_late` stored, `due_at`, provenance). Unscheduled → the ad_hoc completion is logged too. |
| 10 | completion without an attributed actor is refused | added | anchored → "completion with no attributed actor is refused (400 completed_by) …" |
| 11 | an UNSCHEDULED obligation cannot be completed | added | unscheduled → "it cannot be completed … (409 obligation_unscheduled), nothing logged" |
| 12 | the sweep fires the CATALOGUE's own trigger code | added | anchored → "the sweep fires the CATALOGUE's trigger code (not a generic 'due') and names it OVERDUE …" |
| 13 | a due obligation nobody completed is reported OVERDUE | added | same step (`days_late`, plus `governance.obligation.overdue` evidence) |
| 14 | an obligation completed since it came due is NOT overdue | added | anchored → "the next cycle (due 2025-04-01) is itself past due and nobody did it …". **DEFECT, red.** The unit test encodes the bug. Live, the only way `last_completed_at > next_due_at` can happen is a late completion of the *previous* cycle, and that hides a past-due cycle nobody did. |
| 15 | UNSCHEDULED is reported separately from overdue, never merged | added | unscheduled → "the sweep reports it UNSCHEDULED — separately from overdue, never fired — and names the state in its warning" |
| 16 | a fully scheduled, fully current calendar reports no warning | added (partial) | unscheduled → "staff anchor it in the future: now scheduled, not due, and off the unscheduled list". The *instance-wide* "no warning" verdict depends on every obligation on the shared core, so the flow does not assert it. |
| 17 | sweep event ids are deterministic per due date | added | anchored → "re-sweeping does not pile up: one due event and one overdue event per due date" |
| 18 | a partner cannot see or touch the governance calendar | added | anchored → "a partner can neither see nor touch the calendar (403 on all four routes) …". Live, the route's `x-actors` gate answers 403 before the handler's 404. |
| 19 | the sim path writes only to sim, stamped simulated | drop | Only the drill calls the `sim` scope. No live route reaches it. |

**Counts:** flow 0 · added 18 · contract 0 · drop 1 (total 19).

## Flow steps beyond the unit file

- **DEFECT (judgement call):** a completed `ad_hoc` obligation has its anchor nulled, so every later sweep lists it under `unscheduled`, with the warning that it is "NOT satisfied". See unscheduled → "a COMPLETED ad_hoc obligation is not reported as 'unscheduled … NOT satisfied'".
- A malformed `anchor_date` returns 400. Completing an unknown obligation returns 404. The register (`GET /governance/obligations`) lists the obligation, and `scheduled + unscheduled = total`.
- Fixture discipline: the control uids are run-unique (`flowtest:GOV-*`) and the trigger codes are `flowtest.*`, so a sweep never fires a real control's trigger for a fixture. Obligations and completions are deleted at flow end, and events stay. The sweep also revisits the instance's real obligations; their due events already exist and are deduplicated by id.

## §46 of `compliance_e2e.sh`

Nothing from §46 belongs here. RS-03 is in `member_protection.test.ts`. MP-06/07, PR-03/04/15 and CP-05 are in `isolation.test.ts`. DF-05 is lending, which is deliberately unrouted.
