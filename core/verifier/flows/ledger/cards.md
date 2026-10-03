# Coverage ledger: `core/supabase/functions/api/cards.test.ts` → card flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/cards.test.ts`. Run them with `scripts/flow.sh -f cards: --no-deploy`.

Disposition key:

- `flow`: covered by a ported bash section (12, 13, 14, 23, 34).
- `added`: a flow step written to close a gap the bash script left.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`. Not written here.
- `drop`: an implementation detail with no user-observable surface.

The stub tests also assert on what was sent to Blnk (`sent.length === 0`, `precise_amount` on the wire, `{status: "void"}`). Those are not ported as such. The flows check the effect a user can see instead: the row's `blnk_committed_amount` is unchanged after a refusal, and no `bookkeeping_entry` exists for a move that did not happen.

Flow names below are shortened: A = `cards: authorize → partial capture → …`, B = `cards: reverse an under-captured hold → …`, C = `cards: NSF declines before any hold → …`, D = `cards: sandbox simulate → …`.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | capture with no body captures the entire remaining hold | added | A → "capture with no amount takes the whole remaining hold" |
| 2 | partial capture moves to partially_captured and tracks the remainder | flow | A → "capture $300: partially_captured, remainder tracked"; D → "simulated partial then incremental capture accumulate" |
| 3 | incremental capture accumulates onto what was already captured | flow | A → "capture the exact $700 remainder: terminal captured"; D → "simulated partial then incremental capture accumulate" |
| 4 | over-capture by a single cent is refused, and never reaches Blnk | added | A → "over-capture is refused, not clamped — even by a single cent" (70,001 against a 70,000 remainder; the row's committed amount is unchanged) |
| 5 | capture is refused for non-positive or non-integer amounts | added | A → "capture is refused for zero, negative and fractional amounts" |
| 6 | re-capturing an already-captured authorization replays, never double-commits | flow | A → "re-capturing a captured authorization replays and commits nothing" (checks `Idempotent-Replayed` and that no third entry is written) |
| 7 | capturing a reversed authorization is a 409, not a silent no-op | added | B → "capturing a reversed authorization is a 409, not a silent no-op" |
| 8 | capturing a declined authorization is a 409 | added | C → "a declined authorization cannot be captured" |
| 9 | capture on an unknown authorization is a 404 | added | C → "capturing an authorization that does not exist is a 404" |
| 10 | reverse voids the hold and retains the already-captured amount | flow | B → "the merchant cancels: reversed, the $200 already captured stays captured" (also checks that `decline_reason` keeps the reason) |
| 11 | re-reversing replays instead of voiding twice | added | B → "re-reversing replays instead of voiding twice" |
| 12 | reversing a fully captured authorization is a 409 — nothing is held | added | A → "a captured authorization cannot be reversed or expired — nothing is held" |
| 13 | a capture writes bookkeeping + captured event keyed by running total | flow | A → "the first capture books its own $300 entry + a captured event" (entry id/amount, event code and payload) |
| 14 | an incremental capture gets a distinct evidence pair | flow | A → "the incremental capture got its own $700 evidence pair; entries sum to $1,000"; D → bookkeeping check in "simulated partial then incremental capture accumulate" |
| 15 | reverse releases the remainder and books nothing | added | B → "reversal books nothing — only the capture moved money" + "the member's balance reflects only the $200 that was captured" |
| 16 | an uncaptured auth expires: hold voided, funds released | flow | D → "a wholly uncaptured auth expires and releases the entire hold" |
| 17 | a partially-captured auth expires, keeping what was already captured | flow | D → "the partially-captured auth expires: captured stays captured, remainder released" + the `card_authorization.expired` event check |
| 18 | expiry books NO bookkeeping amount — the remainder never left | flow | D → "expiry books no money but leaves a card_authorization.expired event" |
| 19 | a captured auth cannot expire — there is no hold left to age out | added | A → "a captured authorization cannot be reversed or expired — nothing is held" (409 `invalid_state`) |
| 20 | re-expiring replays rather than double-voiding | added | D → "re-expiring replays rather than double-voiding" |
| 21 | expiry and reversal stay distinct terminal states | flow | D → row status `expired` with `decline_reason = authorization_expired`; B → row status `reversed` |

Totals: 10 `flow`, 11 `added`, 0 `contract`, 0 `drop`.

## Gaps the stub file could not see

The stubbed unit tests hand `postCardCapture` a row and never let the ledger answer back. Live, Blnk's `transaction.applied` webhook patches the card row about a second after each capture, so the flows wait for it (`ledgerSettles`) before taking the next merchant action. That wait exposed two defects in `core/supabase/functions/blnk-webhook/handlers.ts`. Each is marked `// DEFECT` in the flow file:

- line 144: `ID_COLUMN.card_authorization = "blnk_inflight_id"` overwrites the inflight hold id with the APPLIED child transaction id. Every later capture, reverse or expire then targets the child and returns 502 `bank_error`.
- lines 151–153: `blnk_committed_amount` is set to the child's `precise_amount`, which is this one increment, not the running total. The card reads back under-captured, and the over-capture guard computes a remainder that is too large.
