# Core API components

The old component diagram has been replaced by the [interactive Core API view](https://cassandra-labs-foundation.github.io/cassandra-platform/architecture/#/api).

Open Request routing & access to inspect dispatch, or Payment execution & controls to see the shared gate's selected call sites. Follow the BSA policy mapping into alert and case management, then open a decision to inspect its checks and writes.

`runGate` lives in `core/supabase/functions/api/transfers.ts`, not `lib.ts`. Its checks are explicit implementation logic. Shared call sites do not establish that every operation or every path invokes it.

See [the architecture guide](README.md) for the reviewed scope and refresh process.
