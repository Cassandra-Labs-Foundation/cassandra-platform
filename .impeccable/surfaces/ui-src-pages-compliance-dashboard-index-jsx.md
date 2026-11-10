---
version: 1
slug: "ui-src-pages-compliance-dashboard-index-jsx"
primary_target: "ui/src/pages/compliance/dashboard/index.jsx"
related_targets: ["ui/src/pages/compliance/dashboard/[policy].jsx"]
---

# Surface: Compliance Monitoring (/compliance/dashboard, policy and control pages)

Mode: Operate. First expression of the Cassandra identity; the rest of the console inherits it.

- Audience and job: staff (BSA officer, compliance) checking which controls fired, went silent or never fired, and acting on an event (trace, flag); examiners verifying a control from the same screen.
- Content: live data only: 7-day window, events, coverage (live / silent / never), per-policy counts, heartbeat, ledger drift, per-control event history with trace and flag. No invented figures.
- Constraints: spec-derived proxy (read-only plus the flag route); honest blanks stay labeled; WCAG AA contrast; 12px floor; works at 390px.
- Chosen direction: the category standard (canon), chosen by Lorenzo 2026-11-10 over the rolled "Station Plot". Quality bar: Mercury and Stripe Dashboard.
- Unresolved: final typeface, exact brand hue, dark mode.

## Direction contract

THESIS: The category standard, executed at Stripe/Mercury craft. Refuses legacy-core density and binder-like compliance forms; conventions embraced without irony or smuggled quirk.

OWN-WORLD: Navy rail (#0d2342) with grouped, icon-led nav and a raised white active chip; cool #edf1f6 canvas; white cards with no hard borders, lifted by layered navy-tinted shadows (e1 at rest, e2 on hover); one blue accent (#1f5eff) for action, selection and production evidence; green/amber/grey live-silent-never; soft status pills; Source Sans 3 with tabular figures, JetBrains Mono only for codes and IDs.

STORY: The user sees in seconds how many controls produced evidence this week, which policies are healthy or gapped, and where the burst or drift is, then opens a policy, then a control, then an event to trace or flag it.

FIRST VIEWPORT: Navy rail left (Cassandra mark, Pynthia institution card, Operations / Compliance / Reporting groups, demo-data badge, user footer). Header: member search, live core heartbeat pill, bell. Title "Compliance Monitoring" with Obligations and Control results links right. Main column: 3 KPI cards (events with stacked area and busiest-moment marker; controls with evidence as a live/silent/never bar; ledger reconciliation), an amber attention banner naming policies with no or mostly silent evidence, then policy cards sorted attention-first. Right column (360px, sticky): latest events across controls, each linked to its control. Approved sketch: .impeccable/mocks/decision/canon-v3.html.

FORM: canon (category standard), chosen over list position 7 (Station Plot); seed:5c804128b3f9afdc

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
