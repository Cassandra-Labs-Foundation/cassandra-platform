# Coverage ledger: `core/supabase/functions/_shared/blnk.test.ts` → ledger flows

Every `Deno.test` in the stubbed unit file is listed below, with where the Blnk writer client's behaviour is now proven through the deployed API and the live Blnk ledger. New steps live in `core/verifier/flows/ledger-integrity.test.ts`. Run them with `scripts/flow.sh -f ledger: --no-deploy`.

Disposition key:

- `flow`: covered by a step in an existing flow file.
- `added`: a step written in `ledger-integrity.test.ts`.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`.
- `drop`: no user-observable surface, or it needs Blnk fault injection.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | blnkReference | added | `ledger: webhook — a transfer's ledger write is stamped …` → "a $125 transfer settles …" (`transfer:<id>` on the row and in Blnk). Leg form: `ledger: inbox — …` → "the opening deposit's delivery reaches the inbox" (`account:<id>:open`) |
| 2 | recordTransaction happy path | added | `… a transfer's ledger write is stamped …` → "a $125 transfer settles and its ledger write carries the writer contract". It reads the Blnk transaction back and checks: `precise_amount` in integer cents, `precision 100`, currency, narration, `core_resource`, and APPLIED (`skip_queue`). |
| 3 | core_resource wins over caller metaData | added | `ledger: inbox — …` → "the opening deposit's delivery reaches the inbox". `core_resource` is stamped alongside the caller's own `allow_overdraft`. No live caller passes a *conflicting* `core_resource`, so the override itself is not provable. |
| 4 | duplicate reference fetches existing transaction | added | `ledger: client — concurrent retries of one transfer post to the ledger exactly once` → "three simultaneous retries: one transfer row, one ledger move, money moved once" (green) |
| 5 | duplicate reference but search empty throws BlnkError | added | Same flow → "no retry is answered with a server error" (**red, DEFECT**). Live, the throw surfaces to the partner as a 502 `bank_error` for a retry whose money did move. |
| 6 | duplicate reference rejects fuzzy search near-match | drop | Typesense fuzziness can't be steered from the API |
| 7 | non-duplicate 422 throws BlnkError with status | drop | Every core writer gates (NSF, velocity, status) before Blnk, so no API input makes Blnk 422 |
| 8 | amountCents validation throws RangeError without fetch | flow | The API refuses the same inputs first: `cards.test.ts` → "capture is refused for zero, negative and fractional amounts"; `wires.test.ts` / `ach.test.ts` malformed-submission steps |
| 9 | inflight record, commit, and void | flow | `cards.test.ts` (authorize → capture → reverse/expire); `ach.test.ts` ("settle commits the hold", "an R02 before settlement voids the hold"); `wires.test.ts` (confirm and cancel); `transfers.test.ts` ("the ledger adds up: … no stranded inflight") |
| 10 | createCustomerBalance stamps core_resource and returns mirror | added | `… a transfer's ledger write is stamped …` → "opening an account creates its ledger balance, stamped back to the account". The Blnk balance's `meta_data.core_resource` is the account, and `blnk_balance_id` is a `bln_` id. |
| 11 | getBalance and balanceMirror | added | `… a transfer's ledger write is stamped …` → "both mirrors agree with the ledger after the delivery"; `ledger: webhook — an ACH settlement's delivery refreshes the balance mirror …` |
| 12 | blnkConfigFromEnv | drop | Env parsing. A missing variable shows up as every flow failing. |

**Counts:** flow 2 · added 7 · contract 0 · drop 3 (total 12).

## Behaviours beyond the unit file

- **409 "a commit or void is already queued" retry** (`inflightPut`): covered by existing flows that reverse or capture straight after a capture. See `cards.test.ts` → "the merchant cancels: …" and "simulated partial then incremental capture accumulate". No step is added here.
- **Concurrent idempotent retries** reach the duplicate-reference path. The guarantee holds: one ledger move, one row, money moved once. The partner-facing answer does not: 500 from the transfer-row insert race, and 502 from the dedupe lookup missing the not-yet-indexed original. See the DEFECT in `ledger-integrity.test.ts`.
