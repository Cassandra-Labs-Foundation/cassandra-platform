# Coverage ledger: `core/supabase/functions/api/unassessed.test.ts` → unassessed flow and the per-domain flows

The unit file guards every place a NULL is load-bearing: it fails when someone fills an honest "no verdict" with a plausible default. Most of
those sites already have a flow that walks them in context. `core/verifier/flows/unassessed.test.ts` adds the cross-cutting claim: the unknown
reaches the examiner explicitly on three surfaces, the API response, the stored row, and the compliance dashboard's trace. The key must be present and
null. A missing key does not count. Each site is also run with a configured value, to show the null is a statement and not a field the core never fills.
Run with `scripts/flow.sh -f unassessed: --no-deploy`.

Disposition key: `flow` (covered by a flow step), `added` (a step written to close a gap), `contract` (HTTP shape only), `drop` (no user-observable surface).

**UA** = `unassessed: every unconfigured check reaches the examiner as NO verdict — …`

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | NULL: the OFAC screen cannot name its list, and every row says so | flow | UA → "OFAC: a clean screen names NO list — null on the row and on the dashboard's ofac.cleared …"; also `bsa_program.test.ts` ("a clean re-screen leaves evidence …") |
| 2 | NULL: the PEP screen has no list either | flow | UA → "PEP: the screen has no list either …"; also `bsa_program.test.ts` ("a clean PEP screen is evidenced and opens no EDD") |
| 3 | NULL: the lending OFAC gate has no list version (OQ-02, same stub) | drop | `POST /loan-applications/{id}/parties` (`lending.postLoanParty`) is deliberately unrouted (the narrow-bank exclusion in CLAUDE.md). **Not proven live:** `loan_party.ofac_list_version` stays null |
| 4 | NULL: an unset capital internal trigger yields NO verdict, not 'not breached' | flow | `capital.test.ts` → "CP-03: with no Board trigger configured the verdict is NULL …", plus the sweep's separate unassessed list ("the sweep (cu_admin) … reports the unassessed position SEPARATELY") |
| 5 | NULL: an unset enterprise cash limit reports 'unassessed' | flow | `cash_ops.test.ts` → "with no Board limit the position is UNASSESSED — never 'within limit'" |
| 6 | NULL: an unset over/short threshold reports 'unassessed' | flow | UA → "cash over/short: with no institutional threshold the dashboard shows 'unassessed' …"; also `cash_ops.test.ts` ("with no institutional threshold set the verdict is UNASSESSED …") |
| 7 | NULL: an unset fair-lending threshold yields no breach verdict | drop | `/fair-lending` analysis (`lending_underwriting.postFairLendingAnalysis`) is deliberately unrouted. **Not proven live:** `fair_lending_analysis.breached` stays null |
| 8 | NULL: an unset complaint-trend threshold yields no verdict | flow | UA → "complaint trend: a 700bp cohort disparity with no threshold is NO verdict and opens no CAP …"; also `complaints.test.ts` |
| 9 | NULL: an unset ALM minimum yields no breach verdict | flow | UA → "ALM: a -9999bp stress result with no minimum is NO verdict everywhere …"; also `investment.test.ts` ("… no minimum → no verdict") |
| 10 | NULL: an unset liquidity minimum yields no breach verdict | flow | UA → "liquidity: a report with no minimum marketable share is NO verdict …"; also `investment.test.ts` |
| 11 | NULL: an unset LTV maximum yields no within-policy verdict | drop | Appraisal (`lending_underwriting.postAppraisalComplete`) is deliberately unrouted. **Not proven live:** `collateral.ltv.checked.within_policy` stays null |
| 12 | NULL: a CDA trade with NO overlay configured is 'unassessed' and BLOCKED | flow | `cda.test.ts` → "with NO overlay configured a trade is unassessed and blocked, not permitted" |
| 13 | NULL: an investment trade with no issuer limit is 'unassessed' and BLOCKED | flow | `investment.test.ts` → "an issuer with NO limit is unassessed, and unassessed blocks" |
| 14 | NULL: the CTR aggregation cannot attribute an unlinked account (OQ-12) | flow | `cash.test.ts` → "a legacy account with no owner exists …", "$15,000 cash in to it is RECORDED, said to be unattributable …", "evidence: the row exists with a NULL entity …" |

**Counts:** flow 11 · added 0 · contract 0 · drop 3 (total 14).

## Flow steps beyond the unit file

- **The dashboard trace carries the null.** `ofac.cleared`, `pep.screened`, `stress_test.completed` and `liquidity.report.published` keep their null keys after the dashboard's PII redaction, and the over/short trace says `unassessed`. The unit file checked only the stored rows.
- **Contrast legs.** ALM, liquidity and complaint trend each turn into a real `breached: true` once a minimum or threshold is supplied.
- Partners get 404 on OFAC, PEP, ALM, liquidity and complaint-trend writes.

## Judgement calls (not marked DEFECT)

- The `POST /bsa/ofac/screens` and `/bsa/pep/screens` responses return `{id, verdict: "clear"}` with no list field. The row and the event both state `list_version: null`, and nothing fabricates a version. A caller reading only the response still sees a bare "clear". The flow asserts that a list field, if ever added to the response, must be null. It does not fail on the field being absent.
- `POST /cash-ops/assets/{id}/overshort` returns `{id, cumulative_cents}` with no verdict. The `unassessed` verdict exists only in the `cash.overshort.thresholds` event, which the dashboard trace shows. The `complaint.trend.reported` event, conversely, carries no verdict at all; the row and the response do.
