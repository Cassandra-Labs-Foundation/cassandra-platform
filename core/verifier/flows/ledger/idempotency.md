# idempotency.test.ts → coverage ledger

Source: `core/supabase/functions/api/idempotency.test.ts` (6 tests, card 45: idempotency keys namespaced per partner). Contract: `core/verifier/contract/idempotency.test.ts` (D6) and `core/verifier/contract/auth.test.ts` (card 45 namespaces, minted `cass_test` callers). Flows: `core/verifier/flows/platform.test.ts`, `core/verifier/flows/ledger-integrity.test.ts`.

| test | disposition | where |
|---|---|---|
| the same Idempotency-Key from two partners is two independent claims | contract | D5-A16: two callers, one key, two fresh 201s with different ids. One instance hosts one partner (D18), so the namespace boundary is exercised caller-vs-caller; flow platform → "idempotency keys are per caller: ops reusing the partner's key is not a replay" |
| partner B never replays partner A's cached response | contract | D5-A16: B's call is not marked `Idempotent-Replayed` and returns its own id |
| storing a response cannot overwrite another partner's row | contract | D5-A16: after B writes (and conflicts) under the same key, A's retry still replays A's original id |
| the same partner replaying its own key still gets the cached response | contract | already there: D6-T1; D5-A17 adds the replay across two tokens of the same partner |
| the same partner reusing a key with a different body still conflicts | contract | already there: D6-T2; D5-A16 also checks it within one caller's namespace |
| an interrupted claim resumes on its original id, per partner | flow | `ledger: client — concurrent retries of one transfer post to the ledger exactly once` drives concurrent retries into the `resume` path and asserts one transfer id, one row, one ledger move. A truly interrupted first attempt needs a mid-flight kill (chaos tier) |

Counts: contract 5 · flow 1 · drop 0
