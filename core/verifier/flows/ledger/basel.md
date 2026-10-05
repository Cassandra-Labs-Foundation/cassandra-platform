# Coverage ledger: `core/supabase/functions/api/basel.test.ts` → basel + bcp flows

Every `Deno.test` in the stubbed unit file is listed below with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/basel.test.ts`. Run them with `scripts/flow.sh -f basel: --no-deploy` and `-f bcp:`.

Disposition key: `flow` (covered by a flow step), `added` (a step written to close a gap), `contract` (HTTP shape only), `drop` (no user-observable surface).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | BA-04: changing a statutory schedule needs the authority for the change | flow | `basel: the CFO adopts a risk-weight schedule change …` → "BA-04: a reweighting without the authority … refused; the schedule is untouched" |
| 2 | BA-04: schedules supersede rather than overwrite | flow | same flow → "BA-04: with the authority the change is a NEW version …" (DEFECT: the third version overwrites v2) |
| 3 | BA-03: an unmapped exposure is surfaced, never weighted at zero | flow | `basel: RWA run on a quarter …` → "BA-03/04: a class with no published weight is SURFACED …" |
| 4 | BA-03: the run reads the VERSIONED schedule when one is on file | flow | schedule flow → "BA-03: the RWA run reads the VERSIONED schedule …" |
| 5 | BA-03: below the trading threshold the market charge does NOT apply | flow | RWA flow → "… below the threshold there is no market charge" |
| 6 | BA-03: above the threshold it applies, and the total is all three legs | flow | RWA flow → "BA-03: at the trading threshold the market charge applies …" |
| 7 | BA-06: no configured CCyB means NO payout cap and NO verdict | flow | `basel: capital buffer …` → "breached with NO configured CCyB …" |
| 8 | BA-06: the payout ladder tightens as the shortfall deepens | flow | same flow → "the ladder tightens: 450bp → 40%; 750bp → 20%; fully through → 0% (not permitted); met → 100%" (the 60% rung is in the CCyB step) |
| 9 | BA-06: with a CCyB the restriction is applied and recorded | flow | same flow → "with a 1% CCyB, 150bp short of 1050 …" |
| 10 | BA-05: a CFP above normal with no liquidation hierarchy is refused | flow | `basel: contingency funding plan …` → first step |
| 11 | BA-05: normal needs no hierarchy and still logs the profile | flow | same flow → "'normal' needs no hierarchy …" |
| 12 | BC-11: a backup channel identical to the primary is not a backup | flow | `bcp: sev1 incident → …` → "BC-11: a backup channel identical to the primary is refused; the tree is untouched" |
| 13 | BC-11: a platform failure activates the backup and says so | flow | same flow → "BC-11: the comms platform fails …" |
| 14 | BC-11: a media response with no CEO approval is refused | flow | same flow → "BC-11: a media response without CEO approval is refused", then "with the CEO's approval …" |
| 15 | BC-05: the IC assignment carries a CLOCK, not just a name | flow | same flow → "BC-05: declare a sev1 on the secondary rotation …" |
| 16 | BC-13: a PIR drafted with no root cause is refused | flow | same flow → "BC-13: a PIR with no root cause is refused …" |
| 17 | BC-13: 'completed' is the owner's opinion; the RETEST is the evidence | flow | same flow → "BC-13: 'completed' is the owner's opinion …" and "BC-13: the RETEST is the evidence …" |
| 18 | a partner token cannot reach the basel routes | flow | a partner 404 step in each of the schedule, RWA, buffer, CFP and bcp flows. Pillar 3 is route-gated, so a partner gets 403 or 404 |

**Counts:** flow 18 · added 0 · contract 0 · drop 0 (total 18).

## Flow steps beyond the unit file

- **Pillar 3 (BA-08):** a disclosure without board minutes is refused. A published disclosure records the 45-day due clock, the publication and the minutes. A shortfall period notifies the board and issues the capital escalation.
- **CFP:** a move to stress with a hierarchy records `cfp.transition.started`, and the investment-test completion is recorded too.
- **Incident close:** closing with a drafted PIR emits `incident.postmortem.completed` carrying the root cause.
- **Corrective actions:** an unknown PIR gets 404 and an action with no owner gets 400. The approval clock is 10 days.
- **DEFECTs:**
  - Comms on a nonexistent incident return 201.
  - Every comms call rewrites `comms_initial_issued_at`, the refused media request included.
  - A PIR for a nonexistent incident is stored and returns 201.
- **Shared-state discipline:** the flows snapshot the active risk-weight schedule and the comms tree singleton and write them back exactly in a `finally`. Any schedule version a flow adds is removed.

### Added 2026-10-05 (stub tests Phase 4 wrote alongside its fixes)

| test | disposition | where |
|---|---|---|
| BC-13: a PIR for an incident nobody declared is 404, and nothing is stored | flow | `basel.test.ts` → "BC-13: a PIR with no root cause is refused; a PIR for a nonexistent incident is 404" |
| BC-11: comms on an unknown incident is 404; the initial issuance is the FIRST one | flow | `basel.test.ts` → "comms for an incident that does not exist is 404, not a silent success" + "initial comms go out on the PRIMARY …" |
| BA-04: a third version numbers past the superseded ones and never overwrites | flow | `basel.test.ts` → "BA-04: with the authority the change is a NEW version …" (asserts max+1 against the live version history, which already holds many superseded versions) |
