# Modeling and review reference

## Minimal semantic model

Choose an implementation format suited to the project. Keep stable identities independent of labels. A useful element record contains:

- ID, domain name, kind, enclosing element or grouping, and available children.
- Inputs and their origin; outputs, state changes and emitted events.
- Applicability, conditions, branch outcomes and material failure behavior.
- Relevant policy/specification clause and the scope of its implementation mapping.
- Source path, symbol/location, inspected revision, and whether the fact is extracted, manually traced, human-reviewed or inferred.
- Supporting test definition or run, including what it establishes and what it does not.
- Explicit unknowns, omitted scope and review boundaries.

Use separate relations for contains, calls, reads, writes, emits, partially implements and tests. A policy relationship can be many-to-many. A call edge does not establish that every applicable request reaches the callee. Shared dependencies should retain their identity across views rather than appear to be independent safeguards.

Do not require a large ontology before a single useful slice exists. A compact manually maintained model is sufficient for a prototype if its provenance and limitations are visible.

## Questions that affect faithful diagrams

Ask these of the source rather than asking the user to supply implementation details:

- Which paths enter this behavior, and what can return before it?
- Are limits strict or inclusive? What units, time windows and time zones apply?
- Who supplies inputs? Does the code verify the claimed fact or merely store it?
- Does actor separation compare people, accounts, credentials or tokens?
- Are writes transactional or sequential? What persists if a later action fails?
- Is an event guaranteed, attempted, swallowed on error, or retried?
- Do repeat requests replay a result, duplicate effects or overwrite decisions?
- Is a deadline calculated, enforced, observed by a sweep, or only documented?
- Does a named outcome correspond to an external action or just an internal record?

Only surface questions material to the selected path. Missing evidence in the inspected scope is not proof that implementation is absent elsewhere.

## Visual composition

Present one legible neighborhood at a time. Show an enclosing boundary, meaningful child blocks and labeled relationships. Keep an inspector supplementary: the diagram itself should expose the structure. Branch destinations and exit conditions must not be implied by an incorrect connector or a linear happy-path rendering.

Preserve domain labels across zoom levels. Keep a small amount of parent context so depth does not become a succession of unrelated screens. Ancestors are navigation; sibling process steps belong in the parent diagram. Distinguish opening an element from following a relationship to another element if both interactions are offered.

No fixed requirement for colors, three columns, number of levels or a particular JavaScript library. The accepted properties are real decomposition, explicit provenance, domain vocabulary and human legibility.

## Research principles retained

These are conceptual references, not claims of regulatory sufficiency:

- C4: progressively reveal useful structural detail; use notation that communicates to the audience. https://c4model.com/
- OSCAL: distinguish implementation descriptions from assessment observations and findings. https://pages.nist.gov/OSCAL/learn/concepts/layer/implementation/ and https://pages.nist.gov/OSCAL/learn/concepts/layer/assessment/assessment-results/
- Assurance cases: connect claims and evidence with reasoning; diagramming an argument does not validate it. https://www.omg.org/spec/SACM/2.1/

Do not repeat broad research on every invocation. Verify external sources when relying on their current details or adding new factual claims.
