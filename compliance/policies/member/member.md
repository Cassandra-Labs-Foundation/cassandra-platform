```yaml
---
title: Member Policy (Table-First, Design-Overlay v3)
owner: Patrick Wilson, Chief Compliance Officer
version: v1.0
effective: 2026-07-01
next_review: 2027-07-01
approvers:
  - Patrick Wilson, Chief Compliance Officer
tags: [Compliance, Member Lifecycle, Membership, Expulsion, Disputes, Account Maintenance]
---
```

## General Policy Statement

Pynthia Credit Union (the "Credit Union") is a California state-chartered credit union committed to serving members throughout the full arc of their relationship with the institution — from eligibility determination and onboarding through account maintenance, dispute resolution, account restrictions and closures, expulsion, and estate handling. This policy establishes the minimum controls governing each stage of the member lifecycle, ensures that member rights are protected in accordance with California Credit Union Law ([Cal. Fin. Code §§ 14000 et seq.](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=FIN&sectionNum=14000.)), the California Consumer Financial Protection Law, [Regulation E (12 CFR Part 1005)](https://www.ecfr.gov/current/title-12/part-1005), [Regulation P (12 CFR Part 1016)](https://www.ecfr.gov/current/title-12/part-1016), and the [FACT Act Red Flags Rule (16 CFR Part 681)](https://www.ecfr.gov/current/title-16/part-681), and that operational risk is managed through documented, auditable processes. Governance is centralized with the Chief Compliance Officer; Member Services, BSA, and the Board of Directors participate as required by specific controls. CIP/identity-verification program details, Red Flags technical controls, privacy notices, record retention schedules, UDAAP monitoring, e-commerce channel controls, and Truth-in-Savings disclosure content are governed by their respective policies and are out of scope here.

---

## Timing Matrix {#timing-matrix}

| Scenario | Trigger (human → event) | Deadline | Content Reference | Control |
|---|---|---:|---|---|
| Eligibility determination at onboarding | Membership application received (`member.application.submitted`) | Before account opened | Field-of-membership rules; CIP hand-off | [MP-01](#mp-01-membership-eligibility-and-onboarding) |
| Ineligibility notice to applicant | Eligibility check fails (`member.eligibility_rule.failed`) | Prompt; no statutory deadline — internal SLA: 3 business days | Written notice of ineligibility | [MP-01](#mp-01-membership-eligibility-and-onboarding) |
| Address-change notice to prior address | Address change processed (`entity.address.changed`) | Same business day | Notice to old and new address | [MP-02](#mp-02-account-maintenance-and-change-of-address) |
| Card/statement hold after address change | Address change processed (`entity.address.changed`) | Hold expires after 7 calendar days (`member.address_hold_expires_at`) | No new card or statement dispatched during hold | [MP-02](#mp-02-account-maintenance-and-change-of-address) |
| Red Flags review on suspicious address change | Suspicious pattern detected (`redflag.detected`) | Immediate — same business day | Step-up verification or case opened | [MP-02](#mp-02-account-maintenance-and-change-of-address) |
| Complaint acknowledgement | Complaint received (`complaint.received`) | 5 business days (`complaint.ack_due_at`) | Written or electronic acknowledgement | [MP-04](#mp-04-member-disputes-and-dispute-resolution) |
| Complaint initial response | Complaint logged (`complaint.logged`) | 15 calendar days (`complaint.initial_response_due_at`) | Substantive response or status update | [MP-04](#mp-04-member-disputes-and-dispute-resolution) |
| Complaint final response | Investigation complete (`complaint.investigation.completed`) | 45 calendar days (`complaint.final_response_due_at`) | Final written response | [MP-04](#mp-04-member-disputes-and-dispute-resolution) |
| Reg E error-resolution provisional credit | EFT error dispute opened (`dispute.opened`) | 10 business days (`dispute.provisional_credit_due_at`) | Provisional credit posted | [MP-04](#mp-04-member-disputes-and-dispute-resolution) |
| Reg E error-resolution final determination | EFT error investigation complete (`dispute.investigation.completed`) | 45 calendar days (`dispute.response_due_at`) | Written determination + correction if error confirmed | [MP-04](#mp-04-member-disputes-and-dispute-resolution) |
| Account restriction notice to member | Restriction approved (`account.restriction.approved`) | Same business day | Written notice of restriction and grounds | [MP-05](#mp-05-account-restrictions-and-closures) |
| Account closure notice to member | Closure approved (`account.closure.approved`) | Minimum 10 calendar days before closure (internal SLA) | Written notice of closure and payout timeline | [MP-05](#mp-05-account-restrictions-and-closures) |
| Closure payout to member | Account closed (`account.closed`) | Promptly; internal SLA: 5 business days (`account.closure_payout_due_at`) | Payout of share balance net of amounts owed | [MP-05](#mp-05-account-restrictions-and-closures) |
| Expulsion notice to member | Expulsion decided (`member.expulsion.decided`) | Prompt written notice before effective date | Written notice of grounds and hearing right | [MP-06](#mp-06-member-expulsion) |
| Member hearing request deadline | Expulsion notice sent (`member.expulsion_notice.sent`) | 30 calendar days from notice date | Member's written request for special meeting | [MP-06](#mp-06-member-expulsion) |
| Expulsion payout | Expulsion effective (`member.expelled`) | Promptly as funds available, net of amounts owed (`member.expulsion_payout`) | Share balance payout | [MP-06](#mp-06-member-expulsion) |
| Death flag on account | Death reported (`member.death.reported`) | Same business day | Account flagged; new transactions reviewed | [MP-07](#mp-07-member-death-and-estate-handling) |
| Estate claim payout | Claim documented and verified (`estate.claim.submitted`) | Internal SLA: 30 calendar days (`estate.payout_due_at`) | Payout to verified claimant net of amounts owed | [MP-07](#mp-07-member-death-and-estate-handling) |
| Member service first response | Inquiry received (`service.inquiry.received`) | 1 business day (`service.first_response_due_at`) | Acknowledgement or resolution | [MP-09](#mp-09-member-service-standards) |
| Member service resolution | Inquiry open (`service.inquiry.received`) | 5 business days (`service.resolution_due_at`) | Resolution or escalation to complaint | [MP-09](#mp-09-member-service-standards) |

---

## MP-01 — Membership Eligibility and Onboarding {#mp-01-membership-eligibility-and-onboarding}

**WHY (Reg cite):** California Credit Union Law ([Cal. Fin. Code §§ 14050–14052](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=FIN&sectionNum=14050.)) requires that membership be limited to persons within the credit union's field of membership as defined in its charter and bylaws; admission of an ineligible person is ultra vires. Identity verification at account opening is required by the BSA CIP program (31 CFR § 1020.220), which this control gates but does not duplicate.

**SYSTEM BEHAVIOR:** When a prospective member submits an application, the system evaluates the applicant's eligibility against the registered field-of-membership rules (`member.eligibility_rule`) before any account is created. If eligibility is confirmed, the system hands off to the CIP/identity-verification process (governed by the BSA Policy); a membership and share account are established only after CIP returns a passed verification (`verification.completed` with `verification.status` = `approved`). If eligibility fails, the system issues an ineligibility notice and no account is opened. If CIP fails, the application is declined and the applicant is notified. The eligibility basis and CIP outcome are recorded on the member record. Member Services staff may read eligibility determinations; only Compliance may override a failed eligibility check, and any override must be documented with rationale.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Prospective member submits application (`member.application.submitted`) | Applicant identity (`entity.name`, `entity.date_of_birth`, `entity.tin`), eligibility evidence (`member.eligibility_basis`, `member.eligibility_rule`) | Eligibility determination recorded (`member.eligibility_determined`); if failed, ineligibility notice queued (`member.eligibility_denied`) | Immediate — before account creation |
| Eligibility check fails (`member.eligibility_rule.failed`) | Applicant contact information (`entity.contact`), denial basis (`member.eligibility_rule`) | Ineligibility notice sent to applicant (`member.ineligibility_notice.sent`) | Internal SLA: 3 business days |
| Eligibility confirmed; CIP hand-off initiated (`verification.created`) | Applicant identity documents per BSA Policy; `verification.type`, `verification.provider` | CIP/verification record created; outcome returned (`verification.completed`) | Per BSA Policy SLA |
| CIP passes (`verification.completed` with status `approved`) | `verification.status`, `verification.provider_result`, `member.eligibility_determined` | Member record activated (`member.activated`); share account created (`account.created`) | Same business day as CIP pass |
| CIP fails or is denied (`verification.denied`) | `verification.status`, `verification.provider_result` | Application declined; applicant notified; no account created | Same business day as CIP outcome |

**ALERTS/METRICS:** Alert if any `account.created` event is not preceded by a `verification.completed` (status `approved`) event on the same member within the same session — target zero occurrences. Monitor the ratio of `member.eligibility_rule.failed` to `member.application.submitted` monthly; spikes may indicate field-of-membership boundary issues requiring Compliance review.

---

## MP-02 — Account Maintenance and Change of Address {#mp-02-account-maintenance-and-change-of-address}

**WHY (Reg cite):** The [FACT Act Red Flags Rule (16 CFR Part 681)](https://www.ecfr.gov/current/title-16/part-681) requires covered financial institutions to detect and respond to red flags — including suspicious address changes — as part of an identity-theft prevention program. The USA PATRIOT Act (31 U.S.C. § 5318(l)) requires that a physical address be maintained on the customer record. California Consumer Financial Protection Law imposes UDAAP standards on member interactions, including account servicing.

**SYSTEM BEHAVIOR:** Before processing any address change, the system requires identity verification of the requesting member using the method registered on the member record (`member.identity_check_method`); telephone requests require secondary-level identification per the BSA Policy. Upon processing, the system automatically dispatches a notice to both the prior address and the new address on the same business day. A 7-calendar-day hold is placed on dispatch of any new card or statement to the new address (`member.address_hold_expires_at`); card reissue requests received during the hold are queued and released only after the hold expires or is cleared by Compliance. Every address change is evaluated against the Red Flags ruleset (`redflag.ruleset`); if a red flag is detected (e.g., `redflag.address_reissue_match` = true, or a pattern of rapid successive changes), a step-up verification is required or a case is opened before the change is finalized. If the address change is disputed by the member (i.e., the member contacts the Credit Union to report a notice they did not initiate), the change is immediately flagged (`member.address_change_disputed`) and routed to the Information Security team per the Information Security Policy. PO Box requests are handled at the account level only; the customer-level record must retain a physical address. Address-change write access is restricted to Member Services staff with supervisor approval for changes flagged by Red Flags; Compliance has read access to all address-change audit records.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Member requests address change (in-branch or by phone) | Member identity verification (`member.identity_check_method`, `verification.status`), current address on file (`entity.address_previous`), new address (`entity.address_new`) | Identity verification result recorded (`verification.completed`); address change held pending verification | Before change is processed |
| Identity verification passes for address change (`verification.completed` with status `approved`) | `entity.address_previous`, `entity.address_new`, all linked account IDs | Address updated on entity and all linked accounts (`entity.address.changed`); address-hold timer set (`member.address_hold_expires_at`); notice queued to old and new address (`member.address_notice`) | Same business day |
| Address-change notice dispatched (`member.address_notice.sent`) | `entity.address_previous`, `entity.address_new`, member ID (`member.id`) | Notice sent to prior address and new address (`member.address_notice.sent`) | Same business day as address change |
| Red Flags evaluation runs on address change (`redflag.detected`) | `redflag.ruleset`, `redflag.address_reissue_match`, `redflag.stepup_required`, member transaction history | Red flag case opened (`redflags.case.opened`) or step-up verification initiated (`verification.created`); address change suspended until resolved | Same business day |
| Card or statement request received during address hold (`card.request_during_address_hold`) | `member.address_hold_expires_at`, card reissue request (`card.reissue_request`) | Request queued; dispatch blocked until hold expires (`member.address_hold_expires_at`) | Hold expires 7 calendar days after address change |
| Member disputes address change they did not initiate | Member contact (`entity.contact`), disputed change record (`member.address_change_disputed`) | Dispute flag set (`member.address_change_disputed`); routed to Information Security per Information Security Policy | Same business day as member contact |

**ALERTS/METRICS:** Alert in real time on any `redflag.detected` event tied to an address change where `redflag.stepup_required` = true and no subsequent `redflag.stepup.completed` is recorded within 1 business day — target zero unresolved. Monitor count of `member.address_change_disputed` events monthly; any instance triggers an Information Security review.

---

## MP-03 — Member Communications and Preferences {#mp-03-member-communications-and-preferences}

**WHY (Reg cite):** [Regulation P (12 CFR Part 1016)](https://www.ecfr.gov/current/title-12/part-1016) requires that opt-out elections be honored and that required privacy notices be delivered. The E-SIGN Act (15 U.S.C. § 7001) requires affirmative consent before electronic delivery of required disclosures; consent must be captured and retained. California Consumer Financial Protection Law imposes UDAAP standards on member communications.

**SYSTEM BEHAVIOR:** The system captures each member's communication preferences (`member.contact_preferences`) and e-delivery consent (`member.esign_consent_captured`, `member.esign_consent_evidence`) at onboarding and updates them whenever the member changes preferences. Opt-out elections (e.g., privacy opt-out, marketing opt-out) are propagated to all downstream delivery channels within 1 business day of receipt. Required disclosures (e.g., account-opening disclosures, change-in-terms notices) are delivered through the member's elected channel only if valid e-consent exists; otherwise, paper delivery is used. If electronic delivery fails (`member.delivery.failed`), the system automatically reverts to paper delivery and records the failure reason (`member.delivery_failure_reason`). Preference records are write-restricted to Member Services and the member via self-service; Compliance has read access. The content of privacy notices and the information-sharing program are governed by the Privacy Policy and are out of scope here.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Member elects or updates communication preferences (`member.preferences.updated`) | Member ID (`member.id`), elected channel (`member.delivery_channel`), e-consent evidence (`member.esign_consent_evidence`), opt-out scope (`privacy.optout_scope`) | Preferences recorded (`member.preferences.updated`); opt-out propagated to delivery systems (`privacy.optout_propagated`) | Opt-out effective within 1 business day (`privacy.optout_propagation_due_at`) |
| Required disclosure is due for delivery (`disclosure.initiated`) | Member delivery channel (`member.delivery_channel`), e-consent status (`member.esign_consent_captured`), disclosure template (`disclosure.template_id`) | Disclosure delivered via elected channel (`disclosure.account_opening.delivered`) or paper if no valid e-consent | Per disclosure-specific deadline (see Truth-in-Savings Policy for content) |
| Electronic delivery fails (`member.delivery.failed`) | Failure reason (`member.delivery_failure_reason`), member ID (`member.id`), disclosure or notice type | Channel reverted to paper (`member.channel_reverted`); paper delivery initiated | Same business day as failure |
| Member revokes e-consent | Member ID (`member.id`), revocation evidence | E-consent flag cleared; all future required deliveries switched to paper (`member.channel_reverted`) | Effective immediately; propagated within 1 business day |

**ALERTS/METRICS:** Alert if any `disclosure.initiated` event is not followed by a `disclosure.account_opening.delivered` (or equivalent) within the required deadline — target zero overdue. Monitor `member.delivery.failed` count weekly; more than 5 failures per week triggers a channel-reliability review.

---

## MP-04 — Member Disputes and Dispute Resolution {#mp-04-member-disputes-and-dispute-resolution}

**WHY (Reg cite):** [Regulation E (12 CFR Part 1005.11)](https://www.ecfr.gov/current/title-12/section-1005.11) establishes mandatory error-resolution procedures and timelines for electronic fund transfer disputes, including provisional credit and final determination deadlines. The California Consumer Financial Protection Law (CCFPL) requires that DFPI-routed complaints be forwarded to a designated officer and that complaint handling meet UDAAP standards. Complaint intake, logging, and UDAAP monitoring program structure are governed by the Compliance Policy; this control governs the member-facing response process only.

**SYSTEM BEHAVIOR:** All member complaints and disputes are logged in the complaint management system upon receipt, regardless of channel. Complaints received directly from members are acknowledged within 5 business days. Complaints routed from DFPI or CFPB are immediately forwarded to the Chief Compliance Officer (the designated officer) and tracked with a regulator case ID (`complaint.regulator_case_id`). EFT error disputes trigger the Regulation E clock (`dispute.rege_clock`): provisional credit is posted within 10 business days if the investigation cannot be completed sooner; a final determination is issued within 45 calendar days. Non-EFT complaints receive an initial substantive response within 15 calendar days and a final response within 45 calendar days. If a service inquiry is reclassified as a complaint (`service.reclassified_as_dispute`), the complaint clock starts from the date of original receipt. Complaint records are write-restricted to Member Services and Compliance; the CCO has full access including regulator-routed records.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Member complaint received via any channel (`complaint.received`) | Member ID (`complaint.member_id`), complaint narrative (`complaint.narrative`), channel (`complaint.channel`), category (`complaint.category`) | Complaint logged (`complaint.logged`); acknowledgement task created (`complaint.ack_due_at`) | Logged same business day |
| Complaint acknowledged (`complaint.acknowledged`) | Complaint ID, member contact information (`entity.contact`) | Acknowledgement sent to member (`complaint.acknowledged`) | 5 business days from receipt (`complaint.ack_due_at`) |
| Regulator-routed complaint received (`complaint.regulator.received`) | Regulator case ID (`complaint.regulator_case_id`), complaint narrative, regulator identity (`complaint.regulator`) | Complaint forwarded to CCO; regulator case ID recorded; initial response task created (`complaint.initial_response_due_at`) | Same business day as receipt |
| EFT error dispute opened (`dispute.opened`) | Transaction details, member assertion (`dispute.basis`), account ID | Reg E clock started (`dispute.rege_clock.started`); provisional credit task created (`dispute.provisional_credit_due_at`) | Clock starts on date of receipt |
| Provisional credit due for EFT dispute (`dispute.provisional_credit_due_at`) | Investigation status, account balance (`account.balance`) | Provisional credit posted (`dispute.provisional_credit.posted`) | 10 business days from dispute receipt |
| EFT dispute investigation complete (`dispute.investigation.completed`) | Investigation findings (`dispute.findings`), correction amount if applicable (`dispute.correction_amount`) | Final determination sent to member (`dispute.response.sent`); correction applied if error confirmed (`dispute.resolved`) | 45 calendar days from dispute receipt (`dispute.response_due_at`) |
| Non-EFT complaint investigation complete (`complaint.investigation.completed`) | Investigation notes (`complaint.investigation_notes`), root cause (`complaint.root_cause_tag`), UDAAP flag (`complaint.udaap_flag`) | Final response sent to member (`complaint.final_response.sent`); complaint resolved (`complaint.resolved`) | 45 calendar days from receipt (`complaint.final_response_due_at`) |

**ALERTS/METRICS:** Alert if any complaint reaches 80% of its response deadline without a recorded response event — aging alert at 36 calendar days for final response. Alert immediately on any `complaint.udaap_flag` = true for CCO review. Monitor count of complaints exceeding any deadline; target zero. Track `dispute.provisional_credit_due_at` breaches; target zero.

---

## MP-05 — Account Restrictions and Closures {#mp-05-account-restrictions-and-closures}

**WHY (Reg cite):** California Credit Union Law ([Cal. Fin. Code §§ 14750–14752](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=FIN&sectionNum=14750.)) permits a credit union to restrict or close member accounts under defined conditions, subject to the member's contractual rights and applicable law. The CCFPL imposes UDAAP standards on account closure practices. Restrictions and closures do not relieve a member of outstanding liabilities to the Credit Union.

**SYSTEM BEHAVIOR:** An account may be restricted (e.g., denial of specific services, transaction limits) or closed only upon documented grounds (`restriction.grounds`, `account.restriction`) and with approval from the CEO or designee (`restriction.approved_by`). The system records the rationale and approver before any restriction or closure is applied. Upon restriction, a notice is sent to the member on the same business day (`member.restriction_notice.sent`). Upon closure approval, a notice is sent to the member at least 10 calendar days before the closure effective date (internal SLA), except where immediate closure is required by law (e.g., legal process, OFAC). Upon closure, the member's share balance is paid out promptly, net of any amounts owed to the Credit Union (`member.closure_payout`), within 5 business days (`account.closure_payout_due_at`). Abusive conduct by a member (as defined in the Credit Union's Abusive Member Policy) is a permissible ground for restriction; the CEO or designee may impose restrictions immediately and report to the Board at the next scheduled meeting. Account restriction and closure records are write-restricted to the CEO/designee and Compliance; Member Services has read access.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Account restriction proposed | Grounds (`restriction.grounds`), approver ID (`restriction.approved_by`), member ID (`member.id`), account ID (`account.id`) | Restriction approval recorded (`account.restriction.approved`); restriction applied to account (`account.lock.applied`) | Approval before restriction is applied |
| Account restriction applied (`account.lock.applied`) | `account.restriction`, `account.lock_type`, member contact (`entity.contact`) | Restriction notice sent to member (`member.restriction_notice.sent`) | Same business day |
| Account closure proposed | Grounds, approver ID, member ID, account balance (`account.balance`), amounts owed (`member.amounts_owed`) | Closure approval recorded (`account.closure.approved`) | Approval before closure notice |
| Closure notice sent to member (`account.closure.approved`) | Member contact (`entity.contact`), closure effective date | Closure notice sent; closure effective date set | At least 10 calendar days before closure (internal SLA); immediate if required by law |
| Account closed (`account.closed`) | `account.status`, `account.balance`, `member.amounts_owed` | Closure payout initiated (`member.closure_payout.sent`); payout amount = balance net of amounts owed | Payout within 5 business days (`account.closure_payout_due_at`) |

**ALERTS/METRICS:** Alert if `account.closed` is not followed by `member.closure_payout.sent` within 5 business days — target zero breaches. Monitor count of restrictions and closures monthly; report to CCO. Alert if any closure notice-to-effective-date gap is less than 10 calendar days without a documented legal-process exception.

---

## MP-06 — Member Expulsion {#mp-06-member-expulsion}

**WHY (Reg cite):** California Credit Union Law ([Cal. Fin. Code §§ 14850–14854](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=FIN&sectionNum=14850.)) establishes the statutory procedure for expulsion of a credit union member, including permissible grounds, the member's right to notice, and the right to be heard at a special meeting of members. Expulsion does not relieve the member of outstanding liabilities. The Federal Credit Union Act § 118 ([12 U.S.C. § 1764](https://www.law.cornell.edu/uscode/text/12/1764)) provides the analogous federal framework for reference.

**SYSTEM BEHAVIOR:** Permissible grounds for expulsion include: conduct causing the Credit Union a loss; breach of federal or state law or regulation; behavior that threatens, harasses, or abuses an employee or member; or other conduct harmful to the Credit Union (as documented in the expulsion record). Membership terminations resulting from loan charge-offs or bankruptcy are not governed by this control. The CEO (or Board-delegated officer) decides expulsion; the decision is recorded with grounds (`expulsion.grounds`, `expulsion.decided_by`). Upon decision, a written expulsion notice is sent to the member stating the grounds and the member's right to request a hearing at a special meeting within 30 calendar days (`member.expulsion_notice.sent`). If the member requests a hearing (`member.expulsion_hearing.requested`), a special meeting is convened; the Board ratifies or reverses the expulsion at that meeting or at the next annual meeting. The expulsion is reported to the Board and Supervisory Committee at their next normally scheduled meeting (`expulsion.board_report`). Upon expulsion becoming effective, the member's share balance is paid out as funds become available, net of amounts owed (`member.expulsion_payout.sent`). Reinstatement petitions are reviewed by the CEO; any losses must be repaid before reinstatement is considered. Expulsion records are write-restricted to the CEO and Compliance; the Board has read access to the board report.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Expulsion decided by CEO or designee (`member.expulsion.decided`) | Grounds (`expulsion.grounds`), deciding officer (`expulsion.decided_by`), member ID (`member.id`), supporting evidence | Expulsion decision recorded; expulsion notice queued (`member.expulsion_notice`) | Decision recorded before notice is sent |
| Expulsion notice sent to member (`member.expulsion_notice.sent`) | Member contact (`entity.contact`), grounds, hearing-right statement, 30-day deadline | Expulsion notice sent (`member.expulsion_notice.sent`); 30-day hearing-request window opens | Prompt written notice; hearing-request window = 30 calendar days from notice date |
| Member requests hearing (`member.expulsion_hearing.requested`) | Member's written request, `expulsion.hearing_requested_at` | Hearing request recorded; special meeting scheduled (`expulsion.meeting_date`) | Special meeting convened within a reasonable time per bylaws |
| Special meeting held; Board ratifies or reverses (`member.expulsion_hearing.held`) | Board quorum, meeting minutes, decision | Expulsion ratified or reversed; board minutes recorded | At or before next annual meeting if no special meeting requested |
| Expulsion board report filed (`expulsion.board_report.filed`) | Expulsion summary, member ID, grounds, outcome | Board report filed with Board and Supervisory Committee (`expulsion.board_report.filed`) | Next normally scheduled Board and Supervisory Committee meeting |
| Expulsion effective; payout initiated (`member.expulsion_payout.sent`) | `account.balance`, `member.amounts_owed`, share account IDs | Share balance paid to expelled member net of amounts owed (`member.expulsion_payout.sent`) | As funds become available; internal SLA: 30 calendar days (`member.expulsion_payout`) |

**ALERTS/METRICS:** Alert if `member.expulsion_notice.sent` is not recorded within 2 business days of `member.expulsion.decided` — target zero gaps. Alert if `expulsion.board_report.filed` is not recorded before the next Board meeting date following the expulsion decision. Monitor all open hearing requests (`member.expulsion_hearing.requested`) to ensure special meetings are scheduled within bylaw timelines.

---

## MP-07 — Member Death and Estate Handling {#mp-07-member-death-and-estate-handling}

**WHY (Reg cite):** California Probate Code and California Credit Union Law govern the disposition of a deceased member's accounts, including payable-on-death (POD) designations and the rights of estate representatives. [Regulation E (12 CFR Part 1005)](https://www.ecfr.gov/current/title-12/part-1005) continues to apply to EFT transactions on the account until the account is closed or transferred. The Credit Union's obligation to pay out share balances to the estate is subject to deduction of amounts owed.

**SYSTEM BEHAVIOR:** Upon notification of a member's death, the system applies a death flag to all accounts (`account.death_flag.applied`) on the same business day, suspending new discretionary transactions pending estate review. The death certificate and any POD designation on file are retrieved; if a valid POD beneficiary is designated, the system routes the claim to that beneficiary upon receipt of required documentation. If no POD designation exists, the account is held for the estate representative. Claimants must provide a death certificate (`estate.death_certificate_ref`), authority document (letters testamentary or equivalent, `estate.authority_document_ref`), and identity verification (`estate.claimant_verification_id`). Upon verification, the payout is processed net of amounts owed to the Credit Union (`estate.payout_due_at`). Any benefits received post-mortem (e.g., ACH credits) are identified and returned to the originator (`estate.benefit_received_postmortem`). Estate records are write-restricted to Member Services with CCO oversight; legal counsel is consulted for contested claims.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Member death reported (`member.death.reported`) | Member ID (`member.id`), date of death (`estate.date_of_death`), notification source | Death flag applied to all member accounts (`account.death_flag.applied`); estate record created | Same business day |
| Post-mortem benefit (e.g., ACH credit) received on flagged account | `account.death_flag`, transaction details, originator (`estate.benefit_received_postmortem`) | Benefit identified; return initiated to originator | Per Reg E and ACH rules (typically within 5 business days) |
| Estate claim submitted by claimant (`estate.claim.submitted`) | Death certificate (`estate.death_certificate_ref`), authority document (`estate.authority_document_ref`), claimant identity verification (`estate.claimant_verification_id`), POD designation if applicable | Claim documented (`estate.claim_documented`); claimant verification initiated (`verification.created`) | Claim accepted for processing upon receipt of complete documentation |
| Claimant verification complete (`verification.completed`) | `verification.status`, `estate.claimant_verification_id`, account balance (`account.balance`), amounts owed (`member.amounts_owed`) | Payout authorized; payout sent to verified claimant (`estate.payout.sent`) | Internal SLA: 30 calendar days from complete documentation (`estate.payout_due_at`) |

**ALERTS/METRICS:** Alert if `account.death_flag.applied` is not recorded within 1 business day of `member.death.reported` — target zero gaps. Alert if `estate.payout.sent` is not recorded within 30 calendar days of `estate.claim.submitted` with complete documentation (`estate.payout_due_at`). Monitor all open estate claims weekly.

---

## MP-08 — Member Records and Privacy {#mp-08-member-records-and-privacy}

**WHY (Reg cite):** [Regulation P (12 CFR Part 1016)](https://www.ecfr.gov/current/title-12/part-1016) (Gramm-Leach-Bliley) requires financial institutions to protect the privacy of nonpublic personal information and to limit access to those with a need to know. California Consumer Financial Protection Law and the California Consumer Privacy Act impose additional access and data-minimization obligations. Record retention schedules are governed by the Record Retention Policy; this control governs access controls and the integrity of member records within their retention period.

**SYSTEM BEHAVIOR:** Member records (identity, account, transaction, communication, and dispute records) are classified as sensitive and subject to need-to-know access controls. Access is provisioned by role: Member Services staff may access records for members they are actively serving; Compliance and the CCO have broad read access for oversight; BSA has access to records required for CIP and suspicious-activity review; no staff member has write access to audit log entries. All access to member records is logged (`record.access.logged`) with actor ID (`record.actor_id`), actor role (`record.actor_role`), and access purpose (`record.access_purpose`). Bulk exports require CCO approval (`record.export_approved_by`). The content of privacy notices, information-sharing elections, and opt-out propagation are governed by the Privacy Policy. Retention periods and destruction schedules are governed by the Record Retention Policy; this control does not set those schedules but enforces that records are not destroyed while under legal hold (`record.legal_hold_flag`).

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Staff member accesses a member record | Actor ID (`record.actor_id`), actor role (`record.actor_role`), access purpose (`record.access_purpose`), member record ID (`record.id`) | Access logged (`record.access.logged`) | Real time — every access |
| Bulk export of member records requested (`record.bulk_export.requested`) | Requestor ID, export justification (`record.export_justification`), CCO approval (`record.export_approved_by`) | Export approved or denied; if approved, export completed and logged (`record.bulk_export.completed`) | CCO approval required before export executes |
| Legal hold placed on member records (`record.hold.placed`) | Matter ID (`record.hold_matter_id`), hold scope (`record.hold_scope`), authorizer (`record.hold_authorizer`) | Legal hold flag set (`record.legal_hold_flag`); destruction suspended for affected records | Immediate upon hold order |
| Legal hold released (`record.hold.released`) | Hold release authorization (`record.hold_release_auth`), matter closure confirmation | Legal hold flag cleared; retention clock resumed | Upon confirmed matter closure |

**ALERTS/METRICS:** Alert on any bulk export (`record.bulk_export.requested`) that lacks a recorded CCO approval before execution — target zero unauthorized exports. Monitor access log anomalies (e.g., access outside normal hours, access to records of members not in the actor's active queue) weekly via the SIEM; route anomalies to Information Security per the Information Security Policy.

---

## MP-09 — Member Service Standards {#mp-09-member-service-standards}

**WHY (Reg cite):** The California Consumer Financial Protection Law imposes UDAAP standards on member-facing interactions, including service responsiveness. Failure to respond to member inquiries in a timely manner may constitute an unfair or deceptive practice. Online and mobile channel-specific standards are governed by the E-Commerce Policy.

**SYSTEM BEHAVIOR:** All member service inquiries received through any in-scope channel (branch, telephone, mail, secure message) are logged as service records upon receipt (`service.inquiry.received`) with category (`service.category`) and assigned staff (`service.assigned_to`). A first response (acknowledgement or resolution) is due within 1 business day (`service.first_response_due_at`). Full resolution is due within 5 business days (`service.resolution_due_at`). If an inquiry cannot be resolved within 5 business days, it is escalated to a supervisor and a status update is sent to the member. If the inquiry reveals a potential regulatory violation or UDAAP concern, it is reclassified as a complaint (`service.reclassified_as_dispute`) and the complaint process under [MP-04](#mp-04-member-disputes-and-dispute-resolution) governs from the original receipt date. Service records are write-restricted to Member Services; Compliance has read access for monitoring.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Member inquiry received via any in-scope channel (`service.inquiry.received`) | Inquiry description, channel (`service.category`), member ID (`member.id`), assigned staff (`service.assigned_to`) | Service record created; first-response task set (`service.first_response_due_at`) | Logged same business day |
| First response sent to member (`service.first_response.sent`) | Inquiry ID (`service.inquiry_id`), response content | First response logged (`service.first_response.sent`) | 1 business day from receipt (`service.first_response_due_at`) |
| Inquiry resolved (`service.resolved`) | Resolution summary, inquiry ID | Resolution recorded (`service.resolved`) | 5 business days from receipt (`service.resolution_due_at`) |
| Inquiry not resolved within 5 business days | Inquiry ID, escalation reason | Status update sent to member (`service.status_update.sent`); escalation to supervisor | At 5-business-day mark |
| Inquiry reclassified as complaint (`service.reclassified_as_dispute`) | Regulatory concern or UDAAP flag, original receipt date | Complaint record created with original receipt date; complaint process initiated per [MP-04](#mp-04-member-disputes-and-dispute-resolution) | Immediately upon reclassification |

**ALERTS/METRICS:** Alert if any service inquiry has no `service.first_response.sent` within 1 business day — target zero breaches. Monitor aging of open service records daily; any inquiry open beyond 5 business days without a `service.resolved` or escalation event triggers a supervisor alert. Track monthly volume of `service.reclassified_as_dispute` events; increases may indicate systemic service issues requiring Compliance review.

---

## Governance & Sign-Off {#governance}

| Role | Responsibility |
|---|---|
| **Patrick Wilson, Chief Compliance Officer** | Policy owner; approves all controls; receives all escalations; designated officer for DFPI/CFPB-routed complaints |
| **Member Services** | Operational execution of MP-01, MP-02, MP-03, MP-04, MP-05, MP-07, MP-09; first-line access to member records |
| **BSA Officer** | CIP hand-off at onboarding (MP-01); access to member records for BSA purposes (MP-08) |
| **CEO / Designee** | Expulsion decisions (MP-06); account restriction and closure approvals (MP-05) |
| **Board of Directors** | Ratification of expulsions at special or annual meetings (MP-06); receipt of expulsion board reports |
| **Supervisory Committee** | Receipt of expulsion board reports (MP-06) |

**Review cadence:** This policy is reviewed annually by the CCO, or sooner upon material regulatory change, examination finding, or significant operational event. The next scheduled review is 2027-07-01.

**Cross-references:**
- BSA Policy (CIP/identity-verification program)
- Information Security Policy (Red Flags technical controls)
- Privacy Policy (member privacy notices and information-sharing program)
- Record Retention Policy (retention schedules and destruction)
- Compliance Policy (complaint-logging program structure and UDAAP monitoring)
- E-Commerce Policy (online and mobile channel controls)
- Truth-in-Savings Policy (account disclosure content)

---

## Assumptions & Gaps {#assumptions}

- **Engineering vocabulary is provisional.** Several field and event codes referenced in the control overlays above are composed from the registered vocabulary grammar but are not yet confirmed as registered in `core-vocabulary.json`. Specifically: `member.eligibility_determined`, `member.eligibility_denied`, `member.eligibility_basis`, `member.eligibility_rule` (field), `member.identity_check_method`, `member.address_change_disputed`, `member.channel_reverted`, `member.delivery_failure_reason`, `member.expelled`, `member.expulsion_payout` (timer), `expulsion.decided_by`, `expulsion.grounds`, `expulsion.hearing_requested_at`, `expulsion.meeting_date`, `expulsion.board_report`, `restriction.grounds`, `restriction.approved_by`, `card.request_during_address_hold`, `card.reissue_request`. These names follow the composition grammar and are the target naming scheme; engineering must confirm or adjust before the next review. All other codes cited are registered in the vocabulary dump provided.

- **California Credit Union Law charter confirmation.** This policy assumes Pynthia Credit Union is a California state-chartered credit union subject to Cal. Fin. Code Division 5. If the Credit Union is federally chartered, the expulsion procedure (MP-06) must be re-anchored to 12 U.S.C. § 1764 and NCUA Bylaws Article VIII, and NCUA Part 701.31 may apply to additional controls. This must be confirmed before the policy is finalized.

- **HMDA reporter status.** HMDA/Reg C (12 CFR Part 1003) is not cited in this policy because membership eligibility and onboarding are not loan origination events. If Pynthia originates covered mortgage loans, HMDA obligations are governed by the Fair Lending Policy, not this policy.

- **Expulsion hearing timeline.** Cal. Fin. Code § 14852 requires that the member be given an opportunity to be heard at a special meeting, but does not specify a fixed number of days within which the special meeting must be convened. The policy states "within a reasonable time per bylaws." Compliance should confirm the specific bylaw provision and update the Timing Matrix accordingly.

- **Complaint response timelines.** The 5-business-day acknowledgement, 15-calendar-day initial response, and 45-calendar-day final response timelines are derived from CCFPL examination guidance and CFPB complaint-handling expectations. They are not expressly codified in a single California statute. Compliance should confirm these timelines against current DFPI examination standards and update if guidance changes.

- **Abusive member conduct and immediate expulsion.** The Reference Policy permits the CEO to immediately remove a member for extreme abusive behavior and have the action ratified at the next annual or special meeting. This control (MP-06) incorporates that authority. The specific definition of "abusive conduct" and the list of permissible sanctions short of expulsion (MP-05) are maintained in the Credit Union's Abusive Member Policy, which is a companion document to this policy.

- **POD beneficiary claim process.** MP-07 references POD designations but does not specify the exact documentation checklist for POD versus estate-representative claims. Member Services should maintain a documented checklist (referenced from MP-07 but maintained separately) specifying required documents for each claim type. The assumption here is that a death certificate plus authority document (letters testamentary or equivalent) is the minimum for estate-representative claims, and a death certificate plus beneficiary identity verification is the minimum for POD claims.

- **Service channel scope.** MP-09 covers branch, telephone, mail, and secure message channels. Online and mobile channel service interactions are governed by the E-Commerce Policy. If the boundary between channels is ambiguous for a given interaction type, Compliance and the E-Commerce team should resolve the classification before the next review.
