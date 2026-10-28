# Control and derivation walkthroughs

The old static walkthroughs have been replaced by inspectable diagrams. Every policy and control is browsable from [Policies & controls](https://cassandra-labs-foundation.github.io/cassandra-platform/architecture/#/policy); two paths are traced by hand:

- [BSA-06: transaction monitoring and case management](https://cassandra-labs-foundation.github.io/cassandra-platform/architecture/#/control/bsa%3ABSA-06). Its three traced processes are drawn inside the control. Open a named process, then a decision or action, to reveal implementation mechanics.
- [Specification and evidence derivation](https://cassandra-labs-foundation.github.io/cassandra-platform/architecture/#/pipeline). Distinguish declared intent, generated contracts and behavioral evidence.

The control path begins with a movement that reaches the payment gate. Earlier validation, safe-mode refusal and replay paths are not fully modeled. An opened alert does not itself block payment; subsequent payment checks still apply. A recorded filing decision is not proof of external submission.

See [the architecture guide](README.md) for scope and provenance. API implementation changes still follow the specification-first workflow in `CLAUDE.md`.
