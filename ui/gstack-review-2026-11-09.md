# Gstack design and product review comparison

Review date: 2026-11-09. Status: DONE_WITH_CONCERNS, findings open. Requested by Lorenzo to compare Gstack with the initial design critique and subsequent Chrome bug hunt.

## What actually ran

Installed [official garrytan/gstack](https://github.com/garrytan/gstack) at commit `7dace1fdeabc4ad5ebddcf9f5fa3b80279a68121`, installer version `1.98.0.0`. Official `setup --host codex --no-browser --no-harness-auto`, with native CSO build skipped, completed successfully. `setup --status` reports the Codex global install current and all 74 section links resolving. Codex support is marked experimental by the installer.

- Source/runtime: `~/.local/share/gstack`; generated skills: `~/.codex/skills/gstack-*`; shared router: `~/.codex/skills/gstack`.
- Bun 1.4.2 is isolated under `~/.local/share/gstack-runtime/node_modules/.bin`. Helper invocations used that directory on PATH; shell startup files were not changed.
- Applied `gstack-design-review` audit phases and `gstack-plan-ceo-review` product/strategy questions. There is no literal PM skill in the selected pair. `plan-design-review` reviews a proposed implementation plan, so it was not substituted for the existing-site audit.
- Adaptations: review-only, no automatic fixes/commits; guarded Cassandra Chrome through CUA instead of Aside or Gstack Chromium; strategy findings rather than an interactive approved implementation plan. No clean-tree manipulation, external publishing, or financial actions.
- Gstack skill-start commands succeeded for both skills; telemetry and artifacts sync reported off. Model overlay reported `gpt-6-astra`. The workflow is a prompt/tool framework, not another model.
- The requested native design-consistency subagent completed a fresh-context source review. Mandatory README/log context contained summaries of earlier findings, so it was not fully blind. It did not open the prior review reports. The primary reviewer already knew the baseline.
- Gstack's Claude command resolver returned `CLAUDE_UNAVAILABLE`. No external Claude review ran; native agreement is single-model agreement, not independent cross-model confirmation.

This is an adapted Gstack evaluation, not a claim that its full audit/fix/commit loop, external review, automatic detector, or implementation-approval gates passed. Newly installed skills become discoverable by Codex on a subsequent turn/session; their files were read and applied directly here.

## Evidence and coverage

Fresh desktop review at 1440×900: Home, Approvals, Teller, Reports, Call Report, Accounting. Reports additionally inspected at 375×812 and 768×1024. Eight screenshots saved in [gstack-evidence-2026-11-09](gstack-evidence-2026-11-09/). Browser viewport restored, task tab retained for completion confirmation. No draft values changed during this run.

Earlier interaction evidence is reused explicitly from [bug-hunt-2026-11-09.md](bug-hunt-2026-11-09.md), including member/account navigation, teller filtering, global search, accounting drilldown, filing clear, report filtering, and monitoring trace. Those bugs were not independently rediscovered by Gstack. The fresh run inspected six screens and rendered semantics; it did not repeat a full transaction flow or every viewport on every screen.

The current checkout is `b7557fa`; its deployed revision was not independently matched. Source-only findings below do not establish deployed runtime behavior. Full contrast measurements, assistive-technology testing, reduced-motion emulation, LCP/CLS measurements, fault injection, auth/role enforcement, filing export correctness, and financial write paths remain unverified. The final Accounting console-log read returned no captured errors/warnings; this is not whole-site error certification.

## Design review

### First impression and page areas

The site communicates an orderly banking console. On Home my eye goes first to the Pynthia Banking identity in the left rail, then Dashboard, then the repeated navigation tiles and bold account balances. One-word impression: **catalogue**. The large center area tells me which records exist more clearly than what needs my attention.

The rail is navigation; the top bar is lookup and utilities; the page header identifies the destination; the four large tiles duplicate navigation; the account area is browsing; recent activity follows below. The account collection's selection rule is the area whose purpose is unclear: it does not say these are recent, assigned, exceptional, or otherwise relevant accounts.

This is APP UI. A restrained system font and minimal motion are appropriate candidates for an operating console. Gstack's preference for expressive fonts or an authored entrance animation is not sufficient justification for changing them.

### Rendered design system

Home uses Arial/Helvetica for visible text and a system sans stack elsewhere in the DOM. Its h1 is 24px/600 and h2s 18px/600. The extracted foreground palette is predominantly slate with a blue accent. Sidebar links are 40px high; search is 36px; notification/admin icon targets are 20×20px. This is below Gstack's 44px touch-target heuristic, not by itself a complete WCAG verdict. Borders, spacing, and alignment are broadly consistent. There is no evidence here that the app needs a new visual brand.

### Findings

| ID | Impact | Observation and consequence | Recommendation | Evidence / relation to baseline |
|---|---|---|---|---|
| G1 | High | Home gives repeated destinations and twelve account cards more emphasis than staff work. The first screen cannot tell an operator which item deserves attention. | Reduce repeated navigation; prioritize supported work and recent activity. Do not invent urgency or counts. | [Home](gstack-evidence-2026-11-09/home-desktop.jpg). Confirms original finding 2. |
| G2 | High | Teller promises walk-in transactions and shows active drawer buttons beside a read-only transaction control. Its local drawer has an old balance timestamp and no simulation label. | State environment, data provenance, persistence, and write capability separately. Label or remove local simulations from operational views. | [Teller](gstack-evidence-2026-11-09/teller-desktop.jpg); original finding 1 supplies source confirmation. |
| G3 | High | At 375px, Reports' table is 583px wide inside a 248px overflow-hidden container; search is only 87.7px wide. At 768px, the table still exceeds its 449px container, and search is 154.7px. | Fix the shared shell and table containment together. Give search adequate width, use table scrolling or compact rows, and check tablet as well as phone. | [Mobile](gstack-evidence-2026-11-09/reports-mobile.jpg), [tablet](gstack-evidence-2026-11-09/reports-tablet.jpg). Extends bug-hunt mobile clipping to tablet and measures search collapse. |
| G4 | High | Reports' four filter controls have no associated labels; its select is unnamed. Sampled filing inputs have no labels, IDs, aria-label, or aria-labelledby; they appear as textboxes named only by a dash placeholder. Narrow navigation again loses all ten link names. | Associate visible labels; name filing inputs by line description/code/context; retain accessible navigation names. | Live DOM probes plus [Reports](gstack-evidence-2026-11-09/reports-desktop.jpg), [Call Report](gstack-evidence-2026-11-09/call-report-desktop.jpg), [mobile](gstack-evidence-2026-11-09/reports-mobile.jpg). Forms extend earlier accessibility findings. Screenshot alone does not prove semantics. |
| G5 | High, source-only extension | Search/list errors become empty results. In Approvals, failed flags can retain a loading message, and flags are nested under successful pending-queue data despite separate requests. | Give each source explicit loading, success-empty, success-data, error, and stale states. Keep independently available sections usable and offer retry. | Native source review: MainLayout.jsx:53/94; member-services.jsx:180/274; approvals.jsx:114/209/238. Original finding 8 already covered search/member ambiguity; approval dependency is new. Error state not forced live. |
| G6 | Medium | Approvals starts with long technical IDs and historical blocked records. A total of 100 flagged is qualified by a later cap explanation; 698 held is prominent but its corresponding queue is farther down. | Lead with readable subject/reason/age and distinguish actionable work from historical evidence. Put capped-count qualification beside the count. | [Approvals](gstack-evidence-2026-11-09/approvals-desktop.jpg). Confirms original finding 3. No claim these displayed counts represent the entire institution. |
| G7 | Medium | Essential qualifications are visually secondary: locally saved filing inputs, partial data, institution scope, and unavailable statement figures. Accounting also uses implementation language to explain missing features. | Make decision-relevant qualifications readable and adjacent to the affected number; move implementation details to an expandable source explanation. Preserve the warnings themselves. | [Call Report](gstack-evidence-2026-11-09/call-report-desktop.jpg), [Accounting](gstack-evidence-2026-11-09/accounting-desktop.jpg). Extends original findings 5/7. Exact contrast remains unmeasured. |
| G8 | Medium, source-only | Shared ledger disclosures lack expanded/controlled semantics; notifications lack the open-state relationship; inspected pulse/flash/smooth-scroll patterns have no reduced-motion alternative. | Standardize disclosure state and focus behavior; honor reduced motion without adding decorative animation. | Native source review: LedgerTree.jsx:100/161/291; MainLayout.jsx:274/288; Live.jsx:46/98; approvals.jsx:121. New systematic detail; keyboard and reduced-motion runtime behavior not certified. |

### Navigation test

Gstack's six checks ask: site, page, major sections, available options, current location, and search. At desktop, Home/Approvals/Teller/Reports/Call Report/Accounting each pass identification and search discoverability from their visible shell. The test does not establish task completion: Approvals' next step and Teller's action persistence still fail a stronger workflow test. At mobile Reports, site identity disappears into a shield and navigation destinations lose names; record PARTIAL rather than desktop PASS. The tablet view retains labels but clips information.

### Scoring and interpretation

No full ten-category letter grade is issued: contrast and performance measurements were not completed, and the complete responsive matrix was not run. Assigning untouched categories A would inflate the score. Gstack's strongest qualitative warnings are hierarchy, interaction states, and responsive behavior. Its generic-card-grid warning applies to Home, but is not proof of AI authorship. Useful working grades for the observed dimensions are hierarchy B, interaction states C, responsive B, and content B; these are subjective review rubrics, not validated usability measurements or release criteria.

The seven design litmus checks: product identity YES on desktop / NO on phone; one strong Home anchor NO; page understandable by headings YES; sections have recognizable jobs YES; every card necessary NO; useful state motion YES, with source-level reduced-motion concerns; structure survives removal of decorative shadows YES.

### Interaction and goodwill review

Reuse of the earlier live flows, assessed with Gstack's qualitative goodwill framework:

- Member investigation: discoverable search and direct member/account links save steps; stale search results and the forced Back to Teller destination erode confidence. Those state defects matter more than visual polish.
- Compliance investigation: direct links from control to reports are useful; a trace claiming no decision while Reports shows one breaks the evidence chain. No aesthetic score offsets that defect.
- Filing preparation: the partial/not-submittable warning and explicit local-save note are helpful; clearing a draft then resurrecting a value on blur is a stop-ship correctness issue for that interaction.

No invented user-satisfaction score: these are reviewer judgments, not observed staff research.

### Quick wins to validate

Candidate small fixes, estimated from source rather than implemented: associate Reports labels; keep sidebar names accessible; add explicit view-only/local-simulation copy; expose a horizontal scroll region for Reports and Approvals; add expanded-state semantics to ledger disclosures. Each needs real browser verification. The full filing reset and trace join fixes should not be disguised as cosmetic quick wins.

## Product review using plan-ceo-review

### Premise challenge

The problem is not principally that this console looks generic. It is that staff cannot consistently tell what is real, what is complete, what they can act on, and whether the evidence agrees across screens. A prettier dashboard could conceal these limits.

The current product reads most credibly as a **staff investigation and evidence console with local preparation and a narrow compliance escalation write**, pending a separate decision about broader banking operations. The banking proxy is GET-only, but the entire UI is not read-only. Source shows ControlStream.jsx:119 → api.js:912 → pages/api/compliance/flag.js:46 → coreWrite.js:29, a dedicated POST route described as demo/sim escalation persistence. This corrects an overly broad premise in the first draft of this comparison. Submission, actual deployed persistence, authorization, and duplicate behavior were not tested. This interpretation does not narrow Cassandra's ambitions or remove capabilities. Cassandra's broader institution-building mission does not require this UI to pretend unsupported operations exist.

Current state → proposed near-term outcome → longer-term possibility:

```
Banking reads + local drafts/simulations + narrow demo escalation write
  -> reliable investigation, clear provenance, recoverable state
  -> broader evidence-backed operational workflows, if authorized
```

The last transition needs product and API authorization. It is not approved by this review.

### Alternatives and reuse

1. Cosmetic redesign first: fast visible change, but leaves the strongest trust failures intact.
2. Correctness and truthful capability boundaries first: recommended; preserves the shell, evidence links, read-only proxies, existing fetch wrapper, and member split view.
3. Build a full operational core workflow now: much broader API, authorization, accounting, and test scope; unsupported by this request.

The earlier recommendation to put a work queue on Home needs one qualification: a queue must have trustworthy lifecycle/ownership/next-action data. Until that exists, use clearly named read-only exception summaries and direct links. Renaming historical flags as tasks would repeat the same product error.

Historical vendor ideas in product-research.md are context, not commitments or current vendor facts. No fresh competitive landscape analysis was performed, and no vendor recommendation follows from this review.

### Eleven-section strategy review

| Gstack section | Result and practical consequence |
|---|---|
| 1. Architecture | Keep banking page → client hook → GET-only allowlisted proxy → core, plus the dedicated compliance flag POST route. Separate local drafts/simulations and demo/sim escalation writes visibly. Do not add broader writes to satisfy an action-oriented mockup. Single upstream failures should not hide independent datasets. |
| 2. Error/rescue | CRITICAL GAP: empty, failed, unavailable, and stale data can look alike. Use the capability map below. No network failures were induced in this run. |
| 3. Security | GET-only banking proxies limit write surface but do not prove authentication or role authorization; the dedicated flag POST has its own authorization and persistence questions. The visible seeded teller persona is not evidence of access control. Auth/PII scope needs an engineering/security review before operational deployment; no vulnerability is asserted from missing evidence. |
| 4. Interaction edge cases | CRITICAL GAP: earlier clear/blur resurrection and missing trace decision remain unresolved. Search edits and URL-filter reset also violate user expectations. Escalation duplicate-submission behavior is outside live coverage and must be checked separately; the audit itself performed no writes. |
| 5. Code quality | Reuse Live and useLiveCore where their contracts fit; standardize state semantics and disclosure/form primitives. Conventional Tailwind spacing already works; replacing the whole component system is not justified. |
| 6. Tests | Require live replay of the observed failures after any fix, plus real-service failure-state validation where safely available. Build/lint alone cannot prove correctness. No new tests were run because app code did not change. |
| 7. Performance | Exact latency, LCP, CLS, 10× data behavior, and long-queue rendering were not measured. Capped counts already require explicit semantics. Do not treat counts or an empty console log as performance evidence. |
| 8. Observability | Prioritize evidence-chain completeness, last successful load, and source errors. Proposed success measures: time to identify a relevant exception, correct interpretation of empty/error, and repeatable trace-to-result agreement. No baselines exist yet. |
| 9. Rollout | No deployment proposed in this review. A later implementation should fix correctness first, verify locally against real services, then repeat on the deployed revision. Preserve ability to roll back UI changes; no schema migration is justified by this audit alone. |
| 10. Long-term trajectory | Preserve reusable legal/control evidence and practical staff investigation. Small shell/state fixes are reversible. New workflow ownership and operational writes create larger commitments and need separate approval. Lending remains deliberately outside routed core scope. |
| 11. Design/UX | Keep calm styling and direct evidence links. Resolve provenance, incomplete state coverage, labels, and clipped tables before making the console denser or more animated. Validate primary role and recurring task with staff before reorganizing every destination. |

### Capability error and rescue map

| Capability | Failure mechanism | Current evidence | Proposed user-facing recovery | Verification required |
|---|---|---|---|---|
| Search/member list | Fetch fails or result belongs to old query | Source-confirmed error masking; prior stale-results reproduction | Specific failure with retry; results tied to submitted query | Real-service failed read where safely reproducible; edit query before/after response |
| Approval sections | One request fails while another is available | Source-only dependency/loading finding | Independent sections with local error and retry | Real failure of each source in turn, no fake services |
| Filing draft | Clear state but uncontrolled input retains value | Earlier live reproduction | Clear visible and persisted values together; no blur resurrection | Enter → clear → focus/blur → navigate/reload; confirm empty throughout |
| Trace | Resource representation differs across tables | Earlier live reproduction plus source join analysis | Complete associated decisions; distinguish incomplete lookup from none | Compare known blocked freeze across trace and Reports |
| Report filters | UI state and URL diverge | Earlier live reproduction | One synchronized filter state | Apply → clear → reload/back, expect same visible filter |
| Compliance escalation | Submission failure, repeated action, scope or authorization mismatch | Dedicated POST path confirmed in source; live behavior unverified | Existing source returns field/upstream errors; implementation owner must prove scope, authorization, and duplicate behavior | Authorized real-service escalation flow, not executed here |
| Narrow layout | Container clips table; shell compresses search | Fresh live mobile/tablet measurements | Usable search and access to every column | 375/768/1440px, keyboard and zoom checks |

### Flow and proof map

```
Find record -> inspect account -> inspect control -> inspect result/trace
    |               |                 |                   |
 empty/error     retain context    readable reason    same evidence

Open filing -> edit locally -> clear -> blur -> revisit/reload
                   |             |                  |
              explicit draft   visible empty    stays empty
```

All checks are proposed acceptance evidence, not claims of completed remediation. Empty success must remain distinct from failed retrieval. Known live bugs remain open until the full flow passes against real services on the consumed deployment.

### Decision ledger

| ID / owner | Contract and evidence | Current | Proposed | Status | Exact approval |
|---|---|---|---|---|---|
| D0 / reviewer | User asked install, review, compare | Existing app unchanged | Install and produce findings | Approved and completed | Current user request only |
| D1 / Lorenzo + product | Read-only proxy and mixed local UI | Operational-looking console | Agree the primary role and truthful capability promise | Unresolved | No product change approved |
| D2 / implementation owner unassigned | Eight existing live defects | Open | Fix state/evidence correctness before visual changes | Proposed | No fixes requested in this turn |
| D3 / implementation owner unassigned | G3/G4/G5/G8 | Open | Shared state, form/disclosure, and responsive corrections | Proposed | No fixes requested in this turn |
| D4 / Lorenzo + design | G1/G6 | Catalogue and historical flags | Reprioritize Home/Approvals using supported actionable data | Unresolved | No new workflow or navigation approved |

## Comparison with the earlier analysis

| Topic | Initial critique / bug hunt | Gstack contribution | Conclusion |
|---|---|---|---|
| Trust and provenance | Strong initial finding | Product framing makes this the capability promise of the entire console | Same diagnosis, stronger sequencing rationale |
| Home hierarchy | Duplicate cards and irrelevant accounts | Card-grid litmus confirms the visual symptom; PM lens challenges whether a real work queue exists | Keep recommendation, qualify implementation prerequisites |
| Approval usefulness | Raw IDs, capped totals, historical flags | Error coupling and indefinite loading add a concrete source defect | New actionable detail, not a new overall diagnosis |
| Accessibility | Shared semantics and mobile labels | Live verification of missing Reports/form labels; disclosures and reduced motion from source | Useful added coverage |
| Responsive behavior | Reports broken at 390px | Confirmed at 375px and 768px; measured tiny search field | Broader reproducibility and shared-shell root cause |
| Correctness bugs | Filing resurrection, trace omission, filter URL, stale search | Not independently rediscovered; used as existing evidence in the product review | Prior Chrome work remains more concrete here |
| Visual styling | Preserve quiet shell; polish later | Some Gstack font/motion rules would push unnecessary decoration | Do not apply marketing rules mechanically |
| Capability scope | Earlier emphasis on read-only banking and local simulation | Product challenger caught an omitted dedicated compliance escalation POST path | Correct the broad read-only framing; no live write capability certified |
| Overall priority | Trust/semantics → hierarchy → polish | Correctness → truthful states/capabilities → supported task hierarchy → polish | Strong agreement with a tighter release order |

**Assessment:** Gstack added value as a structured checklist and a product challenge. It did not overturn the initial critique, and installing it did not produce an independent AI verdict. The best new evidence is the form labeling and tablet/search measurements; the best new source finding is approval-section failure coupling. Its largest strategic improvements are to demand a complete, truthful staff journey before adding more dashboard surface and to distinguish the existing narrow escalation write from broader operational banking writes. The native product challenger found that omission in the draft; the primary reviewer then verified the source path and corrected it.

## GSTACK REVIEW REPORT

| Review | Runs | Status | Findings |
|---|---:|---|---|
| Design audit, adapted | 1 | ISSUES OPEN | 8 grouped findings; 2 include source-only extensions |
| CEO/product strategy, adapted | 1 | ISSUES OPEN | Capability promise and priority proposals unresolved |
| Native design consistency | 1 | FINDINGS, single-model | 7 source findings integrated above |
| Native product challenge | 1 | FINDINGS, single-model | One material capability omission corrected in this report |
| External Claude | 0 completed | UNAVAILABLE | Resolver returned CLAUDE_UNAVAILABLE |
| Engineering / implementation plan | 0 | NOT RUN | No release or implementation clearance |

**OUTSIDE COVERAGE:** Native design source audit and product challenge completed. External model coverage unavailable. No cross-model claim.

**VERDICT:** Review comparison complete with concerns. No app fixes, operational readiness, approved implementation plan, or engineering clearance claimed.

**UNRESOLVED DECISIONS:**
- D1: Lorenzo/product to confirm primary operator and capability promise before substantial redesign.
- D2/D3: Assign implementation owner and choose a correctness/accessibility fix scope.
- D4: Decide Home/Approvals hierarchy only after confirming which workflow state the backend actually supports.
