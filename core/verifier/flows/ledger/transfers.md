# Coverage ledger: `core/supabase/functions/api/transfers.test.ts` → transfer flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/transfers.test.ts`. Run them with `scripts/flow.sh -f transfers: --no-deploy`.

Disposition key:

- `flow`: covered by a ported bash section (1, 2, 4, 8, 16, 19, 24, 25 of `compliance_e2e.sh`) or by `onboard_transfer_large_txn.test.ts`.
- `added`: a flow step written to close a gap the bash script left.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`. Not written here.
- `drop`: an implementation detail with no user-observable surface.

Flow short names:

- **book** = `transfers: book transfer — clean, NSF, exact balance, $10k line, velocity cap, evidence`
- **structuring** = `transfers: structuring — 3 × $4k into one account flags CG-STR-01; one $11k flags CTR only`
- **cross-rail** = `transfers: cross-rail — ACH + card + book aggregate for CG-STR-02 and CG-VEL-01`
- **conservation** = `transfers: conservation — book, wire (returned + partial), ACH (late return), card captures add up`
- **statement** = `transfers: statement — operations sees partner transfers; bad filters are refused, not widened`

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | a small, funded transfer passes with no control artifacts | flow | book → "a small, funded transfer settles with no control artifacts (§1)" |
| 2 | NSF blocks, rejects the row, and records CG-NSF-01 | flow | book → "NSF is refused, the row rejected, CG-NSF-01 persisted (§2)" |
| 3 | a balance exactly equal to the amount is sufficient, not NSF | added | book → "a balance exactly equal to the amount is sufficient, not NSF" |
| 4 | a transfer over $10k raises CG-LGTXN-01 and a CTR bsa_alert but still settles | flow | `onboard_transfer_large_txn.test.ts`, plus structuring → "a single $11k on a $4k day …" |
| 5 | a transfer of exactly $10k does NOT trip CG-LGTXN-01 | added | book → "exactly $10,000 trips nothing — the large-txn line is strictly above" |
| 6 | velocity blocks when prior volume plus this transfer exceeds the daily cap | flow | book → "one cent over the cap is BLOCKED with CG-VEL-01 only (§4)" |
| 7 | velocity lands exactly on the cap without blocking | added | book → "velocity lands exactly on the $25k cap without blocking" |
| 8 | velocity aggregates ACROSS rails, not just book transfers | added | cross-rail → "$8k wire hold + $8k ACH + $8k card hold, then a $2k book transfer is BLOCKED" |
| 9 | structuring fires when daily inflow aggregates past $10k with every transfer under it | flow | structuring → "the third $4k takes the day to $12k … (§8)" |
| 10 | structuring does not fire when the aggregate stays under the line | added | structuring → "$4k + $4k into one account: aggregate $8k stays silent" |
| 11 | a single large transfer raises CTR only, never both CTR and structuring | added | structuring → "a single $11k on a $4k day (both legs) raises CG-LGTXN-01 only …" |
| 12 | structuring is skipped entirely when there is no destination account | added | cross-rail → first step: the ACH and card legs carry no CG-STR-01 |
| 13 | a blocked card authorization is written as 'declined', not 'rejected' | added | cross-rail → "the same cap declines a card authorization …" (row status read back) |
| 14 | the error envelope names the rail that was actually blocked | added | cross-rail → same step (`resource_type: card_authorization`); book → NSF step (`resource_type: transfer`) |
| 15 | outbound structuring fires when daily outflow aggregates past $10k under the line | added | book → "velocity: 4 × $6k settle; outbound structuring flags the $12k day (CG-STR-02)" |
| 16 | outbound structuring aggregates ACROSS rails | flow | cross-rail → "$4k ACH + $4k card hold + $4k book transfer: the book leg flags CG-STR-02 (§16)" |
| 17 | outbound structuring stays silent below the aggregate line | added | book → velocity step (first $6k); cross-rail → first step (ACH, then card) |
| 18 | a single large outbound raises CTR only, not outbound structuring | added | structuring → "a single $11k on a $4k day (both legs) …" (sender already sent $4k) |
| 19 | outbound structuring is not double-reported alongside a velocity block | added | book → "one cent over the cap is BLOCKED with CG-VEL-01 only (§4)" (exactly one control_result row) |
| 20 | a settled transfer writes its bookkeeping entry | flow | book → "the settled transfer left its bookkeeping entry + transfer.settled event (§19)" |
| 21 | a settled transfer writes a transfer.settled event | flow | book → same step (code, type, resource_id, payload, entity_hash = sha256(source)) |
| 22 | settlement artifacts are duplicate-ignoring upserts (resume-safe) | drop | The `ignoreDuplicates` upsert option. The resume path needs a crash between the Blnk write and settlement, which no caller can stage. |
| 23 | the transfer list is confined to one partner, before any filter | drop | Not observable here: the demo instance hosts one fintech (D18; `ptnr_drill` lives on `inst_drill`). Adding a second active partner to `inst_local` would make every ops write ownerless. |
| 24 | account_id matches EITHER leg | added | book → "the partner finds the transfer on BOTH legs' statements" |
| 25 | an account_id cannot smuggle a second filter term into the or-list | added | statement → "the list refuses bad filters instead of widening them" (all five injection strings) |
| 26 | an ops actor lists transfers across partners — D23 | added | statement → "operations (D23) reads the partner's transfer by id and on the account statement" |
| 27 | an unknown transfer status is refused | added | statement → "the list refuses bad filters …" |
| 28 | every legal transfer status is accepted | added | statement → same step (all six statuses list) |
| 29 | the list serves amount_cents, matching the single-transfer read | added | book → "the partner finds the transfer on BOTH legs' statements" |

Counts: flow 8, added 19, contract 0, drop 2.

Section 24 (conservation) has no unit-test counterpart. It is in **conservation** and reads the Blnk ledger directly: CA must end at $8,300 and CB at $6,000, with zero `inflight_debit_balance` on both.
