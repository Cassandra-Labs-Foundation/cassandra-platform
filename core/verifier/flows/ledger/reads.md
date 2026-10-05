# Coverage ledger: `core/supabase/functions/api/reads.test.ts` → read flows

Every `Deno.test` in the stubbed unit file, and where its behaviour is now proven against the deployed core. New steps live in `core/verifier/flows/reads.test.ts`; run them with `scripts/flow.sh -f reads: --no-deploy`.

Disposition key: `flow` (an existing flow step covers it) · `added` (a step written in `reads.test.ts`) · `contract` (already in `core/verifier/contract/`) · `drop` (no user-observable surface).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | every rail list is confined to one partner BEFORE any caller filter | added | `reads: rail lists are confined …` → "each rail's status filter finds this run's row and only this partner's rows" (every listed id's DB `partner_id` is the partner's), and "operations (D23) lists across partners; the partner never sees the foreign row" |
| 2 | an ops actor lists every rail across partners — D23 | added | same flow → "operations (D23) lists across partners; the partner never sees the foreign row" (wire + ACH; the demo instance holds no foreign card rows to probe) |
| 3 | each rail refuses a status outside its OWN vocabulary | added | same flow → "each rail refuses a status from ANOTHER rail's vocabulary, naming the field" |
| 4 | dual_control_status is validated, and is what makes an approval id resolvable | added | same flow → "dual_control_status is validated, and filtering on it finds the wire awaiting approval" |
| 5 | a malformed id on a uuid-keyed rail is 404, not 500 | added | same flow → "a malformed id and a well-formed absent uuid both 404 the same way on wire and ACH" |
| 6 | a well-formed but absent uuid is also 404 — the two are indistinguishable | added | same step |
| 7 | a member the caller cannot see is 404, NOT an empty verification list | added | `reads: a member's verification history …` → "another partner's member is a 404 — not an empty 'never verified' list" |
| 8 | the entity gate is partner-scoped, and the list is keyed on entity_id | flow | `onboarding.test.ts` → `onboarding: KYC through the adapter …` → "the member's verification history shows every run, newest first"; also `onboard_transfer_large_txn.test.ts` → "verify the sender: KYC approves and OFAC clears". Partner scoping of the gate is row 7's step |
| 9 | a verification read omits provider_result — it is the vendor's raw payload | added | `reads: a member's verification history …` → "after a KYC run the history shows it — but never the vendor's raw provider_result" (asserts the stored row DOES carry one) |
| 10 | the projection itself never names provider_result | added | same step: the live row has a non-null `provider_result` and the response has no such key, which is the observable form of "the SELECT never asked for it" |
| 11 | an empty list still says the pre-migration rows cannot appear | added | same flow → "a member never verified: an empty history that still names the pre-linkage caveat" |

**Counts:** flow 1 · added 10 · contract 0 · drop 0 (total 11).
