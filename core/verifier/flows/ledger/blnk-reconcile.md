# Coverage ledger: `core/supabase/functions/blnk-reconcile/sweeps.test.ts` → ledger flows

Every `Deno.test` in the stubbed unit file is listed below, with where its behaviour is now proven against the deployed `blnk-reconcile` function. Flows live in `core/verifier/flows/ledger-integrity.test.ts`. Run them with `scripts/flow.sh -f ledger: --no-deploy`. The fault-injection flows also need `LEDGER_FAULT_INJECTION=1`.

Disposition key:

- `flow`: covered by a step in an existing flow file.
- `added`: a step written in `ledger-integrity.test.ts`. **(opt-in)** means the step creates drift on the flow's own fixtures and then invokes the deployed reconciler the way `pg_cron` does (POST + `X-Reconcile-Key`). It only runs with `LEDGER_FAULT_INJECTION=1`. **None of the opt-in steps have been run live**, because invoking the reconciler with drift was blocked by a permission decision in this session.
- `drop`: no user-observable surface, or it needs a fault the live system can't produce safely. Each drop says what that leaves unproven.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | card authorization live hold in sync: synced_at touched, nothing else | added (opt-in) + added | Opt-in: `ledger: reconciler — a card hold's committed total is re-summed …` → "in sync: …" (marked DEFECT). Live, read-only: `ledger: reconciler inputs — …` → "the child's amount is numeric, so the card sweep's re-sum equals the captured $300" (**red, DEFECT**) |
| 2 | card authorization: applied children sum into blnk_committed_amount and the recovery event is emitted | added (opt-in) + added | Opt-in: same flow → "drifted: a total of $0 is re-summed to $300 and blnk.mirror.recovered is written" (DEFECT). The live read-only steps "the hold's capture is findable as an APPLIED child of the hold" (green) and the numeric-amount step (red) cover the same ground. |
| 3 | card authorization: a VOID child is REPORTED, not guessed into a status | drop | Needs Blnk to void a hold behind the core's back. **Unproven:** `blnk.hold_released_upstream` is emitted for an upstream void. No such event has ever been written live (0 rows). |
| 4 | inbox: a failure below the cap stays retryable and counts an attempt | added (opt-in) | `ledger: reconciler — an undeliverable event counts attempts …` → "one reconcile run re-drives it: still failed, one attempt counted, not dead-lettered". The synthetic row is deleted in `finally` so it can never dead-letter. |
| 5 | inbox: the last attempt parks the row as dead_letter and opens a finding | drop | Driving test data to the cap would open a production-provenance HIGH finding. **Unproven by a flow.** It is observed live, though: 178 `blnk_inbox_dead_letter` findings exist, all from the opening-deposit DEFECT in `blnk-webhook.md`. |
| 6 | inbox: an unusable payload counts an attempt instead of being skipped forever | drop | The webhook 400s a payload without `event`/`data` before storing it, so such a row only exists through a direct DB insert |
| 7 | inbox: dead_letter is terminal — the sweep never picks it back up | drop | Needs a dead-lettered row of our own, which means the cap from #5. **Unproven.** |
| 8 | inbox: the backlog alarm counts parked rows too | drop | It is a global count over every partner's rows, so no fixture of ours can isolate it. Observed live, not asserted: `blnk.inbox_backlog` has fired 1,860 times with `failed_count` 605. |
| 9 | balance drift: only ids Blnk could have issued are swept | drop | An internal selection filter. The placeholder-id accounts belong to the drill, not to this suite. |
| 10 | balance drift: moved-since-sync accounts preempt the round-robin | drop | The opt-in drift flow reaches its account through the nulls-first tail pass, not the `accounts_pending_resync` priority pass. **Unproven:** a moved account is repaired within one run. |
| 11 | balance drift: the drill's placeholder ids cannot match that filter | drop | Constant check with no runtime surface |

**Counts:** flow 0 · added 3 (all opt-in; 1 and 2 also have live read-only steps) · contract 0 · drop 8 (total 11).

## Flow steps beyond the unit file

- **Auth on the deployed function** (live, green): `ledger: reconciler — only pg_cron's keyed POST may run the sweeps`. GET returns 405, a POST with no `X-Reconcile-Key` returns 401, a wrong key returns 401, and none of them returns a sweep summary.
- **Balance drift repair** (opt-in): `ledger: reconciler — a drifted balance mirror is repaired from the ledger, with drift evidence`. The flow's own account mirror is set to $0.01 and swept, and the mirror goes back to $640. One `blnk.balance_drift` event is written with `mirrored`, `actual` and `blnk_balance_id`. A second run writes no second event.
- **Stalled-delivery re-dispatch** (opt-in): `ledger: reconciler — a delivery that stalled before dispatch is re-driven through the same handler`. A `received` inbox row carrying the transfer's real payload, backdated past the grace window, is processed by the sweep and re-stamps the transfer. A processed row is never re-driven.
- **What the sweeps read** (live, read-only): `ledger: reconciler inputs — the ledger search the sweeps depend on returns what they parse`. Steps:
  - the capture is an APPLIED child of the hold (green)
  - the child's `precise_amount` is numeric (**red, DEFECT**)
  - `created_at` is an ISO string (**red, DEFECT**)

## Guarantees that are now unproven

- **Missing-mirror detection (`sweepMissingMirrors`) is unproven and is in fact dead live.** Blnk search returns `created_at` as unix seconds, so every transaction is skipped and the `missing_mirror` cursor has been frozen at 2026-07-15. No flow can show a severed ledger→core link being flagged until that is fixed.
- **Stuck-row recovery (`sweepStuckRows`)**: a crash between the Blnk write and the settle update can't be produced live. Dropped with no unit-test counterpart here, and **unproven**.
- **Upstream hold release**: see #3.
- **Dead-letter parking and terminality**: see #5 and #7.
- **Every opt-in step**: all of them stay unproven until someone runs `LEDGER_FAULT_INJECTION=1 scripts/flow.sh -f ledger: --no-deploy`.
