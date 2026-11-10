```yaml
---
title: E-Commerce Policy (Table-First, Design-Overlay v3)
owner: Patrick Wilson, Chief Compliance Officer
version: v1.0
effective: 2025-07-01
next_review: 2026-07-01
approvers:
  - Patrick Wilson, Chief Compliance Officer
tags: [Compliance, E-Commerce, Information Security, Authentication, Risk Management]
---
```

# E-Commerce Policy

## General Policy Statement

Pynthia Credit Union is committed to identifying, measuring, monitoring, and controlling the risks that arise from operating electronic-commerce channels — the online and mobile banking systems that run over public networks and allow members to access account information and conduct transactions. This policy establishes layered preventive, detective, and recovery controls across the consumer-facing channel layer, covering member enrollment and authentication, network and data access, encryption, virus protection, security monitoring, breach response, business continuity integration, and staff training. Accountability is centralized with the Chief Compliance Officer, with required participation from the CIO/IT Department, Deposit Operations, and Information Security. The Board of Directors approves this policy and reviews it at least annually. Backend payment rails, cybersecurity controls, CIP for online account opening, privacy notices, and third-party vendor oversight are governed by adjacent policies.

---

## Timing Matrix {#timing-matrix}

| Scenario | Trigger (human → event) | Deadline | Content Reference | Control |
|---|---|---:|---|---|
| Enrollment application received | Member submits e-commerce enrollment application (`ecommerce.enrollment.received`) | Before access granted | Identity verification + member-number match required | [EC-03](#ec-03-user-authentication-and-enrollment) |
| Enrollment approved — confirmation sent | Enrollment verified and approved (`ecommerce.enrollment.approved`) | Immediate | Email confirmation to member | [EC-03](#ec-03-user-authentication-and-enrollment) |
| Temporary password issued | No password requested at enrollment (`member_credential.temp_password.issued`) | At credential issuance | 8-character random temp password | [EC-04](#ec-04-member-password-standards) |
| Password change required — first login | Member first accesses system with temp password (`ecommerce.credentials.issued`) | On first access | Member must set new password meeting complexity rules | [EC-04](#ec-04-member-password-standards) |
| Annual password expiry | Password age reaches 12 months (`member_credential.expiry_due`) | Annually | Member prompted to change password | [EC-04](#ec-04-member-password-standards) |
| Firewall periodic review | Scheduled review cycle opens | Periodically (internal cadence) | Firewall rule review and test | [EC-05](#ec-05-firewalls) |
| Firewall independent annual review | Annual calendar trigger (`firewall.independent_review_due`) | Annually | Independent provider intrusion-risk review and test | [EC-05](#ec-05-firewalls) |
| TLS/SSL annual test | Annual calendar trigger (`tls.assessment_due`) | Annually | Qualys SSL Labs test; results retained with IT | [EC-06](#ec-06-encryption) |
| Security breach detected | Unauthorized act or user detected (`incident.detected`) | Immediately | Management notification; damage/liability assessment; response activation | [EC-13](#ec-13-breach-detection-liability-assessment-external-comms-gating) / [SC-01](#sc-01-ncua-reportable-cyber-incident-member-notification) |
| Annual e-commerce risk assessment | Annual calendar trigger (`ecommerce.risk_assessment_due`) | Annually | Risk assessment covering all e-commerce systems | [EC-02](#ec-02-network-and-data-access-controls) |
| Annual training needs assessment | Annual calendar trigger (`training.annual_due`) | Annually | Staffing and training needs reassessment | [EC-12](#ec-12-expertise-and-training) |
| Annual policy review | Board review cycle opens (`policy.review_due`) | Annually | Board review and approval of this policy | [EC-01](#ec-01-safeguarding-member-information) |

---

## EC-01 — Safeguarding Member Information {#ec-01-safeguarding-member-information}

**WHY (Reg cite):** [NCUA 12 CFR Part 748 and Appendix A](https://www.ecfr.gov/current/title-12/part-748) requires federally insured credit unions to maintain a board-approved information-security program with controls that protect the confidentiality, integrity, and availability of member information. [GLBA 15 USC §§6801–6809](https://www.law.cornell.edu/uscode/text/15/6801) establishes the overarching safeguards principle for nonpublic personal information handled through electronic channels.

**SYSTEM BEHAVIOR:** E-commerce systems must maintain data integrity, ensure member privacy, and protect the credit union's computer and telecommunications systems from unauthorized intrusion, misuse, or fraud. End-to-end security controls are applied to all critical data traversing the e-commerce channel. The policy is reviewed by management at least annually and approved by the Board; the CCO owns the policy document and is the sole write-authorized party for policy-level changes. Periodic assessments identify internal and external threats and drive decisions to modify or add controls.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual policy review cycle opens (`policy.board_review.started`) | Current policy version (`policy.document_version`), prior year assessment findings (`finding.description`), any regulatory changes (`regulatory.change_analysis`) | Board-approved policy (`policy.board.approved`) logged with approval date and version (`policy.board_approved_at`, `policy.document_version`) | Annually (internal: prior to annual Board meeting; enforced by `policy.review_due_at`) |
| Periodic e-commerce risk assessment due (`ecommerce.risk_assessment_due`) | Current threat landscape, control inventory (`control.register`), prior assessment results (`ecommerce.risk_assessment_due`) | Completed risk assessment (`ecommerce.risk_assessment.completed`) with findings routed to CCO | Annually minimum (internal: per risk-assessment schedule; enforced by `ecommerce.risk_assessment_due`) |

**ALERTS/METRICS:** Alert when `policy.review_due_at` is within 30 days and no `policy.board_review.started` event has been emitted. Alert when `ecommerce.risk_assessment_due` lapses without a corresponding `ecommerce.risk_assessment.completed` event. Target: zero overdue policy reviews.

---

## EC-02 — Network and Data Access Controls {#ec-02-network-and-data-access-controls}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §III](https://www.ecfr.gov/current/title-12/part-748) requires access controls that limit system access to authorized individuals. The [FFIEC IT Examination Handbook (Information Security booklet)](https://ithandbook.ffiec.gov/it-booklets/information-security/) sets expectations for user authentication, access management, and least-privilege enforcement across electronic channels.

**SYSTEM BEHAVIOR:** The credit union verifies and enforces each user's authorized right to access the network, applications, and data. Controls include: unique user IDs; passwords with regular updates; member-set security questions; physical controls (e.g., combination-locked computer room); and software/hardware security devices (anti-virus, firewall, monitoring software). Unauthorized individuals are prohibited from entering operations facilities, retrieving confidential information, or accessing credit union software and operating systems. Access rights are provisioned on a least-privilege basis and reviewed periodically; the CIO/IT Department administers access provisioning, and the CCO holds write authority over access-control policy parameters.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| User access provisioned or changed (`access.granted`) | User identity (`access.agent_identity`), role entitlements (`access.role_entitlements`), manager approval (`access.manager_approval`) | Access grant record (`access.role.granted`) logged with role, justification, and approver | Before system access is enabled (internal: same business day) |
| Access review cycle due (`access.review_due_at`) | Current access roster (`access.user_roster`), role definitions (`access.role_entitlements`), last review date (`access.last_reviewed_at`) | Completed access review (`access_review.completed`) with attestation (`access.review_attestation`) | Periodically per internal schedule (enforced by `access.review_due_at`) |
| User separated or role changed (`access.deprovisioned`) | Separation notice (`employee.terminated`), user ID (`user.id`), role (`user.role`) | Deprovisioning record (`access.deprovisioned`) logged with timestamp | Immediately on separation or role change (enforced by `access.deprovision_due_at`) |
| Physical access to computer room requested | Visitor identity (`facility.visitor_identity`), visit purpose (`facility.visit_purpose`), access approval (`facility.access_approval`) | Visitor log entry (`facility.visitor.logged`) | At time of access |

**ALERTS/METRICS:** Alert when any user account has not been reviewed within the periodic review window. Alert when `access.deprovision_due_at` is breached without a corresponding `access.deprovisioned` event. Target: zero accounts with lapsed access reviews; zero separated-employee accounts remaining active beyond the deprovision deadline.

---

## EC-03 — User Authentication and Enrollment {#ec-03-user-authentication-and-enrollment}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A](https://www.ecfr.gov/current/title-12/part-748) and the [FFIEC Authentication Guidance (2021 update)](https://www.ffiec.gov/press/pdf/Authentication-and-Access-to-Financial-Institution-Services-and-Systems.pdf) require risk-based authentication and identity verification before granting access to electronic banking systems. [GLBA 15 USC §6801](https://www.law.cornell.edu/uscode/text/15/6801) underpins the obligation to protect member identity and account access.

**SYSTEM BEHAVIOR:** The credit union identifies the member before issuing any authorization codes. Once identity is established, an access code and password are assigned. On every subsequent access attempt, the member's identity is authenticated before account information or transactions are available. Members may not complete an e-commerce enrollment application entirely online without supplying related account numbers; the application must be submitted electronically, in person, or by mail. Identity of the applicant and verification of the member number are confirmed before the access code is issued. An email confirmation is sent to the member upon approval. The system blocks issuance of credentials until both `enrollment.member_number_match` is confirmed true and identity evidence is validated; Deposit Operations staff are the only parties authorized to approve enrollment applications.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Enrollment application received (`ecommerce.enrollment.received`) | Applicant identity (`enrollment.applicant_identity`), related account numbers (`enrollment.identity_evidence`), submission channel (`enrollment.channel`) | Enrollment application record created and queued for verification (`ecommerce.enrollment.submitted`) | Immediately on receipt |
| Identity and member-number verification completed (`ecommerce.enrollment.verified`) | Member number match result (`enrollment.member_number_match`), identity evidence (`enrollment.identity_evidence`), verifier ID | Verification result logged (`verification.completed`); enrollment approved or denied (`ecommerce.enrollment.approved` or `verification.denied`) | Before credentials issued (internal: same business day for in-person; within 2 BD for mail/electronic) |
| Enrollment approved — credentials issued (`ecommerce.credentials.issued`) | Approved enrollment record, member email address (`entity.email`), temporary password (`member_credential.temp_password`) | Credentials issued (`member_credential.issued`); email confirmation sent (`ecommerce.enrollment_confirmation.sent`) | Immediately upon approval |
| Member login attempt (`ecommerce.login.failed` or `ecommerce.session_authenticated`) | Member login ID (`member_credential.login_id`), password hash (`member_credential.password_hash`), security question responses (`member_credential.security_questions`) | Authentication result logged (`ecommerce.audit_trail.recorded`); on repeated failure, lockout recorded (`ecommerce.credential.locked`, `ecommerce.lockout.recorded`) | Real-time on each access attempt |

**ALERTS/METRICS:** Alert on any enrollment approval event lacking a prior `ecommerce.enrollment.verified` event. Alert when failed login attempts (`ecommerce.login.failed`) exceed threshold within a session window, triggering lockout review. Target: zero credentials issued without completed identity verification; lockout events reviewed within 1 BD.

---

## EC-04 — Member Password Standards {#ec-04-member-password-standards}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §III.C](https://www.ecfr.gov/current/title-12/part-748) requires authentication controls sufficient to protect member account access. The [FFIEC Authentication Guidance (2021)](https://www.ffiec.gov/press/pdf/Authentication-and-Access-to-Financial-Institution-Services-and-Systems.pdf) calls for password complexity and lifecycle controls commensurate with the risk of the channel.

**SYSTEM BEHAVIOR:** When no password is requested at enrollment, the system issues a randomly generated eight-character temporary password. The member is required to change the temporary password on first login and at least annually thereafter. All passwords must meet Fiserv complexity rules: minimum length 8, maximum length 32 (spaces allowed but not at start or end); at least one upper-case letter; at least one lower-case letter; at least one number or special character; must not contain the member's first or last name, the Login ID (or Login ID as a substring), the word "Fiserv" in any case combination, or the word "password" as a substring; and must not match any of the prior 5 passwords. Allowed special characters include `!`, `#`, `$`, `%`, `_`, and `-`. The system enforces these rules at the point of password creation and change; the core vendor (Fiserv) complexity configuration is subject to change and the credit union will update this policy accordingly. IT is write-restricted from bypassing complexity enforcement without CCO approval.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| No password requested at enrollment — temp password issued (`member_credential.temp_password.issued`) | Member login ID (`member_credential.login_id`), enrollment approval record | Temporary password issued and flagged as temporary (`member_credential.is_temporary` = true); credential record created (`member_credential.issued`) | At credential issuance |
| Member first login with temporary password (`ecommerce.credentials.issued`) | Temporary password flag (`member_credential.is_temporary`), new password input (`member_credential.new_password`) | Password changed (`member_credential.password.changed`); `member_credential.is_temporary` set to false; `member_credential.password_set_at` recorded | On first access (system blocks account functions until change is complete) |
| Annual password expiry reached (`member_credential.expiry_due`) | Password set date (`member_credential.password_set_at`), member login ID (`member_credential.login_id`) | Member prompted to change password; new password change event logged (`member_credential.password.changed`) upon completion | Annually from last password set date (enforced by `member_credential.expiry_due`) |
| Password change attempted — complexity validation | New password input (`member_credential.new_password`), password history (`member_credential.password_hash`), login ID (`member_credential.login_id`) | Complexity check result logged (`ecommerce.audit_trail.recorded`); rejection or acceptance recorded | Real-time at point of change |

**ALERTS/METRICS:** Alert when any member account has `member_credential.is_temporary` = true for more than 7 days without a `member_credential.password.changed` event. Alert when `member_credential.expiry_due` lapses without a completed password change. Target: zero accounts with expired or unchanged temporary passwords beyond the grace window.

---

## EC-05 — Firewalls {#ec-05-firewalls}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §III.B](https://www.ecfr.gov/current/title-12/part-748) requires controls to protect the credit union's systems from unauthorized access, including perimeter security. The [FFIEC IT Examination Handbook (Information Security booklet)](https://ithandbook.ffiec.gov/it-booklets/information-security/) specifically identifies firewall deployment and periodic testing as baseline expectations for internet-connected financial institutions.

**SYSTEM BEHAVIOR:** The credit union combines hardware and software firewalls to block unwanted inbound and outbound communications while permitting acceptable traffic. Firewalls protect all connection points between internal and external networks, including the Internet. The IT Department reviews and tests firewalls on a periodic basis per the internal security calendar. An independent provider conducts an annual intrusion-risk review and test; results are documented and retained. The CIO owns firewall configuration; changes to firewall rules require documented approval and are logged. The CCO reviews annual independent-review results.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Periodic internal firewall review due (`firewall.review_due`) | Current firewall rule set, prior review results, change log | Completed internal review (`firewall.review.completed`) with findings documented | Per internal security calendar (enforced by `firewall.review_due`) |
| Annual independent intrusion-risk review due (`firewall.independent_review_due`) | Engagement scope (`pentest.scope`), independent provider credentials (`pentest.independence`), prior year findings | Independent review completed (`firewall.independent_review.completed`); report issued (`pentest.report.issued`) and retained with IT | Annually (enforced by `firewall.independent_review_due`) |
| Firewall rule change proposed | Change request (`change.rfc`), risk rating (`change.risk_rating`), approver ID (`change.approver_id`), rollback plan (`change.rollback_plan`) | CAB decision recorded (`change.cab_decision.recorded`); change deployed and logged (`change.completed`) | Per change management process (CAB review enforced by `change.cab_review_due_at`) |

**ALERTS/METRICS:** Alert when `firewall.independent_review_due` lapses without a `firewall.independent_review.completed` event. Alert when `firewall.review_due` lapses without a `firewall.review.completed` event. Target: zero overdue firewall reviews; all independent review findings tracked to remediation closure.

---

## EC-06 — Encryption {#ec-06-encryption}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §III.D](https://www.ecfr.gov/current/title-12/part-748) requires encryption of member information transmitted over public networks. [GLBA 15 USC §6801](https://www.law.cornell.edu/uscode/text/15/6801) and the [FFIEC Information Security booklet](https://ithandbook.ffiec.gov/it-booklets/information-security/) reinforce the obligation to protect data in transit using current cryptographic standards.

**SYSTEM BEHAVIOR:** All e-commerce system communications use TLS connections with current SSL certificates and underlying cipher suites. Encryption is applied to all transmissions of sensitive or critical member data. The SSL certificate and TLS protocol are tested at least annually using Qualys SSL Labs (https://www.ssllabs.com/ssltest/analyze); test results are retained on file with the IT Department. Certificates approaching expiry trigger a renewal workflow. The CIO/IT Department owns certificate management; the CCO reviews annual test results. Any cipher suite downgrade requires documented justification and CCO sign-off.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual TLS/SSL assessment due (`tls.assessment_due`) | Current certificate details (`tls.cipher_suite`, `tls.certificate_expires_at`), Qualys test scope | Assessment completed (`tls.assessment.completed`) with test rating (`tls.test_rating`) recorded and retained with IT | Annually (enforced by `tls.assessment_due`) |
| TLS certificate approaching expiry (`tls.certificate_expiry_due`) | Certificate expiry date (`tls.certificate_expires_at`), renewal authority | Certificate renewed (`tls.certificate.renewed`) and new expiry date recorded | Before expiry (internal: 30 days prior; enforced by `tls.certificate_expiry_due`) |
| Cipher suite or protocol change proposed | Change request (`change.rfc`), security justification (`change.emergency_justification`), approver ID (`change.approver_id`) | Change approved and deployed (`change.completed`); cipher suite update logged (`ecommerce.audit_trail.recorded`) | Per change management process |

**ALERTS/METRICS:** Alert when `tls.assessment_due` lapses without a `tls.assessment.completed` event. Alert when `tls.certificate_expiry_due` is within 30 days without a `tls.certificate.renewed` event. Alert on any TLS test rating below the credit union's minimum acceptable grade. Target: zero expired certificates; annual test completed on schedule.

---

## EC-07 — Transaction Verification {#ec-07-transaction-verification}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A](https://www.ecfr.gov/current/title-12/part-748) requires controls to ensure the integrity and authenticity of electronic transactions. The [E-SIGN Act (15 USC §7001 et seq.)](https://www.law.cornell.edu/uscode/text/15/7001) governs the legal enforceability of electronic records and signatures, supporting the credit union's ability to bind members to e-commerce agreement procedures and rebut repudiation claims.

**SYSTEM BEHAVIOR:** The credit union's e-commerce member agreements define the procedures for valid and authentic electronic communications, and specify that parties intend to be bound by communications complying with those procedures. Audit trails are maintained for all transactions, identifying the parties that initiate them. These trails enable the credit union to verify specific transactions and provide proof to rebut repudiation claims. Audit trail records are write-protected and accessible only to authorized IT and Compliance staff; no modification of audit trail entries is permitted after creation.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Member initiates an e-commerce transaction (`ecommerce.transaction.initiated`) | Authenticated session token, member ID (`member.id`), transaction details (`transaction.amount`, `transaction.type`), initiating party (`transaction.initiated_by`) | Audit trail entry created (`ecommerce.audit_trail.recorded`) with party identity, transaction details, and timestamp | Real-time at transaction initiation |
| Repudiation claim received (`ecommerce.repudiation_claim.received`) | Claim details, member ID (`member.id`), transaction audit trail (`ecommerce.audit_trail.recorded`), e-commerce agreement version | Repudiation review completed (`ecommerce.repudiation.reviewed`) with audit trail evidence package produced | Within internal SLA for dispute response (internal: 5 BD) |

**ALERTS/METRICS:** Alert on any transaction event lacking a corresponding `ecommerce.audit_trail.recorded` entry. Alert when a repudiation claim (`ecommerce.repudiation_claim.received`) has no `ecommerce.repudiation.reviewed` event within the internal SLA. Target: 100% of transactions covered by audit trail; zero unreviewed repudiation claims beyond SLA.

---

## EC-08 — Virus Protection {#ec-08-virus-protection}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §III.B](https://www.ecfr.gov/current/title-12/part-748) requires controls to protect systems from malicious code. The [FFIEC Information Security booklet](https://ithandbook.ffiec.gov/it-booklets/information-security/) identifies malware prevention as a baseline control for internet-connected financial institution systems.

**SYSTEM BEHAVIOR:** The credit union maintains a credit-union-wide detection and prevention program to reduce the likelihood of computer virus infection. The program includes end-user acceptable-use policies, training and awareness programs, anti-virus detection tools deployed on all endpoints and servers, and enforcement procedures for policy violations. Anti-virus definitions are kept current. The IT Department reviews anti-virus logs periodically to identify detections and confirm remediation. The CIO owns the anti-virus program; the CCO reviews periodic log-review summaries.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Anti-virus detection event occurs (`antivirus.remediated`) | Detection details (`antivirus.detection`), signature version (`antivirus.signature`), definitions version (`antivirus.definitions_version`), affected system | Detection logged and remediation action recorded (`antivirus.remediated`) | Real-time on detection; remediation within internal SLA (internal: 4 hours for critical) |
| Periodic anti-virus log review due (`antivirus.log_review_due`) | Anti-virus log data (`antivirus.detection`), definitions currency (`antivirus.definitions_version`), prior review findings | Log review completed (`antivirus.log_review.completed`) with summary of detections and remediation status | Per internal security calendar (enforced by `antivirus.log_review_due`) |

**ALERTS/METRICS:** Alert on any anti-virus detection event that has not been remediated within the internal SLA. Alert when `antivirus.log_review_due` lapses without a `antivirus.log_review.completed` event. Alert when `antivirus.definitions_version` is more than 24 hours behind the vendor's current release. Target: zero unresolved detections beyond SLA; definitions current at all times.

---

## EC-09 — Security Monitoring, Penetration Testing, and Intrusion Detection {#ec-09-security-monitoring-penetration-testing-and-intrusion-detection}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §III.C](https://www.ecfr.gov/current/title-12/part-748) requires ongoing monitoring to detect and respond to threats. The [FFIEC IT Examination Handbook (Information Security booklet)](https://ithandbook.ffiec.gov/it-booklets/information-security/) and [FFIEC Authentication Guidance (2021)](https://www.ffiec.gov/press/pdf/Authentication-and-Access-to-Financial-Institution-Services-and-Systems.pdf) set expectations for real-time monitoring, penetration testing, and intrusion detection as components of a layered security program.

**SYSTEM BEHAVIOR:** The credit union uses monitoring tools to identify vulnerabilities and detect possible intrusions in real time from both external and internal parties. Transaction and audit logs are produced on a real-time basis indicating network traffic. Systems are in place to notify appropriate parties or terminate suspicious network connections automatically. Intrusion detection tools enable management to maintain an incident database for trend analysis of network intrusions and attack attempts. The intrusion detection system is monitored 24/7 by a security operations center (currently SecureWorks). The credit union has contracted with a bonded outside firm specializing in financial institution security to conduct penetration testing, provide results, and recommend remediation. Penetration testing findings are tracked to closure. The SIEM and intrusion detection systems are managed by IT/Information Security; the CCO receives summary reporting. Suspicious-connection termination is automated and does not require manual approval.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Intrusion or suspicious activity detected (`intrusion.detected`) | Detection source (`incident.detection_source`), severity (`intrusion.severity`), affected systems, network traffic log | Intrusion event logged (`intrusion.response.recorded`); suspicious connection terminated if applicable; incident opened (`incident.created`) | Real-time (automated detection and logging) |
| SIEM alert requires review (`siem.alert_review_due_at`) | Alert details (`siem.alert_detail`), alert criticality (`siem.alert_critical`), source inventory (`siem.source_inventory`) | Alert disposition recorded (`siem.alert.disposed`) — confirmed malicious or cleared | Within internal SLA (internal: critical alerts within 1 hour; enforced by `siem.alert_review_due_at`) |
| Penetration test engagement due (`pentest.engagement_due`) | Engagement scope (`pentest.scope`), provider independence confirmation (`pentest.independence`), prior findings | Penetration test completed; report issued (`pentest.report.issued`) and received (`pentest.report.received`); findings logged for remediation tracking | Annually or per engagement schedule (enforced by `pentest.engagement_due`) |
| Penetration test finding requires remediation | Finding severity (`vuln.severity`), remediation plan (`vuln.remediation_plan`), owner | Vulnerability finding confirmed (`vuln.finding.confirmed`); remediation tracked (`vuln.remediated`) | Per finding severity SLA (enforced by `vuln.remediation_due_at`) |
| Incident trend analysis due (`incident_trend.review_due`) | Incident database entries, trend data (`incident.timeline`), prior trend reports | Trend report issued (`incident_trend.report.issued`) for management review | Quarterly (internal cadence) |

**ALERTS/METRICS:** Alert when a SIEM critical alert (`siem.alert_critical`) has no disposition within 1 hour. Alert when `pentest.engagement_due` lapses without a `pentest.report.received` event. Alert when any `vuln.finding.confirmed` item has no `vuln.remediated` event within the severity-based SLA. Alert when a SIEM source goes silent (`siem.source_silent`). Target: 100% of critical SIEM alerts dispositioned within SLA; zero overdue penetration test engagements; all pentest findings remediated within SLA.

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

## EC-13 — Breach Detection, Liability Assessment & External Comms Gating {#ec-13-breach-detection-liability-assessment-external-comms-gating}

**WHY (Reg cite):** [GLBA 15 USC §6801](https://www.law.cornell.edu/uscode/text/15/6801) underpins the obligation to protect member information and respond to breaches. Feeds the reportability determination governed by [SC-01](#sc-01-ncua-reportable-cyber-incident-member-notification).

**SYSTEM BEHAVIOR:** Upon detection of an unauthorized act or user, the credit union immediately declares an incident and creates the incident record; management is notified of cause and scope. Enterprise incident declaration and first-hour mechanics then proceed per SC-03 (embedded below). The extent of damage or disclosure of information is determined, including potential legal liability, to support the SC-01 reportability determination. Only designated individuals are authorized to communicate externally; all other staff route external inquiries to the designated spokesperson. The CCO coordinates the response; the CIO/IT Department supports containment and forensics.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Unauthorized act or user detected (`incident.detected`) | Detection source (`incident.detection_source`), initial scope (`incident.scope_initial`), severity (`incident.severity`) | Incident declared (`incident.declared`); incident record created (`incident.created`) | Immediately on detection |
| Incident scope and damage assessed (`incident.assessment.completed`) | Incident facts (`incident.facts`), data scope (`incident.data_scope`), member impact (`incident.member_impact`), legal review (`incident.legal_review`) | Assessment completed (`incident.assessment.completed`); reportability determination made (`incident.reportability_assessment`) | Within internal SLA (internal: within 24 hours of detection) |
| External communications required (media, law enforcement) (`incident.external_comms.started`) | Designated spokesperson authorization, communications plan (`incident.comms_plan`), holding statement (`comms.holding_statement`) | External communications logged (`incident.external_comms.recorded`); only designated individuals authorized to communicate | Per response plan timeline |

**ALERTS/METRICS:** Target: zero breaches where incident declaration is delayed beyond immediate on detection.

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

## EC-11 — Contingency Planning and Business Continuity {#ec-11-contingency-planning-and-business-continuity}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §IV](https://www.ecfr.gov/current/title-12/part-748) requires credit unions to incorporate e-commerce systems into their overall business continuity and contingency planning. The [FFIEC Business Continuity Management booklet](https://ithandbook.ffiec.gov/it-booklets/business-continuity-management/) sets expectations for business impact analysis, recovery prioritization, and vendor disaster-recovery confirmation.

**SYSTEM BEHAVIOR:** All e-commerce systems are incorporated into the credit union's overall contingency planning and business continuity efforts. The credit union confirms that its core processor (Fiserv) and e-commerce provider have each addressed disaster recovery and contingency planning. The recovery plan for e-commerce is based on a business impact analysis (BIA) that evaluates business applications and processes to determine importance and establishes a prioritized order of business resumption, recovering the most critical functions and systems first. The BIA is reviewed and updated at least annually. Detailed BCP and DR procedures, including RTO/RPO targets and vendor DR confirmation, are maintained in the Business Continuity Plan Policy; this policy establishes the governance requirement that e-commerce systems are included in scope. The CCO confirms annual BIA completion; the CIO/IT Department owns the technical recovery procedures.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual BIA update due (`bia.annual_update_due`) | Current e-commerce system inventory, criticality ratings (`bia.criticality`), prior BIA (`bia.review_due`), member impact assessment (`bia.member_impact`) | BIA updated (`bia.updated`) with e-commerce systems included and prioritized; BIA certified (`bia.certified`) | Annually (enforced by `bia.annual_update_due`) |
| Vendor DR confirmation required (`vendor.dr.confirmed`) | Core processor DR plan (`vendor.dr_plan`), e-commerce provider DR attestation (`vendor.dr_attestation_due`), test results (`vendor.dr_test_results`) | Vendor DR confirmation logged (`vendor.dr.confirmed`) | Annually (enforced by `vendor.dr_attestation_due`) |
| BCP exercise or drill completed (`drill.completed`) | Exercise objectives (`drill.objectives`), e-commerce system scope, participant roster (`drill.roster`) | Drill completed (`drill.completed`); after-action report issued (`drill.aar.published`); remediation items tracked (`drill.corrective_plan.opened`) | Per BCP exercise schedule (enforced by `dr.exercise_due_at`) |

**ALERTS/METRICS:** Alert when `bia.annual_update_due` lapses without a `bia.certified` event. Alert when `vendor.dr_attestation_due` lapses without a `vendor.dr.confirmed` event. Alert when e-commerce systems are absent from the BIA scope. Target: zero e-commerce systems excluded from BIA; annual vendor DR confirmation on file.

---

## EC-12 — Expertise and Training {#ec-12-expertise-and-training}

**WHY (Reg cite):** [NCUA 12 CFR Part 748, Appendix A §II](https://www.ecfr.gov/current/title-12/part-748) requires credit unions to assess and address staffing and training needs for their information-security and e-commerce programs. The [FFIEC IT Examination Handbook](https://ithandbook.ffiec.gov/it-booklets/information-security/) reinforces the expectation that staff involved in e-commerce systems development, operation, and member support maintain current competencies.

**SYSTEM BEHAVIOR:** The credit union relies on its e-commerce system provider (Fiserv) for software development and support. The credit union assesses all personnel to determine whether special staffing or training needs exist for those involved in systems development, operation, and member support. Additional training is provided as deemed appropriate. Training needs are reassessed at least annually to keep pace with technological and personnel changes. The CCO owns the annual training needs assessment; the CIO/IT Department identifies technical training requirements; Deposit Operations identifies member-support training needs. Training completion is tracked per individual.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual training needs assessment due (`training.annual_due`) | Current staff roster for e-commerce roles, prior year training records (`training.completion_status`), technology change log, personnel changes (`employee.hired`, `employee.separated`) | Training needs assessment completed; training assignments created (`training.assignment.created`) for identified gaps | Annually (enforced by `training.annual_due_at`) |
| Training assignment completed (`training.completed`) | Assignee ID (`training.assignee_id`), module ID (`training.module_id`), completion date, assessment score (`training.assessment_score`) | Training completion recorded (`training.completion.recorded`) | Per assignment due date (enforced by `training.completion_due_at`) |
| New hire in e-commerce role (`employee.hired`) | Hire date (`training_detail.hire_date`), role (`user.role`), required curriculum (`training.required_curriculum`) | Onboarding training assigned (`training.assignment.created`); completion tracked | Within onboarding window (enforced by `training.newhire_due_at`) |

**ALERTS/METRICS:** Alert when `training.annual_due_at` lapses without a completed needs assessment. Alert when any e-commerce staff member has an overdue training assignment (`training.completion_due_at` breached without `training.completed`). Alert when a new hire in an e-commerce role has no training assignment within the onboarding window. Target: 100% of e-commerce staff current on required training; zero lapsed annual assessments.

---

## Governance & Sign-Off {#governance}

| Role | Party | Responsibility |
|---|---|---|
| Policy Owner | Patrick Wilson, Chief Compliance Officer | Maintains, updates, and enforces this policy; coordinates annual review |
| Approver | Patrick Wilson, Chief Compliance Officer | Approves policy revisions before Board submission |
| Board of Directors | Pynthia Credit Union Board | Approves written policy; reviews at least annually |
| CIO / IT Department | Chief Information Officer | Implements and operates technical controls; owns firewall, encryption, anti-virus, and access provisioning |
| Deposit Operations | Deposit Operations Manager | Administers enrollment application review and approval |
| Information Security | Information Security Officer | Owns security monitoring, SIEM, intrusion detection, and penetration testing program |

**Review cadence:** This policy is reviewed by management and modified as necessary at least annually, or sooner upon material changes in technology, services, regulatory requirements, or business arrangements. The Board approves the policy at least annually.

**Cross-references:**
- Electronic Payment Systems Policy (backend payment rails: ACH, wires, cards, bill pay, RDC)
- Information Security Policy (cybersecurity controls for online channels)
- BSA Policy (Customer Identification Program for online account opening)
- Privacy Policy (online privacy notices, cookies, third-party app connections)
- Third-Party Risk Policy (oversight of online-service vendors including Fiserv)
- Business Continuity Plan Policy (detailed BCP/DR procedures and RTO/RPO targets)
- Acceptable Use Policy (end-user policies referenced in EC-08)

---

## Assumptions & Gaps {#assumptions}

- **Engineering vocabulary is provisional.** Several event and field codes referenced in the control overlays above are composed from the registered vocabulary grammar but are not yet confirmed as registered in `core-vocabulary.json`. Specifically, the following codes are composed per the grammar and should be confirmed by engineering before the next review: `ecommerce.session_authenticated` (used in EC-03; `ecommerce.login_attempted` and `ecommerce.session_authenticated` are listed as `ecommerce` fields but not as registered events — the event form is composed as `ecommerce.session.authenticated` per grammar, but `ecommerce.audit_trail.recorded` is registered and used for the audit log); `enrollment.applicant_identity`, `enrollment.channel`, `enrollment.identity_evidence`, `enrollment.member_number_match` (the `enrollment` object and its fields are registered in DESIGN_NOTES and used as-is); `transaction.type` (listed as a provisional code — used as-is per provisional spelling). All other codes used in this document are either registered in the core vocabulary or listed in the Provisional codes section of DESIGN_NOTES and used with their agreed spelling.

- **Firewall review frequency not specified.** PATRICK_NOTES state firewalls are reviewed "periodically" without defining a specific interval. This policy uses "per internal security calendar" as the operative standard. The CCO and CIO should agree on a documented minimum frequency (e.g., quarterly) and record it in the security procedures. Until confirmed, the `firewall.review_due` timer cadence is assumed to be set by IT.

- **Penetration testing frequency.** PATRICK_NOTES and the REFERENCE_POLICY do not specify a minimum penetration testing frequency beyond the annual independent firewall review. This policy treats penetration testing as an annual engagement minimum, consistent with FFIEC expectations. If the credit union's risk assessment supports a different cadence, the `pentest.engagement_due` timer should be updated accordingly.

- **NCUA 72-hour breach notification applicability.** The NCUA cybersecurity incident notification rule (12 CFR Part 748, Appendix B, as amended) imposes a 72-hour notification requirement for certain reportable incidents, governed by [SC-01](#sc-01-ncua-reportable-cyber-incident-member-notification). The specific threshold for "reportable" incidents (material impact on members or operations) should be confirmed with legal counsel and documented in the Breach Response procedures referenced by this policy.
- **NCUA reportable-incident/member-notice mechanic is a single shared control.** [SC-01](#sc-01-ncua-reportable-cyber-incident-member-notification) is sourced verbatim — same control ID, title, and body — from [`shared-controls/ncua-incident-notification.md`](../shared-controls/ncua-incident-notification.md) and appears identically in Business Continuity Plan, E-Commerce, Electronic Payment Systems, Collections, Information Security, Privacy, and Third-Party Risk. Edit the shared source first, then propagate to all seven; do not edit SC-01 in this policy in isolation. EC-13 carries the detection/liability-assessment/external-comms material that used to be bundled into the old EC-10 control.

- **SecureWorks as SOC provider.** The REFERENCE_POLICY names SecureWorks as the 24/7 security operations center. This policy preserves that reference. If the provider changes, EC-09 should be updated and the vendor change processed through the Third-Party Risk Policy.

- **Fiserv password complexity rules subject to change.** EC-04 notes that password complexity rules are "subject to change as provided by core vendor." The credit union should establish a process to receive and implement Fiserv complexity updates promptly and update this policy within 30 days of any change. No assumption is made about the current Fiserv rule set beyond what is stated in PATRICK_NOTES.

- **Mobile banking channel.** The SCOPE statement includes mobile banking. The controls in this policy apply equally to mobile and online channels. If mobile introduces distinct authentication or enrollment flows (e.g., biometric authentication, device registration), those should be documented as addenda to EC-03 and EC-04 in the next review cycle. The `verification_biometric` object and related events are available in the registered vocabulary if needed.

- **E-SIGN Act consent.** The E-SIGN Act (15 USC §7001) is cited in EC-07 as authority for the enforceability of e-commerce agreements. The credit union's e-commerce member agreement should include an explicit E-SIGN consent capture. The `entity.esign_consent` field and `privacy.esign_consent.recorded` event are registered in the vocabulary and should be used if the system captures consent electronically. This is noted as a gap to confirm with Deposit Operations and Legal.

- **Reg E applicability.** Regulation E (12 CFR Part 1005) governs electronic fund transfers and error resolution for consumer accounts accessed through the e-commerce channel. Error resolution and dispute procedures for EFT transactions are out of scope for this policy (governed by the Electronic Payment Systems Policy), but the credit union should confirm that the EPS Policy cross-reference is current and that Reg E disclosures are delivered through the e-commerce channel as required. The `entity.reg_e_opt_in` field is registered in the vocabulary.

- **Board-only approval.** PATRICK_NOTES list Patrick Wilson as both Owner and sole Approver. For segregation-of-duties purposes, the credit union should consider whether a second approver (e.g., Board Chair or Audit Committee Chair) is appropriate for the next review cycle. This is flagged as a governance gap.
