# Coverage ledger: `core/supabase/functions/api/hr.test.ts` → people flows

Every `Deno.test` in the stubbed unit file, and where its behaviour is now proven against the deployed core. Steps live in `core/verifier/flows/people.test.ts`; run with `scripts/flow.sh -f people: --no-deploy`. Every employee the flow hires is separated before it ends.

Disposition key: `flow` (an existing flow step covers it) · `added` (a step written for this port) · `contract` (already in `core/verifier/contract/`) · `drop` (no user-observable surface, or unproducible on the shared instance).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | an employee needs a name and a role | added | `people: HR hires a teller …` → "an employee needs a name and a role — 400, nothing stored" |
| 2 | hiring records the personnel fact as an event | added | same flow → "HR hires a cash-handling teller, a second cash handler and a non-cash clerk …" |
| 3 | CP-05: separation revokes every LIVE cash custody in the same request | flow + added | `cash_ops.test.ts` → "the keyholder separates: custody revoked at once …"; the already-revoked half and the count are added in `people:` → "CP-05 + IS-06: the teller separates …" (the earlier revocation is applied by the service role, since rotation has no API) |
| 4 | IS-06: separation deprovisions live access in the same act | added | same step (every grant deprovisioned with its event; `core.user` follows HR) |
| 5 | CP-07: coaching with no notes is a checkbox, and is refused | added | same flow → "CP-07: coaching with no notes is a checkbox and is refused …" |
| 6 | training completion lands on the SHARED training table, not a parallel one | added | same flow → "training completion lands on the shared training table …" |
| 7 | CP-12: coverage over NO declared employees is unassessed, never 100% | added (computed half) / drop (null half) | same flow → "CP-12: the KRI's training coverage is COMPUTED over active cash handlers …". The null-when-nobody-is-declared half needs zero active cash handlers instance-wide, which a shared instance never has; that guarantee stays unproven live |
| 8 | BA-08: a capital training assignment carries the annual clock and the corpus code | added | same flow → "BA-08: a capital training assignment carries the annual clock …" |

**Counts:** flow 0 · added 8 · contract 0 · drop 0 (total 8). Row 3 is also covered by an existing cash_ops flow; row 7's null-when-empty half is unproven live.

## Flow steps beyond the unit file

- A partner cannot hire or grant access (403 at the route gate). Coaching, training and assignment for an unknown employee are 404. An assignment with no assignee is 400.
- CP-12 is only observable on the KRI publication (`POST /cash-ops/kri`). The step publishes under a run-unique period, passes a caller-supplied 100% that is ignored, and asserts the figure is under 100 (the flow keeps one untrained cash handler active) and matches the coverage recomputed from the registers.

## Judgement call

- `POST /hr/employees` upserts on `id` with `status: "active"`, so re-posting a separated employee's id silently reactivates them. Not asserted.
