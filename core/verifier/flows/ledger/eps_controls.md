# Coverage ledger: `core/supabase/functions/api/eps_controls.test.ts` → EPS controls flows

Every `Deno.test` in the stubbed unit file, and where its behaviour is now proven against the deployed core. Steps live in `core/verifier/flows/eps_controls.test.ts`; run with `scripts/flow.sh -f eps_controls: --no-deploy`. Lockouts are applied only to authentication subjects the flow invents. Positive-pay exceptions use 1900s cutoffs, so they sit inside the fraud review's 200-row window, and they are deleted at the end.

Disposition key: `flow` (an existing flow step covers it) · `added` (a step written for this port) · `contract` (already in `core/verifier/contract/`) · `drop` (no user-observable surface, or unproducible on the shared instance).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | EPS-05: the third consecutive failure locks out IN THE SAME WRITE | added | `eps_controls: EPS-05 …` → "three consecutive failures: denied, denied, LOCKED OUT …" |
| 2 | EPS-05: a challenged failure records HOW the member was challenged | added | same flow → "a challenged failure records HOW the member was challenged …" |
| 3 | EPS-05: a success RESETS the chain — fail,fail,success,fail is denied, not locked | added | same flow → "a success RESETS the chain …"; plus "every attempt is its own record …" — **red: DEFECT** |
| 4 | EPS-05: a lockout is not forever — success after lockout starts a fresh chain | added | same flow → "a lockout is not forever …" (judgement call below) |
| 5 | EPS-05: a success is allowed and carries a zero failure count | added | same flow → "a success is allowed and carries a zero failure count" |
| 6 | an auth event with no usable outcome is refused | added | same flow → "a partner cannot post authentication decisions; an attempt with no usable outcome is refused …" |
| 7 | EPS-07: the FIRST application of a card control is not a 'change' | added | `eps_controls: EPS-07 — a member's card controls …` → "the FIRST application of travel mode …" |
| 8 | EPS-07: a changed control carries the value it replaced | added | same flow → "turning it off is a change …"; plus "toggling back and forth …" — **red: DEFECT** |
| 9 | EPS-07: a pospay decision lands complete — decision, decider, timestamp | added | `eps_controls: EPS-07 — positive-pay …` → "operations returns the item …" |
| 10 | EPS-07: deciding a nonexistent exception is a 404, not a 200 with a phantom event | added | same flow → "a decision must be pay or return and name the decider; deciding a nonexistent exception is 404 …" |
| 11 | EPS-07: a decision is decided ONCE — the second attempt is a 409, not an overwrite | added | same flow → "a decision is decided ONCE …" |
| 12 | EPS-07: a decision past the cutoff is recorded as late | added | same flow → "a decision past the cutoff is recorded as LATE …" |
| 13 | an undecided exception past its cutoff PAYS BY DEFAULT, and the review says so | added | same flow → "the fraud-trend review names the undecided exception past its cutoff …" (asserts on this flow's ids; `examined` is instance-wide so it is not pinned) |

**Counts:** flow 0 · added 13 · contract 0 · drop 0 (total 13).

## Flow steps beyond the unit file

- **DEFECT (EPS-05):** auth rows are keyed `epsauth_<subject>_<failure_count>_<outcome>`. A later attempt with the same count and outcome (for example the first failure of a new chain) upserts over the earlier row, and its events are dropped as duplicates. Bob's four attempts leave three rows. The lockout decision is still right, but the attempt history an examiner reads is not.
- **DEFECT (EPS-07):** card-control rows are keyed `epscc_<card>_<type>_<value>`, and the previous value is read as the newest `created_at`, which an upsert never advances. On, off, on, off: the fourth application reports `previous_value: "off"` and no change event. The live demo row `epscc_card_1_intl_block_off` (previous "off", new "off") shows the same thing.
- A partner is refused (403) on auth, card-control, positive-pay and fraud-review routes. A card control with missing fields, and a positive-pay exception with no cutoff, are 400.

## Judgement call

- EPS-05 "a lockout is not forever": a success after lockout is `allowed` and resets the chain. So the lockout blocks nothing beyond recording the decision; a locked-out member can still log in. The stub encodes this behaviour and the flow keeps it, but whether a lockout should hold until an unlock (by time or by an admin) is a policy decision for the user.

### Added 2026-10-06 (stubs written with the EPS-05 / EPS-07 fixes)

| test | disposition | where |
|---|---|---|
| EPS-05: every attempt is its own record — fail,fail,success,fail leaves four rows and four decisions | flow | `eps_controls.test.ts` → "every attempt is its own record: Bob's four attempts leave four auth rows in order" |
| EPS-07: toggling on,off,on,off — every application is its own row and carries the value it replaced | flow | `eps_controls.test.ts` → "toggling back and forth: on again replaces off, and off again replaces on" |
