# Coverage ledger: `core/supabase/functions/api/wires.test.ts` → wire flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/wires.test.ts`. Run them with `scripts/flow.sh -f wires: --no-deploy`.

Disposition key:

- `flow`: covered by a ported bash section (5, 6, 7, 15, 17, 20, 21, 22, 33).
- `added`: a flow step written to close a gap the bash script left.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`. Not written here.
- `drop`: an implementation detail with no user-observable surface.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | prepare requires an Idempotency-Key | added | wires: domestic only … → step "malformed prepares are refused with the field named, and confirm on an unknown wire is 404" |
| 2 | prepare rejects a missing source_account_id | added | wires: domestic only … → step "malformed prepares are refused with the field named, and confirm on an unknown wire is 404" |
| 3 | prepare rejects non-positive / non-integer amounts | added | wires: domestic only … → step "malformed prepares are refused with the field named, and confirm on an unknown wire is 404" |
| 4 | prepare requires a beneficiary object, not a scalar or array | added | wires: domestic only … → step "malformed prepares are refused with the field named, and confirm on an unknown wire is 404" |
| 5 | confirm commits the inflight hold and moves submitted -> completed | flow | `wires: $11k wire …` → "confirm commits the hold: completed, money left, evidence pair written" |
| 6 | cancel voids the hold and moves submitted -> canceled | added | `wires: cancel releases a hold; …` → "a held wire cannot be returned — cancel is the verb; cancel moves no money" |
| 7 | confirm on a non-submitted wire is a 409, and touches Blnk not at all | added | same step: confirm after cancel → 409, balance untouched |
| 8 | re-confirming an already-completed wire replays instead of double-committing | added | `wires: $11k wire …` → "re-confirming replays instead of double-committing" |
| 9 | confirm rejects a partial amount greater than the held amount | added | `wires: cancel releases a hold; …` → "partial confirm: over-the-hold refused; …" |
| 10 | confirm passes a valid partial amount through to the commit | added | same step: $2,000 of a $5,000 hold settles; the balance drops by $2,000 only |
| 11 | confirm on an unknown wire is a 404 | added | wires: domestic only … → step "malformed prepares are refused with the field named, and confirm on an unknown wire is 404" |
| 12 | a beneficiary carrying a SWIFT/BIC code is refused | flow | `wires: domestic only …` → "SWIFT, BIC and a DE beneficiary are each refused …", plus the simulator variant (§17, §33) |
| 13 | a non-US beneficiary country is refused | flow | same flow (DE direct, MX via simulator); "refused wires strand nothing: no row" |
| 14 | an explicit US beneficiary is accepted (case-insensitive) | flow | same flow → "an explicit US beneficiary (any case) is accepted" |
| 15 | a completed wire accepts a return request and records the reason | flow | `wires: completed wire → return requested → ACCEPTED …` → "request the return …" (§20) |
| 16 | a return request without a reason is refused | added | same flow → "a return request needs a reason" |
| 17 | a submitted (held) wire cannot be returned — cancel is the verb | added | `wires: cancel releases a hold; …` → first step |
| 18 | re-requesting a return replays instead of erroring | added | `wires: completed wire → … ACCEPTED …` → "request the return: …; re-request replays" |
| 19 | an ACCEPTED resolution reverses via compensating entry and lands returned | flow | same flow → "ACCEPT: returned, reason retained, money credited back …" (§20) |
| 20 | a REJECTED resolution restores completed and keeps the reason trail | flow | `wires: return request REJECTED …` (§21) |
| 21 | resolve is only valid from return_requested | added | `wires: completed wire → … ACCEPTED …` → "a completed wire with no pending claim cannot be resolved" |
| 22 | resolve rejects an unknown outcome | added | same flow → "an unknown outcome is refused" (checks that state is unchanged, not only the 400) |
| 23 | resolving an already-returned wire replays | added | same flow → "resolving an already-returned wire replays — no second credit" |
| 24 | wire confirm writes bookkeeping + wire_transfer.completed event | flow | `wires: $11k wire …` → confirm step, and the §22 evidence step of the return flow |
| 25 | a partial confirm records the amount that actually moved | added | `wires: cancel releases a hold; …` → partial step (`bke_*_completed.amount`, event `amount_cents` / `held_cents`) |
| 26 | wire cancel moves no money and writes no artifacts | added | `wires: cancel releases a hold; …` → first step (no `bke_*_completed` / `evt_*_completed`) |
| 27 | an accepted wire return writes its own reversal artifacts | flow | `wires: completed wire → … ACCEPTED …` → "evidence (§22): …" |
| 28 | a partial confirm releases the unconfirmed remainder | drop | No API surface exposes Blnk `inflight_debit_balance`, so a stranded remainder is invisible to a user. The conservation sweep owns that residue check. |
| 29 | a full confirm voids nothing — there is no remainder | drop | Asserts the number of Blnk calls |
| 30 | a confirm for exactly the held amount is a full confirm | drop | Asserts the number of Blnk calls |
| 31 | remainder release survives a transient void failure by retrying | drop | Needs Blnk fault injection; cannot be provoked against the live ledger |
| 32 | reject VOIDS the hold and moves submitted -> rejected | flow | `wires: sandbox simulator …` → "the network rejects a held wire: …" (§33) |
| 33 | reject requires a reason — an unexplained rejection is not auditable | added | same step: a reasonless reject gets 400 and the wire stays held |
| 34 | a COMPLETED wire cannot be rejected — it must be returned | flow | same flow → "re-rejecting replays; a COMPLETED wire cannot be rejected …" (§33) |
| 35 | re-rejecting replays rather than double-voiding | added | same step |
| 36 | reject books no money but emits the rejection event | flow | same flow → "evidence: zero-amount bookkeeping + wire_transfer.rejected event …" (§33) |
| 37 | a wire awaiting its second approver cannot be confirmed | added | `wires: $11k wire …` → "confirm before approval is refused: dual_control_required …" (also via the simulator in §33) |
| 38 | a wire the second approver REJECTED cannot be confirmed either | added | `wires: cancel releases a hold; …` → "the second approver REJECTS: …" |
| 39 | an UNASSESSED wire cannot be confirmed — unknown is not permission | drop | No API path can produce `unassessed` on a wire, because prepare always writes `required` |
| 40 | prepare records the originator and marks dual control required | added | `wires: $11k wire …` → "the row records its originator and that dual control is REQUIRED" |

**Counts:** flow 12 · added 18 · contract 5 · drop 5 (total 40).

## Flow steps beyond the unit file

These steps come from the bash sections or close gaps that neither source covered:

- **§5:** CG-LGTXN-01 fires on a wire over $10k. It is asserted on the response, in `control_result`, and as a `ctr_threshold` `bsa_alert`. The bash script expected CG-CTR-01, which is stale: CTR-01 is the cash control.
- **§6:** CG-NSF-01 reject is asserted. The rejected row has no Blnk hold.
- **Added to §6 (fails until fixed):** a second wire against funds already held by a pending wire must be refused with NSF.
- **§7 wire half:** the velocity cap is checked twice. First on wire volume alone (the fifth $6k wire is blocked). Then across rails: a $20k wire followed by a $6k book transfer is blocked.
- **§15:** outbound structuring fires CG-STR-02 on the third $4k wire and not before. The `structuring` alert names both the account and the wire.
- **EPS-06:**
  - The preparer cannot approve their own wire (`dual_control_violation`).
  - `payment_approval` records the preparer, the approver and the rejecter.
  - The partner's GET of a wire shows `dual_control_status`.
