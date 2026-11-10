```yaml
---
title: Fair Lending Policy (Table-First, Design-Overlay v3)
owner: Patrick Wilson, Chief Compliance Officer
version: v1.0
effective: 2025-07-01
next_review: 2026-07-01
approvers:
  - Patrick Wilson, Chief Compliance Officer
tags: [Compliance, Fair Lending, ECOA, FHA, HMDA, Reg Z, NCUA]
---
```

# Fair Lending Policy

## General Policy Statement

Pynthia Credit Union ("Pynthia" or "the Credit Union") is committed to equal access to credit for all creditworthy applicants and members. This policy prohibits discrimination on any prohibited basis — including race, color, religion, national origin, sex, marital status, age (where the applicant has capacity to contract), familial status, disability, receipt of public-assistance income, and good-faith exercise of rights under the Consumer Credit Protection Act — across every stage of the credit lifecycle: inquiry, application, evaluation, pricing, appraisal, action-taken notice, monitoring data collection, advertising, servicing, and record retention. The policy applies to all lending products and channels, all staff and contractors, and all third parties acting on behalf of the Credit Union. Controls combine system enforcement with documented human review and Board oversight to prevent overt discrimination, disparate treatment, disparate impact, and redlining. The Chief Compliance Officer owns this policy; Lending Operations, Analytics, Third-Party Risk Management, Legal, HR, and Marketing are required participants. Board reporting occurs at least quarterly.

---

## Timing Matrix {#timing-matrix}

| Scenario | Trigger (human → event) | Deadline | Content Reference | Control |
|---|---|---:|---|---|
| Completed application — approve, counter, or deny | Application complete and decisioned (`loan_application.decisioned`) | 30 calendar days | AAN with specific reasons + score block if score used | [FL-05](#fl-05-action-taken-notices) |
| Incomplete application — adverse action | Application aged incomplete (`loan_application.incomplete.detected`) | 30 calendar days | AAN or incompleteness notice | [FL-05](#fl-05-action-taken-notices) |
| Existing-account adverse action | Account adverse action decided (`account.adverse_action.decided`) | 30 calendar days | AAN with specific reasons | [FL-05](#fl-05-action-taken-notices) |
| Counteroffer not accepted | Counteroffer issued, applicant does not accept within 90 days (`loan_application.counteroffer.expired`) | 90 calendar days from counteroffer | AAN | [FL-05](#fl-05-action-taken-notices) |
| Small-business phone credit (≤$1MM revenue) | Oral adverse decision on phone application (`loan_application.oral_adverse_decision`) | Reasonable time (written AAN within 30 days if requested) | AAN on request | [FL-05](#fl-05-action-taken-notices) |
| Appraisal/valuation copy delivery | Appraisal completed (`appraisal.completed`) | Promptly after completion; no later than 3 business days before consummation | Copy of appraisal or written valuation | [FL-04](#fl-04-appraisal-independence--rov) |
| ROV review completion | ROV requested (`valuation.rov.requested`) | 15 calendar days of request | ROV outcome logged in Fair-Lending Issue Register | [FL-04](#fl-04-appraisal-independence--rov) |
| GMI collection — HMDA-covered application | Application created for covered transaction (`application.hmda_covered.created`) | At application | GMI fields collected; visual/surname rule applied if declined | [FL-06](#fl-06-government-monitoring-gmihmda) |
| Quarterly LAR QC | Quarter closes (`analytics.quarter.closed`) | Within 30 days of quarter close | LAR QC report | [FL-06](#fl-06-government-monitoring-gmihmda) |
| Annual HMDA LAR submission | Submission window opens (`hmda.submission_window_open`) | Per Reg C calendar (generally March 1) | Submitted LAR | [FL-06](#fl-06-government-monitoring-gmihmda) |
| Ad pre-flight approval | Ad created (`ad.preflight.submitted`) | Before launch | Completed pre-flight checklist | [FL-07](#fl-07-advertising--fair-housing) |
| Advertising demographic reach review | Periodic trigger (at least annually) (`advertising.reach_review.completed`) | Annually or upon material program change | Reach review report | [FL-07](#fl-07-advertising--fair-housing) |
| Pricing exception capture | Exception identified (`pricing.exception.requested`) | At time of exception | Exception record with rationale and demographics | [FL-03](#fl-03-evaluation--pricing-rules) |
| Monthly pricing exception review | Month closes | By 10th of following month | Exception analytics report | [FL-03](#fl-03-evaluation--pricing-rules) |
| Quarterly disparity analytics | Quarter closes (`analytics.quarter.closed`) | Within 30 days of quarter close | Disparity report | [FL-10](#fl-10-monitoring--disparity-reviews) |
| Annual redlining review | Q1 calendar trigger | By end of Q1 | Redlining review report | [FL-10](#fl-10-monitoring--disparity-reviews) |
| Third-party monthly MI pack | 5th business day of month | By 5th BD | MI pack: applications, approvals, pricing, exceptions, complaints | [FL-09](#fl-09-third-party-fair-lending-oversight) |
| New-hire fair-lending training | Employee hired (`employee.hired`) | Within 30 days of role start | Training completion record | [FL-11](#fl-11-training) |
| Annual fair-lending training | Annual cycle opens (`training.annual_cycle.opened`) | By December 31 | Training completion record (≥98% coverage) | [FL-11](#fl-11-training) |
| Complaint intake logging | Complaint received (any channel) (`complaint.received`) | Within 1 business day | Complaint log entry | [FL-13](#fl-13-complaint-monitoring) |
| Prohibited-basis triage | Complaint logged (`complaint.logged`) | Within 3 business days | Prohibited-basis flag; escalation to Compliance if flagged | [FL-13](#fl-13-complaint-monitoring) |
| Compliance initial fair-lending assessment | Complaint escalated to Compliance | Within 10 business days | Assessment memo; Fair-Lending Issue Register entry if warranted | [FL-13](#fl-13-complaint-monitoring) |
| CCO escalation — High/Pattern complaint | Complaint classified High or Pattern-Potential | Within 2 business days of classification | CCO notification; Board queue | [FL-13](#fl-13-complaint-monitoring) |
| CAP initiation — complaint pattern | Pattern of ≥3 same-type complaints in 12-month window identified | Within 30 days of identification | Root-cause investigation; CAP | [FL-13](#fl-13-complaint-monitoring) |
| Consumer application/decision record retention | Notice of action taken | 25 months | Application, evaluation data, AAN | [FL-12](#fl-12-record-retention) |
| Business credit ≤$1MM retention | Notice of action taken | 12 months | Application, evaluation data, AAN | [FL-12](#fl-12-record-retention) |
| Business credit >$1MM (reasons/retention requested) | Notice of action taken | 12 months (60 days if neither requested) | Application, evaluation data, AAN | [FL-12](#fl-12-record-retention) |
| Self-test retention | Self-test completed | 25 months | Self-test records | [FL-12](#fl-12-record-retention) |

---

## FL-01 — Prohibition & Protected Bases {#fl-01-prohibition--protected-bases}

**WHY (Reg cite):** [ECOA/Reg B §1002.4](https://www.ecfr.gov/current/title-12/section-1002.4) prohibits discrimination in any aspect of a credit transaction on any prohibited basis. The [Fair Housing Act, 42 U.S.C. §3605](https://www.law.cornell.edu/uscode/text/42/3605) extends this prohibition to residential real-estate-related transactions. [NCUA 12 CFR §701.31](https://www.ecfr.gov/current/title-12/part-701/section-701.31) imposes parallel nondiscrimination requirements on federal credit unions. The FFIEC Compliance Management Analysis Checklist (Appendix §A.1) requires documented policies communicating prohibited bases and proxy guardrails to all staff; FFIEC overt-discrimination risk factors O1–O5 and inquiry-stage risk factors O4–O5 and §A.1c are directly addressed by this control.

**SYSTEM BEHAVIOR:** The system enforces a closed list of protected attributes and proxy variables (e.g., ZIP/neighborhood used as a racial proxy, property age or location as a neighborhood proxy) that may not be used at any stage of the credit lifecycle — inquiry, application, evaluation, pricing, appraisal, servicing, or collections. The protected-trait list and proxy guardrails are maintained in `compliance.guarded_attributes` and `compliance.guardrails`; both fields are write-restricted to Compliance and require CCO approval before any change is published. Inquiry-stage discouragement is explicitly prohibited: staff may not, on a prohibited basis, discourage inquiries or applications through oral statements, delays, differential referrals, selective disclosure of products or requirements, or any other means (FFIEC §A.1c, risk factors O4–O5). A procedure for reporting and escalating suspected inquiry-stage discouragement is maintained by Compliance and referenced in the staff training curriculum; any reported instance is logged as a `fair_lending.discouragement.reported` event and routed immediately to the CCO. The Board receives a quarterly report on prohibited-basis guardrail status and any policy changes. Disparate impact arising from facially neutral policies is also prohibited where not justified by business necessity and where a less-discriminatory alternative exists.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Compliance publishes or updates the protected-trait list or proxy guardrails (`compliance.guardrails.published`) | CCO approval (`compliance.guarded_attributes`), prior version for diff, change rationale (`compliance.change_rationale`) | Updated guardrail record + `compliance.guardrails.published`; prior version archived | Immediately upon CCO approval; annual review by policy anniversary |
| Staff or member reports suspected inquiry-stage discouragement (`fair_lending.discouragement.reported`) | Description of conduct, staff/branch identifier, applicant/member identifier, channel | Discouragement report logged in Fair-Lending Issue Register (`fair_lending.discouragement.reported`); CCO notified | Immediate escalation to CCO; investigation opened within 1 business day |
| Annual policy review cycle opens | Current policy version, regulatory change log, prior-year findings | Revised policy submitted for CCO and Board approval (`policy.review.completed`) | Annual; next review by `policy.next_review_at` |
| Quarterly Board compliance report due (`compliance.board_report_due_at`) | Guardrail status, any changes, discouragement incidents, disparity summary | Board compliance report section on prohibited bases (`compliance.board_report.delivered`) | Quarterly; enforced by `compliance.board_report_due_at` |

**ALERTS/METRICS:** Alert if `compliance.guarded_attributes` or `compliance.guardrails` is modified without a logged CCO approval event. Alert if any `fair_lending.discouragement.reported` event is not followed by a CCO notification within 1 business day. Target: zero unresolved discouragement reports older than 5 business days.

---

## FL-02 — Permissible Inquiries {#fl-02-permissible-inquiries}

**WHY (Reg cite):** [ECOA/Reg B §1002.5](https://www.ecfr.gov/current/title-12/section-1002.5) limits permissible inquiries about marital status, sex, childbearing, and immigration status, and requires specific disclosures before sensitive fields are collected. [ECOA/Reg B §1002.6](https://www.ecfr.gov/current/title-12/section-1002.6) governs permissible evaluation criteria. FFIEC Compliance Management Analysis Checklist §A.1b requires that training and application-processing aids correctly describe prohibited-basis inquiry rules and Reg B substantive requirements.

**SYSTEM BEHAVIOR:** Application forms are configured to collect only permissible information. Sensitive fields (marital status for joint/secured credit, spouse information, immigration status) are gated: the system presents required disclosures before rendering those fields, and the form blocks submission if a required disclosure has not been acknowledged. Sex may not be inquired; a title designation field (Ms./Mr./Mrs.) is optional and disclosed as such. Childbearing or birth-control inquiries are blocked at the form level. Marital status for individual unsecured credit is suppressed unless the applicant resides in a community property state or relies on community property. The form template is version-controlled; changes require Compliance approval before deployment. Compliance is write-restricted to the form template configuration. The 100% disclosure-presented target is enforced by the `application.disclosures.presented` event gate — no application may advance past the sensitive-field section without this event being recorded.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Application form renders sensitive fields (`application.form.rendered`) | Applicant state (`applicant.state`), credit type (`loan_application.product_type`), channel (`loan_application.channel`) | Required disclosures presented and acknowledged (`application.disclosures.presented`) | Before sensitive fields are displayed; enforced by form gate |
| Form template change proposed | Proposed diff, Compliance approval (`compliance.guarded_attributes`), change rationale | Approved template version published (`form.template.approved`); prior version archived | Before deployment; no production change without approval event |
| Quarterly QC sample of applications | Random sample of completed applications, disclosure acknowledgment records | QC finding report; any deficiency logged (`finding.opened`) | Within 30 days of quarter close |

**ALERTS/METRICS:** Alert if any `loan_application.completed` event is not preceded by `application.disclosures.presented` for the same application ID. Target: 100% of applications with required disclosures presented. Alert on any form template deployment without a logged Compliance approval.

---

## FL-03 — Evaluation & Pricing Rules {#fl-03-evaluation--pricing-rules}

**WHY (Reg cite):** [ECOA/Reg B §1002.6](https://www.ecfr.gov/current/title-12/section-1002.6) requires that evaluation criteria be demonstrably and statistically sound (for scored systems) or documented judgmental criteria, prohibits assigning negative factors to elderly applicants' age, and requires equal treatment of public-assistance income. [Reg Z §1026.36(d)](https://www.ecfr.gov/current/title-12/section-1026.36#p-1026.36(d)) prohibits loan originator compensation based on loan terms. FFIEC risk factors U4–U8 (underwriting) and P1–P7 (pricing) are addressed by this control; FFIEC Checklist §A.1a requires documented, objective underwriting and pricing standards with monitored exceptions.

**SYSTEM BEHAVIOR:** Underwriting uses either a validated scoring model (empirically derived, demonstrably and statistically sound per Reg B §1002.6(b)(2)) or documented judgmental criteria — never both applied inconsistently across similarly situated applicants. The system blocks any scorecard variable that constitutes a prohibited basis (FFIEC risk factor O3). Age may not be assigned a negative factor or value for applicants 62 or older; the scoring engine enforces this constraint. Public-assistance income is treated identically to other income sources; the income-type field does not carry a negative weight. Any deviation from the rate sheet or standard pricing terms constitutes a pricing exception and must be captured in `pricing.exception_rationale` and `pricing.exception_demographics_summary` before the loan may proceed. Pricing exceptions require approval at the tier specified in the authority matrix; Compliance reviews all exceptions monthly by the 10th. The exception register is write-restricted to the originating loan officer for creation and to Compliance for review and closure. Edge case: a pricing exception granted for a documented, non-prohibited business reason (e.g., relationship pricing within policy limits) is permissible but must still be captured and reviewed.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Loan application decisioned (`loan_application.decisioned`) | Scoring model ID (`decision.model_id`), score block (`decision.score_block`), income type (`loan_application.income_assets`), applicant age (derived from `applicant` record), decision basis (`loan_application.action_basis`) | Decision recorded with full basis (`loan_application.adverse_action.decided` or approval event); score block attached if score used | At time of decision |
| Pricing exception identified (`pricing.exception.requested`) | Proposed price (`pricing.proposed_price`), sheet price (`pricing.sheet_price`), exception rationale (`pricing.exception_rationale`), approver (`pricing.exception_approver`), demographics summary (`pricing.exception_demographics_summary`) | Exception record created and logged (`pricing.exception.requested`); approval decision recorded (`pricing.exception.decided`) | Before loan proceeds; approval required |
| Monthly exception review by Compliance | All exceptions in period (`pricing.exception_period`), demographics summary (`pricing.exception_demographics_summary`) | Exception analytics report (`loan_exception.analytics.published`); any disparity finding escalated (`finding.opened`) | By 10th of following month; enforced by `pricing.exception_review_due_at` |
| Scorecard or judgmental criteria change proposed | Change description, validation evidence, Compliance approval | Credit config change approved and published (`credit_config.changed`); prior version archived | Before deployment |

**ALERTS/METRICS:** Alert if any `loan_application.decisioned` event lacks a `decision.model_id` or `decision.score_block` where a score was used. Alert if exception review is not completed by the 10th (`pricing.exception_review_due_at` breached). Monitor exception rate by loan officer, branch, and prohibited-basis group monthly; flag statistical outliers for Compliance review.

---

## FL-04 — Appraisal Independence & ROV {#fl-04-appraisal-independence--rov}

**WHY (Reg cite):** [ECOA/Reg B §1002.14](https://www.ecfr.gov/current/title-12/section-1002.14) requires prompt delivery of appraisals and written valuations and mandates a reconsideration-of-value (ROV) pathway. [NCUA 12 CFR §701.31](https://www.ecfr.gov/current/title-12/part-701/section-701.31) and interagency appraisal-independence rules prohibit production staff from influencing valuation outcomes. The [Fair Housing Act, 42 U.S.C. §3605](https://www.law.cornell.edu/uscode/text/42/3605) prohibits discriminatory appraisal practices. FFIEC Checklist §A.1c requires procedures ensuring appraisals are not used in a discriminatory manner.

**SYSTEM BEHAVIOR:** Valuation staff are organizationally separated from production (loan origination and sales); the system enforces this by restricting appraisal order assignment (`valuation.order.assigned`) to a Compliance-approved appraiser panel and blocking production staff from modifying appraisal inputs or outcomes. The Credit Union does not rely on appraisals known or suspected to reflect prohibited-basis bias; the `valuation.bias_screen_rules` field defines the screening criteria applied at appraisal receipt. A copy of every appraisal or written valuation is delivered to the applicant promptly after completion and no later than 3 business days before consummation, regardless of credit outcome, via `valuation.copy.sent`. The applicant's right to receive the copy is disclosed at application via `valuation.rights_disclosure.sent`. An ROV pathway is available to all applicants: requests are logged, reviewed within 15 calendar days, and outcomes recorded in the Fair-Lending Issue Register. Edge case: if an applicant waives the right to receive the appraisal copy, the waiver must be documented and retained; the 3-business-day pre-consummation delivery requirement cannot be waived.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Application created for first-lien dwelling (`application.first_lien.created`) | Applicant identity (`loan_party.identity`), product type (`loan_application.product_type`) | Appraisal rights disclosure sent (`valuation.rights_disclosure.sent`) | At application; before appraisal is ordered |
| Appraisal or valuation completed (`appraisal.completed`) | Appraisal document (`appraisal.document`), bias screen result (`valuation.bias_screen_rules`), completion date | Copy delivered to applicant (`valuation.copy.sent`); delivery logged | Promptly after completion; no later than 3 BD before consummation; enforced by `appraisal.delivery_due_at` |
| ROV requested by applicant (`valuation.rov.requested`) | Applicant identifier, basis for reconsideration, original appraisal reference | ROV opened; outcome decided and logged in Fair-Lending Issue Register (`valuation.rov.decided`; `fair_lending.record_appended`) | Within 15 calendar days of request; enforced by `valuation.rov_due_at` |
| Appraisal bias screen flags potential issue | Bias screen result (`valuation.bias_screen_rules`), appraisal value (`appraisal.value`) | Escalation to Compliance (`fair_lending.discouragement.reported` or `finding.opened`); appraiser panel review initiated | Immediate; before reliance on appraisal |

**ALERTS/METRICS:** Alert if `valuation.copy.sent` is not recorded within 3 business days of `appraisal.completed` for any first-lien application. Alert if `valuation.rov.decided` is not recorded within 15 calendar days of `valuation.rov.requested` (`valuation.rov_due_at` breached). Monitor ROV outcomes by prohibited-basis group quarterly for disparity patterns.

---

## FL-05 — Action-Taken Notices {#fl-05-action-taken-notices}

**WHY (Reg cite):** [ECOA/Reg B §1002.9](https://www.ecfr.gov/current/title-12/section-1002.9) requires timely adverse action notices (AANs) with specific reasons and, where a credit score is used, a score disclosure block. [FCRA §615](https://www.law.cornell.edu/uscode/text/15/1681m) requires additional disclosures when adverse action is based in whole or in part on a consumer report. FFIEC Checklist §A.1a requires that denial reasons be accurately and promptly communicated.

**SYSTEM BEHAVIOR:** The system generates and queues AANs automatically upon a decisioning event. For completed applications (approve, counter, deny), the AAN must be issued within 30 calendar days of the completed application date. For incomplete applications, the AAN or incompleteness notice must be issued within 30 calendar days of the incompleteness determination. For existing-account adverse actions, the AAN must be issued within 30 calendar days of the action. For counteroffers not accepted within 90 days, the system automatically issues an AAN at day 90. For small-business phone credit (applicant revenue ≤$1MM), an oral adverse decision must be communicated within a reasonable time; a written AAN must be provided within 30 days if the applicant requests it. Where a credit score was used in the decision, the score block (`decision.score_block`) is automatically appended to the AAN. Edge case: a counteroffer accepted within 90 days requires no AAN — the system suppresses the 90-day AAN queue item upon acceptance. The AAN generation module is write-restricted to the system; manual overrides require Compliance approval and are logged. The on-time rate target is ≥99.5% with zero regulatory deadline breaches.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Completed application decisioned adversely (`loan_application.adverse_action.decided`) | Applicant identity (`loan_party.identity`), decision basis (`loan_application.action_basis`), reason codes (`loan_application.adverse_action`), score block if applicable (`decision.score_block`), FCRA flag if consumer report used | AAN with specific reasons + score block if score used (`aan.issued`); FCRA notice if applicable | 30 calendar days of completed application; enforced by `loan_application.aan_due_at` |
| Incomplete application aged (`loan_application.incomplete.detected`) | Applicant identity, missing items (`loan_application.incompleteness_notice`), application date | AAN or incompleteness notice (`notice.incompleteness.sent` or `aan.issued`) | 30 calendar days of incompleteness determination; enforced by `application.notice_due_at` |
| Existing-account adverse action decided (`account.adverse_action.decided`) | Account identifier, action basis (`account.adverse_action`), reason codes | AAN with specific reasons (`aan.issued`) | 30 calendar days of action; enforced by `loan_account.aan_due_at` |
| Counteroffer issued and not accepted within 90 days (`loan_application.counteroffer.expired`) | Counteroffer terms (`loan_application.counteroffer_terms`), counteroffer date, applicant identity | AAN (`aan.issued`) | 90 calendar days from counteroffer; enforced by `loan_application.counteroffer_aan_due_at` |
| Small-business phone credit — oral adverse decision (`loan_application.oral_adverse_decision`) | Applicant revenue tier (`applicant.business_revenue_tier`), oral decision record (`loan_application.oral_statement`) | Oral decision logged (`notice.oral.logged`); written AAN queued if requested (`aan.queued`) | Oral: reasonable time; written: 30 days if requested |

**ALERTS/METRICS:** Alert if any `loan_application.aan_due_at`, `loan_account.aan_due_at`, or `loan_application.counteroffer_aan_due_at` timer reaches T-2 business days without a corresponding `aan.issued` event. Dashboard metric: AAN on-time rate (target ≥99.5%); zero breaches of regulatory deadlines. Monthly aging report of open AAN obligations reviewed by Compliance.

---

## FL-06 — Government Monitoring (GMI/HMDA) {#fl-06-government-monitoring-gmihmda}

**WHY (Reg cite):** [ECOA/Reg B §1002.13](https://www.ecfr.gov/current/title-12/section-1002.13) requires collection of government monitoring information (GMI) for applications primarily for the purchase or refinancing of a principal-residence dwelling secured by that dwelling. [HMDA/Reg C 12 CFR Part 1003, §1003.4](https://www.ecfr.gov/current/title-12/part-1003) governs LAR data collection, maintenance, and submission for covered institutions. FFIEC Compliance Management Analysis Checklist §A.1 and risk factor C2 require that prohibited-basis monitoring information be complete and accurate.

**SYSTEM BEHAVIOR:** For every HMDA-covered application (`application.hmda_covered.created`), the system presents GMI fields (ethnicity, race, sex) to the applicant and records responses in `loan_application.gmi`. Collection is requested but not required; the applicant may decline. If the applicant declines or does not provide GMI in a face-to-face or video application, staff must record ethnicity and race based on visual observation or surname per Reg B §1002.13(b) and Reg C §1003.4(a)(10)(i); this is recorded in `applicant.gmi_responses` with the method noted. GMI data is stored separately from the credit decision file and is not accessible to underwriters during the decisioning process. The LAR is updated within the period required by Reg C; quarterly QC reviews validate LAR accuracy against source loan files. Annual submission occurs per the Reg C calendar. Pynthia's HMDA reporter status is confirmed annually by Compliance; if Pynthia is not a HMDA reporter in a given year, GMI collection under Reg B §1002.13 still applies to covered applications, and the LAR obligation is noted as inapplicable for that year.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| HMDA-covered application created (`application.hmda_covered.created`) | Product type, lien status (`application.first_lien`), dwelling purpose | GMI fields presented to applicant; response or visual/surname observation recorded (`hmda.gmi.recorded`; `applicant.gmi_responses`) | At application |
| Applicant declines to provide GMI (face-to-face or video) | Applicant identity, observation basis | Visual/surname GMI recorded with method flag (`hmda.gmi.recorded`) | At application |
| LAR row recorded for covered transaction (`hmda.lar_row.recorded`) | All required Reg C data fields, GMI, action taken, property location (`loan_application.geography`) | LAR row created and logged (`hmda.lar_row.recorded`) | Within Reg C required period |
| Quarterly LAR QC (`analytics.quarter.closed`) | LAR extract, sample of source loan files, QC protocol | QC report; errors corrected; findings logged (`hmda.lar_qc.completed`; `finding.opened` if errors found) | Within 30 days of quarter close; enforced by `hmda.lar_qc_due_at` |
| Annual LAR submission window opens (`hmda.submission_window_open`) | Final LAR, QC sign-off, Compliance approval | LAR submitted to CFPB (`hmda.lar.submitted`) | Per Reg C calendar (generally March 1); enforced by `hmda.submission_due_at` |

**ALERTS/METRICS:** Alert if any HMDA-covered application lacks a `hmda.gmi.recorded` event. Alert if `hmda.lar_qc_due_at` is breached. Monitor LAR error rate from QC samples; target <1% error rate. Alert if `hmda.submission_due_at` is within 10 business days without a submitted LAR.

---

## FL-07 — Advertising & Fair Housing {#fl-07-advertising--fair-housing}

**WHY (Reg cite):** [Reg Z §1026.24](https://www.ecfr.gov/current/title-12/section-1026.24) governs trigger-term disclosures and APR prominence in credit advertising. The [Fair Housing Act, 42 U.S.C. §3605](https://www.law.cornell.edu/uscode/text/42/3605) and [24 CFR Part 100](https://www.ecfr.gov/current/title-24/part-100) require the Equal Housing Lender legend on real-estate-related advertising and prohibit exclusionary marketing. [ADA, 28 CFR Part 36](https://www.ecfr.gov/current/title-28/part-36) requires reasonable accommodations in digital marketing and application flows for applicants with disabilities. FFIEC risk factors M1–M7 address discriminatory marketing practices; FFIEC Checklist §A.1e requires procedures to prevent prohibited-basis limitations in advertising.

**SYSTEM BEHAVIOR:** Pynthia does not currently anticipate significant consumer advertising; however, these controls are always-on requirements that apply at any volume and scale with advertising activity. Every advertisement for a credit product must complete a pre-flight checklist (`ad.preflight.submitted` → `ad.preflight.decided`) before launch; no ad may be published without a recorded approval. The checklist verifies: (1) trigger-term disclosures and APR prominence per Reg Z §1026.24; (2) Equal Housing Lender legend for real-estate-related ads; (3) absence of prohibited-basis language, code words, or imagery; (4) geo-targeting screen confirming no exclusion of minority-concentrated census tracts or ZIP codes within the marketing area (`ad.targeting_screen.completed`); and (5) ADA/accessibility check for digital ads and application flows (`ad.accessibility_check`). Exclusionary geo-targeting — defined as excluding geographies with demonstrably higher minority concentrations than the remainder of the marketing area, where those geographies have similar income and credit characteristics — is prohibited. Any advertising program is assessed at least annually (or upon material program change) to confirm it is not systematically excluding prohibited-basis group members from the institution's market, covering media selection, geo-targeting, and intermediary relationships (`advertising.reach_review.completed`). Marketing through intermediaries known to serve only one racial or ethnic group is prohibited. The pre-flight checklist and reach review are write-restricted to Marketing for creation and to Compliance for approval.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Ad created and submitted for pre-flight (`ad.preflight.submitted`) | Ad creative (`ad.creative`), audience definition (`ad.audience_definition`), targeting parameters (`ad.targeting_screen`), medium, product type | Pre-flight checklist completed and decided (`ad.preflight.decided`); targeting screen result logged (`ad.targeting_screen.completed`); accessibility check logged (`ad.accessibility_check`) | Before launch; no publication without approval |
| Ad published (`advertising.published`) | Approved pre-flight record, publication details (`advertising.publication`) | Publication logged (`advertising.publication.logged`) | At publication |
| Annual (or material-change) demographic reach review (`advertising.reach_review.completed`) | Media selection records, geo-targeting parameters, intermediary list, minority-concentration data for marketing area | Reach review report; any exclusionary pattern flagged as finding (`finding.opened`); corrective action if needed | Annually or upon material program change; enforced by `advertising.reach_review_due` |
| Digital application flow accessibility review | ADA compliance checklist, WCAG criteria | Accessibility review result logged (`ad.accessibility_check`); remediation if deficiency found (`finding.opened`) | At launch of new digital channel or material redesign; at least annually |

**ALERTS/METRICS:** Alert if any `advertising.published` event is not preceded by `ad.preflight.decided` (approved) for the same ad ID. Target: 100% of ads with completed pre-flight checklist. Alert if `advertising.reach_review_due` is breached. Monitor geo-targeting parameters for any exclusion of minority-concentrated areas; flag for Compliance review before launch.

---

## FL-08 — LO Compensation & Anti-Steering {#fl-08-lo-compensation--anti-steering}

**WHY (Reg cite):** [Reg Z §1026.36(d)](https://www.ecfr.gov/current/title-12/section-1026.36#p-1026.36(d)) prohibits loan originator compensation based on loan terms or proxies for loan terms. [Reg Z §1026.36(e)](https://www.ecfr.gov/current/title-12/section-1026.36#p-1026.36(e)) requires that loan originators present loan options and prohibits steering consumers to less advantageous products. FFIEC risk factors S1–S8 (steering) and P1–P2 (pricing discretion) are addressed by this control; FFIEC Checklist §A.1e prohibits financial incentives for loan officers to place applicants in nontraditional or higher-cost products.

**SYSTEM BEHAVIOR:** Loan originator compensation plans are reviewed and approved by Compliance before implementation; no plan may include compensation based on loan terms (interest rate, APR, points, fees) or proxies for loan terms. The approved plan terms are recorded in `lo_comp.plan_terms` and `lo_comp.basis_analysis`. When an applicant qualifies for multiple loan products, the system requires the loan officer to present and document at least three eligible options: the option with the lowest interest rate, the option with the lowest total origination costs, and the option with the lowest total cost (APR). These options are recorded in `application.options` before the applicant selects a product (`application.option_selection.started`). Finalization of the loan is blocked (`loan_application.decisioned` gate) until evidence of options presentation is recorded. If fewer than three eligible options exist for a given applicant, a Compliance waiver is required (`application.option_waiver.decided`) and the shortfall reason is documented (`loan_application.option_shortfall_reason`). Steering — directing applicants to less advantageous products on a prohibited basis — is prohibited. The LO comp plan and options-presentation records are write-restricted to Compliance for approval; loan officers may not modify the options record after presentation.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| LO compensation plan submitted for approval (`lo_comp.plan.submitted`) | Plan terms (`lo_comp.plan_terms`), basis analysis (`lo_comp.basis_analysis`), Compliance review | Plan approved or rejected (`lo_comp.plan.decided`); approved plan recorded | Before implementation; annual review |
| Applicant qualifies for product selection (`application.option_selection.started`) | Eligible product list (`application.options`), rate/fee/APR for each option, applicant qualifications | Three options (lowest rate, lowest fees, lowest total cost) presented and logged (`application.options.presented`) | Before product selection; gate enforced |
| Fewer than three eligible options exist (`application.option_shortfall.detected`) | Shortfall reason (`loan_application.option_shortfall_reason`), available options | Compliance waiver requested and decided (`application.option_waiver.decided`) | Before finalization; waiver required |
| Loan application finalized (`loan_application.decisioned`) | Options presentation record (`application.option_selection`), waiver if applicable (`application.option_waiver`) | Final action recorded (`application.final_action.recorded`); gate confirms options evidence present | At decisioning; blocked without evidence |
| Quarterly steering review (`steering_review.completed`) | LO comp plan, options-presentation records, product placement data by prohibited-basis group | Steering review report; any disparity finding escalated (`finding.opened`) | Quarterly; enforced by `steering_review.due` |

**ALERTS/METRICS:** Alert if any `loan_application.decisioned` event lacks a corresponding `application.options.presented` or `application.option_waiver.decided` event. Alert if any LO comp plan is implemented without a logged `lo_comp.plan.decided` (approved) event. Monitor product placement rates by prohibited-basis group quarterly; flag statistical outliers for Compliance review.

---

## FL-09 — Third-Party Fair-Lending Oversight {#fl-09-third-party-fair-lending-oversight}

**WHY (Reg cite):** [ECOA/Reg B §1002.4](https://www.ecfr.gov/current/title-12/section-1002.4) makes the Credit Union liable for fair-lending violations by third parties acting on its behalf. The [Fair Housing Act, 42 U.S.C. §3605](https://www.law.cornell.edu/uscode/text/42/3605) extends this liability to residential real-estate transactions. FFIEC Exam Procedures Part I (Understanding Credit Operations) and FFIEC Checklist §A.1 require institutions to understand and monitor third-party fair-lending conduct; FFIEC risk factors U8–U9, P5, and M3 specifically address broker/agent compensation and complaint patterns.

**SYSTEM BEHAVIOR:** Before onboarding any third party that participates in the credit process (brokers, agents, servicers, marketing intermediaries), Compliance conducts fair-lending due diligence (`vendor.fl_dd.completed`) covering the third party's fair-lending policies, complaint history, compensation structure, and geographic reach. The due diligence result is recorded in `vendor.fl_dd`. Contracts with third parties include fair-lending compliance representations and audit rights. Each active third party submits a monthly Fair-Lending MI pack by the 5th business day of the following month, containing: application volume by prohibited-basis group (where available), approval and denial rates, pricing data, exception counts, and complaint counts. The MI pack is recorded in `vendor.mi_pack` and reviewed by Compliance. If the MI pack reveals a disparity or pattern of concern, Compliance issues a corrective action plan (`vendor.cap.issued`) and tracks remediation to closure. Third parties that fail to submit the MI pack on time or that demonstrate persistent fair-lending deficiencies are escalated to the CCO and may be terminated. Third-party oversight mechanics (onboarding, contract management, termination) are governed by the Third-Party Risk Policy; this control addresses only the fair-lending-specific requirements.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Third party proposed for onboarding (`vendor.engagement.proposed`) | Third-party identity, service description, fair-lending due diligence package (`vendor.fl_dd`) | Fair-lending DD completed and recorded (`vendor.fl_dd.completed`); onboarding blocked without approval | Before contract execution |
| Monthly MI pack due (`vendor.mi_due_at`) | Application volume, approval/denial rates, pricing data, exception counts, complaint counts (`vendor.mi_pack`) | MI pack received and reviewed (`vendor.mi.reviewed`); any disparity finding logged (`finding.opened`) | By 5th business day of month; enforced by `vendor.mi_due_at` |
| MI pack reveals disparity or pattern of concern | MI pack data, prior period trend (`vendor.mi_trends`), prohibited-basis breakdown | CAP issued (`vendor.cap.issued`); remediation tracked to closure (`vendor.remediation_due`) | CAP issued within 10 business days of identification |
| Third party fails to submit MI pack on time | Missing MI pack, prior submission history | Escalation to CCO (`escalation.created`); corrective action initiated | Within 2 business days of missed deadline |
| Annual third-party fair-lending review | Prior year MI packs, complaint data, DD refresh | Annual review completed (`vendor.review.completed`); findings reported to Board | Annually; enforced by `vendor.annual_review_due_at` |

**ALERTS/METRICS:** Alert if `vendor.mi_due_at` passes without a `vendor.mi.reviewed` event for any active third party. Alert if a CAP is not issued within 10 business days of a disparity finding. Monitor third-party MI pack submission timeliness monthly; target 100% on-time submission.

---

## FL-10 — Monitoring & Disparity Reviews {#fl-10-monitoring--disparity-reviews}

**WHY (Reg cite):** [ECOA/Reg B §1002.4](https://www.ecfr.gov/current/title-12/section-1002.4) and the [Fair Housing Act, 42 U.S.C. §3605](https://www.law.cornell.edu/uscode/text/42/3605) require ongoing compliance. FFIEC Exam Procedures Part I (Steps 4–7) and Part III.G (Redlining Analysis) establish the examination framework for disparity and redlining reviews. FFIEC risk factors U1–U3 (underwriting disparities), P4–P6 (pricing disparities), R1–R12 (redlining), and FFIEC Checklist §A.2 (self-evaluation/self-test) are addressed by this control.

**SYSTEM BEHAVIOR:** Compliance runs quarterly disparity analytics covering applications, approvals, denials, pricing, terms, and exceptions, segmented by prohibited-basis group (race/ethnicity, sex, age, income source) and by loan officer, branch, and product type. Results are due within 30 days of quarter close. Disparity deltas exceeding defined thresholds trigger a corrective action plan (CAP) within 30 days of identification. **[THRESHOLD NEEDED: Compliance must define specific disparity thresholds (e.g., approval-rate gap, pricing spread) that trigger a CAP before the next examination. This is a pre-exam priority.]** The annual redlining review is completed by end of Q1 and covers the following methodology, consistent with FFIEC Part III.G: (1) Identify and delineate minority-character areas within the Credit Union's CRA assessment area and reasonably expected market area, using census-tract-level minority-concentration data organized in quartiles (0–25%, 25–50%, 50–75%, >75%); (2) Determine whether any minority area is excluded, underserved, or selectively excluded from marketing, using HMDA LAR data and peer comparison data; (3) Identify non-minority areas treated more favorably; (4) Identify minority areas just outside the CRA assessment area that may be purposely avoided; (5) Obtain and evaluate the Credit Union's explanation for any apparent difference in treatment; (6) Obtain and evaluate other information (marketing records, peer performance, complaint data) that supports or contradicts a redlining finding. The redlining review dataset includes the Credit Union's CRA assessment area, census-tract-level lending distribution by minority-concentration quartile, peer comparison data from HMDA aggregate data, and the six-step comparative analysis framework above. Quarterly disparity reports and the annual redlining review are presented to the Board. The analytics dataset version is recorded in `analytics.lending_dataset` and `analytics.geo_lending_dataset`. Compliance is write-restricted to the analytics configuration; Analytics produces the reports under Compliance direction.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Quarter closes (`analytics.quarter.closed`) | Lending dataset (`analytics.lending_dataset`), prohibited-basis group data, exception register, complaint pattern summary | Disparity report completed (`analytics.disparity_report.completed`); threshold breach triggers CAP (`analytics.cap.opened`) | Within 30 days of quarter close; enforced by `analytics.disparity_due_at` |
| Disparity threshold breached (`analytics.threshold.breached`) | Disparity report, affected segment, threshold definition **[THRESHOLD NEEDED]** | CAP opened (`analytics.cap.opened`); CCO notified; Board reported at next quarterly cycle | CAP initiated within 30 days of identification |
| Q1 annual redlining review trigger | Geo lending dataset (`analytics.geo_lending_dataset`), CRA assessment area map, census-tract minority-concentration data (quartile), peer HMDA data, marketing records | Redlining review completed (`analytics.redlining_review.completed`); findings reported to Board | By end of Q1; enforced by `analytics.redlining_due_at` |
| Quarterly Board compliance report due (`compliance.board_report_due_at`) | Disparity report, redlining review (Q1), CAP status, complaint pattern summary (from FL-13) | Board compliance report delivered (`compliance.board_report.delivered`) | Quarterly; enforced by `compliance.board_report_due_at` |

**ALERTS/METRICS:** Alert if `analytics.disparity_due_at` is breached. Alert if `analytics.redlining_due_at` is breached. Alert if a CAP is not opened within 30 days of a threshold breach. Monitor CAP closure rates monthly. **[THRESHOLD NEEDED: Disparity thresholds for CAP triggers must be defined by Compliance before the next examination.]**

---

## FL-11 — Training {#fl-11-training}

**WHY (Reg cite):** [ECOA/Reg B §1002.4](https://www.ecfr.gov/current/title-12/section-1002.4) and the [Fair Housing Act, 42 U.S.C. §3605](https://www.law.cornell.edu/uscode/text/42/3605) require that all staff involved in credit decisions understand and comply with fair-lending obligations. FFIEC risk factor C7 identifies weak or nonexistent fair-lending training as a compliance program deficiency; FFIEC Checklist §A.1b requires that training correctly describe prohibited bases, Reg B substantive requirements, and inquiry-stage discouragement prohibitions.

**SYSTEM BEHAVIOR:** All staff, contractors, and third-party personnel with credit-related responsibilities receive role-based fair-lending training. New hires and personnel assuming a new credit-related role must complete onboarding training within 30 days of role start (`training.newhire_due_at`). All covered personnel must complete annual training by December 31 of each year (`training.annual_due_at`). Training content is role-differentiated: loan officers receive training on evaluation criteria, pricing, anti-steering, and inquiry-stage discouragement; underwriters receive training on scoring, exceptions, and disparate treatment; marketing staff receive training on advertising rules and geo-targeting; management receives training on monitoring, oversight, and Board reporting. Training content is refreshed whenever a material regulatory change or new product introduction occurs (`training.content_trigger.detected`). Completion is tracked in `training.completion_status` and `training.coverage_pct`; the target completion rate is ≥98%. Incomplete training is escalated to HR and the relevant manager. Training records are retained per FL-12. Compliance is write-restricted to the training curriculum configuration; HR tracks completion.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Employee hired or assumes credit-related role (`employee.hired`) | Role (`employee.role`), hire date (`training.hire_date`), role curriculum (`training.role_curriculum`) | Onboarding training assigned (`training.assignment.created`); completion recorded (`training.onboarding.completed`) | Within 30 days of role start; enforced by `training.newhire_due_at` |
| Annual training cycle opens (`training.annual_cycle.opened`) | Role matrix (`training.role_matrix`), curriculum version (`training.content_version`), covered personnel list | Annual training assigned to all covered personnel (`training.annual.assigned`); completion recorded (`training.completion.recorded`) | By December 31; enforced by `training.annual_due_at` |
| Material regulatory change or new product (`training.content_trigger.detected`) | Change description, affected curriculum modules | Refresher training issued (`training.refresh.issued`); completion tracked | Within 60 days of change identification |
| Annual training cycle closes | Completion records, coverage percentage (`training.coverage_pct`) | Coverage report; any incomplete escalated to HR (`finding.opened` if <98%) | By January 15 of following year |

**ALERTS/METRICS:** Alert if `training.newhire_due_at` is breached for any new hire. Alert if `training.annual_due_at` is within 30 days and coverage is below 98%. Monitor training completion rate monthly; target ≥98%. Alert if a refresher training is not issued within 60 days of a `training.content_trigger.detected` event.

---

## FL-12 — Record Retention {#fl-12-record-retention}

**WHY (Reg cite):** [ECOA/Reg B §1002.12](https://www.ecfr.gov/current/title-12/section-1002.12) establishes minimum retention periods for credit applications, evaluation data, AANs, and self-tests. [HMDA/Reg C §1003.4](https://www.ecfr.gov/current/title-12/part-1003) governs LAR retention. [Reg Z §1026.36](https://www.ecfr.gov/current/title-12/section-1026.36) governs LO compensation record retention. FFIEC Checklist §A.1 requires that recordkeeping support examination review.

**SYSTEM BEHAVIOR:** The system applies retention schedules automatically at the time of action taken, using `record.retention_clock_set` to anchor the retention period. Retention periods by record type: consumer credit applications, evaluation data, and AANs — 25 months from notice of action; existing-account adverse action records — 25 months; business credit ≤$1MM — 12 months; business credit >$1MM — 60 days, extended to 12 months if the applicant requests reasons or retention in writing; HMDA/GMI data — per Reg C calendar; LO compensation records — per Reg Z; self-tests — 25 months (self-test reports and results are privileged under Reg B §1002.15 unless voluntarily disclosed). Compliance is write-restricted to retention schedule configuration. Hold/destruction lifecycle mechanics after clock-setting are governed by [SC-02](#sc-02-record-retention-lifecycle-mechanics) embedded in this policy.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Notice of action taken on consumer application (`loan_application.decisioned` or `aan.issued`) | Record type (`retention.record_type`), action date, applicant identifier | Retention clock set (`record.retention_clock_set`); retention expires at 25 months (`record.retention_expires_at`) | At time of action |
| Notice of action taken on business credit ≤$1MM | Record type, action date, business revenue tier (`applicant.business_revenue_tier`) | Retention clock set; expires at 12 months (`record.retention_expires_at`) | At time of action |
| Notice of action taken on business credit >$1MM | Record type, action date, applicant request for reasons or retention | Retention clock set; expires at 60 days or 12 months if requested (`record.retention_expires_at`) | At time of action; extended if request received |
| Self-test completed | Self-test type, scope, results (privileged) | Retention clock set at 25 months (`record.retention_clock_set`); privileged flag applied | At completion |

**ALERTS/METRICS:** Alert if any record reaches `record.retention_expires_at` without a `record.disposed` or active `record.legal_hold_flag`. Monitor destruction queue monthly for records past expiry without disposition. Hold, destruction, and permanent-record alerts are governed by [SC-02](#sc-02-record-retention-lifecycle-mechanics).

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

## FL-13 — Complaint Monitoring {#fl-13-complaint-monitoring}

**WHY (Reg cite):** [ECOA/Reg B §1002.4](https://www.ecfr.gov/current/title-12/section-1002.4) and the [Fair Housing Act, 42 U.S.C. §3605](https://www.law.cornell.edu/uscode/text/42/3605) require that the Credit Union identify and remediate discriminatory conduct, including patterns identified through complaint monitoring. [NCUA 12 CFR §701.31](https://www.ecfr.gov/current/title-12/part-701/section-701.31) imposes parallel obligations. FFIEC risk factors U9 (underwriting complaints), P5 (pricing complaints), S7 (steering complaints), and M7 (marketing complaints) all ask whether management monitors discrimination complaints. FFIEC Compliance Management Analysis Checklist Appendix §A–B requires documented complaint intake, analysis, and response processes, including corrective measures for identified violations.

**SYSTEM BEHAVIOR:** Pynthia maintains a dedicated fair-lending complaint monitoring program as a standalone control. Complaints are captured from all channels — member-direct, CFPB portal, NCUA, state regulators, third-party partners, and internal staff referrals — and logged in the centralized complaint log within one business day of receipt. Each complaint record includes: date received (`complaint.channel`), channel, member/applicant identifier (`complaint.member_id`), product type, complaint description (`complaint.narrative`), and receiving staff member. Every complaint is screened within three business days for potential fair-lending relevance; a prohibited-basis flag is assigned covering all ECOA/Reg B protected classes (race, color, religion, national origin, sex, marital status, age, familial status, disability, income from public assistance, exercise of CCPA rights) and FHA protected classes where real-estate credit is involved. Complaints flagged as potentially fair-lending related are escalated immediately to Compliance. Compliance completes an initial fair-lending assessment within ten business days of escalation. If the complaint alleges or suggests disparate treatment, discriminatory pricing, inquiry-stage discouragement, redlining, or steering, it is logged in the Fair-Lending Issue Register (`fair_lending.record_appended`) and assigned a severity rating (Low / Medium / High / Potential Pattern). High-severity or pattern-potential complaints are escalated to the CCO within two business days of classification and reported to the Board at the next quarterly cycle. Compliance reviews the complaint log quarterly, segmented by prohibited basis, product type, loan officer, branch, and third-party partner, to identify emerging patterns. Any cluster of three or more complaints of the same type within a 12-month rolling window triggers a root-cause investigation and CAP within 30 days of identification. When a confirmed violation or pattern is identified, Compliance documents and tracks: (1) re-underwriting or reconsideration of affected applications; (2) credit offers or fee refunds where the member suffered quantifiable harm; (3) corrective action for responsible staff, loan officers, or third parties; and (4) process or system changes to prevent recurrence. Remediation status is tracked to closure in the Fair-Lending Issue Register with target timelines set at intake and monitored monthly. If Compliance determines that a pattern of violations may constitute a systemic or willful violation of ECOA, FHA, or related statutes, the CCO must assess self-referral obligations to the NCUA (and, where applicable, the CFPB or DOJ) in consultation with Legal; the self-referral assessment is documented and retained regardless of outcome. The complaint log and Fair-Lending Issue Register are write-restricted to Compliance for triage, assessment, and closure; receiving staff may create intake records only.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Complaint received from any channel (`complaint.received`) | Channel (`complaint.channel`), member/applicant identifier (`complaint.member_id`), product type, description (`complaint.narrative`), receiving staff | Complaint logged in centralized log (`complaint.logged`); acknowledgment sent (`complaint.acknowledged`) | Within 1 business day of receipt; enforced by `complaint.ack_due_at` |
| Complaint logged — prohibited-basis triage (`complaint.logged`) | Complaint record, prohibited-basis checklist (ECOA/FHA protected classes), product type | Prohibited-basis flag assigned; if flagged, escalated immediately to Compliance (`complaint.regulator.received` or internal escalation event); triage result recorded | Within 3 business days of logging |
| Complaint escalated to Compliance | Complaint record, prohibited-basis flag, product type, channel | Initial fair-lending assessment completed; severity rating assigned (Low/Medium/High/Potential Pattern); if warranted, logged in Fair-Lending Issue Register (`fair_lending.record_appended`) | Within 10 business days of escalation; enforced by `complaint.initial_response_due_at` |
| Complaint classified High or Potential Pattern | Severity rating, assessment memo, Fair-Lending Issue Register entry | CCO notified (`escalation.created`); Board queue flagged for next quarterly report | Within 2 business days of classification |
| Quarterly complaint pattern review (`complaint.trend.reported`) | Complaint log segmented by prohibited basis, product type, loan officer, branch, third-party partner; 12-month rolling window | Pattern analysis report; if ≥3 same-type complaints in 12-month window, root-cause investigation opened and CAP initiated (`analytics.cap.opened`; `fair_lending.remediation.opened`) | Within 30 days of quarter close; CAP within 30 days of pattern identification |
| Confirmed violation or pattern identified | Fair-Lending Issue Register entry, affected applications, harm assessment | Remediation plan documented: re-underwriting/reconsideration, credit offers/fee refunds, staff corrective action, process/system changes; tracked to closure (`fair_lending.remediation.closed`) | Remediation timelines set at intake; monitored monthly |
| Self-referral assessment triggered | Pattern of violations assessment, CCO determination, Legal consultation | Self-referral assessment documented and retained (`fair_lending.record_appended`); referral made to NCUA/CFPB/DOJ if warranted | Assessment completed within 30 days of CCO determination; referral per agency requirements |
| Monthly complaint log summary | All complaints in period, resolution status, prohibited-basis distribution | Monthly summary report to Compliance management (`complaint.trend.reported`) | By 10th of following month |
| Quarterly Board compliance report due (`compliance.board_report_due_at`) | Complaint pattern summary, High/Pattern complaints, CAP status, remediation outcomes | Fair-lending complaint section in Board compliance report (`compliance.board_report.delivered`) | Quarterly; enforced by `compliance.board_report_due_at` |
| Annual fair-lending complaint trend report | Full-year complaint data, year-over-year volume, prohibited-basis distribution, resolution times, remediation outcomes, self-referral activity | Annual trend report produced and retained (`complaint.trend.reported`) | By January 31 of following year |

**ALERTS/METRICS:** Alert if any complaint is not logged within 1 business day of receipt (`complaint.ack_due_at` breached). Alert if prohibited-basis triage is not completed within 3 business days of logging. Alert if Compliance initial assessment is not completed within 10 business days of escalation (`complaint.initial_response_due_at` breached). Alert if CCO escalation is not completed within 2 business days of High/Pattern classification. Alert if a pattern of ≥3 same-type complaints is identified without a CAP opened within 30 days. Monitor monthly: complaint volume by channel, prohibited-basis flag rate, escalation rate, and average resolution time.

---

## Governance & Sign-Off {#governance}

**Policy Owner:** Patrick Wilson, Chief Compliance Officer

**Approvers:**
- Patrick Wilson, Chief Compliance Officer

**Required Participants:** Lending Operations, Analytics, Third-Party Risk Management, Legal, HR, Marketing

**Review Cadence:** Annual review by policy anniversary date; interim review upon material regulatory change, new product introduction, or examination finding. Next scheduled review: 2026-07-01.

**Board Reporting:** Quarterly compliance report to the Board of Directors covering: prohibited-basis guardrail status, disparity analytics results, redlining review (Q1), AAN on-time rate, training completion rate, third-party MI pack status, complaint monitoring summary (including High/Pattern complaints and CAP status), and any self-referral activity.

**Cross-References:**
- Lending Policy (underwriting standards and credit policy)
- Collections Policy (collections operations beyond fair-lending conduct)
- Enterprise Risk Management Policy and Model Risk Management Program (scoring model governance)
- Third-Party Risk Policy (vendor onboarding and oversight mechanics)
- Privacy Policy (privacy notices and data handling)
- Record Retention Policy (general retention schedules)

**Examiner Readiness Note:** This policy is designed to satisfy the FFIEC Interagency Fair Lending Examination Procedures (Compliance Management Analysis Checklist, Appendix §A–B) and to address FFIEC risk factors O1–O5, U1–U9, P1–P7, S1–S8, R1–R12, and M1–M7. Controls FL-01 through FL-13 map directly to the checklist items. The annual redlining review methodology in FL-10 follows the six-step comparative analysis framework in FFIEC Part III.G. The complaint monitoring program in FL-13 satisfies the corrective-measures requirements in FFIEC Checklist §B.

---

## Assumptions & Gaps {#assumptions}

- **Engineering vocabulary is provisional.** Several field and event codes referenced in the control overlays above are not yet confirmed as registered in `core-vocabulary.json` for the lending domain. The following codes are used per the Composition grammar and provisional-code list and will be confirmed by engineering before the next review: `loan_application.option_shortfall_reason`, `loan_application.oral_adverse_decision`, `loan_application.oral_statement`, `loan_application.counteroffer_terms`, `loan_application.product_type`, `loan_application.income_assets`, `loan_application.action_basis`, `loan_application.adverse_action`, `loan_application.gmi`, `loan_application.geography`, `applicant.business_revenue_tier`, `applicant.gmi_responses`, `applicant.state`, `application.counteroffer_status`, `application.option_shortfall_reason`, `application.oral_adverse_decision`, `application.option_selection`, `application.option_waiver`, `application.options`, `application.first_lien`, `application.hmda_covered`, `application.disclosures`, `application.notice_due_at`, `application.counteroffer_due_at`, `ad.accessibility_check`, `ad.audience_definition`, `ad.creative`, `ad.preflight`, `ad.targeting_screen`, `advertising.reach_review_due`, `valuation.bias_screen_rules`, `valuation.rights_disclosure`, `valuation.copy`, `valuation.rov_due_at`, `lo_comp.plan_terms`, `lo_comp.basis_analysis`, `compliance.guarded_attributes`, `compliance.guardrails`, `compliance.change_rationale`, `fair_lending.discouragement`, `fair_lending.finding_id`, `fair_lending.remediation_due_at`, `complaint.narrative`, `complaint.member_id`, `complaint.channel`, `pricing.exception_rationale`, `pricing.exception_demographics_summary`, `pricing.exception_approver`, `pricing.proposed_price`, `pricing.sheet_price`, `pricing.exception_period`, `analytics.lending_dataset`, `analytics.geo_lending_dataset`, `analytics.disparity_due_at`, `analytics.redlining_due_at`, `analytics.cap`, `analytics.cohort_threshold`, `vendor.fl_dd`, `vendor.mi_pack`, `vendor.mi_trends`, `vendor.mi_due_at`, `vendor.cap`, `vendor.remediation_due`, `training.role_curriculum`, `training.content_version`, `training.coverage_pct`, `training.content_trigger`, `retention.record_type`, `retention.schedule`, `record.hold_matter`, `record.hold_scope`, `record.hold_status`, `document.legal_hold_flag`. All codes follow the registered object/action/task-type grammar; none mint new objects or actions.

- **Disparity thresholds are undefined.** Compliance has not yet defined the specific numeric thresholds (e.g., approval-rate gap, pricing spread, denial-rate differential) that trigger a CAP under FL-10. A `[THRESHOLD NEEDED]` placeholder is included in FL-10. This is a pre-examination priority; thresholds must be defined, documented in `compliance.disparity_thresholds`, and approved by the CCO before the next NCUA examination.

- **HMDA reporter status requires annual confirmation.** This policy assumes Pynthia is subject to HMDA/Reg C reporting obligations. Compliance must confirm Pynthia's HMDA reporter status annually based on asset size, loan volume, and location thresholds under 12 CFR §1003.2. If Pynthia is not a HMDA reporter in a given year, the LAR submission obligation in FL-06 is inapplicable, but GMI collection under Reg B §1002.13 continues for covered applications.

- **Small-business phone credit "reasonable time" standard.** Reg B §1002.9(a)(1)(ii) requires action-taken notice within a "reasonable time" for business credit applications made by telephone. This policy interprets "reasonable time" as consistent with the 30-day standard for written applications, with a written AAN provided within 30 days if requested. Compliance should confirm this interpretation with Legal and document it in a procedure.

- **Self-referral assessment procedure.** The self-referral assessment obligation in FL-13 requires Legal consultation. A documented procedure for conducting and retaining the self-referral assessment (including the criteria for determining systemic or willful violations and the process for consulting with NCUA, CFPB, and DOJ) should be developed by Compliance and Legal and referenced from this policy. This procedure does not currently exist and should be created before the next examination.

- **Proxy guardrail definitions.** The specific proxy variables prohibited under FL-01 (e.g., which ZIP codes or neighborhood characteristics constitute prohibited proxies, property age thresholds) are maintained in `compliance.guardrails` and are not enumerated in this policy. Compliance must ensure the guardrail list is current, documented, and available for examiner review.

- **ADA/accessibility review scope.** FL-07 requires ADA/accessibility review of digital marketing and application flows per 28 CFR Part 36. The specific WCAG conformance level and review methodology (internal vs. third-party) have not been specified. Compliance and IT should define the accessibility standard and review cadence in a procedure document referenced from FL-07.

- **Third-party fair-lending due diligence criteria.** The specific criteria for the fair-lending due diligence conducted at vendor onboarding (FL-09) are not enumerated in this policy. Compliance should document the due diligence checklist (covering fair-lending policies, complaint history, compensation structure, geographic reach, and prohibited-basis monitoring) in a procedure document referenced from FL-09.

- **Redlining peer comparison data source.** FL-10 requires peer comparison data for the annual redlining review. The specific data source (HMDA aggregate data, FFIEC peer reports, or other) and the methodology for selecting peer institutions have not been specified. Compliance and Analytics should document the peer selection methodology before the next Q1 redlining review.
```
