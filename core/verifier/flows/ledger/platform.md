# platform.test.ts → coverage ledger

Source: `core/supabase/functions/api/platform.test.ts` (12 tests). Flow: `core/verifier/flows/platform.test.ts`; contract: `core/verifier/contract/cross_cutting.test.ts`.

| test | disposition | where |
|---|---|---|
| errors carry the canonical envelope: status, type, title, request id, doc url | contract | already there: D12-T1 |
| apiError stamps the same envelope for arbitrary error types | contract | already there: D12-T1/D12-T2 (one unknown-route, one validation error) |
| success responses carry X-API-Version | contract | already there: D13-T1 |
| error responses carry X-API-Version too | contract | already there: D13-T1; the flow also checks a 404's header equals the changelog head in `platform: a partner pins the API version and pages to its own evidence by cursor` → "the changelog leads with the version every response is stamped with" |
| GET /changelog responds newest-first and leads with the current version | added | `platform: a partner pins the API version and pages to its own evidence by cursor` → "the changelog leads with the version every response is stamped with" (contract D13-T2 checks entry structure only) |
| a full page signals has_more and hands back a cursor | flow | `platform: a partner pins the API version and pages to its own evidence by cursor` → "a limit=1 cursor walk reaches that evidence: no overlap, strictly older each hop" |
| a short page says has_more false with no cursor | contract | already there: D16-T4 |
| after= filters strictly older than the cursor | flow | `platform: a partner pins the API version and pages to its own evidence by cursor` → "a limit=1 cursor walk reaches that evidence…" |
| a malformed after cursor is refused | added | `platform: a partner pins the API version and pages to its own evidence by cursor` → "a malformed cursor is refused by field, not ignored" |
| the 5300 report reconciles the FBO position against THIS instance's member shares | added | `platform: a partner pins the API version and pages to its own evidence by cursor` → "the 5300 heartbeat ties the FBO position to member shares and reports the ingest high-water" |
| last_seq comes from the event sequence, not from the position view | added | `platform: a partner pins the API version and pages to its own evidence by cursor` → same step (last_seq bracketed by aggregator.event max sequence_id) |
| member shares are reported even with no FBO position row | drop | precondition (no fbo_position row) cannot be produced on the shared live core without deleting the position; formula is asserted in the step above |

Counts: flow 2 · added 4 · contract 5 (all already present) · drop 1
