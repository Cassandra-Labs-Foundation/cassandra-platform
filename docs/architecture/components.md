# Core API components

The old component diagram has been replaced by the [interactive Core API view](https://cassandra-labs-foundation.github.io/cassandra-platform/architecture/#/api).

The view groups every API module by domain. Open a domain, then a module, to see its operations, emitted events, related controls and imports, then open an operation for its route, access and handler. The manually traced slices below the domains cover request routing & access, the payment gate's call sites, and BSA alert and case management down to each decision's checks and writes.

`runGate` lives in `core/supabase/functions/api/transfers.ts`, not `lib.ts`. Its checks are explicit implementation logic. Shared call sites do not establish that every operation or every path invokes it.

See [the architecture guide](README.md) for the reviewed scope and refresh process.
