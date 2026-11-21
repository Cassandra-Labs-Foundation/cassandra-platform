---
title: Liquidity Policy (Table-First, Design-Overlay v3)
owner: Patrick Wilson, Chief Compliance Officer
version: v1.0
effective: TBD (upon Board approval)
next_review: Effective date + 12 months
approvers:
  - Patrick Wilson, Chief Compliance Officer
tags: [Compliance, Liquidity, Contingency Funding Plan, CFP, LAR, Stress Testing, CLF, Discount Window, ALCO, BaaS]
---

# Liquidity Policy

## General Policy Statement

Pynthia Credit Union is a proposed California state-chartered credit union that intends to carry private share insurance through American Share Insurance. It maintains a risk-based liquidity program and a written Contingency Funding Plan (CFP). The program covers all funding and balance-sheet activity, including BaaS partner flows. Pynthia adopts the NCUA liquidity standard in [12 CFR §741.12](https://www.ecfr.gov/current/title-12/section-741.12) voluntarily as its governing benchmark.

In normal conditions, this policy defines what Pynthia measures, limits, and reports. Under stress, the CFP defines how Pynthia detects stress, escalates it, and executes funding actions. Pynthia's posture is:

* Measure liquidity daily.
* Limit exposures through a Board-approved limit registry.
* Escalate through CFP levels tied to the Liquid Assets Ratio (LAR) bands.
* Execute pre-tested funding actions, including federal contingent liquidity, before a stress event becomes a crisis.

---

## Timing Matrix {#timing-matrix}

| Scenario | Trigger (human → event) | Deadline | Content Reference | Control |
|---|---|---:|---|---|
| Annual policy review | "Annual review due" → `task.opened` | Annual | Board-approved policy and limit registry | [LQ-01](#lq-01-policy-scope-and-risk-appetite) |
| Ad-hoc policy review | "Material change flagged" → `policy.material_change.flagged` | 10 BD | Revised policy version | [LQ-01](#lq-01-policy-scope-and-risk-appetite) |
| Catalogue-to-GL sync | "GL closed for the day" → `gl.eod.closed` | Daily, before 16:00 | Synced metric definitions | [LQ-02](#lq-02-metrics-catalogue-and-data-governance) |
| Independent model review | "Annual model review due" → `task.opened` | Annual | Independent review report | [LQ-02](#lq-02-metrics-catalogue-and-data-governance) |
| Maturity mismatch | "EOD data posted" → `liquidity.eod.posted` | Daily by 16:00 | Cumulative gap by bucket | [LQ-03](#lq-03-maturity-mismatch-limits) |
| LAR computation | "EOD data posted" → `liquidity.eod.posted` | Daily by 16:00 | LAR and band | [LQ-04](#lq-04-lar-bands-and-cfp-activation) |
| CFP transition actions | "Level 2 or 3 set" → `cfp.level.changed` | 2 hours | Transition actions started | [LQ-04](#lq-04-lar-bands-and-cfp-activation) |
| Stress test and survival | "Quarterly cycle due" → `task.opened` | Quarterly | Stress pack; survival days | [LQ-05](#lq-05-survival-horizon-and-stress-testing) |
| Ad-hoc survival recompute | "EWI spike" → `ewi.spike.flagged` | 2 BD | Ad-hoc survival horizon | [LQ-05](#lq-05-survival-horizon-and-stress-testing) |
| Ad-hoc stress re-run | "Major EWI event" → `ewi.major_event.flagged` | 5 BD | Re-run stress pack | [LQ-05](#lq-05-survival-horizon-and-stress-testing) |
| Concentration waiver | "Waiver opened" → `concentration.waiver.opened` | 2 BD | Waiver decision | [LQ-06](#lq-06-funding-concentration-and-counterparty-limits) |
| Collateral headroom | "Collateral file posted" → `collateral.file.posted` | Daily | Unencumbered balance by counterparty | [LQ-07](#lq-07-collateral-and-encumbrance-management) |
| Wholesale ALCO review | "Month closed" → `gl.period.closed` | Monthly | Exposure and ladder review | [LQ-08](#lq-08-wholesale-and-listing-service-deposit-guardrails) |
| Daily ops pack | "LAR computed" → `lar.computed` | 17:00 daily | Daily liquidity pack | [LQ-09](#lq-09-reporting-cadence) |
| Weekly ALCO digest | "Weekly digest due" → `task.opened` | Fri 12:00 | ALCO digest | [LQ-09](#lq-09-reporting-cadence) |
| Quarterly Board deck | "Quarter closed" → `ledger.quarter.closed` | Quarter-end + 5 BD | Board deck | [LQ-09](#lq-09-reporting-cadence) |
| EWI sweep / CEO summary | "EOD data posted" → `liquidity.eod.posted`; "Weekly summary due" → `task.opened` | Daily / Weekly | EWI sweep; CEO summary | [LQ-10](#lq-10-early-warning-indicators-and-event-triggers) |
| Crisis team convened | "Level 2 or 3 set" → `cfp.level.changed` | 60 minutes | Convened crisis team | [LQ-11](#lq-11-escalation-ladder-crisis-roles-and-external-communications) |
| Stakeholder communications | "Level 2 or 3 set" → `cfp.level.changed` | Same day | Scripted notices | [LQ-11](#lq-11-escalation-ladder-crisis-roles-and-external-communications) |
| First-line funding actions | "Level 2 set" → `cfp.level.changed` | 2 hours | Execution plan; first-line draws | [LQ-12](#lq-12-funding-playbooks-and-draw-order) |
| Federal facility test | "Annual test due" → `task.opened` | Annual | Funded or no-funds test result | [LQ-13](#lq-13-federal-liquidity-access-drills-and-after-action-reviews) |
| After-action review | "Test or drill completed" → `drill.completed` | 10 BD | AAR with owners and dates | [LQ-13](#lq-13-federal-liquidity-access-drills-and-after-action-reviews) |
| Regulatory notification | "Notification trigger met" → `liquidity.cfp.activated` / `funding.draw.executed` / `survival.below_threshold` / `lar.critical.breached` | 24 hours | Event memo and notice | [LQ-14](#lq-14-regulatory-notification-and-liaison) |
| Regulator request | "Request received" → `regulator.request.received` | 1 BD | Response | [LQ-14](#lq-14-regulatory-notification-and-liaison) |
| Record indexing | "Artifact created" → `record.created` | 2 BD | Indexed record; 10-year retention | [LQ-15](#lq-15-documentation-and-retention) |

---

## LQ-01 — Policy Scope and Risk Appetite {#lq-01-policy-scope-and-risk-appetite}

**WHY (Reg cite):** [12 CFR §741.12](https://www.ecfr.gov/current/title-12/section-741.12) requires a Board-approved liquidity framework scaled to the credit union's complexity, risk profile, and scope of operations. Pynthia adopts it as its internal standard.

**SYSTEM BEHAVIOR:** One liquidity standard applies to every funding and balance-sheet activity. BaaS partner program balances are aggregated by partner (`account.partner_id`) and measured against the same limits, with no partner-specific exemptions. The policy and its limit registry are versioned together. Every limit enforced in LQ-03 through LQ-08 must resolve to a registry entry, and a limit change takes effect only after Board approval. A limit breached during an active CFP level remains a recorded breach; CFP activation does not suspend limits. The policy text and registry are write-restricted to the CCO. Limit values require a CFO proposal and Board approval.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Annual review cycle opens (`task.opened`) | Current version (`policy.document_version`), limit registry (`policy.limit_registry`), next review date (`policy.next_review_at`) | Reviewed policy (`policy.review.completed`), Board approval (`policy.board.approved`, `policy.board_approved_at`), published version (`policy.version.published`) | Annual (enforced by `policy.review_due_at`) |
| Material change identified: new BaaS partner, product, funding source, or regulation (`policy.material_change.flagged`) | Change description (`policy.change_description`), materiality threshold (`policy.materiality_threshold`), affected partner (`account.partner_id`), redline (`policy.draft_redline`) | Ad-hoc review (`policy.review.completed`) and revised version (`policy.version.published`) | 10 BD (enforced by `policy.review_due_at`) |
| Limit change proposed (`policy.limit_change.requested`) | Proposed limit (`policy.proposed_limit`), rationale (`policy.change_rationale`), approver (`policy.approver_id`) | Updated registry entry (`policy.limit.updated`) | Effective on Board approval (enforced by `policy.board_approval_due_at`) |

**ALERTS/METRICS:** `alert.policy_review_aging` fires 30 days before `policy.review_due_at`. Targets: zero lapsed reviews, and zero limits enforced in production without a matching `policy.limit_registry` entry.

---

## LQ-02 — Metrics Catalogue and Data Governance {#lq-02-metrics-catalogue-and-data-governance}

**WHY (Reg cite):** The CFP required by [12 CFR §741.12(b)](https://www.ecfr.gov/current/title-12/section-741.12#p-741.12(b)) is only as credible as the measurements behind it. Standardized definitions, GL tie-out, and independent model review keep every downstream limit and trigger defensible.

**SYSTEM BEHAVIOR:** A central catalogue holds one definition, formula, and lineage for each metric: LAR, cumulative mismatch, survival horizon, and concentration. The catalogue is synced to the GL chart-of-accounts map each business day before the 16:00 computations.

* **Failed sync.** If the sync fails, the affected metrics publish as provisional and cannot clear a CFP level on their own.
* **GL tie-out.** System balances are tied out to the GL daily. Any variance opens an investigation.
* **Assumption catalog.** Behavioral assumptions are versioned with a rationale for every change.
* **Model review.** An independent reviewer validates the models annually. A reviewer who appears on the builder roster is blocked by segregation-of-duties enforcement.

Catalogue definitions are write-restricted to the CFO, with CCO approval. Model builders have no write access to review records.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Metric definition change requested (`catalogue.change.requested`) | Definition (`catalogue.definition`), formula (`catalogue.formula`), lineage (`catalogue.lineage`), approver (`catalogue.approver_id`) | Versioned definition (`catalogue.definition.updated`) | Approved before next daily run |
| GL closed for the day (`gl.eod.closed`) | COA map (`gl.coa_map`), trial balance (`gl.trial_balance`), lineage (`catalogue.lineage`) | Sync record (`catalogue.sync.completed`). On failure: `catalogue.sync.failed` and `alert.catalogue_sync.failed`, with `catalogue.failure_reason` and `catalogue.metrics_flagged_provisional` | Daily, before 16:00 PT (enforced by `catalogue.sync_due_at`) |
| GL closed for the day (`gl.eod.closed`) | System balances (`liquidity.system_balances`), GL balances (`gl.balances`) | Tie-out record (`dq.tieout.completed`). On variance: `dq.variance.detected` with `dq.variance_amount`, which opens an investigation (`dq.investigation.opened`, `dq.investigation`) | Daily (enforced by `dq.tieout_due_at`) |
| Behavioral assumption changed (`stress.assumption.changed`) | New value (`stress.assumption_value`), rationale (`stress.change_rationale`), assumption set (`stress.behavioral_assumptions`) | Versioned assumption catalog entry (`stress.assumption_versioned`) | Before next stress run |
| Annual model review due (`task.opened`) | Builder roster (`model.builder_roster`), reviewer (`model.reviewer_id`), SoD matrix (`sod.matrix_version`) | Review report (`model.review.completed`). A conflicted reviewer triggers `sod.conflict.detected` and `sod.grant.blocked` | Annual (enforced by `model.review_due_at`) |

**ALERTS/METRICS:**

* Catalogue sync success rate of 100% before 16:00.
* `alert.dq_variance` fires on any non-zero unexplained tie-out variance.
* Zero open `dq.investigation` items older than 2 BD.
* Zero SoD conflicts on model reviews.

---

## LQ-03 — Maturity Mismatch Limits {#lq-03-maturity-mismatch-limits}

**WHY (Reg cite):** [12 CFR §741.12(b)](https://www.ecfr.gov/current/title-12/section-741.12#p-741.12(b)) requires the CFP to address liquidity shortfalls. Bucketed cumulative cash-flow gaps measured against Board limits are the primary shortfall gauge.

**SYSTEM BEHAVIOR:**

* **Daily computation.** Each business day by 16:00 PT, the engine slots behaviorally adjusted cash flows into six buckets: O/N, 2–7d, 8–30d, 31–90d, 91–365d, and >1y. It computes cumulative gaps and compares each bucket to its registry limit from [LQ-01](#lq-01-policy-scope-and-risk-appetite).
* **Intraday recompute.** A large unscheduled inflow or outflow, including BaaS partner settlement movements, triggers an intraday recompute.
* **Breaches.** A breach raises a real-time alert. The CFO must disposition it the same business day.
* **Limits as triggers.** A breach is not by itself a CFP trigger. Activation is governed by [LQ-04](#lq-04-lar-bands-and-cfp-activation).

Bucket limits are read-only to Treasury Operations.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| EOD liquidity data posted (`liquidity.eod.posted`) | Position buckets (`position.liquidity_bucket`), GL balances (`gl.balances`), behavioral assumptions (`stress.behavioral_assumptions`), bucket limits (`mismatch.limit`) | Cumulative gaps by bucket (`mismatch.gap_computed`, `mismatch.current_gaps`) | Daily by 16:00 PT (enforced by `mismatch.compute_due_at`) |
| Large unscheduled flow detected (`liquidity.large_flow.detected`) | Flow detail (`liquidity.large_flow`), current gaps (`mismatch.current_gaps`) | Intraday recompute (`mismatch.intraday_recomputed`) | Intraday, same business day |
| Cumulative gap exceeds bucket limit (`mismatch.limit.breached`) | Breached bucket (`mismatch.breached_bucket`), magnitude (`mismatch.breach_magnitude`) | Real-time alert (`alert.mismatch_breach`); CFO disposition (`mismatch.breach.dispositioned`) | Alert immediate; disposition same business day |

**ALERTS/METRICS:**

* Gap computation completed by 16:00 on 100% of business days.
* Count of `alert.mismatch_breach` events by bucket.
* Zero breaches without a same-day `mismatch.breach.dispositioned` record.

---

## LQ-04 — LAR Bands and CFP Activation {#lq-04-lar-bands-and-cfp-activation}

**WHY (Reg cite):** [12 CFR §741.12(b)](https://www.ecfr.gov/current/title-12/section-741.12#p-741.12(b)) requires a CFP with clear strategies for liquidity shortfalls. Objective, metric-driven activation levels make the CFP executable.

**SYSTEM BEHAVIOR:** LAR is computed daily by 16:00 PT and classified into bands. Each band maps to a CFP level:

| LAR | Band | CFP level |
|---|---|---|
| ≥10% | Normal | None |
| <10% | Watch | Level 1 |
| <8% | Low | Level 2 |
| <6% | Critical | Level 3 |

* **Band changes.** A band change raises a real-time alert and sets the CFP level the same day.
* **Level 2 or 3 transition.** At Level 2 or 3, transition actions start within 2 hours: crisis convening ([LQ-11](#lq-11-escalation-ladder-crisis-roles-and-external-communications)) and funding playbooks ([LQ-12](#lq-12-funding-playbooks-and-draw-order)).
* **Escalation on other evidence.** The CEO may set a higher level than the LAR band indicates when survival or EWI evidence warrants it. The CEO may never set a lower level.
* **Step-down.** Stepping down a level requires the LAR to have recovered into the higher band and CEO approval with a logged rationale.

Band thresholds are write-restricted to the CFO and take effect only through Board approval in [LQ-01](#lq-01-policy-scope-and-risk-appetite). Only the CEO, or the Acting CEO per the succession matrix, may set or clear a level.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| EOD liquidity data posted (`liquidity.eod.posted`) | Liquid assets (`liquidity.liquid_assets`), total assets (`liquidity.total_assets`), haircuts (`liquidity.haircut_table`) | LAR record (`lar.computed`, `lar.value`) | Daily by 16:00 PT (enforced by `lar.compute_due_at`) |
| LAR crosses into a lower band (`lar.band.changed`) | Current band (`lar.current_band`), prior band (`lar.prior_band`) | Real-time alert (`alert.lar_band_change`, `lar.band_alert.issued`); level set (`cfp.level.changed`, `cfp.level`); activation record (`liquidity.cfp.activated`) | Alert real-time; activation same day (enforced by `liquidity.cfp_activation_due_at`) |
| LAR below 6% (`lar.critical.breached`) | LAR value (`lar.value`), critical flag (`lar.critical`) | Level 3 activation (`liquidity.cfp.activated`); notification trigger consumed by [LQ-14](#lq-14-regulatory-notification-and-liaison) | Immediate |
| Survival or EWI evidence warrants escalation (`liquidity.cfp_trigger.breached`) | Trigger basis (`liquidity.cfp_trigger`), deciding executive (`crisis.decider_id`) | CEO-set level (`cfp.level.changed`) | Same day (enforced by `liquidity.cfp_activation_due_at`) |
| Level 2 or 3 set (`cfp.level.changed`) | Level (`cfp.level`), trigger (`liquidity.cfp_trigger`) | Transition actions started (`cfp.transition.started`) | 2 hours (enforced by `cfp.transition_due_at`) |
| LAR recovers into a higher band (`lar.band.changed`) | Prior band (`lar.prior_band`), current level (`cfp.level`), CEO rationale (`cfp.deactivated`) | Step-down or deactivation record (`cfp.deactivated`) | On CEO approval |

**ALERTS/METRICS:**

* `alert.lar_band_change` delivered within 5 minutes of `lar.computed`.
* Time from `cfp.level.changed` to `cfp.transition.started` is 2 hours or less in 100% of Level 2/3 events.
* LAR computed by 16:00 on 100% of business days.

---

## LQ-05 — Survival Horizon and Stress Testing {#lq-05-survival-horizon-and-stress-testing}

**WHY (Reg cite):** [12 CFR §741.12(b)](https://www.ecfr.gov/current/title-12/section-741.12#p-741.12(b)) requires the CFP to anticipate emergency funding needs. Scenario stress testing and survival-days modeling quantify those needs before they occur.

**SYSTEM BEHAVIOR:** Each quarter the CFO runs three scenarios: idiosyncratic, systemic, and combined.

* **Scenario contents.** Each scenario includes intraday peak outflows and BaaS partner shocks, such as a partner's program wind-down or a sudden partner-driven balance runoff.
* **Outputs.** Each run produces survival days per scenario. The combined-scenario figure is the binding metric.
* **EWI spike.** A spike forces an ad-hoc survival recompute within 2 BD.
* **Major EWI event.** A major event forces a full stress re-run within 5 BD.
* **Facility eligibility.** If facility eligibility or haircuts change, survival is recomputed in the next daily cycle before any capacity is counted.
* **Below threshold.** Survival below the Board target raises a CFP trigger for [LQ-04](#lq-04-lar-bands-and-cfp-activation). Combined survival under 15 days is a notification trigger for [LQ-14](#lq-14-regulatory-notification-and-liaison).

Scenario parameters are write-restricted to the CFO. Results are read-only to ALCO and the Board.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Quarterly cycle due (`task.opened`) | Scenario set (`stress.set`), behavioral assumptions (`stress.behavioral_assumptions`), intraday profile (`stress.intraday_profile`), BaaS shock parameters (`stress.baas_shock_params`), haircuts (`liquidity.haircut_table`) | Stress pack (`stress.pack.issued`, `stress.pack`); survival result (`survival.computed`, `survival.days_combined`, `survival.driver_scenario`) | Quarterly (enforced by `stress.quarterly_due_at` and `survival.quarterly_due_at`) |
| EWI spike flagged (`ewi.spike.flagged`) | Indicator (`ewi.indicator_id`), value (`ewi.value`), scenario set (`stress.set`) | Ad-hoc survival horizon (`survival.adhoc_computed`) | 2 BD |
| Major EWI event flagged (`ewi.major_event.flagged`) | Indicator (`ewi.indicator_id`), value (`ewi.value`), scenario set (`stress.set`) | Ad-hoc re-run (`stress.adhoc_rerun.issued`) and revised pack (`stress.pack.issued`) | 5 BD (enforced by `stress.rerun_due_at`) |
| Survival below target or under 15 days combined (`survival.below_threshold`) | Combined survival (`survival.days_combined`), driving scenario (`survival.driver_scenario`) | CFP trigger (`liquidity.cfp_trigger.breached`) for [LQ-04](#lq-04-lar-bands-and-cfp-activation); notification trigger for [LQ-14](#lq-14-regulatory-notification-and-liaison) | Immediate |

**ALERTS/METRICS:**

* `alert.survival_low` fires whenever `survival.days_combined` falls below the Board target.
* Ad-hoc recomputes completed within 2 BD in 100% of cases.
* Ad-hoc re-runs completed within 5 BD in 100% of cases.
* Quarterly packs issued on time in 4 of 4 quarters.

---

## LQ-06 — Funding Concentration and Counterparty Limits {#lq-06-funding-concentration-and-counterparty-limits}

**WHY (Reg cite):** [12 CFR §741.12(b)](https://www.ecfr.gov/current/title-12/section-741.12#p-741.12(b)) requires the CFP to address contingent funding needs. Concentrated depositors, BaaS partners, and single funding providers are the most likely sources of a sudden shortfall.

**SYSTEM BEHAVIOR:**

* **Daily measures.** Each business day the system computes top-10 depositor share, single-BaaS-partner share, and single-provider or single-facility reliance against registry limits.
* **Limit exceeded.** An exceedance records a breach and opens a waiver case. The CFO must decide the case within 2 BD by granting a time-boxed waiver with terms or denying it.
* **Remediation plan.** A denial, or a breach that outlasts its waiver term, requires a diversification plan logged for the next ALCO meeting.

Waiver decisions are restricted to the CFO, and the reviewer cannot be the requester. Waivers exceeding 90 days require Board approval.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Depositor file posted (`liquidity.depositor_file.posted`) | Depositor file (`liquidity.depositor_file`), partner tag (`account.partner_id`), provider reliance (`liquidity.concentration`), limits (`policy.limit_registry`) | Concentration measures (`liquidity.concentration.computed`, `concentration.top10`) | Daily (enforced by `concentration.compute_due_at`) |
| Concentration limit exceeded (`concentration.limit_exceeded`) | Excess (`concentration.excess_amount`), position (`concentration.position_id`) | Breach record (`liquidity.concentration.breached`); waiver case (`concentration.waiver.opened`) | Same business day |
| Waiver case opened (`concentration.waiver.opened`) | Request (`concentration.waiver_request`), proposed terms (`concentration.waiver_terms`), reviewer (`concentration.reviewer_id`) | Decision (`concentration.waiver.decided`); closure (`concentration.waiver.resolved`) | 2 BD (enforced by `concentration.waiver_due_at`) |
| Waiver denied or expired with breach still open (`concentration.waiver.decided`) | Excess (`concentration.excess_amount`), plan (`liquidity.diversification_plan`) | Diversification plan (`liquidity.diversification_plan.logged`) | Next ALCO meeting |

**ALERTS/METRICS:**

* `alert.concentration_breach` fires on every exceedance.
* Waiver decisions within 2 BD in 100% of cases.
* Trend of top-10 depositor share and largest-partner share reported weekly via [LQ-09](#lq-09-reporting-cadence).

---

## LQ-07 — Collateral and Encumbrance Management {#lq-07-collateral-and-encumbrance-management}

**WHY (Reg cite):** Federal Reserve advances must be "secured to the satisfaction" of the Reserve Bank ([12 U.S.C. §347b](https://www.law.cornell.edu/uscode/text/12/347b)). Federal contingent access under [12 CFR §741.12(c)](https://www.ecfr.gov/current/title-12/section-741.12#p-741.12(c)) is only real if eligible collateral is unencumbered and valued.

**SYSTEM BEHAVIOR:**

* **Daily valuation.** Each business day the system values the collateral inventory. It applies counterparty-specific eligibility rules and haircuts, then computes unencumbered, eligible headroom by counterparty: Discount Window, CLF, FHLB if eligible, and repo counterparties.
* **Large moves.** A large collateral move, such as a pledge, release, sale, or maturity, forces an intraday headroom recheck.
* **Dual control.** Every pledge or release executes under dual control: an initiator and a second approver.
* **Disputed collateral.** A security under dispute or pending substitution is excluded from headroom until cleared.
* **Joint governance.** AFS marketability and haircut schedules are governed jointly with the Investment Policy.

Pledge and release rights are restricted to Treasury Operations, and the initiator cannot approve their own instruction.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Collateral file posted (`collateral.file.posted`) | Inventory (`collateral.inventory`), eligibility rules (`collateral.eligibility_rules`), haircuts (`liquidity.haircut_table`), counterparty (`collateral.counterparty_id`), pledge schedule (`collateral.pledge_schedule`) | Valuation (`collateral.valued`); headroom (`collateral.headroom_computed`, `collateral.unencumbered_balance`); if below floor, `alert.headroom_low` | Daily (enforced by `collateral.compute_due_at`) |
| Large collateral move detected (`collateral.large_move.detected`) | Move detail (`collateral.move_detail`), current headroom (`collateral.unencumbered_balance`) | Intraday recheck (`collateral.headroom_rechecked`) | Intraday, same business day |
| Pledge or release requested (`collateral.pledge.requested`) | Position (`collateral.position_id`), counterparty (`collateral.counterparty_id`), initiator (`transaction.initiated_by`), dual-control flag (`transaction.dual_control_required`) | Second approval (`transaction.dual_control.completed`); executed pledge or release (`collateral.pledge.executed`) | Before counterparty settlement cut-off |

**ALERTS/METRICS:**

* `alert.headroom_low` fires when unencumbered eligible headroom falls below the registry floor.
* Zero pledges executed without `transaction.dual_control.completed`.
* Daily headroom computed on 100% of business days.

---

## LQ-08 — Wholesale and Listing-Service Deposit Guardrails {#lq-08-wholesale-and-listing-service-deposit-guardrails}

**WHY (Reg cite):** [12 CFR §741.12(b)](https://www.ecfr.gov/current/title-12/section-741.12#p-741.12(b)) requires identified, reliable contingent funding sources. Wholesale and listing-service deposits count only if their tenor, pricing, and volume are controlled.

**SYSTEM BEHAVIOR:**

* **Approved services only.** Pynthia accepts listing-service deposits only through approved services that pass due diligence.
* **Pre-funding check.** Every listing-service deposit is checked before funding for tenor-ladder fit and for pricing within the authorized rate grid. A deposit that fails either check is blocked and raises a pricing alert.
* **Daily exposure.** Exposure is updated daily against registry caps.
* **Monthly review.** ALCO reviews the exposure history and maturity ladder monthly.
* **Contingent use.** Listing-service CDs also appear as the last external source in [LQ-12](#lq-12-funding-playbooks-and-draw-order). Contingent use remains subject to these guardrails.

Rate grids and pricing authority are write-restricted to the CFO.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Listing service proposed (`wholesale.listing.requested`) | Service (`wholesale.service_id`), due diligence (`intermediary.due_diligence_file`), approved list (`intermediary.approved_list`) | Approval decision (`wholesale.listing_decisioned`) | Before first deposit accepted |
| Deposit opened via listing service (`account.opened`) | Channel (`account.opening_channel`), rate (`wholesale.rate`), tenor (`wholesale.tenor`), ladder (`wholesale.tenor_ladder`), pricing authority (`wholesale.pricing_authority_id`) | Accepted deposit, or block with `alert.wholesale_pricing_violation` | Before funding |
| EOD liquidity data posted (`liquidity.eod.posted`) | Maturity calendar (`wholesale.maturity_calendar`), exposure history (`wholesale.exposure_history`), caps (`policy.limit_registry`) | Daily exposure (`wholesale.exposure_computed`, `wholesale.exposure.posted`) | Daily (enforced by `wholesale.compute_due_at`) |
| Month closed (`gl.period.closed`) | Exposure history (`wholesale.exposure_history`), ladder (`wholesale.tenor_ladder`) | ALCO review (`wholesale.review.completed`, `alco.ratio_review.logged`) | Monthly (enforced by `wholesale.monthly_review_due`) |

**ALERTS/METRICS:**

* Zero funded listing-service deposits with an open `alert.wholesale_pricing_violation`.
* No more than the registry maximum maturing in any single month.
* Monthly ALCO review completed 12 of 12 months.

---

## LQ-09 — Reporting Cadence {#lq-09-reporting-cadence}

**WHY (Reg cite):** [12 CFR §741.12](https://www.ecfr.gov/current/title-12/section-741.12) places liquidity oversight with the Board. Timely, signed-off reporting is how management evidences that oversight.

**SYSTEM BEHAVIOR:** Three packs are generated automatically from catalogue metrics and require a named sign-off:

| Pack | Audience | Due |
|---|---|---|
| Daily ops pack | Treasury Ops and CFO | 17:00 PT |
| Weekly ALCO digest | ALCO | Friday 12:00 PT |
| Quarterly Board deck | Board | Quarter-end + 5 BD |

Packs built on provisional metrics ([LQ-02](#lq-02-metrics-catalogue-and-data-governance)) are watermarked "provisional." During an active Level 2 or 3, the daily pack is also distributed to the crisis team ([LQ-11](#lq-11-escalation-ladder-crisis-roles-and-external-communications)). Packs are read-only after sign-off; corrections are issued as a new version.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Daily metrics computed (`lar.computed`) | LAR (`lar.value`), gaps (`mismatch.current_gaps`), survival (`survival.days_combined`), concentration (`concentration.top10`), headroom (`collateral.unencumbered_balance`), EWIs (`ewi.value`) | Daily pack (`report.daily_pack.published`, `report.daily_pack`) | 17:00 PT daily (enforced by `report.daily_due_at`) |
| Weekly digest due (`task.opened`) | Weekly deltas (`report.weekly_deltas`), EWI trend (`ewi.trend`), wholesale exposure (`wholesale.exposure_history`) | ALCO digest (`report.weekly_digest.published`, `report.weekly_digest`) | Friday 12:00 PT (enforced by `report.weekly_due_at`) |
| Quarter closed (`ledger.quarter.closed`) | Stress pack (`stress.pack`), limit registry (`policy.limit_registry`), weekly digests (`report.weekly_digest`) | Board deck (`report.board_deck.published`, `report.board_deck`) | Quarter-end + 5 BD (enforced by `report.board_due_at`) |
| Pack published (`report.daily_pack.published`) | Reviewer identity (`user.id`) and role (`user.role`) | Sign-off (`attestation.recorded`) | Same day as publication |

**ALERTS/METRICS:**

* On-time publication rate of 100% for each pack.
* Zero packs without an `attestation.recorded` sign-off.
* Count of packs watermarked provisional.

---

## LQ-10 — Early-Warning Indicators and Event Triggers {#lq-10-early-warning-indicators-and-event-triggers}

**WHY (Reg cite):** [12 CFR §741.12(b)](https://www.ecfr.gov/current/title-12/section-741.12#p-741.12(b)) requires strategies for emergency shortfalls. Early-warning indicators buy the time those strategies need.

**SYSTEM BEHAVIOR:** The system evaluates these indicators daily against thresholds:

* Volatile-liability growth
* Depositor and BaaS partner concentrations
* Negative press
* Asset-quality deterioration
* Rising funding costs
* Margin or collateral calls
* Early CD redemptions
* Correspondent line cuts

Qualitative indicators such as press and line cuts are entered by Treasury Operations as indicator values. A threshold breach is classified as either a spike, which drives the ad-hoc survival recompute in [LQ-05](#lq-05-survival-horizon-and-stress-testing), or a major event, which drives the stress re-run. Each breach is escalated to the CFO. The CEO receives a weekly trend summary. Thresholds are write-restricted to the CFO; Risk and ALCO have read-only access.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| EOD liquidity data posted (`liquidity.eod.posted`) | Indicator (`ewi.indicator_id`), value (`ewi.value`), thresholds (`ewi.thresholds`), schedule (`ewi.evaluation_schedule`) | Daily sweep (`ewi.sweep.completed`) | Daily (enforced by `ewi.sweep_due_at`) |
| Indicator crosses threshold (`ewi.threshold.breached`) | Prior state (`ewi.prior_breach_state`), history (`ewi.history`), trend (`ewi.trend`), severity (`escalation.severity`) | Classification (`ewi.spike.flagged` or `ewi.major_event.flagged`); CFO escalation (`escalation.created`) | Same business day |
| Weekly summary due (`task.opened`) | Summary (`ewi.ceo_summary`), trend (`ewi.trend`) | CEO summary (`ewi.ceo_summary.sent`) | Weekly (enforced by `ewi.summary_due_at`) |

**ALERTS/METRICS:**

* Daily sweep completed on 100% of business days.
* Median time from `ewi.threshold.breached` to `escalation.created` under 2 hours.
* Weekly CEO summaries on time 52 of 52 weeks.

---

## LQ-11 — Escalation Ladder, Crisis Roles, and External Communications {#lq-11-escalation-ladder-crisis-roles-and-external-communications}

**WHY (Reg cite):** [12 CFR §741.12(b)](https://www.ecfr.gov/current/title-12/section-741.12#p-741.12(b)) requires a CFP that clearly sets out strategies for emergencies. Defined decision rights and controlled communications prevent a funding stress from becoming a run.

**SYSTEM BEHAVIOR:** Crisis roles are fixed:

| Role | Responsibility |
|---|---|
| CEO | Leads the crisis team; sole external spokesperson |
| CFO | Liquidity operations |
| ALCO | Advisory |
| Board | Authorizes extraordinary measures |
| CCO | Governance and regulator liaison ([LQ-14](#lq-14-regulatory-notification-and-liaison)) |

* **Convening.** At Level 2 or 3, the crisis team convenes within 60 minutes. If the CEO is unavailable, the Acting CEO named in the succession matrix assumes the role.
* **Decisions.** Every crisis decision is logged with its authority basis.
* **Extraordinary measures.** Measures outside delegated authority require Board authorization before execution.
* **Stakeholder notices.** Major depositors and BaaS partners receive CEO-approved scripted notices the same business day a Level 2 or 3 is set.
* **Media.** Media inquiries receive only the approved holding statement.

Scripts are editable only by the CEO's designee and require Compliance review and CEO approval. Staff other than the CEO may not make external statements.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Level 2 or 3 set (`cfp.level.changed`) | Crisis roster (`crisis.roster`), succession matrix (`crisis.succession_matrix`) | Convened team (`crisis.team_convened.recorded`) | 60 minutes (enforced by `crisis.convene_due_at`) |
| Crisis decision proposed (`crisis.decision.proposed`) | Decider (`crisis.decider_id`), authority basis (`crisis.authority_basis`), detail (`crisis.decision_detail`) | Decision log (`crisis.decision.logged`) | Real-time |
| Extraordinary measure proposed (`crisis.extraordinary.proposed`) | Measure (`crisis.measure_detail`), Board quorum (`crisis.board_quorum`) | Board authorization (`crisis.board.authorized`) | Before execution |
| Level 2 or 3 set (`cfp.level.changed`) | Stakeholder matrix (`comms.stakeholder_matrix`), contact tree (`comms.contact_tree`), holding statement (`comms.holding_statement`), CEO approval (`comms.ceo_approval`) | Scripted notices (`comms.notices.sent`) | Same business day (enforced by `comms.same_day_due_at`) |
| Script change requested (`comms.script_change.requested`) | Draft (`comms.draft_script`), Compliance review (`comms.compliance_review`), CEO approval (`comms.ceo_approval`) | Approved script (`comms.script.approved`) | Before use |
| Media inquiry received (`comms.media_inquiry.received`) | Inquiry (`comms.inquiry_detail`), holding statement (`comms.holding_statement`) | Logged response (`comms.media_response.logged`) | Same business day |

**ALERTS/METRICS:**

* Time from `cfp.level.changed` to `crisis.team_convened.recorded` is 60 minutes or less.
* Same-day notice completion of 100% at Level 2 and 3.
* Zero external statements without an approved script.

---

## LQ-12 — Funding Playbooks and Draw Order {#lq-12-funding-playbooks-and-draw-order}

**WHY (Reg cite):** [12 CFR §741.12(b)](https://www.ecfr.gov/current/title-12/section-741.12#p-741.12(b)) and [(c)](https://www.ecfr.gov/current/title-12/section-741.12#p-741.12(c)) require actionable contingent sources, including a federal source: the CLF ([12 U.S.C. §1795](https://www.law.cornell.edu/uscode/text/12/1795)) and Federal Reserve advances ([12 U.S.C. §347b](https://www.law.cornell.edu/uscode/text/12/347b)).

**SYSTEM BEHAVIOR:** Pynthia draws on internal sources before external ones, in this order:

| Order | Source |
|---|---|
| Internal 1 | Cash and Federal Reserve / corporate credit union balances |
| Internal 2 | Unencumbered AFS securities, sold or pledged |
| Internal 3 | Saleable or participation-ready loans |
| External 1 | FHLB, if eligible |
| External 2 | Discount Window |
| External 3 | CLF |
| External 4 | Listing-service CDs, within [LQ-08](#lq-08-wholesale-and-listing-service-deposit-guardrails) guardrails |

* **Level 2.** The CFO documents an execution plan and executes first-line actions within 2 hours.
* **Level 3.** Actions are immediate.
* **External draws.** Every external draw requires dual authorization.
* **Unavailable source.** If a source is unavailable, the playbook moves to the next source. The deviation is logged.
* **Order deviations.** Any deviation from the order for cost or timing reasons requires a CEO decision logged in [LQ-11](#lq-11-escalation-ladder-crisis-roles-and-external-communications).

Playbook specifications are write-restricted to the CFO, and draw execution is limited to Treasury Operations.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Level 2 or 3 set (`cfp.level.changed`) | Shortfall estimate (`funding.shortfall_estimate`), draw order (`cfp.liquidation_hierarchy`), playbook (`playbook.spec`) | Execution plan (`cfp.execution_plan.documented`); first-line actions (`funding.first_line.executed`) | Level 2: 2 hours; Level 3: immediate (enforced by `funding.first_line_due_at` and `cfp.execution_plan_due_at`) |
| External draw requested (`funding.external_draw.requested`) | Draw detail (`funding.external_draw`), amount (`funding.draw_amount`), facility contacts (`facility.contacts`), dual-control flag (`transaction.dual_control_required`) | Second authorization (`transaction.dual_control.completed`); executed draw (`funding.draw.executed`) | Same business day; Level 3 immediate |
| Planned source unavailable (`funding.source_unavailable.flagged`) | Reason (`funding.unavailability_reason`), next source (`funding.next_source`), deviation flag (`funding.draw_order_deviated`) | Next-source draw (`funding.draw.executed`); CEO-approved deviation (`crisis.decision.logged`) | Immediate |

**ALERTS/METRICS:**

* `funding.first_line.executed` within 2 hours in 100% of Level 2 activations.
* Zero external draws without `transaction.dual_control.completed`.
* Count of draw-order deviations per event.

---

## LQ-13 — Federal Liquidity Access, Drills, and After-Action Reviews {#lq-13-federal-liquidity-access-drills-and-after-action-reviews}

**WHY (Reg cite):** [12 CFR §741.12(c)](https://www.ecfr.gov/current/title-12/section-741.12#p-741.12(c)) requires documented access to a federal contingent liquidity source. Federal access can come through CLF membership, direct or through an agent ([12 U.S.C. §1795e](https://www.law.cornell.edu/uscode/text/12/1795e)), or through Discount Window access ([12 U.S.C. §347b](https://www.law.cornell.edu/uscode/text/12/347b)). Testing proves the access works.

**SYSTEM BEHAVIOR:**

* **Access maintained.** Pynthia maintains CLF access (regular or agent membership) and Discount Window operational readiness: executed borrowing documents, a current contact sheet, and a current pledged-collateral schedule.
* **Schedule drift.** A drift between the facility collateral schedule and the [LQ-07](#lq-07-collateral-and-encumbrance-management) inventory is corrected by the next business day.
* **Annual facility test.** At least one federal source is tested each year, funded or no-funds.
* **Annual tabletop.** A tabletop crisis exercise is run each year.
* **Failures.** Any failed element opens a corrective plan immediately.
* **After-action review.** An AAR is published within 10 BD of each test or drill, with a named owner and due date for every remediation item.

The CFO and CEO co-own tests. Treasury Operations executes them.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Schedule drift detected (`facility.schedule_drift.detected`) | Drift detail (`facility.schedule_drift`), schedule (`facility.collateral_schedule`), CLF capacity (`liquidity.clf_capacity`) | Corrected schedule (`facility.schedule.updated`) | Next business day |
| Annual facility test due (`task.opened`) | Test script (`facility.test_script`), contacts (`facility.contacts`), objectives (`drill.objectives`), roster (`drill.roster`) | Test result (`facility.test.completed`) | Annual (enforced by `facility.annual_test_due`) |
| Tabletop scheduled (`exercise.scheduled`) | Objectives (`drill.objectives`), roster (`drill.roster`) | Completed drill (`drill.completed`) | Annual |
| Test or drill element fails (`drill.element.failed`) | Element (`drill.element`), failure detail (`drill.failure_detail`), affected capability (`drill.affected_capability`) | Corrective plan (`drill.corrective_plan.opened`, `drill.corrective_plan`) | Same business day |
| Test or drill completed (`drill.completed`) | Remediation items (`drill.remediation_item`), owners (`drill.remediation_owner`) | AAR (`drill.aar.published`) | 10 BD (enforced by `drill.aar_due_at`) |
| AAR remediation item opened (`drill.aar.published`) | Item (`drill.remediation_item`), owner (`drill.remediation_owner`) | Closed item (`drill.remediation.closed`) | Date set in AAR (enforced by `drill.remediation_due_at`) |

**ALERTS/METRICS:**

* `alert.facility_readiness_aging` fires when the facility test or schedule review is overdue.
* AAR published within 10 BD in 100% of cases.
* Zero overdue remediation items.

---

## LQ-14 — Regulatory Notification and Liaison {#lq-14-regulatory-notification-and-liaison}

**WHY (Reg cite):** No statute sets this 24-hour clock. It is an internal standard that supports supervisory transparency over the liquidity program and federal-source use contemplated by [12 CFR §741.12(c)](https://www.ecfr.gov/current/title-12/section-741.12#p-741.12(c)).

**SYSTEM BEHAVIOR:** The NCUA examiner and regional contacts are notified within 24 hours when any of these occurs:

* CFP Level 2 or 3 activates.
* A federal facility is used or attempted.
* Combined survival falls below 15 days.
* LAR falls below 6%.

The CFO drafts the event memo, the CEO approves it, and the CCO transmits it as designated regulator liaison. A single event that meets several triggers produces one memo listing all of them. Regulator requests are answered within 1 BD unless the regulator directs otherwise. Regulator contacts are verified on a fixed cadence. The memo and contact list are write-restricted to the CCO.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Notification trigger met: Level 2/3, federal facility used or attempted, combined survival under 15 days, or LAR under 6% (`liquidity.cfp.activated`, `funding.draw.executed`, `funding.source_unavailable.flagged`, `survival.below_threshold`, `lar.critical.breached`) | Trigger (`ncua.trigger_condition`), required flag (`ncua.notification_required`), memo (`ncua.memo`), metrics (`ncua.metrics_snapshot`), contacts (`regulator.contacts`) | Event memo (`regulator.memo.filed`); notification (`ncua.notification.sent`) | 24 hours (enforced by `ncua.notification_due_at`) |
| Acknowledgment received (`ncua.ack.received`) | Acknowledgment detail (`ncua.ack_detail`) | Logged acknowledgment (`ncua.ack.logged`) | On receipt |
| Regulator request received (`regulator.request.received`) | Request (`regulator.request_detail`), contacts (`regulator.contacts`) | Response (`regulator.response.sent`) | 1 BD unless otherwise directed (enforced by `regulator.response_due_at`) |
| Contact verification due (`task.opened`) | Contact list (`regulator.contacts`) | Verified contacts (`regulator.contacts.verified`) | Quarterly (enforced by `regulator.contact_verification_due`) |

**ALERTS/METRICS:**

* `alert.ncua_notification_aging` fires 12 hours after a trigger with no `ncua.notification.sent`.
* `alert.regulator_request_aging` fires at 0.5 BD.
* On-time rate of 100% for both notifications and request responses.

---

## LQ-15 — Documentation and Retention {#lq-15-documentation-and-retention}

**WHY (Reg cite):** Pynthia adopts the records-preservation and retention guidance of [12 CFR Part 749](https://www.ecfr.gov/current/title-12/part-749) as an internal standard. Retained evidence demonstrates that the program required by [12 CFR §741.12](https://www.ecfr.gov/current/title-12/section-741.12) operated as written.

**SYSTEM BEHAVIOR:** All liquidity program artifacts are retained for 10 years from creation:

* Policies and limit registries
* Daily, weekly, and Board packs
* Stress packs
* Notifications and acknowledgments
* Facility tests, drills, and AARs
* Crisis decision logs

Each artifact is classified, anchored, and indexed within 2 BD of creation. Legal hold, destruction, and permanent-record mechanics are governed exclusively by [SC-02](#sc-02-record-retention-lifecycle-mechanics). The retention class for liquidity artifacts is write-restricted to the CCO.

**EVENTS:**

| When | What's needed | Produced (and logged) | Within |
|---|---|---|---|
| Liquidity artifact finalized (`record.created`) | Artifact (`record.artifact`), class (`record.class`), metadata (`record.metadata`), retention class (`record.retention_class`), anchor (`record.retention_anchor`) | Retention started (`record.retention.started`); clock set (`record.retention_clock_set`) | 10 years from anchor (enforced by `record.retention_expires_at`) |
| Retention started (`record.retention.started`) | Metadata (`record.metadata`), class (`record.class`) | Searchable index entry (`record.indexed`); index task closed (`task.completed`) | 2 BD (enforced by `record.index_due_at`) |

**ALERTS/METRICS:**

* Indexing latency: 95th percentile at or under 2 BD; zero items past `record.index_due_at`.
* Retention-gap count, meaning liquidity artifacts without a `record.retention_class`, held at zero.

---

## SC-02 — Record-Retention Lifecycle Mechanics {#sc-02-record-retention-lifecycle-mechanics}

> **Shared control — body pending.** The full embeddable block for SC-02 (the WHY, SYSTEM BEHAVIOR, EVENTS, and ALERTS/METRICS fields) lives in `shared-controls/record-retention-mechanics.md`. That file was not available to this drafting pass. It must be inserted here verbatim and in full before publication, without renumbering, retitling, or paraphrasing.

---

## Governance and Sign-Off {#governance}

* **Policy owner:** Patrick Wilson, Chief Compliance Officer. Governance of all controls is centralized with the CCO.
* **Program owner:** Chief Financial Officer.
* **Required participants:** CEO, ALCO, Treasury Operations, and the Board.
* **Approvals:** Patrick Wilson, Chief Compliance Officer (listed approver). Board approval is required before the effective date.
* **Review cadence:** Annual, plus ad-hoc reviews, per [LQ-01](#lq-01-policy-scope-and-risk-appetite).
* **Cross-references (out of scope here):**
  * Investment Policy: portfolio credit, valuation, and concentration. AFS marketability, haircuts, and pledging restrictions are governed jointly with [LQ-07](#lq-07-collateral-and-encumbrance-management).
  * Capitalization Policy and Basel-II Standardized Approach Framework Policy: capital adequacy and reserves.
  * Cash Policy: physical cash and vault operations.
  * Enterprise Risk Management Policy: risk appetite beyond liquidity.
  * Business Continuity Plan: operational resilience.
  * OCC and FDIC liquidity materials are excluded.

---

## Assumptions and Gaps {#assumptions}

* **Engineering vocabulary is provisional.** Two codes in this policy are not yet registered in `core-vocabulary.json` and must be confirmed by engineering before the next review:
  * `crisis.team_convened.recorded`
  * `funding.source_unavailable.flagged`

  Both were composed from registered objects, fields, and actions. No new object prefixes, actions, or task types were coined.
* **Shared control SC-02 body is missing.** The embeddable block in `shared-controls/record-retention-mechanics.md` was not available. It must be inserted verbatim before publication. Until then, legal-hold, destruction, and permanent-record mechanics for liquidity artifacts are undocumented in this policy.
* **Control consolidation.** Patrick's 21 items were consolidated into 15 controls to remove duplicated deadlines and events. The mapping is:

  | Patrick item(s) | Control |
  |---|---|
  | (a) | LQ-01 |
  | (b), (h) | LQ-02 |
  | (c) | LQ-03 |
  | (e), (n) | LQ-04 |
  | (d), (g) | LQ-05 |
  | (f) | LQ-06 |
  | (l) | LQ-07 |
  | (m) | LQ-08 |
  | (i) | LQ-09 |
  | (o) | LQ-10 |
  | (p), (r) | LQ-11 |
  | (q) | LQ-12 |
  | (k), (t) | LQ-13 |
  | (j), (s) | LQ-14 |
  | (u) | LQ-15 |

  Confirm the consolidation is acceptable.
* **Regulatory applicability.** As a proposed California state-chartered credit union with private share insurance (ASI), Pynthia is not directly subject to 12 CFR Parts 741 or 749. Both are adopted voluntarily, and Pynthia applies the $250MM-tier federal-source expectations regardless of asset size. Confirm whether California DFPI or ASI impose equivalent or additional liquidity, CFP, or notification requirements.
* **Notification recipient.** Patrick specified NCUA. NCUA may not be Pynthia's primary supervisor under private insurance. Confirm whether DFPI and ASI should receive the same 24-hour notices, and whether the CCO is the correct transmitter.
* **Federal source eligibility.** Confirm with the following parties that Pynthia, as a privately insured state credit union, qualifies for the access paths assumed in [LQ-12](#lq-12-funding-playbooks-and-draw-order) and [LQ-13](#lq-13-federal-liquidity-access-drills-and-after-action-reviews):
  * The Federal Reserve Bank of San Francisco, for Discount Window access.
  * CLF, for direct or agent-member access.
  * The FHLB district, for membership.
* **LAR definition.** LAR is assumed to be liquid assets (cash, Federal Reserve and corporate credit union balances, unencumbered AFS after haircut) divided by total assets. Confirm the numerator components and the denominator (total assets versus total shares).
* **Limit values not supplied.** The Board must set the following in the [LQ-01](#lq-01-policy-scope-and-risk-appetite) limit registry before go-live:
  * Mismatch limits per bucket.
  * Top-10 depositor, single-partner, and single-provider limits.
  * Wholesale and listing-service caps and the rate grid.
  * The collateral headroom floor.
  * The survival-days target that drives CFP escalation. Only the 15-day notification floor was given.
* **Undefined thresholds.** Definitions are needed for:
  * "Large unscheduled flow" ([LQ-03](#lq-03-maturity-mismatch-limits)).
  * "Large collateral move" ([LQ-07](#lq-07-collateral-and-encumbrance-management)).
  * "Material change" ([LQ-01](#lq-01-policy-scope-and-risk-appetite)).
  * "EWI spike" versus "major event" ([LQ-10](#lq-10-early-warning-indicators-and-event-triggers)).
* **CFP escalation and step-down.** Patrick tied levels to LAR bands only. Two rules were assumed and need confirmation: the CEO may escalate, but never de-escalate, on survival or EWI evidence; and step-down requires LAR recovery plus CEO approval.
* **Assumed internal SLAs and cadences.** The following were set where the notes were silent:
  * Same-day disposition of mismatch breaches.
  * Board approval for concentration waivers longer than 90 days.
  * Next-business-day correction of facility schedule drift.
  * Quarterly verification of regulator contacts.
  * Annual tabletop frequency.
* **Time zone and business days.** All clock times are assumed to be Pacific Time. Business days are assumed to exclude Federal Reserve holidays.
* **Approval authority and dates.** Only the CCO is listed as approver, but a Board-approved policy is the benchmark under [12 CFR §741.12](https://www.ecfr.gov/current/title-12/section-741.12). Board approval must be added. The effective date and version are placeholders pending that approval.
