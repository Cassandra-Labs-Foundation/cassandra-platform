# Coverage ledger: `core/supabase/functions/api/liquidity.test.ts` → liquidity flows

Every `Deno.test` in the stubbed unit file is listed below, with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/liquidity.test.ts`. Run them with `scripts/flow.sh -f liquidity: --no-deploy`.

Disposition key:

- `flow`: covered by a flow step.
- `added`: a flow step written to close a gap the unit file left.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/` (none here; the contract suite has no liquidity tests).
- `drop`: no user-observable behaviour, or not producible through the API.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | STATUTORY: the §741.12 asset tier is derived, not supplied | flow | `liquidity: daily LAR positions …` → "statutory tier boundaries: $49.99m is under_50m, $50m is mid" |
| 2 | STATUTORY: a caller cannot assert its way out of the tier | flow | same flow → "day 1 at 10% …" (supplies `under_50m`, row says `over_250m`), and the $50m boundary step |
| 3 | INSTITUTIONAL: no configured bands means NO BAND, not 'adequate' | drop | Tests the pure `larBand(…, null)`. The live institution has bands in force, and no endpoint removes them |
| 4 | INSTITUTIONAL: an unconfigured system reports 'unassessed' | drop | Same reason: producing it would mean deleting the shared band config. The same pairing is proven live for mismatch, survival and headroom (row 6) |
| 5 | INSTITUTIONAL: with bands configured the same ratio gets a verdict | flow | `liquidity: daily LAR positions …` → "day 1 at 10% …" (band, `band_config_id` = config in force) |
| 6 | the same both-present-or-both-absent pairing on mismatch, survival and headroom | flow | "mismatch with no limit …" · stress flow "a run with no threshold has days but NO verdict" · FHLB flow "headroom with no floor …" |
| 7 | LQ-03: a critical breach fires, and a band CHANGE is its own alert | flow | `liquidity: daily LAR positions …` → "day 2 at 3% …" |
| 8 | LQ-03: bands that cross are refused | flow | `liquidity: ALCO re-approves the LAR bands …` → "bands that cross are refused and nothing changes" |
| 9 | LQ-03: a ratio with no haircut table is refused | flow | `liquidity: daily LAR positions …` → "a ratio with no haircut table is refused …" |
| 10 | LQ-02: a breach disposition needs an owner | flow | same flow → "a breach disposition with no owner is refused, and nothing is written" |
| 11 | LQ-02: a breached bucket carries its magnitude | flow | same flow → "the breach with an owner: bucket + magnitude recorded …" |
| 12 | LQ-05: changing an assumption without a rationale and approver is refused | flow | `liquidity: stress runs …` → "changing an assumption without a rationale and approver is refused …" |
| 13 | LQ-05: assumptions are VERSIONED, so an old run stays reproducible | flow | same flow → "the change with rationale + approver: a NEW version …", "evidence: stress.assumption_versioned …", "the earlier run is still reproducible …" (all three are **DEFECT**, red) |
| 14 | LQ-05: an ad-hoc rerun must say what triggered it | flow | same flow → "an ad-hoc rerun must say what triggered it" |
| 15 | LQ-04: a run with no assumption set on file is refused | drop | The live institution always has a set in force, and no endpoint removes one |
| 16 | LQ-04: below the threshold fires; above it does not | flow | same flow → "scheduled run above its threshold …" + "ad-hoc rerun on an EWI spike …" |
| 17 | LQ-09: a facility test with no script is refused | flow | `liquidity: FHLB line tested …` → "a test outcome with no script is refused …" |
| 18 | LQ-09: headroom with no eligibility rules is refused | flow | same flow → "headroom without eligibility rules is refused; an unknown facility is 404" |
| 19 | LQ-09: headroom below the floor alerts | flow | same flow → "pledged paper moved: recheck against the $50m floor …" |
| 20 | LQ-07: the board pack is ASSEMBLED from the positions, not re-entered | flow | `liquidity: the board pack is assembled …` → "publish the board deck — a typed-in LAR is ignored …" |
| 21 | a partner token cannot reach the liquidity routes | flow | 404 on positions, mismatch, facilities and packs; 403 (actor gate) on the NCUA, regulator and ALCO-tail routes |

**Counts:** flow 18 · added 0 · contract 0 · drop 3 (total 21).

## Flow steps beyond the unit file

- **Band governance:** an unapproved band is refused. An annual re-approval must create a new version and keep the prior one. **DEFECT:** `larcfg_v2` is overwritten in place.
- **Facility test cadence:** the next test is due exactly 365 days after this one. **DEFECT:** a retest emits no `facility.test.completed` event.
- **Pack contents:** the pack's maturity gaps must belong to the latest position. **DEFECT:** the pack takes an arbitrary first row. The daily and weekly cadences emit their own report events.
- **LQ-11:** NCUA notification → reference-less ack refused → ack logged with reference and time.
- **LQ-13:** regulator request → contacts verified → reference-less response refused → response recorded. Unknown ids get 404. No response deadline exists in the schema, so "respond within the deadline" cannot be asserted.
- **LQ-08:** EOD tie-out detects a variance; a clean tie-out completes without one. A model review needs a model, a reviewer and an outcome.
- **LQ-06:** with no concentration limit the result is unassessed. A breach with no waiver gets 409 `waiver_decision_required`. A waiver is recorded with its decider.
- **LQ-17:** wholesale funding priced above market raises `alert.wholesale_pricing_violation`; at market it does not.
- **ALCO ratio review:** needs a reviewer, and the ratios are logged.

## Shared state

Three tables hold institution-wide singletons: `lar_band_config`, `stress_assumption_set` and `liquidity_facility` (`fac_fhlb`). Each flow that writes one snapshots it first and restores it row-for-row in a `finally`. Positions and collateral are posted on random 20th-century dates, so the institution's latest position never changes.
