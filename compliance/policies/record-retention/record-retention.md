```yaml
---
title: Record Retention Policy (Table-First, Design-Overlay v3)
owner: Patrick Wilson, Chief Compliance Officer
version: v1.0
effective: 2025-07-01
next_review: 2026-07-01
approvers:
  - Patrick Wilson, Chief Compliance Officer
tags: [Compliance, Record Retention, Records Management, BSA, CPRA, Destruction]
---
```

## General Policy Statement

Pynthia Credit Union maintains a comprehensive record-retention and destruction program that establishes minimum retention periods for all record classes, provides for the systematic and defensible disposal of obsolete records, and ensures records can be promptly produced for examiners, auditors, and legal proceedings. The program applies to all Pynthia directors, officers, and employees and to records in any form — paper, imaged, microform, or electronic media — including records held by the core processor and email archives. Retention periods reflect the longer of applicable federal minimums (BSA 5 years, Reg B 25 months, Reg Z 3 years, Reg CC/Reg E 2 years, ERISA 6 years), California Financial Code overlays, and Pynthia's conservative administrative defaults. Consumer transaction records subject to 2-year (Reg CC, Reg E) and 25-month (Reg B) minimums are retained on a unified 3-year schedule for consistent administration. The program is governed by the Chief Compliance Officer, with the SVP of Operations & Finance, department records-retention contacts, IT, and Internal Audit as required participants. Alabama Banking Code schedules are not applicable and are excluded.

---

## Timing Matrix {#timing-matrix}

| Scenario | Trigger (human → event) | Deadline | Content Reference | Control |
|---|---|---:|---|---|
| New record created or received | Record created/received → `record.created` | Same business day | Assign retention class and set clock | [RR-01](#rr-01-retention-schedule-and-clock-setting) |
| Destruction date reached | Retention clock expires → `record.retention.expired` | After documented destruction date; no premature destruction | Destruction log, vendor certificate | [RR-03](#rr-03-document-destruction) |
| Destruction log entry | Records placed for destruction → `destruction_log.entry.created` | At time of destruction | Exhibit 1 Destruction Log; two-person initials | [RR-04](#rr-04-destruction-logging-and-storage-labeling) |
| Legal hold placed | Litigation/investigation/subpoena identified → `legal_hold.created` | Immediately upon notice | Hold scope, matter ID | [RR-05](#rr-05-legal-holds) |
| Legal hold released | Matter resolved → `legal_hold.clear.confirmed` | Upon written authorization | Hold release record; schedule resumed | [RR-05](#rr-05-legal-holds) |
| Core processor retention confirmed | Annual review cycle → `core_archive.retention.confirmed` | Annually | Core archive retention config | [RR-06](#rr-06-core-processor-and-email-archive-retention) |
| Email archive retrievability tested | Periodic IT test → `email_archive.test.completed` | Periodically (at least annually) | Test results | [RR-06](#rr-06-core-processor-and-email-archive-retention) |
| BSA/AML 5-year period expires | BSA retention clock expires → `record.retention.expired` | At 5-year mark | Anonymization or destruction documented | [RR-07](#rr-07-bsaaml-anonymization-and-extended-analytical-retention) |
| CDD refresh due (higher-risk) | Annual calendar → `cdd.refresh_due` | Annually | CDD profile, triggering event, disposition of superseded records | [RR-08](#rr-08-cdd-refresh-cycle-and-stale-record-disposition) |
| CDD refresh due (standard-risk) | Biennial calendar → `cdd.refresh_due` | Every 2 years | CDD profile, triggering event, disposition of superseded records | [RR-08](#rr-08-cdd-refresh-cycle-and-stale-record-disposition) |
| CDD refresh triggered by new product | New product/service added → `cdd.profile.refreshed` | At time of new product/service | CDD profile, triggering event | [RR-08](#rr-08-cdd-refresh-cycle-and-stale-record-disposition) |
| Annual policy and Schedule A review | Annual calendar → `records.policy_review.completed` | At least annually | Policy, Schedule A, regulatory change log | [RR-09](#rr-09-annual-policy-and-schedule-review) |
| Annual training cycle | Annual calendar → `training.annual_cycle.opened` | Annually | Training completion records | [RR-10](#rr-10-training) |
| Permanent-record inventory confirmed | Annual review → `records.board_report.filed` | Annually | Permanent-record inventory in Schedule A | [RR-11](#rr-11-permanent-record-governance) |

---

## RR-01 — Retention Schedule and Clock Setting {#rr-01-retention-schedule-and-clock-setting}

**WHY (Reg cite):** Federal and California law require records to be retained for defined minimum periods keyed to specific triggering events. Applicable authorities include: [BSA 31 CFR §1010.430](https://www.ecfr.gov/current/title-31/subtitle-B/chapter-X/part-1010/subpart-D/section-1010.430) (5 years); [Reg B/ECOA 12 CFR §1002.12](https://www.ecfr.gov/current/title-12/section-1002.12) (25 months); [Reg Z/TILA 12 CFR §1026.25](https://www.ecfr.gov/current/title-12/section-1026.25) (3 years after disclosure); [Reg CC 12 CFR §229.21](https://www.ecfr.gov/current/title-12/section-229.21) (2 years); [Reg E 12 CFR §1005.13](https://www.ecfr.gov/current/title-12/section-1005.13) (2 years); [HMDA/Reg C 12 CFR §1003.5](https://www.ecfr.gov/current/title-12/section-1003.5); [ERISA 29 U.S.C. §1027](https://www.law.cornell.edu/uscode/text/29/1027) (6 years); IRS 6-year underreporting SOL; California FTB 4-year SOL; [FFIEC Third-Party Risk Management Guidance](https://www.federalregister.gov/documents/2023/06/09/2023-12340/interagency-guidance-on-third-party-relationships-risk-management) (life of agreement plus 3 years); [12 CFR Part 364 App. B](https://www.ecfr.gov/current/title-12/part-364#Appendix-B-to-Part-364) (information security standards for destruction).

**SYSTEM BEHAVIOR:** When a record is created or received, the system assigns a retention class from Schedule A (`schedule_a.retention_period`), identifies the triggering anchor event (`record.retention_anchor`), and sets the retention expiry clock (`record.retention_expires_at`). Records not explicitly listed in Schedule A that are substantially similar to a listed item inherit the applicable period; the department records-retention contact documents the inheritance in the `schedule_a.entry_inherited` field. Consumer transaction records subject to 2-year (Reg CC, Reg E) and 25-month (Reg B) minimums are assigned to the unified 3-year class. Permanent records receive a destruction date of "Permanent" and are excluded from all automated disposal runs. Schedule A is the authoritative source; the `schedule_a.version` field tracks the current approved version. Write access to Schedule A retention periods is restricted to the SVP of Operations & Finance and the Chief Compliance Officer.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Record created or received (`record.created`) | Record type (`record.class`), triggering anchor event (`record.retention_anchor`), media type (`record.media_type`), subject reference (`record.subject_ref`) | Retention class assigned, expiry clock set (`record.retention_clock_set`); `record.retention_expires_at` populated | Same business day (internal: same BD; enforced by `record.retention_expires_at`) |
| Record class not matched to Schedule A entry (`record_class.unmatched`) | Record description, closest Schedule A analog (`schedule_a.analog_entry_id`), department contact attestation | Inherited entry documented (`schedule_a.entry_inherited`); `schedule_a.entry.added` if new class warranted | Within 5 BD of identification |
| Schedule A version updated (`schedule_a.entry.amended`) | Amended retention period (`schedule_a.retention_period`), version (`schedule_a.version`), approver | Updated Schedule A published; `records.policy_review.completed` | At time of amendment; annual review per [RR-09](#rr-09-annual-policy-and-schedule-review) |

**ALERTS/METRICS:** Alert when any record is created without a retention class assigned within 1 BD (target: zero unclassified records at end of day). Dashboard metric: count of `record_class.unmatched` events per week; target trend to zero within 30 days of any Schedule A update.

---

## RR-02 — Retention Methods and Electronic-Record Integrity {#rr-02-retention-methods-and-electronic-record-integrity}

**WHY (Reg cite):** [12 CFR Part 364 App. B](https://www.ecfr.gov/current/title-12/part-364#Appendix-B-to-Part-364) requires administrative, technical, and physical safeguards to protect the security, confidentiality, and integrity of customer information, including records retained in electronic form. Examiners must be able to determine a financial institution's financial condition and the substance of all transactions from retained electronic records.

**SYSTEM BEHAVIOR:** Records may be retained in any reproducible form — hard copy, imaging, microform, or electronic media — provided the medium can be readily reproduced into a legible paper copy. Electronic records must remain accurate, accessible, and of sufficient integrity for examiners to determine financial condition and the substance of transactions. The system tracks the storage medium (`record.storage_medium`) and media type (`record.media_type`) for each record. When a record is converted from one medium to another (e.g., paper to image), the conversion is certified and logged (`record.conversion.certified`), and the original medium may be destroyed only after certification. Integrity tests are scheduled periodically (`record.integrity_test_due`) and results logged (`record.integrity_test.completed`). Write access to integrity-test scheduling is restricted to IT and the department records-retention contact.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Record converted to new medium (`record.media_converted`) | Original medium, target medium (`record.media_type`), conversion method, certifying officer | Conversion certified (`record.conversion.certified`); original destruction authorized only post-certification | At time of conversion |
| Periodic integrity test due (`record.integrity_test_due`) | Record population sample, storage system access, test criteria | Test result logged (`record.integrity_test.completed`); failures escalated to IT and SVP Operations & Finance | Annually at minimum (internal: per IT schedule; enforced by `record.integrity_test_due`) |
| Integrity test failure detected (`record.integrity_test.completed` with failure) | Failure scope (`record.reproduction_result`), affected record IDs, remediation plan | Escalation to SVP Operations & Finance and CCO; remediation tracked as `finding.opened` | Within 2 BD of detection |

**ALERTS/METRICS:** Alert on any integrity test failure within 1 BD; target zero unresolved integrity failures older than 5 BD. Monitor count of records with `record.storage_medium` = null; target zero.

---

## RR-03 — Document Destruction {#rr-03-document-destruction}

**WHY (Reg cite):** [12 CFR Part 364 App. B](https://www.ecfr.gov/current/title-12/part-364#Appendix-B-to-Part-364) requires that destruction of customer-information records be conducted in accordance with information security standards. Records must not be destroyed before the documented destruction date; premature destruction eliminates the ability to demonstrate compliance and defend claims.

**SYSTEM BEHAVIOR:** Records become eligible for disposal only after `record.disposal_eligible` is set to true, which requires that (a) `record.retention_expires_at` has passed, (b) `record.hold_status` is clear (no active legal hold), and (c) the department records-retention contact has confirmed the record is not subject to any pending regulatory inquiry. Destruction is executed by a licensed destruction vendor in accordance with [12 CFR Part 364 App. B](https://www.ecfr.gov/current/title-12/part-364#Appendix-B-to-Part-364). Two verifying associates must initial the Destruction Log (Exhibit 1) before destruction proceeds. The vendor's destruction certificate is attached to the log entry (`disposal.certificate`). Permanent records (destruction date = "Permanent") are excluded from all disposal runs by system enforcement; any attempt to queue a permanent record for disposal generates an alert. Write access to `record.disposal_eligible` is restricted to the department records-retention contact with SVP Operations & Finance countersignature for batches exceeding 500 records.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Retention period expires and no hold active (`record.retention.expired`) | `record.retention_expires_at`, `record.hold_status` = clear, `record.disposal_eligible` = true, department contact confirmation | Record queued for disposal (`disposal.scheduled`); destruction log entry initiated (`destruction_log.entry.created`) | At a reasonable time after documented destruction date (internal: within 30 days of eligibility) |
| Destruction executed by licensed vendor (`disposal.executed`) | Vendor identity, batch manifest (`disposal.batch_manifest_id`), two-associate initials on Destruction Log, vendor destruction certificate (`disposal.certificate`) | Destruction certified (`record.destruction.certified`); `record.destroyed` logged; certificate attached to `destruction_log.entry_id` | At time of destruction |
| Permanent record queued for disposal (system block) | `record.retention_class` = "Permanent", attempted disposal action | Disposal blocked; alert issued to SVP Operations & Finance and CCO; `destruction_log.mismatch.detected` | Immediately upon detection |

**ALERTS/METRICS:** Alert immediately on any attempt to destroy a permanent record (target: zero successful permanent-record destructions). Alert when eligible records remain undestroyed more than 60 days past `record.retention_expires_at`. Monitor vendor certificate attachment rate; target 100% of destruction events have `disposal.certificate` attached within 5 BD.

---

## RR-04 — Destruction Logging and Storage Labeling {#rr-04-destruction-logging-and-storage-labeling}

**WHY (Reg cite):** [12 CFR Part 364 App. B](https://www.ecfr.gov/current/title-12/part-364#Appendix-B-to-Part-364) requires documented, auditable destruction processes. Examiners must be able to review destruction logs to confirm records were retained for required periods and destroyed appropriately.

**SYSTEM BEHAVIOR:** Each department maintains a Destruction Log (Exhibit 1) keyed to `destruction_log.entry_id`. The log is available for review by internal and external examiners. Physical storage boxes are labeled with the four required fields — Box Number (`storage_box.number`), Content Description (`storage_box.description`), From/To Dates (`storage_box.from_date` / `storage_box.to_date`), and Destruction Date (`storage_box.destruction_date`) — and these fields must match the corresponding Destruction Log entry. The system flags any mismatch between box label data and the log (`destruction_log.mismatch`). Department records-retention contacts are responsible for maintaining log accuracy; the SVP of Operations & Finance reviews logs annually. Write access to Destruction Log entries is restricted to the department records-retention contact; read access is available to examiners, Internal Audit, and the CCO.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Records placed in storage box (`storage_box.created`) | Box number (`storage_box.number`), content description (`storage_box.description`), from/to dates (`storage_box.from_date`, `storage_box.to_date`), destruction date (`storage_box.destruction_date`) | Storage box record created; label fields validated against Destruction Log (`destruction_log.entry_id`) | At time of boxing |
| Mismatch detected between box label and Destruction Log (`destruction_log.mismatch.detected`) | Box number, log entry ID (`destruction_log.entry_id`), discrepant fields | Mismatch alert issued to department contact and SVP Operations & Finance; `destruction_log.mismatch.detected` logged | Within 1 BD of detection |
| Mismatch resolved (`destruction_log.mismatch.resolved`) | Corrected label or log entry, authorizing contact | Resolution logged (`destruction_log.mismatch.resolved`) | Within 5 BD of detection |
| Annual log review by SVP Operations & Finance (`records.annual_review_due_at`) | All department Destruction Logs, `destruction_log.entry_id` completeness check | Annual review completed (`records.policy_review.completed`); gaps reported to Board | Annually (enforced by `records.annual_review_due_at`) |

**ALERTS/METRICS:** Alert on any `destruction_log.mismatch.detected` within 1 BD; target zero unresolved mismatches older than 5 BD. Monitor completeness of Destruction Log entries (all four label fields populated); target 100%.

---

## RR-05 — Legal Holds {#rr-05-legal-holds}

**WHY (Reg cite):** Failure to suspend destruction upon notice of litigation, investigation, or subpoena constitutes spoliation and may result in sanctions, adverse inference instructions, and regulatory penalties. The obligation arises under common law and is reinforced by [12 CFR Part 364 App. B](https://www.ecfr.gov/current/title-12/part-364#Appendix-B-to-Part-364) and applicable California civil procedure rules.

**SYSTEM BEHAVIOR:** Upon notice of litigation, regulatory investigation, or subpoena, the CCO or General Counsel places a legal hold via the `legal_hold` object, specifying the hold scope (`legal_hold.hold_scope`) and matter reference (`legal_hold.matter_ref`). The system immediately sets `record.hold_status` = active and `record.legal_hold_flag` = true for all records within scope, blocking any disposal action. Scheduled destruction for in-scope records is suspended (`disposal.held`) until the hold is released. Hold release requires written authorization from the CCO or General Counsel (`legal_hold.release_approved_by`), after which `legal_hold.schedule_resumed` is set and the retention clock resumes from the point of suspension. Records that were already past their destruction date at the time of hold placement are retained until the hold is released, then destroyed promptly. Write access to legal hold placement and release is restricted to the CCO and General Counsel.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Litigation, investigation, or subpoena identified (`legal_hold.created`) | Matter ID (`legal_hold.matter_id`), hold scope (`legal_hold.hold_scope`), placed-at timestamp (`legal_hold.placed_at`), authorizing officer | Legal hold placed (`legal.hold.placed`); all in-scope records flagged (`record.hold.placed`); disposal suspended (`disposal.held`) | Immediately upon notice |
| Hold scope updated (additional records identified) (`record.hold.applied`) | Updated scope, matter ID, authorizing officer | Scope update logged (`record.hold.applied`); additional records flagged | Within 1 BD of identification |
| Hold released (`legal_hold.clear.confirmed`) | Release authorization (`legal_hold.release_approved_by`), released-at timestamp (`legal_hold.released_at`), matter resolution basis | Hold released (`legal.hold.released`); `record.hold.released` for all in-scope records; `legal_hold.schedule_resumed` set; disposal clock resumed (`disposal.clock_resumed`) | Upon written authorization from CCO or General Counsel |

**ALERTS/METRICS:** Alert if any record subject to an active legal hold (`record.legal_hold_flag` = true) is queued for disposal (target: zero). Monitor count of active legal holds and age; escalate to CCO any hold open more than 3 years without a status update. Alert within 1 BD if a hold release is processed without `legal_hold.release_approved_by` populated.

---

## RR-06 — Core Processor and Email Archive Retention {#rr-06-core-processor-and-email-archive-retention}

**WHY (Reg cite):** [12 CFR Part 364 App. B](https://www.ecfr.gov/current/title-12/part-364#Appendix-B-to-Part-364) requires that safeguards for customer information extend to records held by service providers. BSA recordkeeping obligations under [31 CFR §1010.430](https://www.ecfr.gov/current/title-31/subtitle-B/chapter-X/part-1010/subpart-D/section-1010.430) apply regardless of the medium or custodian.

**SYSTEM BEHAVIOR:** Each department is accountable for confirming that retention timeframes for records maintained on the core processor's electronic archive are correctly configured and match Schedule A. This confirmation is documented annually in `core_archive.retention_config` and logged as `core_archive.retention.confirmed`. IT is responsible for email archives: retention timeframes must be configured to match Schedule A, and retrievability must be tested periodically (at least annually) by attempting to retrieve a sample of archived emails and confirming they are accessible and legible. Test results are logged as `email_archive.test.completed`. Failures trigger immediate escalation to the CCO and SVP Operations & Finance. Write access to core archive retention configuration is restricted to IT with department contact countersignature; email archive configuration is restricted to IT.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual core archive retention review due (`core_archive.confirmation_due`) | Department-by-department confirmation that archive retention settings match Schedule A (`core_archive.retention_config`), department contact attestation | Retention confirmed (`core_archive.retention.confirmed`); gaps escalated to SVP Operations & Finance | Annually (enforced by `core_archive.confirmation_due`) |
| Email archive retrievability test due (`email_archive.test_due`) | Sample of archived emails retrieved, legibility confirmed, test scope documented | Test completed (`email_archive.test.completed`); pass/fail result and sample scope logged | At least annually (enforced by `email_archive.test_due`) |
| Email archive test failure (`email_archive.test.completed` with failure) | Failure scope, affected date ranges, remediation plan | Escalation to CCO and SVP Operations & Finance; remediation tracked as `finding.opened` | Within 1 BD of test completion |

**ALERTS/METRICS:** Alert if `core_archive.confirmation_due` passes without `core_archive.retention.confirmed` logged (target: zero overdue confirmations). Alert on any email archive test failure within 1 BD; target zero unresolved failures older than 5 BD.

---

## RR-07 — BSA/AML Anonymization and Extended Analytical Retention {#rr-07-bsaaml-anonymization-and-extended-analytical-retention}

**WHY (Reg cite):** [31 CFR §1010.430](https://www.ecfr.gov/current/title-31/subtitle-B/chapter-X/part-1010/subpart-D/section-1010.430) requires 5-year retention of BSA/AML records. The California Privacy Rights Act (CPRA) requires that personal information not be retained longer than necessary for the disclosed purpose and imposes de-identification standards for data retained beyond that purpose. Anonymized and aggregated data from which no individual can be identified falls outside CPRA's personal-information definition when de-identification meets the CPRA standard.

**SYSTEM BEHAVIOR:** At the 5-year BSA/AML retention mark, individually identifiable customer information must be either destroyed or anonymized. Anonymization must meet the CPRA de-identification standard: reasonable measures taken to prevent re-identification, and a public commitment not to re-identify. The anonymization process and its completion date are documented in the audit trail (`record.retention_anchor` updated to reflect anonymization event; `record.dispositioned` logged with disposition method). Anonymized and aggregated BSA/AML data — from which no individual can be identified — may be retained beyond 5 years for compliance analytics, trend analysis, and program improvement. Retention of anonymized data must be documented with the anonymization method, the date anonymization occurred, and the analytical purpose. Examiners can confirm the disposition of individually identifiable records by reviewing the audit trail even when older data cannot be traced to specific customers. Write access to anonymization records is restricted to the BSA Officer and CCO.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| BSA/AML 5-year retention period expires (`record.retention.expired` for BSA class) | Record ID, retention class (`record.retention_class` = BSA), individually identifiable fields inventory, anonymization method documentation | Anonymization executed or destruction initiated; disposition logged (`record.disposed` with `record.disposal_method` = "anonymized" or "destroyed"); anonymization date recorded in audit trail | At 5-year mark (enforced by `record.retention_expires_at`) |
| Anonymized BSA/AML data retained for analytics (post-anonymization) | Anonymization method documentation, CPRA de-identification standard attestation, analytical purpose statement, public commitment not to re-identify | Extended retention documented; `record.retained` logged with purpose and anonymization date; `record.retention_expires_at` updated for anonymized dataset | At time of anonymization decision |
| Examiner requests disposition confirmation for BSA records | Examiner request, matter scope | Audit trail exported showing `record.disposed` or `record.retained` with anonymization date for all records in scope | Within timeframe specified by examiner |

**ALERTS/METRICS:** Alert when any BSA/AML record reaches 5 years without a documented disposition decision (target: zero records past 5-year mark without `record.disposed` or anonymization logged). Monitor count of anonymized datasets lacking CPRA de-identification attestation; target zero.

---

## RR-08 — CDD Refresh Cycle and Stale-Record Disposition {#rr-08-cdd-refresh-cycle-and-stale-record-disposition}

**WHY (Reg cite):** FinCEN's Customer Due Diligence Rule ([31 CFR §1010.230](https://www.ecfr.gov/current/title-31/subtitle-B/chapter-X/part-1010/subpart-D/section-1010.230)) requires ongoing CDD and periodic refresh of customer risk profiles. The CPRA requires data minimization — personal information must not be retained beyond what is necessary for the disclosed purpose. Retaining superseded CDD records that have been replaced by updated information is inconsistent with both BSA program integrity and CPRA data minimization obligations.

**SYSTEM BEHAVIOR:** CDD records are refreshed on a rolling basis: at minimum annually for higher-risk customers (`cdd.risk_tier` = high) and every two years for standard-risk customers (`cdd.risk_tier` = standard). A refresh is also triggered upon any new product or service added to a customer relationship. Upon refresh, the BSA department evaluates superseded CDD records: information that has been updated or replaced is destroyed or anonymized (consistent with [RR-07](#rr-07-bsaaml-anonymization-and-extended-analytical-retention)) rather than carried forward. The BSA department documents the refresh date, the triggering event (scheduled review or new product), and the disposition of superseded records in the customer file (`cdd.profile`). Only current, accurate customer information is maintained in the active CDD profile. Write access to CDD refresh records and disposition documentation is restricted to the BSA department.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual CDD refresh due for higher-risk customer (`cdd.refresh_due` for high-risk tier) | Customer ID, `cdd.risk_tier` = high, prior CDD profile (`cdd.profile`), refresh triggering event | CDD profile refreshed (`cdd.profile.refreshed`); superseded records evaluated; disposition documented (destroyed or anonymized per [RR-07](#rr-07-bsaaml-anonymization-and-extended-analytical-retention)); refresh date and trigger logged | Annually (enforced by `cdd.refresh_due`) |
| Biennial CDD refresh due for standard-risk customer (`cdd.refresh_due` for standard-risk tier) | Customer ID, `cdd.risk_tier` = standard, prior CDD profile (`cdd.profile`), refresh triggering event | CDD profile refreshed (`cdd.profile.refreshed`); superseded records evaluated; disposition documented; refresh date and trigger logged | Every 2 years (enforced by `cdd.refresh_due`) |
| New product or service added to customer relationship (`cdd.profile.refreshed` triggered by product event) | Customer ID, new product/service description, prior CDD profile (`cdd.profile`), triggering event = "new product" | CDD profile refreshed (`cdd.profile.refreshed`); superseded records evaluated; disposition documented; triggering event = new product logged | At time of new product/service addition |

**ALERTS/METRICS:** Alert when any higher-risk customer CDD refresh is overdue by more than 30 days (target: zero overdue high-risk refreshes). Alert when any standard-risk customer CDD refresh is overdue by more than 60 days. Monitor count of superseded CDD records without documented disposition; target zero.

---

## RR-09 — Annual Policy and Schedule Review {#rr-09-annual-policy-and-schedule-review}

**WHY (Reg cite):** Sound records management practice and examiner expectations require that retention schedules remain current with applicable law. Changes in [12 CFR Part 1002](https://www.ecfr.gov/current/title-12/part-1002), [12 CFR Part 1003](https://www.ecfr.gov/current/title-12/part-1003), [12 CFR Part 1026](https://www.ecfr.gov/current/title-12/part-1026), [31 CFR §1010.430](https://www.ecfr.gov/current/title-31/subtitle-B/chapter-X/part-1010/subpart-D/section-1010.430), California Financial Code, and CPRA/CPRA regulations may alter minimum retention periods. [NCUA 12 CFR §701.31](https://www.ecfr.gov/current/title-12/part-701/section-701.31) and DFPI charter requirements apply to Pynthia as a California-chartered credit union.

**SYSTEM BEHAVIOR:** The CCO, in coordination with the SVP of Operations & Finance, reviews this policy and Schedule A at least annually. The review considers: changes in state and federal reporting requirements; changes in Pynthia's products and services; changes in overall complexity; changes in consumer compliance requirements; technological advances; and changes in storage costs. Each department records-retention contact reviews their area's Schedule A entries and forwards proposed updates to the SVP of Operations & Finance. Approved revisions are submitted to the Board for approval. The `schedule_a.version` field is incremented upon each approved revision. Write access to the policy document and Schedule A is restricted to the CCO and SVP of Operations & Finance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual review cycle opens (`records.annual_review_due_at`) | Current policy version (`policy.document_version`), current Schedule A version (`schedule_a.version`), regulatory change log (`regulation.retention_change`), department contact inputs | Review initiated; department contacts notified | Annually (enforced by `records.annual_review_due_at`) |
| Regulatory change detected affecting retention period (`regulation.retention_change.detected`) | Regulatory citation, affected record class, new minimum period | Schedule A amendment proposed; `schedule_a.entry.amended` drafted; CCO and SVP Operations & Finance notified | Within 30 days of effective date of regulatory change |
| Policy and Schedule A review completed and approved (`records.policy_review.completed`) | Revised policy, revised Schedule A (`schedule_a.version` incremented), Board approval (`policy.board.approved`) | Policy revision published (`policy.revision.published`); Board approval logged; `records.board_report.filed` | At least annually; Board approval required before new version is effective |

**ALERTS/METRICS:** Alert when `records.annual_review_due_at` passes without `records.policy_review.completed` logged (target: zero overdue annual reviews). Alert within 5 BD of any `regulation.retention_change.detected` event without a corresponding Schedule A amendment in progress.

---

## RR-10 — Training {#rr-10-training}

**WHY (Reg cite):** Effective records management requires that all personnel understand their obligations. Training is a standard examiner expectation under [12 CFR Part 364 App. B](https://www.ecfr.gov/current/title-12/part-364#Appendix-B-to-Part-364) and supports compliance with all retention authorities cited in this policy. Director and employee training records are themselves subject to a 5-year retention period per Schedule A.

**SYSTEM BEHAVIOR:** Annual record-retention training is provided to all Pynthia employees. The Operations department coordinates the annual training cycle; each department records-retention contact develops department-specific training covering that department's Schedule A entries and destruction procedures. Training completion is tracked per employee (`training.completion_status`, `training.assignee_id`). New hires receive training within 30 days of hire. Training records are retained for 5 years per Schedule A. Write access to training completion records is restricted to the Operations department and department records-retention contacts.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual training cycle opens (`training.annual_cycle.opened`) | Employee roster, department-specific curriculum developed by each records-retention contact (`training.curriculum_id`), prior year completion rates | Training assignments created (`training.assignment.created`); all employees assigned | Annually (enforced by `training.annual_due_at`) |
| Employee completes training (`training.completed`) | Employee ID (`training.assignee_id`), module ID (`training.module_id`), completion date, assessment score (`training.assessment_score`) | Completion recorded (`training.completion.recorded`); record retained for 5 years per Schedule A | At time of completion |
| New hire training due (`training.newhire_due_at`) | Employee hire date (`training.hire_date`), new-hire curriculum | Training assigned (`training.assigned`); completion tracked | Within 30 days of hire (enforced by `training.newhire_due_at`) |
| Training completion rate reported to Board (`records.board_report.filed`) | Completion rates by department, outstanding assignments | Board report filed (`records.board_report.filed`) | Annually, as part of annual policy review |

**ALERTS/METRICS:** Alert when any employee's annual training is overdue by more than 30 days (target: 100% completion within annual cycle). Monitor new-hire training completion within 30-day window; target 100%. Alert on any department with completion rate below 90% at 60 days into the annual cycle.

---

## RR-11 — Permanent Record Governance {#rr-11-permanent-record-governance}

**WHY (Reg cite):** Permanent records — including charter documents, Board minutes, General Ledger Daily Statements of Condition, examination reports, and FinCEN 105 Forms — must be retained indefinitely under applicable federal and California law, including [NCUA 12 CFR §701.31](https://www.ecfr.gov/current/title-12/part-701/section-701.31), California Financial Code, and DFPI charter requirements. Loss of permanent records cannot be remediated after the fact.

**SYSTEM BEHAVIOR:** Permanent records are inventoried in Schedule A with a destruction date of "Permanent" (`schedule_a.retention_period` = "Permanent"). The system enforces a hard block preventing any permanent record from being queued for disposal (`record.disposal_eligible` = false, system-enforced for permanent class). The SVP of Operations & Finance confirms the permanent-record inventory annually and reports any gaps to the Board. Permanent records must be stored in a secure and retrievable format; storage location and medium are documented in `record.storage_medium`. The permanent-record inventory includes at minimum: Articles of Incorporation, Charter, Bylaws, DFPI license, NCUA insurance certificate and all amendments; General Ledger Daily Statements of Condition; Board of Directors meeting minutes, board committee minutes, and all supporting packages; stockholder/member meeting minutes; stock or membership share issuance, transfer, and register records; dividend checks and register; Trust Committee and Trust Investment Committee minute books; Reports of Examination by DFPI or NCUA; FinCEN 105 Forms of Exempt Customers; group insurance records; and computer records of all account activity. Write access to the permanent-record inventory is restricted to the SVP of Operations & Finance and CCO.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| New permanent record created or received (`record.created` with `record.retention_class` = "Permanent") | Record type, storage location (`record.storage_medium`), subject reference (`record.subject_ref`) | Permanent record inventoried in Schedule A; `record.retention_expires_at` = null (permanent); `record.disposal_eligible` = false | At time of creation/receipt |
| Annual permanent-record inventory confirmation (`records.annual_review_due_at`) | Full inventory of permanent records in Schedule A, storage location verification, SVP Operations & Finance attestation | Inventory confirmed; gaps (if any) reported to Board (`records.board_report.filed`); `records.policy_review.completed` | Annually (enforced by `records.annual_review_due_at`) |
| Permanent record disposal attempted (system block) | Attempted disposal action, record ID, `record.retention_class` = "Permanent" | Disposal blocked; alert issued to SVP Operations & Finance and CCO; `destruction_log.mismatch.detected` logged | Immediately upon detection |

**ALERTS/METRICS:** Alert immediately on any attempted disposal of a permanent record (target: zero successful permanent-record destructions). Alert if annual permanent-record inventory confirmation is not completed within 30 days of the annual review due date. Monitor count of permanent records without a documented storage location; target zero.

---

## RR-12 — Responsibility and Administration {#rr-12-responsibility-and-administration}

**WHY (Reg cite):** Clear ownership of the records management program is a prerequisite for examiner confidence and is consistent with [12 CFR Part 364 App. B](https://www.ecfr.gov/current/title-12/part-364#Appendix-B-to-Part-364) governance expectations and [NCUA 12 CFR §701.31](https://www.ecfr.gov/current/title-12/part-701/section-701.31) safety and soundness standards.

**SYSTEM BEHAVIOR:** The SVP of Operations & Finance is the designated senior owner responsible for monitoring record retention and destruction activity, maintaining and updating this policy, and reporting to the Board of Directors. Each department designates an employee as that department's records-retention contact (`records.contact_name`), accountable for proper completion of retention in their area. When a records-retention contact role is vacated, the department head must designate a replacement within 10 BD and notify the SVP of Operations & Finance (`records.contact_vacated`). The CCO holds overall governance authority and is the approver for policy changes. The SVP of Operations & Finance, department records-retention contacts, IT, and Internal Audit are required participants in the program. Write access to the records-retention contact registry is restricted to the SVP of Operations & Finance.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Department records-retention contact designated or changed (`records.contacts.assigned`) | Department ID, contact name (`records.contact_name`), effective date, SVP Operations & Finance acknowledgment | Contact assignment logged (`records.contact.assigned`); prior contact record archived | At time of designation or change |
| Records-retention contact role vacated (`records.contact_vacated`) | Department ID, vacating contact, reason for vacancy | Vacancy alert issued to department head and SVP Operations & Finance; replacement designation required | Within 1 BD of vacancy; replacement within 10 BD |
| Annual Board report on records program (`records.board_report.filed`) | Annual review results, training completion rates, destruction log summary, permanent-record inventory confirmation, exception count (`records.exception_count`) | Board report filed (`records.board_report.filed`) | Annually, following completion of annual policy review |

**ALERTS/METRICS:** Alert when any department lacks a designated records-retention contact for more than 10 BD (target: zero departments without a contact). Monitor `records.exception_count` trend; escalate to CCO any quarter with more than 5 exceptions. Alert if annual Board report is not filed within 30 days of annual review completion.

---

## Governance & Sign-Off {#governance}

| Role | Name | Responsibility |
|---|---|---|
| **Policy Owner** | Patrick Wilson, Chief Compliance Officer | Maintains policy; approves all revisions; reports to Board |
| **Senior Program Owner** | SVP of Operations & Finance | Monitors retention and destruction activity; confirms permanent-record inventory; reports to Board |
| **Department Records-Retention Contacts** | Designated per department | Accountable for proper retention completion in their area; develop department-specific training |
| **IT** | Information Technology Department | Responsible for email archives; conducts periodic retrievability testing |
| **Internal Audit** | Internal Audit Department | Reviews Destruction Logs and retention compliance; reports findings |

**Review Cadence:** This policy and Schedule A are reviewed at least annually by the CCO and SVP of Operations & Finance, with Board approval required for any revision. Out-of-cycle reviews are triggered by regulatory changes, new products or services, or material changes in storage technology.

**Cross-References:**
- BSA/AML Program Policy (substantive BSA program; this policy covers only BSA recordkeeping periods)
- Lending Policy and Collections Policy (loan file and collections records management beyond retention periods)
- Cash Policy (deposit and cash operations records beyond retention periods)
- Information Security Policy (security safeguards and email-system controls)
- Privacy Policy (consumer personal-information deletion rights; CPRA/CPRA compliance)

---

## Assumptions & Gaps {#assumptions}

- **Engineering vocabulary is provisional.** Several field and event codes referenced in the control overlays above — including codes on the `schedule_a`, `storage_box`, `destruction_log`, `disposal`, `core_archive`, `email_archive`, `records`, `record`, `cdd`, `legal_hold`, and `retention` objects — are drawn from the registered core-API vocabulary where registered codes exist, and composed per the Composition grammar where they do not. All codes should be confirmed against `core-vocabulary.json` before implementation. Specifically: `record.retention_class`, `record.retention_anchor`, `record.disposal_eligible`, `record.disposal_method`, `record.dispositioned`, `schedule_a.analog_entry_id`, `schedule_a.entry_inherited`, `disposal.batch_manifest_id`, `disposal.held`, `disposal.clock_resumed`, and `records.contact_vacated` are composed codes not confirmed as registered; they follow the grammar and are flagged for engineering confirmation.

- **California Financial Code specific provisions.** The policy references California Financial Code overlays as applicable to DFPI-chartered institutions. The specific California Financial Code sections governing minimum retention periods for California credit unions have not been enumerated in this document. Legal counsel should confirm which California Financial Code provisions apply to Pynthia's charter type and whether any California minimums exceed the federal floors cited herein.

- **DFPI vs. NCUA charter.** Patrick's notes reference both DFPI and NCUA, consistent with a California state-chartered, federally insured credit union. This assumption is reflected in the permanent-records list (DFPI license, NCUA insurance certificate, Reports of Examination by DFPI or NCUA). If Pynthia is federally chartered, the DFPI references should be replaced with NCUA equivalents.

- **HMDA reporter status.** The policy references HMDA/Reg C retention obligations. Whether Pynthia meets the HMDA reporting threshold (and is therefore subject to Reg C LAR retention requirements) has not been confirmed. If Pynthia is not a HMDA reporter, Reg C citations in Schedule A should be removed.

- **Schedule A (Exhibit A) is a separate artifact.** This policy references Schedule A as the authoritative retention schedule. Schedule A itself — containing the full record-by-record retention periods for Pynthia's actual deposit, lending, and payment activities — is maintained as a separate controlled document. The institutional-records section described in Patrick's notes (permanent records, corporate governance, tax records, audit and examination records, financial and operational records, vendor and contract records, HR and employment records) must be incorporated into Schedule A. This policy does not reproduce Schedule A in full; it governs how Schedule A is maintained and applied.

- **Exhibit 1 (Destruction Log) is a separate artifact.** The Destruction Log template referenced in RR-04 is maintained as a separate controlled document (Exhibit 1). Its format must include at minimum: department, record description, box number, from/to dates, destruction date, two-associate initials, and vendor certificate reference.

- **Two-person verification for destruction.** The policy requires two verifying associates to initial the Destruction Log before destruction proceeds. The specific roles authorized to serve as the two verifying associates (e.g., department contact plus supervisor, or any two employees) should be confirmed by the SVP of Operations & Finance and documented in the destruction procedures.

- **Unified 3-year consumer transaction schedule.** The policy adopts a unified 3-year retention period for consumer transaction records subject to 2-year (Reg CC, Reg E) and 25-month (Reg B) minimums. This is a conservative administrative choice that does not conflict with any federal minimum. The additional retention period is justified by consistent administration and does not materially increase CPRA exposure, but this determination should be confirmed by legal counsel in light of CPRA data minimization obligations.

- **Tax records — 7-year period.** The policy adopts a 7-year retention period for tax records, covering the IRS 6-year underreporting SOL plus a 1-year buffer. The California FTB 4-year SOL is fully covered. This is a conservative default; legal counsel should confirm whether any Pynthia-specific circumstances (e.g., prior audit history) warrant a longer period.

- **Audit and examination records — 5-year period.** The source reference contained a discrepancy (4 years in Risk Management, 5 years in Accounting). This policy resolves the discrepancy in favor of the longer 5-year period. This assumption should be confirmed by Internal Audit and the CCO.

- **Salary records — 5-year period.** The source reference listed salary records at 4 years; Patrick's notes specify 5 years. This policy adopts 5 years as the conservative default. FLSA requires 3 years for payroll records; the additional 2 years is an administrative buffer. Confirm with HR and legal counsel.

- **Payroll records — 3-year period.** The source reference listed payroll records, deductions, and overtime at 2 years; Patrick's notes specify 3 years (FLSA minimum). This policy adopts 3 years. Confirm with HR and legal counsel.

- **ERISA benefit plan documents — 6 years.** The source reference listed "Benefit Plan Documents" at 5 years and "ERISA Reports" at 6 years. Patrick's notes specify 6 years after plan closure per [29 U.S.C. §1027](https://www.law.cornell.edu/uscode/text/29/1027). This policy adopts 6 years as the controlling period. Confirm with HR and legal counsel.

- **Employee/HR records — no dedicated HR policy.** Patrick's notes flag that there is no dedicated HR policy in this repository. HR and employment records retention periods are included in Schedule A per this policy, but substantive HR program governance (e.g., personnel file access, background check procedures) is out of scope. A future HR policy should cross-reference this policy for retention periods.

- **BSA/AML anonymization — CPRA de-identification standard.** The policy requires that anonymization of BSA/AML records meet the CPRA de-identification standard (reasonable measures to prevent re-identification; public commitment not to re-identify). The specific technical and organizational measures Pynthia will use to meet this standard, and the form of the public commitment, should be documented in the Privacy Policy and confirmed by legal counsel before the anonymization process is operationalized.

- **CDD refresh — risk-tier definitions.** The policy references "higher-risk" and "standard-risk" customer tiers for CDD refresh frequency. The specific criteria for risk-tier assignment are governed by the BSA/AML Program Policy and are not defined in this policy. The BSA department should confirm that risk-tier definitions in the BSA Policy align with the refresh frequencies specified here.

- **Vendor and contract records — FFIEC guidance.** The policy adopts a "life of agreement plus 3 years after termination" period for vendor files, contracts, and due diligence records, consistent with FFIEC Third-Party Risk Management Guidance. If a vendor relationship is subject to a legal hold or regulatory inquiry, the longer period governs. Confirm with legal counsel whether any current vendor relationships have specific contractual or regulatory retention requirements that exceed this default.
```
