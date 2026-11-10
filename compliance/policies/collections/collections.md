```yaml
---
title: Collections Policy (Table-First, Design-Overlay v3)
owner: Patrick Wilson, Chief Compliance Officer
version: v1.0
effective: 2026-07-01
next_review: 2027-07-01
approvers:
  - Patrick Wilson, Chief Compliance Officer
tags: [Compliance, Collections, Delinquency, Charge-Off, FDCPA, FCRA, UDAAP, NCUA]
---
```

## General Policy Statement

Pynthia Credit Union is committed to recognizing, monitoring, and controlling loan delinquencies and overdrafts in a timely and consistent manner; classifying and charging off loans with a high probability of loss in accordance with FFIEC retail credit guidance; and treating members fairly and lawfully in all collection, forbearance, problem-loan, foreclosure, and complaint-handling activities. This policy applies to all consumer and small-business credit products the credit union originates or services — including residential mortgages, home equity and home improvement loans, unsecured installment loans, credit cards, and co-branded or white-label partner programs — and to overdraft programs that function as extensions of credit. All collections activities must comply with applicable prudential, safety-and-soundness, consumer-protection (FDCPA/Reg F, UDAAP), data-accuracy (FCRA/Reg V), and information-security (NCUA Part 748) requirements. Timings stated in this policy are minimum standards; products or states with stricter requirements must configure tighter SLAs in the system.

---

## Timing Matrix {#timing-matrix}

| Scenario | Trigger (human → event) | Deadline | Content Reference | Control |
|---|---|---:|---|---|
| Courtesy notice — standard products | Payment missed past grace period (`loan.dpd.updated`) | Day 10 DPD | Past-due notice | [CO-02](#co-02-delinquency-monitoring-and-early-stage-collections) |
| Courtesy notice — first-mortgage consumer | Payment missed past grace period (`loan.dpd.updated`) | Day 15 DPD | Past-due notice | [CO-02](#co-02-delinquency-monitoring-and-early-stage-collections) |
| Second reminder | Courtesy notice sent (`collections.courtesy_notice.sent`) | Day 20 DPD | Follow-up notice | [CO-02](#co-02-delinquency-monitoring-and-early-stage-collections) |
| Right-to-cure notice | Loan reaches 30 DPD (`loan.delinquency_day_30`) | Within 5 days of 30 DPD | State-compliant cure notice | [CO-02](#co-02-delinquency-monitoring-and-early-stage-collections) |
| 60-day status memo | Loan reaches 60 DPD (`loan.delinquency_day_60`) | Within 10 days of 60 DPD | Problem-loan status memo | [CO-02](#co-02-delinquency-monitoring-and-early-stage-collections) |
| Substandard classification — retail | Loan reaches 90 DPD (`loan.delinquency_day_90`) | Month-end at 90 DPD | Risk-rating update | [CO-03](#co-03-retail-credit-classification-and-charge-offs) |
| Charge-off — closed-end retail | Loan reaches 120 DPD | Month-end at 120 DPD | Charge-off booking | [CO-03](#co-03-retail-credit-classification-and-charge-offs) |
| Charge-off — open-end retail | Loan reaches 180 DPD | Month-end at 180 DPD | Charge-off booking | [CO-03](#co-03-retail-credit-classification-and-charge-offs) |
| Charge-off — bankruptcy | Bankruptcy notice received (`loan.bankruptcy_notice.received`) | 60 days from notice | Charge-off booking | [CO-03](#co-03-retail-credit-classification-and-charge-offs) |
| Charge-off — fraud | Fraud confirmed (`loan.fraud.confirmed`) | 90 days from confirmation | Charge-off booking | [CO-03](#co-03-retail-credit-classification-and-charge-offs) |
| Charge-off — death | Loss reasonably estimable (`loan.death_loss_estimable`) | Once estimable | Charge-off booking | [CO-03](#co-03-retail-credit-classification-and-charge-offs) |
| DPD reset after modification | Third consecutive modified payment received (`loan.modified_payment_3.received`) | Upon receipt of payment 3 | DPD reset | [CO-04](#co-04-forbearance-extensions-workouts-and-tdrs) |
| TDR quarterly review | Quarter close | Quarterly | TDR review memo | [CO-04](#co-04-forbearance-extensions-workouts-and-tdrs) |
| Cease-communication flag effective | Cease request received (`collections.cease_request.received`) | 1 business day | Flag set in system | [CO-05](#co-05-consumer-protection-in-collections-communications) |
| Complaint acknowledgment — direct | Direct complaint received (`complaint.direct.received`) | 5 business days | Acknowledgment | [CO-06](#co-06-consumer-complaint-intake-and-resolution) |
| Complaint resolution — direct | Direct complaint received (`complaint.direct.received`) | 30 days | Resolution response | [CO-06](#co-06-consumer-complaint-intake-and-resolution) |
| Complaint initial response — regulator | Regulator complaint received (`complaint.regulator.received`) | 15 days | Initial response | [CO-06](#co-06-consumer-complaint-intake-and-resolution) |
| Complaint final response — regulator | Regulator complaint received (`complaint.regulator.received`) | 60 days | Final response | [CO-06](#co-06-consumer-complaint-intake-and-resolution) |
| Metro 2 furnishing file | Month-end close | Monthly | Metro 2 file | [CO-07](#co-07-credit-reporting-and-dispute-handling) |
| Dispute investigation | Dispute received (`furnishing.dispute.received`) | 30 days | Investigation findings + correction | [CO-07](#co-07-credit-reporting-and-dispute-handling) |
| Incident triage | Collections data incident created (`incident.collections.logged`) | 24 hours | Triage classification | [CO-11](#co-11-collections-data-incident-logging-and-triage) |
| NCUA cyber-incident notification | Reasonable belief of reportable incident | 72 hours | NCUA notification | [SC-01](#sc-01-ncua-reportable-cyber-incident-member-notification) |
| Nonaccrual placement | Loan reaches 90+ DPD or full collection doubtful | Immediate | Nonaccrual flag + interest reversal | [CO-09](#co-09-problem-loans-nonaccrual-and-foreclosure-governance) |
| Watch/Substandard/Doubtful rating review | Quarter close | Quarterly | Rating review memo | [CO-09](#co-09-problem-loans-nonaccrual-and-foreclosure-governance) |
| Board/ELC delinquency report | Month-end close | Monthly | Portfolio delinquency report | [CO-01](#co-01-collections-governance-and-scope) |
| Policy annual review | Policy anniversary | Annually | Reviewed policy version | [CO-01](#co-01-collections-governance-and-scope) |
| Material breach log | Breach identified | 5 business days | Breach log entry | [CO-01](#co-01-collections-governance-and-scope) |
| Overdraft daily report review | Daily overdraft report generated (`overdraft.report.reviewed`) | Same business day | Reviewed report | [CO-10](#co-10-overdraft-collections-and-fee-waiver-practices) |

---

## CO-01 — Collections Governance & Scope {#co-01-collections-governance-and-scope}

**WHY (Reg cite):** NCUA safety-and-soundness expectations require credit unions to maintain written policies governing collections activities, with clear ownership and board oversight. UDAAP obligations under [Dodd-Frank §§ 1031 & 1036 (12 U.S.C. 5531, 5536)](https://www.law.cornell.edu/uscode/text/12/5531) require that all collections workflows operate under a current, board-approved policy framework.

**SYSTEM BEHAVIOR:** The system maintains a single `collections` policy configuration object (`collections.policy_version`, `collections.policy_bound`) that every collections workflow must reference at runtime; a workflow bound to an inactive or superseded policy version is blocked from proceeding. The Board and Executive Loan Committee (ELC) receive a monthly delinquency and problem-loan report covering loans >30 DPD, problem loans, nonaccruals, and OREO. The policy is reviewed at least annually; material breaches are logged within 5 business days of identification. The CCO owns this control; write access to the policy configuration object and breach log is restricted to Compliance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Collections policy version activated or updated (`collections.policy_version.activated`) | Policy document ID (`collections.policy_version`), effective date (`policy.effective_date`), approver (`policy.approver_id`), RACI registry (`policy.raci_registry`) | Active policy version record + bound-workflow confirmation (`collections.policy_version.activated`) | At go-live and upon each revision; enforced by `collections.annual_review_due_at` |
| Month-end close — delinquency and problem-loan report due (`collections.board_report.issued`) | Loans >30 DPD, problem loans, nonaccruals, OREO data (`loan.dpd`, `loan.risk_rating`, `loan.nonaccrual_placed`, `loan.re_writedown`) | Board/ELC delinquency report (`collections.board_report.issued`) | Monthly; enforced by `collections.board_report_due_at` |
| Annual policy review cycle opens (`collections.policy_review.completed`) | Prior policy version (`collections.policy_version`), review findings (`collections.policy_review`) | Reviewed and re-approved policy version (`collections.policy_review.completed`) | Annually; enforced by `collections.annual_review_due_at` |
| Material policy breach identified (`collections.policy_breach.logged`) | Breach description (`breach.description`), control ID (`breach.control_id`), owner (`breach.owner`) | Breach log entry (`collections.policy_breach.logged`) | Within 5 business days of identification; enforced by `collections.breach_log_due_at` |

**ALERTS/METRICS:** Alert when `collections.board_report_due_at` ages past month-end without a `collections.board_report.issued` event. Alert when `collections.annual_review_due_at` is within 30 days without a completed review. Alert when `collections.breach_log_due_at` is breached (>5 BD since breach identification without a logged entry). Target: zero overdue board reports and zero unlogged material breaches.

---

## CO-02 — Delinquency Monitoring & Early-Stage Collections {#co-02-delinquency-monitoring-and-early-stage-collections}

**WHY (Reg cite):** FFIEC Uniform Retail Credit Classification and Account Management Policy requires timely follow-up on delinquent accounts. [FDCPA/Reg F (12 CFR Part 1006)](https://www.ecfr.gov/current/title-12/part-1006) governs the form and timing of collection communications. State right-to-cure laws (mapped by Legal per product and state) impose minimum notice requirements before acceleration or repossession.

**SYSTEM BEHAVIOR:** A nightly delinquency engine (`loan.delinquency_engine_run`) calculates days-past-due for every active loan after applying the configured grace period (`loan.grace_period_days`: 10 days standard, 15 days for first-mortgage consumer products). The engine sets milestone flags (`loan.delinquency_day_10`, `loan.delinquency_day_20`, `loan.delinquency_day_30`, `loan.delinquency_day_60`) and schedules the corresponding notice tasks. Courtesy notices are sent at day 10 (or 15 for first-mortgage), second reminders by day 20, and a formal right-to-cure notice within 5 days of the 30-day milestone. A 60-day status memo is filed within 10 days of the 60-DPD milestone. Past Due Notes are retained for at least one year. If a loan is well-secured and in the process of collection such that repayment is reasonably expected within 90 days, classification may be deferred provided the file is clearly documented (`loan.well_secured_documented`). Collections Operations is the operational owner; Compliance has read-only audit access to all notice queues and is the sole approver for template changes.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Nightly delinquency engine run completes (`loan.dpd.updated`) | Loan ID (`loan.id`), last payment date (`loan.last_payment_date`), product type (`loan.product_type`), grace period (`loan.grace_period_days`) | Updated DPD value and milestone flags (`loan.dpd.updated`); engine run log (`loan.delinquency_engine_run`) | Nightly; enforced by `loan.days_past_due` |
| Loan reaches day-10 (or day-15 first-mortgage) DPD milestone (`loan.delinquency_day_10`) | Member contact info (`member.id`, `entity.contact`), loan balance (`loan.balance`), past-due amount (`loan.past_due_amount`), approved template (`collections.template`) | Courtesy notice sent (`collections.courtesy_notice.sent`); past-due note retained (`collections.past_due_note_retained`) | Day 10 (standard) / Day 15 (first-mortgage); enforced by `loan.courtesy_notice_due_at` |
| Courtesy notice sent (`collections.courtesy_notice.sent`) | Prior notice record, member contact preferences (`member.contact_preferences`) | Second reminder notice sent (`collections.second_reminder.sent`) | By day 20 DPD; enforced by `loan.second_reminder_due_at` |
| Loan reaches 30 DPD milestone (`loan.delinquency_day_30`) | State-specific cure parameters (`legal.cure_parameters`), member contact info (`member.id`, `entity.contact`), loan balance (`loan.balance`) | Right-to-cure notice sent (`collections.right_to_cure.sent`) | Within 5 days of 30 DPD; enforced by `loan.right_to_cure_due_at` |
| Loan reaches 60 DPD milestone (`loan.delinquency_day_60`) | Loan status, collectibility assessment (`loan.collectibility_assessment`), workout alternatives considered (`loan.workout_alternatives`) | 60-day status memo filed (`collections.status_memo.filed`) | Within 10 days of 60 DPD; enforced by `loan.status_memo_due_at` |

**ALERTS/METRICS:** Alert when any courtesy notice task ages past its `loan.courtesy_notice_due_at` without a `collections.courtesy_notice.sent` event. Alert when right-to-cure tasks age past `loan.right_to_cure_due_at`. Monitor the count of loans at each DPD milestone without a corresponding notice event; target zero. Alert when status memo tasks age past `loan.status_memo_due_at`.

---

## CO-03 — Retail Credit Classification & Charge-Offs {#co-03-retail-credit-classification-and-charge-offs}

**WHY (Reg cite):** The [FFIEC Uniform Retail Credit Classification and Account Management Policy](https://www.govinfo.gov/content/pkg/FR-2000-06-12/html/00-14704.htm) requires: Substandard classification at 90 DPD; closed-end charge-off at 120 DPD; open-end charge-off at 180 DPD; bankruptcy charge-off within 60 days of notice; fraud charge-off within 90 days of confirmation; death charge-off once loss is estimable; and real-estate write-down to fair value net of cost to sell. All charge-offs are taken at month-end. NCUA safety-and-soundness expectations incorporate these FFIEC standards for federally insured credit unions.

**SYSTEM BEHAVIOR:** The delinquency engine automatically triggers classification and charge-off tasks at the applicable DPD thresholds. Substandard classification is set at 90 DPD (`loan.classified_substandard`). Closed-end loans are charged off at 120 DPD and open-end loans at 180 DPD, both executed at month-end (`loan.chargeoff_month_end_at`). Bankruptcy charge-offs are triggered within 60 days of court notice (`loan.bankruptcy_chargeoff_due_at`); fraud charge-offs within 90 days of confirmed fraud (`loan.fraud_chargeoff_due_at`); death charge-offs once the loss is reasonably estimable (`loan.death_loss_estimable`). For real estate loans, when the outstanding balance exceeds fair value net of cost to sell, the excess is classified as Loss and written down (`loan.re_writedown`, `collateral.fair_value`, `collateral.cost_to_sell`). A well-secured loan in the process of collection (repayment reasonably expected within 90 days) need not be classified, provided the basis is documented (`loan.well_secured_documented`, `loan.repayment_evidence`). Charge-off entries are write-restricted to Finance/Credit Risk; Compliance has read-only audit access.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Loan reaches 90 DPD (`loan.delinquency_day_90`) | Loan type (`loan.product_type`), LTV (`loan.ltv`), collateral value (`loan.collateral_value`), well-secured documentation (`loan.well_secured_documented`) | Substandard classification applied (`loan.rating_review.completed`); risk rating updated (`loan.risk_rating`) | Month-end at 90 DPD; enforced by `loan.classification_due_at` |
| Closed-end loan reaches 120 DPD (`loan.chargeoff_due_closed_end`) | Loan balance (`loan.balance`), product type (`loan.product_type`), well-secured exception if applicable (`loan.well_secured_documented`) | Charge-off booked (`loan.charged_off`); GL entry posted | Month-end at 120 DPD; enforced by `loan.chargeoff_month_end_at` |
| Open-end loan reaches 180 DPD (`loan.chargeoff_due_open_end`) | Loan balance (`loan.balance`), product type (`loan.product_type`), well-secured exception if applicable (`loan.well_secured_documented`) | Charge-off booked (`loan.charged_off`); GL entry posted | Month-end at 180 DPD; enforced by `loan.chargeoff_month_end_at` |
| Bankruptcy notice received from court (`loan.bankruptcy_notice.received`) | Bankruptcy case ID (`loan.bankruptcy_case_id`), loan balance (`loan.balance`), repayment likelihood documentation | Charge-off booked (`loan.charged_off`) unless repayment clearly documented | Within 60 days of notice; enforced by `loan.bankruptcy_chargeoff_due_at` |
| Fraud confirmed (`loan.fraud.confirmed`) | Fraud investigation ID (`loan.id`), confirmed loss amount (`loan.balance`), BSA referral if applicable | Charge-off booked (`loan.charged_off`); BSA referral noted | Within 90 days of confirmation; enforced by `loan.fraud_chargeoff_due_at` |
| Death loss determined estimable (`loan.death_loss_estimable`) | Estate claim status (`loan.estate_claim_status`), estimated recovery (`loan.estimated_recovery`), death flag (`account.death_flag`) | Charge-off booked (`loan.charged_off`) | Once loss is reasonably estimable; no fixed calendar deadline |
| Real estate loan balance exceeds fair value net of cost to sell (`loan.re_writedown`) | Fair value (`collateral.fair_value`), cost to sell (`collateral.cost_to_sell`), outstanding balance (`loan.balance`), LTV (`loan.ltv`) | Loss classification applied; write-down booked (`loan.re_writedown.booked`) | At 120 DPD (closed-end) or 180 DPD (open-end) assessment; enforced by `loan.re_valuation_due` |

**ALERTS/METRICS:** Alert when any loan passes its charge-off DPD threshold without a `loan.charged_off` event by month-end. Alert when `loan.bankruptcy_chargeoff_due_at` or `loan.fraud_chargeoff_due_at` is within 5 business days without a completed charge-off. Monitor count of loans classified Substandard without a subsequent charge-off action at the applicable threshold; target zero unexplained exceptions.

---

## CO-04 — Forbearance, Extensions, Workouts & TDRs {#co-04-forbearance-extensions-workouts-and-tdrs}

**WHY (Reg cite):** FFIEC Account Management Policy governs re-aging, extensions, and workout standards for retail credit, requiring that modifications reflect sustainable repayment capacity and that DPD resets meet defined performance criteria. UDAAP obligations under [Dodd-Frank §§ 1031 & 1036 (12 U.S.C. 5531, 5536)](https://www.law.cornell.edu/uscode/text/12/5531) require that forbearance and workout terms be offered and administered fairly. Interagency nonaccrual and problem-asset guidance governs TDR classification and quarterly review requirements.

**SYSTEM BEHAVIOR:** Hardship forbearance, extensions, and troubled-debt restructurings (TDRs) are governed by this control to ensure modifications reflect the member's sustainable repayment capacity (`member.repayment_capacity`, `member.hardship_evidence`). DPD is reset only after the member completes three consecutive modified payments (`loan.modified_payment_3.received`, `loan.dpd_reset`); the system enforces this gate via `loan.dpd_reset_eligibility_check`. Extensions are capped at three months per event; interest capitalization and interest-only arrangements (3–12 months) require ELC committee approval (`elc.modification.approved`). Active TDRs are reviewed quarterly (`tdr.quarterly_review_due`). Proposed modifications are documented in `loan.proposed_modification` and the modified schedule in `loan.modified_schedule`. Interest-only term months are tracked in `loan.io_term_months`; capitalization proposals in `loan.io_capitalization`. Collections Operations initiates modifications; ELC approval is required for interest capitalization and interest-only arrangements; Compliance reviews TDR quarterly reports.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Member hardship forbearance or extension requested (`loan.workout.requested`) | Hardship evidence (`member.hardship_evidence`), repayment capacity assessment (`member.repayment_capacity`), proposed modification terms (`loan.proposed_modification`), extension cap check (≤3 months) | Modification decision recorded (`loan.modification.decided`); modified schedule set (`loan.modified_schedule`) | Upon request; decision within lending authority timelines |
| Interest capitalization or interest-only arrangement proposed (`loan.io_capitalization.proposed`) | Proposed IO term (`loan.io_term_months`), capitalization amount, repayment capacity (`member.repayment_capacity`), ELC approval packet (`elc.approval_packet`) | ELC approval recorded (`elc.modification.approved`); modification booked | Prior to implementation; ELC approval required |
| Third consecutive modified payment received (`loan.modified_payment_3.received`) | Payment history confirming three consecutive on-time modified payments (`loan.modified_schedule`), loan ID (`loan.id`) | DPD reset applied (`loan.dpd_reset`); reset eligibility check logged (`loan.dpd_reset_eligibility_check`) | Upon receipt of third payment |
| Quarter close — active TDR review (`tdr.quarterly_review.completed`) | Active TDR list, performance data (`loan.modified_schedule`, `loan.dpd`), repayment capacity reassessment (`member.repayment_capacity`) | TDR quarterly review memo (`tdr.quarterly_review.completed`) | Quarterly; enforced by `tdr.quarterly_review_due` |

**ALERTS/METRICS:** Alert when a DPD reset is applied without a confirmed `loan.modified_payment_3.received` event (gate bypass). Alert when any interest-only or capitalization modification is booked without a corresponding `elc.modification.approved` event. Alert when `tdr.quarterly_review_due` ages past quarter-end without a completed review. Monitor count of active TDRs with no review in the current quarter; target zero.

---

## CO-05 — Consumer Protection in Collections Communications {#co-05-consumer-protection-in-collections-communications}

**WHY (Reg cite):** [FDCPA/Reg F (12 CFR Part 1006)](https://www.ecfr.gov/current/title-12/part-1006) prohibits abusive, unfair, and deceptive collection practices; limits calling times (8 a.m.–9 p.m. local time), places, and frequency (no more than 7 calls within 7 days per debt); and requires cease-communication and attorney-representation flags to be honored. UDAAP under [Dodd-Frank §§ 1031 & 1036 (12 U.S.C. 5531, 5536)](https://www.law.cornell.edu/uscode/text/12/5531) independently prohibits harassment, threats, obscene language, and false credit-information disclosures in collections.

**SYSTEM BEHAVIOR:** The collections platform enforces permitted calling windows based on the member's local timezone (`member.timezone`) and blocks outbound contact outside 8 a.m.–9 p.m. local time. A 7-day frequency counter (`collections.contact_frequency_7d`) gates outbound calls; the system blocks the seventh-plus attempt within a rolling 7-day window per debt (`collections.contact_gated`). Cease-communication flags (`member.cease_flag_set`, `collections.cease_flag_due_at`) and attorney-representation flags (`member.attorney_contact`, `collections.attorney_flag_due_at`) are set within 1 business day of the triggering request and block all further outbound contact except as permitted by law. All collection templates and scripts must be routed through Compliance for approval before use (`collections.template.approved`); unapproved templates are blocked from the platform. Prohibited conduct (harassment, threats, obscene language, false disclosures) is enforced by system controls and monitored via call-recording review. Compliance is the sole approver for templates and scripts; Collections Operations is the operational owner of contact logging.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Outbound contact attempted (`collections.contact.logged`) | Member timezone (`member.timezone`), contact channel (`collections.contact_channel`), cease flag status (`member.cease_flag_set`), attorney flag status (`member.attorney_contact`), 7-day frequency count (`collections.contact_frequency_7d`), contact gate check result (`collections.contact_gate_check`) | Contact attempt logged (`collections.contact.logged`); gate block logged if applicable (`collections.contact_gated`) | Real-time at each contact attempt |
| Cease-communication request received (`collections.cease_request.received`) | Member ID (`member.id`), request channel (`collections.contact_channel`), cease request record (`collections.cease_request`) | Cease flag set (`member.cease_flag_set`); all outbound contact blocked (`collections.contact_gated`) | Within 1 business day; enforced by `collections.cease_flag_due_at` |
| Attorney representation identified (`member.attorney_flag_set`) | Attorney contact information (`member.attorney_contact`), member ID (`member.id`) | Attorney flag set; direct member contact blocked (`collections.attorney_identified`) | Within 1 business day; enforced by `collections.attorney_flag_due_at` |
| Collection template or script submitted for approval (`collections.template.submitted`) | Template content (`collections.template`), submitting collector ID (`collections.collector_id`), product scope | Compliance approval or rejection recorded (`collections.template.approved`) | Prior to use; no fixed calendar deadline |

**ALERTS/METRICS:** Alert when any contact is logged for a member with an active cease flag or attorney flag (flag-bypass event). Alert when cease-flag or attorney-flag set tasks age past 1 business day without completion. Monitor 7-day contact frequency counts; alert when any account approaches the 7-call threshold. Target: zero flag-bypass contacts, zero unapproved templates in active use.

---

## CO-06 — Consumer Complaint Intake & Resolution {#co-06-consumer-complaint-intake-and-resolution}

**WHY (Reg cite):** CFPB complaint program expectations require complete, accurate, and timely responses — typically 15 days initial and 60 days final for regulator-forwarded complaints. UDAAP under [Dodd-Frank §§ 1031 & 1036 (12 U.S.C. 5531, 5536)](https://www.law.cornell.edu/uscode/text/12/5531) requires that complaint handling not itself constitute an unfair, deceptive, or abusive act or practice. [FDCPA/Reg F (12 CFR Part 1006)](https://www.ecfr.gov/current/title-12/part-1006) requires that complaints alleging collections-conduct violations be investigated and remediated.

**SYSTEM BEHAVIOR:** All complaints — regardless of channel (phone, mail, email, member portal, regulator portal) — are captured in a single complaint platform (`complaint.channel`, `complaint.direct`, `complaint.regulator`). Each complaint is tagged with a root-cause category (`complaint.root_cause_tag`) and a UDAAP flag (`complaint.udaap_flag`) at intake. Regulator-forwarded complaints receive an initial response within 15 days (`complaint.initial_response_due_at`) and a final response within 60 days (`complaint.final_response_due_at`). Direct member complaints receive an acknowledgment within 5 business days (`complaint.ack_due_at`) and a resolution within 30 days (`complaint.resolution_due_at`). Complaint trends are reviewed periodically (`complaint.trend_review_due`). Compliance owns complaint intake and resolution; Collections Operations provides factual input; Legal is consulted on UDAAP-flagged complaints.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Direct member complaint received (`complaint.direct.received`) | Member ID (`complaint.member_id`), complaint narrative (`complaint.narrative`), channel (`complaint.channel`), root-cause tag (`complaint.root_cause_tag`), UDAAP flag (`complaint.udaap_flag`) | Complaint logged (`complaint.logged`); acknowledgment sent (`complaint.acknowledged`) | Acknowledgment within 5 business days; enforced by `complaint.ack_due_at` |
| Direct complaint investigation completed (`complaint.investigation.completed`) | Investigation notes (`complaint.investigation_notes`), root-cause tag (`complaint.root_cause_tag`), UDAAP flag (`complaint.udaap_flag`) | Resolution response sent (`complaint.resolved`); final response recorded | Within 30 days of receipt; enforced by `complaint.resolution_due_at` |
| Regulator complaint received (`complaint.regulator.received`) | Regulator case ID (`complaint.regulator`), complaint narrative (`complaint.narrative`), UDAAP flag (`complaint.udaap_flag`), portal due date (`complaint.portal_due_date`) | Initial response sent (`complaint.initial_response.sent`) | Within 15 days; enforced by `complaint.initial_response_due_at` |
| Regulator complaint investigation completed (`complaint.investigation.completed`) | Investigation notes (`complaint.investigation_notes`), root-cause tag (`complaint.root_cause_tag`), UDAAP flag (`complaint.udaap_flag`) | Final response sent (`complaint.final_response.sent`) | Within 60 days; enforced by `complaint.final_response_due_at` |
| Complaint trend review due (`complaint.trend.reported`) | Trend summary (`complaint.trend_summary`), UDAAP flag counts, root-cause distribution | Trend report issued (`complaint.trend.reported`) | Periodic (at minimum quarterly); enforced by `complaint.trend_review_due` |

**ALERTS/METRICS:** Alert when any complaint acknowledgment ages past `complaint.ack_due_at` without a `complaint.acknowledged` event. Alert when any regulator complaint ages past `complaint.initial_response_due_at` or `complaint.final_response_due_at`. Alert when any direct complaint ages past `complaint.resolution_due_at`. Monitor UDAAP-flagged complaint count; escalate any UDAAP-flagged complaint to CCO within 1 business day of flagging. Target: zero missed response deadlines.

---

## CO-07 — Credit Reporting & Dispute Handling {#co-07-credit-reporting-and-dispute-handling}

**WHY (Reg cite):** [FCRA/Reg V (12 CFR Part 1022)](https://www.ecfr.gov/current/title-12/part-1022) imposes furnisher duties for accuracy and integrity of information reported to consumer reporting agencies, requires investigation of disputes within 30 days of receipt, and mandates correction of inaccurate information in the next furnishing cycle. Identity-theft disputes must be escalated to Fraud per [15 U.S.C. 1681c-2](https://www.law.cornell.edu/uscode/text/15/1681c-2).

**SYSTEM BEHAVIOR:** The system generates a monthly Metro 2 furnishing file (`furnishing.file_transmitted`) covering all in-scope loan accounts and tracks furnishing history (`furnishing.cycle_due_at`). Corrections identified internally or through disputes are applied in the next furnishing batch (`furnishing.correction.applied`). Disputes received from consumers or consumer reporting agencies are logged (`furnishing.dispute.received`) and investigated within 30 days (`furnishing.dispute_due_at`). Identity-theft disputes (`furnishing.idtheft_dispute`) are escalated to the Fraud team (`fraud.idtheft_case.opened`) within 1 business day of receipt. Furnishing files and dispute records are write-restricted to Credit Risk/Collections Operations; Compliance has read-only audit access.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Month-end close — furnishing cycle due (`furnishing.cycle_due_at`) | All in-scope loan account data, Metro 2 format fields, furnishing history (`furnishing.file_transmitted`), correction queue (`furnishing.correction_identified`) | Metro 2 file transmitted (`furnishing.file_transmitted`); furnishing history updated | Monthly; enforced by `furnishing.cycle_due_at` |
| Dispute received from consumer or CRA (`furnishing.dispute.received`) | Disputed account ID (`furnishing.disputed_account`), dispute basis (`dispute.basis`), dispute category (`dispute.category`), member ID (`member.id`) | Dispute investigation opened; findings documented (`dispute.findings`); correction applied if warranted (`furnishing.correction.applied`); dispute resolved (`furnishing.dispute.resolved`) | Within 30 days of receipt; enforced by `furnishing.dispute_due_at` |
| Identity-theft dispute received (`furnishing.idtheft_dispute.received`) | Identity-theft report (`dispute.idtheft_report`), disputed account ID (`furnishing.disputed_account`), member ID (`member.id`) | Fraud case opened (`fraud.idtheft_case.opened`); dispute escalated to Fraud | Within 1 business day of receipt; no registered timer — internal SLA |
| Correction identified in furnishing data (`furnishing.correction.applied`) | Corrected field values, account ID (`furnishing.disputed_account`), correction evidence | Correction applied in next furnishing batch (`furnishing.correction.applied`) | Next monthly furnishing cycle; enforced by `furnishing.cycle_due_at` |

**ALERTS/METRICS:** Alert when any dispute ages past `furnishing.dispute_due_at` without a `furnishing.dispute.resolved` event. Alert when the monthly furnishing file is not transmitted by `furnishing.cycle_due_at`. Alert when an identity-theft dispute is not escalated to Fraud within 1 business day. Monitor correction backlog count; target zero corrections outstanding beyond one furnishing cycle.

---

## SC-01 — NCUA Reportable Cyber-Incident & Member Notification {#sc-01-ncua-reportable-cyber-incident-member-notification}

**WHY (Reg cite):** [NCUA 12 CFR Part 748 §748.1(c)](https://www.ecfr.gov/current/title-12/part-748) requires credit unions to notify NCUA within 72 hours of determining a reportable cyber incident. [NCUA 12 CFR Part 748, Appendix B](https://www.ecfr.gov/current/title-12/part-748) requires a member notification program for unauthorized access to sensitive member information.

**SYSTEM BEHAVIOR:** Once a reportable cyber incident is determined, NCUA notification must be sent within 72 hours of that determination. Member notice is sent without unreasonable delay per Appendix B criteria once misuse of member information is determined likely. The reportability determination and the NCUA-notification field are write-restricted to the CCO/Compliance-Legal. An incident determined non-reportable is documented with rationale and triggers no NCUA notice.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Reportable cyber incident determined (`incident.reportability_determination`) | Reportability rationale (`incident.reportability_rationale`), NCUA notice due (`incident.ncua_notice_due_at`) | NCUA notification sent (`incident.ncua.notified`) | 72 hours of determination (enforced by `incident.ncua_notice_due_at`) |
| Member impact confirmed (`incident.member_impact.confirmed`) | Member impact summary (`incident.member_impact`), notice template (`incident.member_notice_template`) | Member notices sent (`incident.member_notices.sent`) | Without unreasonable delay per Appendix B (enforced by `incident.notification_due_at`) |

**ALERTS/METRICS:** Alert fires when `incident.ncua_notice_due_at` is within 12 hours without an `incident.ncua.notified` event; alert fires when member notice is overdue per `incident.notification_due_at`. Target: 100% of reportable incidents notified to NCUA within 72 hours; zero member-notice SLA breaches.

---

## CO-11 — Collections-Data Incident Logging & Triage {#co-11-collections-data-incident-logging-and-triage}

**WHY (Reg cite):** [NCUA Part 748 (12 CFR Part 748)](https://www.ecfr.gov/current/title-12/part-748) requires federally insured credit unions to maintain a written security program protecting member records. Triage feeds the reportability determination governed by [SC-01](#sc-01-ncua-reportable-cyber-incident-member-notification).

**SYSTEM BEHAVIOR:** Any incident affecting collections data (loan records, member contact data, payment history, credit-reporting data) is logged as an incident with the `incident.collections` flag set (`incident.collections.logged`). The incident is triaged within 24 hours (`incident.triage_due_at`) to classify severity (`incident.severity`), assess reportability (`incident.reportability_assessment`), and determine member impact (`incident.member_impact`) feeding the SC-01 reportability determination. This control operates within the enterprise incident-response framework (see Information Security Policy); this policy governs the collections-data-specific classification obligations. IT/Security owns incident detection and triage; Compliance and Legal own reportability determination.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Incident affecting collections data detected and logged (`incident.collections.logged`) | Incident description (`incident.description`), data scope (`incident.data_scope`), detection source (`incident.detection_source`), collections flag (`incident.collections`) | Incident record created (`incident.created`); triage task opened | Immediately upon detection |
| Triage due — incident classification (`incident.classified`) | Incident severity (`incident.severity`), scope assessment (`incident.scope_initial`), reportability assessment (`incident.reportability_assessment`), member impact (`incident.member_impact`) | Triage completed (`incident.classified`); reportability determination recorded (`incident.reportability_determination`) | Within 24 hours of incident creation; enforced by `incident.triage_due_at` |

**ALERTS/METRICS:** Alert when any collections-flagged incident ages past 24 hours without a `incident.classified` event.

---

## CO-09 — Problem Loans, Nonaccrual & Foreclosure Governance {#co-09-problem-loans-nonaccrual-and-foreclosure-governance}

**WHY (Reg cite):** Interagency nonaccrual and problem-asset guidance (incorporated by NCUA into safety-and-soundness expectations) requires credit unions to maintain a five-tier risk-rating system (Pass/Watch/Substandard/Doubtful/Loss), place loans on nonaccrual at 90+ DPD or when full collection is doubtful, reverse accrued interest upon nonaccrual placement, and review Watch/Substandard/Doubtful ratings at least quarterly. Foreclosure actions require a pre-foreclosure financial-impact evaluation and senior management approval consistent with NCUA safety-and-soundness standards and applicable state foreclosure law.

**SYSTEM BEHAVIOR:** Every loan carries a risk rating (`loan.risk_rating`) from the five-tier scale (Pass/Watch/Substandard/Doubtful/Loss). Loans are placed on nonaccrual (`loan.nonaccrual_placed`) automatically when they reach 90+ DPD or when a collectibility assessment determines full collection is doubtful (`loan.collectibility_assessment`); accrued interest is reversed upon placement (`loan.accrued_interest`). Return to accrual requires documented evidence of sustained performance (`loan.repayment_evidence`). Watch, Substandard, and Doubtful-rated loans are reviewed quarterly (`loan.rating_review_due_at`). Before initiating foreclosure, a financial-impact evaluation is required (`loan.foreclosure_impact_eval`) with CCO and President approval (`loan.foreclosure.approved`). OREO valuation and disposition are governed by separate OREO guidelines (out of scope here). Credit Risk owns risk ratings and nonaccrual decisions; Compliance and Legal must be consulted on foreclosure; CCO and President approve foreclosure initiation.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Loan reaches 90+ DPD or collectibility assessed as doubtful (`loan.nonaccrual.triggered`) | DPD count (`loan.dpd`), collectibility assessment (`loan.collectibility_assessment`), accrued interest balance (`loan.accrued_interest`), loan ID (`loan.id`) | Nonaccrual flag set (`loan.nonaccrual_placed`); accrued interest reversed; nonaccrual event logged (`loan.nonaccrual.triggered`) | Immediately upon 90 DPD or doubtful determination; enforced by `loan.nonaccrual_due_at` |
| Quarterly rating review cycle opens for Watch/Substandard/Doubtful loans (`loan.rating_review.completed`) | Current risk rating (`loan.risk_rating`), loan performance data (`loan.dpd`, `loan.modified_schedule`), collectibility assessment (`loan.collectibility_assessment`) | Rating review completed and documented (`loan.rating_review.completed`); rating updated if warranted | Quarterly; enforced by `loan.rating_review_due_at` |
| Foreclosure proposed (`loan.foreclosure.proposed`) | Financial-impact evaluation (`loan.foreclosure_impact_eval`), legal foreclosure checklist (`legal.foreclosure_checklist`), CCO and President approval packet | Foreclosure approved (`loan.foreclosure.approved`) or rejected; approval recorded | Prior to foreclosure initiation; no fixed calendar deadline |
| Loan returns to accrual (`loan.accrual.restored`) | Sustained performance evidence (`loan.repayment_evidence`), collectibility reassessment (`loan.collectibility_assessment`) | Accrual restored (`loan.accrual.restored`); return-to-accrual documented | Upon determination of sustained performance |

**ALERTS/METRICS:** Alert when any loan at 90+ DPD does not have a `loan.nonaccrual_placed` flag within 1 business day. Alert when Watch/Substandard/Doubtful loans have not received a rating review within the current quarter (`loan.rating_review_due_at`). Alert when a foreclosure is initiated without a corresponding `loan.foreclosure.approved` event. Monitor nonaccrual portfolio balance trend monthly; report to Board/ELC via CO-01.

---

## CO-10 — Overdraft Collections and Fee Waiver Practices {#co-10-overdraft-collections-and-fee-waiver-practices}

**WHY (Reg cite):** UDAAP under [Dodd-Frank §§ 1031 & 1036 (12 U.S.C. 5531, 5536)](https://www.law.cornell.edu/uscode/text/12/5531) requires that overdraft fees be assessed consistently and that fee-waiver practices not be applied in a discriminatory or deceptive manner. NCUA safety-and-soundness expectations treat overdrafts as short-term unsecured credit extensions requiring appropriate credit authority and monitoring. [FDCPA/Reg F (12 CFR Part 1006)](https://www.ecfr.gov/current/title-12/part-1006) applies to collection of overdraft balances.

**SYSTEM BEHAVIOR:** Overdrafts are treated as short-term unsecured credit extensions. The daily overdraft report (`overdraft.daily_report_generated`) is reviewed by Collections Operations on the same business day (`overdraft.report.reviewed`). Each overdraft requires approval within the applicable lending authority before coverage is extended (`overdraft.referral`). Fees are assessed according to the published fee schedule (`overdraft.fee_schedule`) and applied consistently (`overdraft.fee_assessed`); fee suppression (`fee.overdraft.suppressed`) is logged. Fee waivers are permitted only as documented exceptions (`overdraft.waiver_reason`); recurring waiver patterns (`overdraft.recurring_pattern`) require CCO approval (`overdraft.waiver.approved`). Ongoing payroll overdraft coverage absent a formal credit facility (`overdraft.payroll_coverage_flag`) is prohibited and triggers an immediate referral for a formal facility. Collections Operations owns daily overdraft review; CCO approves recurring waiver patterns; Compliance audits fee consistency.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Daily overdraft report generated (`overdraft.report.reviewed`) | Overdraft balances (`overdraft.amount`), days outstanding (`overdraft.days_outstanding`), occurrence counts (`overdraft.occurrence_count`), payroll coverage flags (`overdraft.payroll_coverage_flag`), fee schedule (`overdraft.fee_schedule`) | Report reviewed and logged (`overdraft.report.reviewed`); referrals issued for items requiring credit authority (`overdraft.referral.issued`) | Same business day; enforced by `overdraft.review_due_at` |
| Overdraft fee assessed (`overdraft.fee.logged`) | Account ID, fee amount, fee schedule version (`overdraft.fee_schedule`), fee suppression flag (`fee.overdraft.suppressed`) | Fee posted and logged (`overdraft.fee.logged`); suppression logged if applicable (`fee.overdraft.suppressed`) | At time of overdraft event |
| Fee waiver requested (`overdraft.waiver.requested`) | Waiver reason (`overdraft.waiver_reason`), member ID (`member.id`), occurrence count (`overdraft.occurrence_count`), recurring pattern flag (`overdraft.recurring_pattern`) | Waiver approved or denied (`overdraft.waiver.approved`); CCO approval required for recurring patterns | At time of request; CCO approval for recurring patterns before waiver is applied |
| Recurring overdraft pattern detected (`overdraft.recurring_pattern.detected`) | Pattern history (`overdraft.recurring_pattern`), occurrence count (`overdraft.occurrence_count`), payroll coverage flag (`overdraft.payroll_coverage_flag`) | CCO notified; formal facility referral issued (`overdraft.referral.issued`) if payroll coverage is ongoing without a facility | Immediately upon pattern detection |

**ALERTS/METRICS:** Alert when the daily overdraft report is not reviewed by end of business day (`overdraft.review_due_at`). Alert when a recurring waiver pattern is approved without a `overdraft.waiver.approved` event bearing CCO authorization. Alert when `overdraft.payroll_coverage_flag` is set without a corresponding formal facility referral. Monitor fee-waiver rate by member segment quarterly for UDAAP consistency; report anomalies to Compliance.

---

## Governance & Sign-Off {#governance}

| Role | Name | Responsibility |
|---|---|---|
| Policy Owner | Patrick Wilson, Chief Compliance Officer | Maintains policy; approves all amendments; signs off on NCUA notifications |
| Approver | Patrick Wilson, Chief Compliance Officer | Annual and interim policy approval |
| Collections Operations | VP Collections (to be designated) | Operational execution of CO-02, CO-05, CO-10 |
| Credit Risk | Chief Credit Officer (to be designated) | CO-03, CO-04, CO-09 classification and charge-off decisions |
| Legal | General Counsel (to be designated) | State law mapping (CO-02), foreclosure checklist (CO-09), UDAAP consultation (CO-06) |
| IT/Security | CISO (to be designated) | CO-11 incident detection and triage |
| Finance | CFO (to be designated) | Charge-off GL entries (CO-03) |
| Executive Loan Committee | ELC Chair | CO-04 interest capitalization/IO approvals; CO-09 foreclosure approval |
| Board of Directors | Board Chair | Monthly delinquency report recipient (CO-01) |

**Review cadence:** This policy is reviewed at least annually, or sooner upon material regulatory change, significant portfolio event, or examination finding. The next scheduled review is 2027-07-01.

**Cross-references:**
- Lending Policy (origination, underwriting, credit policy)
- Fair Lending Policy (fair-lending and adverse-action requirements)
- BSA Policy (SAR filing for fraud charge-offs)
- Information Security Policy (enterprise incident-response framework)
- Privacy Policy (member data handling)
- OREO Guidelines (OREO valuation and disposition)
- Third-Party Risk Policy (vendor management of third-party collectors)
- Record Retention Policy (retention schedules beyond collections-specific evidence)

---

## Assumptions & Gaps {#assumptions}

- **Engineering vocabulary is provisional for select codes.** The following codes used in this policy's control overlays are composed per the Composition grammar and are not yet confirmed as registered in `core-vocabulary.json`. They follow the agreed naming scheme and must be confirmed by engineering before the next review: `loan.delinquency_day_10`, `loan.delinquency_day_20`, `loan.delinquency_day_30`, `loan.delinquency_day_60`, `loan.delinquency_day_90`, `loan.delinquency_engine_run`, `loan.delinquency_engine_schedule`, `loan.chargeoff_due_closed_end`, `loan.chargeoff_due_open_end`, `loan.chargeoff_month_end_at`, `loan.well_secured_documented`, `loan.repayment_evidence`, `loan.dpd_reset`, `loan.dpd_reset_eligibility_check`, `loan.io_capitalization`, `loan.io_term_months`, `loan.modified_schedule`, `loan.proposed_modification`, `loan.foreclosure_impact_eval`, `loan.death_loss_estimable`, `loan.estate_claim_status`, `loan.estimated_recovery`, `loan.accrued_interest`, `loan.nonaccrual_placed`, `loan.collectibility_assessment`, `loan.re_writedown`, `collections.past_due_note_retained`, `collections.contact_frequency_7d`, `collections.contact_gate_check`, `collections.contact_gated`, `collections.attorney_identified`, `collections.policy_bound`, `overdraft.daily_report_generated`, `fee.overdraft.suppressed`. All other codes used in this document are registered in the core vocabulary as confirmed by the DESIGN_NOTES dump.

- **State right-to-cure and foreclosure law mapping.** This policy states federal minimum standards. Legal is assumed to maintain a product-level and state-level parameter map that configures tighter SLAs where state law requires. The system must support per-product, per-state grace period and cure-notice configuration. This mapping has not been confirmed as complete; Legal must attest to coverage before go-live.

- **FFIEC guidance applicability.** The FFIEC Uniform Retail Credit Classification and Account Management Policy is incorporated by reference as the standard for retail credit classification and charge-off timing. Pynthia Credit Union is a federally insured credit union; NCUA has adopted these standards. No separate NCUA rule citation is available for the specific DPD thresholds — the FFIEC guidance is the operative source.

- **HMDA reporter status.** This policy does not address HMDA reporting obligations. If Pynthia Credit Union is a HMDA reporter, collections-related data (e.g., loan modifications, charge-offs on HMDA-covered loans) may have LAR implications. This is assumed to be addressed in the Fair Lending Policy and is out of scope here.

- **Partner program collections conduct.** The scope includes co-branded and white-label partner programs. This policy governs conduct requirements for collections on those programs. Vendor management of third-party collectors (including partner-program servicers) is governed by the Third-Party Risk Policy. The boundary between conduct requirements (in scope here) and vendor oversight (out of scope) should be confirmed with Legal and the Third-Party Risk function before go-live.

- **Overdraft lending authority matrix.** CO-10 requires overdraft approval within lending authority. The specific authority tiers (dollar thresholds, approver roles) are assumed to be defined in the Lending Policy authority matrix. This policy does not restate those thresholds; a cross-reference to the authority matrix must be confirmed as current.

- **TDR accounting classification.** CO-04 references TDRs. Under ASC 310-40 (superseded by ASU 2022-02 for fiscal years beginning after December 15, 2022), TDR accounting has been replaced by a modified loan disclosure framework for most institutions. The policy uses "TDR" as a functional label for troubled modifications requiring quarterly review. Finance must confirm the applicable accounting standard and whether the quarterly review cadence aligns with the credit union's adopted accounting framework.

- **CCO as sole approver.** Patrick Wilson is listed as both owner and sole approver. For segregation-of-duties purposes, it is assumed that Board approval (or a designated Board committee) serves as the independent approval for the policy itself, with the CCO as the operational owner. This should be confirmed with governance counsel.

- **Complaint trend review frequency.** PATRICK_NOTES do not specify a frequency for complaint trend reviews beyond "periodic." This policy defaults to at minimum quarterly. If a different frequency is required by examiner expectation or internal risk appetite, the `complaint.trend_review_due` timer should be reconfigured accordingly.

- **Member notice timing for data breaches.** [SC-01](#sc-01-ncua-reportable-cyber-incident-member-notification) states member notices are sent "without unreasonable delay" once misuse is determined likely. State breach-notification laws may impose shorter deadlines. Legal must confirm the applicable state-law overlay and configure `incident.notification_due_at` accordingly.
- **NCUA reportable-incident/member-notice mechanic is a single shared control.** [SC-01](#sc-01-ncua-reportable-cyber-incident-member-notification) is sourced verbatim — same control ID, title, and body — from [`shared-controls/ncua-incident-notification.md`](../shared-controls/ncua-incident-notification.md) and appears identically in Business Continuity Plan, E-Commerce, Electronic Payment Systems, Collections, Information Security, Privacy, and Third-Party Risk. Edit the shared source first, then propagate to all seven; do not edit SC-01 in this policy in isolation. CO-11 carries the collections-specific incident-logging/triage material that used to be bundled into the old CO-08 control.
