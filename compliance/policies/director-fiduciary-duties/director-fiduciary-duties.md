```yaml
---
title: Director Fiduciary Duties Policy (Table-First, Design-Overlay v3)
owner: Patrick Wilson, Chief Compliance Officer
version: v1.0
effective: 2026-07-01
next_review: 2027-07-01
approvers:
  - Patrick Wilson, Chief Compliance Officer
tags: [Compliance, Fiduciary Duties, Conflicts of Interest, Insider Transactions, Affiliate Transactions, Corporate Governance]
---
```

## General Policy Statement

Pynthia Credit Union requires every director, executive officer, principal shareholder, and any employee or contractor with decision-making authority to act at all times in the best interests of the credit union and its membership. Covered persons owe duties of loyalty, care, good faith, confidentiality, impartiality, and continuing disclosure. Conflict-of-interest disclosure is the primary operational mechanism for enforcing the duty of loyalty. Insider credit and affiliate transactions are subject to regulatory limits that must be observed strictly. Violations expose the credit union and individuals to regulatory sanction, civil liability, and criminal prosecution. The Chief Compliance Officer owns this policy; the Board of Directors, Legal/General Counsel, and the Supervisory Committee are required participants in its governance.

---

## Timing Matrix {#timing-matrix}

| Scenario | Trigger (human → event) | Deadline | Content Reference | Control |
|---|---|---:|---|---|
| Annual COI questionnaire issued | Annual cycle opens (`coi.annual_cycle.opened`) | Within 30 days of cycle open | Exhibit A questionnaire | [DF-03](#df-03-annual-and-continuing-disclosure) |
| Ad-hoc conflict arises mid-year | Covered person identifies conflict (`coi.conflict_identified`) | Immediately; before next Board action on the matter | Exhibit B ad-hoc form | [DF-03](#df-03-annual-and-continuing-disclosure) |
| Annual insider/related-interest record | Annual cycle opens | Annually | Insider record compiled and circulated | [DF-03](#df-03-annual-and-continuing-disclosure) |
| Board vote on conflicted matter | Conflict identified on agenda (`board.agenda_item_flagged_conflicted`) | Before vote | Recusal recorded | [DF-04](#df-04-conflict-management-recusal-and-board-determination) |
| Insider credit — Board approval required | Aggregate credit exceeds threshold (`insider.credit_threshold_exceeded`) | Before credit extended | Board approval excluding interested director | [DF-05](#df-05-insider-transactions-reg-o--12-cfr-70121d) |
| Insider credit — Board report | Credit extended to insider (`insider.credit_extended`) | Promptly (next Board meeting) | Board report | [DF-05](#df-05-insider-transactions-reg-o--12-cfr-70121d) |
| Affiliate transaction — limits check | Covered transaction proposed (`affiliate.covered_transaction.proposed`) | Before execution | Limits check and file | [DF-06](#df-06-transactions-with-affiliates-reg-w) |
| Affiliate list update | Annual cycle opens | Annually | Updated affiliate list | [DF-06](#df-06-transactions-with-affiliates-reg-w) |
| Gift/bribery disclosure | Offer or receipt beyond authorized threshold (`gift.disclosure.submitted`) | Promptly | Gift disclosure record | [DF-07](#df-07-bank-bribery-gifts-and-kickbacks) |
| Gift board report | Periodic compilation | Periodically (at least annually) | Board report of gift disclosures | [DF-07](#df-07-bank-bribery-gifts-and-kickbacks) |
| Corporate opportunity identified | Opportunity identified (`corp_opportunity.identified`) | Before personal pursuit | Board presentation and disposition logged | [DF-08](#df-08-corporate-opportunity-and-tie-ins) |
| Public disclosure of insider credit | Written request received (`insider.public_request`) | Promptly on request | Disclosure of qualifying credits | [DF-09](#df-09-recordkeeping-and-reporting) |
| Financial literacy attainment | Director elected or appointed (`covered_person.roster.updated`) | Within 6 months | Literacy attainment recorded | [DF-01](#df-01-fiduciary-duties-defined) |
| Annual policy acknowledgment | Annual cycle opens (`policy.training_cycle.opened`) | Within 30 days of cycle open | Signed acknowledgment | [DF-10](#df-10-training-acknowledgment-and-enforcement) |
| Annual training | Annual cycle opens | Annually | Training completion recorded | [DF-10](#df-10-training-acknowledgment-and-enforcement) |

---

## DF-01 — Fiduciary Duties Defined {#df-01-fiduciary-duties-defined}

**WHY (Reg cite):** [12 CFR §701.4](https://www.ecfr.gov/current/title-12/part-701/section-701.4) establishes the general authorities and duties of federal credit union directors, including the duty of care (good faith, best interests of the membership, prudent-person standard with reasonable inquiry), the duty of impartiality (fair administration without discrimination in favor of or against any particular member), and the financial literacy requirement (working familiarity with basic finance and accounting within 6 months of election or appointment). Common-law fiduciary duties of loyalty, good faith, and confidentiality supplement §701.4 and are codified in California Corporations Code §§ 309 and 310 to the extent Pynthia is state-chartered.

**SYSTEM BEHAVIOR:** The system maintains a roster of covered persons (`covered_person`) with their role, effective date, and status. For each director, it tracks financial literacy attainment against the 6-month deadline from election or appointment date. Overdue directors are flagged automatically. The five core duties (loyalty, care, good faith, confidentiality, disclosure) plus impartiality and financial literacy are defined here as the normative baseline; all other controls in this policy operationalize them. The `covered_person` roster is write-restricted to the Chief Compliance Officer and the Board Secretary.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Director elected or appointed (`covered_person.roster.updated`) | Director identity (`covered_person.id`), role (`covered_person.role`), effective date (`covered_person.effective_date`) | Roster entry created; literacy attainment task opened (`coi.questionnaire.issued` for onboarding acknowledgment) | Literacy attainment required within 6 months (enforced by `training.newhire_due_at`) |
| 6-month literacy deadline approached or passed (`training.completion_due_at`) | Director ID (`covered_person.id`), hire/appointment date (`training.hire_date`), completion status (`training.completion_status`) | Overdue flag raised; alert issued to CCO (`training.lapsed`) | 6 months from appointment (internal: flag at 5 months; enforced by `training.newhire_due_at`) |
| Director completes financial literacy requirement (`training.completed`) | Director ID (`covered_person.id`), module ID (`training.module_id`), assessment score (`training.assessment_score`) | Completion recorded (`training.completion.recorded`); overdue flag cleared | At or before 6-month deadline |
| Annual training cycle opens (`training.annual_cycle.opened`) | Covered person roster (`covered_person.roster`), curriculum version (`training.curriculum_version`) | Annual training assignments created (`training.annual.assigned`) | Annually (internal: assignments issued within 10 BD of cycle open; enforced by `training.annual_due_at`) |

**ALERTS/METRICS:** Alert fires when any director's literacy attainment is overdue (>6 months from appointment with no completion recorded); target count = 0 overdue directors at any time. Annual training completion rate reported to the Board; target ≥ 100% of covered persons within the cycle window.

---

## DF-02 — Conflict Identification and General Duties {#df-02-conflict-identification-and-general-duties}

**WHY (Reg cite):** [12 CFR §163.200](https://www.ecfr.gov/current/title-12/section-163.200) (formerly 12 CFR §563.200; the conflicts-of-interest rule for federal savings associations) requires that persons owing a fiduciary duty to the institution not advance their own interests at the institution's expense, disclose all material information on matters in which they have an interest, and not participate in Board discussion or vote on such matters. These obligations are adopted as internal standards for Pynthia under [12 CFR §701.4](https://www.ecfr.gov/current/title-12/part-701/section-701.4) and California Corporations Code § 310.

**SYSTEM BEHAVIOR:** The system screens each Board agenda item against the current conflict register. When a covered person is identified as having an interest in an agenda item, the item is flagged (`board.agenda_item_flagged_conflicted`) before the meeting. Covered persons must not advance personal or related-party interests at the credit union's expense, must disclose all material non-privileged information on any matter in which they have an interest (including the nature and extent of the interest), and must avoid even the appearance of a conflict. The obligation to disclose is continuing — it applies whenever a conflict arises, not only at annual questionnaire time. The conflict register is write-restricted to the Chief Compliance Officer; read access for Board members is limited to their own entries.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Covered person identifies a potential conflict (`coi.conflict_identified`) | Covered person ID (`covered_person.id`), interest description (`coi.interest_description`), related party (`coi.related_party`), matter reference (`coi.matter_reference`) | Ad-hoc disclosure filed (`coi.adhoc_disclosure.filed`); conflict register entry created (`coi.register_entry.created`) | Immediately upon identification; before any Board action on the matter |
| Board agenda item flagged as conflicted (`board.agenda_item_flagged_conflicted`) | Agenda ID (`board.agenda_id`), conflicted person ID (`covered_person.id`), conflict register entry (`coi.register_entry_id`) | Recusal notice issued (`coi.recusal.executed`); meeting minutes updated to reflect recusal (`board.minutes.recorded`) | Before the Board meeting at which the item is considered |
| Conflicted matter voted on without recusal detected (`coi.conflicted_matter_voted`) | Board minutes (`board.minutes`), conflict register entry (`coi.register_entry_id`), vote record | Escalation created (`escalation.created`); CCO notified | Immediately upon detection |

**ALERTS/METRICS:** Alert fires if a conflicted agenda item proceeds to vote without a recorded recusal; target count = 0 unrecused conflicted votes. Conflict register completeness reviewed quarterly; any gap triggers a CCO investigation task.

---

## DF-03 — Annual and Continuing Disclosure {#df-03-annual-and-continuing-disclosure}

**WHY (Reg cite):** [12 CFR §701.4](https://www.ecfr.gov/current/title-12/part-701/section-701.4) requires directors to act in the members' best interests, and [12 CFR §163.200](https://www.ecfr.gov/current/title-12/section-163.200), the federal savings association conflicts standard Pynthia adopts internally, requires ongoing disclosure of conflicts. [12 CFR §215.8](https://www.ecfr.gov/current/title-12/part-215/section-215.8) (Regulation O) requires annual identification of insiders and their related interests, with insiders reviewing the record for completeness and accuracy.

**SYSTEM BEHAVIOR:** Each calendar year the system opens an annual COI cycle, issues Exhibit A questionnaires to all directors and executive officers, and tracks completion. Questionnaire responses are stored against the covered person's record. Separately, the CCO compiles the annual insider/related-interest record, circulates it to insiders for review, and retains the reviewed record. Ad-hoc disclosures (Exhibit B) are accepted at any time during the year and are linked to the conflict register. Questionnaire issuance and the insider record compilation are write-restricted to the Chief Compliance Officer.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual COI cycle opens (`coi.annual_cycle.opened`) | Covered person roster (`covered_person.roster`), questionnaire version (`coi.questionnaire_version`) | Exhibit A questionnaires issued to all directors and officers (`coi.questionnaire.issued`) | Annually; questionnaires issued within 10 BD of cycle open (enforced by `coi.questionnaire_due_at`) |
| Covered person submits annual questionnaire (`coi.questionnaire.submitted`) | Covered person ID (`covered_person.id`), questionnaire responses (`coi.questionnaire_responses`), attestation signature (`coi.attestation_signature`), attestation date (`coi.attestation_date`) | Questionnaire response recorded; certification logged (`coi.certified`) | Within 30 days of questionnaire issuance (enforced by `coi.questionnaire_due_at`) |
| Annual insider/related-interest record compiled (`insider.record.updated`) | Insider list (`insider.record_entry`), related interests per insider (`insider.record_prior`), prior year record (`insider.record_prior`) | Record compiled (`insider.record_compiled`); record circulated to insiders for review (`insider.record_circulated`) | Annually; compiled within 30 days of cycle open (enforced by `insider_report.due`) |
| Insider reviews and confirms record (`insider.record.updated`) | Insider ID (`covered_person.id`), record entry (`insider.record_entry`), confirmation | Record confirmed as reviewed; any corrections noted | Within 15 BD of circulation |
| Ad-hoc conflict arises mid-year (`coi.conflict_identified`) | Covered person ID (`covered_person.id`), interest description (`coi.interest_description`), matter reference (`coi.matter_reference`) | Exhibit B ad-hoc form filed (`coi.adhoc_disclosure.filed`); conflict register updated (`coi.register_entry.created`) | Immediately upon identification (continuing obligation) |

**ALERTS/METRICS:** Alert fires if any covered person has not submitted their annual questionnaire within 30 days of issuance; target = 100% completion before the first Board meeting of the new year. Alert fires if the annual insider record has not been compiled and circulated within 30 days of cycle open; target count = 0 overdue records.

---

## DF-04 — Conflict Management, Recusal, and Board Determination {#df-04-conflict-management-recusal-and-board-determination}

**WHY (Reg cite):** [12 CFR §163.200](https://www.ecfr.gov/current/title-12/section-163.200), the federal savings association conflicts standard Pynthia adopts internally, bars interested persons from participating in Board discussion or voting on matters in which they have an interest. California Corporations Code § 310 provides the standard for interested-director transactions: approval by a majority of disinterested directors after full disclosure, or a showing that the transaction is just and reasonable. [12 CFR §701.4](https://www.ecfr.gov/current/title-12/part-701/section-701.4) requires directors to act in the best interests of the membership as a whole.

**SYSTEM BEHAVIOR:** When a conflict is identified on a Board agenda item, the system records the recusal, removes the interested director from the quorum count for that item, and confirms that a disinterested quorum exists before the vote proceeds. The Board may appoint an independent reviewer or committee to investigate alternatives. The interested party may make a presentation before the discussion but must leave before deliberation and vote. The Board's determination — including the basis for approving or rejecting the transaction — is recorded in the minutes. Recusal records and Board determinations are write-restricted to the Board Secretary and the Chief Compliance Officer.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Conflict identified on Board agenda (`board.agenda_item_flagged_conflicted`) | Agenda ID (`board.agenda_id`), conflicted person ID (`covered_person.id`), conflict register entry (`coi.register_entry_id`) | Recusal executed and logged (`coi.recusal.executed`; `coi.recusal.logged`); disinterested quorum confirmed (`board.disinterested_quorum`) | Before Board deliberation on the item |
| Independent review ordered by Board (`coi.independent_review`) | Matter reference (`coi.matter_reference`), reviewer assignment, scope | Independent review record created (`coi.independent_review`); findings reported to Board | As directed by Board; before final vote |
| Board votes on conflicted matter (`board.minutes.recorded`) | Disinterested quorum confirmation (`board.disinterested_quorum`), vote record, determination basis (`coi.determination_made`) | Board determination logged in minutes (`board.minutes.recorded`); recusal record archived (`coi.recusal_record`) | At the Board meeting; minutes finalized within 10 BD |

**ALERTS/METRICS:** Alert fires if a Board vote on a flagged item is recorded without a corresponding recusal record; target count = 0. Disinterested quorum failures escalate immediately to the CCO and Legal/General Counsel.

---

## DF-05 — Insider Transactions (Reg O / 12 CFR §701.21(d)) {#df-05-insider-transactions-reg-o--12-cfr-70121d}

**WHY (Reg cite):** [12 CFR Part 215](https://www.ecfr.gov/current/title-12/part-215) (Regulation O) restricts extensions of credit to insiders (directors, executive officers, principal shareholders, and their related interests): credit must be on substantially the same terms and underwriting as comparable non-insider transactions ([§215.4(a)](https://www.ecfr.gov/current/title-12/part-215/section-215.4)); prior Board approval (excluding the interested director) is required when aggregate credit to an insider and related interests exceeds the greater of $25,000 or 5% of unimpaired capital and surplus, or $500,000 ([§215.4(b)](https://www.ecfr.gov/current/title-12/part-215/section-215.4)); the single-borrower limit is 15% of unimpaired capital and surplus (plus 10% for readily marketable collateral) ([§215.4(c)](https://www.ecfr.gov/current/title-12/part-215/section-215.4)); aggregate insider credit must not exceed unimpaired capital and surplus ([§215.4(d)](https://www.ecfr.gov/current/title-12/part-215/section-215.4)); and extensions must be reported promptly to the Board ([§215.4(b)](https://www.ecfr.gov/current/title-12/part-215/section-215.4)). [12 CFR §701.21(d)](https://www.ecfr.gov/current/title-12/part-701/section-701.21) sets a Board-approval trigger at $20,000 plus pledged shares for federal credit unions; Legal must confirm the operative threshold based on Pynthia's charter type. No insider may knowingly receive credit not in compliance with these restrictions ([§215.6](https://www.ecfr.gov/current/title-12/part-215/section-215.6)).

**SYSTEM BEHAVIOR:** Every loan application is screened for insider status at origination (`loan_application.insider.screened`). When aggregate credit to an insider and related interests approaches or exceeds the applicable Board-approval threshold, the system blocks funding and routes the application for Board approval, excluding the interested director from the vote. Terms-parity is checked against a comparable non-insider benchmark before approval. Line-of-credit Board approvals expire after 14 months. The single-borrower limit and aggregate insider limit are computed against current unimpaired capital and surplus (`cu.unimpaired_capital_surplus`) at each extension. All extensions are reported to the Board promptly. Insider credit records are write-restricted to the Chief Lending Officer and the Chief Compliance Officer; the Board approval record is write-restricted to the Board Secretary.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Loan application received from or flagged as insider (`loan_application.insider.flagged`) | Applicant identity (`loan_application.applicant`), insider flag (`loan_application.insider`), aggregate credit amount (`insider.aggregate_credit_amount`), related interests (`insider.record_entry`) | Insider screen logged (`loan_application.insider.screened`); terms-parity check initiated (`insider.terms_parity`) | At application intake |
| Aggregate credit threshold exceeded (`insider.credit_threshold_exceeded`) | Insider ID (`covered_person.id`), aggregate credit amount (`insider.aggregate_credit_amount`), unimpaired capital and surplus (`cu.unimpaired_capital_surplus`), proposed terms (`insider.proposed_terms`), comparable terms benchmark (`insider.comparable_terms`) | Board approval task created; funding blocked pending approval (`insider.board_approval`) | Before credit is extended; Board approval required prior to commitment (enforced by `insider.loc_approval_expires_at` for lines of credit — 14-month validity) |
| Board approves insider credit (excluding interested director) (`insider.board_approval.recorded`) | Board approval record (`insider.board_approval`), disinterested quorum confirmation (`board.disinterested_quorum`), terms parity confirmation (`insider.terms_parity`), funded terms (`insider.funded_terms`) | Board approval recorded (`insider.board_approval.recorded`); credit may proceed | Before credit is extended |
| Credit extended to insider (`insider.credit_extended`) | Insider ID (`covered_person.id`), credit amount, funded terms (`insider.funded_terms`), board approval reference (`insider.board_approval`) | Extension reported to Board (`insider.board_report.issued`); limits recomputed (`insider.limits_recomputed`) | Promptly; reported at next Board meeting (internal: within 5 BD of extension) |
| Single-borrower or aggregate limit approached or breached (`insider.limits_recomputed`) | Aggregate credit amount (`insider.aggregate_credit_amount`), unimpaired capital and surplus (`cu.unimpaired_capital_surplus`), limit thresholds | Alert issued to CCO and Chief Lending Officer; further extensions blocked if limit exceeded | Immediately upon computation |

**ALERTS/METRICS:** Alert fires when any insider's aggregate credit reaches 90% of the single-borrower limit or when aggregate insider credit reaches 90% of unimpaired capital and surplus; target = 0 limit breaches. Board report lag (extension to report) monitored; target ≤ 5 BD.

---

## DF-06 — Transactions with Affiliates (Reg W) {#df-06-transactions-with-affiliates-reg-w}

**WHY (Reg cite):** Sections 23A and 23B of the Federal Reserve Act ([12 U.S.C. §§ 371c](https://www.law.cornell.edu/uscode/text/12/371c), [371c-1](https://www.law.cornell.edu/uscode/text/12/371c-1)) and [12 CFR Part 223](https://www.ecfr.gov/current/title-12/part-223) (Regulation W) limit covered transactions with any single affiliate to 10% of unimpaired capital and surplus and with all affiliates in the aggregate to 20%; require collateral at specified coverage ratios for credit transactions; require market terms on all covered and related transactions; prohibit purchase of low-quality assets from affiliates; and prohibit advertisements or agreements suggesting the credit union is responsible for affiliate obligations. These provisions are adopted as internal standards per Patrick Wilson's direction.

**SYSTEM BEHAVIOR:** The system maintains an affiliate list (`affiliate.list`) updated at least annually. Every proposed covered transaction is screened against the per-affiliate and aggregate limits before execution. Credit transactions with affiliates require collateral at the applicable coverage ratio (100%–130% depending on collateral type). All covered transactions must be on market terms; the market-terms basis is documented at the time of the transaction. Low-quality asset purchases from affiliates are prohibited unless an independent credit evaluation pre-dates the affiliate's acquisition of the asset. Transaction records identify the affiliate, transaction type, dollar amount, limit utilization, collateral type and value, low-quality asset status, and market-terms basis. The affiliate list and transaction records are write-restricted to the Chief Financial Officer and the Chief Compliance Officer.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Covered transaction with affiliate proposed (`affiliate.covered_transaction.proposed`) | Affiliate ID (`affiliate.list_entry`), transaction type (`affiliate.transaction_type`), transaction amount (`affiliate.transaction_amount`), current limit utilization (`affiliate.limit_utilization`), unimpaired capital and surplus (`cu.unimpaired_capital_surplus`) | Limits checked (`affiliate.limits.checked`); transaction blocked if limit would be exceeded | Before execution |
| Credit transaction with affiliate proposed (`affiliate.credit_transaction.funded`) | Affiliate ID (`affiliate.list_entry`), credit amount, collateral type (`affiliate.collateral_type`), collateral value (`affiliate.collateral_value`), required coverage ratio (`affiliate.required_coverage_ratio`), market terms basis (`affiliate.market_terms_basis`) | Collateral adequacy confirmed; market terms documented; transaction recorded (`affiliate.transaction.recorded`) | Before funding |
| Asset purchase from affiliate proposed (`affiliate.asset_purchase.proposed`) | Affiliate ID (`affiliate.list_entry`), asset quality classification (`affiliate.asset_quality_classification`), independent evaluation (`affiliate.independent_evaluation`), market terms basis (`affiliate.market_terms_basis`) | Low-quality asset screen logged (`affiliate.lqa_screen.logged`); transaction blocked if low-quality asset without qualifying pre-commitment | Before purchase |
| Annual affiliate list review opens (`affiliate.list_review.opened`) | Current affiliate list (`affiliate.list`), ownership/control data | Updated affiliate list published (`affiliate.list.updated`) | Annually (internal: within 30 days of fiscal year-end) |
| Covered transaction executed (`affiliate.transaction.recorded`) | All fields above plus transaction file | Transaction file archived (`affiliate.transaction_file_archived`); board report updated | At execution; retained per Record Retention Policy |

**ALERTS/METRICS:** Alert fires when per-affiliate utilization reaches 80% of the 10% cap or aggregate utilization reaches 80% of the 20% cap; target = 0 limit breaches. Affiliate list staleness alert fires if list has not been updated within 12 months.

---

## DF-07 — Bank Bribery, Gifts, and Kickbacks {#df-07-bank-bribery-gifts-and-kickbacks}

**WHY (Reg cite):** [18 U.S.C. § 215](https://www.law.cornell.edu/uscode/text/18/215) (Federal Bank Bribery Law) prohibits any officer, director, employee, agent, or attorney of a financial institution from soliciting or receiving anything of value in connection with any transaction or business of the institution, except bona fide salary, wages, fees, or compensation paid in the ordinary course of business. Violation is a criminal offense. The Guidelines for Compliance with the Federal Bank Bribery Law, 52 Fed. Reg. 43941 (1987), identify permissible exceptions (family gifts, reasonable business meals, advertising items, customary loans, recognized-event gifts, civic awards). Pynthia adopts defined de minimis thresholds in Exhibit C.

**SYSTEM BEHAVIOR:** All covered persons are prohibited from soliciting or receiving anything of value in connection with credit union business beyond what is authorized in Exhibit C. When a covered person receives or is offered something beyond the authorized threshold, they must disclose it promptly using the gift disclosure process. The system records each disclosure, compares the estimated value against the Exhibit C threshold, and routes disclosures to the CCO. The CCO compiles disclosures periodically and reports them to the Board. Gift records are write-restricted to the Chief Compliance Officer.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Covered person receives or is offered a gift/benefit beyond authorized threshold (`gift.disclosure.submitted`) | Covered person ID (`covered_person.id`), source party (`gift.source_party`), estimated value (`gift.estimated_value`), threshold comparison (`gift.threshold_comparison`), description (`gift.disclosure`) | Gift disclosure record created (`gift.record_entry.created`); CCO notified | Promptly upon receipt or offer |
| CCO reviews gift disclosure (`gift.ruling.issued`) | Gift record entry (`gift.record_entry_id`), disposition decision (`gift.disposition`) | Ruling issued (`gift.ruling.issued`); disposition recorded | Within 10 BD of disclosure |
| Periodic Board report compiled (`gift.board_report.issued`) | All gift disclosure records for the period (`gift.record_entry_id`), disposition summaries (`gift.disposition`) | Board report issued (`gift.board_report.issued`) | At least annually; at each regular Board meeting if disclosures exist |

**ALERTS/METRICS:** Alert fires if a gift disclosure has not received a CCO ruling within 10 BD; target = 0 unruled disclosures older than 10 BD. Board report lag monitored; target = report delivered at the next regular Board meeting following any disclosure.

---

## DF-08 — Corporate Opportunity and Tie-Ins {#df-08-corporate-opportunity-and-tie-ins}

**WHY (Reg cite):** [12 CFR §163.201](https://www.ecfr.gov/current/title-12/section-163.201) (formerly 12 CFR §563.201; the corporate-opportunity rule for federal savings associations, adopted by Pynthia as an internal standard) bars directors, officers, and other fiduciaries from taking advantage of corporate opportunities belonging to the institution. A corporate opportunity belongs to the credit union if it is within its corporate authority and of present or potential practical advantage. A disinterested majority Board rejection after full and fair presentation provides a safe harbor. Prohibited tie-in arrangements are barred by [12 U.S.C. § 1464(q)](https://www.law.cornell.edu/uscode/text/12/1464) and [12 U.S.C. § 2608](https://www.law.cornell.edu/uscode/text/12/2608) (RESPA title insurance tying).

**SYSTEM BEHAVIOR:** When a covered person identifies a business opportunity that may belong to the credit union, they must present it to the Board before pursuing it personally or through a related party. The Board evaluates the opportunity and records its disposition — acceptance, rejection as a matter of sound business judgment, or referral. If the Board rejects the opportunity after full and fair presentation by a disinterested majority, the covered person may pursue it without violating this policy. Tie-in arrangements — conditioning credit, property, or services on the customer obtaining additional products from the credit union or its affiliates, or on the customer not obtaining products from a competitor — are prohibited. Tie-in reviews are logged when flagged. Corporate opportunity and tie-in records are write-restricted to the Chief Compliance Officer and the Board Secretary.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Corporate opportunity identified by covered person (`corp_opportunity.identified`) | Covered person ID (`covered_person.id`), opportunity description (`corp_opportunity.description`), authority assessment (`corp_opportunity.authority_assessment`) | Opportunity presented to Board (`corp_opportunity.presented`); Board agenda item created | Before personal pursuit of the opportunity |
| Board votes on corporate opportunity (`corp_opportunity.board_voted`) | Board vote record, disinterested quorum confirmation (`board.disinterested_quorum`), disposition (`corp_opportunity.disposition`) | Disposition logged (`corp_opportunity.disposition.logged`); minutes updated (`board.minutes.recorded`) | At the Board meeting; minutes finalized within 10 BD |
| Tie-in arrangement flagged (`tiein.flagged`) | Transaction terms (`tiein.transaction_terms`), condition description (`tiein.condition_description`), flagging source | Tie-in review logged (`tiein.review.logged`); CCO and Legal notified; transaction blocked pending review | Immediately upon detection |

**ALERTS/METRICS:** Alert fires if a corporate opportunity presentation has not received a Board disposition within 30 days of identification; target = 0 undisposed opportunities older than 30 days. Tie-in flags are reviewed within 5 BD; target = 0 unreviewed flags older than 5 BD.

---

## DF-09 — Recordkeeping and Reporting {#df-09-recordkeeping-and-reporting}

**WHY (Reg cite):** [12 CFR §215.8](https://www.ecfr.gov/current/title-12/part-215/section-215.8) requires annual identification of insiders and their related interests. [12 CFR §§ 215.11 and 215.23](https://www.ecfr.gov/current/title-12/part-215/section-215.11) require public disclosure of qualifying insider credit on written request, with a 2-year retention of requests and dispositions. Affiliate transaction records must be maintained per [12 CFR §223](https://www.ecfr.gov/current/title-12/part-223) (Regulation W). Retention schedules for disclosures and director records are governed by the Record Retention Policy.

**SYSTEM BEHAVIOR:** The system retains all COI disclosures, insider/related-interest records, affiliate transaction records, and gift disclosures as permanent or long-term records per the Record Retention Policy. On receipt of a written public request for insider credit information, the CCO identifies qualifying credits (aggregate ≥ lesser of 5% of unimpaired capital and surplus or $500,000, and > $25,000) and discloses the names of qualifying executive officers and principal shareholders (not specific amounts). The request and disposition are retained for 2 years. Public disclosure records are write-restricted to the Chief Compliance Officer.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Written public request for insider credit information received (`insider.public_request`) | Requester identity (`insider.public_request`), request date, prior calendar year credit data (`insider.correspondent_credit_data`), unimpaired capital and surplus (`cu.unimpaired_capital_surplus`) | Qualifying credits identified; public disclosure issued (`insider.public_disclosure.issued`); request and disposition retained (`insider.public_request_retention_expires_at`) | Promptly on receipt; retention for 2 years from request date (enforced by `insider.public_request_retention_expires_at`) |
| Annual insider record compiled and reviewed (see [DF-03](#df-03-annual-and-continuing-disclosure)) | Insider list, related interests | Record retained per Record Retention Policy (`record.retained`) | Annually; permanent retention per Record Retention Policy |
| Affiliate transaction executed (see [DF-06](#df-06-transactions-with-affiliates-reg-w)) | Transaction file (`affiliate.transaction_file_archived`) | Transaction record retained per Record Retention Policy | At execution; retained per Record Retention Policy |
| COI disclosure filed (see [DF-03](#df-03-annual-and-continuing-disclosure)) | Disclosure record (`coi.register_entry_id`) | Disclosure retained per Record Retention Policy | At filing; retained per Record Retention Policy |

**ALERTS/METRICS:** Alert fires if a public disclosure request has not been responded to within 10 BD; target = 0 overdue responses. Retention compliance for insider and affiliate records reviewed annually by the Supervisory Committee.

---

## DF-10 — Training, Acknowledgment, and Enforcement {#df-10-training-acknowledgment-and-enforcement}

**WHY (Reg cite):** [12 CFR §701.4](https://www.ecfr.gov/current/title-12/part-701/section-701.4) requires directors to maintain financial literacy and act with the care of an ordinarily prudent person. Sound governance practice — and the enforcement provisions adopted from the reference policy — require annual distribution, acknowledgment, and training on this policy, with defined sanctions for willful violations. [18 U.S.C. § 215](https://www.law.cornell.edu/uscode/text/18/215) provides criminal penalties for bribery violations.

**SYSTEM BEHAVIOR:** At each annual cycle open, the policy is distributed to all directors and executive officers, and each covered person must sign and return an acknowledgment within 30 days. New directors and officers receive the policy and must acknowledge it upon election, appointment, or promotion. Annual training is assigned to all covered persons and must be completed within the cycle window. Willful violations may result in: (a) for directors — required return of benefits received and resignation from the Board; (b) for officers — required return of benefits received and dismissal. The CCO escalates confirmed violations to the Board for sanction determination. Acknowledgment records and training completions are write-restricted to the Chief Compliance Officer.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual policy cycle opens (`policy.training_cycle.opened`) | Covered person roster (`covered_person.roster`), policy version (`policy.document_version`) | Policy distributed (`policy.distribution.logged`); acknowledgment tasks created for all covered persons | Annually; distribution within 5 BD of cycle open |
| Covered person signs annual acknowledgment (`policy.acknowledgment.signed`) | Covered person ID (`covered_person.id`), policy version (`policy.document_version`), signature date | Acknowledgment recorded (`policy.acknowledgment.signed`); compliance record filed (`policy.compliance_record.filed`) | Within 30 days of distribution (enforced by `policy.acknowledgment_due_at`) |
| New director or officer onboarded (`covered_person.roster.updated`) | Covered person ID (`covered_person.id`), role (`covered_person.role`), effective date (`covered_person.effective_date`) | Policy distributed; onboarding acknowledgment filed (`policy.onboarding_acknowledgment.filed`) | Upon election, appointment, or promotion |
| Annual training cycle opens (`training.annual_cycle.opened`) | Covered person roster, curriculum version (`training.curriculum_version`) | Training assignments created (`training.annual.assigned`) | Annually; assignments issued within 10 BD of cycle open (enforced by `training.annual_due_at`) |
| Covered person completes annual training (`training.completed`) | Covered person ID (`covered_person.id`), module ID (`training.module_id`), assessment score (`training.assessment_score`) | Completion recorded (`training.completion.recorded`) | Within annual cycle window (enforced by `training.annual_due_at`) |
| Willful violation confirmed by Board (`policy.sanction.recorded`) | Violation description (`policy.violation_description`), covered person ID (`covered_person.id`), Board determination, sanction type | Sanction recorded (`policy.sanction.recorded`); escalation closed (`escalation.routed`) | At the Board meeting at which the determination is made |

**ALERTS/METRICS:** Alert fires if any covered person has not completed their annual acknowledgment within 30 days of distribution; target = 100% completion. Alert fires if any covered person has not completed annual training within the cycle window; target = 100% completion. Sanction determinations are reported to the Supervisory Committee within 10 BD of the Board decision.

---

## Governance & Sign-Off {#governance}

**Policy Owner:** Patrick Wilson, Chief Compliance Officer

**Approvers:**
- Patrick Wilson, Chief Compliance Officer

**Review Cadence:** This policy is reviewed at least annually by the Board of Directors and revised as necessary to conform to current laws and regulations. The CCO initiates the review no later than 60 days before the next_review date.

**Required Participants:** Board of Directors (approval authority); Legal/General Counsel (charter-type confirmation, threshold confirmation, tie-in and RESPA review); Supervisory Committee (oversight of insider lending and affiliate transaction compliance).

**Cross-References:**
- Lending Policy — insider loan underwriting and operational process
- Compliance Policy — general compliance governance, whistleblower, complaint intake
- Record Retention Policy — retention schedules for disclosures and director records
- Reimbursement, Insurance and Indemnification Policy — director/officer indemnification and insurance
- Resolution Policy — Board resolutions, bylaws, general governance mechanics
- Third-Party Risk Policy — enterprise affiliate/vendor risk beyond Reg W transaction limits

**Exhibits Referenced (maintained separately):**
- Exhibit A — Annual COI Questionnaire
- Exhibit B — Ad-Hoc Conflict Disclosure Form
- Exhibit C — Gift and Entertainment Thresholds

---

## Assumptions & Gaps {#assumptions}

- **Charter type and operative insider-credit threshold must be confirmed by Legal.** Patrick's notes identify two potentially applicable thresholds: the Regulation O Board-approval trigger (greater of $25,000 or 5% of unimpaired capital and surplus, or $500,000) and the NCUA-specific federal credit union trigger under 12 CFR §701.21(d) ($20,000 plus pledged shares). The operative threshold depends on whether Pynthia Credit Union holds a federal or state charter. Legal/General Counsel must confirm the charter type and the applicable threshold before this policy is finalized. DF-05 currently references both; the inapplicable threshold should be removed at next review.

- **California state-charter applicability.** AUTHORITY_HINTS reference California Corporations Code §§ 309 and 310 and the California Financial Code / DFPI. These apply if Pynthia is state-chartered. If Pynthia is a federal credit union, §701.4 is the primary authority and California law supplements it only to the extent not preempted. Legal must confirm and the WHY fields in DF-01 and DF-04 should be updated accordingly.

- **Regulation W applicability to credit unions.** Regulation W (12 CFR Part 223) was promulgated under the Federal Reserve Act and applies directly to member banks. Its adoption as an internal standard for Pynthia is per Patrick Wilson's direction. Legal should confirm whether any NCUA-specific affiliate transaction rule (e.g., a state-charter analog) applies in addition to or instead of Reg W, and whether the Reg W exemptions (12 CFR §§ 223.41–43) are adopted in full.

- **Exhibit C gift thresholds not yet defined.** Patrick's notes reference Exhibit C for de minimis gift/entertainment thresholds but do not specify the dollar amounts. The CCO must define these thresholds (consistent with 18 U.S.C. § 215 guidance and the 52 Fed. Reg. 43941 guidelines) before the policy is distributed. DF-07 references Exhibit C as the operative threshold document.

- **Engineering vocabulary is provisional.** Several field and event codes used in the EVENTS tables throughout this document are drawn from the registered core-API vocabulary (`coi`, `insider`, `affiliate`, `gift`, `corp_opportunity`, `tiein`, `covered_person`, `board`, `policy`, `training`, `cu`). These objects and most of their fields are registered. The following codes are composed per the grammar and are flagged as provisional pending engineering confirmation: `cu.unimpaired_capital_surplus` (field on `cu` object — registered per DESIGN_NOTES), `insider.credit_threshold_exceeded` (composed: `insider.credit_threshold.exceeded` — provisional spelling), `coi.conflict_identified` (composed: `coi.conflict.identified` — provisional spelling), `insider.record_compiled` and `insider.record_circulated` (provisional properties on `insider`). Engineering should confirm or register these codes before the next review cycle.

- **"Promptly" for Board reporting of insider credit extensions.** Regulation O requires extensions to be "reported promptly" to the Board but does not define a specific number of days. This policy adopts an internal SLA of the next Board meeting or within 5 BD, whichever is sooner. The Board may adjust this SLA by resolution.

- **Aggregate insider credit limit — small-institution exception.** 12 CFR §215.4(d) permits the Board of a depository institution with deposits under $100 million to increase the aggregate insider credit limit to up to 2× unimpaired capital and surplus by annual resolution, subject to conditions. This policy does not pre-authorize that exception; if Pynthia wishes to invoke it, the Board must adopt a qualifying resolution and the CCO must update DF-05 accordingly.

- **Public disclosure threshold — correspondent bank credits.** 12 CFR §§ 215.11 and 215.23 require disclosure of credits by correspondent banks to Pynthia's executive officers and principal shareholders. The reference policy language is adapted from a bank context. The CCO should confirm with Legal whether Pynthia has correspondent banking relationships that trigger this specific disclosure obligation, or whether the obligation is limited to Pynthia's own extensions of credit.

- **Retention periods for disclosures and director records.** This policy defers retention schedules to the Record Retention Policy. The Record Retention Policy should specify that COI questionnaires, ad-hoc disclosures, insider records, affiliate transaction records, gift disclosures, and public disclosure requests and dispositions are retained for the periods required by applicable law (typically permanent for director records; 2 years for public disclosure requests per 12 CFR §215.11; and as required by Reg W for affiliate transaction records).
