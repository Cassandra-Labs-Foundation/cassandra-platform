# docs/

| file | what it is |
|---|---|
| [architecture/](architecture/README.md) | interactive backend and control architecture: open components, processes and decisions to inspect their implementation — hosted at <https://cassandra-labs-foundation.github.io/cassandra-platform/architecture/> with a reviewed source model |
| [demo-runbook.md](demo-runbook.md) | how to run the live demo, and what to say in the room |
| [drill.md](drill.md) | the synthetic-institution drill record — and why a drill is not coverage |
| [proposed-surface.md](proposed-surface.md) | generated inventory of `x-proposed-paths` — the designed-but-unimplemented API, grouped by resource with the verifier's demand signals |
| [history/](history/) | dated snapshots of the July 2026 working record, kept for the narrative and the method, **not the numbers** |

Current state never lives here: [STATE.md](../STATE.md) is the generated page
of live numbers, and the full artifacts sit beside it at the repo root
(`control-tests.json`, `control-tests-live.json`, `crosswalk.json` /
`CROSSWALK.md`), all regenerated on every rebuild. Hand-written docs are held
to the artifacts by `scripts/check_doc_claims.py`, which runs in the same
rebuild. The system's description is the root [README.md](../README.md); the
working rules are `CLAUDE.md`.
