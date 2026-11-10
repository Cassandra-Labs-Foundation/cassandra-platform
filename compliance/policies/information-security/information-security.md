```yaml
---
title: Information Security Policy (Table-First, Design-Overlay v3)
owner: Patrick Wilson, Chief Compliance Officer
version: v1.0
effective: 2025-07-01
next_review: 2026-07-01
approvers:
  - Patrick Wilson, Chief Compliance Officer
tags: [Compliance, Information Security, Cybersecurity, NCUA, GLBA, Identity Theft]
---
```

## General Policy Statement

Pynthia Credit Union maintains a risk-based information security program that protects the confidentiality, integrity, availability, and resilience of member and organizational information across all people, facilities, data, systems, networks, vendors, and AI tools. The program is governed by the Board/Supervisory Committee, owned by the Chief Compliance Officer, and implemented by Engineering and SecOps. Controls are evidence-based: every obligation in this policy produces a logged event, a measurable artifact, or a scheduled task that can be examined by regulators and auditors. Out of scope: consumer online/mobile banking channel governance (E-Commerce Policy), electronic payment rails (Electronic Payment Systems Policy), marketing-compliance and advertising rules (Fair Lending Policy), enterprise risk appetite and taxonomy (Enterprise Risk Management Policy), vendor onboarding program mechanics beyond information-security diligence (Third-Party Risk Policy), detailed business continuity planning (Business Continuity Plan Policy), and privacy notices and member privacy rights (Privacy Policy).

---

## Timing Matrix {#timing-matrix}

| Scenario | Trigger (human → event) | Deadline | Content Reference | Control |
|---|---|---:|---|---|
| Annual policy approval | Board meeting cycle opens (`policy.board_review.started`) | Annual | Board-approved policy document | [IS-01](#is-01-governance-and-oversight) |
| Quarterly KPI report to Board | Quarter closes (`security.quarter.closed`) | 30 days post-quarter | KPI snapshot + program metrics | [IS-01](#is-01-governance-and-oversight) |
| High/Very High risk reassessment | Risk rated High/Very High (`risk.rating.recorded`) | Quarterly | Risk register entry | [IS-02](#is-02-enterprise-risk-assessment) |
| Moderate risk reassessment | Risk rated Moderate (`risk.rating.recorded`) | Annually | Risk register entry | [IS-02](#is-02-enterprise-risk-assessment) |
| Low/Very Low risk reassessment | Risk rated Low/Very Low or trigger event | Every 2 years or on trigger | Risk register entry | [IS-02](#is-02-enterprise-risk-assessment) |
| Monthly POA&M update | Month closes | Monthly | POA&M status report | [IS-02](#is-02-enterprise-risk-assessment) |
| New-product security risk assessment | New product proposed (`product.change.proposed`) | 10 business days | Security risk assessment findings | [IS-02](#is-02-enterprise-risk-assessment) |
| CMDB inventory delta posting | Asset change detected (`asset.changed`) | 5 business days | CMDB delta record | [IS-03](#is-03-asset-inventory-and-classification) |
| Quarterly CMDB attestation | Quarter closes (`security.quarter.closed`) | Quarterly | Attestation record | [IS-03](#is-03-asset-inventory-and-classification) |
| CAB review — medium/high-risk RFC | RFC submitted (`change.rfc.submitted`) | 3 business days | CAB decision record | [IS-04](#is-04-change-management-and-configuration-control) |
| Emergency change post-review | Emergency change deployed (`change.emergency.deployed`) | 24 hours | Post-review record | [IS-04](#is-04-change-management-and-configuration-control) |
| High-risk vulnerability triage | High-risk finding confirmed (`vuln.finding.confirmed`) | 5 business days | Triage record + POA&M entry | [IS-05](#is-05-vulnerability-and-penetration-testing) |
| Critical vulnerability patch | Critical finding confirmed (`vuln.finding.confirmed`) | 7 days | Remediation evidence | [IS-05](#is-05-vulnerability-and-penetration-testing) |
| High vulnerability patch | High finding confirmed (`vuln.finding.confirmed`) | 15 days | Remediation evidence | [IS-05](#is-05-vulnerability-and-penetration-testing) |
| Medium vulnerability patch | Medium finding confirmed (`vuln.finding.confirmed`) | 30 days | Remediation evidence | [IS-05](#is-05-vulnerability-and-penetration-testing) |
| Annual external pen-test | Annual cycle opens | Annual | Pen-test report | [IS-05](#is-05-vulnerability-and-penetration-testing) |
| Access deprovisioning on termination | Employee separated (`employee.separated`) | Same business day | Deprovisioning record | [IS-06](#is-06-access-control-and-authentication) |
| Quarterly access review | Quarter closes (`security.quarter.closed`) | Quarterly | Access review attestation | [IS-06](#is-06-access-control-and-authentication) |
| Data disposal | Retention eligibility reached (`record.retention.expired`) | 30 days | Disposal certificate | [IS-07](#is-07-data-protection-encryption-and-disposal) |
| Weekly backup restore verification | Weekly cycle (`backup.cycle.completed`) | Weekly | Restore test result | [IS-08](#is-08-backup-and-disaster-recovery) |
| Annual DR exercise | Annual cycle | Annual | DR exercise after-action report | [IS-08](#is-08-backup-and-disaster-recovery) |
| NCUA cyber incident notification | Reportable incident determined (`incident.reportability_determination`) | 72 hours | NCUA notification record | [SC-01](#sc-01-ncua-reportable-cyber-incident-member-notification) |
| Member notice — data breach | Member impact confirmed | Without unreasonable delay | Member notice per Appendix B | [SC-01](#sc-01-ncua-reportable-cyber-incident-member-notification) |
| Red-flag case review | Red flag detected (`redflag.detected`) | Same day | Red-flag case record | [IS-10](#is-10-identity-theft-red-flags-program) |
| Red-flag ruleset quarterly review | Quarter closes (`security.quarter.closed`) | Quarterly | Updated ruleset record | [IS-10](#is-10-identity-theft-red-flags-program) |
| Vendor security triage (breach notice) | Vendor breach notified (`vendor.breach.notified`) | 1 business day | Triage record | [IS-11](#is-11-vendor-information-security-diligence) |
| High-risk vendor annual review | Annual cycle | Annual | Vendor review package | [IS-11](#is-11-vendor-information-security-diligence) |
| Badge deactivation on separation | Employee separated (`employee.separated`) | 24 hours | Badge deactivation record | [IS-12](#is-12-physical-security-and-facilities) |
| AI tool registry update | AI tool approved (`ai.tool.approved`) | 5 business days | AI register entry | [IS-13](#is-13-ai-governance-and-usage-disclosure) |
| Critical SIEM alert review | Critical alert fired (`siem.alert_critical`) | Daily | Alert disposition record | [IS-14](#is-14-logging-monitoring-and-alerting) |
| AUP acknowledgment before access | Access requested (`user.access.requested`) | Before access granted | Signed AUP record | [IS-15](#is-15-acceptable-use-and-communications-systems) |
| Social media takedown escalation | Impersonation/scam detected (`socialmedia.impersonation.detected`) | Same day | Takedown escalation record | [IS-16](#is-16-social-media) |
| New-hire security training | Employee hired (`employee.hired`) | 30 days | Training completion record | [IS-17](#is-17-training-awareness-and-testing) |
| Annual security training refresher | Annual cycle opens | Annual | Training completion record | [IS-17](#is-17-training-awareness-and-testing) |
| Quarterly phishing simulation | Quarter opens | Quarterly | Phishing simulation results | [IS-17](#is-17-training-awareness-and-testing) |
| Monthly security destruction queue | Month closes | Monthly (unless legal hold) | Destruction log entry | [IS-18](#is-18-records-management-and-retention) |

---

## IS-01 — Governance and Oversight {#is-01-governance-and-oversight}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §I](https://www.ecfr.gov/current/title-12/part-748) requires each federally insured credit union to implement a written information security program approved by the board. [GLBA 15 USC §§6801–6809](https://www.law.cornell.edu/uscode/text/15/6801) establishes the overarching safeguards obligation for nonpublic personal information.

**SYSTEM BEHAVIOR:** The Security Program record is the single authoritative source for the program charter, control owners, KPIs, and review cadence. The CCO owns the record and submits it for annual Board approval; the Board/Supervisory Committee receives a quarterly KPI report within 30 days of quarter-end. The program record is write-restricted to the CCO and designated Information Security/IT lead; read access is granted to all approvers and the Board package distribution list.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual board review cycle opens (`policy.board_review.started`) | Current program charter (`security.program_charter`), prior-year KPI snapshot (`security.kpi_snapshot`), proposed changes (`policy.change_description`) | Board-approved policy document + approval record (`policy.board.approved`) | Annual (enforced by `policy.board_approval_due_at`) |
| Quarter closes and KPI report is due (`security.quarter.closed`) | KPI snapshot (`security.kpi_snapshot`), quarter identifier (`security.quarter`), program metrics | Quarterly KPI report delivered to Board/Supervisory Committee (`security.board_report.issued`) | 30 days post-quarter (enforced by `security.board_report_due_at`) |

**ALERTS/METRICS:** Alert fires if `policy.board_approval_due_at` is breached without a `policy.board.approved` event; alert fires if `security.board_report_due_at` is breached without a `security.board_report.issued` event. Target: zero overdue approvals or reports in any rolling 12-month period.

---

## IS-02 — Enterprise Risk Assessment {#is-02-enterprise-risk-assessment}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §II](https://www.ecfr.gov/current/title-12/part-748) requires a risk assessment identifying threats, vulnerabilities, and controls for member information. [NCUA 12 CFR Part 748, Appendix A §III](https://www.ecfr.gov/current/title-12/part-748) requires ongoing monitoring and testing tied to risk levels.

**SYSTEM BEHAVIOR:** The information-security risk register maps assets, threats (including fraud, social engineering, identity theft, and AI risks), and controls. It feeds into the centralized enterprise risk register owned by the Enterprise Risk Management Policy. Reassessment cadence follows ERM tiers: High/Very High residual risks at least quarterly, Moderate at least annually, Low/Very Low every two years or on trigger events. POA&M entries are updated monthly. For new products, a lightweight security risk assessment is completed within 10 business days and submitted as input to the ERM new-product review process. The risk register is write-restricted to the Information Security/IT lead and CCO; the ERM team has read access for consolidation.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Risk rating recorded or reassessment due (`risk.rating.recorded`) | Asset inventory (`asset.cmdb_snapshot`), threat catalog (`risk.threat_catalog`), control mapping (`risk.assessment_results`), residual rating (`risk.residual_rating`) | Risk register entry updated (`risk.assessment.completed`) | High/Very High: quarterly; Moderate: annually; Low/Very Low: every 2 years or on trigger (enforced by `risk.reassessment_due_at`) |
| Month closes — POA&M update due | Open POA&M items (`risk.poam_status`), remediation evidence (`risk.remediation_evidence`), owner IDs (`risk.owner_id`) | POA&M status report (`risk.poam.updated`) | Monthly |
| New product proposed (`product.change.proposed`) | Product description (`product.description`), data flows (`product.data_flows`), threat catalog (`risk.threat_catalog`) | Security risk assessment findings submitted to ERM (`risk.product_assessment.completed`) | 10 business days (enforced by `risk.product_assessment_due_at`) |

**ALERTS/METRICS:** Alert fires when a High/Very High risk item has not been reassessed within 90 days; alert fires when a POA&M item has no update event in the current month. Target: zero overdue reassessments; POA&M update coverage 100% monthly.

---

## IS-03 — Asset Inventory and Classification {#is-03-asset-inventory-and-classification}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §II](https://www.ecfr.gov/current/title-12/part-748) requires identification of information and systems that must be protected. [GLBA 15 USC §6801](https://www.law.cornell.edu/uscode/text/15/6801) requires safeguards appropriate to the nature and scope of information handled.

**SYSTEM BEHAVIOR:** The CMDB is the authoritative inventory of hardware, software, data stores, and vendors. Each asset record carries a data classification of Public, Internal, or Confidential-NPI. When any asset is added, changed, or retired, the CMDB delta must be posted within 5 business days. A quarterly attestation confirms inventory completeness. The CMDB is write-restricted to the Information Security/IT lead and Engineering; the CCO and Risk team have read access.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Asset added, changed, or retired (`asset.changed`) | Asset attributes (`asset.attributes`), data classification (`asset.classification`), owner (`asset.owner`), media type (`asset.media_type`) | CMDB delta record posted (`asset.cmdb.updated`) | 5 business days (enforced by `asset.cmdb_update_due_at`) |
| Quarter closes — attestation due (`security.quarter.closed`) | Current CMDB snapshot (`asset.cmdb_snapshot`), owner roster (`asset.owner_roster`) | Quarterly attestation record (`asset.attestation.completed`) | Quarterly |

**ALERTS/METRICS:** Alert fires when an `asset.changed` event is not followed by `asset.cmdb.updated` within 5 business days; alert fires when quarterly attestation is overdue. Target: CMDB delta lag ≤ 5 BD for 100% of changes; zero missed quarterly attestations.

---

## IS-04 — Change Management and Configuration Control {#is-04-change-management-and-configuration-control}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §III](https://www.ecfr.gov/current/title-12/part-748) requires controls over information systems, including change management. [NIST SP 800-53 Rev.5 CM-3](https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final) (non-regulatory framework reference) provides the configuration change control baseline.

**SYSTEM BEHAVIOR:** All changes to production systems follow an RFC workflow requiring documented risk rating, test evidence, backout plan, and approver sign-off. Medium- and high-risk changes require CAB review within 3 business days of RFC submission. Emergency changes bypass pre-approval but must receive a post-review within 24 hours of deployment. Configuration drift detected by automated tooling triggers an RFC or remediation record. The CAB decision field is write-restricted to designated CAB members; emergency post-review is write-restricted to the Information Security/IT lead and CCO.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| RFC submitted for medium/high-risk change (`change.rfc.submitted`) | RFC document (`change.rfc`), risk rating (`change.risk_rating`), test evidence (`change.test_evidence`), backout plan (`change.backout_plan`), approver ID (`change.approver_id`) | CAB decision recorded (`change.cab_decision.recorded`) | 3 business days (enforced by `change.cab_review_due_at`) |
| Emergency change deployed (`change.emergency.deployed`) | Emergency justification (`change.emergency_justification`), deployment record (`change.deployment_record`), rollback plan (`change.rollback_plan`) | Post-review record (`change.post_review.completed`) | 24 hours (enforced by `change.post_review_due_at`) |
| Configuration drift detected (`config.drift.detected`) | Baseline ID (`config.baseline_id`), drift detail (`config.drift_detail`) | Drift remediation or RFC initiated (`config.drift.resolved`) | Per risk rating of the drift finding |

**ALERTS/METRICS:** Alert fires when a medium/high-risk RFC has no `change.cab_decision.recorded` within 3 BD; alert fires when an emergency change has no `change.post_review.completed` within 24 hours; alert fires on any unresolved `config.drift.detected` older than 5 BD. Target: zero overdue CAB reviews; zero unreviewed emergency changes.

---

## IS-05 — Vulnerability and Penetration Testing {#is-05-vulnerability-and-penetration-testing}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §III](https://www.ecfr.gov/current/title-12/part-748) requires regular testing and monitoring of information security controls. [GLBA 15 USC §6801](https://www.law.cornell.edu/uscode/text/15/6801) requires safeguards to protect against anticipated threats.

**SYSTEM BEHAVIOR:** Automated vulnerability scans run on a scheduled basis across all in-scope systems. An external penetration test is conducted annually by an independent party. All findings are triaged and tracked to closure in the POA&M. Severity-based patching SLAs apply: Critical within 7 days, High within 15 days, Medium within 30 days. High-risk findings (Critical or High severity) must be triaged within 5 business days of confirmation. Findings that cannot be remediated within SLA require a risk acceptance record. The pen-test scope and independence attestation are write-restricted to the Information Security/IT lead; finding records are write-restricted to SecOps.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Vulnerability finding confirmed (`vuln.finding.confirmed`) | Finding detail (`vuln.detail`), severity (`vuln.severity`), affected asset (`asset.id`) | Triage record + POA&M entry (`vuln.triage.completed`) | 5 business days for High/Critical (enforced by `vuln.triage_due_at`) |
| Triage complete — remediation assigned (`vuln.triage.completed`) | Remediation plan (`vuln.remediation_plan`), owner, severity (`vuln.severity`) | Remediation evidence recorded (`vuln.remediated`) | Critical: 7 days; High: 15 days; Medium: 30 days (enforced by `vuln.remediation_due_at`) |
| Annual pen-test cycle opens | Scope definition (`pentest.scope`), independence attestation (`pentest.independence`) | Pen-test report issued (`pentest.report.issued`) | Annual (enforced by `pentest.engagement_due`) |

**ALERTS/METRICS:** Alert fires when a Critical finding has no `vuln.remediated` event within 7 days; High within 15 days; Medium within 30 days. Alert fires when annual pen-test is overdue. Target: zero Critical findings open beyond SLA; mean time to remediate High findings ≤ 15 days.

---

## IS-06 — Access Control and Authentication {#is-06-access-control-and-authentication}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §II–III](https://www.ecfr.gov/current/title-12/part-748) requires access controls to limit information access to authorized individuals. [GLBA 15 USC §6801](https://www.law.cornell.edu/uscode/text/15/6801) requires safeguards against unauthorized access to member information.

**SYSTEM BEHAVIOR:** All system access requires SSO with MFA enforced at the identity provider. Role assignments follow least-privilege principles enforced by the SoD matrix. Joiner/mover/leaver events trigger automated provisioning and deprovisioning workflows. On termination, all access must be deprovisioned the same business day. Break-glass accounts are permitted for emergency use only and generate a heavily logged access record that is reviewed within one business day. Quarterly access reviews attest that all active entitlements remain appropriate. Access provisioning is write-restricted to the Information Security/IT lead with manager approval; break-glass usage is logged automatically and reviewed by the CCO.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Employee hired or role changed (`employee.hired`, `employee.role.changed`) | Role entitlements (`access.role_entitlements`), manager approval (`access.manager_approval`), justification (`access.justification`) | Access provisioned (`access.provisioned`) | Before first system access |
| Employee separated (`employee.separated`) | User ID (`user.id`), employment status (`user.employment_status`), role ID (`access.role_id`) | Access deprovisioned (`access.deprovisioned`) | Same business day (enforced by `access.deprovision_due_at`) |
| Break-glass account used (`access.breakglass_used`) | Break-glass ID (`access.breakglass_id`), justification (`access.breakglass_justification`), agent identity (`access.agent_identity`) | Break-glass usage logged and flagged for review (`access.breakglass_reviewed`) | Review within 1 business day |
| Quarter closes — access review due (`security.quarter.closed`) | Reviewer roster (`access.reviewer_roster`), user roster (`access.user_roster`), last reviewed date (`access.last_reviewed_at`) | Access review attestation completed (`access_review.completed`) | Quarterly (enforced by `access.review_due_at`) |

**ALERTS/METRICS:** Alert fires when `employee.separated` is not followed by `access.deprovisioned` within the same business day; alert fires when break-glass usage is not reviewed within 1 BD; alert fires when quarterly access review is overdue. Target: same-day deprovisioning rate 100%; zero unreviewed break-glass events.

---

## IS-07 — Data Protection, Encryption, and Disposal {#is-07-data-protection-encryption-and-disposal}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §II](https://www.ecfr.gov/current/title-12/part-748) requires encryption and other safeguards for member information in transit and at rest. [FACTA Disposal Rule 16 CFR Part 682](https://www.ecfr.gov/current/title-16/part-682) requires proper disposal of consumer information derived from consumer reports. [GLBA 15 USC §6801](https://www.law.cornell.edu/uscode/text/15/6801) requires safeguards against unauthorized access and use.

**SYSTEM BEHAVIOR:** All data in transit uses TLS 1.2 or higher; all data at rest on Confidential-NPI classified assets uses AES-256 or equivalent approved cryptography. The approved cipher suite list is maintained in the crypto configuration record. DLP controls monitor and block unauthorized exfiltration of NPI. When data reaches its retention eligibility date, disposal must be completed within 30 days using a method that renders the data unreadable (shredding, degaussing, or certified overwrite), unless a legal hold is in effect. Disposal certificates are retained. Litigation-hold status is checked before any disposal action. The crypto configuration is write-restricted to the Information Security/IT lead; DLP policy rules are write-restricted to the CCO and Information Security/IT lead.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| TLS certificate approaching expiry (`tls.certificate_expires_at`) | Certificate details, cipher suite (`tls.cipher_suite`), assessment result (`tls.test_rating`) | Certificate renewed (`tls.certificate.renewed`) | Before expiry (enforced by `tls.certificate_expiry_due`) |
| DLP violation detected (`dlp.violation.detected`) | Violation detail (`dlp.violation_detail`), data classification (`asset.classification`), actor ID | DLP violation resolved or escalated (`dlp.violation.resolved`) | Same business day for NPI violations |
| Record reaches retention eligibility (`record.retention.expired`) | Record class (`record.retention_class`), legal hold flag (`record.legal_hold_flag`), disposal method (`record.disposal_method`) | Disposal certificate recorded (`disposal.certificate.recorded`) | 30 days (enforced by `record.disposal_due_at`); suspended if legal hold active |

**ALERTS/METRICS:** Alert fires when a TLS certificate expires without renewal; alert fires when a DLP NPI violation is unresolved after 1 BD; alert fires when a disposal-eligible record has no `disposal.certificate.recorded` within 30 days. Target: zero expired certificates in production; zero unresolved NPI DLP violations beyond 1 BD.

---

## IS-08 — Backup and Disaster Recovery {#is-08-backup-and-disaster-recovery}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §III](https://www.ecfr.gov/current/title-12/part-748) requires controls to ensure availability and recovery of member information systems. [NCUA 12 CFR Part 749](https://www.ecfr.gov/current/title-12/part-749) and its Appendix B require vital-records preservation and recovery planning.

**SYSTEM BEHAVIOR:** RTO and RPO targets are defined per system in the DR plan and scope registry. Backups are maintained offsite and in immutable storage. Restore tests are conducted weekly to verify backup integrity; failures trigger immediate remediation. An annual full DR exercise tests end-to-end recovery including ransomware isolation and clean-room restore scenarios. Exercise results are documented in an after-action report and findings tracked to closure. The DR plan and RTO/RPO matrix are write-restricted to the Information Security/IT lead; restore test results are written by SecOps.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Weekly backup cycle completes (`backup.cycle.completed`) | Backup catalog (`backup.catalog`), cycle detail (`backup.job_detail`), RPO monitor (`backup.rpo_monitor`) | Restore test result recorded (`backup.restore.verified`) | Weekly (enforced by `backup.verify_due_at`) |
| Backup job fails (`backup.job.failed`) | Job detail (`backup.job_detail`), failure reason | Remediation record (`backup.job.remediated`) | Same business day |
| Annual DR exercise cycle opens | DR plan (`dr.plan`), RTO/RPO matrix (`dr.rto_rpo_matrix`), exercise objectives (`drill.objectives`) | DR exercise after-action report published (`drill.aar.published`) | Annual (enforced by `dr.exercise_due_at`) |
| Ransomware or destructive event detected (`incident.sev1.detected`) | Incident scope (`incident.scope`), blast radius isolation status (`it.blast_radius_isolated`), restore test environment (`restore.test_env`) | Clean-room restore completed (`restore.completed`) | Per RTO for affected systems |

**ALERTS/METRICS:** Alert fires when weekly restore test is overdue or fails without a remediation record; alert fires when annual DR exercise is overdue. Target: weekly restore test success rate ≥ 99%; annual DR exercise completed on schedule with after-action report within 30 days.

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

## IS-19 — Incident Response Plan, Post-Mortem & Law Enforcement Coordination {#is-19-incident-response-plan-post-mortem-law-enforcement-coordination}

**WHY (Reg cite):** [GLBA 15 USC §6801](https://www.law.cornell.edu/uscode/text/15/6801) requires safeguards and response programs for breaches. Incident declaration and triage feed the reportability determination governed by [SC-01](#sc-01-ncua-reportable-cyber-incident-member-notification).

**SYSTEM BEHAVIOR:** The IR plan, incident commander roster, and playbooks are maintained and tested annually. Reportability is assessed as soon as material facts are known and routed to SC-01. Law enforcement coordination is documented in the incident record. Incident declaration, IC assignment, and first-hour mechanics are governed by SC-03 (embedded below). The incident record is write-restricted to the assigned incident commander and CCO.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Incident closed (`incident.closed`) | Root cause (`incident.root_cause`), timeline (`incident.timeline`), recovery evidence (`incident.recovered`) | Post-mortem completed (`incident.postmortem.completed`) | Within 30 days of closure |

**ALERTS/METRICS:** Track post-mortem completion within 30 days of closure (target: 100%).

---

## SC-03 — Enterprise Incident Declaration & First-Hour Response {#sc-03-enterprise-incident-declaration-first-hour-response}

**WHY (Reg cite):** [12 CFR Part 748, Appendix A](https://www.ecfr.gov/current/title-12/part-748) requires a defined incident response process including declaration, containment, and communication; [FFIEC Business Continuity Management guidance](https://ithandbook.ffiec.gov/it-booklets/business-continuity-management/) requires a structured first-hour checklist and regular situation reporting. Documented declaration authority and initial actions are supervisory expectations. This control implements the enterprise incident declaration and initial-response mechanics defined in [BC-06 — Incident Declaration and Initial Actions](../business-continuity-plan/business-continuity-plan.md#bc-06-incident-declaration-and-initial-actions), which is the authoritative source for IMT roles, sitrep cadence, and incident stabilization.

**SYSTEM BEHAVIOR:** Upon declaration of a disruptive event, the IC executes a "first hour" checklist covering: (1) confirm human safety, (2) stabilize immediate threat, (3) scope the incident, (4) assign IMT roles, (5) notify required parties, and (6) set sitrep cadence. A Situation Report version 1 (Sitrep v1) must be produced within 30 minutes of declaration. Sitreps are issued every 30–60 minutes until the incident is stabilized. Declaration authority rests with the CCO, CEO, or designated IMT lead; the IC manages execution. Sitrep content and cadence are write-restricted to the IC and IMT leads.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Incident declared (`incident.declared`) | Incident scope (`incident.scope`), severity (`incident.severity`), IC identity, IMT roster | First-hour checklist initiated (`incident.first_hour.completed`), IMT roles assigned (`incident.ic.assigned`) | Immediately upon declaration |
| First-hour checklist completed (`incident.first_hour.completed`) | Safety confirmation, stabilization status, scope assessment, role assignments, notification list | Sitrep v1 issued (`sitrep.issued`), v1 timer logged (`sitrep.v1_timer`) | 30 minutes after declaration (enforced by `sitrep.v1_timer`) |
| Sitrep v1 issued (`sitrep.issued`) | Current incident status, actions taken, next steps, estimated resolution | Sitrep cadence timer set (`sitrep.cadence_timer`), subsequent sitreps issued at cadence | Every 30–60 minutes until stabilized (enforced by `sitrep.cadence_timer`) |
| Incident stabilized (`incident.contained`) | Stabilization criteria met, IC confirmation | Sitrep cadence suspended, stabilization logged (`incident.contained`) | Upon IC determination of stabilization |

**ALERTS/METRICS:** Alert fires if `incident.ic.assigned` is not logged within 15 minutes of `incident.declared`. Alert fires if Sitrep v1 is not issued within 30 minutes of declaration (`sitrep.v1_timer` breached); alert fires if sitrep cadence lapses beyond 60 minutes during active incident. Target: IC assignment ≤ 15 minutes of declaration; 100% of declared incidents with Sitrep v1 ≤ 30 minutes; zero cadence lapses during active incidents.

---

## IS-10 — Identity Theft Red Flags Program {#is-10-identity-theft-red-flags-program}

**WHY (Reg cite):** [NCUA 12 CFR Part 717 Subpart J](https://www.ecfr.gov/current/title-12/part-717) requires federally insured credit unions to develop and implement a written identity theft prevention program covering covered accounts. [FACTA (15 USC §1681m(e))](https://www.law.cornell.edu/uscode/text/15/1681m) establishes the statutory basis for the Red Flags Rule.

**SYSTEM BEHAVIOR:** The red-flag matrix enumerates applicable red flags for all covered accounts (loans, lines of credit, deposit accounts) across all access channels (in-person, telephone, online, ATM, written). When a red flag is detected, step-up verification is triggered and an account hold may be applied pending resolution. Cases are reviewed the same day they are detected. Staff complete the appropriate red-flag form (credit-report alert form or general red-flag alert form) for every detected flag, even when no response is warranted. SAR referral is made where suspicious activity meets BSA thresholds. The ruleset is reviewed quarterly and updated to reflect new identity theft methods, account types, or business arrangements. The red-flag ruleset is write-restricted to the CCO and designated ID Theft Compliance Officer.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Red flag detected on new or existing covered account (`redflag.detected`) | Red flag type (`redflag.type`), account ID (`account.id`), step-up required flag (`redflag.stepup_required`), address/reissue match (`redflag.address_reissue_match`) | Red-flag case opened and step-up verification initiated (`redflags.case.opened`, `redflag.stepup.completed`) | Same day (enforced by `redflag.review_due_at`) |
| Red-flag case resolved (`redflag.case.disposed`) | Case disposition, SAR referral if applicable (`sar.filing_id`), case stats (`redflag.case_stats`) | Case disposition recorded; SAR filed if warranted (`sar.filed`) | Same day as resolution |
| Quarter closes — ruleset review due (`security.quarter.closed`) | Current ruleset (`redflag.ruleset`), pattern updates (`redflag.pattern_updates`), new account types or channels | Updated ruleset record (`redflag.ruleset.updated`) | Quarterly (enforced by `redflag.review_due_at`) |

**ALERTS/METRICS:** Alert fires when a detected red-flag case has no same-day disposition event; alert fires when quarterly ruleset review is overdue. Target: 100% of red-flag cases reviewed same day; zero missed quarterly ruleset reviews.

---

## IS-11 — Vendor Information Security Diligence {#is-11-vendor-information-security-diligence}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §IV](https://www.ecfr.gov/current/title-12/part-748) requires oversight of service provider arrangements to ensure they implement appropriate safeguards. [GLBA 15 USC §6801–6802](https://www.law.cornell.edu/uscode/text/15/6801) requires contractual protections when sharing NPI with service providers.

**SYSTEM BEHAVIOR:** This control covers the information-security contribution to the broader vendor lifecycle governed by the Third-Party Risk Policy. For each vendor with NPI access or network connectivity, the Information Security/IT lead completes a security questionnaire, reviews privacy controls, SOC reports, and pen-test results as part of the due-diligence package. Contracts must include breach-notice obligations (vendor notifies the institution within 24 hours of discovery), data disposition requirements, and right-to-audit clauses. When a vendor reports a breach, internal security triage must be completed within 1 business day. High-risk vendors are reviewed annually consistent with Third-Party Risk monitoring cadences. The vendor security questionnaire and SOC report fields are write-restricted to the Information Security/IT lead.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Vendor proposed or onboarding initiated (`vendor.proposed`, `vendor.onboarding.started`) | Security questionnaire (`vendor.security_questionnaire`), SOC report (`vendor.soc_report`), NPI access flag (`vendor.npi_access_flag`), network access flag (`vendor.network_access_flag`), pen-test results | Vendor due-diligence package completed (`vendor.diligence.completed`) | Before contract execution |
| Vendor breach notification received (`vendor.breach.notified`) | Breach detail (`vendor.breach_detail`), affected scope (`vendor.affected_scope`), incident scope (`vendor.incident_scope`) | Internal security triage completed (`vendor.incident.logged`) | 1 business day (enforced by `vendor.incident_triage_due`) |
| Annual review cycle — high-risk vendor (`vendor.annual_review_due_at`) | Prior review package, updated security questionnaire, SOC report, contract clauses (`vendor.contract_clauses`), GLBA clause verification (`vendor.glba_clause`) | Annual vendor review completed (`vendor.review.completed`) | Annual (enforced by `vendor.annual_review_due_at`) |

**ALERTS/METRICS:** Alert fires when a vendor breach notification is not triaged within 1 BD; alert fires when a high-risk vendor annual review is overdue. Target: 100% of vendor breach notifications triaged within 1 BD; zero overdue high-risk vendor reviews.

---

## IS-12 — Physical Security and Facilities {#is-12-physical-security-and-facilities}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §II](https://www.ecfr.gov/current/title-12/part-748) requires physical safeguards to protect member information and systems. [ADA 28 CFR Part 36](https://www.ecfr.gov/current/title-28/part-36) provides supporting authority for facilities access controls where public accommodation is involved.

**SYSTEM BEHAVIOR:** Card/access controls restrict entry to all facilities; server rooms and media storage areas are designated secure zones with additional access controls. All visitors are escorted and logged. CCTV and alarm systems are monitored continuously. On employee separation, physical access badges are deactivated within 24 hours. Annual facility security tests verify alarm, CCTV, and access-control functionality. Facility access approval and badge deactivation are write-restricted to Facilities and the Information Security/IT lead.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Visitor arrives at a facility (`facility.visitor.arrived`) | Visitor identity (`facility.visitor_identity`), visit purpose (`facility.visit_purpose`), zone (`facility.zone`) | Visitor log entry recorded (`facility.visitor.logged`) | At time of arrival |
| Employee separated (`employee.separated`) | Badge ID (`facility.badge_id`), employee ID | Badge deactivated (`facility.badge_deactivated`) | 24 hours (enforced by `facility.badge_deactivation_due_at`) |
| Facility alarm triggered (`facility.alarm.triggered`) | CCTV reference (`facility.cctv_ref`), zone, alarm detail | Alarm resolved and logged (`facility.alarm.resolved`) | Immediate response; resolution documented same day |
| Annual facility test due (`facility.annual_test_due`) | Test script (`facility.test_script`), contacts (`facility.contacts`) | Facility test completed (`facility.test.completed`) | Annual (enforced by `facility.test_due_at`) |

**ALERTS/METRICS:** Alert fires when badge deactivation is not completed within 24 hours of separation; alert fires when annual facility test is overdue. Target: 100% badge deactivation within 24 hours; annual test completion rate 100%.

---

## IS-13 — AI Governance and Usage Disclosure {#is-13-ai-governance-and-usage-disclosure}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §II–III](https://www.ecfr.gov/current/title-12/part-748) requires that safeguards extend to all systems and tools that process member information, including AI tools. [GLBA 15 USC §6801](https://www.law.cornell.edu/uscode/text/15/6801) requires safeguards for NPI regardless of the processing technology used.

**SYSTEM BEHAVIOR:** Pynthia Credit Union maintains a default pro-AI posture with controls. All AI tools and use cases must be registered in the AI Use Register before production use. A Data Protection Impact Assessment (DPIA) is required before any AI tool is deployed in production. Member-facing AI features require a published disclosure. Uploading NPI to unapproved external AI tools is prohibited; DLP controls enforce this. When an AI tool is approved, the registry must be updated within 5 business days. AI violations (unapproved NPI upload, undisclosed member-facing feature) are dispositioned as policy violations. The AI Use Register is write-restricted to the CCO and Information Security/IT lead.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| AI tool proposed for production use (`ai.tool.proposed`) | Tool description (`ai.tool`), use case (`ai.use_case`), DPIA reference (`ai.dpia_ref`), vendor/feature review | DPIA completed and tool approved or rejected (`ai.tool.approved`, `ai.tool.rejected`) | Before production deployment |
| AI tool approved (`ai.tool.approved`) | Approval record (`ai.approval_record`), use case (`ai.use_case`), member feature flag (`ai.member_feature`) | AI register updated (`ai.register.updated`) | 5 business days (enforced by `ai.register_update_due_at`) |
| Member-facing AI feature launched (`ai.member_feature.launched`) | Disclosure text (`ai.disclosure_text`), disclosure channel (`ai.disclosure_channel`) | Member-facing disclosure published (`ai.disclosure.published`) | Before or at launch |
| AI policy violation detected (`ai.violation.disposed`) | Violation type, actor ID, data scope (`incident.data_scope`) | Violation dispositioned and logged (`ai.violation.disposed`) | Same business day |

**ALERTS/METRICS:** Alert fires when an AI tool is detected in production without a corresponding `ai.tool.approved` event; alert fires when registry update is overdue after approval. Target: zero unapproved AI tools in production; registry update lag ≤ 5 BD for 100% of approvals.

---

## IS-14 — Logging, Monitoring, and Alerting {#is-14-logging-monitoring-and-alerting}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §III](https://www.ecfr.gov/current/title-12/part-748) requires monitoring and testing of information security controls. [NCUA 12 CFR Part 749](https://www.ecfr.gov/current/title-12/part-749) sets retention requirements for records, including security logs.

**SYSTEM BEHAVIOR:** All security-relevant events are centralized in the SIEM with time-synchronized sources. Real-time alerting is configured for critical events (authentication failures, privilege escalation, data exfiltration attempts, system outages). Critical alerts are reviewed daily; unreviewed critical alerts escalate automatically. Security-relevant logs are retained for at least 12 months, aligned to the records retention schedule. Silent log sources (no events received within expected window) trigger an alert. The SIEM alert disposition field is write-restricted to SecOps; the source inventory is write-restricted to the Information Security/IT lead.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Critical SIEM alert fires (`siem.alert_critical`) | Alert detail (`siem.alert_detail`), source inventory (`siem.source_inventory`), last seen timestamp (`siem.last_seen_at`) | Alert reviewed and dispositioned (`siem.alert.disposed`) | Daily (enforced by `siem.alert_review_due_at`) |
| Log source goes silent (`siem.source_silent`) | Source inventory (`siem.source_inventory`), expected event cadence | Source restored or incident declared (`siem.source.restored`) | Same business day |
| Security log retention period expires (`record.retention.expired`) | Record class (`record.retention_class`), legal hold flag (`record.legal_hold_flag`) | Log retention confirmed or disposal executed (`record.disposed`) | Per records schedule (minimum 12 months) |

**ALERTS/METRICS:** Alert fires when any critical SIEM alert has no disposition event within 24 hours; alert fires when a log source is silent beyond its expected cadence. Target: critical alert review rate 100% daily; zero silent log sources undetected beyond 1 BD.

---

## IS-15 — Acceptable Use and Communications Systems {#is-15-acceptable-use-and-communications-systems}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §II](https://www.ecfr.gov/current/title-12/part-748) requires policies governing employee use of information systems. [GLBA 15 USC §6801](https://www.law.cornell.edu/uscode/text/15/6801) requires safeguards that include employee training and use controls.

**SYSTEM BEHAVIOR:** The Acceptable Use Policy (AUP) documents permitted use of devices, email, messaging, internet, and removable media. Monitoring notice is provided to all users. BYOD devices must be enrolled in MDM with encryption enabled before accessing credit union systems. Remote-work connections require VPN or equivalent secure access. All users must acknowledge the AUP before access is granted; re-acknowledgment is required when the AUP is materially revised. The AUP document is write-restricted to the CCO and Information Security/IT lead; acknowledgment records are system-generated.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| User requests system access (`user.access.requested`) | User ID (`user.id`), role (`user.role`), AUP version (`aup.version`) | AUP acknowledged and access granted (`aup.acknowledged`, `access.granted`) | Before first access |
| AUP materially revised (`aup.revised`) | Revision summary (`aup.revision_summary`), affected user roster | Re-acknowledgment collected from all users (`aup.reacknowledged`) | Within 30 days of revision |
| BYOD device enrollment requested (`byod.enrollment.requested`) | MDM status (`byod.mdm_status`), encryption status (`byod.encryption_status`) | BYOD enrolled (`byod.enrolled`) | Before device accesses credit union systems |

**ALERTS/METRICS:** Alert fires when a user has active system access without a current AUP acknowledgment; alert fires when a BYOD device accesses systems without MDM enrollment. Target: AUP acknowledgment coverage 100% of active users; zero unmanaged BYOD devices with system access.

---

## IS-16 — Social Media {#is-16-social-media}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §II](https://www.ecfr.gov/current/title-12/part-748) requires controls over communications channels that could expose member information. [GLBA 15 USC §6801](https://www.law.cornell.edu/uscode/text/15/6801) requires safeguards against unauthorized disclosure of NPI through any channel.

**SYSTEM BEHAVIOR:** Corporate social media posts require pre-approval by the designated approver before publication. Personal posts by employees that reference the credit union must include a disclaimer that views are personal. Employees are prohibited from disclosing member information on any social media platform. Scams, impersonation accounts, and fraudulent posts are escalated for takedown the same day they are detected. Evidence of detected violations is preserved. The social media approver field is write-restricted to the CCO and designated Communications lead.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Corporate post drafted (`socialmedia.post.drafted`) | Post content (`socialmedia.post_content`), approver (`socialmedia.approver`) | Post approved and published (`socialmedia.post.approved`) | Before publication |
| Impersonation or scam detected (`socialmedia.impersonation.detected`) | Impersonation detail (`socialmedia.impersonation_detail`), evidence (`socialmedia.evidence`) | Takedown escalated (`socialmedia.takedown.escalated`) | Same day (enforced by `socialmedia.takedown_due_at`) |
| Member-information disclosure detected (`socialmedia.disclosure.detected`) | Disclosure detail, actor ID, data scope | Disclosure dispositioned and logged (`socialmedia.disclosure.disposed`) | Same business day |

**ALERTS/METRICS:** Alert fires when a detected impersonation or scam has no `socialmedia.takedown.escalated` event within the same business day; alert fires when a corporate post is published without a prior `socialmedia.post.approved` event. Target: same-day takedown escalation rate 100%; zero unapproved corporate posts.

---

## IS-17 — Training, Awareness, and Testing {#is-17-training-awareness-and-testing}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §IV](https://www.ecfr.gov/current/title-12/part-748) requires training of staff to implement the information security program. [NCUA 12 CFR Part 717 Subpart J](https://www.ecfr.gov/current/title-12/part-717) requires training for the identity theft prevention program.

**SYSTEM BEHAVIOR:** All employees complete role-based security training. New hires must complete initial security training within 30 days of hire. Annual refresher training is required for all staff. High-risk roles (system administrators, SecOps, finance) receive additional deep-dive training. Quarterly phishing simulations are conducted; employees who fail are flagged for re-training, which must be completed within 15 business days of the simulation results. Repeated phishing failures trigger escalated re-training and a coaching record. Training completion records are maintained for audit. Training assignments are write-restricted to the Information Security/IT lead and HR; completion records are system-generated.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Employee hired (`employee.hired`) | Hire date (`training.hire_date`), role curriculum (`training.role_curriculum`), required curriculum (`training.required_curriculum`) | New-hire training completed (`training.onboarding.completed`) | 30 days of hire (enforced by `training.onboarding_due_at`) |
| Annual training cycle opens (`training.annual_cycle.opened`) | Annual curriculum (`training.annual_cycle`), assignee roster | Annual refresher training completed (`training.refresher.completed`) | Annual (enforced by `training.annual_due_at`) |
| Quarterly phishing simulation launched (`phishing.simulation.launched`) | Simulation scenario (`phishing.scenario`), target population | Phishing simulation results recorded (`phishing.results.recorded`) | Quarterly |
| Phishing simulation failure recorded (`phishing.repeat_failure`) | Failure history (`phishing.failure_history`), employee ID, repeat failure flag (`phishing.repeat_failure`) | Remedial training assigned and completed (`training.remedial.assigned`, `training.remedial.completed`) | Re-training within 15 BD of results |

**ALERTS/METRICS:** Alert fires when new-hire training is not completed within 30 days; alert fires when annual refresher completion rate falls below 95% at cycle close; alert fires when a phishing-failure re-training assignment is not completed within 15 BD. Target: new-hire training completion rate 100% within 30 days; annual refresher completion ≥ 95%.

---

## IS-18 — Records Management and Retention {#is-18-records-management-and-retention}

**WHY (Reg cite):** [NCUA 12 CFR Part 749](https://www.ecfr.gov/current/title-12/part-749) and its Appendix B require credit unions to maintain vital records and preserve them for specified periods. [NCUA 12 CFR Part 748, Appendix A §III](https://www.ecfr.gov/current/title-12/part-748) requires retention of records sufficient to evidence the security program. [FACTA Disposal Rule 16 CFR Part 682](https://www.ecfr.gov/current/title-16/part-682) requires proper disposal of consumer report-derived information.

**SYSTEM BEHAVIOR:** Security-specific record classes — SIEM and audit logs, incident-response records, vulnerability findings and POA&Ms, access-review evidence, AI-use registry entries, and physical security logs — are subject to the retention periods in Record Retention Policy Schedule A. Retention clocks are set automatically when records are created. The security destruction queue is processed monthly; data disposal aligns with IS-07 (data rendered unreadable within 30 days of eligibility). The destruction queue is write-restricted to the CCO and Records Management lead. Hold/destruction lifecycle mechanics are governed by [SC-02](#sc-02-record-retention-lifecycle-mechanics) embedded in this policy.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Security record created (any security-class record) | Record class (`record.retention_class`), retention schedule (`record.retention_timer`), anchor date (`record.retention_anchor`) | Retention clock set (`record.retention_clock_set`) | At record creation |
| Month closes — destruction queue processed | Disposal-eligible records (`record.disposal_eligible`), legal hold flag (`record.legal_hold_flag`) cleared, disposal method (`record.disposal_method`) | Destruction log entry created (`destruction_log.entry.created`) | Monthly (unless legal hold active per SC-02) |

**ALERTS/METRICS:** Alert fires when a disposal-eligible record has no destruction log entry after the monthly queue run (absent a legal hold); alert fires when a destruction log mismatch is detected (`destruction_log.mismatch.detected`). Target: monthly destruction queue completion rate 100% for eligible records; zero unresolved destruction log mismatches. Hold, vendor-certificate, and permanent-record alerts are governed by [SC-02](#sc-02-record-retention-lifecycle-mechanics).

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

| Role | Name | Responsibility |
|---|---|---|
| Policy Owner | Patrick Wilson, Chief Compliance Officer | Maintains policy, coordinates annual review, submits for Board approval |
| Information Security/IT Lead | TBD | Implements controls, maintains CMDB, SIEM, and security program record |
| Engineering/SecOps | TBD | Implements automated controls, produces audit logs, executes vulnerability and DR testing |
| Risk | TBD | Consolidates security risk register into enterprise risk register |
| Privacy | TBD | Coordinates on data classification, DLP, and AI DPIA |
| HR | TBD | Triggers joiner/mover/leaver events for access and training workflows |
| Facilities | TBD | Manages physical access controls and badge deactivation |
| Board/Supervisory Committee | TBD | Annual policy approval; quarterly KPI report recipient |

**Review cadence:** Annual policy review and Board approval; quarterly KPI reporting; controls reviewed on trigger events (material incidents, regulatory changes, new products).

**Cross-references:** Enterprise Risk Management Policy (risk register consolidation, ERM new-product review), Third-Party Risk Policy (vendor lifecycle beyond IS diligence), Record Retention Policy (Schedule A retention periods, legal-hold process), Business Continuity Plan Policy (BCP/DR coordination), Privacy Policy (member privacy rights), E-Commerce Policy (online/mobile channel governance), Electronic Payment Systems Policy (payment rail controls), Fair Lending Policy (marketing compliance).

---

## Assumptions & Gaps {#assumptions}

- **Engineering vocabulary is provisional.** Several field and event codes referenced in the control overlays above are composed per the Composition grammar and are not yet confirmed as registered in `core-vocabulary.json`. Specifically: `security.program_charter`, `security.kpi_snapshot`, `security.quarter`, `security.board_report_due_at`, `security.board_report.issued`, `security.quarter.closed` (used as a trigger throughout — this is a composed event on the registered `security` object with the registered action `closed`, matching the registered event `security.quarter.closed`), `access.breakglass_used`, `access.breakglass_id`, `access.breakglass_justification`, `access.breakglass_reviewed`, `siem.alert_critical` (composed from registered `siem` object + registered action `alert`; the registered event `siem.alert_critical` does not appear in the events table but `siem.alert_detail` and `siem.alert_review_due_at` are registered fields). Engineering must confirm or register these codes before the next review cycle.

- **`security.quarter.closed` as a recurring trigger.** This event is used throughout the Timing Matrix and control overlays as the trigger for quarterly obligations (KPI report, CMDB attestation, access review, red-flag ruleset review). The registered event `security.quarter.closed` exists in the vocabulary. Engineering should confirm the scheduler emits this event at quarter-end for all relevant consumers.

- **NCUA reportable-incident/member-notice mechanic is a single shared control.** [SC-01](#sc-01-ncua-reportable-cyber-incident-member-notification) is sourced verbatim — same control ID, title, and body — from [`shared-controls/ncua-incident-notification.md`](../shared-controls/ncua-incident-notification.md) and appears identically in Business Continuity Plan, E-Commerce, Electronic Payment Systems, Collections, Information Security, Privacy, and Third-Party Risk. Edit the shared source first, then propagate to all seven; do not edit SC-01 in this policy in isolation. IS-19 carries the IR-declaration/IC-assignment/post-mortem material that used to be bundled into the old IS-09 control.

- **`siem.alert_critical` event code.** The SIEM entity has a registered field `siem.alert_critical` (string) and `siem.alert_review_due_at` (string). The event `siem.alert_critical` is used in IS-14 as a trigger; engineering should confirm whether this is emitted as a lifecycle event or whether the correct trigger is a state change on `siem.alert_critical` field (e.g., `siem.alert_critical.detected`). The registered event `siem.source_silent` is used as-is.

- **`phishing.repeat_failure` as an event trigger.** The `phishing` object has a registered field `phishing.repeat_failure` (string). IS-17 uses this as a trigger event. Engineering should confirm the event code — likely `phishing.repeat_failure.detected` per Composition grammar — and register it.

- **`access.breakglass_used` event.** The `access` object has registered fields `access.breakglass_used`, `access.breakglass_id`, `access.breakglass_justification`, and `access.breakglass_reviewed`. IS-06 uses `access.breakglass_used` as a trigger event. Engineering should confirm the emitted event code (likely `access.breakglass.used` per Composition grammar) and register it.

- **`product.description` provisional code.** IS-02 references `product.description` for the new-product security risk assessment. This is listed in the Provisional codes section and should be used as-is.

- **`security.program_charter` and `security.kpi_snapshot` fields.** These are registered fields on the `security` object (`security.program_charter`, `security.kpi_snapshot`) and are used in IS-01. Engineering should confirm these fields are populated by the security program management workflow.

- **ID Theft Compliance Officer designation.** PATRICK_NOTES and the REFERENCE_POLICY both reference a designated ID Theft Compliance Officer. This policy assigns that function to the CCO. If a separate designee is appointed, the role assignment in IS-10 and the Governance table should be updated.

- **HMDA reporter status.** This policy does not address HMDA reporting obligations. If Pynthia Credit Union is a HMDA reporter, the information security program should coordinate with the Fair Lending Policy on data integrity controls for LAR data.

- **NCUA Part 701.31 applicability.** NCUA 12 CFR Part 701.31 (nondiscrimination in lending) is not directly implicated by this policy. No assumption is made about its applicability here; the Fair Lending Policy governs.

- **ADA (28 CFR Part 36) scope.** ADA is cited in IS-12 as supporting authority for facilities access controls. Its applicability depends on whether Pynthia Credit Union's facilities are places of public accommodation. Legal counsel should confirm the scope of ADA obligations for physical security design.

- **`disposal.due_at` provisional code.** IS-07 references `record.disposal_due_at` (registered field on `record`) for the 30-day disposal deadline. The provisional code `disposal.due_at` is also listed; the registered `record.disposal_due_at` is preferred and used throughout.

- **Vendor breach-notice window alignment.** IS-11 states vendors must notify the institution within 24 hours of discovery, with internal triage within 1 business day. This aligns with the Third-Party Risk Policy standard per PATRICK_NOTES. If the Third-Party Risk Policy specifies a different window, IS-11 should be updated to match.

- **`training.onboarding_due_at` vs. `training.newhire_due_at`.** Both are registered timers for the same concept. IS-17 uses `training.onboarding_due_at`; engineering should confirm which timer is canonical for the 30-day new-hire security training deadline.
