# Coverage ledger: `core/supabase/functions/api/capital.test.ts` → capital flows

Every `Deno.test` in the stubbed unit file is listed below with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/capital.test.ts` (and, for RWA, `core/verifier/flows/basel.test.ts`). Run them with
`scripts/flow.sh -f capital: --no-deploy` (or `-f basel:`).

Disposition key: `flow` (covered by a flow step), `added` (a step written to close a gap), `contract` (HTTP shape only), `drop` (no user-observable surface).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | the ratio is FLOORED and classifies at the statutory boundaries | flow | `capital: CFO records the quarter …`: "CP-04: 6.99999% FLOORS to 699bp", "5.99999% floors to 599bp", "the deeper bands: 3.99999% → significantly, 1.99999% → critically" |
| 2 | a well-capitalized position is recorded unrestricted, ratio derived from components | flow | same flow → "15% net worth: well capitalized, unrestricted, ratio derived from the components" |
| 3 | CP-03: an unset internal trigger reports NO verdict, not 'not breached' | flow | same flow → "CP-03: with no Board trigger configured the verdict is NULL"; and the sweep reports it as unassessed (`capital: quarterly sweep …`) |
| 4 | CP-03/CP-08: a breached internal trigger escalates under BOTH alias codes | flow | same flow → "CP-03/CP-08: the Board sets a 16% trigger …" |
| 5 | CP-04: above the floor but through the buffer is its own breach | flow | same flow → "CP-04: 6.99999% FLOORS to 699bp …" |
| 6 | an undercapitalized position restricts payouts and starts the 45-day NWRP clock | flow | same flow → "5.99999% floors to 599bp: undercapitalized …", "filing the NWRP …", "a healthy institution cannot file an NWRP: 409" |
| 7 | CP-01: a target at or below the 700bp floor is refused | flow | `capital: the CCO sets an internal target …` → "CP-01: a target below the 700bp floor … 409, not stored" |
| 8 | CP-03: targets are CCO-restricted and cannot be self-approved | flow | same flow → "a partner gets 404; operations without the CCO role gets 403", "CP-03: the proposer cannot approve their own target", "the Board approves …"; plus "CP-03: a CCO token can be issued at all" (DEFECT) |
| 9 | BA-04: an unmapped exposure class is SURFACED, never weighted at zero | flow | `basel: RWA run on a quarter …` → "BA-03/04: a class with no published weight is SURFACED …" and "at the trading threshold the market charge applies …" |
| 10 | the sweep escalates an overdue NWRP and reports the unassessed separately | flow | `capital: quarterly sweep …` → "the sweep (cu_admin) names the overdue plan …". The 45-day deadline is moved into the past by a service-role update to the flow's own position (clock simulation; the API has no way to move time) |

**Counts:** flow 10 · added 0 · contract 0 · drop 0 (total 10).

## Flow steps beyond the unit file

- A partner gets 404 on positions, targets, documents and RWA, and on the sweep. A malformed position names `as_of_date` and `total_assets_cents`.
- **DEFECT:** an insolvent quarter (negative net worth, not an exact multiple) is a 500. See "an insolvent quarter …".
- NWRP filing: `filed_by` required (400), unknown position (404), and a refusal stamps nothing.
- Sweep: a late filing takes the plan off the overdue list, and a Board trigger takes the position off the unassessed list.
- Targets: a proposal without approval is stored unapproved with no approval event. An approved target above the latest ratio is breached and escalated when it arrives.
- Capital documents (CP-05/06, BA-07), none of which the unit file covered: kind validation, review-before-presentation 409, prepare → present → review, stress-report and ICAAP events, and the prior-document link. **DEFECTs:** a `cfo` token cannot be minted, and a token without the cfo role can file the capital plan.
- Fixture discipline: positions are dated in the 1900s so none can become the institution's latest position. The flow deletes them at the end so the sweep's 200-row window never fills.

### Added 2026-10-05 (stub tests Phase 4 wrote alongside its fixes)

| test | disposition | where |
|---|---|---|
| an insolvent position records the ratio the DB constraint computes (truncated toward zero) | flow | `capital.test.ts` → "an insolvent quarter (negative net worth) is still recorded — critically undercapitalized" (−2.47bp posts 201 only if the ratio truncates like the DB check) |
| a restatement of a still-undercapitalized quarter keeps the first NWRP deadline | added | `capital.test.ts` → "restating a still-undercapitalized quarter keeps the FIRST NWRP deadline" |
| CP-05: only a cfo token files the capital plan | flow | `capital.test.ts` → "CP-05: only the CFO prepares the capital plan — a token without the cfo role is refused" |
