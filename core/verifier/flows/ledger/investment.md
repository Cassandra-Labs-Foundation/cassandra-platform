# Coverage ledger: `core/supabase/functions/api/investment.test.ts` → investment flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/investment.test.ts`. Run them with `scripts/flow.sh -f investment: --no-deploy`.

Disposition key:

- `flow`: covered by a flow step (named).
- `added`: a flow step written to close a gap the unit file left.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`.
- `drop`: no user-observable surface, or not producible through the API.

Flow names below are shortened to their first words:

- **lifecycle:** `investment: officer builds the book → trades within, at warning, past the limit → …`
- **gate:** `investment: the trade gate refuses unlisted, prohibited and over-maturity instruments, …`
- **identity:** `investment: duties bind to the authenticated actor — …`
- **credit:** `investment: credit file analysed → security downgraded … → fair value and impairment`
- **liquidity:** `investment: liquidity classified → report computed from the book → CFP … → performance against benchmark`
- **repos:** `investment: repos — approved counterparty books, …`

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | IP-03: an instrument class NOT on the list is refused — absence means no | flow | gate → "an instrument class NOT on the list is refused — absence means no (unassessed)" |
| 2 | IP-03: an explicitly prohibited class is refused | flow | gate → "an explicitly prohibited class is refused (prohibited)" |
| 3 | IP-03: maturity beyond the list limit is prohibited | flow | gate → "a maturity beyond the list's cap is prohibited" |
| 4 | IP-03: the list is effective-dated | flow | gate → "the list is effective-dated: a FUTURE prohibition supersedes from its date, not today" (v1 `superseded_at`, v2 `prior_version`, today's trade still executes) |
| 5 | IP-08: an unregulated counterparty is not approved and blocks the trade | flow | every flow's book setup → "broker-dealer approval is derived …" (a supplied `approved: true` is ignored); gate → "an unregulated broker blocks the trade" |
| 6 | IP-08: a trade with NO counterparty is refused | flow | gate → "a trade with NO broker is refused" |
| 7 | IP-08: safekeeping reconciliation compares OUR book to the custodian's | flow | lifecycle → "safekeeping: the custodian's statement is compared to OUR book — a short holding is one break" |
| 8 | IP-07: concentration is tested on the PROJECTED position | flow | lifecycle → "trade 3 would breach on the PROJECTED position — …" (each trade is sized from the live net worth) |
| 9 | IP-07: the warning fires on a trade that still EXECUTES | flow | lifecycle → "trade 2 crosses the WARNING on the projected position — it still executes, and warns" |
| 10 | IP-07: a breach blocks, books nothing, and opens a waiver | flow | lifecycle → trade 3 step; the waiver is then approved in "the breach waiver: …" |
| 11 | IP-07: NO limit configured is unassessed, not within-limit | flow | gate → "an issuer with NO limit is unassessed, and unassessed blocks" |
| 12 | IP-07: a warning at or above the limit is refused as a limit definition | flow | gate → "limit definitions: a warning at/above the limit, or no approver, is refused" |
| 13 | IP-11: no pre-purchase checklist blocks the trade | flow | gate → "no pre-purchase checklist blocks the trade" |
| 14 | IP-14: the executing trader cannot confirm their own trade | flow | lifecycle → "SoD: the trader cannot confirm their own trade …" (`sod_violation` row, `sod.violation.logged` with the registered role and matrix version, `trade.sod.blocked`) |
| 15 | IP-14: the executing trader cannot settle their own trade either | flow | lifecycle → "SoD: the trader cannot settle their own trade either; a third actor reconciles it" |
| 16 | IP-14: a confirmation that does not match the counterparty is flagged | flow | lifecycle → "a confirmation that disagrees with the counterparty is flagged, not matched" |
| 17 | IP-14: a matching confirmation records the match | flow | lifecycle → "the second approver confirms trade 1 against the counterparty's figures: matched" |
| 18 | IP-02: a trade exception cannot be self-approved | flow | lifecycle → "the breach waiver: the trader cannot approve their own exception; the approver can" |
| 19 | IP-09: a margin shortfall ISSUES A CALL, not just a measurement | flow | repos → "a reverse repo short of margin books AND issues a margin call" |
| 20 | IP-09: adequate margin issues no call | flow | repos → "adequate margin books with no call" |
| 21 | IP-09: an UNAPPROVED counterparty blocks the repo, not just a missing one | flow | repos → "an unapproved counterparty is refused, and so is none at all — each recorded as blocked" |
| 22 | IP-10: a fair value with no source is refused | flow | credit → "fair value: a value with no source is refused" |
| 23 | IP-10: fair value below cost recognises an impairment; above it does not | flow | credit → "fair value below cost recognises the impairment and re-marks the position" and "fair value above cost concludes no impairment" |
| 24 | IP-05: a downgrade with no review leaves the review absent, and it is visible | flow | credit → "a downgrade nobody reviewed is recorded and stays visibly unreviewed" |
| 25 | IP-05: a sub-investment-grade downgrade goes to the Board | flow | credit → "the review of a sub-investment-grade downgrade goes to the board" and "a reviewed downgrade that stays investment grade does NOT go to the board" |
| 26 | IP-05: a credit file with no internal analysis is refused | flow | credit → "a credit file with only an external rating is refused — …" |
| 27 | IP-06: the liquidity report is computed from the book, not supplied | flow | liquidity → "the report is computed from the book — supplied figures are ignored — …" (asserted as a delta against a baseline report, since the book is instance-wide) |
| 28 | IP-06: an unset minimum yields no breach verdict | flow | same step (`breached` null); the breached case is "against a minimum the book cannot meet, the report says breached" |
| 29 | IP-17: a contingency level cannot be activated without its execution plan | flow | liquidity → "CFP: a contingency level without its execution plan is refused; with it, activated and tested — then restored" |
| 30 | IP-04: a simulation breach escalates; one within the minimum does not | flow | liquidity → "ALM simulation: a breach of the minimum escalates; a pass does not; no minimum is no verdict" |
| 31 | IP-13: a return with no benchmark is refused | flow | liquidity → "performance: a return without a benchmark is refused; with one, the excess is recorded" |
| 32 | IP-15: executing a trade declares the required document set with its clock | flow | lifecycle → "trade 1 within the limit executes: position booked, document set declared with its clock" |
| 33 | a blocked trade declares NO document set and books no position | flow | every refusal in lifecycle and gate (the `assertBlocked` helper checks for no `document` rows, no `position.booked`, and an unchanged position) |

**Counts:** flow 33 · added 0 · contract 0 · drop 0 (total 33).

## Flow steps beyond the unit file

- **Roles and actors:** the trader, the confirmer and the settler are three different minted tokens. Their token ids are registered through `PUT /investment/users`. A partner gets a 404 on trades, limits and user registration, and nothing is written.
- **Validation:** malformed trade tickets name every missing field. Also covered: unknown role, a limit with no approver, a malformed repo, reconciliation with no `settled_by`, and reconciliation of an unknown trade (404).
- **Unknown broker:** a broker the institution never reviewed is refused as `intermediary_not_approved`, with a blocked row.
- **Credit re-analysis:** after a downgrade, re-analysis is refused without the analysis and is 404 on an unknown file. When it succeeds, the prior and new ratings are recorded and `completed_late` is false.
- **CFP:** activating with `investment_test_completed` writes a `finding.opened` with severity `none`, so a clean test is distinguishable from no test.
- **Board report:** a management report at the start and a board report at the end of the lifecycle flow. Our position, the blocked trade and the approved waiver must show up as relative changes.

### Steps that are red until the core is fixed (`// DEFECT:` in the flow file)

| Flow → step | Defect |
|---|---|
| lifecycle → "the confirmation match is a boolean …" | `core.trade.confirmation_matched` is a TEXT column (codegen-era; the investment migration's boolean was a no-op `add column if not exists`), so rows and the `trade.reconciliation.completed` payload carry `"true"`/`"false"` |
| lifecycle → "safekeeping is scoped to the custodian …" | reconciliation compares one custodian's statement with every position in the book |
| lifecycle → "board report reflects the run …" | `postPortfolioReport` reads `core.trade` unpaginated. PostgREST caps the select at 1000 rows, so `trades_blocked` was seen to go DOWN after a blocked trade (820 → 819) |
| gate → "the gate classifies by the SECURITY MASTER, not the ticket …" | `evaluateTradeGate` trusts the request's `instrument_class`/`issuer_ref`, so a prohibited security relabelled as permitted executes |
| identity → "an actor not registered for execution cannot execute a trade" | `postTrade` never consults the role register |
| identity → "the trader's own credential cannot confirm by naming the approver" | SoD compares body strings and ignores the calling token, so the trader confirms their own trade under another id |
| credit → "a fair value for a security that does not exist is refused …" | `postFairValue` answers 200 and emits evidence for an unknown security (`downgrade` correctly 404s) |

### API gap (not marked as a defect)

No route creates a `core.security` row. Each flow seeds its securities with the service-role client (`provenance: demo`), as the drill does.
