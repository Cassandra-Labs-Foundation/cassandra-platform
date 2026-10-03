# ACH coverage ledger

Maps every `Deno.test` in `core/supabase/functions/api/ach.test.ts` (stubbed
Blnk + stubbed DB) to where the behaviour is exercised against the deployed core
in `core/verifier/flows/ach.test.ts`.

Flows (filter `ach:`):

- **F1** `ach: $11k debit → CG-LGTXN-01 + CTR alert → settle commits the hold → evidence pair`
- **F2** `ach: malformed submissions refused; NSF blocks before any hold (CG-NSF-01)`
- **F3** `ach: ACH-only volume past $25k/day is blocked by CG-VEL-01`
- **F4** `ach: settled entry returned late (R01) → compensating reversal + evidence`
- **F5** `ach: pre-settlement return voids the hold; every NACHA code accepted, unauthorized ones alerted`
- **F6** `ach: sandbox simulations run the real writer — gate, return codes, NOC`

| Stub test | Disposition | Where |
|---|---|---|
| submit requires an Idempotency-Key | added | F2 "malformed submissions are refused with field-level errors" |
| submit rejects a missing source_account_id | added | F2 "malformed submissions are refused with field-level errors" |
| submit rejects non-positive / non-integer amounts | added | F2 "malformed submissions are refused with field-level errors" (0, -5, 10.5) |
| submit rejects a settlement window outside the allowed set | added | F2 "malformed submissions are refused with field-level errors" |
| submit requires counterparty to be an object, not a scalar | added | F2 "malformed submissions are refused with field-level errors" ("Acme", 7, ["a"]) |
| settle COMMITS the hold and moves submitted -> settled | flow | F1 "the batch clears: settle commits the hold and the member is debited" (balance proves the commit; the exact Blnk PUT body is not asserted) |
| return VOIDS the hold and moves submitted -> returned | added | F5 "an R02 before settlement voids the hold: returned, nothing booked, no debit" |
| return retains the reason code in its own column, not in `window` | flow | F4 "the row keeps the code in its own column and the window intact"; F5 R02 step; F6 R10 step |
| return rejects a blank reason code rather than storing junk | added | F5 "a blank or unknown return code is refused and nothing is stored" |
| re-settling an already-settled entry replays, never double-commits | added | F1 "a duplicate settlement notice replays — no second commit, no second debit" |
| settling a returned entry is a 409 — money must not move after a return | flow | F4 "once returned, a settle is refused and a duplicate return replays"; F5 R02 step |
| resolving an entry with no hold is a 409, not a crash | drop | a `submitted` row without a Blnk hold only exists after a mid-submit Blnk failure; not reachable through the API without fault injection (rejected rows hit `invalid_state` first, F2) |
| resolving an unknown entry is a 404 | added | F2 "resolving an entry that does not exist is a 404" |
| a settled entry CAN be returned — returns arrive days later | flow | F4 "an R01 arrives after settlement: returned, money comes back" |
| a post-settlement return REVERSES rather than voiding | flow | F4 "an R01 arrives after settlement" (member credited back) + reversal evidence step; the exact Blnk POST arguments (`@ACHNetwork` → member, `:return` reference) are implementation detail |
| settling is still refused once returned | flow | F4 "once returned, a settle is refused and a duplicate return replays" |
| ach settle writes bookkeeping + ach_transfer.settled event | flow | F1 "settlement left its evidence pair: bookkeeping entry + ach_transfer.settled" |
| a pre-settlement return voids the hold and books nothing | added | F5 "an R02 before settlement voids the hold: returned, nothing booked, no debit" |
| a post-settlement return writes reversal artifacts | flow | F4 "the reversal left its evidence pair; R01 raises no unauthorized alert"; F6 R10 step |
| return refuses a code outside the NACHA set rather than storing it | flow | F6 "a bogus return code R99 is refused and not stored"; F5 blank/unknown step |
| every recognised return code is accepted | added | F5 "every recognised NACHA code is accepted; only R05/R07/R10/R29 raise an alert" (R02 in the void step) |
| an unauthorized-claim return raises a BSA alert; an ordinary one does not | flow | F6 "R10 is an unauthorized claim" + "an ordinary R01 return raises no unauthorized alert"; F5 per-code loop |
| a NOC records the correction WITHOUT changing status or moving money | flow | F6 "a NOC on a settled entry records the correction without changing status" |
| a NOC leaves a durable event — 'told and did nothing' is the audit finding | flow | F6 "the NOC left a durable event" (C01); F6 "a C02 routing correction is accepted with its own event" |
| a NOC carrying a field its code does not correct is refused | flow | F6 "a NOC whose corrections contradict its code, or an unknown code, is refused" |
| an unrecognised NOC code is refused | added | F6 "a NOC whose corrections contradict its code, or an unknown code, is refused" (C99) |
| a NOC on an entry that never reached the RDFI is refused | added | F2 "a rejected entry cannot be settled, and a NOC for it is refused" (live state is `rejected`; same guard as `pending_approval`) |

Counts: flow 13 · added 13 · contract 0 · drop 1 (27 tests).

Beyond the stub file, the flows also cover the bash script's gate behaviour
(CG-LGTXN-01 + ctr_threshold alert, CG-NSF-01 with no hold, CG-VEL-01 across
ACH volume), submission idempotency replay, and the partner read
`GET /ach-transfers/{id}`.
