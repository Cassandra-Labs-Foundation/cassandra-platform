# Coverage ledger: `core/supabase/functions/api/ecommerce.test.ts` → e-commerce flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/ecommerce.test.ts`. Run them with `scripts/flow.sh -f ecommerce: --no-deploy`.

Disposition key:

- `flow`: covered by a step of a flow that walks the whole journey.
- `added`: a step written to close a gap the stub covered and no journey step did.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`. Not written here.
- `drop`: an implementation detail with no user-observable surface.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | EC-01: board approval before the assessment completes is refused | flow | `ecommerce: online-banking policy — …` → "board approval of an incomplete assessment is refused and leaves no record" |
| 2 | EC-01: a finding lands in core.finding, not only in a text column | flow | same flow → "a completed, board-approved assessment: its finding is tracked in core.finding" |
| 3 | EC-03: an unanswered member-number comparison blocks approval | flow | `ecommerce: online-banking enrollment — …` → "verified identity but NO member-number comparison: unknown is not permission" |
| 4 | EC-03: a matched, verified enrollment approves AND confirms to the member | flow | same flow → "a matched, verified applicant is approved AND the member is sent a confirmation" |
| 5 | EC-03: a denial records its reason | flow | same flow → "a phone applicant whose member number does not match is denied with a reason" |
| 6 | EC-04: a temporary credential carries an expiry and no set-date | flow | `ecommerce: member credential — …` → "a temporary credential is issued with an expiry and no set-date" |
| 7 | EC-04: only an actual password change clears is_temporary | flow | same flow → "only an actual password change clears is_temporary; the new password is never recorded" |
| 8 | EC-03: consecutive failures lock the credential, and the lock is recorded | flow | same flow → "four failures do not lock; the fifth locks AND the lockout is recorded" |
| 9 | EC-07: a transaction with no recorded initiator is refused | flow | `ecommerce: transaction audit trail — …` → "a transaction with no recorded initiator is refused and leaves no row" |
| 10 | EC-07: a repudiation outcome with no rationale is refused | flow | same flow → "a repudiation verdict with no rationale is refused; the transaction is unchanged" |
| 11 | EC-07: the review carries the trail it was decided from | flow | same flow → "the member's claim is reviewed and rejected; the review carries the trail it was decided from" |
| 12 | a partner token cannot reach the e-commerce routes | flow | `ecommerce: online-banking policy — …` → "a partner cannot reach the e-commerce routes (404 — they do not exist for it)" |

Totals: flow 12, added 0, contract 0, drop 0.

The flows also prove that no secret leaks into the evidence. The issued password hash and the new plaintext password appear in no event, and the plaintext is not on the credential row. They also cover the 404s on unknown credentials and transactions.
