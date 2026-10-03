# Backend and control architecture

[Open the interactive architecture explorer](https://cassandra-labs-foundation.github.io/cassandra-platform/architecture/#/overview).

This replaces the previous Markdown/Mermaid C4 tour. The interface focuses on the backend Core API and the controls system. Open a diagram block to reveal its contents; use ancestor breadcrumbs to return to the enclosing view.

Start with the Core API to inspect selected components, or with Policies & controls to follow BSA-06 from policy intent through large-movement detection, alert triage, investigation and a recorded SAR decision. Engineering detail adds contracts and identifiers to the same domain vocabulary.

## What the documentation establishes

The model is a manually traced source snapshot. Its footer identifies the inspected revision. Policy intent, implementation behavior, supporting source/test definitions and review boundaries remain separate. A test link is not a passing test run; an event name is not proof of an external action.

The detailed slice covers one path within BSA-06, not every obligation or every backend domain. Other detectors, external filing, Board reporting, timer sweeps and full retention enforcement are outside this slice. The staff console is not the subject of this explorer.

The payment gate is implemented in `core/supabase/functions/api/transfers.ts`. It contains explicit checks. The extracted control catalogue and crosswalk are documentation and evidence inputs; they should not be described as a runtime rules interpreter. CDA has its own funding gate. Coverage must be established from actual call sites and early returns rather than an “all rails” label.

## Maintain the model

- `model.json` contains the control model, implementation mechanics and reviewed source fingerprints.
- `explorer.mjs` renders the diagrams and the focused backend component views.
- `navigation.mjs` defines stable routes, ancestor state and legacy-route aliases.
- `explorer.css` defines the responsive interface.
- `index.html` is the published entry point. It loads only local assets.

Use the repository skill at `.skills/visual-control-architecture/SKILL.md` to revise the source-grounded model. Re-read affected policy, handlers, helpers and tests before changing claims. Update the inspected revision and fingerprints only after reviewing the sources, not as an automatic way to clear a check. Include new source dependencies in the manifest. Fingerprints detect changed inputs; they do not validate the interpretation or discover newly relevant code.

Validate with:

```sh
python3 scripts/check_architecture.py
node --test docs/architecture/navigation.test.mjs
python3 scripts/check_doc_claims.py
```

Serve the repository with a local HTTP server to inspect the explorer at `docs/architecture/index.html`. Direct filesystem opening is unsupported because the page loads its model with an HTTP request. The Pages workflow copies the viewer, model and supporting assets under the existing architecture URL. Old overview, containers, components and walkthroughs hashes remain usable.

Current repository-wide counts remain in [STATE.md](../../STATE.md). The explorer is a human review surface, not operational monitoring or an automated compliance verdict.
