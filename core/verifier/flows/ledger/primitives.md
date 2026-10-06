# Coverage ledger: `core/supabase/functions/api/primitives.test.ts` → primitives flows

Every `Deno.test` in the stubbed unit file is listed below with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/primitives.test.ts`. Run them with `scripts/flow.sh -f primitives: --no-deploy`.

Disposition key: `flow` (covered by a flow step), `added` (a step written to close a gap), `contract` (HTTP shape only), `drop` (no user-observable surface).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | all four kinds open, across four DIFFERENT policies | flow | `primitives: work items across four policies → …` → "all four kinds open with ONE shape, for four different policies (audit / cash / privacy / bsa)" |
| 2 | a bare control_id is refused — ids collide across policies (OQ-11) | flow | same flow → "OQ-11: a bare control id … is refused as ambiguous; nothing stored" |
| 3 | an item with NO deadline says so and is not silently current | flow | same flow → "an item opened with NO deadline says so — it can never become overdue" |
| 4 | inbound correspondence must record its SOURCE and ARRIVAL time | flow | same flow → "inbound correspondence must record its SOURCE and its ARRIVAL time — each absence refused, nothing stored"; the stored `received_at` is the arrival time supplied |
| 5 | a REQUEST cannot close without saying what was decided | flow | same flow → "a REQUEST cannot close without saying what was decided (400 outcome); still open" |
| 6 | an adverse outcome requires a reason — same rule as a SAR no-file | flow | same flow → "an ADVERSE outcome needs a reason — 'denied' with no rationale is refused", then "denied WITH a reason" |
| 7 | requiresRationale is exported so no caller re-implements it | added | same flow → "the adverse set is exactly denied / rejected / no_action: the latter two need a reason too; 'approved' does not". The export itself is a code-structure property with no live surface; its behaviour is proven through the close route |
| 8 | closing late is RECORDED, never suppressed | flow | same flow → "closing the 2020 task LATE is recorded as late, never suppressed" (`closed_late` and `payload.late` on `task.completed`) |
| 9 | re-closing replays rather than re-deciding | flow | same flow → "re-closing REPLAYS rather than re-deciding: the outcome is not rewritten" |
| 10 | the sweep separates OVERDUE from UNDEADLINED | flow | same flow → "the sweep reports OUR overdue item and OUR undeadlined item separately …". Counts are instance-wide, so the flow asserts membership of its own ids in each list and the `task.overdue` event on its own item |
| 11 | canBeOverdue is one definition, exported | flow | open+deadline-passed → overdue and no deadline → never overdue are asserted in #10; closed → not overdue in "a closed item drops out of the next sweep". The export itself is a code-structure property with no live surface |
| 12 | an unconfigured limit is UNASSESSED, not within and not breaching | flow | `primitives: thresholds …` → "registered with NO limit: an observation keeps the real VALUE but is UNASSESSED, and raises nothing" |
| 13 | a limit of ZERO is a real policy, not an absence | flow | same flow → "a limit of ZERO is a real policy, not an absence: 1 breaches it" |
| 14 | thresholds work in both directions | flow | same flow → "ABOVE with a warn level …" and "BELOW (floors — liquidity, capital): 15 within, 5 breaches" |
| 15 | a warn level fires before the breach, not after | flow | same flow → "ABOVE with a warn level: 7 within, 8 warns (before the breach), 11 breaches" |
| 16 | a warn level on the wrong side of the limit is refused | flow | same flow → "a warn level on the WRONG side of the limit is refused …; nothing stored" |
| 17 | thresholds serve THREE different policies with the same shape | flow | same flow → "ONE shape serves three policies: liquidity:LQ-01, capitalization:CP-01, cash:CP-01" |
| 18 | an observation against an unconfigured threshold is recorded but UNASSESSED | flow | same as #12: the observation row keeps `observed_value` and stores `assessment = unassessed` |
| 19 | a breach emits an event; a within-limit observation does not | flow | same flow → "ABOVE with a warn level …" (exactly one warning and one breach event for three observations) and "BELOW …" (one event for two observations) |
| 20 | an attestation records the AUTHENTICATED actor, not a payload claim | flow | `primitives: attestations …` → "three policies attest … each records the AUTHENTICATED actor even when the payload names someone else" |
| 21 | an attestation with no statement asserts nothing and is refused | flow | same flow → "an attestation with no statement asserts nothing — 400 …; neither stored" |
| 22 | an inverted attestation period is refused | flow | same step as #21 (`period_end` named) |
| 23 | attestations serve THREE different policies | flow | same step as #20 (director-fiduciary-duties, information-security, truth-in-savings) |
| 24 | a partner cannot reach any primitive | flow | each flow's partner step: work-item open/close/sweep, threshold configure/observe, attestation all 403 at the `x-actors` gate, nothing stored. Live, the route gate answers before the handler's own 404 |
| 25 | the sim path writes only to sim, stamped simulated | drop | No routed handler calls the primitives with `scope = "sim"` (same as `bsa.md` #21/#22), so the path is unreachable on the live core. Left unproven: that a sim-scoped call would write only to `sim`. The inverse, that API writes land in `core` stamped `demo`, is asserted on every work item opened in flow 1 |

**Counts:** flow 23 · added 1 · contract 0 · drop 1 (total 25).

## Flow steps beyond the unit file

- Append-only attestation: the database refuses both UPDATE and DELETE of a made attestation, even for the service role (`freeze_attestation` trigger), and the original statement stands.
- Setter, opener and closer are all recorded from the authenticated token.
- Hygiene: work items are closed or cancelled and thresholds (with their observations) deleted in a `finally`, so the instance's overdue and undeadlined queues are left as found.
