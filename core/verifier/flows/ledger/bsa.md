# Coverage ledger: `core/supabase/functions/api/bsa.test.ts` → BSA case-chain flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/bsa.test.ts`. Run them with `scripts/flow.sh -f bsa: --no-deploy`.

Disposition key:

- `flow`: covered by a ported bash section (35, 36).
- `added`: a flow step written to close a gap the bash script left.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`. None here.
- `drop`: no user-observable behaviour, or unreachable on the live core.

Flow names are shortened: **F1** = `bsa: alert → triage → case → SAR filed …`, **F2** = `bsa: resolve-with-rationale opens no case …`, **F3** = `bsa: the timer sweep surfaces what nobody did …`, **F4** = `bsa: retention — closure starts a 5-year clock …`.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | raiseAlert writes the causing event FIRST, then points the alert at it | flow | F1 → "a $12k transfer raises an alert whose causing event was written first (OQ-05)" (event_id set, `bsa_alert.created`, event `created_at` ≤ alert `created_at`, triage-timer event) |
| 2 | alert ids are deterministic so a retried gate cannot duplicate them | flow | F1 → same step: the alert is found at `alert_<transfer>_ctr_threshold` by construction |
| 3 | a raised alert carries its 2-business-day triage deadline | flow | F1 → "the 2-business-day triage clock started at creation …" |
| 4 | business-day arithmetic skips weekends | added | F1 → same step: `triage_due_at` equals creation + 2 business days (weekends skipped) for the run's actual day |
| 5 | the triage deadline never lands on a weekend | added | F1 → same step (one real day per run, not a 14-day sweep) |
| 6 | escalating opens a case and starts the SAR clock from DETECTION | flow | F1 → "escalating opens a case; the SAR clock runs 30 days from DETECTION"; F3 → "triaging late does not buy time …" (detection back-dated 10 days, due = detection + 30d) |
| 7 | no_suspect extends the SAR clock to 60 days, not 30 | added | F2 → "no_suspect extends the SAR clock to 60 days from detection" |
| 8 | resolving an alert without a documented rationale is refused | added | F1 → "resolving without a documented rationale is refused; a bad outcome too; nothing written" |
| 9 | resolving WITH a rationale closes the alert and opens no case | added | F2 → "resolving WITH a rationale closes the alert and opens no case" |
| 10 | re-triaging replays instead of overwriting the first decision | flow | F1 → "re-triaging replays instead of overwriting the first decision"; F2 → "a resolved alert cannot be re-triaged into a case" |
| 11 | a no_file decision REQUIRES a rationale (BSA-07 retention) | flow | F1 → "an undocumented decision is refused (BSA-07) and decides nothing" |
| 12 | filing a SAR closes the case and emits sar.filed | flow | F1 → "a second officer files the SAR with committee concurrence recorded" (also `case.investigation_complete`, SAR retention record) |
| 13 | a no-file decision emits its own distinct event | added | F2 → "a no-file decision emits its own distinct event, never sar.filed" |
| 14 | a LATE decision is recorded as late rather than silently accepted | added | F3 → "a LATE decision still files, and the lateness survives on the response and event" |
| 15 | the sweep surfaces an alert nobody triaged in time | flow | F3 → "an alert nobody triaged in time is surfaced as a breach, once" |
| 16 | the sweep surfaces a case nobody decided in time | added | F3 → "a case nobody decided in time is surfaced as a breach" |
| 17 | breach event ids are deterministic — repeated sweeps do not pile up | flow | F3 → "an alert nobody triaged in time …" (re-sweep leaves exactly one breach event) |
| 18 | a clean sweep reports zero breaches, not silence | drop | The shared live core always holds someone's overdue alert, so a zero sweep can't be produced. F3 still asserts that `breach_count` matches the list and `truncated` is reported |
| 19 | a partner cannot reach case management at all — and gets 404, not 403 | flow | F1 → "a partner reaching case management gets 404 …" (triage, sweep), "staff read the case; a partner gets 404 for it" (get), "the SAR decision needs the Officer role …" (decision) |
| 20 | scope decides provenance, and the two cannot disagree | drop | Pure function. No route passes `scope=sim`. Core-side labelling is asserted live: alert/case `demo` in F1 |
| 21 | a sim-scoped request writes ONLY into the sim schema | drop | No routed handler accepts `scope=sim`, so this path is unreachable on the live core |
| 22 | every row a sim request writes is stamped simulated | drop | Unreachable, same reason as #21. The inverse is asserted in F4 → "no simulated evidence exists in core" |
| 23 | a core-scoped request never writes into sim | drop | The sim schema isn't exposed to the flow client. F4 → "no simulated evidence exists in core" asserts the inverse |
| 24 | triage requires the Investigations role, not merely being staff | added | F1 → "triage needs the Investigations role: ops and an officer are 403 insufficient_role" (extends the ops-only check in `onboard_transfer_large_txn.test.ts`) |
| 25 | the SAR decision requires the BSA Officer role | added | F1 → "the SAR decision needs the Officer role: investigator and ops 403, partner 404" |
| 26 | a role failure is 403 while a partner is 404 — the distinction is deliberate | added | F1 → same step |
| 27 | the investigator who opened a case cannot decide it | flow | F1 → "the investigator who opened the case cannot decide it, even holding bsa_officer" (409 `segregation_of_duties`), and "the database itself refuses a self-decided case (ck_case_four_eyes)" (§36) |
| 28 | holding BOTH roles does not defeat the separation | added | F2 → "holding both roles still lets an officer decide a case someone ELSE opened: no-file" |
| 29 | the case records WHO opened and WHO decided, so the separation is provable later | added | F1 → "escalating opens a case …" (`opened_by`) + "a second officer files the SAR …" (`decided_by` ≠ `opened_by`); F2 → dual-role step |
| 30 | SAR committee concurrence is recorded but not enforced (OQ-09) | added | F1 → "a second officer files the SAR with committee concurrence recorded" (recorded); F2 → dual-role no-file step (no committee, still 200) |

**Counts:** flow 11 · added 14 · contract 0 · drop 5 (total 30).

## Flow steps beyond the unit file

These steps come from bash §35/§36 or close gaps that neither source covered:

- **§35 provenance:** alert and case raised under test actors are `demo`. **DEFECT (red):** the case events (`case.opened`, `case.sar.decision.timer`, `bsa_alert.triaged`, `sar.*`, `case.investigation_complete`) are stamped `production`, because `emitBsaEvent` is never passed `ctx`.
- **§35 decision replay:** re-deciding a decided case replays and the first decision stands.
- **§35 negatives:** a decided case drops out of the overdue sweep.
- **§36 retention:** account closure clocks `rec_<acct>_cip_identity` for 5 years and emits `record.retention_clock_set`. Premature disposal is refused by the API (400 without approval, 409 `retention_not_expired`) and by the schema (`ck_record_disposal_*` on a service-role write). A legal hold flags the record in the same request and emits `disposal.held`. Disposal under a hold is 409 `legal_hold_in_force`. Release without `approved_by` is 400 and the hold stays. An authorized release clears the flag. No `simulated` rows exist in `core.record`, `control_result`, `bsa_alert` or `case`.
- **§36 DEFECT (red):** a closure by a test actor clocks the record as `production`, because `setRetentionClocks` never receives `ctx`. The bash script expected `production` only because it predates per-actor provenance.
- **Partner on `/retention/holds`:** the spec's `x-actors` route gate answers 403 `insufficient_scope` before `retention.ts`'s own 404-for-partners gate runs. The flow asserts the 403 and that nothing was held.
- **Not ported:** the bash pg_constraint existence checks. The flows trip `ck_case_four_eyes` and `ck_record_disposal_*` instead, which proves more. The `sim.record` table-exists check is also not ported, because the flow client has no catalog access.
