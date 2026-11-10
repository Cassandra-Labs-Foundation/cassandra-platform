# Core UI design critique

Reviewed 2026-11-09 at Lorenzo's request using design:design-critique.

## Scope and evidence

Inspected the deployed desktop console at https://cassandra-platform.vercel.app: Home, Teller, Accounting, Approvals, Monitoring, and Member Services, including opening a member in the split workspace. Compared the visible screens with current source. The deployed commit was not independently matched to the local checkout. No financial actions were submitted, application code changed, or end-to-end transaction flow certified. Mobile, full keyboard behavior, and measured color contrast remain unverified.

## Overall assessment

The console has a calm, legible foundation: consistent sidebar, restrained blue accent, familiar tables, clear page titles, and useful links between evidence and operational records. Its largest weakness is that it presents a catalogue of system capabilities instead of prioritizing a staff member's work. Local fixtures, live reads of synthetic data, unavailable actions, and technical diagnostics need clearer distinctions.

Preserve the visual shell and the evidence links. Prioritize trust, task hierarchy, and interaction semantics before adding decorative polish.

## Prioritized findings

### 1. High: distinguish demonstration state from persistent actions

Observed: Teller shows a $5,000 drawer balance, a May 2025 last-balanced date, and active Buy Cash, Sell Cash, and Balance Drawer buttons. Beside this, New Transaction explicitly says read-only. The drawer itself has no visible simulation label. Source confirms its handlers update React session state, not a core cash record. The sidebar identity is also a seeded teller persona.

Why it matters: a user cannot infer which numbers come from the core or which actions survive a reload. A live connection does not establish production provenance.

Recommendation: a persistent environment label such as “Demo institution · synthetic data”; a separate “Local simulation · resets on reload” label for the drawer and persona; and action labels that state simulation when applicable. For a staff-facing version, remove simulated cash actions until they represent a persisted workflow. Keep data provenance, connection freshness, and write availability as separate concepts.

Sources: `src/components/teller/TellerDrawer.jsx`, `src/lib/context/SessionContext.js`, `src/lib/mock.js`, `DEPLOY.md`.

### 2. High: make Home an operational starting point

Observed: four large navigation tiles duplicate the sidebar. A grid of account cards takes the remainder of the initial viewport; recent transactions are below it. The page promises what is happening today but does not lead with deadlines, exceptions, or review work. Source loads twelve accounts without explaining why these are the accounts staff should see first.

Recommendation: lead with a prioritized work queue, with reason, age, status, and next available action. Follow with a compact institution summary and recent activity. Keep member lookup prominent. Move account browsing to a searchable list, or label a smaller list explicitly as recently viewed once that capability exists. Only show counts and urgency that real sources support.

Sources: `src/components/dashboard/Dashboard.jsx`; deployed Home.

### 3. High: turn Approvals into a legible review queue

Observed: the summary distinguishes held, flagged, and never-assessed items, which is useful. Below it, flags are grouped by control and rows lead with long account/event IDs. Grouping is by count, not an expressed review priority. The visible count is capped, with a separate explanation lower on the page.

Recommendation: lead rows with member/account display name, amount where available, plain-language reason, age, and review state. Keep IDs available through copy/details. Separate actionable held items from historical blocked/rejected decisions. Label capped counts as “shown” or “at least” as appropriate, adjacent to the number. Provide a clear next step or say “View only” when resolution is unavailable. Ownership and resolution controls should be introduced only with real backing workflows.

Sources: `src/pages/approvals.jsx`; deployed Approvals.

### 4. Medium: organize navigation around recognizable jobs

Observed: Compliance, Monitoring, Reports, and Call Report are peers without grouping. The Compliance destination is described elsewhere as the governance calendar, while Reports is linked as control results. This makes navigation labels less predictive than the destination-specific links.

Recommendation: group existing destinations under Member operations, Finance, and Compliance, with explicit names such as Governance calendar, Control monitoring, Control results, and Call report. Preserve direct access to frequent tasks. Show the parent section as active on member/account detail routes. Validate grouping with actual staff rather than assuming all teller, accounting, and compliance roles need the same start page.

Source: `src/components/layout/MainLayout.jsx`.

### 5. Medium: move implementation explanations behind task guidance

Observed: Member Services explains missing search features through storage and filter implementation; Accounting exposes phrases such as “core.loan has no writer” and bookkeeping-table limitations. Disabled actions occupy primary action positions.

Recommendation: use concise operational language: “Transactions cannot be posted in this console,” “Identity document unavailable,” or “Income statement unavailable: no income and expense ledger connected.” Put schema names, request details, and architecture explanations in an expandable data-source panel. Preserve honest limitations, but let them explain what the user can do next. Do not frame deliberately excluded lending as an accidental unfinished feature.

Sources: `src/pages/member-services.jsx`, `src/pages/accounting.jsx`, `src/components/dashboard/Dashboard.jsx`.

### 6. Medium: give monitoring an exception-first view

Observed: monitoring gives prominent space to overall event volume and similarly styled policy cards, including small sparklines. It also exposes coverage, silent/never-fired counts, reconciliation events, and production/simulated distinctions. These are valuable signals, but volume and alphabetical policy browsing do not directly establish which condition requires action.

Recommendation: put attention-required conditions first, with a reason, evidence window, and destination. Keep the policy grid as a secondary catalogue. Define what “silent” means, and distinguish no expected trigger from a missed expected event. Do not equate an event count with compliance effectiveness or treat every drift event as an unresolved incident. Use policy title and readable status as the main hierarchy; put miniature charts and raw codes in supporting roles.

Sources: `src/pages/compliance/dashboard/index.jsx`, `src/components/compliance/atoms.jsx`; deployed Monitoring.

### 7. High: fix semantic accessibility in shared interactions

Confirmed in source: accounting drilldowns use clickable `div` and `li` elements without equivalent keyboard controls. Global search relies on a placeholder without an explicit label. Sidebar labels disappear below the medium breakpoint without an alternative link label. Teller's modal uses generic containers without dialog semantics or explicit focus management in that component.

Recommendation: use native buttons/links for drilldowns, accessible names for search and icon-only navigation, `aria-current` for the active destination, and dialog primitives with focus entry, containment, Escape dismissal, and focus restoration. Enlarge compact icon targets and establish visible focus styling. Check the numerous 10–12px, pale metadata labels with measured contrast and zoom testing before claiming accessibility conformance.

Sources: `src/pages/accounting.jsx` (`Line`, `Ratio`, summary cards, recent-transfer rows), `src/components/layout/MainLayout.jsx`, `src/components/teller/TellerDrawer.jsx`, `src/components/compliance/atoms.jsx`.

### 8. Medium: distinguish loading, absence, failure, and unavailable data

Observed: Member Services initially displayed “No members returned,” then populated with 25 members. Source initializes an empty list and swallows initial-list failures into the same empty array. Global-search failures similarly become “No member found.” Accounting uses dashes for unavailable values and while information loads. These states require different user responses.

Recommendation: standardize Loading, Empty, Unavailable, Error, and Stale states. Provide retry where possible and keep last-successful freshness visible. “No matching member” must mean a successful search with zero results. Use skeletons only while loading and an explicit reason for unavailable financial figures.

Sources: `src/pages/member-services.jsx`, `src/components/layout/MainLayout.jsx`, `src/pages/accounting.jsx`.

## What to retain

- The quiet palette, readable primary headings, consistent borders, and predictable shell.
- Member Services' list/detail split, which preserves search context while inspecting a record.
- Direct links between approvals, controls, reports, and affected records.
- Explicit limits and missing-data explanations, rewritten for the operator rather than removed.
- Approvals' distinct review categories and monitoring's provenance distinctions.

## Suggested sequence and acceptance checks

1. Trust and semantics: identify demo/local states, remove ambiguous action promises, correct misleading empty states, and fix shared keyboard semantics.
2. Operational hierarchy: redesign Home around real work queues; simplify labels and organize navigation; make Approvals human-readable.
3. Visual refinement: standardize cards, tables, status chips, readable metadata, source panels, and compact versus expanded density.

Proposed acceptance checks, not yet executed: a new staff user can identify the environment and whether an action persists; find a member and open an account without losing context; identify the next item requiring review and its evidence; distinguish failed data retrieval from an empty result; and complete these navigation flows with keyboard alone. Validate narrow viewport and zoom behavior against the real deployed services. Implementation owner and delivery date remain unassigned pending Lorenzo's prioritization.
