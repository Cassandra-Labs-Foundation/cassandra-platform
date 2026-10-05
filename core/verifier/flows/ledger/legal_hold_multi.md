# Coverage ledger: `core/supabase/functions/api/legal_hold_multi.test.ts` → retention flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/retention.test.ts`. Run them with `scripts/flow.sh -f retention: --no-deploy`.

Disposition key: `flow` (existing step), `added` (step written for it), `contract`, `drop`.

All steps are in **multi** = `retention: two matters hold one expired record → both must release → the sweep schedules but never destroys → certified disposal`. Each hold targets a run-unique subject whose only record this flow classified, under a 0-year Schedule A class.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | two concurrent holds: releasing the FIRST leaves the record held | added | "the other order: releasing the FIRST hold also leaves the record held, by matter B" |
| 2 | two concurrent holds: releasing the SECOND leaves the record held | added | "releasing the SECOND hold (the direction that used to fail open) leaves the record held by matter A" (disposal still 409 `legal_hold_in_force`) |
| 3 | releasing BOTH holds clears the flag | added | "releasing BOTH holds clears the flag", then "all three conditions met …" shows that release re-enables disposal |
| 4 | a record held by a surviving matter is NOT disposal-eligible | added | "the sweep (operations) schedules what is eligible, skips a record still held by a surviving matter, …" (runs after B is released and A survives) |
| 5 | the membership set is the authority, not the pointer | added | "matter A then matter B place holds: both memberships are recorded, the pointer names only the latest" |

Totals: flow 0, added 5, contract 0, drop 0.
