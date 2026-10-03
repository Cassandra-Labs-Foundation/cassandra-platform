---
name: visual-control-architecture
description: Build or evolve interactive, source-grounded architecture documentation that lets humans drill from policy or backend components into implemented control logic. Use for visual policy-to-code inspection and architecture comprehension, rather than operational monitoring dashboards.
---

# Visual Control Architecture

Help humans understand what has actually been built and judge whether it implements the intended behavior. This matters especially when LLM-generated controls and backend code become too complex for conventional inspection.

The reviewer should be able to explain the path to a lay audience, while an occasional engineer can inspect the same model's decisions, dependencies and evidence. A polished diagram is a review aid, not proof of correctness.

## Scope and starting point

Use the user's current scope. For Cassandra, default to the backend Core API and controls; the staff UI is peripheral. Start from one policy control or one backend capability and a complete, bounded path. Expand breadth only as requested. A complete path within a control does not imply full control coverage.

C4 contributes meaningful abstraction and drill-down; GRC contributes intent, implementation and evidence distinctions. Neither dictates the navigation taxonomy. Do not introduce live alert metrics, change-history dashboards, control authoring, automatic findings, or compliance scores unless requested.

Read [the design reference](references/design-and-grounding.md) when modeling a new slice or changing its navigation. For Cassandra examples, read [the worked example](references/cassandra-example.md). Do not load the example as evidence about current repository behavior.

## Ground the representation

Inspect the current repository and record its revision, plus relevant local changes. Read the policy/specification separately from implementation. Trace entry points, called helpers, authorization, branches, state writes, events and meaningful failures. Follow dependencies far enough to establish the selected claim; do not infer enforcement from names, imports or comments.

Keep these distinct in the model and presentation:
- Intended policy or specification behavior.
- Behavior established by inspected implementation.
- Supporting tests or observations and their actual scope.
- Interpretations, assumptions, unknowns and review boundaries.

Pin source links to the inspected revision when possible. Identify local-only evidence honestly. Mark a manually traced snapshot as such. Do not call a copied prototype current, synchronized or automatically verified. On refresh, revisit sources for affected nodes and invalidate stale claims; changing the displayed commit hash is not a refresh.

Tests defined in source are not test runs. A passing test supports only its asserted behavior, and may share the implementation's mistaken assumptions. Represent partial coverage without turning it into a single green verdict.

## Make depth the primary interaction

A click into a diagram block must reveal its constituent structure. It must change the represented topology or granularity, rather than merely relabeling the same diagram or changing inspector prose.

A useful control entry path is:

**Policy → control → named process → decision/action → implementation mechanics.**

For backend architecture, use actual system/component boundaries as appropriate. Do not force every topic into the same number of levels. A process grouping is not necessarily a service, module or deployment boundary; label the distinction.

- Use domain-specific names such as “Alert triage & investigation” or “SAR decision & record.” Avoid generic “Recognize / Assess / Record” navigation.
- Draw siblings as connected elements within their enclosing boundary. Opening a sibling reveals its internals.
- Keep clickable ancestor breadcrumbs that return to the parent diagram. Preserve inputs, outputs and enclosing context where useful.
- Distinguish containment from sequence, calls, data flow and policy mappings. Label meaningful relationships.
- At a genuine leaf, show checks, writes, refusal conditions and source evidence. Indicate that the implementation boundary has been reached; do not create fake drill-down.

**Rejected pattern:** numbered 1/2/3 stage tabs as the main navigation. Moving sideways through a lifecycle does not provide C4-like depth. Sequence is still useful inside a diagram, but is not a substitute for decomposition.

## Share language across audiences

Use human vocabulary as in a readable no-code rule builder: who acts, what is checked, which outcome follows, and what is recorded. This is inspection, not an implied permission to edit or execute controls.

Keep one underlying flow for legal and engineering readers. An engineering-detail toggle may add identifiers, contracts and storage/event semantics; it must not change the facts or masquerade as an abstraction level. Raw code is supporting evidence, not the main visual.

An inspector can pair policy intent with implemented behavior and a source-grounded review boundary. Let the reviewer disagree with the interpretation. Avoid turning speculative review questions into asserted defects.

## Build and validate

For an inline conversational prototype, use the available visualization skill for rendering and host integration. For a repository application, follow its stack and local instructions. The semantic model should not depend on a specific diagram library. Prefer polished, interactive JavaScript diagrams to Mermaid-style static output for this workflow.

Reuse [the accepted depth prototype](assets/control-depth.html) only as a design starting point. It contains historical Cassandra data and is an inline fragment, not a production application. Replace its content and grounding when adapting it; do not blindly copy its examples or incidental layout limitations.

Validate the paths that matter: entry into a container, changed child structure, deeper implementation inspection, return through every ancestor, and consistent engineering annotations. Check saved-state compatibility if implemented. Check responsive layout and keyboard use; visually inspect when tooling permits, and state any limits to verification. Do not claim a DOM harness proves visual quality or backend correctness.

The acceptance test is human comprehension: can the reviewer explain the control, follow how its intent becomes behavior, and locate a boundary where correctness needs examination? Record substantive user feedback so later iterations preserve the accepted model rather than drifting back to stage tabs or generic architecture summaries.
