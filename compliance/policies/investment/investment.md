```yaml
---
title: Investment Policy (Table-First, Design-Overlay v3)
owner: Patrick Wilson, Chief Compliance Officer
version: v1.0
effective: 2025-07-01
next_review: 2026-07-01
approvers:
  - Patrick Wilson, Chief Compliance Officer
tags: [Compliance, Investment, NCUA Part 703, ALM, Liquidity, Credit Risk]
---
```

## General Policy Statement

Pynthia Credit Union ("the Credit Union") invests surplus funds and places non-loan assets to protect safety and soundness, maintain adequate liquidity, earn a reasonable risk-adjusted yield, and comply with the Federal Credit Union Act and [12 CFR Part 703](https://www.ecfr.gov/current/title-12/part-703). The portfolio is managed to simultaneously provide earnings, liquidity, interest-rate-risk mitigation, safety of principal, and pledging capacity — all consistent with safe and sound practices. This policy governs all investments, repurchase and reverse repurchase agreements, deposits, and other non-loan asset placements held on the balance sheet, whether executed directly or through third parties. It does not authorize derivative activity (which requires a separate board-approved Derivatives Policy under [12 CFR Part 703 Subpart B](https://www.ecfr.gov/current/title-12/part-703)) or retail nondeposit investment product sales programs. Governance is centralized with the Chief Compliance Officer; the CFO/Chief Investment Officer, ALCO/Investment Committee, Treasury, Risk, Finance, and Internal Audit/Supervisory Committee are required participants.

---

## Timing Matrix {#timing-matrix}

| Scenario | Trigger (human → event) | Deadline | Content Reference | Control |
|---|---|---:|---|---|
| Policy review warning — 60 days | 60 days before `policy.next_review_at` | 60 days prior | Board approval required within 12 months | [IP-01](#ip-01-policy-record-and-review-cycle) |
| Policy review warning — 30 days | 30 days before `policy.next_review_at` | 30 days prior | Escalation if not yet scheduled | [IP-01](#ip-01-policy-record-and-review-cycle) |
| Policy lapses without board approval | `policy.next_review_at` passes without `policy.board.approved` | Immediate flag | Prior policy governs; non-compliant flag set | [IP-01](#ip-01-policy-record-and-review-cycle) |
| Board annual policy approval | Board meeting at or before 12-month anniversary | ≤ 12 months | Full policy + authority matrix | [IP-02](#ip-02-governance-board-oversight-and-delegations) |
| Board quarterly investment report | End of each calendar quarter | Quarterly (monthly preferred) | Purchases, sales, composition, total return, duration, credit, market depreciation | [IP-02](#ip-02-governance-board-oversight-and-delegations) |
| ALCO monthly investment review | End of each calendar month | Monthly | Composition, total return, duration, liquidity, net worth | [IP-02](#ip-02-governance-board-oversight-and-delegations) |
| CFO monthly aggregate limit check | End of each calendar month | Monthly | Purchases + sales vs. authority-matrix limit | [IP-02](#ip-02-governance-board-oversight-and-delegations) |
| Prohibited instrument attempted at booking | Trade entry (`trade.permissibility.checked`) | Immediate block | Instrument not on allow-list or Part 703 prohibited | [IP-03](#ip-03-permissible-investments-and-prohibited-activities) |
| Instrument allow-list annual review | 12-month anniversary of last review | ≤ 12 months | Part 703 §703.13–703.14 mapping | [IP-03](#ip-03-permissible-investments-and-prohibited-activities) |
| Market depreciation stress calculation | End of each calendar quarter | Quarterly | +100/+200/+300 bp parallel shift; limit 30% of Net Worth | [IP-04](#ip-04-interest-rate-risk-and-alm-integration) |
| IRR simulation | ALCO calendar; threshold breach | Quarterly minimum | Scenario-based total return; EVE; duration/convexity | [IP-04](#ip-04-interest-rate-risk-and-alm-integration) |
| Credit file required before purchase | Trade entry for non-government instrument | Before settlement | Credit memo, investment-grade determination | [IP-05](#ip-05-credit-risk-standards-and-downgrade-management) |
| Annual credit re-analysis | 12-month anniversary of last analysis | ≤ 12 months | Per-instrument due diligence | [IP-05](#ip-05-credit-risk-standards-and-downgrade-management) |
| Downgrade review | Rating downgrade event detected | 5 business days | Board notification for material positions | [IP-05](#ip-05-credit-risk-standards-and-downgrade-management) |
| Liquidity report | End of each calendar month | Monthly (more frequent under stress) | On-demand and 30-day stress capacity | [IP-06](#ip-06-liquidity-and-marketability-limits) |
| Concentration limit check | Trade entry | Immediate (soft warn / hard block) | Issuer, sector, rating, product, counterparty | [IP-07](#ip-07-concentration-and-counterparty-limits) |
| Broker/dealer annual due-diligence review | 12-month anniversary of last review | ≤ 12 months | Capital, reputation, FINRA, rep experience | [IP-08](#ip-08-approved-brokers-dealers-and-safekeepers) |
| Safekeeping reconciliation | End of each calendar month | Monthly | Bank records vs. safekeeping agent statements | [IP-08](#ip-08-approved-brokers-dealers-and-safekeepers) |
| Repo collateral mark-to-market | Weekly (daily under stress) | Weekly / daily | Fair value vs. required margin; margin call on shortfall | [IP-09](#ip-09-repurchase-and-reverse-repurchase-agreements) |
| Fair-value update | End of each calendar month | Monthly | Reputable independent pricing source | [IP-10](#ip-10-valuation-accounting-and-fair-value-measurement) |
| OTTI evaluation | End of each calendar quarter | Quarterly | Security-by-security; 10% loss threshold | [IP-10](#ip-10-valuation-accounting-and-fair-value-measurement) |
| Pre-purchase checklist and approval | Trade entry for non-government instrument | Before settlement | Credit memo + valuation support linked to trade | [IP-11](#ip-11-pre-purchase-due-diligence-and-exceptions) |
| Document attachment to trade | Trade booking | Within 2 business days | Trade ticket, confirmation, credit memo, approvals | [IP-15](#ip-15-recordkeeping-and-documentation-retention) |
| Management portfolio report | End of each calendar month | Monthly | Composition, duration, liquidity, gain/loss, limits | [IP-12](#ip-12-ongoing-monitoring-reporting-and-stress-testing) |
| Board portfolio report | End of each calendar quarter | Quarterly (monthly preferred) | Full board report package | [IP-12](#ip-12-ongoing-monitoring-reporting-and-stress-testing) |
| Portfolio stress test | Annual minimum; more often as metrics approach limits | Annual | Scenario set; limit-adherence | [IP-12](#ip-12-ongoing-monitoring-reporting-and-stress-testing) |
| Performance attribution | End of each calendar quarter | Quarterly | Benchmark attribution by segment | [IP-13](#ip-13-performance-measurement-and-benchmarks) |
| Trade reconciliation | Trade settlement | T+1 | Confirmation match; settlement vs. ticket | [IP-14](#ip-14-trade-execution-controls-and-segregation-of-duties) |
| Training completion before system access | New hire / role change | Before access granted | Investment-role curriculum | [IP-16](#ip-16-training-competency-and-conflicts-of-interest) |
| COI annual certification | Annual cycle | Annual | All covered staff and board members | [IP-16](#ip-16-training-competency-and-conflicts-of-interest) |
| CFP investment-liquidation test | Annual minimum | Annual | Stress scenarios; liquidation hierarchy | [IP-17](#ip-17-contingency-planning-and-liquidity-stress-events) |
| Stress declaration execution plan | Actual stress event declared | 1 business day | Initial execution plan documented | [IP-17](#ip-17-contingency-planning-and-liquidity-stress-events) |

---

## IP-01 — Policy Record and Review Cycle {#ip-01-policy-record-and-review-cycle}

**WHY (Reg cite):** [12 CFR §703.3](https://www.ecfr.gov/current/title-12/part-703/section-703.3) requires a federal credit union to maintain a written investment policy approved by the board of directors and reviewed at least annually. Investments made after a policy lapses without board re-approval remain subject to the prior policy but constitute a supervisory deficiency.

**SYSTEM BEHAVIOR:** The system maintains a single canonical Investment Policy record (`policy`) with `policy.effective_date`, `policy.next_review_at`, and `policy.document_version`. Automated alerts fire at 60 days (`policy.review_due_soon`) and 30 days (`policy.review_warning_at`) before `policy.next_review_at`. If the board approval event (`policy.board.approved`) is not recorded by `policy.next_review_at`, the system sets `policy.noncompliance` to flagged and emits a non-compliant alert; the prior policy version continues to govern all positions tagged to it. Every balance-sheet position (investments, repos, deposits, other non-loan placements) carries a `position.policy_tagged` reference to the active policy version. Policy records are write-restricted to Compliance; read access is unrestricted.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| 60 days before policy next-review date (`policy.review_warning.issued`) | Active policy record (`policy.next_review_at`, `policy.document_version`) | 60-day review warning alert (`policy.review_warning.issued`) | 60 days before `policy.next_review_at` (enforced by `policy.review_due_at`) |
| 30 days before policy next-review date (`policy.review_warning.issued`) | Active policy record (`policy.next_review_at`, `policy.document_version`) | 30-day review warning alert (`policy.review_warning.issued`) | 30 days before `policy.next_review_at` (enforced by `policy.review_due_at`) |
| Policy next-review date passes without board approval (`policy.noncompliance.flagged`) | `policy.next_review_at`, absence of `policy.board_approved_at` within cycle | Non-compliant flag on policy record + alert to CCO (`policy.noncompliance.flagged`) | Immediately on date passage (enforced by `policy.review_due_at`) |
| Board approves revised Investment Policy (`policy.board.approved`) | Revised policy draft (`policy.draft_id`, `policy.change_summary`, `policy.draft_redline`), board minutes reference (`policy.minutes_reference`), approver identity | Approved policy version published; `policy.effective_date` and `policy.next_review_at` updated; prior version archived (`policy.version.approved`, `policy.revision.published`) | ≤ 12 months from prior approval (enforced by `policy.board_approval_due_at`) |
| Material change to Part 703 or related guidance detected (`regulatory.change_analysis.logged`) | Regulatory change description (`regulatory.source_doc`, `regulatory.change_analysis`), CCO review | Out-of-cycle policy amendment initiated (`policy.amendment.proposed`) | As soon as practicable; no fixed deadline but must precede next affected trade |

**ALERTS/METRICS:** Alert fires at 60-day and 30-day marks; a separate escalation alert fires to the CCO and Board Chair if `policy.board_approved_at` is not recorded within 5 business days of `policy.next_review_at`. Target: zero policies in non-compliant state at any month-end.

---

## IP-02 — Governance, Board Oversight, and Delegations {#ip-02-governance-board-oversight-and-delegations}

**WHY (Reg cite):** [12 CFR §703.3](https://www.ecfr.gov/current/title-12/part-703/section-703.3) requires board approval of the investment policy and oversight of investment activities. NCUA Examiner's Guide expectations require documented delegation of authority, periodic board reporting, and ALCO-level monitoring on at least a monthly basis.

**SYSTEM BEHAVIOR:** The system maintains an authority matrix (`authority_matrix`) with `authority_matrix.role_limits` defining single-trade and aggregate monthly limits by role. Each trade record (`trade`) carries `trade.approval` linked to an authorized approver; trades that exceed the CFO's monthly aggregate limit are blocked (`trade.limit_blocked`) until the President/CEO or ALCO provides documented prior approval per the matrix. Exceptions must be documented and approved before settlement; any exception is logged to the exception register (`trade.exception_raised`, `trade.exception.logged`). Board reports are generated quarterly (monthly preferred) and ALCO reports monthly; both are produced as `portfolio.board_report_due_at` and `portfolio.report_due_at` tasks respectively. The authority matrix is write-restricted to Compliance with CFO concurrence; the board-approved dealer and safekeeper lists are maintained by the CFO and approved by the Board annually.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Trade entered that exceeds CFO monthly aggregate limit (`trade.limit_blocked`) | Trade details (`trade.instrument_type`, `trade.settlement_amount`), CFO aggregate-to-date, authority matrix (`authority_matrix.role_limits`) | Trade blocked; escalation to President/CEO or ALCO for prior approval (`trade.limit_blocked`, `trade.approval.requested`) | Before settlement; no grace period |
| Exception to authority matrix identified at trade entry (`trade.exception.logged`) | Exception rationale, approver identity, trade details | Exception logged and linked to trade; approval recorded before settlement (`trade.exception.logged`, `trade.exception.approved`) | Before settlement |
| End of calendar quarter — board report due (`portfolio.board_report.issued`) | Portfolio composition, purchases, sales, net gain/loss, total return profile, yield, effective duration, average life, credit risk summary, market depreciation as % of Net Worth (`portfolio.performance_metrics`, `portfolio.gain_loss_summary`) | Board investment report package distributed (`portfolio.board_report.issued`) | Quarterly; monthly preferred (enforced by `portfolio.board_report_due_at`) |
| End of calendar month — ALCO report due (`portfolio.management_report.issued`) | Current and desired composition, total return profile, risk analysis, liquidity objectives, duration, average life, net worth levels (`portfolio.performance_metrics`) | ALCO investment report package (`portfolio.management_report.issued`) | Monthly (enforced by `portfolio.report_due_at`) |
| End of calendar month — CFO aggregate limit reconciliation | All trades in calendar month (`trade.settlement_amount`, `trade.instrument_type`), authority matrix limit | Aggregate utilization report; alert if limit approached or exceeded (`trade.limit_warning.issued`) | Monthly |
| Board annual review of approved dealer list (`intermediary.review.completed`) | Current approved dealer list (`intermediary.approved_list`), due-diligence files (`intermediary.due_diligence_file`) | Board-approved dealer list updated and dated (`intermediary.review.completed`) | ≤ 12 months (enforced by `intermediary.review_due_at`) |
| Board annual review of approved safekeeping agents | Current safekeeper list, board resolution | Board-approved safekeeper list updated (`policy.board.approved` for safekeeper schedule) | ≤ 12 months |

**ALERTS/METRICS:** Alert fires when CFO monthly aggregate reaches 80% of matrix limit. Target: zero trades settled without a linked approver; zero board reports delivered more than 5 business days after quarter-end.

---

## IP-03 — Permissible Investments and Prohibited Activities {#ip-03-permissible-investments-and-prohibited-activities}

**WHY (Reg cite):** [12 CFR §§703.13–703.14](https://www.ecfr.gov/current/title-12/part-703) enumerate permissible investment categories and instruments for federal credit unions. [12 CFR §703.15](https://www.ecfr.gov/current/title-12/part-703) prohibits specific activities including derivatives (absent a separate board-approved policy), subordinated debt, and non-investment-grade instruments. [12 CFR §703.16](https://www.ecfr.gov/current/title-12/part-703) addresses conflicts of interest.

**SYSTEM BEHAVIOR:** The system maintains a versioned instrument allow-list (`instrument_list`) with `instrument_list.part703_category` mapped to each permitted instrument type. At trade entry, the system checks `trade.permissibility` against the allow-list; any instrument not on the list or flagged as prohibited under §703.15 is hard-blocked (`trade.blocked_prohibited`). Portfolio diversification limits (expressed as % of total portfolio and % of Net Worth) and instrument-level parameters (single-security limit, single-issuer limit, maximum maturity, maximum weighted average life) are stored in `limit_set` with `limit_set.parameters` and enforced at booking: soft warnings fire at 80% of any limit; hard blocks fire at 100%. The allow-list and limit parameters are reviewed at least annually and whenever Part 703 changes materially; the review is recorded as `instrument_list.review.completed`. The following are hard-blocked at trade entry: derivatives (absent a separate derivatives policy), subordinated debt, instruments below the four highest NRSRO rating categories, stripped MBS unless specifically permitted, and any instrument not on the approved allow-list. The allow-list and limit-set records are write-restricted to Compliance.

**Portfolio Diversification Hard Limits (% of Total Portfolio / % of Net Worth):**

| Category | Max % Portfolio | Max % Net Worth |
|---|---|---|
| U.S. Treasury Bills, Notes, Bonds | 100% | No limit |
| Direct Debt Obligations of U.S. Agencies | 100% | No limit |
| Agency MBS | 100% | No limit |
| Agency CMOs | 100% | No limit |
| Agency HECM Securities | 50% | No limit |
| Structured Notes / Callable Agency | 50% | 100% |
| Other U.S. Agency Securities | 25% | 100% |
| Municipal GO Bonds (all munis combined ≤ 50% portfolio / 200% NW) | 50%¹ | 200%¹ |
| Municipal Essential Purpose Revenue | 50% | 100% |
| Other Municipal Revenue | 25% | 100% |
| Private-Label MBS | 25% | 100% |
| Private-Label ABS | 25% | 100% |
| Corporate Bonds | 25% | 100% |
| Overnight Fed Funds Sold | N/A | 200% |
| Term Fed Funds Sold | N/A | 200% |
| NCUA-Insured / Fully Collateralized CDs | N/A | 200% |
| Uninsured/Uncollateralized CDs | N/A | 50% |
| Repurchase Agreements | N/A | 50% |
| Commercial Paper | N/A | 50% |

¹ Total of all municipal obligations combined may not exceed 50% of total portfolio or 200% of Net Worth.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Trade entry attempted for prohibited or non-permitted instrument (`trade.permissibility.checked`) | Instrument type (`trade.instrument_type`), CUSIP, allow-list version (`instrument_list.version`), Part 703 category (`instrument_list.part703_category`) | Hard block; trade rejected with reason code (`trade.blocked_prohibited`) | Immediate at trade entry |
| Trade entry triggers soft concentration warning (`trade.limit_warning.issued`) | Proposed position size, current portfolio totals, Net Worth, limit parameters (`limit_set.parameters`) | Warning alert to CFO and Compliance (`trade.limit_warning.issued`) | Immediate at trade entry |
| Trade entry triggers hard concentration block (`trade.limit_blocked`) | Same as soft warning | Trade blocked; exception workflow required (`trade.limit_blocked`) | Immediate at trade entry |
| Annual allow-list review (`instrument_list.review.completed`) | Current allow-list (`instrument_list.version`), Part 703 §§703.13–703.14 mapping, any regulatory changes | Updated allow-list version published; review date recorded (`instrument_list.review.completed`) | ≤ 12 months (enforced by `instrument_list.review_due_at`) |
| Material Part 703 regulatory change detected (`regulatory.change_analysis.logged`) | Regulatory change description, CCO and CFO review | Out-of-cycle allow-list review initiated; affected positions flagged (`instrument_list.review.completed`) | As soon as practicable before next affected trade |

**ALERTS/METRICS:** Target: zero prohibited-instrument trades reaching settlement. Alert fires on any `trade.blocked_prohibited` event. Concentration soft-warning count reported monthly to ALCO; hard-block count reported quarterly to the Board.

---

## IP-04 — Interest Rate Risk and ALM Integration {#ip-04-interest-rate-risk-and-alm-integration}

**WHY (Reg cite):** [12 CFR §703.3(b)](https://www.ecfr.gov/current/title-12/part-703/section-703.3) requires the investment policy to address interest rate risk. NCUA Examiner's Guide expectations require integration of the investment portfolio into the institution's ALM framework, including scenario-based total return analysis and periodic IRR simulations. The market depreciation limit (30% of Net Worth under +100/+200/+300 bp parallel shifts) is a board-approved internal limit consistent with safe and sound practices.

**SYSTEM BEHAVIOR:** Each position record (`position`) carries `position.effective_duration`, `position.convexity`, and cash-flow vectors that feed the ALM model (`alm`). The system runs ALCO IRR simulations at least quarterly (`alm.irr_simulation_due_at`) and more frequently when any IRR threshold is breached. The primary analytical tool is prospective, scenario-based total return analysis combining income simulation with projected market value at the horizon (equivalent to income simulation + EVE). Market depreciation stress calculations are run at least quarterly: given parallel yield-curve shifts of +100, +200, and +300 basis points, aggregate price depreciation of the combined AFS and HTM portfolio may not exceed 30% of Net Worth; results are reported to ALCO and the Board. If the 30% limit is breached, an immediate escalation is triggered. Position analytics are updated at least monthly (`position.analytics_update_due`). The ALM model and scenario-set configuration are write-restricted to Treasury/Risk with CFO approval.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| New position booked or existing position updated (`position.booked`, `position.analytics.updated`) | CUSIP, instrument type, coupon, maturity, book value, amortized cost, fair value, CPR/PSA assumptions (`position.cusip`, `position.instrument_type`, `position.coupon`, `position.book_value`, `position.amortized_cost`, `position.fair_value`, `position.effective_duration`, `position.convexity`) | Position analytics record updated; duration and convexity fed to ALM model (`position.analytics.updated`) | At booking; updated monthly (enforced by `position.analytics_update_due`) |
| Quarterly IRR simulation due (`alm.irr_simulation.completed`) | Full position set with cash-flow vectors, scenario set (`alm.scenario_set`), behavioral assumptions | IRR simulation results; total return profile across rate scenarios; EVE output (`alm.irr_simulation.completed`) | Quarterly minimum (enforced by `alm.irr_simulation_due_at`); more frequent on threshold breach |
| Quarterly market depreciation stress calculation | Full AFS + HTM portfolio fair values, Net Worth, +100/+200/+300 bp shock parameters | Market depreciation report: aggregate depreciation as % of Net Worth for each shock scenario; breach flag if > 30% (`portfolio.stress_test.completed`) | Quarterly (enforced by `portfolio.stress_test_due_at`) |
| Market depreciation limit breached (> 30% of Net Worth) (`stress_test.minimum.breached`) | Stress calculation output, Net Worth (`position.fair_value` aggregated, Net Worth) | Immediate escalation to ALCO and Board; remediation plan required (`stress_test.minimum.breached`, `stress_test.remediation.escalated`) | Immediate on detection |
| IRR threshold breached between scheduled simulations | Threshold monitoring output, current position set | Ad-hoc IRR simulation triggered (`alm.irr_simulation.completed`) | Within 5 business days of threshold breach |

**ALERTS/METRICS:** Alert fires when market depreciation under any shock scenario exceeds 25% of Net Worth (soft warning) or 30% (hard breach). IRR simulation aging alert fires if `alm.irr_simulation_due_at` is overdue by more than 5 business days. Target: zero quarters without a completed market depreciation calculation reported to the Board.

---

## IP-05 — Credit Risk Standards and Downgrade Management {#ip-05-credit-risk-standards-and-downgrade-management}

**WHY (Reg cite):** [12 CFR §703.6](https://www.ecfr.gov/current/title-12/part-703/section-703.6) requires credit unions to perform independent credit analysis before purchasing non-government investments and to monitor credit quality on an ongoing basis. NCUA Letter to Credit Unions [LCU 2013-05](https://www.ncua.gov/files/supervisory-letters/LCU2013-05_SupervisoryLetter.pdf) establishes that NRSRO ratings may support but may not be the sole basis for investment-grade determination.

**SYSTEM BEHAVIOR:** For all investments not directly guaranteed by the U.S. government, a completed credit file (`credit_file`) with `credit_file.issuer_analysis`, `credit_file.internal_rating`, and `credit_file.reanalysis_due_at` must exist and be approved (`credit_file.approved`) before the trade is booked. The system blocks booking of non-government instruments without a linked approved credit file. Investment-grade determination requires documented internal analysis confirming: adequate capacity to meet financial commitments over the projected life, low default risk, and expected full and timely repayment of principal and interest. NRSRO ratings (minimum four highest categories) are a supporting input, not the sole basis. Per-instrument due diligence requirements (municipal GO, essential purpose revenue, other revenue, private-label MBS/ABS, corporate bonds, commercial paper) are documented in the permissible instruments appendix and enforced via the pre-purchase checklist (see [IP-11](#ip-11-pre-purchase-due-diligence-and-exceptions)). Credit files are re-analyzed at least annually (`credit_file.reanalysis_due_at`). On any rating downgrade event, the system flags the affected position (`security.downgraded`) and requires a documented review within 5 business days (`security.downgrade_review_due_at`); if the position is material (defined in the authority matrix), the Board is notified. Credit file records are write-restricted to the CFO/Investment Officer and Compliance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Non-government instrument trade entry attempted without approved credit file (`credit_file.approved`) | Instrument CUSIP, instrument type (`trade.instrument_type`), credit file status (`credit_file.id`) | Trade blocked until credit file approved (`trade.limit_blocked`); credit file approval required (`credit_file.approved`) | Before settlement |
| Credit file approved for non-government instrument (`credit_file.approved`) | Issuer analysis (`credit_file.issuer_analysis`), internal rating (`credit_file.internal_rating`), NRSRO rating (supporting), due diligence checklist per instrument type, approver identity | Approved credit file linked to position; booking unblocked (`credit_file.approved`) | Before settlement |
| Annual credit re-analysis due (`credit_file.reanalysis.completed`) | Prior credit file (`credit_file.id`), current issuer financials, NRSRO rating update, due diligence factors per instrument type | Updated credit file with new `credit_file.internal_rating` and `credit_file.reanalysis_due_at` (`credit_file.reanalysis.completed`) | ≤ 12 months from last analysis (enforced by `credit_file.reanalysis_due_at`) |
| Rating downgrade event detected (`security.downgraded`) | CUSIP, prior rating, new rating, position size, Net Worth (for materiality check) (`security.rating_change`) | Downgrade flag on position; review task created (`security.downgraded`, `security.downgrade.reviewed`) | Review completed within 5 business days (enforced by `security.downgrade_review_due_at`) |
| Downgrade review completed — material position (`security.downgrade.reviewed`) | Review findings, materiality determination, remediation options | Board notification issued; remediation plan if required (`board.notification.sent`, `security.downgrade.reviewed`) | Within 5 business days of downgrade detection |

**ALERTS/METRICS:** Alert fires on any `security.downgraded` event; aging alert fires if `security.downgrade_review_due_at` is not cleared within 3 business days. Target: zero non-government positions without a current approved credit file; zero annual re-analyses overdue by more than 30 days.

---

## IP-06 — Liquidity and Marketability Limits {#ip-06-liquidity-and-marketability-limits}

**WHY (Reg cite):** [12 CFR §703.3(b)](https://www.ecfr.gov/current/title-12/part-703/section-703.3) requires the investment policy to address liquidity risk. [12 CFR §741.12](https://www.ecfr.gov/current/title-12/part-741/section-741.12) requires a Contingency Funding Plan that identifies the investment portfolio as a core contingent liquidity source. NCUA Examiner's Guide expectations require the portfolio to consist largely of securities with active secondary markets.

**SYSTEM BEHAVIOR:** Each position is classified into a liquidity bucket (`position.liquidity_bucket`) with `position.days_to_liquidate` and `position.stress_haircut` assigned at booking and reviewed at least monthly (`position.liquidity_classification_due`). The system generates a liquidity report (`liquidity.report`) at least monthly showing on-demand and 30-day stress liquidity capacity across the portfolio; under stress conditions (CFP activation or ALCO declaration), reporting frequency increases to daily or as directed by ALCO. AFS securities may be sold prior to maturity to provide liquid funds; the system tracks AFS vs. HTM classification per position (see [IP-10](#ip-10-valuation-accounting-and-fair-value-measurement)). The portfolio must consist largely of securities with active secondary or resale markets; instruments with no active secondary market require explicit ALCO approval and are flagged in the liquidity report. Liquidity classification records are write-restricted to Treasury/Risk.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| New position booked (`position.booked`) | Instrument type, maturity, market depth indicator (`position.instrument_type`, `position.liquidity_bucket`), stress haircut table (`liquidity.haircut_table`) | Liquidity bucket, days-to-liquidate, and stress haircut assigned to position (`position.liquidity.classified`) | At booking |
| End of calendar month — liquidity report due (`liquidity.report.published`) | Full position set with liquidity classifications, stress haircuts, on-demand capacity, 30-day stress outflow estimates (`liquidity.net_outflows_30d`, `liquidity.liquid_assets`) | Monthly liquidity report to ALCO (`liquidity.report.published`) | Monthly (enforced by `liquidity.report_due_at`); daily under stress |
| Stress event declared or CFP activated (`liquidity.stress.declared`) | CFP level (`cfp.level`), ALCO declaration, current liquidity position | Liquidity reporting frequency increased to daily; investment liquidation hierarchy activated (`cfp.level.changed`, `liquidity.cfp.activated`) | Immediately on declaration |
| Position liquidity classification review due (`position.liquidity.classified`) | Current market depth data (`market.depth_indicator`), position details | Updated liquidity classification; alert if classification deteriorates (`position.liquidity.classified`) | Monthly (enforced by `position.liquidity_classification_due`) |

**ALERTS/METRICS:** Alert fires if on-demand liquidity capacity falls below the ALCO-approved minimum threshold. Alert fires if any position's days-to-liquidate exceeds the bucket maximum. Target: 100% of positions classified at all times; zero positions with stale liquidity classifications (> 35 days).

---

## IP-07 — Concentration and Counterparty Limits {#ip-07-concentration-and-counterparty-limits}

**WHY (Reg cite):** [12 CFR §703.3(b)](https://www.ecfr.gov/current/title-12/part-703/section-703.3) requires the investment policy to address concentration risk. NCUA Examiner's Guide expectations require concentration limits addressing single or related issuer, geographic area, and obligations with similar cash-flow or risk characteristics. The diversification limits in [IP-03](#ip-03-permissible-investments-and-prohibited-activities) constitute the hard limits; ALCO may establish tighter operating limits by sector.

**SYSTEM BEHAVIOR:** The system maintains parameterized concentration limits in `limit_set` covering single-issuer, sector, rating category, product type, and counterparty dimensions. Soft warnings fire at 80% of any limit; hard blocks fire at 100%. ALCO may establish tighter operating limits by sector on a periodic basis; these are stored as overlay limits in `limit_set` and take precedence over the policy hard limits for operating purposes. Concentration limits are reviewed at least annually (`limit_set.review_due_at`) and whenever the portfolio composition or Net Worth changes materially. The instrument-level parameters from [IP-03](#ip-03-permissible-investments-and-prohibited-activities) (single-security limit, single-issuer limit, maximum maturity, maximum weighted average life) are enforced at trade entry as part of this control. Limit-set records are write-restricted to Compliance with ALCO concurrence.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Trade entry — concentration soft warning (`trade.limit_warning.issued`) | Proposed trade details, current issuer/sector/counterparty exposures (`exposure.by_issuer`, `exposure.by_sector`, `exposure.by_counterparty`), limit parameters (`limit_set.parameters`), Net Worth | Soft warning alert to CFO and Compliance; trade may proceed with acknowledgment (`trade.limit_warning.issued`) | Immediate at trade entry |
| Trade entry — concentration hard block (`trade.limit_blocked`) | Same as soft warning | Trade blocked; exception workflow required before settlement (`trade.limit_blocked`) | Immediate at trade entry |
| ALCO sets tighter operating limits by sector | ALCO decision, sector definition, new limit percentage | Operating limit overlay recorded in `limit_set`; effective immediately (`limit_set.review.completed`) | Effective at ALCO meeting |
| Annual concentration limit review (`limit_set.review.completed`) | Current limit parameters, portfolio composition, Net Worth, ALCO strategy | Updated limit-set version published; review date recorded (`limit_set.review.completed`) | ≤ 12 months (enforced by `limit_set.review_due_at`) |
| Concentration breach detected post-trade (e.g., Net Worth decline) (`concentration.limit_exceeded`) | Current position set, updated Net Worth, limit parameters | Breach alert to CFO and ALCO; remediation plan required within 5 business days (`concentration.waiver.opened`) | Immediate on detection |

**ALERTS/METRICS:** Soft-warning count reported monthly to ALCO; hard-block count and any post-trade breaches reported quarterly to the Board. Target: zero hard-block overrides without documented exception approval; zero post-trade concentration breaches outstanding more than 5 business days.

---

## IP-08 — Approved Brokers, Dealers, and Safekeepers {#ip-08-approved-brokers-dealers-and-safekeepers}

**WHY (Reg cite):** [12 CFR §703.8](https://www.ecfr.gov/current/title-12/part-703/section-703.8) requires credit unions to conduct business only with approved securities dealers and to maintain due-diligence records. [12 CFR §703.9](https://www.ecfr.gov/current/title-12/part-703/section-703.9) requires purchased securities to be held by an approved safekeeping agent (not the selling dealer) and bank records to be reconciled to safekeeping agent statements at least monthly per [§703.9(c)](https://www.ecfr.gov/current/title-12/part-703/section-703.9).

**SYSTEM BEHAVIOR:** The system maintains an approved intermediaries list (`intermediary`) with `intermediary.approved_list`, `intermediary.due_diligence_file`, and `intermediary.review_due_at`. At trade entry, the system validates `trade.intermediary_id` against the approved list; trades with unapproved intermediaries are hard-blocked (`trade.intermediary_blocked`). Annual due-diligence reviews cover: (1) capital strength, liquidity, and operating results; (2) general reputation for financial stability and fair dealings; (3) FINRA and state/federal regulator enforcement actions; and (4) sales representative experience and expertise. Purchased securities must be transferred to an approved safekeeping agent (`safekeeping`) and may not remain with the selling dealer; the system enforces this by requiring a `safekeeping.statement` reference on each settled position. Safekeeping statements are reconciled to bank records at least monthly (`safekeeping.reconciliation_due_at`). Board approval is required for any new or existing safekeeping agent. The approved intermediaries list and safekeeping agent list are write-restricted to the CFO; board approval events are recorded by Compliance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Trade entry with unapproved intermediary (`trade.intermediary_blocked`) | Dealer/broker identity (`trade.intermediary_id`), approved list (`intermediary.approved_list`) | Trade hard-blocked; alert to CFO (`trade.intermediary_blocked`) | Immediate at trade entry |
| Annual dealer due-diligence review (`intermediary.review.completed`) | Due-diligence file per dealer (`intermediary.due_diligence_file`): capital/liquidity/operating results, reputation, FINRA/regulator enforcement history, sales rep credentials | Updated due-diligence file; board-approved dealer list refreshed (`intermediary.review.completed`) | ≤ 12 months (enforced by `intermediary.review_due_at`) |
| Securities settled — safekeeping transfer required | Settled trade details, approved safekeeper list (`safekeeping.statement`) | Safekeeping transfer confirmed; position linked to safekeeper (`safekeeping.statement.received`) | At or before settlement |
| Monthly safekeeping reconciliation due (`safekeeping.reconciliation.completed`) | Bank position records, safekeeping agent statement (`safekeeping.statement`) | Reconciliation completed; discrepancies flagged for immediate resolution (`safekeeping.reconciliation.completed`) | Monthly (enforced by `safekeeping.reconciliation_due_at`) |
| Board approves new or existing safekeeping agent | Board resolution, safekeeper due-diligence package | Safekeeper added to approved list; board approval recorded (`policy.board.approved` for safekeeper schedule) | Before any securities are transferred to new agent |

**ALERTS/METRICS:** Alert fires on any `trade.intermediary_blocked` event. Reconciliation aging alert fires if `safekeeping.reconciliation_due_at` is not cleared within 5 business days of month-end. Target: zero trades settled with unapproved intermediaries; zero safekeeping reconciliation breaks outstanding more than 10 business days.

---

## IP-09 — Repurchase and Reverse Repurchase Agreements {#ip-09-repurchase-and-reverse-repurchase-agreements}

**WHY (Reg cite):** [12 CFR §703.13](https://www.ecfr.gov/current/title-12/part-703/section-703.13) addresses permissible investment activities including repurchase agreements. NCUA IRPS 1985-2 and Part 703 guidance establish safe-and-sound collateral practices, haircut requirements, and maturity-mismatch limits for repurchase and reverse repurchase transactions. The single-issuer limit of 25% of Net Worth and maximum maturity of 3 months apply as baseline limits.

**SYSTEM BEHAVIOR:** Each repurchase agreement is represented as a `repo` record with explicit fields: `repo.collateral_cusip`, `repo.haircut`, `repo.counterparty_id`, `repo.maturity_mismatch_days`, `repo.required_margin`, and `repo.margin_shortfall_amount`. Repos are treated as secured borrowings: the credit union simultaneously sells securities and agrees to repurchase them at a specified price on a specified future date, creating a balance-sheet liability while the investment remains as an asset. The system blocks booking of any repo that violates the 3-month maximum maturity, the 25% of Net Worth single-issuer limit, or applicable maturity-mismatch limits (`repo.blocked_rule_violation`). Collateral is marked to market at least weekly (`repo.collateral_revaluation_due_at`) and daily under stress; margin calls are issued automatically on any shortfall (`repo.margin_call`). Repo records are write-restricted to Treasury/CFO; Compliance has read access.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Repo booking attempted — rule violation detected (`repo.booked`) | Repo terms (`repo.maturity_mismatch_days`, `repo.counterparty_id`), counterparty aggregate exposure, Net Worth, limit parameters (`limit_set.parameters`) | Booking blocked; violation reason recorded (`repo.blocked_rule_violation`) | Immediate at booking |
| Repo booked within limits (`repo.booked`) | Collateral CUSIP (`repo.collateral_cusip`), haircut (`repo.haircut`), counterparty (`repo.counterparty_id`), maturity, settlement amount | Repo record created; collateral revaluation schedule set (`repo.booked`, `repo.collateral_revaluation_due_at`) | At booking |
| Weekly collateral mark-to-market (`repo.collateral_marked`) | Current fair value of collateral (`repo.collateral_cusip`), required margin (`repo.required_margin`), haircut (`repo.haircut`) | Collateral marked; margin shortfall computed (`repo.collateral_marked`); margin call issued if shortfall > 0 (`repo.margin_call.issued`) | Weekly (enforced by `repo.collateral_revaluation_due_at`); daily under stress |
| Margin shortfall detected (`repo.margin_shortfall.detected`) | Shortfall amount (`repo.margin_shortfall_amount`), counterparty contact | Margin call issued to counterparty; alert to CFO (`repo.margin_call.issued`, `repo.margin_shortfall.detected`) | Immediately on detection |

**ALERTS/METRICS:** Alert fires on any `repo.blocked_rule_violation` event and on any `repo.margin_shortfall.detected` event. Aging alert fires if a margin call is not resolved within 1 business day. Target: zero repos booked in violation of maturity or issuer limits; zero unresolved margin shortfalls at any weekly mark.

---

## IP-10 — Valuation, Accounting, and Fair-Value Measurement {#ip-10-valuation-accounting-and-fair-value-measurement}

**WHY (Reg cite):** [12 CFR §703.11](https://www.ecfr.gov/current/title-12/part-703/section-703.11) requires credit unions to value investment securities in accordance with GAAP. GAAP (ASC 320) requires classification of debt securities as HTM (amortized cost) or AFS (fair value with unrealized gains/losses in equity) at purchase, with transfers between categories rare and documented. OTTI recognition requirements (ASC 320-10-35) require quarterly security-by-security evaluation.

**SYSTEM BEHAVIOR:** At purchase, each security is classified as HTM or AFS (`position.instrument_type` carries the classification designation); the classification is recorded in the trade ticket and linked to the position. HTM securities are reported at amortized cost (`position.amortized_cost`); AFS securities are reported at fair value (`position.fair_value`) with unrealized gains/losses excluded from income and reported in a separate component of members' equity on a tax-affected basis. Transfers between HTM and AFS are rare and require documented CFO approval; permissible transfer reasons are: (1) less than 3 months to maturity or effective call date; (2) less than 15% of purchase face remaining on MBS/CMO; (3) deterioration of creditworthiness; (4) major regulatory change; or (5) a business combination or disposition resulting in an unacceptable asset/liability position. Fair value is updated at least monthly from reputable, independent pricing sources (`security.fair_value.updated`); at least quarterly, the CFO verifies that reported fair values are reasonable and supported (`security.fair_value_update_due_at`). OTTI evaluation is conducted quarterly on a security-by-security basis; for securities in a loss position of 10% or more, management assesses whether the issuer is unable to pay all contractual amounts due; if probable, OTTI is recorded and the security is written down to fair value with credit impairment flowing through income (`security.otti_analysis.completed`). Pricing overrides are restricted to CFO/Controller under dual approval; all overrides are logged. AFS repositioning (sale prior to maturity) is permitted when warranted to improve risk/reward profile, adjust IRR sensitivity, improve liquidity, or improve credit quality.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Security purchased — classification required (`position.booked`) | AFS vs. HTM designation, instrument type, purchase price, amortized cost (`position.book_value`, `position.amortized_cost`, `position.instrument_type`) | Classification recorded on position; linked to trade ticket (`position.booked`) | At purchase |
| Monthly fair-value update due (`security.fair_value.updated`) | Independent pricing source data, CUSIP, prior fair value (`position.fair_value`, `position.cusip`) | Updated fair value recorded on position; unrealized gain/loss computed (`security.fair_value.updated`) | Monthly (enforced by `security.fair_value_update_due_at`) |
| Quarterly fair-value reasonableness verification | Fair values from pricing source, CFO review, independent benchmark | Verification documented; any discrepancies flagged for override review (`security.fair_value.updated`) | Quarterly (enforced by `security.fair_value_update_due_at`) |
| Quarterly OTTI evaluation (`security.otti_analysis.completed`) | Full position set, fair values, amortized cost, loss positions ≥ 10% (`position.fair_value`, `position.amortized_cost`), issuer credit assessment | OTTI evaluation documented per security; OTTI recorded and write-down booked if probable (`security.otti_analysis.completed`) | Quarterly (enforced by `portfolio.stress_test_due_at` as proxy; dedicated OTTI task) |
| Pricing override requested | Override rationale, CFO and Controller dual approval, original and proposed price | Override logged with dual-approval evidence; alert to Compliance (`override.recorded`, `override.senior_decision.recorded`) | Before fair-value publication |
| HTM-to-AFS transfer requested | Transfer rationale (one of five permissible reasons), CFO documentation | Transfer documented and approved; position reclassified; board notified at next meeting (`position.analytics.updated`) | Before next reporting period |

**ALERTS/METRICS:** Alert fires on any pricing override; aging alert fires if monthly fair-value update is not completed within 5 business days of month-end. Target: zero OTTI evaluations missed in any quarter; zero pricing overrides without dual-approval documentation.

---

## IP-11 — Pre-Purchase Due Diligence and Exceptions {#ip-11-pre-purchase-due-diligence-and-exceptions}

**WHY (Reg cite):** [12 CFR §703.6](https://www.ecfr.gov/current/title-12/part-703/section-703.6) requires independent credit analysis before purchasing non-government investments. [12 CFR §703.3](https://www.ecfr.gov/current/title-12/part-703/section-703.3) requires the investment policy to establish pre-purchase analysis procedures. The pre-purchase checklist and exception log are the operational implementation of these requirements.

**SYSTEM BEHAVIOR:** For all non-government, non-fully-insured instruments, the system enforces a pre-trade checklist (`trade.pretrade_checklist`) that must be completed and linked to a credit memo (`credit_file.issuer_analysis`) and valuation support (`trade.valuation_support`) before the trade is booked. The checklist is instrument-type-specific and captures all required documentation fields (see purchase documentation list below). U.S. government obligations and fully NCUA-insured instruments are exempt from the credit memo requirement but still require trade ticket documentation. Any exception to the pre-purchase checklist requires documented approval before settlement; exceptions are logged to the board-thresholded exception register (`trade.exception_raised`). The exception threshold (dollar amount or frequency) is defined in the authority matrix; exceptions exceeding the threshold are reported to the Board at the next quarterly meeting. Pre-trade checklist completion is write-restricted to the CFO/Investment Officer; exception approvals require Compliance sign-off.

**Required purchase documentation:** bond issuer; bond/security type; CUSIP; issue size; issue date, maturity date, call date; coupon and coupon frequency; trade date and settlement date; par value, original issue price, and credit union purchase price; prospective total return profile; yield, duration, and weighted average life; CPR/PSA assumptions and analysis (if applicable); credit analysis memo (required for non-government instruments); AFS vs. HTM classification designation; name of dealer.

**Required sale documentation:** bond issuer; bond/security type; CUSIP; rationale for sale; total return profile at sale price; trade date; settlement date; coupon; price; yield; par value; name of dealer.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Non-government instrument trade entry — pre-trade checklist required (`trade.checklist.completed`) | All required purchase documentation fields, credit memo (`credit_file.issuer_analysis`), valuation support (`trade.valuation_support`), AFS/HTM designation | Completed pre-trade checklist linked to trade; booking unblocked (`trade.checklist.completed`) | Before booking |
| Pre-trade checklist exception identified (`trade.checklist_exception_raised`) | Exception rationale, approver identity, missing documentation description | Exception logged; Compliance approval required before settlement (`trade.checklist_exception_raised`, `trade.exception.approved`) | Before settlement |
| Sale transaction executed | All required sale documentation fields, rationale for sale, total return profile at sale price | Sale documentation linked to trade ticket (`trade.booked`) | At trade entry; documents attached within 2 business days |
| Exception count or amount exceeds board threshold | Exception register summary, threshold from authority matrix | Board notification at next quarterly meeting (`board.notification.sent`) | Next quarterly board meeting |

**ALERTS/METRICS:** Alert fires on any `trade.checklist_exception_raised` event. Aging alert fires if any exception is not resolved (approved or rejected) within 1 business day. Target: zero trades settled without a completed pre-trade checklist; exception rate reported quarterly to the Board.

---

## IP-12 — Ongoing Monitoring, Reporting, and Stress Testing {#ip-12-ongoing-monitoring-reporting-and-stress-testing}

**WHY (Reg cite):** [12 CFR §703.12](https://www.ecfr.gov/current/title-12/part-703/section-703.12) requires ongoing monitoring of the investment portfolio. [12 CFR §703.3(b)](https://www.ecfr.gov/current/title-12/part-703/section-703.3) requires the investment policy to address monitoring and reporting. NCUA Examiner's Guide expectations require periodic stress testing of the portfolio and regular reporting to management and the board.

**SYSTEM BEHAVIOR:** The system generates recurring reports on portfolio composition, duration, liquidity, gain/loss, and limit adherence. Management (ALCO) receives reports at least monthly; the Board receives reports at least quarterly (monthly preferred). Portfolio stress tests are run at least annually and more frequently as metrics approach limits (`portfolio.stress_test_due_at`). Board reports include: all security purchases; all security sales and net gains/(losses); portfolio composition; prospective total return profile; portfolio total return results; portfolio yield, current effective duration, and current average life; credit risk considerations; market appreciation or depreciation; and market appreciation/depreciation as a percent of Net Worth. ALCO reports include: current and desired portfolio composition; prospective total return profile over one or more time horizons; analysis of risk considerations; liquidity objectives; portfolio total return results, current effective duration, and current average life; and credit union net worth levels. Report generation is automated from position and trade data; report distribution is logged. Report records are write-restricted to Finance/Treasury; Compliance and the Board have read access.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| End of calendar month — ALCO management report due (`portfolio.management_report.issued`) | Full position set, trade activity, duration, liquidity metrics, net worth, total return results (`portfolio.performance_metrics`, `portfolio.gain_loss_summary`) | Monthly ALCO investment report (`portfolio.management_report.issued`) | Monthly (enforced by `portfolio.report_due_at`) |
| End of calendar quarter — board report due (`portfolio.board_report.issued`) | Full position set, purchases, sales, net gain/loss, total return, yield, duration, average life, credit risk summary, market depreciation as % of Net Worth | Quarterly board investment report package (`portfolio.board_report.issued`) | Quarterly; monthly preferred (enforced by `portfolio.board_report_due_at`) |
| Annual portfolio stress test due (`portfolio.stress_test.completed`) | Stress scenario set, full position set, limit parameters, Net Worth | Stress test results; limit-adherence summary; remediation plan if limits approached (`portfolio.stress_test.completed`) | Annual minimum (enforced by `portfolio.stress_test_due_at`); more frequent as metrics approach limits |
| Metric approaches limit threshold (80% of any limit) | Current metric value, limit parameter (`limit_set.parameters`) | Soft warning alert to CFO and ALCO; ad-hoc stress test may be triggered (`trade.limit_warning.issued`) | Immediate on detection |

**ALERTS/METRICS:** Aging alert fires if monthly management report is not distributed within 5 business days of month-end; quarterly board report within 10 business days of quarter-end. Target: zero quarters without a completed board report; zero annual stress tests missed.

---

## IP-13 — Performance Measurement and Benchmarks {#ip-13-performance-measurement-and-benchmarks}

**WHY (Reg cite):** [12 CFR §703.3(b)](https://www.ecfr.gov/current/title-12/part-703/section-703.3) requires the investment policy to address performance measurement. NCUA Examiner's Guide expectations require that performance targets not incentivize breaching risk limits and that performance measurement support ALCO's assessment of the portfolio's risk/reward profile relative to approved strategy.

**SYSTEM BEHAVIOR:** Total return analysis — combining income simulation with projected market value at the horizon — is the primary performance measurement tool. Performance attribution is conducted quarterly by portfolio segment (`performance.attribution_due_at`), comparing actual total return against approved benchmarks. Benchmarks are defined in the ALCO-approved strategy and stored in `performance.targets`; any proposed change to performance targets is reviewed to confirm it does not incentivize breaching risk limits (`performance.target_risk.reviewed`). Performance results are included in the quarterly board report (see [IP-12](#ip-12-ongoing-monitoring-reporting-and-stress-testing)) and the monthly ALCO report. Performance records are write-restricted to Treasury/Finance; Compliance has read access.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| End of calendar quarter — performance attribution due (`performance.attribution.completed`) | Actual total return by segment, benchmark returns (`performance.targets`), rate scenario assumptions, position-level total return data (`portfolio.performance_metrics`) | Quarterly performance attribution report by segment; variance to benchmark documented (`performance.attribution.completed`) | Quarterly (enforced by `performance.attribution_due_at`) |
| Proposed change to performance targets or benchmarks (`performance.target_change.proposed`) | Proposed new target, risk-limit impact analysis, ALCO review | Risk-limit impact assessment documented; ALCO approval required before target change effective (`performance.target_risk.reviewed`) | Before target change takes effect |
| Performance target breach detected (actual return materially below benchmark) | Attribution results, benchmark, variance magnitude | Alert to ALCO; strategy review initiated (`performance.target_risk.reviewed`) | At quarterly attribution |

**ALERTS/METRICS:** Alert fires if any segment's total return falls more than a board-approved threshold below benchmark for two consecutive quarters. Target: 100% of quarters with completed attribution reports; zero target changes implemented without documented risk-limit impact review.

---

## IP-14 — Trade Execution, Controls, and Segregation of Duties {#ip-14-trade-execution-controls-and-segregation-of-duties}

**WHY (Reg cite):** [12 CFR §703.3(b)](https://www.ecfr.gov/current/title-12/part-703/section-703.3) requires the investment policy to address internal controls. [12 CFR §703.15](https://www.ecfr.gov/current/title-12/part-703/section-703.15) prohibits conflicts of interest in investment activities. NCUA Examiner's Guide expectations require segregation of trade initiation, approval, confirmation, settlement, and accounting, with dual control and no single user controlling a full transaction lifecycle.

**SYSTEM BEHAVIOR:** The system enforces segregation of duties (`sod`) across the trade lifecycle: trade initiation, approval, confirmation, settlement, and accounting are assigned to distinct roles; no single user may perform more than one of these steps on the same trade (`trade.sod_blocked`). Dual control is enforced for trades above a threshold defined in the authority matrix. Trade confirmations are matched against trade tickets (`trade.confirmation_matched`); discrepancies are flagged immediately (`trade.confirmation_discrepancy.flagged`). Settlement is reconciled within T+1 (`trade.reconciliation_due_at`). All trade lifecycle steps are logged as `trade.step.recorded` events. The SOD matrix is maintained by Compliance and reviewed annually; any SOD conflict detected at access provisioning is blocked (`sod.conflict.detected`). Trade execution records are write-restricted per role; Compliance and Internal Audit have read access to all steps.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Trade initiation attempted by user with conflicting role (`trade.sod_blocked`) | User role (`user.role`), SOD matrix (`sod.matrix_version`), trade step attempted (`trade.step_attempted`) | Trade step blocked; SOD violation logged (`trade.sod_blocked`, `sod.violation.logged`) | Immediate at step attempt |
| Trade confirmation received from dealer (`trade.confirmation.received`) | Dealer confirmation details, original trade ticket (`trade.ticket`) | Confirmation matched or discrepancy flagged (`trade.confirmation_matched`, `trade.confirmation_discrepancy.flagged`) | Same business day as confirmation receipt |
| Trade confirmation discrepancy detected (`trade.confirmation_discrepancy.flagged`) | Discrepancy details, original trade ticket, dealer confirmation | Discrepancy flagged; CFO and Compliance notified; resolution required before settlement (`trade.confirmation_discrepancy.flagged`) | Before settlement |
| T+1 reconciliation due (`trade.reconciliation.completed`) | Settled trade details, safekeeping confirmation, GL entries | Reconciliation completed; breaks flagged for immediate resolution (`trade.reconciliation.completed`) | T+1 (enforced by `trade.reconciliation_due_at`) |
| Each trade lifecycle step completed (`trade.step.recorded`) | Step type, actor identity (`user.id`, `user.role`), trade ID, timestamp | Audit log entry for each step (`trade.step.recorded`) | At each step |

**ALERTS/METRICS:** Alert fires on any `trade.sod_blocked` or `trade.confirmation_discrepancy.flagged` event. Aging alert fires if T+1 reconciliation is not completed by end of T+2. Target: zero SOD violations; zero unresolved confirmation discrepancies at settlement; zero T+1 reconciliation breaks outstanding more than 2 business days.

---

## IP-15 — Recordkeeping and Documentation Retention {#ip-15-recordkeeping-and-documentation-retention}

**WHY (Reg cite):** [12 CFR §703.4](https://www.ecfr.gov/current/title-12/part-703/section-703.4) requires credit unions to maintain records of investment transactions. NCUA and federal record retention requirements establish minimum retention periods for investment records. The 2-business-day attachment requirement is an internal SLA consistent with safe and sound practices.

**SYSTEM BEHAVIOR:** All trade tickets, confirmations, credit memos, approvals, safekeeping statements, and reports are stored and indexed in the document management system (`document`) with `document.subject_ref` linking each document to its trade or position record. Required documents must be attached to the relevant trade or position record within 2 business days of the triggering event (`document.attachment_due_at`). Retention schedules comply with applicable NCUA and federal requirements and are maintained in the Record Retention Policy; the `document.retention_schedule` field carries the applicable schedule code. Document records are write-restricted to the originating function; Compliance and Internal Audit have read access. Hold/destruction lifecycle mechanics are governed by [SC-02](#sc-02-record-retention-lifecycle-mechanics) embedded in this policy.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Trade booked — documentation attachment required (`document.required_set`) | Trade ticket, dealer confirmation, credit memo (if applicable), AFS/HTM designation, approvals (`document.type`, `document.subject_ref`) | Documents attached and indexed to trade record (`document.required_set`) | Within 2 business days of trade booking (enforced by `document.attachment_due_at`) |
| Sale transaction executed — sale documentation required | Sale documentation set (rationale, total return at sale price, trade/settlement dates, coupon, price, yield, par, dealer) | Sale documents attached and indexed (`document.required_set`) | Within 2 business days of trade |
| Document attachment overdue (`document.attachment_due_at` passed) | Trade record, missing document list | Alert to CFO and Compliance; escalation if not resolved within 1 additional business day | Immediately on due-date passage |

**ALERTS/METRICS:** Alert fires on any document attachment overdue event. Target: zero trade records with missing required documents more than 3 business days after booking; 100% of records with assigned retention schedules. Hold, destruction, and permanent-record alerts are governed by [SC-02](#sc-02-record-retention-lifecycle-mechanics).

---

## SC-02 — Record-Retention Lifecycle Mechanics {#sc-02-record-retention-lifecycle-mechanics}

**WHY (Reg cite):** [12 CFR Part 364, Appendix B](https://www.ecfr.gov/current/title-12/part-364#Appendix-B-to-Part-364) requires documented, auditable destruction processes and safeguards extending to all retained records. Failure to suspend destruction upon notice of litigation or investigation constitutes spoliation under common law and may result in sanctions and adverse inference instructions. This control implements [RR-03 — Document Destruction](../record-retention/record-retention.md#rr-03-document-destruction) and [RR-05 — Legal Holds](../record-retention/record-retention.md#rr-05-legal-holds) from the Record Retention Policy, which is the authoritative source for Schedule A retention periods, destruction procedures, and the permanent-record inventory.

**SYSTEM BEHAVIOR:** Once a retention clock is set by this policy's record-class-specific control, the following lifecycle mechanics apply to all records within scope. Legal holds take precedence over all scheduled destruction: upon notice of litigation, investigation, or subpoena, the CCO or General Counsel places a legal hold specifying scope (`legal_hold.hold_scope`) and matter reference (`legal_hold.matter_ref`); the system immediately sets `record.legal_hold_flag` = true for all in-scope records and suspends any queued disposal (`disposal.held`). Hold release requires written authorization from the CCO or General Counsel; upon release, `legal_hold.schedule_resumed` is set and the retention clock resumes. A record becomes eligible for disposal only when all three conditions are met: (a) `record.retention_expires_at` has passed, (b) `record.legal_hold_flag` is clear, and (c) the department records-retention contact has confirmed no pending regulatory inquiry (`record.disposal_eligible` = true). Destruction is executed by a licensed vendor in accordance with [12 CFR Part 364 App. B](https://www.ecfr.gov/current/title-12/part-364#Appendix-B-to-Part-364) with two associates initialing the Destruction Log (Exhibit 1) and the vendor's destruction certificate attached (`disposal.certificate`). Permanent records (`record.retention_class` = "Permanent") are excluded from all disposal runs by system enforcement; any attempt to queue a permanent record for disposal generates an immediate alert. Write access to legal-hold placement and release is restricted to the CCO and General Counsel; write access to `record.disposal_eligible` is restricted to the department records-retention contact with SVP Operations & Finance countersignature for batches exceeding 500 records.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Litigation, investigation, or subpoena identified (`legal_hold.created`) | Matter ID (`legal_hold.matter_id`), hold scope (`legal_hold.hold_scope`), placed-at timestamp (`legal_hold.placed_at`), authorizing officer | Legal hold placed (`legal.hold.placed`); all in-scope records flagged (`record.hold.placed`, `record.legal_hold_flag` = true); disposal suspended (`disposal.held`) | Immediately upon notice |
| Hold scope updated — additional records identified (`record.hold.applied`) | Updated scope, matter ID, authorizing officer | Scope update logged (`record.hold.applied`); additional records flagged | Within 1 BD of identification |
| Legal hold released (`legal_hold.clear.confirmed`) | Release authorization (`legal_hold.release_approved_by`), released-at timestamp (`legal_hold.released_at`), matter resolution basis | Hold released (`legal.hold.released`); `record.hold.released` for all in-scope records; `legal_hold.schedule_resumed` set; disposal clock resumed (`disposal.clock_resumed`) | Upon written authorization from CCO or General Counsel |
| Record meets all three disposal-eligibility conditions (`record.disposal_eligible` = true) | `record.retention_expires_at` passed, `record.legal_hold_flag` clear, department contact confirmation of no pending inquiry | Record queued for disposal (`disposal.scheduled`); destruction log entry initiated (`destruction_log.entry.created`) | Within 30 days of eligibility (enforced by `record.retention_expires_at`) |
| Destruction executed by licensed vendor (`disposal.executed`) | Vendor identity, batch manifest (`disposal.batch_manifest_id`), two-associate initials on Destruction Log (Exhibit 1), vendor certificate (`disposal.certificate`) | Destruction certified (`record.destruction.certified`); `record.destroyed` logged; certificate attached to `destruction_log.entry_id` | At time of destruction |
| Permanent record disposal attempted — system block | Attempted disposal action, record ID, `record.retention_class` = "Permanent" | Disposal blocked; alert issued to SVP Operations & Finance and CCO; `destruction_log.mismatch.detected` logged | Immediately upon detection |

**ALERTS/METRICS:** Alert immediately if any record with `record.legal_hold_flag` = true is queued for disposal (target: zero). Alert when eligible records remain undestroyed more than 60 days past `record.retention_expires_at`. Alert immediately on any attempted disposal of a permanent record (target: zero successful permanent-record destructions). Monitor vendor certificate attachment rate; target 100% of destruction events have `disposal.certificate` attached within 5 BD.

---

## IP-16 — Training, Competency, and Conflicts of Interest {#ip-16-training-competency-and-conflicts-of-interest}

**WHY (Reg cite):** [12 CFR §703.15](https://www.ecfr.gov/current/title-12/part-703/section-703.15) and [§703.16](https://www.ecfr.gov/current/title-12/part-703/section-703.16) address conflicts of interest in investment activities. NCUA Examiner's Guide expectations require that covered staff and board members have appropriate competency and that conflicts of interest be identified and managed. The training-before-access and auto-suspension requirements are internal controls consistent with safe and sound practices.

**SYSTEM BEHAVIOR:** All staff and board members with investment-related responsibilities are designated as covered persons (`covered_person`). Required training (`training`) must be completed before system access is granted to any investment function; the system blocks access provisioning until `training.completion_status` is confirmed (`training.completed`). Annual COI certifications (`coi`) are required for all covered persons; the system auto-suspends investment system access (`access.suspended`) for any covered person who does not complete the annual COI certification by the due date (`coi.questionnaire_due_at`). Any identified conflict is disclosed, reviewed, and resolved before the covered person participates in any affected investment decision (`coi.recusal.executed`). Training records and COI certifications are write-restricted to HR/Compliance; access suspension is automated by the system.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| New covered person hired or role changed (`employee.hired`, `employee.role.changed`) | Role assignment, required training curriculum (`training.required_curriculum`, `training.role_curriculum`), covered person designation (`covered_person.role`) | Training assignment created; system access blocked until training complete (`training.assignment.created`) | Before system access granted |
| Training completed by covered person (`training.completed`) | Training completion record (`training.completion_status`, `training.module_id`), assessment score | System access provisioned; completion logged (`training.completed`, `access.provisioned`) | Immediately on completion |
| Annual COI certification cycle opens (`coi.annual_cycle.opened`) | Covered person roster (`covered_person.roster`), COI questionnaire version (`coi.questionnaire_version`) | COI questionnaires issued to all covered persons (`coi.questionnaire.issued`) | Annual cycle open date (enforced by `coi.questionnaire_due_at`) |
| COI certification not completed by due date | `coi.questionnaire_due_at` passed, no `coi.certified` recorded | Investment system access auto-suspended; alert to CCO (`access.suspended`) | Immediately on due-date passage |
| COI certification completed (`coi.certified`) | Completed questionnaire (`coi.questionnaire_responses`), attestation signature (`coi.attestation_signature`) | Certification recorded; access restored if suspended (`coi.certified`, `access.provisioned`) | Within 1 business day of completion |
| Conflict of interest identified (`coi.conflict_identified`) | Conflict description (`coi.interest_description`), related matter (`coi.matter_reference`), covered person identity | Conflict disclosed; recusal executed before affected decision; register entry created (`coi.disclosure.filed`, `coi.recusal.executed`, `coi.register_entry.created`) | Before participation in affected decision |

**ALERTS/METRICS:** Alert fires on any access auto-suspension due to COI non-completion. Target: 100% COI certification rate by due date; zero covered persons with lapsed training accessing investment systems; zero undisclosed conflicts identified in audit.

---

## IP-17 — Contingency Planning and Liquidity Stress Events {#ip-17-contingency-planning-and-liquidity-stress-events}

**WHY (Reg cite):** [12 CFR §741.12](https://www.ecfr.gov/current/title-12/part-741/section-741.12) requires credit unions above applicable asset thresholds to maintain a Contingency Funding Plan (CFP) that identifies contingent liquidity sources, including the investment portfolio. The investment portfolio must be structured so that a sufficient tranche of AFS securities can be liquidated under stress without fire-sale pricing. The CFP investment-liquidation hierarchy and annual test requirement are consistent with NCUA Examiner's Guide expectations.

**SYSTEM BEHAVIOR:** The system maintains a predefined investment liquidation hierarchy (`cfp.liquidation_hierarchy`) within the CFP framework (`cfp`), ranking AFS securities by liquidity tier, days-to-liquidate, and stress haircut (from [IP-06](#ip-06-liquidity-and-marketability-limits)). The hierarchy is tested at least annually (`cfp.investment_test_due_at`); test results are documented and any gaps remediated. On declaration of an actual liquidity stress event (`liquidity.stress.declared`), the system requires an initial execution plan to be documented within 1 business day (`cfp.execution_plan_due_at`). The CFP investment liquidation hierarchy is reviewed and updated whenever the portfolio composition changes materially or the CFP is revised. The CFP and liquidation hierarchy are write-restricted to Treasury/CFO with CCO approval; the enterprise CFP governance is out of scope (see Liquidity Policy).

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual CFP investment liquidation test due (`cfp.investment_test.completed`) | Investment liquidation hierarchy (`cfp.liquidation_hierarchy`), AFS position set with liquidity classifications and stress haircuts (`position.liquidity_bucket`, `position.stress_haircut`), stress scenario set | Test results documented; gaps identified and remediated; results reported to ALCO and Board (`cfp.investment_test.completed`) | Annual minimum (enforced by `cfp.investment_test_due_at`) |
| Actual liquidity stress event declared (`liquidity.stress.declared`) | CFP level declaration (`cfp.level`), current AFS position set, liquidation hierarchy (`cfp.liquidation_hierarchy`) | CFP investment liquidation hierarchy activated; initial execution plan documented (`cfp.execution_plan_documented`, `cfp.level.changed`) | Initial execution plan within 1 business day (enforced by `cfp.execution_plan_due_at`) |
| Portfolio composition changes materially (new instrument type or significant size shift) | Updated position set, current liquidation hierarchy | Liquidation hierarchy reviewed and updated if needed (`cfp.liquidation_hierarchy` updated, `cfp.investment_test.completed` if material change) | Within 30 days of material change |
| CFP investment test gap identified (`cfp.investment_test.completed` with findings) | Test findings, gap description, remediation owner | Remediation plan created; gap tracked to closure (`finding.opened`, `finding.remediation.reported`) | Remediation plan within 10 business days of test completion |

**ALERTS/METRICS:** Alert fires if `cfp.investment_test_due_at` is overdue by more than 10 business days. Alert fires if execution plan is not documented within 1 business day of a stress declaration. Target: annual test completed and documented; zero stress declarations without a same-day or next-business-day execution plan.

---

## IP-18 — Policy Review, Amendments, and Version Control {#ip-18-policy-review-amendments-and-version-control}

**WHY (Reg cite):** [12 CFR §703.3](https://www.ecfr.gov/current/title-12/part-703/section-703.3) requires board approval of the investment policy at least annually (not to exceed 12 months between approvals) and requires the policy to be reviewed and updated when material regulatory changes occur. Full version history, redlines, and approval metadata are required for examiner review and internal governance.

**SYSTEM BEHAVIOR:** The system maintains full version history for the Investment Policy (`policy.document_version`, `policy.draft_redline`, `policy.change_summary`) with each version linked to its board approval event (`policy.board_approved_at`) and approver identity (`policy.approver_id`). Redlines between versions are stored and indexed. The annual review cycle is governed by [IP-01](#ip-01-policy-record-and-review-cycle); this control covers the amendment workflow and version control mechanics. Any proposed amendment is drafted as a redline (`policy.draft_redline`), reviewed by the CCO, and submitted for board approval (`policy.board_review.started`). Material regulatory changes to Part 703 or related guidance trigger an out-of-cycle review (`policy.amendment.proposed`) as soon as practicable. All prior versions are retained per the Record Retention Policy. Policy version records are write-restricted to Compliance; board approval events are recorded by the Board Secretary.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual review cycle initiated (`policy.board_review.started`) | Current policy version (`policy.document_version`), CCO review, proposed changes | Draft redline prepared; change summary documented (`policy.redline.recorded`, `policy.amendment.proposed`) | ≤ 12 months from prior approval (enforced by `policy.board_approval_due_at`) |
| Material Part 703 regulatory change identified (`regulatory.change_analysis.logged`) | Regulatory change description, impact assessment, CCO determination of materiality | Out-of-cycle amendment initiated; board notified (`policy.amendment.proposed`, `policy.material_change.flagged`) | As soon as practicable; before next affected trade |
| Board approves policy amendment (`policy.board.approved`) | Approved redline, board minutes reference, approver identity, effective date | New policy version published; prior version archived; `policy.next_review_at` reset (`policy.version.approved`, `policy.revision.published`) | At board meeting |
| Policy version archived | Prior version document, approval metadata | Prior version retained with full metadata; accessible for examiner review (`record.retained`) | Immediately on new version publication |

**ALERTS/METRICS:** Alert fires if a proposed amendment is not submitted for board approval within 30 days of CCO initiation. Target: 100% of policy versions with complete approval metadata and redline history; zero versions without a linked board approval event.

---

## Governance & Sign-Off {#governance}

| Role | Responsibility |
|---|---|
| **Patrick Wilson, Chief Compliance Officer** | Policy owner; approves all amendments; oversees control compliance |
| **Chief Financial Officer / Chief Investment Officer** | Day-to-day portfolio management; pre-purchase approvals; safekeeping oversight; CFO aggregate limit compliance |
| **ALCO / Investment Committee** | Monthly strategy development and monitoring; IRR simulation review; operating limit setting |
| **Board of Directors** | Annual policy approval; annual dealer and safekeeper list approval; quarterly investment report review |
| **Internal Audit / Supervisory Committee** | Independent testing of investment controls; findings reported to Board |

**Review cadence:** Annual board approval required; not to exceed 12 months between approvals. Out-of-cycle review required on material change to [12 CFR Part 703](https://www.ecfr.gov/current/title-12/part-703) or related NCUA guidance.

**Cross-references:**
- Derivatives Policy (Part 703 Subpart B) — separate document
- Retail Nondeposit Investment Products Policy — separate document
- Liquidity Policy (CFP governance, §741.12 enterprise program)
- Capitalization and Basel-II Standardized Approach Framework Policies
- Record Retention Policy (retention schedules)
- Third-Party Risk Policy (broker/custodian vendor risk beyond investment due diligence)

---

## Assumptions & Gaps {#assumptions}

- **Engineering vocabulary is provisional.** The investment-domain resources, fields, and events referenced throughout this document (e.g., `position.*`, `repo.*`, `trade.*`, `instrument_list.*`, `intermediary.*`, `safekeeping.*`, `security.*`, `portfolio.*`, `cfp.*`, `alm.*`, `credit_file.*`, `performance.*`, `limit_set.*`, `concentration.*`, `exposure.*`) are registered in `core-vocabulary.json` and used per the registered spelling. A small number of codes composed under the grammar rules — including `position.policy_tagged`, `position.maturity_date` (provisional per DESIGN_NOTES), `cfp.liquidation_hierarchy`, `cfp.execution_plan_documented`, and `trade.sod_blocked` — are provisional and will be confirmed by engineering before the next review.

- **Net Worth definition.** This policy uses "Net Worth" as the denominator for all percentage-of-Net-Worth limits, consistent with NCUA's definition for federal credit unions. Engineering must confirm the field mapping to the credit union's regulatory net worth calculation (undivided earnings + reserves) rather than GAAP equity. The `cu.unimpaired_capital_surplus` field in DESIGN_NOTES is the closest registered field; confirmation required.

- **CFO aggregate monthly limit amount.** PATRICK_NOTES specify that the CFO's aggregate purchase/sale authority within a calendar month is set in the authority matrix but do not specify the dollar amount. The policy references the authority matrix as the source of truth. The specific dollar amount must be set by the Board at the time of policy adoption and recorded in `authority_matrix.role_limits`.

- **Board reporting frequency — monthly vs. quarterly.** PATRICK_NOTES state the Board receives reports "at least quarterly (monthly preferred)." This policy implements quarterly as the regulatory minimum and monthly as the preferred cadence. The Timing Matrix reflects quarterly as the deadline; the system should be configured to generate monthly reports by default.

- **NCUA §741.12 asset-tier applicability.** The CFP requirement under §741.12 applies to credit unions based on asset tier. This policy assumes Pynthia Credit Union meets the applicable asset threshold. If the credit union is below the threshold, IP-17 should be scoped accordingly at the next review.

- **NCUA §741.3 state charter applicability.** AUTHORITY_HINTS reference §741.3 regarding nonconforming investments for state charters. Pynthia Credit Union is described as a credit union but charter type (federal vs. state) is not specified. If Pynthia is a state-chartered credit union, §741.3 special reserve treatment for nonconforming investments may apply and should be addressed in the permissible instruments appendix at the next review.

- **OTTI accounting standard.** This policy references OTTI under legacy ASC 320-10-35 guidance. If Pynthia Credit Union has adopted ASU 2016-13 (CECL), the OTTI framework is replaced by the allowance for credit losses (ACL) model. The CCO and CFO should confirm the applicable accounting standard and update IP-10 accordingly.

- **Permissible instruments appendix.** PATRICK_NOTES reference a "permissible instruments appendix" containing instrument-level parameters. This appendix is referenced in IP-03 and IP-05 but is maintained as a separate operational document linked to the `instrument_list` record. Engineering must confirm the document linkage mechanism.

- **Quality ratings appendix.** PATRICK_NOTES reference a "quality ratings appendix" mapping NRSRO rating categories to investment-grade thresholds. This appendix is referenced in IP-05 and is maintained as a separate operational document. The four highest NRSRO rating categories (AAA/Aaa/AAA through BBB/Baa/BBB) constitute the investment-grade floor.

- **Banker's acceptances.** The REFERENCE_POLICY includes banker's acceptances as a permissible money market instrument. PATRICK_NOTES do not include them in the permissible instruments table. This policy omits banker's acceptances from the allow-list pending CCO and CFO confirmation of Part 703 permissibility for Pynthia's charter type.

- **Mutual funds and stock holdings.** The REFERENCE_POLICY includes mutual funds made up of U.S. obligations and permissible stock holdings. PATRICK_NOTES do not include these categories. This policy omits them pending CCO confirmation that Pynthia does not hold or intend to hold such instruments; if applicable, the allow-list and diversification table should be updated.

- **Tax considerations for municipal securities.** The REFERENCE_POLICY addresses bank-qualified municipal bonds and tax deductibility of interest carry costs. As a credit union, Pynthia is generally tax-exempt; the tax-consideration analysis applicable to banks does not apply. The CCO should confirm that no tax-optimization objective applies to Pynthia's municipal investment strategy.

- **HTM transfer reason — tax law change.** The REFERENCE_POLICY lists "change in tax laws (not tax rates)" as a permissible HTM transfer reason. PATRICK_NOTES omit this reason. This policy follows PATRICK_NOTES (five permissible reasons). If Pynthia's auditors or regulators require the tax-law-change reason, it should be added at the next review.

- **Stress event execution plan — "1 business day" SLA.** The 1-business-day deadline for documenting an initial execution plan on actual stress declaration is an internal SLA inferred from PATRICK_NOTES. This should be confirmed by ALCO and the CCO as operationally achievable.
