```yaml
---
title: BSA Policy (Table-First, Design-Overlay v3)
owner: Patrick Wilson, Chief Compliance Officer
version: v1.0
effective: 2025-07-01
next_review: 2026-07-01
approvers:
  - Patrick Wilson, Chief Compliance Officer
tags: [Compliance, BSA, AML, CFT, OFAC, CIP, CDD, FinCEN, NCUA]
---
```

## General Policy Statement

Pynthia Credit Union maintains a risk-based, Board-approved BSA/AML/CFT/OFAC/CIP program that satisfies [12 CFR § 748.2](https://www.ecfr.gov/current/title-12/section-748.2) for federally insured credit unions and applicable Treasury regulations under [31 CFR Chapter X](https://www.ecfr.gov/current/title-31/chapter-X). The program verifies member identities; establishes and maintains customer due diligence and enhanced due diligence profiles (including beneficial ownership for legal entities); monitors transactions and reports suspicious activity; files required reports (CTR, SAR, CMIR, FBAR); screens against OFAC sanctions lists; identifies politically exposed persons; operationalizes FinCEN special measures and Geographic Targeting Orders; and escalates breaches. It applies to all members, accounts, transactions, channels, and third parties of the credit union. This policy consolidates the formerly separate AML/CFT, OFAC, and Customer Due Diligence programs. Out-of-scope items include information-system safeguards (see Information Security Policy), general third-party onboarding (see Third-Party Risk Policy), member privacy (see Privacy Policy), general records management (see Record Retention Policy), payment-rail operational controls (see Electronic Payment Systems Policy), and IRS/FinCEN Form 8300 (not applicable to Pynthia as a financial institution).

---

## Timing Matrix {#timing-matrix}

| Scenario | Trigger (human → event) | Deadline | Content Reference | Control |
|---|---|---:|---|---|
| Board policy approval | Annual cycle opens → `governance.board_cycle.opened` | Annual; interim within 30 days of material change | Board minutes + signed policy | [BSA-01](#bsa-01-governance--delegation) |
| Risk assessment review | Material change or calendar trigger → `risk.assessment.completed` | Every 12–18 months or on material change | Risk catalog + residual scores | [BSA-02](#bsa-02-enterprise-bsaaml-risk-assessment) |
| CIP verification before account opening | Onboarding submitted → `application.submitted` | Before account activation | CIP verification record | [BSA-03](#bsa-03-customer-identification-program-cip) |
| CDD profile created | KYC/CIP complete → `cdd.profile.created` | At account opening | CDD profile + risk tier | [BSA-04](#bsa-04-customer-due-diligence--enhanced-due-diligence) |
| EDD opened on trigger | High-risk signal → `risk.trigger_edd` | Same business day | EDD file | [BSA-04](#bsa-04-customer-due-diligence--enhanced-due-diligence) |
| OFAC screening — onboarding | Member/counterparty submitted → `verification.created` | Pre-account activation | OFAC result + hold if matched | [BSA-05](#bsa-05-ofac-screening--holds) |
| OFAC screening — pre-payment | Wire/ACH prepared → `wire_transfer.submitted` | Pre-execution | OFAC result + hold if matched | [BSA-05](#bsa-05-ofac-screening--holds) |
| OFAC block/reject report to OFAC | Block or reject placed → `ofac.blocked` / `ofac.rejected` | 10 business days | OFAC report filed | [BSA-05](#bsa-05-ofac-screening--holds) |
| OFAC annual blocked-property report | Scheduler → `ofac.annual_report_due` | September 30 (for assets blocked as of June 30) | Annual OFAC report | [BSA-05](#bsa-05-ofac-screening--holds) |
| BSA alert triage | Alert generated → `bsa_alert.created` | 2 business days | Alert disposition record | [BSA-06](#bsa-06-transaction-monitoring--case-management) |
| SAR decision | Case investigation complete → `case.investigation_complete` | 30 days from detection (suspect known); 60 days (no suspect) | SAR workpaper + filing | [BSA-07](#bsa-07-sar-filing--confidentiality) |
| Continuing SAR | 90-day review due → `sar.continuing_timer` | 30 days after 90-day review | Continuing SAR filing | [BSA-07](#bsa-07-sar-filing--confidentiality) |
| CTR filing | Cash threshold reached → `ctr.threshold.reached` | 15 calendar days after transaction date | CTR e-filed with FinCEN | [BSA-08](#bsa-08-currency-transaction-reporting-ctr) |
| CTR exemption (DOEP) filing | First exempt transaction → `ctr.exemption.designated` | 30 days after first exempt transaction | DOEP filed with FinCEN | [BSA-08](#bsa-08-currency-transaction-reporting-ctr) |
| CTR annual exemption review | Scheduler → `ctr.exemption_review_due` | Annually | Exemption review record | [BSA-08](#bsa-08-currency-transaction-reporting-ctr) |
| Monetary instrument log consolidation | Month-end → `mi.consolidation_timer` | 15th of following month | Central MI log updated | [BSA-09](#bsa-09-monetary-instruments-log) |
| Wire Travel Rule validation | Wire prepared → `wire_transfer.submitted` | Pre-release | Wire record with originator/beneficiary data | [BSA-10](#bsa-10-travel-rule-wires-3000) |
| 314(a) response | FinCEN SISS request received → `filing.fincen_314a` | 14 calendar days | Match/no-match response to FinCEN | [BSA-11](#bsa-11-information-sharing-314a314b) |
| CMIR filing | Reportable shipment identified → `cmir.reportable.identified` | 15 days after receipt (or by mailing/shipping date if not accompanying a person) | Form 105 e-filed | [BSA-12](#bsa-12-cmir-cross-border-currency) |
| FBAR filing | Foreign account inventory updated → `fbar.inventory.updated` | April 15 (auto-extension to October 15) | FinCEN Form 114 e-filed | [BSA-13](#bsa-13-fbar) |
| Escalation acknowledgment | Breach/issue reported → `escalation.created` | 1 business day | Internal acknowledgment | [BSA-14](#bsa-14-escalation-pathway) |
| Escalation action plan | Escalation acknowledged → `escalation.acknowledged` | 5 business days | Action plan published | [BSA-14](#bsa-14-escalation-pathway) |
| New-hire BSA training | Employee hired → `employee.hired` | 30 days of hire date | Training completion record | [BSA-15](#bsa-15-training) |
| Annual BSA training | Annual cycle opens → `training.annual_cycle.opened` | By policy anniversary | Training completion record | [BSA-15](#bsa-15-training) |
| Independent program testing | Cycle timer → `audit.cycle_timer` | Every 12–18 months | Audit report + remediation tracker | [BSA-16](#bsa-16-independent-testing) |
| High-risk category EDD refresh | Annual scheduler or event trigger → `edd.refresh_due` | At least annually | EDD file refreshed | [BSA-17](#bsa-17-high-risk-categories-msb-correspondent-private-banking) |
| PEP screening at onboarding | Applicant submitted → `pep.hit` | Before account activation (high-risk PEP) | PEP EDD file | [BSA-18](#bsa-18-pep-screening--edd) |
| Special measure / GTO operationalization | BSA Officer receives order → `regulatory.correspondence.received` | Circulate within 1 BD; implement by GTO deadline | GTO compliance record | [BSA-19](#bsa-19-fincen-special-measures--gtos) |
| Vendor due-diligence annual review | Scheduler → `vendor.annual_review_due` | Annually | Vendor review report | [BSA-20](#bsa-20-prepaid-access--third-party-vendors) |
| Record retention — BSA baseline | Account closed → `account.closed` | 5 years after closure / 5 years after record made | Retained record with timer set | [BSA-21](#bsa-21-record-retention) |
| Record retention — OFAC | Block/reject unblocked → `ofac.cleared` | 10 years after unblocking | Retained OFAC record | [BSA-21](#bsa-21-record-retention) |

---

## BSA-01 — Governance & Delegation {#bsa-01-governance--delegation}

**WHY (Reg cite):** [12 CFR § 748.2](https://www.ecfr.gov/current/title-12/section-748.2) requires a Board-approved, written BSA/AML program with a designated BSA Officer, internal controls, independent testing, and training. [31 CFR § 1020.210](https://www.ecfr.gov/current/title-31/section-1020.210) requires an ongoing AML program administered by a qualified individual.

**SYSTEM BEHAVIOR:** The Board approves the BSA policy at least annually and designates the BSA Officer by resolution. A RACI registry (`governance.raci_registry`) defines roles and segregation of duties across Compliance, BSA Operations, Vendor Management, Payments Operations, HR, and Internal Audit. The BSA Officer submits a monthly Board report covering CTR/SAR counts, exemption status, cash-activity changes, regulatory updates, law-enforcement requests, OFAC hits, wire activity, training status, and monetary-instrument log reviews. Interim policy review is required within 30 days of a material change (regulatory amendment, new product line, or significant risk-profile shift). The `policy_doc` object stores the current BSA Officer designation (`policy_doc.bsa_officer_id`), RACI registry (`policy_doc.raci_registry`), and version (`policy_doc.version`). The `governance` object tracks the board cycle (`governance.board_cycle`) and policy review due date (`governance.policy_review_due`). Write access to the policy artifact is restricted to the BSA Officer; the Board and examiners have read access.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual board cycle opens (`governance.board_cycle.opened`) | Current policy draft (`policy.draft_id`), RACI registry (`governance.raci_registry`), BSA Officer designation (`governance.bsa_officer_id`) | Board-approved policy version + minutes (`governance.policy.approved`); BSA Officer designation recorded (`governance.bsa_officer.designated`) | Annual; enforced by `governance.policy_review_due` |
| Material change identified (`policy.material_change.flagged`) | Change description (`policy.change_description`), change rationale (`policy.change_rationale`) | Interim board ratification (`governance.policy.approved`) | 30 days of material change |
| Monthly Board report due (`reporting.board_pack_due`) | CTR count (`reporting.bsa_metrics`), SAR count (`reporting.sar_count`), OFAC metrics (`reporting.ofac_metrics`), training metrics (`reporting.training_metrics`) | Board pack submitted (`reporting.board_pack.submitted`) | Monthly; enforced by `reporting.board_pack_due` |

**ALERTS/METRICS:** Alert if `governance.policy_review_due` is within 30 days and no approval event has fired. Alert if monthly Board report is not submitted within 5 business days of month-end. Track open RACI vacancies as a KRI.

---

## BSA-02 — Enterprise BSA/AML Risk Assessment {#bsa-02-enterprise-bsaaml-risk-assessment}

**WHY (Reg cite):** [12 CFR § 748.2](https://www.ecfr.gov/current/title-12/section-748.2) requires internal controls calibrated to the credit union's risk profile. [31 CFR § 1020.210](https://www.ecfr.gov/current/title-31/section-1020.210) requires risk-based AML procedures. FFIEC BSA/AML Examination Manual defines examiner expectations for risk-assessment scope (products, services, customers, geographies) and documentation.

**SYSTEM BEHAVIOR:** The BSA Officer maintains a product/partner/channel/geography risk catalog (`risk_catalog_entry`) that scores inherent risk and residual risk after controls. The catalog drives EDD triggers and monitoring intensity. The assessment is reviewed every 12–18 months or upon a material change (new product, new geography, significant customer-base shift, or regulatory change). Results are reported to the Board. The `risk` object tracks `risk.assessment_due_at`, `risk.inherent_score`, `risk.residual_rating`, and `risk.geography_factors`. The `risk_catalog_entry` object captures `risk_catalog_entry.inherent_score`, `risk_catalog_entry.geography_factors`, and `risk_catalog_entry.partner_dependency`. Write access is restricted to the BSA Officer and Compliance; the Board and Internal Audit have read access.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Assessment cycle due (`risk.assessment_due_at`) | Product/service catalog (`risk_catalog_entry`), customer-base data (`cdd.risk_tier`), geography factors (`risk.geography_factors`), partner dependencies (`risk_catalog_entry.partner_dependency`) | Completed risk assessment (`risk.assessment.completed`); catalog entry created/updated (`risk.catalog_entry.created`) | Every 12–18 months; enforced by `risk.assessment_due_at` |
| Material change detected (`policy.material_change.flagged`) | Description of change (`policy.change_description`), affected products/channels | Reassessment triggered (`risk.assessment.completed`) | Within 30 days of material change |
| Assessment results delivered to Board | Completed assessment artifact | Board report delivered (`governance.board_report.delivered`) | At next scheduled Board meeting after assessment completion |

**ALERTS/METRICS:** Alert if `risk.assessment_due_at` is breached without a completed assessment event. Track residual-risk score distribution across catalog entries; flag any entry where residual rating exceeds appetite threshold.

---

## BSA-03 — Customer Identification Program (CIP) {#bsa-03-customer-identification-program-cip}

**WHY (Reg cite):** [31 CFR § 1020.220](https://www.ecfr.gov/current/title-31/section-1020.220) (USA PATRIOT Act § 326) requires identity verification before or promptly after account opening, recordkeeping of verification methods and results, and government-list comparison. [12 CFR § 748.2](https://www.ecfr.gov/current/title-12/section-748.2) incorporates CIP into the BSA program.

**SYSTEM BEHAVIOR:** Before account activation, the system collects required identity data for individuals (legal name via `entity.name`, date of birth via `entity.date_of_birth`, address via `entity.address`, TIN via `entity.tin`) and for entities (legal name, address, EIN/TIN). Verification is performed by documentary methods (unexpired government-issued photo ID) or non-documentary methods (credit bureau, public databases). The `verification` object tracks the result (`verification.status`, `verification.provider_result`, `verification.trust_level`). Account activation is blocked until `verification.status = approved`. If initial verification fails and additional CDD does not resolve identity, the BSA Officer may close the account. Non-US persons require officer approval and alternative government-issued document numbers. A 45-day pending period applies for missing authorized-signer TINs; exceptions apply for newborns/minors with proof of TIN application. Identity records are retained 5 years after account closure; verification records (methods, results, discrepancy resolution) are retained 5 years after the record is made. Write access to verification outcomes is restricted to trained reviewers; overrides require dual control.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Onboarding application submitted (`application.submitted`) | Legal name (`entity.name`), DOB (`entity.date_of_birth`), address (`entity.address`), TIN (`entity.tin`), ID document type and number (`verification.type`, `verification.provider_result`) | Verification created (`verification.created`); OFAC screened (`ofac.cleared` or `ofac.hold.placed`) | Before account activation |
| Verification provider returns result (`verification.completed`) | Provider result (`verification.provider_result`), match status (`verification.match_status`), trust level (`verification.trust_level`) | Verification approved (`verification.completed`) or denied (`verification.denied`); account activation blocked if denied | Immediately on provider response |
| Verification fails and manual review required | Discrepancy details, additional documents | Manual review case opened (`case.opened`); dual-control override recorded if applicable | Within reasonable time; account not activated until resolved |
| Account closed (`account.closed`) | Member ID (`member.id`), closure date | Retention timer set for CIP records (`record.retention_clock_set`); retention anchor = closure date + 5 years | At account closure; enforced by `record.retention_expires_at` |

**ALERTS/METRICS:** Alert on any account that reaches `account.created` state without a corresponding `verification.completed` (approved) event. Track manual-review queue aging; target zero accounts open >7 days without resolved verification. Monitor false-positive rate from non-documentary verification providers.

---

## BSA-04 — Customer Due Diligence & Enhanced Due Diligence {#bsa-04-customer-due-diligence--enhanced-due-diligence}

**WHY (Reg cite):** [31 CFR § 1010.230](https://www.ecfr.gov/current/title-31/section-1010.230) requires collection and verification of beneficial ownership (natural persons owning ≥25% plus one control person) for legal-entity customers. [31 CFR § 1020.210](https://www.ecfr.gov/current/title-31/section-1020.210) requires ongoing CDD including understanding the nature and purpose of relationships and maintaining/updating customer information. FFIEC BSA/AML Examination Manual defines risk-rating factors and EDD documentation standards.

**SYSTEM BEHAVIOR:** At account opening, a CDD profile is created capturing expected activity (`cdd.expected_activity`), source of funds (`cdd.source_of_funds`), industry code (`cdd.industry_code`), and risk tier (`cdd.risk_tier`). For legal-entity customers, beneficial ownership is collected via a certification form: all natural persons owning ≥25% (ownership prong) and one control person (control prong) are identified and verified using CIP-equivalent procedures (`cdd.control_person`). Exemptions from BO collection apply to regulated entities listed in 31 CFR § 1010.230 (e.g., federally regulated financial institutions, listed companies, government entities); exemption rationale is documented. High-risk playbooks (EDD checklists) are maintained per risk category. EDD is opened within one business day of a trigger and completed within five business days (or extension documented). EDD refresh cadence is set by risk tier and triggered by event-driven changes (ownership change, adverse media, SAR filing). The `edd` object tracks `edd.approver_id`, `edd.category_checklist`, `edd.source_of_wealth`, `edd.site_visit_report`, and `edd.refresh_due`. Senior Compliance approval is required for EDD decisions; dual control applies to exits.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| CIP verification approved for individual (`verification.completed`) | Expected activity (`cdd.expected_activity`), source of funds (`cdd.source_of_funds`), industry code (`cdd.industry_code`) | CDD profile created (`cdd.profile.created`) with initial risk tier | At account opening |
| Business account application submitted (`application.submitted`) | BO certification form, BO list (`cdd.control_person`), ownership percentages, CIP data for each BO | BO certified (`cdd.bo.certified`); BO OFAC screened (`ofac.cleared` or `ofac.hold.placed`) | Before business account activation |
| High-risk trigger fires (`risk.trigger_edd`) | Trigger type (industry, geography, PEP, adverse media, behavior, volume), source of wealth (`edd.source_of_wealth`), additional documents (`edd.category_checklist`) | EDD opened (`edd.pep.opened` or `edd.completed`); senior approval recorded (`edd.category.approved`) | EDD opened same business day; completed within 5 BD; enforced by `edd.refresh_due` |
| Periodic refresh due (`cdd.refresh_due`) | Updated expected activity, source of funds, BO re-check, adverse media rescan | CDD profile refreshed (`cdd.profile.refreshed`); EDD refresh completed (`edd.refresh.completed`) if applicable | Per risk tier (high: annually; medium: 24 months; low: 36 months); enforced by `cdd.refresh_due` |
| Ownership change detected (`entity.updated`) | New BO data, updated ownership percentages | BO re-certification triggered; `cdd.profile.refreshed` | Within 30 days of change |

**ALERTS/METRICS:** Alert if EDD is not opened within 1 business day of a `risk.trigger_edd` event. Alert if `cdd.refresh_due` is breached without a `cdd.profile.refreshed` event. Track % of legal-entity accounts with complete BO certification; target 100%.

---

## BSA-05 — OFAC Screening & Holds {#bsa-05-ofac-screening--holds}

**WHY (Reg cite):** [31 CFR Part 501](https://www.ecfr.gov/current/title-31/part-501) (OFAC reporting, procedures, and penalties) and applicable sanctions program regulations (e.g., [31 CFR Part 594](https://www.ecfr.gov/current/title-31/part-594)) require blocking or rejecting transactions and accounts involving SDNs and sanctioned countries, reporting blocked/rejected transactions within 10 business days, and filing annual blocked-property reports. OFAC record retention is 10 years effective March 12, 2025.

**SYSTEM BEHAVIOR:** All members, beneficial owners, counterparties, and payment parties are screened against OFAC SDN and other applicable sanctions lists at onboarding and pre-execution of payments (wires, ACH, monetary instruments, loan disbursements). The 50% rule is applied: entities 50% or more owned by a blocked person are treated as blocked regardless of list appearance. On a potential match, the system places an automatic hold (`ofac.hold.placed`) and routes to a Sanctions Analyst for adjudication within 1 business day. If confirmed, funds are placed in a segregated interest-bearing account; no set-offs are permitted; escheat to state is permitted only with OFAC license. Rejected transactions are reported to OFAC within 10 business days via the OFAC Reporting System. Annual blocked-property reports are filed by September 30 for assets blocked as of June 30. False positives are cleared with documented rationale (`ofac.hotline_record` if OFAC hotline was consulted). Licenses and license applications are tracked. The `ofac` object tracks `ofac.blocked_property`, `ofac.hotline_record`, `ofac.list_version`, `ofac.annual_report_due`, and `ofac.report_timer`. OFAC records are retained 10 years after unblocking. Only Sanctions Analysts may adjudicate hits; the BSA Officer is notified of all confirmed blocks/rejects.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| New member/BO/counterparty submitted (`verification.created`) | Subject identifiers (`entity.name`, `entity.tin`, `entity.date_of_birth`, `entity.address`), list version (`ofac.list_version`) | OFAC screened; cleared (`ofac.cleared`) or hold placed (`ofac.hold.placed`) | Pre-account activation |
| Wire/ACH/payment prepared (`wire_transfer.submitted`) | Originator and beneficiary identifiers (`originator.name`, `originator.routing_number`, `beneficiary.name`, `beneficiary.routing_number`), amount (`wire_transfer.amount`) | OFAC screened; cleared or hold placed (`ofac.hold.placed`); blocked (`ofac.blocked`) or rejected (`ofac.rejected`) if confirmed | Pre-execution |
| OFAC hit confirmed as true match | Hit details, OFAC hotline record (`ofac.hotline_record`), approver decision | Block or reject executed (`ofac.blocked` / `ofac.rejected`); OFAC report filed (`ofac.report.filed`) | Report to OFAC within 10 business days; enforced by `ofac.report_timer` |
| Annual blocked-property report due (`ofac.annual_report_due`) | All blocked assets as of June 30 (`ofac.blocked_property`) | Annual OFAC report filed (`ofac.annual_report.filed`) | September 30 annually; enforced by `ofac.annual_report_due` |
| OFAC list updated by Treasury | New list version | Re-screen triggered for existing members (`ofac.rescreen.completed`) | Within 1 business day of list update |

**ALERTS/METRICS:** Alert if any `ofac.hold.placed` event is not adjudicated within 1 business day. Alert if `ofac.report_timer` fires without a corresponding `ofac.report.filed`. Track confirmed-match rate and false-positive rate monthly.

---

## BSA-06 — Transaction Monitoring & Case Management {#bsa-06-transaction-monitoring--case-management}

**WHY (Reg cite):** [31 CFR § 1020.210](https://www.ecfr.gov/current/title-31/section-1020.210) requires ongoing monitoring to identify and report suspicious transactions. [31 CFR § 1020.320](https://www.ecfr.gov/current/title-31/section-1020.320) sets SAR filing deadlines anchored to initial detection. FFIEC BSA/AML Examination Manual defines alert-management, case-documentation, and SAR-decision standards.

**SYSTEM BEHAVIOR:** Rules-based and model-based monitoring generates `bsa_alert` records (`bsa_alert.alert_type`, `bsa_alert.details`, `bsa_alert.status`). Each alert is triaged within 2 business days of creation (`bsa_alert.triage_timer`). Alerts that cannot be resolved at triage are escalated to a case (`case.opened`). Cases are managed through investigation to a SAR/no-SAR decision within 30 days of initial detection (or 60 days if no suspect). The `case` object tracks `case.type`, `case.summary`, `case.evidence[]`, `case.sar_decision_timer`, and `case.status`. A SAR committee (BSA Officer, Compliance, and legal counsel as needed) makes the filing decision. Do-not-file decisions are documented and retained. The BSA Officer reports all SAR filings to the Board at the next scheduled meeting. Investigations role is required to open or close cases; the BSA Officer has write access to SAR decisions.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Monitoring system generates alert (`bsa_alert.created`) | Alert type (`bsa_alert.alert_type`), entity hash (`bsa_alert.entity_hash`), event ID (`bsa_alert.event_id`), lookback flag (`bsa_alert.requires_lookback`) | Alert record created; triage timer started (`bsa_alert.triage_timer`) | Alert created immediately; triage within 2 BD; enforced by `bsa_alert.triage_timer` |
| Alert escalated to case | Alert details, member transaction history, CDD profile (`cdd.profile`) | Case opened (`case.opened`); SAR decision timer started (`case.sar_decision_timer`) | Same business day as escalation decision |
| Case investigation complete (`case.investigation_complete`) | Case summary (`case.summary`), evidence (`case.evidence[]`), SAR decision | SAR filed (`sar.filed`) or do-not-file recorded (`sar.decision_no_file`); Board notified at next meeting | 30 days from initial detection (suspect known); 60 days (no suspect); enforced by `case.sar_decision_timer` |

**ALERTS/METRICS:** Alert if any `bsa_alert` remains in open status beyond 2 business days without a triage disposition. Alert if any case exceeds 28 days without a SAR decision event (early warning before 30-day deadline). Track alert-to-SAR conversion rate and case aging distribution monthly.

---

## BSA-07 — SAR Filing & Confidentiality {#bsa-07-sar-filing--confidentiality}

**WHY (Reg cite):** [31 CFR § 1020.320](https://www.ecfr.gov/current/title-31/section-1020.320) requires SAR filing within 30 calendar days of initial detection (60 days if no suspect identified), continuing SARs every 90 days for ongoing activity, 5-year retention of SARs and supporting documents, and strict confidentiality (no tipping off). Safe harbor from civil liability applies to all SAR filings.

**SYSTEM BEHAVIOR:** SARs are filed electronically via FinCEN's BSA E-Filing System. The SAR narrative (`sar.narrative`) includes only information directly relevant to the suspicious activity; the receipt of law-enforcement inquiries (grand jury subpoenas, NSLs, 314(a) requests) is not referenced in the narrative. Continuing SARs are filed at least every 90 days for ongoing activity; the 90-day review window is tracked by `sar.continuing_timer` and the filing must occur within 30 days of the review. SAR records and all supporting documentation are retained 5 years from the filing date (`sar.filing_timer`). SAR visibility is restricted: only the BSA Officer, designated Compliance staff, and legal counsel may access SAR records. The Board receives monthly summaries (counts and brief descriptions, no subject names). If subpoenaed for a SAR, the credit union declines to produce it and notifies FinCEN and NCUA. The SAR committee reviews accounts prior to filing to determine whether to restrict or close the relationship; a "Do Not Re-Open" notation is applied when a relationship is terminated for BSA risk. The `sar` object tracks `sar.narrative`, `sar.prior_filing_id`, `sar.filing_timer`, `sar.continuing_timer`, and `sar.decision_file`. SAR data is write-restricted to the BSA Officer and designated Compliance staff.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| SAR decision made to file (`case.investigation_complete`) | SAR narrative (`sar.narrative`), prior filing ID if continuing (`sar.prior_filing_id`), supporting evidence (`case.evidence[]`) | SAR filed (`sar.filed`); filing timer set (`sar.filing_timer`) | 30 days from initial detection (suspect known); 60 days (no suspect); enforced by `sar.filing_timer` |
| 90-day continuing review due (`sar.continuing_timer`) | Review of ongoing activity, updated narrative | Continuing SAR filed (`sar.continuing.filed`) | Within 30 days of 90-day review; enforced by `sar.continuing_timer` |
| Subpoena or disclosure request received for SAR (`sar.disclosure_request.received`) | Request details, requester identity | Disclosure declined (`sar.disclosure.declined`); FinCEN and NCUA notified | Immediately upon receipt |
| SAR retention period expires | Filing date + 5 years (`sar.filing_timer`) | Retention purge executed (`retention.purge.executed`) | 5 years from filing date |

**ALERTS/METRICS:** Alert if `sar.filing_timer` fires without a `sar.filed` event. Alert if `sar.continuing_timer` fires without a `sar.continuing.filed` event. Track SAR filing timeliness rate (target 100% on-time). Monitor SAR access log for unauthorized access attempts.

---

## BSA-08 — Currency Transaction Reporting (CTR) {#bsa-08-currency-transaction-reporting-ctr}

**WHY (Reg cite):** [31 CFR § 1010.311](https://www.ecfr.gov/current/title-31/section-1010.311) requires filing a CTR for each currency transaction exceeding $10,000. [31 CFR § 1010.306](https://www.ecfr.gov/current/title-31/section-1010.306) sets the 15-calendar-day filing deadline. Exemption procedures (Phase I and Phase II) are governed by [31 CFR § 1020.315](https://www.ecfr.gov/current/title-31/section-1020.315); FinCEN Form 110 (Designation of Exempt Person) is required for non-Phase-I exemptions.

**SYSTEM BEHAVIOR:** The system auto-aggregates cash-in and cash-out transactions per person per business day (`ctr.cash_in_total`, `ctr.cash_out_total`). When the aggregate exceeds $10,000, a CTR is generated and e-filed with FinCEN within 15 calendar days (`ctr.filing_timer`). Phase I exemptions (banks, government entities, listed companies and their subsidiaries) do not require a DOEP filing. Phase II exemptions (eligible non-listed businesses and payroll customers) require a DOEP (FinCEN Form 110) filed within 30 days of the first exempt transaction and annual renewal. Ineligible business types (as defined in 31 CFR § 1020.315) are excluded from Phase II. Annual exemption reviews confirm continued eligibility (`ctr.exemption_review_due`). Exemption does not relieve the credit union of SAR obligations or monetary-instrument recordkeeping. CTR backfilling is coordinated with the FinCEN Help Line. The `ctr` object tracks `ctr.cash_in_total`, `ctr.cash_out_total`, `ctr.exemption_basis`, `ctr.filing_timer`, `ctr.exemption_review_due`, and `ctr.exemption_review_timer`. CTR records are retained 5 years from the date of the report.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Daily cash aggregate exceeds $10,000 (`ctr.threshold.reached`) | Aggregated cash-in (`ctr.cash_in_total`), cash-out (`ctr.cash_out_total`), person identity (`entity.name`, `entity.tin`), transaction details | CTR e-filed with FinCEN (`ctr.filed`); filing timer set (`ctr.filing_timer`) | 15 calendar days after transaction date; enforced by `ctr.filing_timer` |
| First exempt transaction for Phase II customer | Customer eligibility documentation, exemption basis (`ctr.exemption_basis`) | DOEP filed (`ctr.doep.filed`); exemption designated (`ctr.exemption.designated`) | Within 30 days of first exempt transaction |
| Annual exemption review due (`ctr.exemption_review_due`) | Eligibility documentation (annual reports, stock quotes, business records), account cash-flow review | Exemption reviewed (`ctr.exemption.reviewed`); revocation initiated if ineligible | Annually; enforced by `ctr.exemption_review_timer` |

**ALERTS/METRICS:** Alert if `ctr.filing_timer` fires without a `ctr.filed` event. Alert if any exemption review is overdue. Track CTR filing timeliness rate (target 100%). Monitor for structuring patterns (multiple sub-$10,000 transactions by the same person on the same day).

---

## BSA-09 — Monetary Instruments Log {#bsa-09-monetary-instruments-log}

**WHY (Reg cite):** [31 CFR § 1010.415](https://www.ecfr.gov/current/title-31/section-1010.415) requires recordkeeping for cash purchases of monetary instruments (cashier's checks, bank drafts) in amounts from $3,000 to $10,000 inclusive, including purchaser identity, instrument type, serial numbers, and dollar amounts. Records must be retained 5 years.

**SYSTEM BEHAVIOR:** At the point of sale, the teller captures purchaser identity (verified against account records or acceptable photo ID), instrument type (`mi.instrument_type`), serial number(s), and purchase amount (`mi.amount`) in the `mi_central_log`. Simultaneous purchases of the same or different instrument types totaling $3,000 or more are treated as one purchase. Indirect currency purchases (where currency is deposited first then used to purchase an instrument) are subject to the same recordkeeping. If the purchaser cannot be identified, the transaction is refused. Branch-level logs are consolidated to the central MI log by the 15th of the following month (`mi.consolidation_timer`). The BSA Officer reviews the Official Document Report periodically for completeness. Records are retained 5 years. The `mi_central_log` object tracks `mi_central_log.amount`, `mi_central_log.instrument_type`, and `mi_central_log.purchaser_id_number`. Write access is restricted to teller staff at point of sale and BSA Operations for consolidation.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Monetary instrument purchased for cash $3,000–$10,000 (`monetary_instrument.purchased`) | Purchaser name (`entity.name`), purchaser ID number (`mi_central_log.purchaser_id_number`), instrument type (`mi_central_log.instrument_type`), serial number(s), amount (`mi_central_log.amount`), date of purchase | MI log entry created (`mi.log_entry.created`) | At point of sale |
| Month-end consolidation due (`mi.consolidation_timer`) | All branch-level MI log entries for the month | Central MI log updated (`mi.central_log.updated`) | By 15th of following month; enforced by `mi.consolidation_timer` |
| Retention period expires | Log entry date + 5 years | Retention purge executed (`retention.purge.executed`) | 5 years from date of record |

**ALERTS/METRICS:** Alert if `mi.consolidation_timer` fires without a `mi.central_log.updated` event. Alert if any MI log entry is missing required fields (purchaser ID, serial number, amount). Track completeness rate of MI log entries monthly (target 100%).

---

## BSA-10 — Travel Rule (Wires ≥$3,000) {#bsa-10-travel-rule-wires-3000}

**WHY (Reg cite):** [31 CFR § 1010.410(e) and (f)](https://www.ecfr.gov/current/title-31/section-1010.410) (the "Travel Rule") requires originating financial institutions to include and transmit originator and beneficiary information with funds transfers of $3,000 or more, and requires beneficiary institutions to retain the original or reproduction of the payment order. Records must be retained 5 years.

**SYSTEM BEHAVIOR:** For outgoing wires ≥$3,000, the system requires and validates originator name and address (`originator.name`), originator account number or reference (`originator.reference`), originator routing number (`originator.routing_number`), amount (`wire_transfer.amount`), date, beneficiary's financial institution identity (`beneficiary.bank_name`, `beneficiary.routing_number`), and as many beneficiary identifiers as provided (`beneficiary.name`, `beneficiary.account_number`). The wire is blocked from release until all required fields are populated (`wire_transfer.status = pending_approval` until validated). For incoming wires ≥$3,000, the original or reproduction of the payment order is retained (`wire_transfer.record_retained`). Recordkeeping exemptions apply when both originator and beneficiary are the same person at the same domestic institution, or when both are domestic banks, government entities, or their subsidiaries. Records are retrievable by originator name/account number and beneficiary name/account number. The `wire_transfer` object tracks `wire_transfer.amount`, `wire_transfer.originator`, `wire_transfer.beneficiary`, `wire_transfer.record_retained`, and `wire_transfer.status`. Wire release requires second approval for high-value or international wires per the Electronic Payment Systems Policy.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Wire transfer prepared (`wire_transfer.submitted`) | Originator name/address/account (`originator.name`, `originator.reference`, `originator.routing_number`), beneficiary identifiers (`beneficiary.name`, `beneficiary.account_number`, `beneficiary.routing_number`, `beneficiary.bank_name`), amount (`wire_transfer.amount`) | Wire validated and released (`wire_transfer.created`); record retained (`wire_transfer.record_retained`) | Pre-release; wire blocked until all required fields validated |
| Incoming wire received | Original payment order or reproduction | Record retained (`wire_transfer.record_retained`) | At receipt |
| Retention period expires | Wire record date + 5 years | Retention purge executed (`retention.purge.executed`) | 5 years from date of record |

**ALERTS/METRICS:** Alert if any wire ≥$3,000 reaches `wire_transfer.submitted` state with missing required Travel Rule fields. Track % of wires with complete originator/beneficiary data (target 100%). Monitor for wires to/from high-risk jurisdictions as a transaction-monitoring input.

---

## BSA-11 — Information Sharing (314(a)/314(b)) {#bsa-11-information-sharing-314a314b}

**WHY (Reg cite):** [31 CFR § 1010.520](https://www.ecfr.gov/current/title-31/section-1010.520) (Section 314(a)) requires financial institutions to search records and respond to FinCEN requests within 14 calendar days. [31 CFR § 1010.540](https://www.ecfr.gov/current/title-31/section-1010.540) (Section 314(b)) establishes a voluntary safe harbor for FI-to-FI information sharing among registered institutions.

**SYSTEM BEHAVIOR:** The BSA Officer and designated staff receive 314(a) requests via FinCEN's Secure Information Sharing System (SISS). Upon receipt, the system searches deposit records, funds-transfer records (originators and recipients for the preceding 12 months for account-linked transactions; 6 months for non-account-linked), monetary-instrument sales records (remitters), loan records, and safe-deposit records. Only a match/no-match response is provided to FinCEN; no additional details are shared. A negative response is not required. All requests and search results are documented and retained until after the most current NCUA BSA examination. If a match is found, the SAR committee reviews whether a SAR should be filed. 314(a) request information is not referenced in SAR narratives. For 314(b), the credit union maintains current FinCEN registration and verifies counterpart registration before sharing. Annual renewal of 314(b) certification is required. The `filing` object tracks `filing.fincen_314a` and `filing.status`. Access to 314(a) request files is restricted to the BSA Officer and Board-approved staff.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| 314(a) request received via SISS (`regulator.request.received`) | Named subjects (`fincen314a_data.request_scope`), lookback windows (12 months account-linked; 6 months non-account-linked) | Search completed; match/no-match response filed (`filing.fincen_314a` → `filing.status = submitted`); supporting documents retained | 14 calendar days of request; enforced by `regulator.response_due_at` |
| 314(b) certification renewal due | Current FinCEN registration status, counterpart registration (`fincen314a_data.counterpart_registration`) | 314(b) certification renewed; registration confirmed | Annually |
| Match found on 314(a) search | Match details, member account/transaction records | SAR committee review triggered (`case.opened` if warranted) | Concurrent with 314(a) response |

**ALERTS/METRICS:** Alert if `regulator.response_due_at` fires without a submitted 314(a) response. Alert if 314(b) certification lapses. Track 314(a) response timeliness rate (target 100% within 14 days).

---

## BSA-12 — CMIR (Cross-Border Currency) {#bsa-12-cmir-cross-border-currency}

**WHY (Reg cite):** [31 CFR § 1010.340](https://www.ecfr.gov/current/title-31/section-1010.340) requires filing FinCEN Form 105 (CMIR) for the international transportation of currency or monetary instruments exceeding $10,000 by, through, or to the United States. Records are retained 5 years.

**SYSTEM BEHAVIOR:** The BSA Officer identifies reportable cross-border currency shipments or receipts involving credit union personnel or on behalf of the credit union. When a reportable event is identified, FinCEN Form 105 is e-filed within 15 days after receipt of the currency or monetary instruments (or by the mailing/shipping date if not accompanying a person). The `cmir` object tracks `cmir.filing_timer`. The `cmir_data` object captures `cmir_data.amount`, `cmir_data.counterparty`, `cmir_data.direction`, and `cmir_data.shipment_manifest`. Filing confirmations are stored and retained 5 years.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Reportable cross-border currency shipment/receipt identified (`cmir.reportable.identified`) | Amount (`cmir_data.amount`), direction (`cmir_data.direction`), counterparty (`cmir_data.counterparty`), shipment manifest (`cmir_data.shipment_manifest`) | CMIR filed (`cmir.filed`); filing timer set (`cmir.filing_timer`) | 15 days after receipt (or by mailing/shipping date if not accompanying a person); enforced by `cmir.filing_timer` |
| Retention period expires | Filing date + 5 years | Retention purge executed (`retention.purge.executed`) | 5 years from filing date |

**ALERTS/METRICS:** Alert if `cmir.filing_timer` fires without a `cmir.filed` event. Track all CMIR filings in the annual BSA activity report to the Board.

---

## BSA-13 — FBAR {#bsa-13-fbar}

**WHY (Reg cite):** [31 CFR § 1010.350](https://www.ecfr.gov/current/title-31/section-1010.350) requires U.S. persons with financial interest in or signature authority over foreign financial accounts exceeding $10,000 aggregate to file FinCEN Form 114 (FBAR) annually. The deadline is April 15 with an automatic extension to October 15.

**SYSTEM BEHAVIOR:** The BSA Officer maintains an inventory of foreign financial accounts (`fbar_data.account_record`) for which the credit union has a filing obligation. The annual filing calendar is maintained with the April 15 deadline and automatic October 15 extension. FBARs are e-filed via the BSA E-Filing System. The `fbar` object tracks `fbar.filing_timer`. If no reportable accounts exist, a nil determination is documented (`fbar.nil.determined`). Filing confirmations are retained.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Foreign account inventory updated (`fbar.inventory.updated`) | Account records (`fbar_data.account_record`), authority type (`fbar_data.authority_type`), aggregate balance | FBAR account added to inventory (`fbar.account.added`) | At account identification |
| Annual FBAR filing due (`fbar.filing_timer`) | Complete foreign account inventory (`fbar_data.account_record`) | FBAR e-filed (`fbar.filed`) or nil determination recorded (`fbar.nil.determined`) | April 15 (auto-extension to October 15); enforced by `fbar.filing_timer` |

**ALERTS/METRICS:** Alert if `fbar.filing_timer` fires without a `fbar.filed` or `fbar.nil.determined` event. Track foreign account inventory completeness annually.

---

## BSA-14 — Escalation Pathway {#bsa-14-escalation-pathway}

**WHY (Reg cite):** [12 CFR § 748.2](https://www.ecfr.gov/current/title-12/section-748.2) requires internal controls that ensure timely escalation of compliance breaches. [31 CFR § 1020.320](https://www.ecfr.gov/current/title-31/section-1020.320) requires immediate law-enforcement notification (by telephone) for violations requiring urgent attention, in addition to timely SAR filing.

**SYSTEM BEHAVIOR:** Any employee may initiate a one-click breach/emergent-issue escalation to the BSA Officer and General Counsel via the `escalation` object. The escalation captures `escalation.severity`, `escalation.facts`, `escalation.reporter_id`, and `escalation.regulatory_assessment`. The BSA Officer acknowledges internally within 1 business day (`escalation.ack_timer`) and publishes an action plan within 5 business days (`escalation.plan_timer`). For violations requiring immediate attention (ongoing reportable violations), law enforcement is notified by telephone and NCUA is notified as applicable, in addition to filing a timely SAR. Regulator notifications are documented. The `escalation` object is write-restricted to the reporter at creation; the BSA Officer and General Counsel have write access for acknowledgment and action plan.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Breach or emergent issue identified (`escalation.created`) | Severity (`escalation.severity`), facts (`escalation.facts`), reporter ID (`escalation.reporter_id`), regulatory assessment (`escalation.regulatory_assessment`) | Escalation created and routed (`escalation.routed`) to BSA Officer and General Counsel | Immediately |
| BSA Officer acknowledges escalation (`escalation.acknowledged`) | Acknowledgment details | Internal acknowledgment recorded (`escalation.acknowledged`) | 1 business day of escalation creation; enforced by `escalation.ack_timer` |
| Action plan published (`escalation.action_plan.published`) | Remediation steps, responsible parties, regulator notification status | Action plan published (`escalation.action_plan.published`) | 5 business days of acknowledgment; enforced by `escalation.plan_timer` |

**ALERTS/METRICS:** Alert if `escalation.ack_timer` fires without an `escalation.acknowledged` event. Alert if `escalation.plan_timer` fires without an `escalation.action_plan.published` event. Track open escalations by severity and age weekly.

---

## BSA-15 — Training {#bsa-15-training}

**WHY (Reg cite):** [12 CFR § 748.2](https://www.ecfr.gov/current/title-12/section-748.2) requires periodic training of appropriate personnel. [31 CFR § 1020.210](https://www.ecfr.gov/current/title-31/section-1020.210) requires training as a pillar of the AML program. FFIEC BSA/AML Examination Manual defines training adequacy standards including comprehensiveness, accuracy, scheduling, and attendance tracking.

**SYSTEM BEHAVIOR:** Role-based BSA curricula are maintained in `training.role_curriculum` and `training.board_curriculum`. New employees complete initial BSA training within 30 days of hire (`training.newhire_due_at`). All employees complete annual refresher training by the policy anniversary (`training.annual_due_at`). Board and committee members receive annual training tracked separately (`training.board_curriculum`). The BSA Officer and designated BSA staff attend at least one external training session per year relevant to regulatory changes or the BSA risk profile. Training records (`training.completion_status`, `training.assignee_id`, `training.curriculum_id`, `training.hire_date`) are maintained and reported to the Board. The `training` object tracks `training.new_hire_timer`, `training.annual_timer`, `training.board_curriculum`, `training.role_curriculum`, and `training.completion_due_at`. HR provides hire-date data to trigger new-hire assignments.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Employee hired (`employee.hired`) | Hire date (`training.hire_date`), role (`employee.role`), assigned curriculum (`training.role_curriculum`) | Training assignment created (`training.assignment.created`); new-hire timer started (`training.new_hire_timer`) | Assignment within 1 business day of hire |
| New-hire training due (`training.newhire_due_at`) | Completed training modules, assessment score (`training.assessment_score`) | Training completion recorded (`training.completion.recorded`) | 30 days of hire date; enforced by `training.newhire_due_at` |
| Annual training cycle opens (`training.annual_cycle.opened`) | Role-based curriculum (`training.role_curriculum`), Board curriculum (`training.board_curriculum`) | Annual training assigned (`training.annual.assigned`); annual timer started (`training.annual_timer`) | At policy anniversary |
| Annual training due (`training.annual_due_at`) | Completed modules, assessment score | Training completion recorded (`training.completion.recorded`); Board session scheduled (`training.board_session.scheduled`) | By policy anniversary; enforced by `training.annual_due_at` |

**ALERTS/METRICS:** Alert if `training.newhire_due_at` fires without a `training.completion.recorded` event for the employee. Alert if `training.annual_due_at` fires with incomplete coverage. Track training completion rate by role (target 100% before deadline). Report training activity to Board monthly.

---

## BSA-16 — Independent Testing {#bsa-16-independent-testing}

**WHY (Reg cite):** [12 CFR § 748.2](https://www.ecfr.gov/current/title-12/section-748.2) requires independent testing of the BSA program. [31 CFR § 1020.210](https://www.ecfr.gov/current/title-31/section-1020.210) requires independent testing as a program pillar. FFIEC BSA/AML Examination Manual defines the scope of independent testing (program integrity, risk assessment, reporting/recordkeeping, CIP, CDD, transaction testing, training, SAR process, monitoring systems, MIS, prior-finding remediation).

**SYSTEM BEHAVIOR:** An independent, qualified auditor (internal audit function or qualified external auditor) conducts a risk-based BSA program evaluation every 12–18 months. The audit scope is mapped to all BSA controls in this policy. Auditors report directly to the Board or Audit Committee. Findings are tracked to closure in a remediation register (`deficiency.severity`, `deficiency.owner_id`, `deficiency.plan_timer`). The BSA Officer provides all examination and audit reports to the Compliance Committee, including responses and corrective actions. The `audit` object tracks `audit.cycle_timer`, `audit.engagement_scope`, `audit.report_id`, `audit.remediation_due`, and `audit.findings_routed_to_board`. Internal BSA Officer reviews of specific areas supplement but do not replace independent testing. Auditors have read access to all BSA records; write access to audit findings is restricted to the audit function.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Independent testing cycle due (`audit.cycle_timer`) | Engagement scope (`audit.engagement_scope`), prior findings (`audit.records`), FFIEC examination manual guidelines | Audit engagement started (`audit.engagement.started`); fieldwork completed (`audit.fieldwork.completed`) | Every 12–18 months; enforced by `audit.cycle_timer` |
| Audit report issued (`audit.report.issued`) | Findings, ratings, management responses | Report issued to Board/Audit Committee (`audit.report.issued`); findings routed to Board (`audit.findings_routed_to_board`) | Within agreed engagement timeline |
| Finding remediation due (`audit.remediation_due`) | Corrective action plan, evidence of remediation | Finding closed (`audit.finding.closed`) or reopened if insufficient | Per finding-specific deadline; enforced by `audit.remediation_timer` |

**ALERTS/METRICS:** Alert if `audit.cycle_timer` fires without an `audit.engagement.started` event. Track % of findings closed by target date (target ≥90%). Alert on any critical finding open beyond 90 days.

---

## BSA-17 — High-Risk Categories (MSB, Correspondent, Private Banking) {#bsa-17-high-risk-categories-msb-correspondent-private-banking}

**WHY (Reg cite):** [31 CFR § 1020.210](https://www.ecfr.gov/current/title-31/section-1020.210) requires risk-based CDD calibrated to customer risk. FFIEC BSA/AML Examination Manual provides specific examination procedures for MSBs (FinCEN registration verification, state licensing, agent status), foreign correspondent accounts, and private banking accounts for non-US persons. [12 CFR § 748.2](https://www.ecfr.gov/current/title-12/section-748.2) requires controls appropriate to the credit union's risk profile.

**SYSTEM BEHAVIOR:** High-risk category playbooks (EDD checklists) are maintained for MSBs, non-bank financial institutions, cash-intensive businesses, professional service providers, NGOs/charities, nonresident aliens, foreign individuals, and brokered deposits. For MSBs, the system verifies FinCEN registration (`edd.msb_registration_number`) and applicable state licenses before account opening and at each annual EDD refresh. Site visits are documented (`edd.site_visit_report`) for applicable categories. EDD is refreshed at least annually for all high-risk category accounts. The `edd_file` object tracks `edd_file.category_checklist`, `edd_file.msb_registration_number`, `edd_file.site_visit_report`, `edd_file.source_of_wealth`, and `edd_file.approver_id`. Senior management approval is required for establishing relationships with high-risk category customers. The credit union does not open accounts for entities on the prohibited list (e.g., unlawful internet gambling, marijuana-related businesses, virtual currency exchangers) per internal risk appetite.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| High-risk category account application submitted (`application.submitted`) | Category checklist (`edd.category_checklist`), MSB registration number if applicable (`edd.msb_registration_number`), state license verification, site visit report (`edd.site_visit_report`), source of wealth (`edd.source_of_wealth`), senior approval (`edd.approver_id`) | EDD completed (`edd.completed`); category approved (`edd.category.approved`) | Before account activation |
| Annual EDD refresh due (`edd.refresh_due`) | Updated category checklist, re-verified MSB registration/licenses, updated site visit if applicable | EDD refresh completed (`edd.refresh.completed`) | Annually; enforced by `edd.refresh_due` |
| MSB registration or license lapse detected | Registration/license status check | EDD refresh triggered; account restriction considered | Within 5 business days of detection |

**ALERTS/METRICS:** Alert if any high-risk category account reaches its `edd.refresh_due` date without a completed `edd.refresh.completed` event. Track % of MSB accounts with verified FinCEN registration (target 100%). Alert on any site-visit requirement overdue.

---

## BSA-18 — PEP Screening & EDD {#bsa-18-pep-screening--edd}

**WHY (Reg cite):** [31 CFR § 1020.210](https://www.ecfr.gov/current/title-31/section-1020.210) requires risk-based EDD for higher-risk customers. FFIEC BSA/AML Examination Manual identifies politically exposed persons (current or former senior foreign political figures, their immediate family, and close associates) as a high-risk category requiring EDD, senior management approval, source-of-wealth determination, and enhanced monitoring. There is no categorical prohibition on PEP relationships; risk-based assessment governs.

**SYSTEM BEHAVIOR:** All applicants, beneficial owners, and authorized signers are screened against PEP datasets at onboarding and at each periodic refresh. PEP hits are routed to EDD (`edd.pep.opened`) with elevated approval requirements (senior management sign-off, `edd.approver_id`). For high-risk PEPs, EDD must be completed before account activation. The EDD file captures PEP status (`pep.status`, `pep.subject_role`), source of wealth (`edd.source_of_wealth`), source of funds (`cdd.source_of_funds`), countries of residence and corruption-risk assessment, purpose and expected volume of account activity, and enhanced monitoring cadence. The `pep` object tracks `pep.status`, `pep.subject_role`, and `pep.refresh.completed`. Monitoring is adjusted upward for confirmed PEP relationships. The `verification` object tracks `verification.pep` result. PEP data is restricted to Compliance and the BSA Officer.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Applicant/BO/signer submitted for screening (`verification.created`) | Subject identifiers (`entity.name`, `entity.date_of_birth`, `entity.address`), PEP dataset version | PEP screened; hit detected (`pep.hit`) or cleared | Pre-account activation |
| PEP hit detected (`pep.hit`) | PEP status (`pep.status`), subject role (`pep.subject_role`), source of wealth (`edd.source_of_wealth`), countries of residence, corruption-risk assessment | EDD opened (`edd.pep.opened`); senior approval required (`edd.approver_id`) | EDD opened same business day; completed before activation for high-risk PEPs |
| PEP designated and EDD approved (`pep.designated`) | Completed EDD file, monitoring cadence set | EDD completed (`edd.pep.completed`); enhanced monitoring activated | Before account activation for high-risk PEPs |
| Periodic PEP refresh due (`pep.refresh.completed`) | Updated PEP dataset screen, refreshed source-of-wealth and activity review | PEP refresh completed (`pep.refresh.completed`); EDD refresh if status changed | Per risk tier; at minimum annually for confirmed PEPs |

**ALERTS/METRICS:** Alert if any `pep.hit` event is not followed by an `edd.pep.opened` event within 1 business day. Alert if a high-risk PEP account is activated without a completed `edd.pep.completed` event. Track PEP refresh compliance rate annually.

---

## BSA-19 — FinCEN Special Measures & GTOs {#bsa-19-fincen-special-measures--gtos}

**WHY (Reg cite):** USA PATRIOT Act § 311 (codified at [31 USC § 5318A](https://www.law.cornell.edu/uscode/text/31/5318A)) authorizes the Secretary of the Treasury to impose special measures on jurisdictions, financial institutions, or transactions of primary money-laundering concern. Geographic Targeting Orders (GTOs) are issued under [31 USC § 5326](https://www.law.cornell.edu/uscode/text/31/5326). Both impose recordkeeping and/or reporting obligations with specific deadlines. [31 CFR § 1010.430](https://www.ecfr.gov/current/title-31/section-1010.430) sets the 5-year baseline retention for GTO compliance records.

**SYSTEM BEHAVIOR:** The BSA Officer is the designated intake owner for all FinCEN special measures and GTOs. Upon receipt, the BSA Officer assesses applicability and circulates to affected business lines within 1 business day (`regulatory.correspondence.received`). Required recordkeeping or reporting is implemented by the GTO-specified deadline. GTO compliance records are retained 5 years. The `regulatory` object tracks `regulatory.change_identified`, `regulatory.change_analysis`, `regulatory.change_required`, `regulatory.change_implemented`, and `regulatory.analysis_due_at`. The `record` object tracks retention for GTO compliance records (`record.retention_expires_at`). The BSA Officer maintains a documented process for receiving, assessing, and operationalizing special measures and GTOs. Write access to the GTO compliance process is restricted to the BSA Officer and Compliance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| FinCEN special measure or GTO received (`regulatory.correspondence.received`) | Order text, applicability assessment (`regulatory.change_analysis`), affected business lines | Change identified (`regulatory.change_identified`); circulated to affected business lines | Within 1 business day of receipt; enforced by `regulatory.analysis_due_at` |
| GTO implementation required (`regulatory.change_required`) | Required recordkeeping/reporting specifications, GTO deadline | Change implemented (`regulatory.change_implemented`); compliance records created (`record.created`) | By GTO-specified deadline |
| GTO compliance record retention expires | Record creation date + 5 years | Retention purge executed (`retention.purge.executed`) | 5 years from record creation; enforced by `record.retention_expires_at` |

**ALERTS/METRICS:** Alert if a received GTO is not circulated to affected business lines within 1 business day. Alert if GTO implementation deadline is within 3 business days without a `regulatory.change_implemented` event. Track all active special measures and GTOs in the BSA risk register.

---

## BSA-20 — Prepaid Access & Third-Party Vendors {#bsa-20-prepaid-access--third-party-vendors}

**WHY (Reg cite):** [12 CFR § 748.2](https://www.ecfr.gov/current/title-12/section-748.2) requires the credit union to retain accountability for BSA functions performed by third parties. Interagency Third-Party Risk Management guidance defines life-cycle controls (planning, due diligence, contracting, ongoing monitoring, termination). [31 CFR § 1020.210](https://www.ecfr.gov/current/title-31/section-1020.210) requires that outsourced AML/CFT screening functions meet the same standards as internally performed functions.

**SYSTEM BEHAVIOR:** All vendors performing BSA-relevant functions (AML/CFT screening, CIP/KYC, sanctions screening, prepaid access program management) are subject to a vendor due-diligence package (`vendor.dd_package`) before engagement and annual review (`vendor.annual_review_due`). Contracts must include clauses for data access, audit rights, sanctions compliance, and incident notification compatible with regulatory timelines (`vendor.contract_clauses`). System program limits for prepaid access products are set and monitored. Real-time critical vendor alerts are integrated into transaction monitoring (`vendor.monitoring_alert`). The `vendor` object tracks `vendor.bsa_role_flag`, `vendor.bsa_function_scope`, `vendor.bsa_responsibility_split`, `vendor.contract_clauses`, `vendor.annual_review_due`, and `vendor.monitoring_alert`. Vendor Management edits the vendor register; Compliance and the Board have read access. The BSA Officer approves all BSA-function vendor engagements.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| New BSA-function vendor proposed (`vendor.proposed`) | Due-diligence package (`vendor.dd_package`), contract clauses (`vendor.contract_clauses`), BSA function scope (`vendor.bsa_function_scope`), responsibility split (`vendor.bsa_responsibility_split`) | Vendor due diligence completed (`vendor.diligence.completed`); BSA role flagged (`vendor.bsa_role.flagged`); contract submitted (`vendor.contract.submitted`) | Before vendor go-live |
| Annual vendor review due (`vendor.annual_review_due`) | Updated due-diligence package, performance metrics, contract clause review, efficacy results (`vendor_review.efficacy_results`) | Annual vendor review completed (`vendor.review.completed`); board report delivered if material issues | Annually; enforced by `vendor.annual_review_due` |
| Critical vendor alert received (`vendor.critical.alert`) | Alert details (`vendor_alert.alert_details`), impact scope (`vendor_alert.impact_scope`) | Alert routed to transaction monitoring; incident opened if warranted (`vendor.incident.logged`) | Real-time; triage within 1 business day |

**ALERTS/METRICS:** Alert if `vendor.annual_review_due` fires without a `vendor.review.completed` event. Alert on any critical vendor alert not triaged within 1 business day. Track % of BSA-function vendors with current due-diligence packages (target 100%).

---

## BSA-21 — Record Retention {#bsa-21-record-retention}

**WHY (Reg cite):** [31 CFR § 1010.430](https://www.ecfr.gov/current/title-31/section-1010.430) sets a 5-year baseline retention for BSA records. [31 CFR § 1020.220](https://www.ecfr.gov/current/title-31/section-1020.220) requires CIP identity records to be retained 5 years after account closure and verification records 5 years after made. [31 CFR § 1010.230](https://www.ecfr.gov/current/title-31/section-1010.230) requires BO records to be retained 5 years after account closure. OFAC record retention is 10 years effective March 12, 2025 (blocked property: 10 years after unblocking; rejected transactions: 10 years after the transaction). SAR records are retained 5 years from filing date per [31 CFR § 1020.320](https://www.ecfr.gov/current/title-31/section-1020.320).

**SYSTEM BEHAVIOR:** The `record` object manages retention for all BSA record types using `record.retention_anchor`, `record.retention_class`, and `record.retention_expires_at`. Retention schedules by record type: CIP identity records — 5 years after account closure; CIP verification records — 5 years after made; BO records — 5 years after account closure; CTR records — 5 years from report date; SAR records and supporting documents — 5 years from filing date; MI log records — 5 years; wire transfer records — 5 years; CMIR records — 5 years; OFAC blocked/rejected records — 10 years after unblocking/transaction date. Records are stored in immutable, searchable storage indexed to member ID and retrievable by originator/beneficiary name or account number for wire records. Write access to retention schedules is restricted to Compliance and Records Management. Hold/destruction lifecycle mechanics after clock-setting are governed by [SC-02](#sc-02-record-retention-lifecycle-mechanics) embedded in this policy.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Account closed (`account.closed`) | Member ID (`member.id`), closure date, CIP and BO record references | Retention timer set for CIP identity records (5 years post-closure) and BO records (5 years post-closure) (`record.retention_clock_set`) | At account closure |
| BSA record created (CTR filed, SAR filed, MI log entry, wire record, CMIR filed) | Record type, creation/filing date | Retention timer set per schedule (`record.retention_clock_set`); retention anchor recorded (`record.retention_anchor`) | At record creation |

**ALERTS/METRICS:** Track retrieval success rate for examiner requests (target: 100% within 1 business day of request). Hold, destruction, and permanent-record alerts are governed by [SC-02](#sc-02-record-retention-lifecycle-mechanics).

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

## Governance & Sign-Off {#governance}

- **Owner:** Patrick Wilson, Chief Compliance Officer
- **Approvers:** Patrick Wilson, Chief Compliance Officer
- **Review Cadence:** Annual Board approval; interim review within 30 days of a material change (regulatory amendment, new product/channel, or significant risk-profile shift).
- **Reporting:** Monthly BSA activity report to the Board (CTR/SAR counts, exemption status, cash-activity changes, regulatory updates, law-enforcement requests, OFAC hits, wire activity, training status, MI log review). Annual risk assessment results to the Board.
- **Cross-References:**
  - Information Security Policy (cyber incident response, system safeguards)
  - Third-Party Risk Policy (general vendor onboarding and oversight)
  - Privacy Policy (member data handling)
  - Record Retention Policy (general records management schedules)
  - Electronic Payment Systems Policy (payment-rail operational controls)
  - NCUA Examination Manual and FFIEC BSA/AML Examination Manual (supervisory guidance)

---

## Assumptions & Gaps {#assumptions}

- **Engineering vocabulary is provisional.** Several field and event codes referenced throughout this policy are not yet confirmed as registered in `core-vocabulary.json` for the BSA/lending domain. Codes used follow the Composition grammar (registered object + registered property + registered action) and the provisional-code list where applicable. Specific provisional codes used include: `cmir.amount`, `cmir.counterparty`, `cmir.direction`, `cmir.shipment_manifest`, `fbar.account_record`, `fbar.authority_type`, `fincen.counterpart_registration`, `fincen.request_scope`, `mi.amount`, `mi.central_log`, `mi.instrument_type`, `mi.purchaser_id_number`, `pep.status`, `pep.subject_role`, `edd.file`, `sar.filing_id`, `escalation.description`, `escalation.owner_id`, `escalation.regulatory_assessment`. All codes will be confirmed with engineering before the next policy review.

- **Risk tier refresh frequencies.** The specific refresh cadences for CDD profiles by risk tier (assumed: high = 12 months, medium = 24 months, low = 36 months) are placeholders pending Board approval of the risk appetite statement. These must be confirmed and documented in the risk assessment.

- **EDD trigger thresholds.** Specific volume/transaction thresholds that trigger EDD (e.g., rolling 30-day transaction volume) are not defined in this policy and must be set in the BSA risk assessment and monitoring system configuration. They are referenced as configurable parameters.

- **Prohibited account categories.** The list of account types the credit union will not open (e.g., marijuana-related businesses, virtual currency exchangers, unlawful internet gambling) is stated as a risk-appetite decision. The Board should formally ratify this list as part of the annual policy approval.

- **HMDA reporter status.** This policy does not address HMDA reporting obligations. If Pynthia Credit Union is a HMDA reporter, a separate HMDA/Reg C control framework is required.

- **Foreign correspondent and private banking accounts.** Patrick's notes indicate these are currently not offered. If the credit union begins offering these products, BSA-17 must be expanded with specific correspondent-account and private-banking EDD procedures per FFIEC guidance and 31 USC § 5318(i) and (j).

- **Prepaid access program specifics.** BSA-20 references prepaid access program limits and vendor controls generically. Specific program limits, velocity controls, and vendor names must be documented in the vendor register and system configuration before any prepaid product launch.

- **314(b) registration status.** The reference policy indicated the credit union was not registered for 314(b) at the time of drafting. BSA-11 assumes current registration. If not currently registered, the BSA Officer should assess whether registration is appropriate given the credit union's risk profile and implement procedures before activating 314(b) sharing.

- **OFAC 10-year retention effective date.** The 10-year OFAC record retention requirement is stated as effective March 12, 2025. Records created before that date may be subject to the prior 5-year schedule. Legal counsel should confirm the transition rule and update the retention schedule accordingly.

- **Board-only approver.** The OWNER & APPROVERS input lists only Patrick Wilson as both owner and approver. For segregation-of-duties purposes, the Board of Directors (not the BSA Officer) should be the formal approver of the BSA policy. This document reflects the BSA Officer as the policy owner/administrator; Board approval should be evidenced by Board resolution and minutes.
