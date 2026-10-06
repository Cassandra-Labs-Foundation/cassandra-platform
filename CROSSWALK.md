# CG-\* ↔ control catalogue crosswalk

> **Generated** by `scripts/build_crosswalk.py`. Do not edit by hand —
> edit `crosswalk-mappings.json` (judgments) or
> `crosswalk-emitted-events.json` (event inventory) and regenerate.

Catalogue: **316** distinct controls across **27** policies (333 rows — shared controls like SC-02 are replicated into every policy that references them, and are counted once here). 
Implemented: **10** `CG-*` controls. 
Event codes the core can emit: **810**. 
Distinct trigger events the catalogue demands: **787**.

## How to read this

This artifact is used to make regulatory coverage claims, so it is built
to **under-claim**. A verdict of `discharges` asserts that a catalogue
control needs no further work. **Nothing currently holds that verdict.**

| Verdict | Meaning |
|---|---|
| `discharges` | fully satisfies the catalogue control |
| `partially_discharges` | satisfies part — the gaps say exactly what is missing |
| `related` | same subject area, does **not** discharge |
| `no_catalogue_counterpart` | nothing in the catalogue corresponds |

Claims marked **needs review** are proposals awaiting a compliance
reviewer, not findings. A row is only load-bearing once `reviewed_by` is set.

## Evidence provenance

`control_result` rows are this repo's evidence artifact, and until
migration `20260719000900` nothing on the row recorded where it came
from. `analytics/seed.sh` drives the deployed API specifically to trip
every control, and the e2e harness fires 397 live assertions at the same
tables — so rows written before that migration are a mixture of real gate
decisions, demo seeding and test assertions with no way to tell them
apart. They are labelled `unknown`, which is the only claim the data
supports.

**Evidence written before the provenance migration cannot support a
coverage claim.** Simulated evidence lives in the `sim` schema and is
structurally unreachable from `core` — the check constraints make
`provenance = 'simulated'` unrepresentable in a core table, so it is not
a filter that could be forgotten. This build hard-fails if any
non-`production` row reaches a coverage count.

## Summary of claims

| Verdict | Claims |
|---|---:|
| `partially_discharges` | 8 |
| `related` | 4 |
| `no_catalogue_counterpart` | 2 |

Open questions requiring a decision: **20** (5 high severity).

Awaiting review: **0** of 14 claims. 
Reviewed: **14**.

## View 1 — what each implemented control discharges

### `CG-LGTXN-01`

*On any single money movement above $10,000 (1_000_000 cents) on any of the four rails, writes a control_result (decision 'pass') and opens a bsa_alert of type 'ctr_threshold' with requires_lookback=true. Does not block.*

Source: `core/supabase/functions/api/transfers.ts`

**BSA-08 — Currency Transaction Reporting (CTR)** → `related`

Shares the $10,000 threshold and the name, but is not the same control. A CTR obligation under 31 CFR 1010.311 attaches to CURRENCY transactions — physical cash in or out. CG-LGTXN-01 fires on book transfers, wires, ACH and card authorizations, none of which are currency transactions, so a CTR is not owed on any event it detects. Treating this as CTR coverage would claim a filing obligation is met that was never triggered, while leaving actual cash handling unmonitored.

Missing:

- wrong transaction class: BSA-08 aggregates ctr.cash_in_total / ctr.cash_out_total; the core has no cash-handling surface at all
- wrong aggregation unit: BSA-08 aggregates per person per business day; CG-LGTXN-01 evaluates a single transaction against one account
- no filing: BSA-08 requires e-filing to FinCEN within 15 calendar days (ctr.filing_timer); nothing files
- no exemptions: Phase I/II exemption handling, DOEP (FinCEN Form 110), annual exemption review are all absent
- required inputs unavailable: entity.tin and entity.name are not joined to the transaction

> Would discharge if: the core gains a cash-handling surface, per-person aggregation via entity linkage, and a FinCEN filing path. That is BSA-08 being implemented, not CG-LGTXN-01 being extended.

**BSA-06 — Transaction Monitoring & Case Management** → `partially_discharges`

BSA-06's first rule triggers on bsa_alert.created with inputs alert_type, entity_hash, event_id and requires_lookback. CG-LGTXN-01 writes exactly that row shape, so it genuinely performs the rules-based detection half of BSA-06 for one alert class. Everything downstream of the alert is absent. UPDATED: the downstream half now exists — alerts carry a 2-business-day triage deadline, escalate to a real core.case, and reach a documented SAR/no-SAR decision, with a sweep that surfaces breached timers. bsa_alert.event_id is populated (OQ-05 resolved), so the alert joins back to its causing event as BSA-06 requires. Still not a full discharge: see gaps.

Missing:

- covers three alert typologies (CTR threshold, inbound and outbound structuring) plus OFAC and unauthorized-ACH-return; BSA-06 expects monitoring across all typologies
- model-based monitoring is absent — detection is rules-based only
- no SAR committee: BSA-06 names BSA Officer + Compliance + counsel as the deciding body, and the actor model has no such roles (see OQ-08)
- covers one alert_type only; BSA-06 expects monitoring across all typologies

### `CG-STR-01`

*Sums same-day INBOUND book transfers to a destination account; when the aggregate crosses $10,000 with no single transfer above it, writes a control_result and opens a bsa_alert of type 'structuring'. Book transfers only — wires/ACH/card have no destination account row.*

Source: `core/supabase/functions/api/transfers.ts`

**BSA-06 — Transaction Monitoring & Case Management** → `partially_discharges`

Same basis as CG-LGTXN-01: it is genuine rules-based detection producing a conforming bsa_alert row, which is BSA-06's trigger. It adds an aggregation typology the per-transaction gate structurally cannot see. UPDATED: the downstream half now exists — alerts carry a 2-business-day triage deadline, escalate to a real core.case, and reach a documented SAR/no-SAR decision, with a sweep that surfaces breached timers. bsa_alert.event_id is populated (OQ-05 resolved), so the alert joins back to its causing event as BSA-06 requires. Still not a full discharge: see gaps.

Missing:

- covers three alert typologies (CTR threshold, inbound and outbound structuring) plus OFAC and unauthorized-ACH-return; BSA-06 expects monitoring across all typologies
- model-based monitoring is absent — detection is rules-based only
- no SAR committee: BSA-06 names BSA Officer + Compliance + counsel as the deciding body, and the actor model has no such roles (see OQ-08)
- inbound book transfers only: a member receiving structured deposits by ACH is not seen, because ACH has no destination account row in this core
- single-day window only; BSA-06 monitoring typically spans multi-day patterns
- per-account, not per-person: splitting across two accounts owned by the same member evades it entirely

**BSA-07 — SAR Filing & Confidentiality** → `partially_discharges`

UPGRADED from 'related'. The filing DECISION now exists: a case reaches file or no_file, both require a documented rationale (an undocumented no-file is refused rather than stored, which is BSA-07's retention requirement), the 30/60-day clock runs from detection rather than triage, and a late decision is recorded as late instead of silently accepted. Confidentiality is enforced structurally: case management is closed to partner actors and returns 404 rather than 403, so the existence of a case is not disclosed.

Missing:

- no actual FinCEN filing: sar.filed records the DECISION to file, not a submission
- no continuing-activity SAR timer (sar.continuing_timer) — 90-day continuing reviews absent
- no 314(a)/(b) disclosure-request handling (sar.disclosure_request.received)
- no SAR committee composition or Board reporting of filings
- retention of SAR records and supporting documentation is not implemented

### `CG-STR-02`

*Same as CG-STR-01 but on OUTBOUND daily volume, reusing the cross-rail velocity sum. Covers all four rails, since it keys on the source account.*

Source: `core/supabase/functions/api/transfers.ts`

**BSA-06 — Transaction Monitoring & Case Management** → `partially_discharges`

As CG-STR-01. Broader than its inbound twin because it aggregates across all four rails rather than book transfers only. UPDATED: the downstream half now exists — alerts carry a 2-business-day triage deadline, escalate to a real core.case, and reach a documented SAR/no-SAR decision, with a sweep that surfaces breached timers. bsa_alert.event_id is populated (OQ-05 resolved), so the alert joins back to its causing event as BSA-06 requires. Still not a full discharge: see gaps.

Missing:

- covers three alert typologies (CTR threshold, inbound and outbound structuring) plus OFAC and unauthorized-ACH-return; BSA-06 expects monitoring across all typologies
- model-based monitoring is absent — detection is rules-based only
- no SAR committee: BSA-06 names BSA Officer + Compliance + counsel as the deciding body, and the actor model has no such roles (see OQ-08)
- single-day window only
- per-account, not per-person

### `CG-OFAC-01`

*Runs first on every verification path and is decisive — no attestation, forced simulation outcome or provider choice can override it. Writes a control_result on EVERY run including clean passes. On a hit: denies the verification and opens a bsa_alert of type 'ofac'.*

Source: `core/supabase/functions/api/kyc.ts`
  · screening function: `/\bSDN\b/i tested against entity.name`

**BSA-05 — OFAC Screening & Holds** → `related`

This is the mapping most at risk of being over-claimed, so it is stated bluntly: the enforcement MECHANISM is real and well built — always-on, unbypassable, evidence on every run — but the SCREEN is a sandbox stub. It matches the literal token 'SDN' in a name against no list at all. A control whose comparison set is empty cannot discharge a screening obligation no matter how sound the plumbing around it is. The mechanism is worth crediting; the coverage is zero.

Missing:

- no sanctions list: matches a name marker, not SDN/CONS/NS-PLC or any other list; ofac.list_version is never recorded
- not run on payments: BSA-05 triggers on wire_transfer.submitted for beneficiary and originator screening; CG-OFAC-01 runs only on verification, so no wire, ACH or card payment is screened at all
- no 50% rule: entities 50%+ owned by a blocked person are not derived, though core.entity.owners holds the ownership data that would allow it
- no hold: BSA-05 requires ofac.hold.placed and segregation of blocked funds; the verification is denied but no funds are held
- no adjudication: no Sanctions Analyst routing, no 1-business-day SLA, no false-positive clearing with documented rationale
- no reporting: OFAC Reporting System filing within 10 business days and the annual blocked-property report (by Sept 30) are absent
- beneficial owners and counterparties are not screened, only the entity itself

> Would discharge if: a real list with version tracking is wired into ofacScreen(), screening is added at payment submission, and the hold/adjudication/reporting workflow exists. The always-on floor design means the first of those is a genuinely small change with a large coverage effect.

**LP-11 — OFAC & Sanctions Gate (lending)** → `related`

LP-11 gates loan origination on sanctions screening. The lending subsystem does not exist — core.loan and core.loan_application are schema-only with no writer — so there is no origination path for this control to gate. Listed so the mapping is not silently forgotten when lending is built.

Missing:

- no lending subsystem: no writer for loan or loan_application
- same screening-stub limitation as BSA-05

### `CG-VEL-01`

*Blocks any money movement that would push the source account's same-day outbound volume above $25,000, aggregated across all four rails. The only CG-* control that BLOCKS rather than observes.*

Source: `core/supabase/functions/api/transfers.ts`

**no catalogue counterpart** → `no_catalogue_counterpart`

No control among the 333 imposes a per-account daily transaction cap. Searching the catalogue for velocity / daily limit / transaction limit returns only MP-05 (Account Restrictions and Closures, which is about restricting an account after a member-conduct decision, not a standing volume ceiling) and TIS-02 (Pre-Opening Account Disclosures, which is about disclosing limits, not enforcing them). CG-VEL-01 is a safety-and-soundness engineering control the institution chose, not a policy obligation the corpus demands.

Candidates examined and rejected: `MP-05`, `TIS-02`

> Implication: It should not appear in a regulatory coverage claim at all. If the $25,000 cap is intended to be a member-facing account limit, TIS-02 may create a DISCLOSURE obligation for it — that is the reverse direction from coverage and is worth a compliance opinion.

### `CG-NSF-01`

*Reads the live Blnk balance and rejects the movement when available funds are below the amount. Writes a control_result with decision 'reject'.*

Source: `core/supabase/functions/api/transfers.ts`

**no catalogue counterpart** → `no_catalogue_counterpart`

Refusing to overdraw an account is basic ledger correctness, not a compliance control. The catalogue's overdraft-related controls are all about DISCLOSURE or COLLECTION, never about refusal: TIS-08 (Overdraft Service Disclosures) and TIS-05 (Periodic Statement Disclosures) govern what must be told to the member, and CO-10 (Overdraft Collections and Fee Waiver Practices) governs what happens after an overdraft occurs. None is discharged by declining the transaction.

Candidates examined and rejected: `TIS-08`, `TIS-05`, `CO-10`

> Implication: Because this core refuses overdrafts outright, TIS-08 and CO-10 may be entirely inapplicable rather than unimplemented — there is no overdraft service to disclose and no overdraft to collect. That is a scoping question for compliance, and answering it would remove two controls from the backlog rather than adding them.

### `CG-CASH-01`

*Records currency movement (cash_in/cash_out) against a person, aggregates per person per business day with cash-in and cash-out assessed SEPARATELY, opens a CTR obligation with a 15-calendar-day clock when either direction exceeds $10,000, and surfaces currency that cannot be attributed to a person as an explicit finding rather than dropping or mis-bucketing it.*

Source: `core/supabase/functions/api/cash.ts`

**BSA-08 — Currency Transaction Reporting (CTR)** → `partially_discharges`

This is the first thing in the core that represents CURRENCY, which is what a CTR obligation under 31 CFR 1010.311 actually attaches to — and therefore the first control that can genuinely address BSA-08 (see OQ-01, where CG-LGTXN-01 was found to fire only on non-reportable electronic movements). It aggregates ctr.cash_in_total and ctr.cash_out_total per person per business day, keeps the two directions separate so a $6k deposit plus a $6k withdrawal does not manufacture a false obligation, fires ctr.threshold.reached (BSA-08's declared trigger), and starts the 15-day ctr.filing_timer. Currency that cannot be attributed to a person is counted and reported as unattributable rather than silently dropped or bucketed as its own person — both of which would understate the aggregate and hide obligations.

Missing:

- no actual FinCEN transmission: ctr.filed records the DECISION and a reference, not a submission
- no exemptions: Phase I/II handling, DOEP (FinCEN Form 110) and annual exemption review are absent — exemption_basis is stored but never evaluated (OQ-13)
- entity.tin and entity.name are required inputs of BSA-08 and are reachable via the entity link, but the filing does not yet populate them
- legacy accounts have no owning entity (OQ-12), so their currency is unattributable and no CTR determination exists for it — visible, but a real coverage hole
- no backfilling coordination with the FinCEN Help Line
- cash OPERATIONS controls (CP-01..CP-12: vault limits, dual control, reconciliation, over/short) are a separate domain built on this ledger and do not exist yet

> Would discharge if: a FinCEN transmission path, exemption evaluation, and complete entity linkage exist. The detection and timing half is now real.

### `CG-DUAL-01`

*Maker-checker on payment origination. Wire dual control is unconditional (EPS-06 states it as required): a wire cannot reach 'completed' without an approver distinct from its preparer, enforced by ck_wire_dual_control_before_complete. ACH is threshold-based per client; with no configured limit the batch is recorded UNASSESSED rather than exempt or required, and appears in GET /eps/pending-approvals as such.*

Source: `core/supabase/functions/api/eps.ts`

**EPS-06 — Dual Control for High-Risk Processes** → `partially_discharges`

This control corrected the API rather than fitting into it. The two-phase wire prepare/confirm split looked like dual control and was not — it required two CALLS, not two PEOPLE, and any single token could do both. Confirm now demands a distinct approver, enforced by a CHECK constraint so it holds against service_role. The four-eyes rule is expressed once in core.payment_approval rather than repeated per table, which is the reusable form of what ck_case_four_eyes did bespokely for SAR decisions.

Missing:

- the ACH per-client threshold is unconfigured, so ACH batches are UNASSESSED rather than assessed — the mechanism works, the policy values are missing (OQ-14)
- no offline callback approval with PIN, which EPS-06 offers as the alternative to dual control for wires
- no user limits below client limits — EPS-06 describes a two-level limit hierarchy and only the client level exists
- no pre-defined file templates restricting file creation
- internal Fedwire processing (Payments Exchange user ID / passcode / token) is not modelled
- eps.pospay_exception.presented and eps.wire_release.requested have no writer

### `CG-GOV-01`

*One obligation register for the catalogue's 83 time-based triggers. Each obligation carries a cadence and an optional anchor; the sweep fires the CONTROL'S OWN declared trigger code when it comes due, emits an overdue event when nobody completed it, and reports unanchored obligations as UNSCHEDULED — a distinct state from both 'not due' and 'overdue'. Completion advances from the DUE date, never from the completion date.*

Source: `core/supabase/functions/api/governance.ts`

**bsa:BSA-16 — Independent Testing** → `partially_discharges`

BSA-16's triggers are audit.cycle_timer, audit.report.issued and audit.remediation.due — a cadence, a deliverable and a follow-up clock. The calendar supplies the cadence half honestly: registering the obligation and anchoring it makes audit.cycle_timer fire when the cycle genuinely opens, with an overdue event if nobody acts. Cited by uid because control ids are not unique (OQ-11). Chosen as the single claim for this machinery rather than claiming all 83 time-triggered controls, because the register is empty until obligations are actually registered.

Missing:

- the obligation is UNSCHEDULED until someone supplies the anchor date — the cadence is known, the cycle start is not (OQ-15)
- audit.report.issued and audit.remediation.due have no writer: the calendar starts the cycle, nothing records the report or tracks remediation
- no scope, no independence assessment, no auditor qualification checks
- 82 other time-triggered controls could use this machinery and none are registered, so none are claimed

> Would discharge if: the audit deliverable and remediation tracking exist, and the obligation is anchored to a real cycle start.

### `CG-LEND-01`

*Loan origination spine. Records the final action on an application; queues an adverse action notice on any adverse outcome with the ECOA clock anchored on APPLICATION COMPLETION rather than the decision date; requires second-level review by a different actor before the notice may be issued; screens every loan party on add and blocks funding on a potential match. A sweep surfaces notices nobody sent and parties nobody screened.*

Source: `core/supabase/functions/api/lending.ts`

**lending:LP-07 — Adverse Action & Notifications** → `partially_discharges`

The AAN is queued automatically on an adverse decision (aan.queued), carries specific reasons enforced at decision time rather than reconstructed later, runs a 30-day ECOA clock anchored on completion, and cannot be issued without second-level review by a different actor — enforced by ck_aan_reviewed_before_issue because an issued notice cannot be recalled. The overdue sweep surfaces notices nobody sent.

Missing:

- counteroffer EXPIRY does not queue a notice: LP-07 requires it and there is no counteroffer timer
- ECOA content is recorded as flags (credit_score_disclosed, cra_disclosure_included) but never validated — nothing checks the notice actually contains what it claims
- no fair-lending consistency check in the second review; the reviewer role is not constrained to Compliance or senior underwriting (the actor model has no such roles — same shape as OQ-08)
- no delivery: aan.issued records the decision to issue, not transmission to the applicant

**lending:LP-11 — OFAC & Sanctions Gate** → `related`

The MECHANISM is real and was the architecturally missing half of OQ-02: parties are screened on add, a potential match blocks funding rather than the application, an alert is raised, and 'unscreened' is a distinct state from 'clear' so an unscreened party cannot be funded. But the screen it calls is still the sandbox stub — /\bSDN\b/i against a name, with no list and no ofac.list_version. Verdict stays `related` for the same reason CG-OFAC-01's does: a screen with an empty comparison set discharges nothing however sound the blocking around it is. Every party row records list_version NULL so the gap is visible in the data.

Missing:

- no sanctions list and no list version — the screen is a stub (OQ-02, domain-blocked)
- no 50% rule derivation for entity ownership
- clearance of an apparent match has no documented-rationale requirement yet (loan_party.ofac_result is unwritten)
- no re-screening when the list updates, because there is no list

> Would discharge if: a real versioned list is wired into ofacScreen(). The blocking, the alerting and the unscreened/clear distinction are already in place, so this is a genuinely small change with a large coverage effect.

### Excluded

- `CG-NOPE-99` — Test sentinel, not a control. Exists so the gate's unknown-control path is exercised; never evaluated against real traffic.

## Open questions

Places where the catalogue is ambiguous, a CG-\* control does not
cleanly correspond to anything, or a mapping turns on a decision that
is not mine to make. Deliberately not smoothed over — several change
what the crosswalk should say.

### OQ-01 · high — Is CG-LGTXN-01 misnamed, and does that misname a coverage claim?

**Finding.** A CTR obligation attaches to CURRENCY transactions. CG-LGTXN-01 fires only on electronic movements (book, wire, ACH, card), none of which are CTR-reportable. The control detects large electronic transfers — a legitimate monitoring signal — but its name asserts a filing regime it has nothing to do with.

**Why it matters.** The name alone is enough to produce a false coverage claim in a review: someone scanning for CTR coverage finds CG-LGTXN-01 and stops. Meanwhile actual cash handling, which is what BSA-08 governs, is unmonitored because the core has no cash surface at all.

**Asks of reviewer.** Confirm the reading, then decide whether to rename (e.g. CG-LGTXN-01) or to keep the name and record explicitly that it does not address BSA-08.

### OQ-02 · high — Should CG-OFAC-01 be described as a control at all while its screen is a stub?

**Finding.** The enforcement mechanism is genuinely strong — always-on, unbypassable by attestation or forced outcome, evidence written on every run including clean passes. The screen underneath it is `/\bSDN\b/i` against the entity name. There is no list, no list version, and no screening at payment submission, which BSA-05 requires via wire_transfer.submitted.

**Why it matters.** This is the single most over-claimable row in the artifact. The plumbing looks like a finished control and reads like one in code review. An auditor who accepts the mechanism without inspecting ofacScreen() would conclude sanctions screening exists.

**Asks of reviewer.** Confirm `related` (not `partially_discharges`) is the right verdict while the list is absent. Also decide whether the OFAC floor should be marked non-production until a real list is wired — this interacts with roadmap item 50.

### OQ-12 · high — Accounts have no owning entity, which blocks per-person cash aggregation.

**Finding.** BSA-08 aggregates cash 'per person per business day' and names entity.name and entity.tin as required inputs. core.account had no link to core.entity of any kind. Migration 20260719001300 adds account.entity_id (nullable, FK) and POST /accounts now accepts it, but EXISTING accounts are unlinked and cannot be backfilled truthfully — nothing in the data says which member owns which account, and inventing the link would fabricate a member relationship.

**Why it matters.** This was found while sequencing cash and it changed the order. Building cash without it would aggregate per ACCOUNT, which is the exact defect already recorded against CG-STR-01 ('splitting across two accounts owned by the same member evades it entirely') — reproduced at birth, in the one control where that evasion IS the behaviour being detected. Linking accounts also retroactively lets CG-STR-01/02 move from per-account to per-entity.

**Asks of reviewer.** Existing accounts need linking by someone who knows the answer, or the demo accounts discarded. Until then entity_id stays nullable and unlinked accounts sit outside CTR aggregation. Query them with: select count(*) from core.account where entity_id is null;

### OQ-14 · high — Per-client ACH dual-control thresholds and exposure limits are unset, so ACH batches are UNASSESSED.

**Finding.** EPS-06 says dual control is 'recommended for clients originating over $50,000 per batch' and that 'client exposure limits are assigned by the Credit Union'. Both the threshold and whether it applies are per-client configuration this repo does not hold. The mechanism is built (PUT /eps/client-limits/{partner_id}) and until it is called for a partner, that partner's ACH batches carry dual_control_status='unassessed' and appear in GET /eps/pending-approvals under a separate unassessed count with an explicit warning.

**Why it matters.** Unassessed is deliberately not 'exempt' and not 'required'. Treating an unconfigured client as exempt fails OPEN — a $2m batch would originate with no second pair of eyes and nothing would say so. Treating it as required fails closed on a number nobody chose and blocks every client until configured. Both were mutation-tested. The $50,000 figure in the policy is explicitly a recommendation, not a rule, so it must not be hardcoded as one.

**Asks of reviewer.** The actual per-client thresholds, or a decision that a single institution-wide default applies. Once set via the endpoint, every subsequent batch is assessed; existing unassessed rows stay unassessed because re-deciding them retroactively would be inventing a determination that was never made.

### OQ-15 · high — The governance calendar has no anchor dates, so every obligation is UNSCHEDULED.

**Finding.** 83 of the catalogue's triggers are time-based and share one shape, so one register serves them all. But a cadence needs an anchor — when the fiscal year starts, when the last board review happened, when the training cycle opens. Those are facts only the institution holds. An obligation registered without one is UNSCHEDULED: it never comes due, and POST /governance/calendar/sweep reports it under a separate count with an explicit warning rather than letting it sit among the not-due.

**Why it matters.** Unscheduled is the most dangerous absence in the repo so far, because it is INVISIBLE BY SHAPE. An overdue obligation appears on a list. An unscheduled one has nothing outstanding — from any distance it looks exactly like an obligation that is up to date. That is why it gets its own count and its own warning rather than being folded into 'not due'.

**Asks of reviewer.** Anchor dates per obligation, and which of the 83 time-triggered controls are live obligations at all. Registering all 83 automatically was deliberately NOT done — it would assert the institution has 83 live obligations, which nobody has said.

### OQ-03 · medium — Two implemented controls answer to nothing in the catalogue. Is the catalogue incomplete, or are they out of scope?

**Finding.** CG-VEL-01 (daily $25k cap) and CG-NSF-01 (overdraft refusal) have no counterpart among the 333. The nearest catalogue entries govern disclosing or collecting overdrafts (TIS-08, TIS-05, CO-10) and restricting accounts after a conduct decision (MP-05) — none is discharged by refusing a transaction.

**Why it matters.** Either the corpus is missing safety-and-soundness controls it should contain, or these are engineering choices that should never appear in a compliance claim. The two readings lead to opposite backlog decisions.

**Asks of reviewer.** Decide which. If the latter, they should be excluded from coverage reporting entirely rather than sitting unmapped.

### OQ-04 · medium — Does refusing overdrafts make TIS-08 and CO-10 inapplicable rather than unimplemented?

**Finding.** CG-NSF-01 declines any movement that would overdraw. If the product genuinely offers no overdraft service, there is nothing to disclose under TIS-08 and nothing to collect under CO-10.

**Why it matters.** This is the one place the crosswalk might REMOVE work from the backlog rather than add it. Two controls could be scoped out with a documented rationale instead of built.

**Asks of reviewer.** A scoping opinion. Note this is contingent on the product never offering overdraft, which is a business decision, not a code fact.

### OQ-09 · medium — BSA-07's SAR committee is recorded but not enforced. Is that the right line?

**Finding.** case.concurred_by records who concurred in a filing decision, but nothing enforces quorum or committee composition. A SAR can be filed by a lone BSA Officer with no concurrence at all.

**Why it matters.** BSA-07 says a committee of BSA Officer, Compliance and counsel 'makes the filing decision'. Whether that is a system obligation or an organizational one is a genuine judgment: enforcing quorum in software would block a legitimate filing when counsel is unavailable, and the deadline does not pause for that.

**Asks of reviewer.** Decide whether quorum should be enforced, advisory, or left organizational. The data to enforce it is already being captured either way.

### OQ-10 · medium — Retention clocks are only set for two record classes, so most of BSA-21's schedule has no writer.

**Finding.** setRetentionClocks fires on account.closed and creates cip_identity and beneficial_owner records — the two classes anchored on closure. The other seven classes (CIP verification, CTR, SAR, monetary instrument, wire transfer, CMIR, OFAC blocked) anchor on their own creation dates and would need a clock set at the point each record is made. Some of those hook points exist now (core.ctr_filing, and the filing table carries a cmir type) but set no clock at creation; others (monetary instrument log) still do not exist.

**Why it matters.** The retention MECHANISM is complete and enforced — schedule, holds, three-condition disposal, irreversibility. What is partial is coverage: a wire transfer today starts no retention clock, so SC-02's lifecycle applies to nothing on that rail. Reading 'retention is implemented' off the mechanism would over-claim.

**Asks of reviewer.** None immediately. Recorded so BSA-21's crosswalk verdict is not read as broader than it is; each remaining class arrives with its own subsystem.

### OQ-11 · medium — PARTLY RESOLVED — control_id collisions are a CORPUS defect, not an extractor bug.

**Finding.** Diagnosed at source. capitalization.md line 39 defines '## CP-01 - Capital Adequacy Targets'; cash.md line 47 defines '## CP-01 - Governance and Delegation'. Both policy documents independently chose the CP- prefix, and the extractor is reading exactly what is written — it is not merging anything. Ten ids collide (CP-01..CP-10). Separately, STATUS.md records the cash policy as carrying controls CA-01..CA-12, and no CA- id exists in cash.md at all: the cash regeneration appears to have changed its control prefix from CA- to CP- and that is what created the collision with capitalization.

**Why it matters.** Containment is now in place — the extractor emits a globally unique `uid` (policy:control_id), reports collisions in controls.json, and the crosswalk refuses a claim citing a colliding bare id while accepting a uid-qualified one. 333 rows now carry 333 distinct uids. But the underlying corpus is still wrong: two documents claim the same control numbers, and any human citing 'CP-03' in a memo or an examination response is ambiguous in a way no tooling can fix.

**Asks of reviewer.** Decide which policy renumbers. STATUS.md suggests cash was meant to be CA-, so restoring that is the smaller change. Also worth adding a prefix-collision check to the regeneration pipeline, since this was introduced by a regeneration and nobody noticed.

### OQ-13 · medium — CTR exemptions are stored but never evaluated.

**Finding.** BSA-08 describes Phase I exemptions (banks, government entities, listed companies) and Phase II (eligible non-listed businesses, payroll customers) with DOEP filing on FinCEN Form 110 and annual eligibility review. core.ctr_filing has an exemption_basis column and nothing reads it — every threshold crossing opens a filing obligation regardless of whether the person is exempt.

**Why it matters.** Failing OPEN, which is the safe direction: an exempt customer generates a CTR obligation that a human can dismiss, rather than an exempt determination silently suppressing a filing that was actually owed. But it means the CTR queue will contain avoidable work, and the annual exemption review (ctr.exemption.review.due) has no writer at all.

**Asks of reviewer.** Whether Pynthia intends to operate exemptions at all. Many small institutions do not, in which case this is scoped out rather than unimplemented — the same question as OQ-04 on overdraft.

### OQ-16 · medium — The eps governance controls do NOT fall out of the obligation register — my resequencing rationale was wrong.

**Finding.** Tier D was resequenced ahead of loan on the argument that the governance-calendar machinery would unlock the remaining eps controls too. It does not. Only 3 of ~30 triggers across EPS-01/03/04/08/09/10/11 are timer-shaped (eps.vendor_dd_cycle.opened, eps.training_annual_cycle.opened, eps.training_employee_cycle.opened). The rest are WORKFLOW triggers — eps.proposal.submitted, eps.control_review.opened, eps.board_report.delivered, eps.deployment.scheduled — which need proposal, review, board-reporting and deployment pipelines, not a calendar.

**Why it matters.** Tier D was still correct to build: it is honest, cheap and serves 83 catalogue triggers. But it does not shorten eps, and no work was manufactured to pretend otherwise. Registering the 3 timer-shaped eps obligations was also declined because registration is configuration nobody has supplied (OQ-15) and would have produced two more deeply-incomplete controls for appearance.

**Asks of reviewer.** None. Recorded because the resequencing argument is in the session record and was wrong; the eps governance controls remain unbuilt and need their own subsystems.

### OQ-18 · medium — The four money rails hardcode db.schema("core") and take no scope parameter.

**Finding.** transfers.ts, wires.ts, ach.ts and cards.ts write to core unconditionally. Every module built afterwards — bsa, cash, retention, governance, lending, eps, primitives — takes `scope: EvidenceScope`. Found by the drill, which could not point the rails at sim and had to seed both schemas.

**Why it matters.** Six modules can be exercised in isolation and four cannot. Any future work that needs the rails driven against a substrate — a larger drill, a tenant migration rehearsal, a replay harness — hits this first. It is also an inconsistency a new contributor will trip over, since the rails look like the reference implementation.

**Asks of reviewer.** None; engineering. Thread `scope` through the four rails the way every later module does.

### OQ-19 · medium — The gate returns on the FIRST blocking control, so only one control_result is ever written.

**Finding.** Drill case RAIL-02 moved an amount that was both over the $25k velocity cap and beyond the available balance. runGate evaluates velocity first and returns immediately, so CG-VEL-01 wrote evidence and CG-NSF-01 never ran. The transaction was correctly refused; the evidence record shows one control firing where two would have.

**Why it matters.** An examiner asking 'did NSF checking run on this transaction' finds no control_result for it, and cannot distinguish 'ran and passed' from 'never ran'. That is the exact ambiguity control_result exists to remove — the same reasoning that made CG-OFAC-01 write evidence on clean passes. The refusal is right; the evidence is incomplete.

**Asks of reviewer.** Whether the gate should evaluate ALL controls and return the aggregate, rather than short-circuit. Evaluating all costs an extra Blnk balance call on a doomed transaction; short-circuiting costs evidence completeness.

### OQ-06 · low — The catalogue's own trigger vocabulary is inconsistent, which weakens reachability as a measure.

**Finding.** Some control_rules carry trigger_event: null (a rule with inputs and outputs but nothing that starts it). Others use namespaces that no subsystem could plausibly own. Reachability treats a null trigger as unreachable, which is conservative but conflates 'blocked on a subsystem' with 'the catalogue does not say'.

**Why it matters.** Reachability counts are only as good as the trigger declarations. The headline numbers are directionally right but should not be quoted to a decimal.

**Asks of reviewer.** None immediately — flagged so the numbers are not over-read. Fixing it means editing the policy corpus, not this artifact.

### OQ-07 · low — RESOLVED — BSA-21's reachability is no longer a singleton headline.

**Finding.** When recorded, BSA-21 (Record Retention) was the only fully reachable control and could not emit record.retention_anchor or record.retention_clock_set. Both have writers now, BSA-21 is completable, and reachability is no longer a count of one — see crosswalk.json's reachability view for the current numbers.

**Why it matters.** Kept for the narrative: it documents why the reachable count was once treated with suspicion. The caution it encoded — read reachable together with completable — still applies.

**Asks of reviewer.** None. Historical.

### OQ-05 · low — RESOLVED — bsa_alert.event_id is populated.

**Finding.** raiseAlert() now writes the causing core.event first and points the alert at it. The event's code is bsa_alert.created, which is BSA-06's declared trigger, so raising an alert fires the event the catalogue says starts case management rather than merely resembling it. Alert ids are deterministic per D26.

**Why it matters.** Closed. Recorded here so the resolution is auditable rather than silently disappearing from the list.

**Asks of reviewer.** None — verification only.

### OQ-08 · low — RESOLVED — segregation of duties is representable and enforced.

**Finding.** api_token.roles carries a closed four-value vocabulary (bsa_investigator, bsa_officer, bsa_compliance, bsa_counsel). core.case records opened_by and decided_by, and ck_case_four_eyes enforces that they differ. The constraint is a CHECK, so it holds against service_role and a psql session — RLS was not needed, because the property is relational (two columns must differ) rather than row-visibility.

**Why it matters.** Closed. Deliberately not a general RBAC system: four named roles, two hardcoded gates, one constraint.

**Asks of reviewer.** Confirm the four roles match how the institution actually staffs these duties.

### OQ-17 · low — core.payment_approval is now misnamed — it is a general four-eyes register.

**Finding.** The table was introduced for EPS-06 payment dual control. LP-07's adverse-action second review is the third use of the same property, and its resource_type enum now carries adverse_action_notice, which is not a payment. Two of the three domains using it are not payments.

**Why it matters.** Naming debt only — the constraint and behaviour are correct. But a table called payment_approval holding adverse action notices will mislead the next reader, and the rename is FREE right now because the migration has never been applied.

**Asks of reviewer.** None; engineering cleanup. Rename to four_eyes_approval before first apply, or accept the name and document it.

### OQ-20 · low — Repeated attempts against the velocity cap leave no aggregate signal.

**Finding.** A rejected transaction correctly does not count toward same-day volume, so an actor blocked at $27k can immediately succeed with a smaller amount. Each rejection is individually evidenced, but nothing detects 'this account attempted eight blocked movements today'.

**Why it matters.** Attempted volume is a stronger evasion signal than settled volume, and repeatedly probing a cap is exactly the behaviour structuring detection is meant to catch. Not a defect in CG-VEL-01 — counting rejected attempts toward the cap would lock a member out after one mistake — but a gap between the two controls.

**Asks of reviewer.** Whether repeated velocity rejections should raise their own alert typology.

## View 2 — which catalogue controls are reachable

**Reachable** means the core can fire *every* trigger the control
declares. Partial reachability is its own category: a control whose
triggers are half firable is blocked, not half-done.

| Reachability | Controls |
|---|---:|
| `reachable` | 77 |
| `partially_reachable` | 121 |
| `unreachable` | 118 |

**Completable: 60.** Reachability only asks whether the
core can *start* a control. A control can be startable and still have no
way to signal its own outputs — BSA-21 scores fully reachable because its
one trigger is `account.closed`, while the retention schedule, legal holds
and disposal workflow it describes exist nowhere. `completable` means every
trigger fires **and** every produced event can be emitted. Use that number,
not the reachable one, when estimating what is buildable.

### Fully reachable (77)

| Control | Policy | Title | Triggers | Completable | Cannot emit |
|---|---|---|---|---|---|
| `AU-03` | audit | Internal Auditor Independence and Reporting | `audit.engagement.started` | **no** | `audit.gap.detected`, `auditor.access.denied`, `auditor.independence_attestation` |
| `AU-05` | audit | Audit Types and Network Assessments | `audit.engagement.started`, `audit.fieldwork.completed`, `audit.plan_cycle.opened` | **no** | `audit.scope_change.documented` |
| `AU-06` | audit | Audit Reporting and Work Papers | `audit.fieldwork.completed`, `audit.report.issued` | **no** | `audit.management_responses.received` |
| `AU-07` | audit | Finding Tracking and Escalation | `finding.aging_threshold.breached`, `finding.monthly_review.recorded`, `finding.opened`, `finding.quarterly_report.delivered` | yes | — |
| `BA-01` | basel-ii-standardized-approach-framework | Minimum Capital Requirements | `capital.contingency.activated`, `capital.pca_threshold.breached`, `capital.ratios.verified`, `capital.target.breached` | yes | — |
| `BA-03` | basel-ii-standardized-approach-framework | Risk-Weighted Assets Computation | `rwa.mapping_run.started`, `rwa.trading_threshold_crossed` | yes | — |
| `BA-06` | basel-ii-standardized-approach-framework | Buffer Ratios | `capital.buffer.breached`, `capital.buffer_status.recorded`, `capital.credit_growth_threshold_crossed`, `capital.distribution_restriction.applied` | yes | — |
| `BSA-06` | bsa | Transaction Monitoring & Case Management | `bsa_alert.created`, `case.investigation_complete` | yes | — |
| `BSA-07` | bsa | SAR Filing & Confidentiality | `case.investigation_complete`, `sar.continuing_timer`, `sar.disclosure_request.received` | **no** | `retention.purge.executed` |
| `BSA-10` | bsa | Travel Rule (Wires ≥$3,000) | `wire_transfer.submitted` | **no** | `retention.purge.executed` |
| `BSA-11` | bsa | Information Sharing (314(a)/314(b)) | `regulator.request.received` | **no** | `filing.fincen_314a` |
| `BSA-12` | bsa | CMIR (Cross-Border Currency) | `cmir.reportable.identified` | **no** | `retention.purge.executed` |
| `BSA-18` | bsa | PEP Screening & EDD | `pep.designated`, `pep.hit`, `pep.refresh.completed`, `verification.created` | yes | — |
| `BSA-21` | bsa | Record Retention | `account.closed` | yes | — |
| `BC-06` | business-continuity-plan | Incident Declaration and Initial Actions | `incident.contained`, `incident.declared`, `incident.first_hour.completed`, `sitrep.issued` | **no** | `sitrep.v1_timer` |
| `SC-01` | business-continuity-plan | NCUA Reportable Cyber-Incident & Member Notification | `incident.member_impact.confirmed`, `incident.reportability_determination` | yes | — |
| `BC-13` | business-continuity-plan | Post-Incident Review (PIR) | `cap.approved`, `cap.retest.verified`, `incident.closed`, `pir.drafted` | yes | — |
| `CP-01` | capitalization | Capital Adequacy Targets | `capital.ratios.verified`, `capital.targets.approved` | yes | — |
| `CP-02` | capitalization | Capital Components and Measurement | `capital.ratios.verified` | yes | — |
| `CP-03` | capitalization | PCA Thresholds and Internal Triggers | `capital.internal_trigger.breached`, `capital.pca_response.recorded`, `capital.pca_threshold.breached` | yes | — |
| `CP-04` | capitalization | Capital Conservation Buffer | `capital.buffer_status.recorded`, `capital.distribution_restriction.applied`, `capital.restricted_distribution.decided` | yes | — |
| `CP-05` | capitalization | Capital Planning | `capital.plan.presented`, `capital.plan.reviewed`, `capital.plan.updated` | yes | — |
| `CP-06` | capitalization | Capital Stress Testing | `capital.stress_report.issued`, `capital.stress_report.presented`, `capital.stress_report.reviewed` | yes | — |
| `CP-07` | capitalization | Quarterly Monitoring and Reporting | `capital.quarterly_report.issued`, `capital.quarterly_report.reviewed` | yes | — |
| `CP-08` | capitalization | Contingency Actions and Escalation | `capital.board_escalation.issued`, `capital.contingency_action.executed`, `capital.contingency_memo.issued` | yes | — |
| `CP-09` | capitalization | Capital Actions Governance | `capital.action.executed`, `capital.action.proposed`, `capital.action_board.decided` | yes | — |
| `CP-10` | capitalization | Internal Capital Adequacy Assessment (ICAAP) | `capital.icaap.presented`, `capital.icaap.reviewed`, `capital.icaap_cycle.opened`, `capital.icaap_report.issued` | yes | — |
| `CA-03` | cash | Enterprise Cash Limit | `cash.enterprise_limit.breached`, `cash.enterprise_limit.warning`, `cash.enterprise_position.posted`, `cash.limits_schedule.updated` | yes | — |
| `CDA-03` | charitable-donation-accounts | Structure & Segregation | `cda.evidence_packet.filed` | yes | — |
| `CDA-14` | charitable-donation-accounts | Communications & Accessibility | `cda.communication.drafted`, `cda.communication.published` | yes | — |
| `CO-06` | collections | Consumer Complaint Intake & Resolution | `complaint.direct.received`, `complaint.investigation.completed`, `complaint.regulator.received`, `complaint.trend.reported` | yes | — |
| `SC-03` | e-commerce | Enterprise Incident Declaration & First-Hour Response | `incident.contained`, `incident.declared`, `incident.first_hour.completed`, `sitrep.issued` | **no** | `sitrep.v1_timer` |
| `EPS-01` | electronic-payment-systems | Planning and Feasibility Analysis | `eps.erm_review.decided`, `eps.product_risk_analysis.drafted`, `eps.proposal.submitted`, `eps.service.activated` | yes | — |
| `EPS-03` | electronic-payment-systems | Internal Routines and Controls | `eps.control_review.completed`, `eps.control_review.opened`, `eps.deficiency_remediation.opened` | yes | — |
| `EPS-05` | electronic-payment-systems | Authentication Controls | `eps.auth.challenged`, `eps.auth.decided`, `eps.auth_lockout.applied`, `eps.card_control.applied` | yes | — |
| `EPS-06` | electronic-payment-systems | Dual Control for High-Risk Processes | `ach_transfer.created`, `eps.client_limit_change.requested`, `eps.pospay_exception.presented`, `eps.wire_release.requested`, `wire_transfer.submitted` | yes | — |
| `EPS-07` | electronic-payment-systems | Electronic Fraud Protection Systems | `eps.card_control.applied`, `eps.fraud_trend_review.completed`, `eps.pospay_exception.decided`, `eps.pospay_exception.presented` | yes | — |
| `EPS-10` | electronic-payment-systems | Pre-Deployment Testing | `eps.deployment.emergency_exception`, `eps.deployment.scheduled`, `eps.test_results.recorded`, `eps.test_retro.completed` | yes | — |
| `ERM-06` | enterprise-risk-management | Risk Appetite Breach Escalation & Incident Management | `risk_breach.committee_due_at`, `risk_breach.detected`, `risk_breach.review.due_at`, `risk_breach.triage.due_at` | **no** | `risk_breach.closed` |
| `ERM-07` | enterprise-risk-management | Risk Acceptance & Exceptions | `risk_acceptance.decision.due_at`, `risk_acceptance.expired`, `risk_acceptance.expiry.warning`, `risk_acceptance.expiry_alert_at`, `risk_acceptance.requested` | yes | — |
| `IS-05` | information-security | Vulnerability and Penetration Testing | `vuln.finding.confirmed`, `vuln.triage.completed` | yes | — |
| `IS-19` | information-security | Incident Response Plan, Post-Mortem & Law Enforcement Coordination | `incident.closed` | yes | — |
| `IS-13` | information-security | AI Governance and Usage Disclosure | `ai.member_feature.launched`, `ai.tool.approved`, `ai.tool.proposed`, `ai.violation.disposed` | yes | — |
| `IS-14` | information-security | Logging, Monitoring, and Alerting | `record.retention.expired`, `siem.alert_critical`, `siem.source_silent` | yes | — |
| `IC-08` | internal-controls | Audit Trail and Recordkeeping | `record.integrity.test.due` | **no** | `record.audit_entry_written`, `record.retained` |
| `IP-02` | investment | Governance, Board Oversight, and Delegations | `intermediary.review.completed`, `portfolio.board_report.issued`, `portfolio.management_report.issued`, `trade.exception.logged`, `trade.limit.blocked` | yes | — |
| `IP-03` | investment | Permissible Investments and Prohibited Activities | `instrument_list.review.completed`, `regulatory.change_analysis.logged`, `trade.limit.blocked`, `trade.limit_warning.issued`, `trade.permissibility.checked` | yes | — |
| `IP-04` | investment | Interest Rate Risk and ALM Integration | `alm.irr_simulation.completed`, `position.booked`, `stress_test.minimum.breached` | yes | — |
| `IP-05` | investment | Credit Risk Standards and Downgrade Management | `credit_file.approved`, `credit_file.reanalysis.completed`, `security.downgrade.reviewed`, `security.downgraded` | yes | — |
| `IP-06` | investment | Liquidity and Marketability Limits | `liquidity.report.published`, `liquidity.stress.declared`, `position.booked`, `position.liquidity.classified` | yes | — |
| `IP-07` | investment | Concentration and Counterparty Limits | `concentration.limit_exceeded`, `limit_set.review.completed`, `trade.limit.blocked`, `trade.limit_warning.issued` | yes | — |
| `IP-08` | investment | Approved Brokers, Dealers, and Safekeepers | `intermediary.review.completed`, `safekeeping.reconciliation.completed`, `trade.intermediary.blocked` | **no** | `safekeeping.statement.received` |
| `IP-09` | investment | Repurchase and Reverse Repurchase Agreements | `repo.booked`, `repo.collateral_marked`, `repo.margin_shortfall.detected` | yes | — |
| `IP-10` | investment | Valuation, Accounting, and Fair-Value Measurement | `position.booked`, `security.fair_value.updated`, `security.otti_analysis.completed` | **no** | `override.senior_decision.recorded` |
| `IP-11` | investment | Pre-Purchase Due Diligence and Exceptions | `trade.checklist.completed`, `trade.checklist_exception_raised` | **no** | `trade.booked` |
| `IP-12` | investment | Ongoing Monitoring, Reporting, and Stress Testing | `portfolio.board_report.issued`, `portfolio.management_report.issued`, `portfolio.stress_test.completed` | yes | — |
| `IP-14` | investment | Trade Execution, Controls, and Segregation of Duties | `trade.confirmation.received`, `trade.confirmation_discrepancy.flagged`, `trade.reconciliation.completed`, `trade.sod.blocked`, `trade.step.recorded` | yes | — |
| `IP-17` | investment | Contingency Planning and Liquidity Stress Events | `cfp.investment_test.completed`, `liquidity.stress.declared` | yes | — |
| `MP-02` | member | Account Maintenance and Change of Address | `card.request_during_address_hold`, `member.address_notice.sent`, `redflag.detected`, `verification.completed` | **no** | `member.address_change_disputed` |
| `MP-04` | member | Member Disputes and Dispute Resolution | `complaint.acknowledged`, `complaint.investigation.completed`, `complaint.received`, `complaint.regulator.received`, `dispute.investigation.completed`, `dispute.opened`, `dispute.provisional_credit_due_at` | yes | — |
| `MP-06` | member | Member Expulsion | `expulsion.board_report.filed`, `member.expulsion.decided`, `member.expulsion_hearing.held`, `member.expulsion_hearing.requested`, `member.expulsion_notice.sent`, `member.expulsion_payout.sent` | yes | — |
| `PR-03` | privacy | Permissible Disclosures and Exceptions | `disclosure.initiated`, `privacy.sharing.blocked`, `vendor.glba_clause.verified` | yes | — |
| `PR-04` | privacy | Member Access and Authentication | `access.poa.presented`, `access.refused`, `access.request.received`, `legal.process.received` | yes | — |
| `PR-05` | privacy | Data Accuracy and Corrections | `address.ncoa_mismatch.detected`, `correction.propagated`, `furnishing.correction.applied`, `furnishing.dispute.received` | yes | — |
| `PR-16` | privacy | Biometric Data for KYC | `verification.biometric.completed`, `verification.biometric.purge.due_at`, `verification.biometric.started` | yes | — |
| `PR-17` | privacy | Children's Data | `privacy.age_gate.blocked`, `privacy.minor_data.detected`, `privacy.minor_data_deleted` | yes | — |
| `RR-01` | record-retention | Retention Schedule and Clock Setting | `record.created`, `record_class.unmatched`, `schedule_a.entry.amended` | yes | — |
| `RR-05` | record-retention | Legal Holds | `legal_hold.clear.confirmed`, `legal_hold.created`, `record.hold.applied` | yes | — |
| `RR-06` | record-retention | Core Processor and Email Archive Retention | `core_archive.confirmation_due`, `email_archive.test.completed`, `email_archive.test.due` | yes | — |
| `RR-07` | record-retention | BSA/AML Anonymization and Extended Analytical Retention | `record.retention.expired` | **no** | `record.retained` |
| `RR-08` | record-retention | CDD Refresh Cycle and Stale-Record Disposition | `cdd.profile.refreshed`, `cdd.refresh.due` | yes | — |
| `RR-12` | record-retention | Responsibility and Administration | `records.board_report.filed`, `records.contact_vacated`, `records.contacts.assigned` | yes | — |
| `RS-02` | resolution | Early-Warning Indicators | `ewi.ceo_summary.sent`, `ewi.sweep.completed`, `ewi.threshold.breached` | yes | — |
| `RS-06` | resolution | Next-Business-Day Member Availability | `institution_freeze.activated`, `member_portal.access.logged` | yes | — |
| `RS-08` | resolution | Records Preservation for Resolution | `records_package.build.started`, `records_package.completed`, `records_package.snapshot.completed`, `records_package.verification.failed` | yes | — |
| `TIS-01` | truth-in-savings | Disclosure Standards | `disclosure.template.published`, `privacy.esign_consent.recorded` | **no** | `disclosure.recorded` |
| `TIS-09` | truth-in-savings | Recordkeeping | `record.hold.placed`, `record.retention.expired` | yes | — |

### Partially reachable (121)

These are the nearest to buildable: some triggers already fire.

| Control | Policy | Firable | Missing |
|---|---|---|---|
| `SC-02` | audit | `legal_hold.clear.confirmed`, `legal_hold.created`, `record.disposal_eligible`, `record.hold.applied` | `disposal.executed` |
| `BA-05` | basel-ii-standardized-approach-framework | `cfp.investment_test.completed`, `cfp.level.changed`, `liquidity.concentration.breached`, `liquidity.report.published` | `liquidity.cfp_trigger.breached` |
| `CA-09` | cash | `cash.overshort.resolved`, `cash.surprise_count.completed`, `cash.surprise_count.due`, `supervisory.count_results.delivered` | `exam.export.requested` |
| `AU-04` | audit | `audit.annual_plan.submitted`, `audit.plan_cycle.opened`, `audit.poor_rating.recorded` | `audit.scope_change.identified` |
| `AU-08` | audit | `audit.report.issued`, `finding.management_response.recorded`, `risk_acceptance.decided` | `finding.risk_acceptance.proposed` |
| `BSA-04` | bsa | `cdd.refresh.due`, `risk.trigger_edd`, `verification.completed` | `application.submitted`, `entity.updated` |
| `BC-05` | business-continuity-plan | `incident.ic.assigned`, `incident.severity.assigned`, `incident.signal.received` | `incident.sev1.detected` |
| `CA-05` | cash | `cash.custody.rotation_due_at`, `cash.dual_control.completed`, `employee.separated` | `cash.coverage_change.requested`, `cash.keybox.opened` |
| `CA-06` | cash | `cash.recon.variance_found`, `gl.cash_suspense.aged`, `gl.cash_suspense.cleared` | `cash.recon_day.closed` |
| `CA-07` | cash | `cash.overshort.recorded`, `cash.overshort.resolved`, `cash.overshort.threshold_crossed` | `cash.kri_month.closed`, `cash.overshort_anomaly.detected` |
| `CA-08` | cash | `cash.seal.mismatch`, `cash.shipment.received`, `cash.shipment.verified` | `cash.dual_control.initiated`, `cash.nightdrop.retrieved` |
| `CA-12` | cash | `cash.evidence.created`, `cash.exception.logged`, `record.retention.expired` | `cash.kri_month.closed`, `exam.export.requested` |
| `FL-13` | fair-lending | `complaint.logged`, `complaint.received`, `complaint.trend.reported` | `compliance.board.report.due_at` |
| `IS-06` | information-security | `access.breakglass.used`, `employee.hired`, `employee.separated` | `security.quarter.closed` |
| `IC-06` | internal-controls | `control.override.invoked`, `exception.expiring`, `exception.registered` | `override.analytics_due` |
| `MP-01` | member | `verification.completed`, `verification.created`, `verification.denied` | `member.application.submitted`, `member.eligibility_rule.failed` |
| `PR-12` | privacy | `privacy.state_request.received`, `privacy.state_request_fulfilled`, `web.gpc_signal` | `privacy.nv_optout.received` |
| `PR-14` | privacy | `web.consent.updated`, `web.tag_review`, `web.tag_review.requested` | `web.session.started` |
| `RR-04` | record-retention | `destruction_log.mismatch.detected`, `destruction_log.mismatch.resolved`, `storage_box.created` | `records.annual.review.due_at` |
| `AU-09` | audit | `audit.poor_rating.recorded`, `finding.remediation.reported` | `finding.closure.rejected`, `finding.closure.verified` |
| `BA-07` | basel-ii-standardized-approach-framework | `capital.stress_report.issued`, `stress_test.minimum.breached` | `icaap.completed`, `icaap.cycle.started` |
| `BA-08` | basel-ii-standardized-approach-framework | `alco.ratio_review.logged`, `ncua.notification.sent` | `capital.target_breach.notified`, `disclosure.pillar3.published`, `training.capital_cycle.started` |
| `BSA-03` | bsa | `account.closed`, `verification.completed` | `application.submitted` |
| `BSA-05` | bsa | `verification.created`, `wire_transfer.submitted` | `ofac.annual.report.due` |
| `BSA-14` | bsa | `escalation.acknowledged`, `escalation.action_plan.published` | `escalation.created` |
| `BC-07` | business-continuity-plan | `backup.cycle.completed`, `backup.job.failed` | `backup.restore.test.due`, `incident.sev1.detected` |
| `BC-15` | business-continuity-plan | `incident.containment.started`, `incident.created` | `vendor.incident.logged` |
| `CA-10` | cash | `cash.deviation.requested`, `cash.exception.logged` | `cash.deviation.approved`, `cash.deviation.expired` |
| `CDA-04` | charitable-donation-accounts | `cda.vendor_issue.flagged`, `cda.vendor_review.completed` | `cda.vendor_onboarding.started` |
| `CDA-12` | charitable-donation-accounts | `cda.inkind_transfer.proposed`, `cda.termination.approved` | `cda.account.closed` |
| `CO-07` | collections | `furnishing.correction.applied`, `furnishing.dispute.received` | `furnishing.cycle_due_at`, `furnishing.idtheft_dispute.received` |
| `CM-08` | compliance | `complaint.received`, `regulatory.change_required` | `complaint.trend.review.due`, `regulatory.correspondence.received` |
| `CM-09` | compliance | `policy.board.approved`, `regulatory.change_implemented` | `policy.review.due_at` |
| `EC-02` | e-commerce | `access.deprovisioned`, `access.granted` | `access.review.due_at` |
| `EC-13` | e-commerce | `incident.assessment.completed`, `incident.detected` | `incident.external_comms.started` |
| `EC-12` | e-commerce | `employee.hired`, `training.completed` | `training.annual_due` |
| `IS-07` | information-security | `dlp.violation.detected`, `record.retention.expired` | `tls.certificate_expires_at` |
| `IS-08` | information-security | `backup.cycle.completed`, `backup.job.failed` | `incident.sev1.detected` |
| `IS-10` | information-security | `redflag.case.disposed`, `redflag.detected` | `security.quarter.closed` |
| `IC-04` | internal-controls | `recon.item.escalated`, `recon.item.resolved` | `gl.eod.closed`, `gl.period.closed` |

### Unreachable — blocked on subsystems that do not exist

Grouped by the namespace of the missing trigger, which is a decent proxy
for the subsystem that would have to be built first.

| Missing-trigger namespace | Controls blocked |
|---|---:|
| `vendor` | 14 |
| `application` | 6 |
| `cda` | 5 |
| `policy` | 4 |
| `compliance` | 4 |
| `ecommerce` | 4 |
| `indemnification` | 4 |
| `collections` | 3 |
| `loan` | 3 |
| `insider` | 3 |
| `eps` | 3 |
| `product` | 3 |
| `loan_application` | 3 |
| `board` | 2 |
| `governance` | 2 |
| `bia` | 2 |
| `coi` | 2 |
| `(no trigger declared)` | 2 |
| `aan` | 2 |
| `ewi` | 2 |
| `bcp` | 1 |
| `facility` | 1 |

