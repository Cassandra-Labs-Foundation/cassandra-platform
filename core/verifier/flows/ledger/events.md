# events.test.ts → coverage ledger

Source: `core/supabase/functions/api/events.test.ts` (11 tests). Flow: `core/verifier/flows/platform.test.ts`.

| test | disposition | where |
|---|---|---|
| due events are delivered to the target and marked delivered | flow | `platform: an event lands in the outbox and the worker delivers it to the aggregator` → "creating a member writes entity.created into the outbox" + "operations sweeps until the event is delivered" (DEFECT, red) |
| a down target reschedules the event instead of losing it | drop | the live target cannot be taken down on demand; hermetic only |
| backoff grows with the attempt count | drop | same — requires repeated induced failures |
| a thrown fetch (network down) is a retry, not a crash | drop | same — requires an induced network failure |
| an empty outbox sweep is a clean no-op | drop | the shared live outbox is never empty; nothing user-observable to drive |
| aggregator mode: one batched POST with a Bearer instance JWT, all marked delivered | flow | `platform: an event lands in the outbox and the worker delivers it to the aggregator` → "the aggregator holds the event — identity only as a hash, no plaintext name" (DEFECT, red) |
| aggregator refusal reschedules the WHOLE batch with backoff — nothing is lost | drop | cannot induce an aggregator refusal on demand (incidentally observed live: the current 401 outage left 300+ events rescheduled, none lost) |
| PII keys are redacted at the boundary — one legacy payload cannot starve the batch | flow | `platform: an event lands in the outbox and the worker delivers it to the aggregator` → "the aggregator holds the event — identity only as a hash, no plaintext name" (entity.created carries `name`; asserted absent at the aggregator) |
| a full 500-row sweep marks delivery in URL-safe chunks, never one giant in-list | drop | implementation detail (URL length of the mark query) |
| a failed delivery MARK is failed-with-backoff, never reported delivered | drop | cannot induce a mark failure live |
| without aggregator config the sink path is untouched | drop | deployment configuration; the live core runs in aggregator mode |

Also added (not in the stub file): `platform: an event lands in the outbox and the worker delivers it to the aggregator` → "a partner cannot drive the worker: the sweep is operations-only".

Counts: flow 3 · added 0 · contract 0 · drop 8
