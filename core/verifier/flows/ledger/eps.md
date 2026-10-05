# Coverage ledger: `core/supabase/functions/api/eps.test.ts` → EPS-06 dual control flows

Every `Deno.test` in the stubbed unit file, and where its behaviour is now proven against the deployed core. New steps live in `core/verifier/flows/eps.test.ts`; run with `scripts/flow.sh -f eps: --no-deploy`. The flow sets the partner's client limit temporarily and restores the original row (or its absence) in a `finally`.

Disposition key: `flow` (an existing flow step covers it) · `added` (a step written in `eps.test.ts`) · `contract` (already in `core/verifier/contract/`) · `drop` (no user-observable surface, or unproducible on the shared instance).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | wire dual control is unconditional — no policy value needed | flow | `wires.test.ts` → `wires: $11k wire …` → "the row records its originator and that dual control is REQUIRED" (and every wire flow's prepare) |
| 2 | an unconfigured ACH limit is UNASSESSED, not exempt and not required | added | `eps: ACH dual control follows the client limit …` → "with no limit configured an ACH is UNASSESSED — not exempt, and no approval is opened" |
| 3 | a configured limit produces a real determination in both directions | added | same flow → "over the limit is REQUIRED with an approval naming the originator; at or under is NOT required" (one cent over, exactly at, one cent under) |
| 4 | a configured limit of ZERO is a real policy, not an absence | added | same flow → "a limit of ZERO is a real policy: even a $1 batch needs dual control" |
| 5 | the originator cannot approve their own payment | flow | `wires.test.ts` → "the preparer cannot approve their own wire (two calls is not two people)"; the ACH form is added in `eps:` → "the originator cannot approve its own ACH; operations can, and both are recorded" |
| 6 | a different actor can approve, and both actors are recorded | flow | `wires.test.ts` → "operations approves as the second pair of eyes"; ACH form in the `eps:` step above |
| 7 | a rejection blocks rather than approves | flow | `wires.test.ts` → `wires: cancel releases a hold; …` → "the second approver REJECTS: the wire can never be confirmed" |
| 8 | re-approving replays rather than re-deciding | added | `eps:` → "a second decision on a decided approval replays — it does not re-decide" (a different actor tries to REJECT an approved ACH) |
| 9 | pending-approvals separates PENDING from UNASSESSED | added | `eps:` → "the approvals queue lists the required ACH as pending and the unconfigured one as unassessed" — **red: DEFECT** (the queue returns the 200 oldest open approvals and reports 200 as the count; new items never appear) |
| 10 | with everything assessed there is no warning | drop | Needs zero unassessed payments institution-wide; the shared demo instance holds hundreds and a flow must not delete them. The warning's presence is asserted in row 9's step |
| 11 | client limits can be set, which is what resolves the unassessed state | added | `eps:` → "operations sets a $1,000 limit: stored with who set it, and a durable change event" |
| 12 | a fintech cannot set its own dual-control threshold | added | `eps:` → "a fintech cannot set its own dual-control threshold" (route gate answers 403 `insufficient_scope`; the unit stub's handler-level 404 is never reached) |
| 13 | a negative or fractional limit is refused | added | `eps:` → "a negative or fractional limit is refused by field and writes nothing" |
| 14 | explicit null leaves the limit unconfigured rather than setting zero | added | `eps:` → "explicit null leaves the limit unconfigured — not zero — and ACH is unassessed again" |

**Counts:** flow 4 · added 9 · contract 0 · drop 1 (total 14).
