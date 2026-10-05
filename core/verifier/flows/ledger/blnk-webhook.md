# Coverage ledger: `core/supabase/functions/blnk-webhook/handlers.test.ts` → ledger flows

Every `Deno.test` in the stubbed unit file is listed below, with where its behaviour is now proven against the deployed `blnk-webhook` function. Flows live in `core/verifier/flows/ledger-integrity.test.ts`. Run them with `scripts/flow.sh -f ledger: --no-deploy`.

Disposition key:

- `flow`: covered by a step in an existing flow file.
- `added`: a step written in `ledger-integrity.test.ts`. **(opt-in)** means the step is in a fault-injection flow that only runs with `LEDGER_FAULT_INJECTION=1`. Those steps have **not been run live yet**, because invoking them was blocked by a permission decision in this session.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`.
- `drop`: no user-observable surface, or it needs a fault the live system can't produce safely. Each drop says what that leaves unproven.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | eventKey: two trips of the same monitor are distinct events | drop | No Blnk balance monitor is configured, and a synthetic `balance.monitor` would open a real BSA alert with a running triage clock. **Unproven:** a repeat trip of one monitor gets its own inbox row. |
| 2 | eventKey: a redelivery of ONE trip still dedups | added | Proven for the transaction form, not the monitor form: `ledger: webhook — unsigned, forged and stale …` → "Blnk redelivering the SAME event is acked as a duplicate and applied nothing twice" |
| 3 | eventKey: transactions still anchor on transaction_id | added | `ledger: webhook — a transfer's ledger write is stamped …` → "the transaction.applied delivery is recorded once …" (`id = transaction.applied:<txn>`) |
| 4 | eventKey: ledger.created anchors on ledger_id | drop | No core writer creates Blnk ledgers, so the event is never delivered |
| 5 | eventKey: an id-less event fingerprints its payload, not a shared literal | added (opt-in) | `ledger: webhook — a queued move's _q child …` → "an unknown event is stored and skipped …" (a second id-less payload is its own event) |
| 6 | balance.monitor raises a BSA alert with the triage clock started | drop | Same reason as #1: the alert would enter the production BSA queue. **Unproven:** a Blnk monitor trip reaches `bsa_alert` through `raiseAlert`. |
| 7 | balance.monitor without a matching account throws (inbox marks it failed) | added (opt-in) | `ledger: reconciler — an undeliverable event counts attempts …` → first step (signed monitor for an unowned balance → stored `failed`, `no account for balance`) |
| 8 | balance.monitor without a balance_id throws rather than guessing | drop | Guards against a malformed Blnk payload that Blnk does not send |
| 9 | reconciliation.completed advances the cursor and flags unmatched items | drop | No Blnk reconciliation runs are configured. A synthetic run would move the shared `blnk_sync_state.reconciliation` cursor and open production findings. **Unproven.** |
| 10 | reconciliation.completed with everything matched opens no finding | drop | Same as #9 |
| 11 | reconciliation.failed opens a high-severity finding | drop | Same as #9 |
| 12 | system.error opens a finding — nothing else surfaces Blnk internals | drop | A synthetic error would open a production-provenance finding. The live inbox does hold one processed `system.error`, but no flow asserts it. **Unproven by a flow.** |
| 13 | bulk_transaction.failed opens a finding | drop | No core writer uses Blnk bulk transactions |
| 14 | bulk_transaction.applied mirrors every inline constituent | drop | Same as #13 |
| 15 | bulk_transaction: one bad constituent does not strand the others | drop | Same as #13 |
| 16 | coreReference: recovers the reference our writers actually stamped | added (opt-in) | `ledger: webhook — a queued move's _q child …` → "a signed applied child with reference `transfer:<id>_q` …" (the row keeps the canonical reference) |
| 17 | a queued transaction's `_q` child still finds its core row | added (opt-in) | Same step. It is synthetic because every live writer sends `skip_queue: true`, so no queued `_q` child occurs in live traffic. |
| 18 | a row already stamped `_q` by an earlier delivery is still matched | drop | The handler writes the canonical spelling, so a `_q`-stamped row only exists in pre-2026-08-11 data |
| 19 | core_resource still wins over the reference fallback | added | Routing by `core_resource` is proven on every live delivery: `… a transfer's ledger write is stamped …` (routed to `resource_type=transfer`, `resource_id=<id>`), and the ACH flow (`ach_transfer`). Precedence over a *conflicting* reference is not provable live, because the two always agree. |
| 20 | an unknown event is stored and skipped, never failed | added (opt-in) | `ledger: webhook — a queued move's _q child …` → "an unknown event is stored and skipped …; its redelivery is a duplicate" |

**Counts:** flow 0 · added 9 (4 opt-in) · contract 0 · drop 11 (total 20).

## Flow steps beyond the unit file

These are the transport and apply guarantees that the hermetic handler tests never reached:

- **Signature verification** (`index.ts`, not unit-tested). In `ledger: webhook — unsigned, forged and stale deliveries are refused …`:
  - GET returns 405.
  - Missing headers, a wrong secret, a garbage signature and a body swapped after signing each return 401.
  - A correctly signed delivery more than 5 minutes stale, or future-dated, returns 401 with "replay window".
  - Each refusal is checked to leave no inbox row and an untouched transfer.
- **Idempotent redelivery**: re-signing the stored payload of a processed delivery returns `{duplicate:true}`. The inbox row's `processed_at`, `updated_at` and `attempts` don't change, the transfer row is not re-stamped, and no balance moves.
- **balance.created** is recorded `processed`, links `blnk_balance_id`, and does **not** zero the funded mirror with its birth snapshot. This guards the `applyBalance` regression. Step: "balance.created is recorded and processed …"
- **The applied delivery is processed once against its row**: exactly one inbox row, `attempts 0`, `synced_at` stamped, and the reference kept canonical.
- **Balance-mirror refresh on `transaction.applied`**: `ledger: webhook — an ACH settlement's delivery refreshes the balance mirror …`. The ACH writer never refreshes the balance inline, so the debit appearing, with `balance_synced_at` at or after the delivery, can only come from `refreshBalanceMirrors`.
- **DEFECT, opening deposits**: `ledger: inbox — a funded account opening leaves no failed delivery behind` → "the opening deposit's delivery is not recorded as failed" (red; see the DEFECT comment).

## Existing flows that already depend on the webhook

| Behaviour | Flow + step |
|---|---|
| A card capture's APPLIED child is applied without replacing the hold id | `cards.test.ts` → "once the ledger confirms the capture, the remaining hold is still the one we placed" |
| The webhook leaves the card's running `blnk_committed_amount` alone | `cards.test.ts` → "after the ledger confirms, the partner reads the card back with the same arithmetic"; "after the ledger confirms, the running total is still $500" |
| A reverse or expire after the confirmation still targets the original hold | `cards.test.ts` → "the merchant cancels: …"; "the partially-captured auth expires: …" |
| The ACH balance mirror is refreshed by the delivery, not by the writer | `ach.test.ts` → `expectBalance` in "the batch clears: …", "the batch settles …", and the return flows |
| The wire balance reflects the ledger after commit or void | `wires.test.ts` → the balance helper at line 47, used by the confirm, cancel and return steps |
