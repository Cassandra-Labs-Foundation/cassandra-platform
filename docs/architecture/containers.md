# Backend context

The old container diagram has been replaced by the [interactive backend architecture view](https://cassandra-labs-foundation.github.io/cassandra-platform/architecture/#/overview).

The overview lists every deployable: the Core API and the other Supabase edge functions (aggregator, Blnk webhook, Blnk reconciler, control drill), Postgres with its declared state machines, the Blnk ledger, and the staff console with the Core API operations it may read. Open the Core API to reach every module and operation. Domains, policy groupings and processes are documentation boundaries, not additional deployable services.

See [the architecture guide](README.md) for scope, source provenance and maintenance.
