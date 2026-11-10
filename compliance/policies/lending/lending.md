```yaml
---
title: Lending Policy (Table-First, Design-Overlay v3)
owner: Patrick Wilson, Chief Compliance Officer
version: v1.0
effective: 2026-07-01
next_review: 2027-07-01
approvers:
  - Patrick Wilson, Chief Compliance Officer
tags: [Compliance, Lending, Fair Lending, ECOA, HMDA, TILA, OFAC, Insider Lending]
---
```

## General Policy Statement

Pynthia Credit Union extends credit on a safe-and-sound, non-discriminatory basis across all products and channels — including direct origination, fintech-partner programs, and white-label/BaaS arrangements. Every acceptance and denial decision must rest exclusively on neutral creditworthiness factors; steering, discriminatory product placement, and preferential insider terms are prohibited. This policy establishes the minimum controls governing credit-box integrity, underwriting standards, adverse-action notice, pricing, collateral valuation, exceptions, recordkeeping, OFAC screening, and fair-lending monitoring. It also serves as the engineering design specification for Pynthia's lending systems and partner integrations; each control overlay below defines the system behavior, event vocabulary, and operational metrics required to implement and evidence the control.

---

## Timing Matrix {#timing-matrix}

| Scenario | Trigger (human → event) | Deadline | Content Reference | Control |
|---|---|---:|---|---|
| Completed application — approve, deny, or counteroffer | Application complete and decisioned (`loan_application.decisioned`) | 30 calendar days from completion | ECOA/Reg B §1002.9(a)(1) | [LP-03](#lp-03-applications-acceptance--denial-standards) |
| Adverse action on existing account | Adverse action decided on open loan account (`loan_account.adverse_action.decided`) | 30 calendar days | ECOA/Reg B §1002.9(a)(2) | [LP-07](#lp-07-adverse-action--notifications) |
| Counteroffer not accepted — AAN required | Counteroffer expires without acceptance (`loan_application.counteroffer.expired`) | 90 days after counteroffer date | ECOA/Reg B §1002.9(a)(1)(iv) | [LP-07](#lp-07-adverse-action--notifications) |
| Oral adverse decision — written AAN follow-up | Oral adverse decision logged (`loan_application.oral_adverse_decision`) | 30 calendar days | ECOA/Reg B §1002.9(a) | [LP-07](#lp-07-adverse-action--notifications) |
| First-lien dwelling — appraisal copy delivery | Appraisal ordered (`appraisal.ordered`) | Promptly; no later than 3 business days before consummation | ECOA/Reg B §1002.14(a)(1) | [LP-06](#lp-06-appraisals-valuations--collateral) |
| ATR checklist — must complete before docs print | Loan application decisioned as approve (`loan_application.decisioned`) | Before closing documents generated | TILA/Reg Z §1026.43(c) | [LP-05](#lp-05-atrqm--mortgage-underwriting) |
| HPML test — covered mortgage before docs | Rate locked (`loan_pricing.locked`) | Before closing documents generated | TILA/Reg Z §1026.35 | [LP-10](#lp-10-pricing-rate-sheets--hpml-controls) |
| Rate sheet refresh — weekly APOR tie | Weekly calendar trigger | Every 7 days | TILA/Reg Z §1026.35(a)(2) | [LP-10](#lp-10-pricing-rate-sheets--hpml-controls) |
| Credit report freshness check | Application decisioned (`loan_application.decisioned`) | Report ≤ 6 months old at decision | Internal standard | [LP-04](#lp-04-credit-scoring--adverse-credit-history) |
| OFAC screen — all new parties before closing | Loan party added (`loan_party.added`) | Before funding | 31 CFR Ch. V | [LP-11](#lp-11-ofac--sanctions-gate) |
| Exception decided — must precede closing | Exception case opened (`loan_exception.case.opened`) | Before closing | Internal standard | [LP-08](#lp-08-exceptions-mitigating-factors--overrides) |
| Credit-package retention clock set | Loan application final action recorded (`application.final_action.recorded`) | Retention ≥ 25 months from action date | ECOA/Reg B §1002.12(b) | [LP-09](#lp-09-documentation-recordkeeping--retention) |
| Credit-box annual review | Calendar anniversary of last review (`credit_box.review.completed`) | ≤ 12 months | Internal standard | [LP-02](#lp-02-product-eligibility--prohibited-practices) |
| Governance mapping update — new product/program | New lending program activated (`lending_program.activated`) | Within 30 days | Internal standard | [LP-01](#lp-01-governance-roles--program-scope) |
| Fair-lending risk assessment | Annual calendar trigger | ≤ 12 months | ECOA/Reg B; FHA; NCUA §701.31 | [LP-13](#lp-13-fair-lending-risk-assessment--monitoring) |
| Insider flag — must resolve before decision | Insider flag set on application (`loan_application.insider.flagged`) | Before credit decision | NCUA Parts 701, 741 | [LP-14](#lp-14-insider-lending--employee-conflicts) |
| Pricing exception — periodic demographic review | Pricing exception period closed (`pricing.exception_period.closed`) | Per exception-review schedule | ECOA/Reg B §1002.6 | [LP-10](#lp-10-pricing-rate-sheets--hpml-controls) |
| Steering review — product-menu deployment | Product menu deployed (`product_menu.deployed`) | Before go-live | TILA/Reg Z §1026.36(e); ECOA | [LP-12](#lp-12-prequalification-marketing--steering-controls) |

---

## LP-01 — Governance, Roles & Program Scope {#lp-01-governance-roles--program-scope}

**WHY (Reg cite):** [ECOA/Reg B 12 CFR §1002.4](https://www.ecfr.gov/current/title-12/section-1002.4) requires that no creditor discriminate; effective governance and clear role assignment are the foundational controls that make every downstream lending control enforceable. [NCUA 12 CFR Parts 701 and 741](https://www.ecfr.gov/current/title-12/part-701) impose safety-and-soundness expectations that require documented authority structures and program oversight for all credit activities, including BaaS and fintech-partner programs.

**SYSTEM BEHAVIOR:** The system maintains a machine-readable RACI registry (`policy.raci_registry`) that maps every lending control in this policy to an owner role. Each lending program — direct, fintech-partner, and white-label/BaaS — is tagged in `lending_program` with channel, partner ID, and scope flags. Credit-parameter and pricing changes are write-restricted to roles authorized in the authority matrix; any change request must carry an `authority.matrix_entry` reference and be approved before the configuration change is applied. The policy itself is reviewed at least annually; when a new product or program is activated, the governance mapping must be updated within 30 days. The Chief Compliance Officer (Fair Lending Officer) is the designated policy owner; the Chief Lending Officer, Loan Operations, underwriting, BSA/Compliance, and the Board Lending/Fair Lending Committee are required participants. Write access to `credit_config` and `loan_pricing` parameters is restricted to authorized Compliance and Credit Administration roles.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---:|---|
| New lending program activated (`lending_program.activated`) | Program channel (`lending_program.channel`), partner ID (`lending_program.partner_id`), scope flags (`lending_program.id`) | Governance mapping record (`lending_program.governance.mapped`) | 30 days of activation (internal SLA; enforced by `lending_program.governance_due_at`) |
| Annual policy review cycle opens (calendar trigger) | Current policy version (`policy.document_version`), RACI registry (`policy.raci_registry`), prior review date (`policy.next_review_at`) | Policy review completed (`policy.review.completed`), updated version published (`policy.version.published`) | ≤ 12 months from last review (enforced by `policy.review_due_at`) |
| Credit-parameter or pricing change requested (`credit_config.change.requested`) | Change diff (`credit_config.diff`), authority matrix entry (`authority.matrix_entry`), approver ID (`credit_config.approval_id`) | Config change approved and applied (`credit_config.changed`) | Before configuration is applied — no deadline, but change is blocked until approval recorded |
| Authority matrix updated (`authority.matrix.updated`) | Change rationale (`authority.change_rationale`), matrix entry (`authority.matrix_entry`) | Matrix change logged (`authority.matrix_change.proposed` → `authority.matrix.updated`) | Immediately on change |

**ALERTS/METRICS:** Alert when `lending_program.governance_due_at` is within 5 business days and mapping is not yet recorded. Alert when `policy.review_due_at` is within 30 days and review is not completed. Target zero unapproved `credit_config.changed` events (i.e., every change must have a preceding `credit_config.change.requested` with an approval ID).

---

## LP-02 — Product Eligibility & Prohibited Practices {#lp-02-product-eligibility--prohibited-practices}

**WHY (Reg cite):** [NCUA 12 CFR §701.21](https://www.ecfr.gov/current/title-12/part-701/section-701.21) and safety-and-soundness expectations under [NCUA Parts 701 and 741](https://www.ecfr.gov/current/title-12/part-701) prohibit credit unions from offering products that are predatory or inconsistent with member welfare. [ECOA/Reg B 12 CFR §1002.4](https://www.ecfr.gov/current/title-12/section-1002.4) and [FHA 42 USC §3605](https://www.law.cornell.edu/uscode/text/42/3605) require that product eligibility criteria not operate as proxies for prohibited bases.

**SYSTEM BEHAVIOR:** The system maintains a machine-readable credit box per product (`credit_box.definition`, `credit_box.version`) specifying permissible collateral types, LTV ranges, and term limits. Applications for explicitly prohibited product types — payday loans, vehicle-title loans, tax refund anticipation loans, defined private education loans, and stated-income/no-doc loans — are blocked at intake by a product screen before any underwriting begins; the block is logged as `loan_application.product.screened`. The prohibited-product list is encoded in `credit_config` and is write-restricted to Compliance. The credit box is reviewed at least annually; the review is triggered by `credit_box.review_due` and produces a `credit_box.review.completed` event. If a product screen fires on an application, the application cannot advance to underwriting without a Compliance override that is itself logged and subject to LP-08 exception controls.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---:|---|
| Application submitted for any product (`loan_application.created`) | Product code (`loan_application.product_code`), product type (`loan_application.product_type`), prohibited-product list version (`credit_config.approval_id`) | Product screen result logged (`loan_application.product.screened`); if prohibited, application blocked | Immediately at intake — no regulatory deadline; internal SLA: real-time |
| Annual credit-box review due (calendar trigger) | Current credit-box definition (`credit_box.definition`), version (`credit_box.version`), next review date (`credit_box.next_review_at`) | Credit-box review completed (`credit_box.review.completed`) | ≤ 12 months from last review (enforced by `credit_box.review_due`) |
| Credit-box definition changed (`credit_config.changed`) | Updated LTV matrix (`credit_config.ltv_matrix`), DTI tiers (`credit_config.dti_tiers`), FICO bands (`credit_config.fico_bands`), approval ID (`credit_config.approval_id`) | Config change recorded (`credit_config.changed`) | Before change takes effect in underwriting engine |

**ALERTS/METRICS:** Alert when `credit_box.review_due` is within 30 days and no `credit_box.review.completed` event exists for the current cycle. Alert on any `loan_application.product.screened` event that results in a block — target zero unreviewed blocks older than 1 business day. Monitor count of prohibited-product screen hits by channel and partner monthly.

---

## LP-03 — Applications, Acceptance & Denial Standards {#lp-03-applications-acceptance--denial-standards}

**WHY (Reg cite):** [ECOA/Reg B 12 CFR §1002.9(a)](https://www.ecfr.gov/current/title-12/section-1002.9) requires that a creditor notify an applicant of action taken on a completed application within 30 days. [ECOA/Reg B §1002.6](https://www.ecfr.gov/current/title-12/section-1002.6) requires that credit decisions be based on neutral creditworthiness factors only. [TILA/Reg Z §1026.43(c)](https://www.ecfr.gov/current/title-12/section-1026.43#p-1026.43(c)) (ATR) and [NCUA §701.21](https://www.ecfr.gov/current/title-12/part-701/section-701.21) impose substantive underwriting standards.

**SYSTEM BEHAVIOR:** Every application must accumulate a standardized underwriting bundle before a credit decision is recorded: application data (`loan_application.data`), credit report (`credit_report`), income and assets (`loan_application.income_assets`), DTI (`loan_application.dti`), collateral/LTV (`loan.ltv`), OFAC clearance (`loan_party.ofac_status`), and ATR/QM result (`loan_application.atr_qm_result`) for covered mortgage products. These inputs are summarized into a `car` (Credit Analysis Record) object that is sealed (`car.sealed`) before the decision is recorded. Decisions must be based solely on neutral factors enumerated in the credit policy; any factor referencing a prohibited basis or proxy is blocked by the underwriting engine's guardrails (`compliance.guardrails`). Completed applications must be decided within 30 days; the system enforces this via `loan_application.decision_due_at`. Incomplete applications trigger an incompleteness notice; if the application ages without completion it is flagged (`loan_application.incomplete.detected`) and the incompleteness notice clock starts. Second-level review of all denials for consistency and fair-lending concerns is required before the AAN is issued (see [LP-07](#lp-07-adverse-action--notifications)). Write access to the decision field is restricted to authorized underwriting roles; Compliance has read access to all decision records.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---:|---|
| Application received and underwriting bundle assembled (`loan_application.completed`) | Application data (`loan_application.data`), income/assets (`loan_application.income_assets`), DTI (`loan_application.dti`), credit report freshness (`credit_report.freshness`), collateral LTV (`loan.ltv`), OFAC status (`loan_party.ofac_status`), ATR/QM result (`loan_application.atr_qm_result`) | CAR sealed (`car.sealed`); application marked complete | Before decision is recorded |
| Credit decision recorded (`loan_application.decisioned`) | CAR ID (`car.id`), decision basis (`loan_application.action_basis`), neutral factors only (`compliance.guardrails`) | Decision recorded (`loan_application.decisioned`); AAN timer started if adverse (`loan_application.aan_due_at`) | Within 30 calendar days of application completion (enforced by `loan_application.decision_due_at`) |
| Application incomplete and aging detected (`loan_application.incomplete.detected`) | Application ID (`loan_application.id`), incomplete-aged flag (`loan_application.incomplete_aged`) | Incompleteness notice sent (`loan_application.incompleteness_notice.sent`) | Per Reg B §1002.9(c) — reasonable notice; internal SLA: within 5 business days of detection |
| Final action recorded on application (`application.final_action.recorded`) | Final action code (`application.final_action`), channel (`loan_application.channel`), GMI (`loan_application.gmi`) | Final action logged (`application.final_action.recorded`); retention clock set (`credit_package.retention.started`) | Immediately on decision |

**ALERTS/METRICS:** Alert when any `loan_application.decision_due_at` is within 3 business days and no `loan_application.decisioned` event exists. Target zero applications decided after the 30-day deadline. Monitor denial rate by channel, product, and partner monthly for disparity signals feeding [LP-13](#lp-13-fair-lending-risk-assessment--monitoring).

---

## LP-04 — Credit Scoring & Adverse Credit History {#lp-04-credit-scoring--adverse-credit-history}

**WHY (Reg cite):** [ECOA/Reg B 12 CFR §1002.6(b)](https://www.ecfr.gov/current/title-12/section-1002.6) requires that credit evaluation factors be empirically derived and statistically sound and not operate as proxies for prohibited bases. [FCRA 15 USC §1681m](https://www.law.cornell.edu/uscode/text/15/1681m) requires specific adverse-action disclosures when a credit score is a factor. [ECOA/Reg B §1002.9](https://www.ecfr.gov/current/title-12/section-1002.9) and the CFPB's credit-score disclosure rules require score disclosure in AANs.

**SYSTEM BEHAVIOR:** Credit scores are used as a secondary analytical input, not the sole driver of a credit decision; the primary decision rests on the full underwriting bundle assembled under [LP-03](#lp-03-applications-acceptance--denial-standards). The system enforces configurable FICO bands (`credit_config.fico_bands`) and derogatory-credit tolerances (`credit_config.seasoning_rules`), including bankruptcy seasoning periods and small medical-judgment thresholds. When a score falls outside configured bands or derogatory tolerances are breached, the application is automatically routed to exception handling under [LP-08](#lp-08-exceptions-mitigating-factors--overrides). Credit reports must be no older than 6 months at the time of decision; the system checks freshness (`credit_report.freshness`, `credit_report.stale_at`) and blocks decisioning if the report is stale. For thin-file borrowers (`loan_application.thin_file`), the system supports alternative credit data ingestion; use of alternative data is logged via `car.alternative_data.used`. Score disclosure is automatically included in any AAN where a score was a factor (`credit_report.score_disclosure`). Compliance is write-restricted on FICO band and seasoning-rule configuration; changes require an approved `credit_config.change.requested`.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---:|---|
| Credit report received for application (`credit_report.received`) | Report date (`credit_report.report_date`), stale-at date (`credit_report.stale_at`), freshness flag (`credit_report.freshness`) | Freshness check logged (`credit_report.freshness.checked`); if stale, decisioning blocked | Before underwriting bundle is sealed |
| Credit score evaluated against configured bands (`credit_score.tolerance.breached`) | FICO bands config (`credit_config.fico_bands`), observed score (`credit_report.score`), seasoning rules (`credit_config.seasoning_rules`) | Score tolerance breach logged (`credit_score.tolerance.breached`); exception routing triggered (`loan_exception.detected`) | Immediately on evaluation |
| Thin-file flag set on application (`loan_application.thin_file.flagged`) | Thin-file indicator (`loan_application.thin_file`), alternative data source | Alternative data use logged (`car.alternative_data.used`) | Before CAR is sealed |
| AAN issued where score was a factor (`aan.issued`) | Score disclosure content (`credit_report.score_disclosure`), reason codes (`loan_application.action_basis`) | AAN with score disclosure issued (`aan.issued`) | Within AAN deadline (see [LP-07](#lp-07-adverse-action--notifications)) |

**ALERTS/METRICS:** Alert when a credit report's `credit_report.stale_at` is reached and the associated application has not yet been decided. Monitor the rate of `credit_score.tolerance.breached` events by product and channel monthly; a rising exception rate is a fair-lending signal. Target zero decisions made with a stale credit report.

---

## LP-05 — ATR/QM & Mortgage Underwriting {#lp-05-atrqm--mortgage-underwriting}

**WHY (Reg cite):** [TILA/Reg Z 12 CFR §1026.43(c)](https://www.ecfr.gov/current/title-12/section-1026.43#p-1026.43(c)) requires that a creditor make a reasonable, good-faith determination of a consumer's ability to repay a covered closed-end consumer credit transaction secured by a dwelling, based on eight enumerated factors. [§1026.43(e)](https://www.ecfr.gov/current/title-12/section-1026.43#p-1026.43(e)) provides a safe harbor for Qualified Mortgages. Failure to complete the ATR analysis before consummation exposes Pynthia to rescission and damages claims.

**SYSTEM BEHAVIOR:** For every covered closed-end consumer credit transaction secured by a 1–4 family dwelling (`application.first_lien`), the system enforces completion of the ATR 8-factor checklist before closing documents are generated. The checklist is embedded in the `loan_application.atr_qm_result` field and must be in a completed state before the `loan_application.doc_block_state` is released. The system applies a default consumer DTI ceiling of 43% (`credit_config.dti_tiers`); stricter configurable tiers (e.g., 35% for mortgage products) are supported and enforced per product. DTI breaches trigger exception routing under [LP-08](#lp-08-exceptions-mitigating-factors--overrides). QM classification is recorded on the application; non-QM loans require additional documentation of the ATR analysis. The ATR/QM result is sealed as part of the CAR before docs print. Write access to ATR/QM result fields is restricted to authorized underwriting roles.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---:|---|
| Covered dwelling-secured application decisioned as approve (`loan_application.decisioned`) | First-lien flag (`application.first_lien`), ATR 8-factor checklist (`loan_application.atr_qm_result`), DTI (`loan_application.dti`), DTI tier config (`credit_config.dti_tiers`) | ATR/QM check completed (`loan_application.atr_qm.completed`); QM classification recorded | Before closing documents generated — enforced by `loan_application.doc_block_state` |
| DTI threshold breached on application (`loan_application.dti.breached`) | Observed DTI (`loan_application.dti`), configured DTI tier (`credit_config.dti_tiers`), product type (`loan_application.product_type`) | DTI breach logged (`loan_application.dti.breached`); exception case opened (`loan_exception.case.opened`) | Immediately on underwriting evaluation |
| Closing documents requested | ATR/QM result status (`loan_application.atr_qm_result`), doc block state (`loan_application.doc_block_state`) | Doc block released only if ATR/QM result is complete; block logged if not | Before docs print — hard gate |

**ALERTS/METRICS:** Alert on any covered mortgage application where `loan_application.doc_block_state` is released without a completed `loan_application.atr_qm_result`. Target zero covered mortgage closings without a sealed ATR checklist. Monitor DTI exception rate by product and loan officer monthly.

---

## LP-06 — Appraisals, Valuations & Collateral {#lp-06-appraisals-valuations--collateral}

**WHY (Reg cite):** [ECOA/Reg B 12 CFR §1002.14(a)](https://www.ecfr.gov/current/title-12/section-1002.14) requires that a creditor provide an applicant a free copy of any appraisal or other written valuation developed in connection with a first-lien application, promptly upon completion or no later than 3 business days before consummation. [§1002.12(b)](https://www.ecfr.gov/current/title-12/section-1002.12) requires retention of appraisal copies for 25 months. [TILA/Reg Z §1026.35(c)](https://www.ecfr.gov/current/title-12/section-1026.35#p-1026.35(c)) imposes appraisal independence requirements for HPMLs. [FHA 42 USC §3605](https://www.law.cornell.edu/uscode/text/42/3605) and [NCUA §701.31](https://www.ecfr.gov/current/title-12/part-701/section-701.31) prohibit discriminatory valuation practices.

**SYSTEM BEHAVIOR:** The system maintains an approved-appraiser list (`intermediary.approved_list`) and enforces appraiser independence by blocking assignment of appraisers with a conflict of interest. For every first-lien dwelling application, the system auto-generates an appraisal delivery task (`appraisal.delivery_due_at`) upon appraisal completion and delivers a free copy to the applicant (`appraisal.copy.delivered`) no later than 3 business days before consummation. Appraisal documents are retained for a minimum of 25 months (`credit_package.retention_expires_at`). The system enforces configurable product LTV matrices (`credit_config.ltv_matrix`); LTV breaches trigger exception routing under [LP-08](#lp-08-exceptions-mitigating-factors--overrides). Reconsideration of Value (ROV) requests are tracked via `valuation.rov_due_at`. Bias-screen rules (`valuation.bias_screen_rules`) are applied to every valuation to flag potential discriminatory patterns for fair-lending review. Appraisal ordering and delivery records are write-restricted to Loan Operations; Compliance has read access.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---:|---|
| Appraisal ordered for first-lien dwelling application (`appraisal.ordered`) | Application ID (`loan_application.id`), first-lien flag (`application.first_lien`), approved-appraiser list version (`intermediary.approved_list`) | Appraisal order logged (`appraisal.order.logged`); delivery task created (`appraisal.delivery_due_at`) | Immediately on order |
| Appraisal completed (`appraisal.completed`) | Appraisal value (`appraisal.value`), appraisal document (`appraisal.document`), bias-screen rules (`valuation.bias_screen_rules`) | Appraisal copy delivered to applicant (`appraisal.copy.delivered`); bias screen result logged (`valuation.completed`) | Promptly; no later than 3 business days before consummation (enforced by `appraisal.delivery_due_at`) |
| LTV computed and checked against product matrix (`collateral.ltv.checked`) | Observed LTV (`loan.ltv`), LTV matrix (`credit_config.ltv_matrix`), product code (`loan_application.product_code`) | LTV check logged (`collateral.ltv.checked`); if breach, exception triggered (`loan_exception.detected`) | Before CAR is sealed |
| ROV requested by applicant (`valuation.rov.requested`) | Applicant identity (`loan_application.applicant`), valuation report (`valuation.report`), ROV basis | ROV decision recorded (`valuation.rov.decided`) | Within `valuation.rov_due_at` (internal SLA: 10 business days) |
| Appraisal record retention clock set (`credit_package.retention.started`) | Appraisal document ID (`appraisal.document`), retention anchor date | Retention record created; expires at (`credit_package.retention_expires_at`) | Immediately on final action; retention ≥ 25 months |

**ALERTS/METRICS:** Alert when `appraisal.delivery_due_at` is within 1 business day and no `appraisal.copy.delivered` event exists. Alert on any `valuation.completed` event where the bias screen flags a potential disparity — route to fair-lending review within 2 business days. Target zero first-lien closings without a delivered appraisal copy on file.

---

## LP-07 — Adverse Action & Notifications {#lp-07-adverse-action--notifications}

**WHY (Reg cite):** [ECOA/Reg B 12 CFR §1002.9](https://www.ecfr.gov/current/title-12/section-1002.9) requires written notice of adverse action within 30 days of a completed application or existing-account adverse action, and within 90 days if a counteroffer is not accepted. [FCRA 15 USC §1681m](https://www.law.cornell.edu/uscode/text/15/1681m) requires specific content when a consumer report or score was a factor. [ECOA/Reg B §1002.12(b)](https://www.ecfr.gov/current/title-12/section-1002.12) requires retention of AANs for 25 months.

**SYSTEM BEHAVIOR:** The system automatically queues an AAN (`aan.queued`) whenever a loan application is decisioned adversely or a counteroffer expires without acceptance. The AAN must contain ECOA-required content (specific reasons, ECOA notice, CRA disclosure if applicable, credit-score disclosure if a score was a factor) and must pass a second-level review (`aan.second_review.completed`) for consistency and fair-lending concerns before it is issued. The second-level reviewer is a Compliance or senior underwriting role; the AAN is write-locked to that role until review is complete. For oral adverse decisions, a written AAN must follow within 30 days. Counteroffers that are not accepted within 90 days trigger an AAN automatically via `loan_application.counteroffer_aan_due_at`. A counteroffer accepted within 90 days requires no AAN — this carve-out is enforced by checking `loan_application.counteroffer_status` before queuing. AANs are retained for ≥ 25 months. Existing-account adverse actions on open loan accounts (`loan_account.adverse_action.decided`) follow the same 30-day notice requirement and second-level review.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---:|---|
| Application decisioned adversely (`loan_application.adverse_action.decided`) | Applicant identity (`loan_application.applicant`), decision basis/reason codes (`loan_application.action_basis`), credit score disclosure (`credit_report.score_disclosure`), GMI (`loan_application.gmi`) | AAN queued (`aan.queued`); second-level review task created | Immediately on adverse decision |
| Second-level review completed (`aan.second_review.completed`) | AAN draft content, reviewer ID, fair-lending consistency check | AAN issued (`aan.issued`); retention clock set | Within 30 calendar days of application completion (enforced by `loan_application.aan_due_at`) |
| Counteroffer expires without acceptance (`loan_application.counteroffer.expired`) | Counteroffer status (`loan_application.counteroffer_status`), counteroffer terms (`loan_application.counteroffer_terms`), expiry date | AAN queued (`aan.queued`) for counteroffer expiry | Within 90 days of counteroffer date (enforced by `loan_application.counteroffer_aan_due_at`) |
| Oral adverse decision logged (`loan_application.oral_adverse_decision`) | Oral adverse decision flag (`loan_application.oral_adverse_decision`), oral statement record (`loan_application.oral_statement`) | Oral notice logged (`notice.oral.logged`); written AAN queued (`aan.queued`) | Written AAN within 30 calendar days (enforced by `loan_application.aan_due_at`) |
| Existing-account adverse action decided (`loan_account.adverse_action.decided`) | Account ID (`loan_account.action_basis`), action basis, reason codes | AAN queued (`aan.queued`); second-level review task created | Within 30 calendar days (enforced by `loan_account.aan_due_at`) |

**ALERTS/METRICS:** Alert when any `loan_application.aan_due_at` or `loan_account.aan_due_at` is within 3 business days and no `aan.issued` event exists. Alert when `aan.second_review.completed` has not occurred within 2 business days of `aan.queued`. Target zero AANs issued past deadline. Monitor AAN reason-code distribution by product, channel, and partner quarterly for fair-lending disparity signals.

---

## LP-08 — Exceptions, Mitigating Factors & Overrides {#lp-08-exceptions-mitigating-factors--overrides}

**WHY (Reg cite):** [ECOA/Reg B 12 CFR §1002.6(b)](https://www.ecfr.gov/current/title-12/section-1002.6) requires that any exception to standard credit criteria be based on neutral, documented factors and not operate as a proxy for a prohibited basis. [NCUA Parts 701 and 741](https://www.ecfr.gov/current/title-12/part-701) require safe-and-sound underwriting; undocumented exceptions undermine that standard. Uncontrolled exception rates are a primary fair-lending examination focus.

**SYSTEM BEHAVIOR:** The system automatically detects breaches of numeric and qualitative underwriting rules — DTI, FICO band, LTV, bankruptcy seasoning, and product restrictions — and opens a `loan_exception` case (`loan_exception.case.opened`) for each breach. The underwriter must select from a standardized mitigant menu and document the compensating factors (`loan_exception.observed_value`, `loan_exception.rule`); free-text rationale alone is not accepted. Exceptions are routed to an approval tier (`loan_exception.approval_tier`) based on severity: minor exceptions to a senior underwriter, material exceptions to the Chief Lending Officer, and exceptions involving prohibited-basis proxies to Compliance. All exceptions must be decided (`loan_exception.decided`) before closing documents are released; the `loan_exception.closing_block_state` prevents closing until the exception is resolved. Portfolio-level exception analytics are published quarterly (`loan_exception.analytics.published`) and reviewed by the Fair Lending Committee. Compliance is write-restricted on the mitigant menu configuration; exception approval records are immutable once written.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---:|---|
| Underwriting rule breach detected (DTI, FICO, LTV, seasoning, product restriction) (`loan_exception.detected`) | Breached rule (`loan_exception.rule`), observed value (`loan_exception.observed_value`), application ID (`loan_application.id`) | Exception case opened (`loan_exception.case.opened`); closing block applied (`loan_exception.closing_block_state`) | Immediately on detection |
| Exception submitted with mitigants (`loan_exception.submitted`) | Standardized mitigant selection, compensating factors, approval tier (`loan_exception.approval_tier`), case ID (`loan_exception.case`) | Exception routed to approver; submission logged (`loan_exception.submitted`) | Before closing — no fixed calendar deadline; closing is blocked until resolved |
| Exception decided by approver (`loan_exception.decided`) | Approver ID, decision (approve/deny), rationale | Exception decision recorded (`loan_exception.decided`); closing block released if approved | Before closing documents generated (enforced by `loan_exception.closing_block_state`) |
| Quarterly exception analytics published (`loan_exception.analytics.published`) | All exception cases for the period, approval tier distribution, mitigant types, demographic summary | Analytics report published (`loan_exception.analytics.published`) | Quarterly (internal SLA: within 15 days of quarter close; enforced by `loan_exception.analytics_due`) |

**ALERTS/METRICS:** Alert when any `loan_exception.case.opened` has not been decided within 5 business days. Alert when `loan_exception.closing_block_state` is active on an application within 3 days of a scheduled closing. Monitor exception approval rate by approver, product, and channel quarterly; a disparity in exception grant rates by demographic proxy is a fair-lending red flag.

---

## LP-09 — Documentation, Recordkeeping & Retention {#lp-09-documentation-recordkeeping--retention}

**WHY (Reg cite):** [ECOA/Reg B 12 CFR §1002.12(b)](https://www.ecfr.gov/current/title-12/section-1002.12) requires retention of applications, GMI, evaluation data, and adverse-action notices for 25 months from the date of notification. [HMDA/Reg C 12 CFR §1003.5](https://www.ecfr.gov/current/title-12/section-1003.5) requires retention of HMDA LAR data. [TILA/Reg Z §1026.25](https://www.ecfr.gov/current/title-12/section-1026.25) requires retention of evidence of compliance for 2 years (longer for certain mortgage records). Pynthia's internal standard extends retention to the longer of the regulatory minimum or the CU's general record retention schedule.

**SYSTEM BEHAVIOR:** Every loan application and prequalification must have a complete credit package (`credit_package.schema`) before the loan is booked; the `loan_application.doc_block_state` prevents booking if required documents are missing. The credit package schema specifies the required document set by product type; the system validates completeness at booking (`credit_package.validated`). Upon final action, the retention clock is set automatically (`credit_package.retention.started`) with an anchor date equal to the date of notification to the applicant and an expiry of ≥ 25 months (`credit_package.retention_expires_at`); Pynthia's CU standard may extend this further per the Record Retention Policy. GMI data (`loan_application.gmi`) is retained as part of the credit package. Compliance and Loan Operations have read access to all credit packages; write access to the retention schedule is restricted to Records Management. Prequalification records (`prequal`) are retained under the same schema. Hold/destruction lifecycle mechanics after clock-setting are governed by [SC-02](#sc-02-record-retention-lifecycle-mechanics) embedded in this policy.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Loan application final action recorded (`application.final_action.recorded`) | Final action code (`application.final_action`), notification date (`loan_application.notified_at`), GMI (`loan_application.gmi`), credit package schema (`credit_package.schema`) | Retention clock set (`credit_package.retention.started`); retention expiry recorded (`credit_package.retention_expires_at`) | Immediately on final action |
| Loan booking requested (`loan.booking.requested`) | Credit package completeness (`credit_package.validated`), doc block state (`loan_application.doc_block_state`), required document set | Booking allowed only if package validated (`credit_package.validated`); block logged if incomplete | Before booking — hard gate |

**ALERTS/METRICS:** Alert when any `loan.booking.requested` event is blocked by `loan_application.doc_block_state` — target zero bookings with incomplete packages. Alert when `credit_package.retention_expires_at` is within 30 days and no disposition decision has been made. Monitor the count of credit packages without a set `credit_package.retention_expires_at` weekly — target zero. Hold, destruction, and permanent-record alerts are governed by [SC-02](#sc-02-record-retention-lifecycle-mechanics).

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

## LP-10 — Pricing, Rate Sheets & HPML Controls {#lp-10-pricing-rate-sheets--hpml-controls}

**WHY (Reg cite):** [TILA/Reg Z 12 CFR §1026.35](https://www.ecfr.gov/current/title-12/section-1026.35) defines Higher-Priced Mortgage Loans (HPMLs) by reference to the Average Prime Offer Rate (APOR) and imposes escrow, appraisal, and other requirements. [§1026.36(d)](https://www.ecfr.gov/current/title-12/section-1026.36#p-1026.36(d)) prohibits loan-originator compensation based on loan terms. [§1026.36(e)](https://www.ecfr.gov/current/title-12/section-1026.36#p-1026.36(e)) prohibits steering consumers to less favorable products. [ECOA/Reg B §1002.6](https://www.ecfr.gov/current/title-12/section-1002.6) requires that pricing not be based on prohibited bases or proxies.

**SYSTEM BEHAVIOR:** The system publishes a new rate sheet every 7 days tied to the current APOR (`rate_sheet.apor_values`, `rate_sheet.refresh_due_at`). Before closing documents are generated on any covered mortgage, the system runs an HPML test (`loan_pricing.hpml`) and a points-and-fees test (`loan_pricing.points_fees`) against the locked rate. If either test triggers HPML status, the system applies the required HPML controls (escrow requirement flag, additional appraisal requirements if applicable) before releasing the doc block. Pricing exceptions — deviations from the published rate sheet — require a documented rationale (`pricing.exception_rationale`), mitigant selection, and approval (`pricing.exception.decided`) before the exception price is applied. Pricing exceptions are reviewed periodically for demographic patterns (`pricing.exception_demographics_summary`); the review period is configurable and produces a `pricing.exception_review.completed` event. Pricing engines for direct and partner channels are both subject to these controls; partner pricing deviations are flagged and reviewed under the same workflow. LO compensation plans (`lo_comp.plan_terms`) are reviewed for compliance with §1026.36(d) before activation. Write access to rate-sheet parameters and LO comp plans is restricted to authorized Finance and Compliance roles.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---:|---|
| Weekly rate-sheet refresh due (`rate_sheet.refresh_due_at`) | Current APOR values (`rate_sheet.apor_values`), prior sheet version | New rate sheet published (`rate_sheet.published`, `rate_sheet.apor.published`) | Every 7 days (enforced by `rate_sheet.refresh_due_at`) |
| Rate locked on covered mortgage (`loan_pricing.locked`) | Locked APR (`loan_pricing.apr`), APOR reference (`rate_sheet.apor_values`), points and fees (`loan_pricing.points_fees`) | HPML test run (`loan_pricing.hpml.tested`); HPML flag set if triggered | Before closing documents generated |
| Pricing exception requested (`loan_pricing.exception.requested`) | Deviation from sheet price (`loan_pricing.deviation`), exception rationale (`pricing.exception_rationale`), approver ID (`pricing.exception_approver`) | Exception routed for approval (`pricing.exception.requested`) | Before exception price is applied |
| Pricing exception decided (`loan_pricing.exception.decided`) | Approver decision, mitigant documentation | Exception decision recorded (`loan_pricing.exception.decided`); exception price applied only if approved | Before rate lock confirmation |
| Pricing exception period closed for demographic review (`pricing.exception_period.closed`) | Exception records for period, demographic summary (`pricing.exception_demographics_summary`) | Exception review completed (`pricing.exception_review.completed`) | Per configured review period (internal SLA: quarterly; enforced by `pricing.exception_review_due_at`) |

**ALERTS/METRICS:** Alert when `rate_sheet.refresh_due_at` passes without a `rate_sheet.published` event. Alert when any covered mortgage reaches doc-generation without a `loan_pricing.hpml.tested` event. Monitor pricing exception rate and demographic distribution quarterly; a statistically significant disparity by race, national origin, or other prohibited basis triggers a fair-lending escalation under [LP-13](#lp-13-fair-lending-risk-assessment--monitoring).

---

## LP-11 — OFAC & Sanctions Gate {#lp-11-ofac--sanctions-gate}

**WHY (Reg cite):** [31 CFR Chapter V](https://www.ecfr.gov/current/title-31/subtitle-B/chapter-V) and OFAC regulations require that U.S. financial institutions screen all parties to transactions against OFAC's Specially Designated Nationals (SDN) and other sanctions lists before completing a transaction. The FFIEC BSA/AML Manual confirms that lending transactions require pre-funding OFAC screening of all borrowers, co-borrowers, and guarantors. Failure to screen or to block a prohibited transaction exposes Pynthia to civil and criminal penalties.

**SYSTEM BEHAVIOR:** The system screens every new borrower, co-borrower, and guarantor (`loan_party`) against the current OFAC SDN list (`ofac.list_version`) when they are added to a loan application (`loan_party.added`). A `loan_party.ofac_status` of "potential match" blocks funding (`loan.funding_block_state`) until the match is reviewed and either cleared or escalated. Clearance of an apparent match requires documented rationale (`loan_party.ofac_result`) and is logged as `loan_party.ofac.cleared`; escalation of a confirmed match is logged as `loan_party.ofac.escalated` and triggers BSA/OFAC reporting procedures (see BSA Policy). The OFAC list version used for each screen is captured in `ofac.list_version`. Override of a potential match requires a senior Compliance officer approval and a documented rationale; the override is immutable once recorded. Funding is blocked until all parties on the application have an `ofac_status` of "cleared."

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---:|---|
| Loan party added to application (`loan_party.added`) | Party identity (`loan_party.identity`), OFAC list version (`ofac.list_version`), contact (`loan_party.contact`) | OFAC screen result logged (`loan_party.ofac.screened`); potential match flag set if triggered (`loan_party.ofac_potential_match`) | Immediately on party addition — before any credit decision |
| Potential OFAC match reviewed and cleared (`loan_party.ofac.cleared`) | Match score (`ofac_result.match_score`), matched lists (`ofac_result.matched_lists`), clearance rationale, approver ID | Clearance recorded (`loan_party.ofac.cleared`); funding block released if all parties cleared | Before funding — enforced by `loan.funding_block_state` |
| Confirmed OFAC match escalated (`loan_party.ofac.escalated`) | Match details (`loan_party.ofac_result`), escalation rationale | Escalation logged (`loan_party.ofac.escalated`); BSA referral initiated; funding permanently blocked | Immediately on confirmation |
| All parties cleared — funding authorized | All `loan_party.ofac_status` = cleared, funding block state (`loan.funding_block_state`) | Funding block released; funding authorized | Before disbursement |

**ALERTS/METRICS:** Alert when any `loan_party.ofac_potential_match` flag is set and has not been reviewed within 1 business day. Target zero funded loans with an unresolved `loan_party.ofac_potential_match`. Monitor OFAC screen hit rate by channel and partner monthly; anomalous hit rates may indicate data quality issues.

---

## LP-12 — Prequalification, Marketing & Steering Controls {#lp-12-prequalification-marketing--steering-controls}

**WHY (Reg cite):** [TILA/Reg Z 12 CFR §1026.36(e)](https://www.ecfr.gov/current/title-12/section-1026.36#p-1026.36(e)) prohibits steering consumers to loan products that are not in their interest based on loan-originator compensation. [ECOA/Reg B 12 CFR §1002.4](https://www.ecfr.gov/current/title-12/section-1002.4) and [FHA 42 USC §3605](https://www.law.cornell.edu/uscode/text/42/3605) prohibit discriminatory product placement and discouragement of applications on prohibited bases. [NCUA §701.31](https://www.ecfr.gov/current/title-12/part-701/section-701.31) prohibits redlining and other geographic discrimination.

**SYSTEM BEHAVIOR:** Prequalification decisions (`prequal`) must be based on neutral, documented criteria (`prequal.criteria_version`, `prequal.inputs`) and must not reference prohibited bases or proxies. The system enforces this by running the same guardrails check (`compliance.guardrails`) on prequal inputs as on full applications. Product menus presented to applicants — online, in-branch, and through partner channels — are reviewed before deployment (`product_menu.steering_review`) to ensure they do not steer protected groups toward less favorable products or discourage applications. Any change to a product menu requires a steering review (`product_menu.change.requested` → `steering_review.completed`) before the menu is deployed (`product_menu.deployed`). Marketing materials and advertisements are subject to the advertising review workflow (`advertising.review.completed`) and must not contain language that discourages applications from protected groups (`fair_lending.discouragement`). The `steering` object tracks steering-review outcomes; the `steering_review` object tracks the periodic review cadence. Compliance is write-restricted on product-menu configurations and prequal criteria; changes require documented approval.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---:|---|
| Prequalification requested (`prequal.requested`) | Prequal inputs (`prequal.inputs`), criteria version (`prequal.criteria_version`), product mapping (`prequal.product_mapping`), guardrails check (`compliance.guardrails`) | Prequal decision recorded (`prequal.decided`) | Immediately; no regulatory deadline — internal SLA: same business day |
| Product menu change requested (`product_menu.change.requested`) | Menu diff (`product_menu.diff`), proposed change (`product_menu.change`), steering review assignment | Steering review completed (`steering_review.completed`) before deployment | Before menu deployed — hard gate |
| Product menu deployed (`product_menu.deployed`) | Steering review completion record (`steering_review.completed`), outcome metrics baseline (`product_menu.outcome_metrics`) | Menu deployment logged (`product_menu.deployed`) | After steering review is complete |
| Discouragement pattern detected in marketing or partner channel (`fair_lending.discouragement.reported`) | Discouragement evidence (`fair_lending.discouragement`), channel, partner ID | Discouragement reported (`fair_lending.discouragement.reported`); remediation opened (`fair_lending.remediation.opened`) | Within 2 business days of detection (internal SLA; enforced by `fair_lending.remediation_due_at`) |
| Periodic steering review completed (`steering_review.completed`) | Product menu outcome metrics (`product_menu.outcome_metrics`), demographic distribution of product placements | Steering review result logged (`steering_review.completed`) | Per review schedule (internal SLA: semi-annually; enforced by `steering_review.due`) |

**ALERTS/METRICS:** Alert when a `product_menu.change.requested` event exists without a corresponding `steering_review.completed` event and the menu has been deployed. Alert on any `fair_lending.discouragement.reported` event — target zero unresolved discouragement findings older than 5 business days. Monitor prequal-to-application conversion rates by demographic proxy quarterly for disparity signals.

---

## LP-13 — Fair Lending Risk Assessment & Monitoring {#lp-13-fair-lending-risk-assessment--monitoring}

**WHY (Reg cite):** [ECOA/Reg B 12 CFR §1002.4](https://www.ecfr.gov/current/title-12/section-1002.4) and [§1002.6](https://www.ecfr.gov/current/title-12/section-1002.6) require that credit decisions not discriminate on prohibited bases; a reproducible monitoring program is the primary evidence of compliance. [FHA 42 USC §3605](https://www.law.cornell.edu/uscode/text/42/3605) and [NCUA §701.31](https://www.ecfr.gov/current/title-12/part-701/section-701.31) impose anti-redlining and nondiscrimination obligations that require geographic analysis. [HMDA/Reg C 12 CFR §1003.5](https://www.ecfr.gov/current/title-12/section-1003.5) requires collection and retention of HMDA LAR data that feeds the fair-lending dataset.

**SYSTEM BEHAVIOR:** The system maintains a reproducible fair-lending dataset (`analytics.lending_dataset`, `analytics.geo_lending_dataset`) capturing application, approval, denial, pricing, and loss data with GMI by product, channel, partner, and geography. The dataset version is recorded (`fair_lending.dataset_version`) at each analysis run to ensure reproducibility. A full fair-lending risk assessment (`fair_lending.assessment.completed`) is conducted at least annually; the assessment covers disparate treatment, disparate impact, and redlining analyses. Remediation findings are tracked (`fair_lending.finding_id`, `fair_lending.remediation_due_at`) and reported to the Board Lending/Fair Lending Committee. HMDA LAR data is collected, quality-checked, and submitted per Reg C; the LAR QC process (`hmda.lar_qc.completed`) is a prerequisite for submission. The fair-lending dataset is write-restricted to Compliance and the analytics team; raw GMI data is access-controlled per privacy requirements. Remediation items are tracked to closure (`fair_lending.remediation.closed`).

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---:|---|
| Annual fair-lending assessment cycle opens (calendar trigger) | Lending dataset version (`fair_lending.dataset_version`), prior assessment results, assessment area (`analytics.assessment_area`) | Fair-lending assessment completed (`fair_lending.assessment.completed`) | ≤ 12 months from last assessment (enforced by `fair_lending.next_assessment_at`) |
| Disparity analysis run (`analytics.disparity_report.completed`) | Lending dataset (`analytics.lending_dataset`), group estimators (`analytics.group_estimators`), cohort threshold (`analytics.cohort_threshold`), disparity thresholds (`compliance.disparity_thresholds`) | Disparity report completed (`analytics.disparity_report.completed`); threshold breach flagged if triggered (`analytics.threshold.breached`) | Per assessment schedule (enforced by `analytics.disparity_due_at`) |
| Redlining review completed (`analytics.redlining_review.completed`) | Geographic lending dataset (`analytics.geo_lending_dataset`), assessment area (`analytics.assessment_area`) | Redlining review completed (`analytics.redlining_review.completed`) | Per assessment schedule (enforced by `analytics.redlining_due_at`) |
| HMDA LAR QC completed (`hmda.lar_qc.completed`) | LAR rows (`hmda.lar_row`), GMI data (`hmda.gmi`), HMDA-covered flag (`application.hmda_covered`) | LAR QC completed (`hmda.lar_qc.completed`); LAR submitted (`hmda.lar.submitted`) | Per Reg C submission deadline (enforced by `hmda.submission_due_at`) |
| Fair-lending finding remediation opened (`fair_lending.remediation.opened`) | Finding ID (`fair_lending.finding_id`), remediation owner, remediation due date (`fair_lending.remediation_due_at`) | Remediation tracked; closed on completion (`fair_lending.remediation.closed`) | Per remediation plan (enforced by `fair_lending.remediation_due_at`) |

**ALERTS/METRICS:** Alert when `fair_lending.next_assessment_at` is within 60 days and no assessment is in progress. Alert on any `analytics.threshold.breached` event — route to Compliance within 1 business day. Monitor open remediation items weekly; target zero items past their `fair_lending.remediation_due_at`. Alert when `hmda.submission_due_at` is within 30 days and LAR QC is not complete.

---

## LP-14 — Insider Lending & Employee Conflicts {#lp-14-insider-lending--employee-conflicts}

**WHY (Reg cite):** [NCUA 12 CFR Parts 701 and 741](https://www.ecfr.gov/current/title-12/part-701) impose safety-and-soundness requirements that prohibit preferential insider lending. [ECOA/Reg B 12 CFR §1002.4](https://www.ecfr.gov/current/title-12/section-1002.4) prohibits discrimination; preferential insider terms can constitute reverse discrimination against non-insiders. Federal credit union regulations and NCUA examination guidance require that insider loans be made on terms no more favorable than those available to similarly situated non-insider members, and that insider lending activity be reported to governance.

**SYSTEM BEHAVIOR:** The system flags any loan application where the applicant or a co-borrower is an employee, officer, director, or related party (`loan_application.insider`). The insider flag is set automatically based on a comparison against the covered-person roster (`covered_person.roster`) and must be resolved before the credit decision is recorded. Resolution requires a terms-parity check (`insider.terms_parity`) confirming that the proposed terms (`insider.proposed_terms`) are no more favorable than comparable market terms (`insider.comparable_terms`); the check is logged as `insider.terms_parity.checked`. Looser underwriting standards or pricing concessions for insiders are prohibited; the system enforces this by running the same guardrails check on insider applications as on all others. Board approval is required for insider credit above configured thresholds (`insider.credit_threshold_exceeded`); the approval is recorded as `insider.board_approval.recorded`. Insider lending activity is reported to governance quarterly (`insider.board_report.issued`). The insider flag and terms-parity check are write-restricted to Compliance; the credit decision field is locked until the insider flag is resolved.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---:|---|
| Insider flag set on application (`loan_application.insider.flagged`) | Insider indicator (`loan_application.insider`), covered-person roster (`covered_person.roster`), applicant identity (`loan_application.applicant`) | Insider flag logged (`loan_application.insider.flagged`); decision block applied until resolved | Immediately on application creation |
| Insider application screened for terms parity (`loan_application.insider.screened`) | Proposed terms (`insider.proposed_terms`), comparable market terms (`insider.comparable_terms`), credit threshold (`insider.aggregate_credit_amount`) | Terms-parity check logged (`insider.terms_parity.checked`); if threshold exceeded, board approval task created | Before credit decision — enforced by decision block |
| Board approval recorded for above-threshold insider credit (`insider.board_approval.recorded`) | Board approval record (`insider.board_approval`), credit amount (`insider.aggregate_credit_amount`), proposed terms | Board approval logged (`insider.board_approval.recorded`); decision block released | Before credit decision |
| Insider lending activity reported to governance (`insider.board_report.issued`) | All insider loan records for the period, terms-parity results, board approval records | Board report issued (`insider.board_report.issued`) | Quarterly (internal SLA: within 15 days of quarter close; enforced by `insider_report.due`) |

**ALERTS/METRICS:** Alert when any `loan_application.insider.flagged` event has not been resolved (screened and cleared) within 2 business days. Alert when an insider application reaches the decision stage without a `insider.terms_parity.checked` event. Target zero insider loans with terms more favorable than comparable non-insider loans. Monitor insider loan volume and terms quarterly for governance reporting.

---

## Governance & Sign-Off {#governance}

| Role | Responsibility |
|---|---|
| Patrick Wilson, Chief Compliance Officer (Fair Lending Officer) | Policy owner; annual review; fair-lending program oversight |
| Chief Lending Officer | Credit standards; exception approval authority; insider lending oversight |
| Loan Operations | Application processing; document completeness; appraisal delivery |
| BSA/Compliance | OFAC screening; fair-lending monitoring; AAN second-level review |
| Board Lending/Fair Lending Committee | Annual policy approval; fair-lending assessment review; insider lending reporting |

**Review cadence:** This policy is reviewed at least annually. Material changes to products, channels, or partner programs trigger an out-of-cycle review within 30 days of the change.

**Cross-references:**
- Collections Policy — non-accrual, charge-off, and delinquency-collection workflow
- BSA Policy — BSA/AML program governance beyond the lending OFAC gate
- Fair Lending Policy — fair-lending program governance and analytics methodology
- Member Policy / BSA Policy — member eligibility, onboarding, and CIP identity verification
- Third-Party Risk Policy — fintech/BaaS partner onboarding and ongoing vendor due diligence
- Record Retention Policy — general record retention schedules
- Truth-in-Savings Policy — deposit disclosures

---

## Assumptions & Gaps {#assumptions}

- **Engineering vocabulary is provisional.** Several field and event codes referenced throughout this policy — including `loan_application.product_type`, `loan_application.counteroffer_status`, `loan_application.counteroffer_terms`, `loan_application.oral_adverse_decision`, `loan_application.option_shortfall_reason`, `application.counteroffer_status`, `application.counteroffer_terms`, `application.incomplete_aged`, `credit_report.score` (provisional: `credit_report.id`, `credit_report.score`), `car.id` (provisional), `notice.oral_statement` (provisional), `override.approver_id` (provisional), and `insider_case.approver_id` (provisional) — are drawn from the provisional codes list in `core-vocabulary.json` or are composed per the Composition grammar. Their exact spelling must be confirmed with engineering before the next policy review. All such codes are flagged as provisional in the Assumptions & Gaps section rather than inline.

- **HMDA reporter status.** This policy assumes Pynthia Credit Union meets the HMDA/Reg C reporting threshold and is a covered institution under [12 CFR Part 1003](https://www.ecfr.gov/current/title-12/part-1003). If asset size or origination volume falls below the threshold in any year, the HMDA LAR collection and submission requirements in [LP-13](#lp-13-fair-lending-risk-assessment--monitoring) do not apply for that year. Compliance should confirm reporter status annually.

- **QM safe harbor vs. rebuttable presumption.** LP-05 assumes Pynthia originates loans that qualify for the QM safe harbor (e.g., under the General QM definition at §1026.43(e)(2) or the Small Creditor QM). If Pynthia originates higher-priced covered transactions that qualify only for the rebuttable-presumption QM, additional ATR documentation requirements apply. Engineering should confirm which QM categories are in scope for the ATR/QM result field.

- **Partner pricing engine integration.** LP-10 assumes that fintech-partner and white-label/BaaS pricing engines emit `loan_pricing` events into the core system in real time. If partner engines operate independently and batch-sync pricing data, the HPML test and pricing-exception workflow may require a separate integration point. This gap should be resolved during partner onboarding under the Third-Party Risk Policy.

- **Alternative credit data sources.** LP-04 references alternative credit data for thin-file borrowers but does not specify approved data sources. Compliance should maintain an approved-alternative-data-source list and confirm that each source is empirically derived and does not operate as a proxy for a prohibited basis before use. This list is assumed to be maintained in `credit_config` but is not yet registered as a distinct field.

- **Insider threshold configuration.** LP-14 references a configurable credit threshold above which board approval is required for insider loans (`insider.credit_threshold_exceeded`). The specific dollar threshold is not set in this policy and must be established by the Board Lending Committee and encoded in `credit_config`. Until set, all insider loans above the NCUA regulatory threshold for officer loans should require board approval.

- **Appraisal independence — HPML additional appraisal.** LP-06 notes that HPML status may trigger an additional appraisal requirement under [Reg Z §1026.35(c)](https://www.ecfr.gov/current/title-12/section-1026.35#p-1026.35(c)). The system behavior for the second appraisal workflow (including the additional `appraisal.ordered` event and delivery requirement) is not fully specified here. Engineering should confirm whether the HPML flag in `loan_pricing.hpml` automatically triggers a second appraisal task or whether this is a manual Loan Operations step.

- **Prequalification vs. application distinction.** LP-12 treats prequalifications as distinct from completed applications for purposes of the AAN requirement. If a prequalification constitutes an "application" under Reg B (e.g., because it involves a credit report pull and a credit decision), the AAN requirements in LP-07 apply. Compliance should confirm the Reg B characterization of Pynthia's prequalification product before go-live.
