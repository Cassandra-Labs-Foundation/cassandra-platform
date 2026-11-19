# Liquidity Policy — Summary

> This document serves two purposes:
> 1. A plain-language summary of our Liquidity Policy that a regulator or
>    examiner can read end-to-end in a few minutes.
> 2. The canonical input that our regeneration task feeds into the shared
>    meta-prompt to produce the full Table-First, Design-Overlay v2 policy
>    document.
>
> Edit this file directly when the policy's substance, scope, or ownership
> changes. The regenerated long-form policy is rebuilt from this summary plus
> the reference documents in `references/`.

---

## Organization and Ownership

**Organization:** Pynthia Credit Union
**Policy Owner:** Patrick Wilson, Chief Compliance Officer
**Approvers:**
- Patrick Wilson, Chief Compliance Officer

## 1. Purpose and Scope

This policy establishes Pynthia Credit Union's risk-based liquidity program and written Contingency Funding Plan (CFP). The Liquidity Policy defines what we measure, limit, and report in normal conditions; the CFP defines how we detect stress, escalate, and execute funding actions when indicators breach triggers. It applies across the credit union's funding and balance-sheet activities, including BaaS partner flows, and aligns to NCUA requirements.

## 2. Key Regulatory Authorities

- **NCUA 12 CFR §741.12 (Liquidity and Contingency Funding Plans)** — board-approved liquidity program; a written CFP is required for credit unions of $50MM or more, and documented access to a federal contingent liquidity source (CLF and/or Federal Reserve Discount Window) is required at $250MM or more.
- **Central Liquidity Facility statute (12 U.S.C. §§1795–1795k)** — eligibility, membership/agent membership, and the purpose of federal emergency liquidity for credit unions.
- **Federal Reserve advances / Discount Window (12 U.S.C. §347b)** — authority for Federal Reserve advances to depository institutions, used as a federal contingent liquidity source.

## 3. What This Policy Must Cover

Liquidity risk at Pynthia is concentrated in cash-flow mismatch, funding concentration, and the ability to survive idiosyncratic and systemic stress — and in the readiness, escalation discipline, and federal-access arrangements that let the credit union execute funding actions before a stress event becomes a crisis.

The policy must establish the following controls:

**(a) Policy Scope & Risk Appetite.** Enforce a single liquidity standard across scope, maintain a versioned policy and limit registry, and review at least annually (ad-hoc within 10 business days after material changes).

**(b) Definitions & Ratios Catalogue.** Maintain a central library of standardized metrics (LAR, cumulative mismatch, survival horizon, concentration) kept synced to GL mapping daily.

**(c) Maturity Mismatch Limits.** Compute cumulative cash-flow gaps in time buckets (O/N, 2–7d, 8–30d, 31–90d, 91–365d, >1y) daily by 16:00 against limits, recalculating intraday on large unscheduled flows.

**(d) Survival Horizon & Coverage Days.** Model survival days under idiosyncratic and combined stress quarterly, and ad-hoc within 2 business days when early-warning indicators spike.

**(e) Liquid Assets Ratio Bands.** Compute LAR daily by 16:00 and classify into policy-set bands (Normal ≥10%; Watch <10%; Low <8%; Critical <6%), raising real-time alerts on breach.

**(f) Funding Concentration & Counterparty Limits.** Track top-10 depositors and single-provider/facility reliance limits daily, with a waiver workflow resolved within 2 business days.

**(g) Stress Testing.** Run idiosyncratic, systemic, and combined scenarios (including intraday peaks and BaaS shocks) quarterly, re-running within 5 business days on a major early-warning indicator.

**(h) Data Quality & Model Governance.** Maintain data lineage and assumption catalogs, tie out to GL daily, and obtain independent model review annually with segregation between model builders and reviewers.

**(i) Reporting Cadence.** Auto-generate a daily ops pack (17:00), weekly ALCO digest (Fri 12:00), and quarterly Board deck (+5 business days), with sign-offs.

**(j) Regulatory Notification.** Notify NCUA within 24 hours when CFP Level 2 or 3 activates, a federal facility is used or attempted, survival falls below 15 days (combined), or LAR falls below 6%.

**(k) Contingent Federal Liquidity Access.** Maintain CLF membership/agent access and Discount Window operational readiness, keep collateral schedules current, and conduct an annual (funded or no-funds) test.

**(l) Collateral & Encumbrance Management.** Track eligible/unencumbered balances and haircuts by counterparty under dual control, updating daily and re-checking after large moves.

**(m) Wholesale / Listing-Service Deposits Guardrails.** Allow approved listing services with tenor laddering and enforced pricing authority, updating exposure daily with monthly ALCO review.

**(n) CFP Purpose & Activation.** Define activation Level 1 (Watch), Level 2 (Low), and Level 3 (Critical) tied to the LAR bands, starting transition actions within 2 hours of Level 2/3.

**(o) Early-Warning Indicators & Event Triggers.** Monitor volatile-liability growth, concentrations, negative press, asset-quality deterioration, rising funding costs, margin calls, early CD redemptions, and correspondent line cuts daily with weekly CEO summaries.

**(p) Escalation Ladder & Crisis Roles.** Define crisis roles (CEO external comms, CFO liquidity ops, ALCO advisory, Board extraordinary measures) and convene the crisis team within 60 minutes of Level 2/3.

**(q) Funding Playbooks & Draw Order.** Specify an internal-then-external draw order (cash/Fed balances, unencumbered AFS, saleable loans; then FHLB if eligible, Discount Window, CLF, listing-service CDs), executing first-line actions within 2 hours of Level 2 under dual authorization on external draws.

**(r) External Communications & Stakeholder Matrix.** Designate the CEO as sole spokesperson, use scripted updates to major depositors/partners, and issue Level 2/3 communications same-day.

**(s) Regulator Liaison Protocols.** Maintain examiner/region contacts and event memos and respond to regulator requests within 1 business day unless otherwise directed.

**(t) Liquidity Drills & After-Action Reviews.** Run an annual facility test and tabletop exercises, publishing the after-action review within 10 business days with remediation owners and dates.

**(u) Documentation & Retention.** Retain policies, limits, packs, notifications, facility tests, drills, and AARs for 10 years, indexed within 2 business days of creation, with legal-hold capability.

Governance of these controls is centralized with the Chief Compliance Officer, with the CFO (program owner), CEO, ALCO, Treasury Operations, and the Board as required participants and approvers.

## 4. Out of Scope

- Investment portfolio credit, valuation, and concentration controls — see Investment Policy. Liquidity-relevant characteristics of the investment portfolio (AFS marketability, haircut schedules, pledging restrictions) are governed jointly; see Investment Policy and Collateral & Encumbrance Management (§3(l) above).
- Capital adequacy and reserve frameworks — see Capitalization and Basel-II Standardized Approach Framework Policies.
- Physical cash and vault operations — see Cash Policy.
- Enterprise-wide risk appetite governance beyond liquidity — see Enterprise Risk Management Policy.
- Business continuity and operational resilience — see Business Continuity Plan.
- OCC/FDIC liquidity materials — excluded; scope follows NCUA standards, applied voluntarily (Pynthia is a proposed California state-chartered credit union that intends private share insurance through American Share Insurance).

## 5. System Design Notes

**This section is resolved dynamically at regeneration time.** The
regenerator must invoke the project-scoped `vocabulary` skill (see
`.skills/vocabulary/SKILL.md` at the project root) and inline its
entire stdout as the `DESIGN_NOTES` input to the shared meta-prompt.
Do not hand-curate event or field names here — the skill is the source
of truth and `core-vocabulary.json` evolves.

**Directive to the regenerator.** Before assembling the INPUTS block,
run the skill's extraction script from the project root:

    python3 .skills/vocabulary/scripts/extract_vocabulary.py

Capture the complete stdout verbatim and use it as `DESIGN_NOTES`. The
skill emits a self-contained Markdown block (per-entity field tables
plus events, endpoints, state machines, and plugins). Do not trim,
summarize, or reorder its output — the meta-prompt decides what is
relevant for the policy.

**Failure handling.** If the script exits non-zero, `core-vocabulary.json`
is missing, or the skill reports a parse error, record the failure in
the run summary and proceed with `DESIGN_NOTES` empty. Never invent
event codes or field names; the Design Overlay v2 blocks must only
cite codes that actually exist in the spec.

**Known state of the spec (as of regeneration time).** The parsed spec
is `Cassandra Banking Core API v1.0.0`, which is banking-core
(deposits, transfers, cards, BSA). Treasury and liquidity entities and events — liquid-asset-ratio calculations, cash-flow gap buckets, stress-test runs, funding concentration, collateral/encumbrance tracking, CFP activation levels, and federal-facility draws — are likely sparse or absent in a banking-core spec, so the regenerator must mark them `(Assumption—needs confirmation)` per the meta-prompt's MISSING INFO HANDLING rule.

## 6. Local Overrides to the Shared Meta-Prompt

**Shared control SC-02: Record-retention lifecycle mechanics.**
This policy contains a control that embeds shared control `SC-02 — Record-Retention
Lifecycle Mechanics` immediately after its record-class-specific retention control
(`LQ-15`). Before generating, read `shared-controls/record-retention-mechanics.md` at
the project root and emit its "Embeddable block" **verbatim and in full**, including the
heading line itself:

    ## SC-02 — Record-Retention Lifecycle Mechanics {#sc-02-record-retention-lifecycle-mechanics}

Do not renumber this control into the LQ-xx sequence, do not retitle it, and do not
paraphrase the SYSTEM BEHAVIOR, EVENTS, or ALERTS body. The control ID `SC-02` and this
exact title must be byte-identical across all eight consuming policies.

`LQ-15` (the local retention control) covers only: the 10-year retention period for all
liquidity program artifacts, the 2-BD indexing SLA (`record.index_due_at`), and the
indexing-latency and retention-gap ALERTS. Do NOT include legal-hold, destruction, or
permanent-record EVENTS in `LQ-15` — those live exclusively in SC-02.
