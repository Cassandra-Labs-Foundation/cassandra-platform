# Cassandra: accepted interaction example

The user accepted the direction of the nested `control-depth.html` prototype and requested this skill on October 3, 2026. This validates the design direction, not every implementation claim, layout detail or completeness of policy coverage.

## Purpose and audience

Patrick should be able to judge whether his intended control was implemented properly. Engineers who work on the project less frequently should be able to understand the actual Core API behavior. Both need a shared, human-readable representation as LLM-generated code grows in complexity. Operational control monitoring and automatic inconsistency detection were deferred.

## Worked path

BSA policy → BSA-06 Transaction monitoring & case management → SAR decision & record → A different officer decides → authorization and case-state checks.

Another path is BSA-06 → Alert triage & investigation → Close with an explanation → saved alert state and attempted explanation event.

The parent control connects large-movement detection, alert triage/investigation and SAR decision recording. Each process opens into its own decisions and actions; each action opens into implementation mechanics. Returning through breadcrumbs restores the enclosing diagram. Engineering detail adds contracts without replacing shared domain language.

## Historical source grounding

Asset data was manually traced at revision `ca61c1c87045ba969e73c13f2df3330ba65d73f6` of `cassandra-labs-foundation/cassandra-platform`:

- `compliance/policies/bsa/bsa.md`: BSA-06 intent.
- `core/supabase/functions/api/transfers.ts`: gate ordering and large-movement detector.
- `core/supabase/functions/api/bsa.ts`: alert, triage and decision handlers.
- Related `transfers.test.ts` and `bsa.test.ts`: test definitions, not executed evidence.

At that snapshot, useful inspection boundaries included a velocity block preceding the detector; a strict greater-than-$10,000 comparison; weekends-only business-day arithmetic; token-based actor separation; recorded but unenforced committee composition; and an internal `sar.filed` event that did not establish external submission. Some event failures were caught after business-state writes.

Re-read current sources before using any of these as current facts. Other detectors, full payment processing, timer sweeps, external filing, Board reporting and full retention enforcement were outside the modeled slice.

## What was rejected

An earlier prototype used numbered “Recognize a signal / Assess the alert / Record a decision” stage tabs. The user found the labels generic and the interaction shallow: it moved between process stages without opening elements to show their contents. An even earlier abstraction toggle relabeled the same topology. Neither satisfies the depth requirement.

## Asset limitations

`../assets/control-depth.html` is a self-contained inline fragment with historical data, basic CSS layout and local state. Its node drill-ins, ancestors and toggles were exercised with a lightweight DOM harness; browser appearance was not verified. Some leaf branches are expressed as text inside a sequence; improve their visual branching when relevant. The asset is an interaction exemplar, not a production extractor or a requirement to preserve its exact markup.
