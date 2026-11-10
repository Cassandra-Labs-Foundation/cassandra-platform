---
title: Charitable Donation Accounts Policy (Table-First, Design-Overlay v2)
owner: Patrick Wilson, Chief Compliance Officer
version: v1.0
effective: 2026-06-16
next_review: 2027-06-16
approvers:
  - Patrick Wilson, Chief Compliance Officer
tags: [Compliance, CDA, Charitable Donation Account, FCU Incidental Powers, 721.3]
---

## General Policy Statement

Pynthia Credit Union establishes and operates Charitable Donation Accounts (CDAs) under the FCU incidental-powers rule to support mission-aligned charitable giving. The credit union's posture is to preserve the §721.3(b)(2) safe harbor at all times: every CDA is held in a segregated, properly labeled custodial account or SPE/trust managed by a qualified trustee/manager under a written agreement carrying the required clauses; aggregate CDA book value is capped at no more than 5% of net worth; at least 51% of Total Return is distributed to Qualified Charities at least every five years and again at termination; and no CDA fees or expenses are paid to the credit union or its affiliates. This policy applies to all CDA structures and to the trustees, managers, staff, and committees that fund, monitor, distribute from, account for, and terminate CDAs. Failure of any §721.3(b)(2) condition forfeits Part 703 relief; the controls below are therefore mandatory and gating.

## Timing Matrix {#timing-matrix}

| Scenario | Trigger (human → event) | Deadline | Content Reference | Control |
|---|---|---|---:|---|
| Annual policy re-adoption | Board cycle opens for CDA policy | 12 months from last adoption | Board re-adoption resolution; expired policy blocks CDA actions | [CDA-01](#cda-01-governance-board-oversight) |
| Quarterly Board/ALCO packet | Quarter closes | 30 days after quarter-end | Cap utilization, performance, window coverage, exceptions | [CDA-01](#cda-01-governance-board-oversight) |
| Trustee/manager registration lapse | Registration lapse detected | 2 business days to Board | Escalation memo | [CDA-04](#cda-04-trustee-manager-qualification) |
| Cap breach cure | Aggregate book value exceeds 5% | 30 calendar days to cure | Cure plan + remediation | [CDA-06](#cda-06-funding-cap-monitoring-cure) |
| ≥51% distribution cadence | Five-year window or annual cadence reached | Default Dec 31 annually; at least every 5 years and at termination | ≥51% of Total Return to Qualified Charities | [CDA-08](#cda-08-charity-eligibility-giving-rules) |
| Quarterly accounting packet | Quarter closes | 30 days after quarter-end | GAAP entries, reconciliations, 789H mapping | [CDA-09](#cda-09-accounting-reporting-records) |
| Vendor material issue | Material TPRM issue identified | 2 business days to escalate | Escalation record | [CDA-10](#cda-10-third-party-risk-management) |
| Termination closeout | Termination approved | ≥51% closing distribution; report within 30 days post-close | Final accounting + termination report | [CDA-12](#cda-12-termination) |
| Affiliate-fee conflict | Conflict identified | 5 business days to escalate | Payee blocklist + conflict escalation | [CDA-13](#cda-13-conflicts-affiliate-fees) |

## CDA-01 — Governance & Board Oversight {#cda-01-governance-board-oversight}

**WHY (Reg cite):** A CDA is permissible only as an exercise of FCU incidental powers under [12 CFR §721.3(b)(2)](https://www.ecfr.gov/current/title-12/section-721.3#p-721.3(b)(2)); Board adoption, structure/vendor/strategy approval, and ongoing oversight are how the credit union demonstrates the conditions are met and Part 703 relief is properly claimed.

**SYSTEM BEHAVIOR:** The Board adopts and annually re-adopts this policy and approves CDA structures, vendors, strategy/limits, and distributions. A quarterly Board/ALCO packet summarizing cap utilization, performance, five-year window coverage, and exceptions is compiled and issued within 30 days of quarter-end. If the policy lapses, all CDA actions (funding, trades, distributions) are blocked until re-adoption is recorded. Policy version, expiry, and the readoption flag are write-restricted to Compliance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual policy review window opens (`cda.audit_cycle_opened`) | Policy version (`cda.policy_version`), expiry (`cda.policy_expiry_at`), prior board resolution (`board.resolution_id`) | Board re-adoption recorded (`cda.board_decision_recorded`) | 12 months (enforced by `cda.policy_review_due`) |
| Policy lapses without readoption (`cda.policy_expired`) | Policy expiry (`cda.policy_expiry_at`), actions-blocked flag (`cda.actions_blocked`) | CDA actions blocked + escalation (`cda.board_escalation_issued`) | Immediate on expiry (enforced by `cda.policy_review_due`) |
| Quarter closes (`cda.quarter_closed`) | Cap utilization (`cda.aggregate_book_value`, `cda.net_worth`), performance (`cda.portfolio_performance`), window coverage (`cda.window_coverage_pct`), exceptions register | Board/ALCO packet issued (`cda.board_packet_issued`) | 30 days post-quarter (enforced by `cda.board_packet_due_at`) |

**ALERTS/METRICS:** Alert on policy review aging approaching 12 months and on any quarter where the board packet is not issued by day 30; target zero CDA actions attempted while policy is expired.

## CDA-02 — Definitions & Central Glossary {#cda-02-definitions-central-glossary}

**WHY (Reg cite):** §721.3(b)(2) defines the operative terms—Qualified Charity, Total Return, Affiliate—on which the cap, distribution, and fee conditions depend ([12 CFR §721.3(b)(2)](https://www.ecfr.gov/current/title-12/section-721.3#p-721.3(b)(2))); consistent definitions drive correct validations and calculations.

**SYSTEM BEHAVIOR:** A central glossary maintains canonical definitions for CDA, Qualified Charity, Total Return, Distribution in Kind, Affiliate, Net Worth, and Book Value, each with a regulatory citation and version. These definitions power downstream validations (charity eligibility, fee screening) and calculations (cap test, distribution percentage). Glossary changes are proposed, attested, and versioned; the glossary term set and version are write-restricted to Compliance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Glossary term change proposed (`cda.glossary_change_proposed`) | Glossary term (`cda.glossary_term`), citation (`cda.glossary_citation`), prior version (`cda.glossary_version`) | Updated glossary published + attested (`cda.glossary_updated`, `cda.glossary_attested`) | At change; reviewed annually with policy (enforced by `cda.policy_review_due`) |

**ALERTS/METRICS:** Alert when a validation or calculation references a glossary term whose version differs from the active glossary version; target zero stale-definition references.

## CDA-03 — Structure & Segregation {#cda-03-structure-segregation}

**WHY (Reg cite):** §721.3(b)(2)(i) requires the CDA to be a segregated account or held by a regulated trustee/manager and properly designated as a charitable donation account ([12 CFR §721.3(b)(2)](https://www.ecfr.gov/current/title-12/section-721.3#p-721.3(b)(2))); mislabeling or commingling forfeits the safe harbor.

**SYSTEM BEHAVIOR:** Before first funding, the credit union selects the CDA structure (segregated custodial account or SPE/trust), labels it "Charitable Donation Account," and assembles an evidence packet (structure selection, account label, custodial statement). Funding is gated until the evidence packet is filed and the structure is confirmed. Structure type and account label are write-restricted to Compliance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Structure selected and evidence assembled (`cda.evidence_packet_filed`) | Structure type (`cda.structure_type`), account label (`cda.account_label`), structure-selected flag (`cda.structure_selected`), custodial statement (`cda.custodian_statement`) | Evidence packet filed; funding gate set (`cda.evidence_packet_filed`, `cda.funding_gate_evaluated`) | Before first funding (gated by `cda.funding_requested`) |

**ALERTS/METRICS:** Alert on any funding request where the structure-selected flag or account label is absent; target zero fundings against an unlabeled or unsegregated account.

## CDA-04 — Trustee & Manager Qualification {#cda-04-trustee-manager-qualification}

**WHY (Reg cite):** §721.3(b)(2)(ii) limits trustees/managers to regulated trustees and, for non-CU discretionary managers, SEC-registered investment advisers or OCC-regulated entities ([12 CFR §721.3(b)(2)](https://www.ecfr.gov/current/title-12/section-721.3#p-721.3(b)(2))); a registration lapse jeopardizes the relief.

**SYSTEM BEHAVIOR:** Only regulated trustees and qualified non-CU discretionary managers (SEC-registered investment adviser or OCC-regulated) are onboarded; qualification is validated at onboarding and reviewed annually using registration evidence. A detected registration lapse is escalated to the Board within 2 business days. Vendor qualification status and registration evidence are write-restricted to Compliance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Vendor onboarding begins (`cda.vendor_onboarding_started`) | Regulator (`cda.vendor_regulator`), registration status (`cda.vendor_registration_status`), registration evidence (`cda.vendor_registration_evidence`) | Vendor qualified flag set (`cda.vendor_qualified`) | Before assignment to a CDA |
| Annual qualification review due (`cda.vendor_review_completed`) | Registration status (`cda.vendor_registration_status`), revalidation flag (`cda.vendor_revalidated`) | Review completed (`cda.vendor_review_completed`) | Annually (enforced by `cda.vendor_review_due`) |
| Registration lapse detected (`cda.vendor_issue_flagged`) | Registration-lapsed flag (`cda.vendor_registration_lapsed`), issue details (`cda.vendor_issue_details`) | Board escalation issued (`cda.board_escalation_issued`) | 2 business days (enforced by `cda.conflict_escalation_due_at`) |

**ALERTS/METRICS:** Alert on registration evidence aging past the annual review window and on any open registration-lapse escalation older than 2 business days; target zero CDAs managed by an unqualified vendor.

## CDA-05 — Written Agreement (Required Clauses A–D) {#cda-05-written-agreement-required-clauses}

**WHY (Reg cite):** §721.3(b)(2)(v) and the agreement conditions require the CDA written agreement to name Qualified Charities, state investment strategy/risk, require GAAP accounting, and set distribution frequency ([12 CFR §721.3(b)(2)](https://www.ecfr.gov/current/title-12/section-721.3#p-721.3(b)(2))); a missing clause breaks the safe harbor.

**SYSTEM BEHAVIOR:** Funding is blocked unless the written agreement is validated to contain clause (A) named Qualified Charities, clause (B) investment strategy/risk, clause (C) GAAP accounting requirement, and clause (D) distribution frequency per §721.3(b)(2)(v). Agreement amendments require Board re-approval before taking effect. Agreement clause fields and the validated flag are write-restricted to Compliance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Agreement submitted for validation (`cda.agreement_submitted`) | Distribution clause (`cda.agreement_distribution_clause`), strategy clause (`cda.agreement_strategy_clause`), GAAP clause (`cda.agreement_gaap_clause`), validated flag (`cda.agreement_validated`) | Agreement validated; funding gate updated (`cda.agreement_validated`, `cda.funding_gate_evaluated`) | Before first funding (gated by `cda.funding_requested`) |
| Amendment proposed (`cda.agreement_amendment_proposed`) | Amendment redline (`cda.agreement_redline`), affected clauses (`cda.agreement_distribution_clause`, `cda.agreement_strategy_clause`, `cda.agreement_gaap_clause`) | Board decision recorded (`cda.board_decision_recorded`) | Before amendment effective |

**ALERTS/METRICS:** Alert on any funding request where one or more A–D clauses are unvalidated; target zero fundings against an agreement missing a required clause.

## CDA-06 — Funding Cap (Monitoring & Cure) {#cda-06-funding-cap-monitoring-cure}

**WHY (Reg cite):** §721.3(b)(2)(iii) caps aggregate CDA book value at no more than 5% of net worth and provides a cure period for breaches ([12 CFR §721.3(b)(2)](https://www.ecfr.gov/current/title-12/section-721.3#p-721.3(b)(2))); exceeding the cap without timely cure forfeits Part 703 relief.

**SYSTEM BEHAVIOR:** Aggregate CDA book value is held at no more than 5% of net worth with a default internal buffer of 4%. Cap tests run monthly and at quarter-end; a projected breach blocks new funding, and any actual breach is cured within 30 calendar days via a tracked cure plan. Cap buffer, excess amount, and cure status are write-restricted to Compliance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Monthly/quarter-end cap test scheduled (`cda.cap_test_scheduled`) | Aggregate book value (`cda.aggregate_book_value`), net worth (`cda.net_worth`), buffer pct (`cda.cap_buffer_pct`) | Cap test completed + certified (`cda.cap_test_completed`, `cda.cap_certified`) | Monthly and at quarter-end (enforced by `cda.cap_test_due_at`) |
| Funding requested near/over cap (`cda.funding_requested`) | Funding amount (`cda.funding_amount`), projected aggregate (`cda.aggregate_book_value`), net worth (`cda.net_worth`) | Funding blocked on projected breach (`cda.funding_gate_evaluated`) | At funding request |
| Cap breach detected (`cda.cap_breached`) | Excess amount (`cda.cap_excess_amount`), cure plan (`cda.cure_plan`) | Cure executed + breach cured (`cda.cap_breach_cured`) | 30 calendar days (enforced by `cda.cap_cure_due_at`) |

**ALERTS/METRICS:** Alert when utilization crosses the 4% buffer and when an open cap-cure task ages past 30 days; target zero uncured cap breaches.

## CDA-07 — Investment Strategy & Risk Limits {#cda-07-investment-strategy-risk-limits}

**WHY (Reg cite):** Although [12 CFR Part 703](https://www.ecfr.gov/current/title-12/part-703) limits do not apply to a compliant CDA per §721.3(b)(2), the Board applies prudent overlays as required by the agreement's strategy/risk clause under [12 CFR §721.3(b)(2)](https://www.ecfr.gov/current/title-12/section-721.3#p-721.3(b)(2)) and safe-and-sound governance.

**SYSTEM BEHAVIOR:** Board-approved prudent overlays (single-issuer, sector, liquidity, volatility, drawdown) apply even though Part 703 limits do not. A pre-trade check evaluates each proposed trade against the overlays, and a monthly post-trade check confirms continued compliance. Overlay limits and strategy parameters are write-restricted to Compliance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Trade proposed (`cda.trade_proposed`) | Trade details (`cda.trade_details`), overlay limits (`cda.overlay_limits`), strategy limits (`cda.strategy_limits`) | Pre-trade check completed (`cda.pretrade_check_completed`) | Before execution |
| Monthly post-trade window opens (`cda.posttrade_check_scheduled`) | Portfolio composition (`cda.portfolio_composition`), overlay limits (`cda.overlay_limits`) | Post-trade check completed (`cda.posttrade_check_completed`) | Monthly (enforced by `cda.posttrade_due_at`) |

**ALERTS/METRICS:** Alert on any pre-trade overlay breach blocking a trade and on overdue monthly post-trade checks; track count of overlay exceptions per quarter with a target of zero unremediated breaches.

## CDA-08 — Charity Eligibility & Giving Rules {#cda-08-charity-eligibility-giving-rules}

**WHY (Reg cite):** §721.3(b)(2)(iv)–(v) require distributions only to Qualified Charities and at least 51% of Total Return at least every five years and at termination ([12 CFR §721.3(b)(2)](https://www.ecfr.gov/current/title-12/section-721.3#p-721.3(b)(2))); a Qualified Charity is defined by [26 U.S.C. §501(c)(3)](https://www.law.cornell.edu/uscode/text/26/501) (and (c)(19) where applicable).

**SYSTEM BEHAVIOR:** Each donee's EIN and IRS §501(c)(3)/(c)(19) status are validated before distribution, and the rolling five-year window is tracked. At least 51% of Total Return is distributed to Qualified Charities at least every five years and at termination, with a default annual cadence by December 31. A distribution to an unvalidated donee is blocked. Donee validation status and window coverage are write-restricted to Compliance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Distribution proposed (`cda.distribution_proposed`) | Donee EIN (`cda.donee_ein`), IRS status (`cda.donee_irs_status`), validated flag (`cda.donee_validated`), proposed amount (`cda.distribution_amount`), cumulative Total Return (`cda.total_return_cumulative`) | Distribution executed to Qualified Charity (`cda.distribution_executed`) | Default Dec 31 annually; at least every 5 years (enforced by `cda.distribution_due_at`) |
| Five-year distribution cycle opens (`cda.distribution_cycle_opened`) | Window close date (`cda.window_close_at`), cumulative distributions (`cda.distributions_cumulative`), shortfall (`cda.distribution_shortfall`) | Window coverage updated; shortfall alert if applicable (`cda.distribution_window_alert`) | Within the rolling 5-year window (enforced by `cda.distribution_due_at`) |

**ALERTS/METRICS:** Alert when five-year window coverage falls below the ≥51% threshold or the window-close date approaches with a shortfall; target zero distributions to unvalidated donees and zero missed five-year windows.

## CDA-09 — Accounting, Reporting & Records {#cda-09-accounting-reporting-records}

**WHY (Reg cite):** §721.3(b)(2) requires GAAP accounting for the CDA under the written agreement ([12 CFR §721.3(b)(2)](https://www.ecfr.gov/current/title-12/section-721.3#p-721.3(b)(2))); accurate books and Call Report mapping support the cap test and Total Return calculation.

**SYSTEM BEHAVIOR:** GAAP entries are enforced, monthly reconciliations are performed, and Call Report Account 789H mapping is maintained. The quarterly Board/ALCO accounting packet is issued within 30 days of quarter-end. GL balances, reconciliation status, and the 789H mapping are write-restricted to Compliance and Finance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Month closes (`cda.month_closed`) | GL balances (`cda.gl_balances`), custodial statement (`cda.custodian_statement`) | Reconciliation completed (`cda.reconciliation_completed`) | Monthly (enforced by `cda.reconciliation_due_at`) |
| Call Report cycle opens (`cda.call_report_cycle_opened`) | 789H mapping (`cda.account_789h_mapping`), GL balances (`cda.gl_balances`) | Mapping recorded (`cda.call_report_mapped`) | Per Call Report cycle |
| Quarter closes (`cda.quarter_closed`) | Portfolio performance (`cda.portfolio_performance`), GL balances (`cda.gl_balances`), preparer (`cda.preparer_id`) | Quarterly accounting packet issued (`cda.board_packet_issued`) | 30 days post-quarter (enforced by `cda.board_packet_due_at`) |

**ALERTS/METRICS:** Alert on aged unreconciled items and on a quarterly packet not issued by day 30; target zero GAAP exceptions and zero 789H mapping mismatches.

## CDA-10 — Third-Party Risk Management {#cda-10-third-party-risk-management}

**WHY (Reg cite):** §721.3(b)(2)(ii) requires CDA trustees/managers to remain qualified throughout the engagement ([12 CFR §721.3(b)(2)](https://www.ecfr.gov/current/title-12/section-721.3#p-721.3(b)(2))); CDA-specific life-cycle diligence preserves that qualification and the integrity of the segregated assets.

**SYSTEM BEHAVIOR:** Life-cycle CDA-specific due diligence runs on trustees/managers covering regulatory status, financials, SOC/ISO, BCP/DR, and fees/conflicts, with annual review. Contracts require a 90-day termination provision and asset-transfer steps. Material issues are escalated within 2 business days. Vendor due-diligence file and contract-validation flags are write-restricted to Compliance. (CDA-specific diligence only; enterprise vendor management lives in the Third-Party Risk Policy.)

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Vendor due diligence performed (`cda.vendor_dd_completed`) | DD file (`cda.vendor_dd_file`), financials (`cda.vendor_financials`), SOC/ISO (`cda.vendor_soc_iso`), BCP/DR (`cda.vendor_bcp_dr`), fee disclosures (`cda.vendor_fee_disclosures`) | DD completed (`cda.vendor_dd_completed`) | At onboarding |
| Contract drafted (`cda.vendor_contract_drafted`) | Termination clause (`cda.contract_termination_clause`), transfer steps (`cda.contract_transfer_steps`), validated flag (`cda.vendor_contract_validated`) | Contract clauses verified (`cda.vendor_contract_drafted`) | Before execution; 90-day termination required |
| Material vendor issue identified (`cda.vendor_issue_flagged`) | Issue details (`cda.vendor_issue_details`) | Board escalation issued (`cda.board_escalation_issued`) | 2 business days (enforced by `cda.conflict_escalation_due_at`) |

**ALERTS/METRICS:** Alert on annual vendor review aging and on open material-issue escalations older than 2 business days; target zero contracts lacking a 90-day termination/asset-transfer clause.

## CDA-11 — Internal Controls & Testing {#cda-11-internal-controls-testing}

**WHY (Reg cite):** Sustained compliance with the §721.3(b)(2) conditions—cap, distribution cadence, and fee prohibition—depends on dual control, segregation of duties, and independent testing ([12 CFR §721.3(b)(2)](https://www.ecfr.gov/current/title-12/section-721.3#p-721.3(b)(2))).

**SYSTEM BEHAVIOR:** Distributions at or above $5,000 require dual approval; segregation of duties is enforced; automated cap checks run continuously; valuation reviews occur quarterly; and Internal Audit tests the program annually with tracked remediation. Audit findings and remediation ownership are write-restricted to Compliance and Internal Audit. A distribution below the dual-approval threshold requires single approval but is still logged.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Distribution at/above $5,000 initiated (`cda.distribution_proposed`) | Distribution amount (`cda.distribution_amount`), approver (`cda.approver_id`) | Dual approval recorded (`cda.dual_approval_recorded`) | Before execution |
| Quarterly valuation review window opens (`cda.quarter_closed`) | Independent pricing (`cda.independent_pricing`), portfolio composition (`cda.portfolio_composition`) | Valuation review completed (`cda.valuation_review_completed`) | Quarterly (enforced by `cda.posttrade_due_at`) |
| Annual Internal Audit cycle opens (`cda.audit_cycle_opened`) | Audit finding (`cda.audit_finding`), remediation owner (`cda.remediation_owner`) | Audit report issued; findings logged (`cda.audit_report_issued`, `cda.audit_finding_logged`) | Annually (enforced by `cda.audit_due_at`) |
| Audit remediation tracked (`cda.audit_finding_logged`) | Remediation owner (`cda.remediation_owner`), due date (`cda.remediation_due_at`) | Remediation closed (`cda.remediation_closed`) | Per finding (enforced by `cda.remediation_due_at`) |

**ALERTS/METRICS:** Alert on any ≥$5,000 distribution lacking dual approval, on overdue quarterly valuation reviews, and on aged open audit findings; target zero SoD violations.

## CDA-12 — Termination {#cda-12-termination}

**WHY (Reg cite):** §721.3(b)(2)(vi) requires that on termination the CDA satisfy the ≥51% closing distribution and that remaining assets be received in cash or, in kind, only if otherwise permissible FCU investments ([12 CFR §721.3(b)(2)](https://www.ecfr.gov/current/title-12/section-721.3#p-721.3(b)(2))); permissibility of in-kind assets is judged against [12 CFR Part 703](https://www.ecfr.gov/current/title-12/part-703).

**SYSTEM BEHAVIOR:** At termination, the ≥51% closing distribution is satisfied and remaining assets are received in cash or in-kind only where the in-kind asset is an otherwise permissible FCU investment, determined by a documented permissibility check. A termination report is issued within 30 days post-close. Termination approval, final accounting, and permissibility determination are write-restricted to Compliance. An in-kind transfer of a non-permissible asset is blocked and must be liquidated to cash before receipt.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Termination approved (`cda.termination_approved`) | Distribution shortfall (`cda.distribution_shortfall`), cumulative Total Return (`cda.total_return_cumulative`) | Closing distribution executed (`cda.closing_distribution_executed`) | At termination (≥51% closing distribution) |
| In-kind transfer proposed (`cda.inkind_transfer_proposed`) | Asset details (`cda.asset_details`), permissibility determination (`cda.permissibility_determination`), evaluated flag (`cda.inkind_transfer_evaluated`) | In-kind transfer decisioned (`cda.inkind_transfer_proposed`) | At close; blocked if non-permissible |
| Account closed (`cda.account_closed`) | Final accounting (`cda.final_accounting`) | Termination report issued (`cda.termination_report_issued`) | 30 days post-close (enforced by `cda.termination_report_due_at`) |

**ALERTS/METRICS:** Alert if the closing distribution falls short of 51% or the termination report is not issued within 30 days; target zero in-kind receipts of non-permissible assets.

## CDA-13 — Conflicts & Affiliate Fees {#cda-13-conflicts-affiliate-fees}

**WHY (Reg cite):** §721.3(b)(2) prohibits payment of CDA fees/expenses to the credit union or its affiliates and defines Affiliate accordingly ([12 CFR §721.3(b)(2)](https://www.ecfr.gov/current/title-12/section-721.3#p-721.3(b)(2))); such payments distort Total Return and break the safe harbor.

**SYSTEM BEHAVIOR:** Payment of any CDA fee or expense to the credit union or its affiliates is blocked via a payee blocklist, preserving the Total Return definition, with a quarterly fee review. Identified conflicts are escalated within 5 business days. The payee blocklist and conflict determinations are write-restricted to Compliance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Fee payment proposed (`cda.fee_payment_proposed`) | Fee amount (`cda.fee_amount`), payee (`cda.fee_payee`) | Fee screen completed; affiliate payment blocked (`cda.fee_screen_completed`) | At payment request |
| Quarterly fee review window opens (`cda.quarter_closed`) | Fee payee list (`cda.fee_payee`), fee amounts (`cda.fee_amount`) | Fee review completed (`cda.fee_review_completed`) | Quarterly (enforced by `cda.board_packet_due_at`) |
| Affiliate-fee conflict identified (`cda.fee_conflict_flagged`) | Conflict details (`cda.conflict_details`) | Conflict escalated (`cda.conflict_escalated`) | 5 business days (enforced by `cda.conflict_escalation_due_at`) |

**ALERTS/METRICS:** Alert on any attempted affiliate-payee fee payment and on open conflict escalations older than 5 business days; target zero affiliate fees charged to a CDA.

## CDA-14 — Communications & Accessibility {#cda-14-communications-accessibility}

**WHY (Reg cite):** Public CDA web pages and announcements must be accessible under the ADA ([28 CFR Part 36](https://www.ecfr.gov/current/title-28/part-36)); inaccessible public communications create legal and reputational exposure.

**SYSTEM BEHAVIOR:** A pre-publication ADA/WCAG checklist is applied to CDA web pages and press, requiring both Marketing and Compliance approval, with artifacts archived. Publication is gated on completion of the checklist and approvals. The WCAG checklist result and approval records are write-restricted to Compliance and Marketing.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| CDA communication drafted (`cda.communication_drafted`) | Communication draft (`cda.communication_draft`), WCAG checklist (`cda.wcag_checklist`) | Communication approved (`cda.communication_approved`) | Before publication |
| Communication published (`cda.communication_published`) | Approved draft (`cda.communication_draft`), archive flag (`cda.communication_archived`) | Publication logged + archived (`cda.communication_published`) | At publication |

**ALERTS/METRICS:** Alert on any publication lacking a completed WCAG checklist or dual Marketing/Compliance approval; target zero unaccessible CDA pages in production.

## Governance & Sign-Off {#governance}

- **Owner:** Patrick Wilson, Chief Compliance Officer — accountable for CDA program governance, the controls above, and centralizing oversight across CFO/Controller, ALCO, TPRM, Legal, and the Board.
- **Approver:** Patrick Wilson, Chief Compliance Officer.
- **Required participants:** CFO/Controller (cap test inputs, GAAP, 789H mapping), ALCO (quarterly review), TPRM (vendor diligence), Legal (agreement clauses, structure), and the Board (adoption, structure/vendor/strategy/distribution approval, escalations).
- **Review cadence:** Board adopts and re-adopts this policy annually; expired policy blocks CDA actions (see [CDA-01](#cda-01-governance-board-oversight)). Quarterly Board/ALCO reporting within 30 days of quarter-end (see [CDA-01](#cda-01-governance-board-oversight), [CDA-09](#cda-09-accounting-reporting-records)).
- **Cross-refs:** Investment Policy (Part 703 context), Third-Party Risk Policy (vendor management beyond CDA-specific diligence), Capitalization Policy and Record Retention Policy (enterprise reporting and Call Report production beyond 789H mapping), Compliance Policy and E-Commerce Policy (general website accessibility).

## Assumptions & Gaps {#assumptions}

- **Engineering vocabulary is provisional.** The `cda.*` fields, events, and timers referenced throughout the control overlays are present in DESIGN_NOTES (Cassandra Banking Core, `cda` entity and registered CDA task/timer codes), so they are treated as registered. Where a control referenced a concept without a dedicated registered code, the nearest registered CDA field/event/timer was reused. Any residual codes will be confirmed by engineering before the next review.
- **Reused timers for quarterly fee/valuation cadence.** CDA-11's quarterly valuation review and CDA-13's quarterly fee review have no dedicated quarterly timer in DESIGN_NOTES; the registered `cda.posttrade_due_at` (monthly post-trade) and `cda.board_packet_due_at` (quarterly packet) timers are reused as the enforcing cadence. Engineering to confirm whether a distinct quarterly valuation/fee timer should be registered.
- **Charter applicability.** This policy assumes Pynthia Credit Union is a federal credit union to which 12 CFR §721.3(b)(2) and the Part 703 relief apply. If the credit union is state-chartered, applicable state CDA authority and any NCUA Part 741 incorporation must be confirmed.
- **Qualified Charity scope.** PATRICK_NOTES reference both §501(c)(3) and §501(c)(19) status; the policy validates both. Confirm whether (c)(19) (veterans' organizations) donees are in scope for Pynthia's program or whether eligibility should be limited to (c)(3).
- **Dual-approval threshold.** The $5,000 dual-approval threshold for distributions (CDA-11) is taken from PATRICK_NOTES; confirm this matches the credit union's broader authority matrix and any Board-set limits.
- **Internal cap buffer.** The 4% default internal buffer below the 5% statutory cap (CDA-06) is taken from PATRICK_NOTES as a default; confirm the Board-approved buffer value before activation.
- **In-kind permissibility determination.** CDA-12 relies on a documented permissibility check against Part 703 to accept in-kind assets at termination; the criteria and approver for that determination should be confirmed with Legal and Finance.
