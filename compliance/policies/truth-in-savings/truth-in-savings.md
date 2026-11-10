```yaml
---
title: Truth in Savings Policy (Table-First, Design-Overlay v3)
owner: Patrick Wilson, Chief Compliance Officer
version: v1.0
effective: 2025-07-01
next_review: 2026-07-01
approvers:
  - Patrick Wilson, Chief Compliance Officer
tags: [Compliance, Truth in Savings, Regulation DD, Deposit Accounts, Overdraft, Advertising]
---
```

## General Policy Statement

Pynthia Credit Union complies with the Truth in Savings Act (TISA) and its implementing Regulation DD (12 CFR Part 1030) by ensuring that every consumer deposit account disclosure is accurate, clear, conspicuous, and delivered in a form the consumer can keep before an account is opened or a service is provided. This policy governs the content and timing of account-opening disclosures, change-in-terms notices, maturity notices, periodic-statement disclosures, interest-calculation methods, deposit advertising, and overdraft-service disclosures across all delivery channels (paper, electronic with E-SIGN consent, and in-person). It also establishes recordkeeping obligations and a training and monitoring program. Governance is centralized with the Chief Compliance Officer; deposit operations, marketing, and front-line staff are required participants. California Financial Code §851 et seq. imposes parallel state-level disclosure obligations that are satisfied by compliance with this policy. DFPI examination of deposit disclosures for deceptive practices is addressed through the UDAAP posture maintained in the Compliance Policy.

---

## Timing Matrix {#timing-matrix}

| Scenario | Trigger (human → event) | Deadline | Content Reference | Control |
|---|---|---:|---|---|
| Account opened in person or online | Consumer requests account (`account.created`) | Before account opened | APY, rate, compounding, fees, minimums, transaction limits | [TIS-02](#tis-02-pre-opening-account-disclosures) |
| Account opened — consumer not present | Account created remotely (`account.created`) | 10 business days after opening | Same as above | [TIS-02](#tis-02-pre-opening-account-disclosures) |
| Adverse change to account terms | Change approved (`disclosure.change_in_terms.approved`) | 30 calendar days before effective date | Changed term(s) + effective date | [TIS-03](#tis-03-change-in-terms-notices) |
| CD/share certificate maturing — term ≤ 1 year | Maturity window opens (`account.maturity_window.opened`) | ≥ 30 calendar days before maturity | Maturity date, renewal terms or disposition | [TIS-04](#tis-04-maturity-notices) |
| CD/share certificate maturing — term > 1 year | Maturity window opens (`account.maturity_window.opened`) | ≥ 30 calendar days before maturity | Maturity date, renewal terms or disposition | [TIS-04](#tis-04-maturity-notices) |
| Long-term non-renewing account matures | Maturity window opens (`account.maturity_window.opened`) | ≥ 30 calendar days before maturity | Maturity date, disposition | [TIS-04](#tis-04-maturity-notices) |
| Periodic statement issued | Statement cycle closes (`statement.cycle.closed`) | With each statement | APY earned, interest paid, fees, days in period | [TIS-05](#tis-05-periodic-statement-disclosures) |
| Interest accrual run | Daily batch (`interest.accrual_run.completed`) | Daily | Full principal balance, permitted method | [TIS-06](#tis-06-interest-calculation) |
| Deposit advertisement created | Ad drafted (`ad.preflight.submitted`) | Before publication | Required rate/bonus disclosures; "free" rule compliance | [TIS-07](#tis-07-advertising-review) |
| Overdraft fee posted to account | Fee posted (`fee.overdraft.posted`) | On each periodic statement | Aggregate OD fees current period + YTD; returned-item fees | [TIS-08](#tis-08-overdraft-service-disclosures) |
| Disclosure error detected | Error detected (`disclosure.error.detected`) | Escalate within 2 business days; remediate per CCO direction | Root cause, affected accounts, correction plan | [TIS-10](#tis-10-training-and-monitoring) |
| Annual training cycle | Cycle opens (`training.annual_cycle.opened`) | Within 30 days of cycle open | Reg DD content, disclosure procedures, escalation path | [TIS-10](#tis-10-training-and-monitoring) |

---

## TIS-01 — Disclosure Standards {#tis-01-disclosure-standards}

**WHY (Reg cite):** [12 CFR §1030.3](https://www.ecfr.gov/current/title-12/section-1030.3) requires that all account disclosures be made clearly and conspicuously in writing (or electronic form with E-SIGN consent), in a form the consumer can keep, and that they accurately reflect the deposit contract. California Financial Code §851 et seq. imposes parallel state-level requirements for state-chartered institutions.

**SYSTEM BEHAVIOR:** The system maintains a versioned disclosure template library keyed to product type and delivery channel. Every template must be approved by the Chief Compliance Officer before activation; templates are write-restricted to Compliance. When a template is published, the system records the approval, effective date, and version identifier. Electronic delivery is permitted only when `entity.esign_consent` is confirmed present and valid for the member; if E-SIGN consent is absent or revoked, the system falls back to paper delivery. Templates that have been superseded are archived (not deleted) to support the two-year retention obligation in [TIS-09](#tis-09-recordkeeping). A disclosure that references a rate or yield must pull the current value from the live product configuration (`product.apy`, `product.interest_rate`) at the moment of generation, not from a cached snapshot, to prevent stale-rate errors.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Compliance approves a new or revised disclosure template (`disclosure.template.published`) | Template content (`disclosure.template_id`), product scope (`template.product_scope`), approval record (`advertising.approval_id`), channel (`advertising.medium`) | Approved template activated in library; prior version archived (`disclosure.template.published`) | Before any account opening or service delivery using the new template |
| Member's E-SIGN consent status is checked at disclosure delivery (`privacy.esign_consent.recorded`) | Member identity (`member.id`), E-SIGN consent flag (`entity.esign_consent`), delivery channel (`member.delivery_channel`) | Delivery channel confirmed or fallback to paper logged (`disclosure.account_opening.delivered`) | At point of disclosure generation |
| Disclosure generated with rate/yield fields | Current APY (`product.apy`), current interest rate (`product.interest_rate`), product contract version (`product.contract_version`) | Disclosure artifact with live rate values stamped (`disclosure.recorded`) | Synchronously at generation |

**ALERTS/METRICS:** Alert if any active disclosure template references a product APY or interest rate that differs from the live `product.apy` or `product.interest_rate` by more than zero (stale-rate mismatch count = 0 target). Alert if a template has been in draft status for more than 5 business days without CCO approval.

---

## TIS-02 — Pre-Opening Account Disclosures {#tis-02-pre-opening-account-disclosures}

**WHY (Reg cite):** [12 CFR §1030.4](https://www.ecfr.gov/current/title-12/section-1030.4) requires that a depository institution provide account disclosures before an account is opened or a service is provided. If the consumer is not present at the institution when the account is opened, the institution must mail or deliver the disclosures within 10 business days.

**SYSTEM BEHAVIOR:** When an account is created, the system evaluates whether the consumer was present (keyed to `account.opening_channel`). For in-person and synchronous online openings, the disclosure must be delivered and acknowledged before the account transitions to `open` status; the account-opening flow blocks progression until `disclosure.account_opening.delivered` is recorded. For remote openings where the consumer is not present at the time of account creation, the system creates a delivery task with a 10-business-day deadline (`disclosure.account_opening_due_at`). Required disclosure content includes: APY (`product.apy`), interest rate (`product.interest_rate`), compounding and crediting frequency (`product.interest_config`), minimum-balance requirements, fees (`fee.overdraft` and any applicable service fees), and transaction limitations (`account.restriction`). Disclosure delivery is write-restricted to Deposit Operations and Compliance; members cannot self-serve the disclosure record.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Account created — consumer present (`account.created`) | Account type (`account.account_type`), opening channel (`account.opening_channel`), member ID (`member.id`), E-SIGN consent (`entity.esign_consent`), APY (`product.apy`), rate (`product.interest_rate`), interest config (`product.interest_config`), fees, restrictions (`account.restriction`), template ID (`disclosure.template_id`) | Disclosure delivered and acknowledged; account unblocked (`disclosure.account_opening.delivered`) | Before account opens (synchronous gate) |
| Account created — consumer not present (`account.created`) | Same fields as above; delivery address (`address.line1`, `address.city`, `address.region`, `address.postal_code`) | Delivery task created; disclosure mailed or delivered electronically (`disclosure.account_opening.delivered`); timer set (`disclosure.account_opening_due_at`) | Within 10 business days of account creation (enforced by `disclosure.account_opening_due_at`) |
| Disclosure delivery fails (mail returned, e-delivery bounced) (`member.delivery.failed`) | Member ID (`member.id`), delivery failure reason (`member.delivery_failure_reason`), account ID (`account.id`) | Failure logged; escalation task created for Compliance review (`disclosure.error.detected`) | Same business day as failure detected |

**ALERTS/METRICS:** Alert if any account in `open` status has no corresponding `disclosure.account_opening.delivered` event (count = 0 target). Alert if any remote-opening delivery task is within 2 business days of the 10-business-day deadline without a confirmed delivery record.

---

## TIS-03 — Change-in-Terms Notices {#tis-03-change-in-terms-notices}

**WHY (Reg cite):** [12 CFR §1030.5](https://www.ecfr.gov/current/title-12/section-1030.5) requires that a depository institution mail or deliver advance notice at least 30 calendar days before the effective date of any change that may reduce the APY or otherwise adversely affect the consumer, and that the notice include the effective date of the change.

**SYSTEM BEHAVIOR:** When a product term change is proposed that would reduce APY, increase fees, add restrictions, or otherwise adversely affect consumers, Compliance classifies the change as adverse or non-adverse using `disclosure.classification_basis`. Only adverse changes trigger the 30-day advance notice requirement; non-adverse changes are logged with the classification rationale (`disclosure.change_in_terms.classified_nonadverse`) and do not require advance notice. The system calculates the required send date as the effective date minus 30 calendar days and creates a delivery task (`disclosure.change_in_terms_due_at`). The notice must state the changed term(s) and the effective date (`disclosure.change_effective_date`). Classification decisions are write-restricted to Compliance; Deposit Operations executes delivery.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Product term change proposed and classified as adverse (`disclosure.change_in_terms.approved`) | Changed term description (`disclosure.change_description`), effective date (`disclosure.change_effective_date`), classification basis (`disclosure.classification_basis`), affected account types, template ID (`disclosure.template_id`) | Change-in-terms notice queued for delivery; timer set (`disclosure.change_in_terms_due_at`) | Notice must be sent ≥ 30 calendar days before effective date (enforced by `disclosure.change_in_terms_due_at`) |
| Change classified as non-adverse (`disclosure.classification.logged`) | Classification basis (`disclosure.classification_basis`), change description (`disclosure.change_description`) | Non-adverse classification logged; no notice required (`disclosure.classification.logged`) | At time of classification |
| Change-in-terms notice delivered (`disclosure.change_in_terms.sent`) | Member IDs of affected accounts, delivery channel (`member.delivery_channel`), notice content, effective date (`disclosure.change_effective_date`) | Delivery confirmed and logged (`disclosure.change_in_terms.sent`) | ≥ 30 calendar days before effective date |

**ALERTS/METRICS:** Alert if any pending change-in-terms notice has not been sent and the effective date is fewer than 35 calendar days away (5-day internal buffer). Target zero instances of a change-in-terms effective date passing without a confirmed prior delivery record.

---

## TIS-04 — Maturity Notices {#tis-04-maturity-notices}

**WHY (Reg cite):** [12 CFR §1030.5(b)](https://www.ecfr.gov/current/title-12/section-1030.5#p-1030.5(b)) requires depository institutions to send maturity notices before the maturity of automatically renewable accounts (e.g., certificates of deposit/share certificates) and similar notices for long-term non-renewing accounts, with timing keyed to the account term.

**SYSTEM BEHAVIOR:** The system monitors `account.maturity_date` for all certificate and time-deposit accounts. When the maturity window opens (30 calendar days before maturity for all terms, per Reg DD §1030.5(b)), the system emits `account.maturity_window.opened` and creates a notice delivery task (`account.maturity_notice_due_at`). The notice must state the maturity date, the renewal terms (for auto-renewing accounts), or the disposition of funds (for non-renewing accounts), and any grace period (`account.maturity_window`). For accounts with a term of more than one year that do not automatically renew, the same 30-day advance notice applies. The `account.maturity_disposition` field records whether the account will roll over, pay out, or require member instruction. Maturity notice delivery is write-restricted to Deposit Operations; Compliance reviews the notice template annually.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Maturity window opens 30 days before maturity date (`account.maturity_window.opened`) | Account ID (`account.id`), maturity date (`account.maturity_date`), account type (`account.account_type`), maturity disposition (`account.maturity_disposition`), maturity window/grace period (`account.maturity_window`), renewal terms (if auto-renewing), member delivery channel (`member.delivery_channel`), template ID (`disclosure.template_id`) | Maturity notice delivery task created; timer set (`account.maturity_notice_due_at`) | Task created at window open; notice must be delivered ≥ 30 calendar days before maturity (enforced by `account.maturity_notice_due_at`) |
| Maturity notice delivered (`disclosure.maturity_notice.sent`) | Member ID (`member.id`), account ID (`account.id`), notice content, maturity date (`account.maturity_date`), delivery confirmation | Delivery confirmed and logged (`disclosure.maturity_notice.sent`) | ≥ 30 calendar days before maturity date |
| Member fails to respond before maturity (auto-renewal accounts) | Account ID (`account.id`), maturity disposition (`account.maturity_disposition`), renewal terms | Account rolled over per disclosed terms; renewal logged (`account.maturity_window.opened`) | At maturity date per account terms |

**ALERTS/METRICS:** Alert if any certificate account has a maturity date within 35 calendar days and no confirmed `disclosure.maturity_notice.sent` event (5-day internal buffer). Target zero maturity dates passed without a prior notice delivery record.

---

## TIS-05 — Periodic Statement Disclosures {#tis-05-periodic-statement-disclosures}

**WHY (Reg cite):** [12 CFR §1030.6](https://www.ecfr.gov/current/title-12/section-1030.6) specifies the information a depository institution must include on periodic statements if it provides them, including the APY earned, amount of interest earned, fees imposed, and the number of days in the statement period.

**SYSTEM BEHAVIOR:** When a statement cycle closes, the system assembles the required Reg DD fields from the account ledger and interest accrual records before the statement is rendered. Required fields are: APY earned during the period (computed from `interest.accrued` and `account.balance`), interest dollar amount credited (`interest.credited`), all fees charged during the period (including overdraft and returned-item fees per [TIS-08](#tis-08-overdraft-service-disclosures)), and the number of days in the statement period (`statement.days_in_period`). The statement generation process is blocked from rendering if any required field is null. Statements are write-restricted to Deposit Operations; Compliance reviews the statement template annually and after any product change.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Statement cycle closes (`statement.cycle.closed`) | Account ID (`account.id`), statement cycle (`statement.cycle`), days in period (`statement.days_in_period`), interest accrued (`interest.accrued`), interest credited (`interest.credited`), APY earned (computed), fees charged during period (`fee.ytd_total`), overdraft fee totals (per TIS-08) | Statement rendered with all required Reg DD fields; statement issued (`statement.issued`) | With each periodic statement; no regulatory deadline on frequency, but must include required content whenever a statement is provided |
| Required field missing at statement generation | Account ID (`account.id`), missing field identifier, statement cycle (`statement.cycle`) | Statement generation blocked; error escalated to Deposit Operations and Compliance (`disclosure.error.detected`) | Immediately at generation attempt |

**ALERTS/METRICS:** Alert if any issued statement is missing one or more required Reg DD fields (APY earned, interest amount, fees, days in period) — target count = 0. Alert if statement generation is blocked for more than 1 business day due to a missing required field.

---

## TIS-06 — Interest Calculation {#tis-06-interest-calculation}

**WHY (Reg cite):** [12 CFR §1030.7](https://www.ecfr.gov/current/title-12/section-1030.7) requires that interest be paid on the full principal balance each day using either the daily balance method or the average daily balance method, and that the APY and APYE formulas be documented. Interest must begin to accrue no later than the business day the institution receives credit for deposited funds.

**SYSTEM BEHAVIOR:** The system runs a nightly interest accrual batch that applies the configured balance method (`product.balance_method`) — either daily balance or average daily balance — to the full principal balance (`account.balance`) for each interest-bearing account. The accrual engine reads the interest configuration (`product.interest_config`) to determine the rate, compounding frequency, and crediting schedule. Interest begins to accrue on the business day the institution receives credit for deposited funds; the accrual engine enforces this by using the settlement date of inbound credits, not the posting date. The APY and APYE formulas are documented in `product.interest_config` and are version-controlled; changes require CCO approval before activation. The accrual run result is logged as `interest.accrual_run.completed`; any run that fails or produces a zero-interest result for an account with a positive balance triggers an alert. Interest calculation configuration is write-restricted to Deposit Operations with CCO approval for any formula change.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Nightly accrual batch runs (`interest.accrual_run.completed`) | Account ID (`account.id`), account balance (`account.balance`), balance method (`product.balance_method`), interest rate (`product.interest_rate`), interest config (`product.interest_config`), settlement date of last credit | Accrual amount posted to `interest.accrued_balance`; run logged (`interest.accrual_run.completed`) | Daily; must accrue from business day institution receives credit for funds |
| Interest credited to account per crediting schedule (`interest.credited`) | Account ID (`account.id`), accrued balance (`interest.accrued_balance`), crediting frequency from `product.interest_config`, crediting due date (`interest.crediting_due_at`) | Interest posted to account balance; crediting event logged (`interest.accrual_run.completed`) | Per crediting schedule in `product.interest_config` (enforced by `interest.crediting_due_at`) |
| Interest configuration changed (`product.interest_config.updated`) | Prior config version, new config version, APY formula, APYE formula, balance method (`product.balance_method`), CCO approval record | New config version activated; prior version archived; change logged (`product.interest_config.updated`) | Before any accrual run using the new configuration |

**ALERTS/METRICS:** Alert if any interest-bearing account with a positive balance records zero accrual for two or more consecutive business days. Alert if the accrual batch does not complete by 06:00 local time on the following business day. Target zero instances of interest beginning to accrue later than the business day the institution receives credit for deposited funds.

---

## TIS-07 — Advertising Review {#tis-07-advertising-review}

**WHY (Reg cite):** [12 CFR §1030.8](https://www.ecfr.gov/current/title-12/section-1030.8) prohibits deposit advertisements that are inaccurate or misleading, restricts use of "free" or "no cost" unless the account is genuinely free of all fees, and requires disclosure of additional terms (minimum balance, time requirements, penalties) whenever a rate or bonus is advertised.

**SYSTEM BEHAVIOR:** All deposit advertising — including print, broadcast, digital, online, and social media — must be submitted for pre-publication compliance review before release. The advertising workflow requires the submitter to attach the creative (`advertising.asset_id`), identify the medium (`advertising.medium`), and flag whether the ad references a rate, APY, or bonus. Compliance reviews the submission against the §1030.8 checklist: accuracy of stated rate/APY (cross-checked against `product.apy`), "free" account claim validity (verified against the fee schedule), and presence of required additional terms when a rate or bonus is advertised. The CCO or designated Compliance reviewer must record an approval (`advertising.approval_id`) before the ad may be published. Social media posts are subject to the same pre-publication review; the `socialmedia.post.approved` event is required before any deposit-related social post is published. Advertising approval is write-restricted to Compliance; Marketing may submit but not self-approve. Ads that reference a rate must pull the current APY from `product.apy` at the time of review; if the rate changes after approval but before publication, re-review is required.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Deposit advertisement submitted for review (`advertising.review.requested`) | Ad creative (`advertising.asset_id`), medium (`advertising.medium`), rate/APY referenced (`product.apy`, `product.interest_rate` if applicable), bonus terms if applicable, "free" claim flag, submitter ID | Review task created; submission logged (`advertising.review.requested`) | Before publication |
| Compliance completes advertising review (`advertising.review.completed`) | Submission record, checklist results (accuracy, "free" rule, required additional terms), approval or rejection decision, reviewer ID (`advertising.approval_id`) | Approval or rejection recorded; if approved, ad cleared for publication (`advertising.review.completed`); if rejected, submitter notified with required changes | Before publication; internal SLA: within 3 business days of submission |
| Approved advertisement published (`advertising.published`) | Approval ID (`advertising.approval_id`), publication date, medium (`advertising.medium`), asset ID (`advertising.asset_id`) | Publication logged (`advertising.publication.logged`) | At publication |
| Rate changes after ad approval but before publication | New APY (`product.apy`), prior approved APY, ad asset ID (`advertising.asset_id`) | Ad flagged for re-review; publication blocked until re-approval (`advertising.review.requested`) | Immediately upon rate change detection |

**ALERTS/METRICS:** Alert if any deposit advertisement is published without a corresponding `advertising.review.completed` approval record (count = 0 target). Alert if any open advertising review request has been pending for more than 3 business days without a decision.

---

## TIS-08 — Overdraft Service Disclosures {#tis-08-overdraft-service-disclosures}

**WHY (Reg cite):** [12 CFR §1030.11](https://www.ecfr.gov/current/title-12/section-1030.11) requires disclosure of aggregate overdraft and returned-item fees on periodic statements (total for the statement period and year-to-date), advertising disclosures for overdraft services, and accurate balance disclosures through automated systems. Regulation E [12 CFR §1005.17](https://www.ecfr.gov/current/title-12/section-1005.17) requires affirmative opt-in before ATM and one-time debit-card overdraft fees may be assessed; this policy governs the disclosure side of that intersection — the opt-in process itself is governed by the Electronic Payment Systems Policy.

**SYSTEM BEHAVIOR:** The system tracks overdraft fees and returned-item fees at the account level using `fee.overdraft` and `fee.ytd_total`. At each statement cycle close, the statement assembly process pulls the current-period overdraft fee total and the year-to-date total and includes both on the statement (see [TIS-05](#tis-05-periodic-statement-disclosures)). Automated balance inquiry responses (e.g., ATM, IVR, online banking) must reflect the actual available balance and must not include funds available through an overdraft line or courtesy pay program unless the member has affirmatively opted in under Reg E §1005.17 and the balance disclosure is clearly labeled. The `balance.disclosed` field records what balance was presented to the member at each inquiry. Overdraft advertising must comply with §1030.8 (see [TIS-07](#tis-07-advertising-review)) and must not misrepresent the cost or availability of overdraft coverage. Overdraft fee configuration is write-restricted to Deposit Operations with CCO approval.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Overdraft fee posted to account (`fee.overdraft.posted`) | Account ID (`account.id`), fee amount (`fee.overdraft`), fee type, Reg E opt-in status (`entity.reg_e_opt_in`) for ATM/one-time debit transactions | Fee recorded; YTD total updated (`fee.ytd_total`); fee logged (`overdraft.fee.logged`) | At time of fee assessment; ATM/one-time debit fee requires confirmed `entity.reg_e_opt_in` = true |
| Statement cycle closes — overdraft fee aggregation (`statement.cycle.closed`) | Account ID (`account.id`), current-period OD fees, current-period returned-item fees, YTD OD fees (`fee.ytd_total`), statement cycle (`statement.cycle`) | Aggregate fee totals included in statement; statement issued (`statement.issued`) | With each periodic statement |
| Automated balance inquiry received (`balance.inquiry.received`) | Account ID (`account.id`), inquiry channel, Reg E opt-in status (`entity.reg_e_opt_in`), available balance (`account.balance`), overdraft availability flag | Balance disclosed to member (`balance.disclosed`); inquiry logged (`balance.inquiry.received`) | At time of inquiry; overdraft funds excluded from disclosed balance unless opt-in confirmed |

**ALERTS/METRICS:** Alert if any statement is issued for an account with overdraft fee activity during the period but the statement contains no overdraft fee disclosure line (count = 0 target). Alert if any ATM or one-time debit overdraft fee is assessed on an account where `entity.reg_e_opt_in` is not confirmed true — this is a Reg E violation and must be escalated to the CCO within 1 business day.

---

## TIS-09 — Recordkeeping {#tis-09-recordkeeping}

**WHY (Reg cite):** [12 CFR §1030.9](https://www.ecfr.gov/current/title-12/section-1030.9) requires depository institutions to retain evidence of compliance with Regulation DD for at least two years after the date a disclosure is required to be made or an action is required to be taken.

**SYSTEM BEHAVIOR:** All disclosure artifacts, delivery confirmations, advertising approval records, change-in-terms notices, maturity notices, and interest-calculation configuration records are retained as `record` objects with `record.retention_class` = `reg_dd` and `record.retention_expires_at` set to two years from the date the disclosure was required or the action was taken. The retention clock is set at the time the triggering event occurs (e.g., account opening date, effective date of a change, statement date), not at the date of actual delivery. Records subject to a legal hold (`record.legal_hold_flag`) are exempt from disposal until the hold is released. The Record Retention Policy governs the retention schedule and disposal procedures; this policy cross-references it for the two-year Reg DD minimum. Recordkeeping configuration is write-restricted to Compliance and Records Management.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Disclosure delivered or action taken (any TIS control) | Disclosure artifact or action record, triggering event date, account ID (`account.id`), disclosure type | Retention clock set; `record.retention_expires_at` = triggering date + 2 years; retention record created (`record.retention_clock_set`) | At time of disclosure delivery or required action |
| Retention period expires (`record.retention.expired`) | Record ID (`record.id`), retention class (`record.retention_class`), retention expiry (`record.retention_expires_at`), legal hold status (`record.legal_hold_flag`) | Record flagged for disposal if no legal hold; disposal task created (`record.disposed`) | At expiry date; disposal blocked if `record.legal_hold_flag` is set |
| Legal hold placed on Reg DD records (`record.hold.placed`) | Record IDs in scope, matter ID (`record.matter_id`), hold authorizer (`record.hold_authorizer`) | Legal hold applied; retention clock suspended (`record.hold.applied`) | Immediately upon hold order |

**ALERTS/METRICS:** Alert if any Reg DD disclosure record reaches its `record.retention_expires_at` date without a disposal decision (disposed or hold extended) — target zero aged-out records without disposition. Alert if any disclosure delivery event has no corresponding retention record within 1 business day.

---

## TIS-10 — Training and Monitoring {#tis-10-training-and-monitoring}

**WHY (Reg cite):** [12 CFR §1030.3](https://www.ecfr.gov/current/title-12/section-1030.3) and the CFPB's UDAAP examination framework (enforced by DFPI under the CCFPL for California-chartered institutions) require that institutions maintain effective compliance management systems, including training and monitoring, to ensure ongoing accuracy of disclosures and advertising. No specific training or monitoring interval is prescribed by Reg DD; the annual cycle and monitoring cadence below represent Pynthia's minimum viable control posture.

**SYSTEM BEHAVIOR:** The CCO opens an annual Reg DD training cycle each calendar year. All employees who open accounts, calculate interest, prepare disclosures, or create advertising are assigned the Reg DD training module. Completion is tracked against `training.completion_due_at`; employees who do not complete within 30 days of cycle open are escalated to their manager. Compliance conducts periodic monitoring of disclosure and advertising compliance — at minimum quarterly sampling of account-opening disclosures, change-in-terms notices, and advertising approvals — and logs findings as `monitoring.findings.reported`. Any disclosure error detected (whether through monitoring, member complaint, or system alert) is escalated to the CCO within 2 business days via `disclosure.error.detected`; the CCO determines the remediation scope, affected accounts, and whether a regulatory notification is required. Escalation and error records are write-restricted to Compliance; monitoring sample results are accessible to Internal Audit.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual training cycle opens (`training.annual_cycle.opened`) | Cycle year, in-scope employee roles (account openers, interest calculators, disclosure preparers, advertising creators), curriculum ID (`training.curriculum_id`), completion deadline (`training.completion_due_at`) | Training assignments created for all in-scope employees (`training.assignment.created`) | Within 30 days of cycle open |
| Employee completes Reg DD training (`training.completed`) | Employee ID (`training.assignee_id`), module ID (`training.module_id`), completion date, assessment score (`training.assessment_score`) | Completion recorded (`training.completion.recorded`) | Within 30 days of cycle open (enforced by `training.completion_due_at`) |
| Quarterly monitoring sample drawn (`monitoring.review.completed`) | Sample specification (`monitoring.sample_spec`), scope (`monitoring.scope`) — account-opening disclosures, change-in-terms notices, advertising approvals; sample period | Monitoring findings logged (`monitoring.findings.reported`); any deficiencies escalated as findings (`finding.opened`) | Quarterly; internal SLA: within 15 business days of quarter close |
| Disclosure error detected (`disclosure.error.detected`) | Error description (`disclosure.error_description`), root cause (`disclosure.error_root_cause`), affected account IDs, detection source, CCO notification | Error escalation task created; CCO notified (`disclosure.error.detected`); remediation plan initiated | Escalate to CCO within 2 business days of detection (enforced by `disclosure.error_escalation_due_at`) |
| Disclosure error remediated (`disclosure.error.remediated`) | Error record ID, remediation actions taken, affected accounts corrected, CCO sign-off | Remediation confirmed and logged (`disclosure.error.remediated`) | Per CCO-directed remediation timeline |

**ALERTS/METRICS:** Alert if any in-scope employee has not completed the annual Reg DD training module within 30 days of cycle open. Alert if a quarterly monitoring review has not been completed within 15 business days of quarter close. Alert if any open `disclosure.error.detected` escalation has not received a CCO response within 2 business days — target zero aged escalations.

---

## Governance & Sign-Off {#governance}

| Role | Responsibility |
|---|---|
| **Patrick Wilson, Chief Compliance Officer** | Policy owner; approves all disclosure templates, advertising, interest-config changes, and error remediation plans; opens annual training cycle; reviews monitoring findings |
| **Deposit Operations** | Executes disclosure delivery, statement generation, interest accrual, maturity notice delivery; escalates delivery failures to Compliance |
| **Marketing** | Submits advertising for pre-publication review; may not self-approve |
| **Internal Audit** | Reviews monitoring sample results; conducts periodic independent audit of Reg DD controls |
| **Front-Line Staff** | Completes annual Reg DD training; escalates member questions about disclosures to Compliance |

**Review cadence:** This policy is reviewed annually (next review: 2026-07-01) and upon any material change to Regulation DD, California Financial Code §851 et seq., or Pynthia's deposit product menu.

**Cross-references:**
- Electronic Payment Systems Policy — Reg E §1005.17 ATM/one-time debit overdraft opt-in process
- E-Commerce Policy and Privacy Policy — E-SIGN consent mechanics and electronic delivery
- BSA Policy — Account-opening identity verification and CIP
- Record Retention Policy — Two-year Reg DD retention schedule and disposal procedures
- Compliance Policy — UDAAP examination framework and broader advertising-review process
- Member Policy — General member account servicing

---

## Assumptions & Gaps {#assumptions}

- **Engineering vocabulary is provisional.** Several field and event codes used in the control overlays above are not yet registered in `core-vocabulary.json` for the deposit/savings domain. The following codes are composed per the Composition grammar from registered objects, properties, and actions and are flagged as provisional pending engineering confirmation: `disclosure.error_description` (provisional: `incident.description` pattern applied to `disclosure` object), `disclosure.error_root_cause` (provisional: `incident.root_cause` pattern), `product.balance_method` (registered field — confirmed), `product.interest_config` (registered field — confirmed), `product.apy` (registered field — confirmed), `product.interest_rate` (registered field — confirmed), `product.contract_version` (registered field — confirmed), `template.product_scope` (registered field — confirmed), `fee.ytd_total` (registered field — confirmed), `fee.overdraft` (registered field — confirmed), `balance.disclosed` (registered field — confirmed), `balance.inquiry` (registered field — confirmed), `statement.days_in_period` (registered field — confirmed), `statement.cycle` (registered field — confirmed), `interest.accrued` (registered field — confirmed as `interest.accrued`), `interest.accrued_balance` (registered field — confirmed), `interest.credited` (registered field — confirmed), `interest.crediting_due_at` (registered timer — confirmed), `account.maturity_notice_due_at` (registered timer — confirmed), `account.maturity_window` (registered field — confirmed), `account.maturity_disposition` (registered field — confirmed), `account.maturity_date` (registered field — confirmed), `account.opening_channel` (registered field — confirmed), `account.restriction` (registered field — confirmed), `disclosure.account_opening_due_at` (registered timer — confirmed), `disclosure.change_in_terms_due_at` (registered timer — confirmed), `disclosure.error_escalation_due_at` (registered timer — confirmed), `disclosure.change_effective_date` (registered field — confirmed), `disclosure.classification_basis` (registered field — confirmed), `disclosure.change_in_terms.classified_nonadverse` (registered field — confirmed), `disclosure.template_id` (registered field — confirmed), `disclosure.artifact_id` (registered field — confirmed), `advertising.approval_id` (registered field — confirmed), `advertising.asset_id` (registered field — confirmed), `advertising.medium` (registered field — confirmed), `entity.esign_consent` (registered field — confirmed), `entity.reg_e_opt_in` (registered field — confirmed), `member.delivery_channel` (registered field — confirmed), `member.delivery_failure_reason` (registered field — confirmed). Any code not confirmed above should be registered by engineering before the next policy review.

- **California Financial Code §851 et seq. applicability.** This policy assumes Pynthia Credit Union is a state-chartered credit union subject to California Financial Code §851 et seq. parallel deposit-disclosure requirements. If Pynthia is federally chartered, the California Financial Code provisions do not apply and the WHY fields in TIS-01 and TIS-02 should be updated to remove that citation. Charter type should be confirmed by Legal before the effective date.

- **HMDA reporter status.** This policy does not address HMDA reporting obligations. If Pynthia meets the HMDA coverage thresholds, a separate HMDA/Reg C policy is required.

- **Reg E opt-in process scope.** TIS-08 addresses only the disclosure side of the Reg E §1005.17 ATM/one-time debit overdraft opt-in intersection. The assumption is that the opt-in workflow, consent capture, and `entity.reg_e_opt_in` flag management are fully governed by the Electronic Payment Systems Policy. If that policy does not cover the consent capture mechanics, TIS-08 will need to be expanded.

- **Maturity notice timing for CDs with terms ≤ 1 year.** Reg DD §1030.5(b) specifies different notice windows depending on account term (e.g., for accounts with terms of less than or equal to one year that automatically renew, notice must be provided at least 30 calendar days before maturity or within 10 calendar days after maturity). This policy applies a uniform 30-day advance notice standard for all maturities as the conservative posture. Engineering should confirm whether the system can differentiate notice timing by account term if a more precise implementation is required.

- **"Free" account claim definition.** TIS-07 applies the §1030.8 "free" account rule but does not enumerate which specific fee types disqualify an account from being advertised as "free." Compliance should document the specific fee categories (e.g., NSF fees, dormancy fees, paper statement fees) that trigger the restriction and configure the advertising review checklist accordingly before the effective date.

- **Monitoring sample size and methodology.** TIS-10 specifies quarterly monitoring but does not prescribe a sample size or statistical methodology. Compliance should document the sampling methodology (e.g., random sample of N account-opening disclosures per quarter, 100% review of change-in-terms notices) in a supporting procedure before the first monitoring cycle.
```
