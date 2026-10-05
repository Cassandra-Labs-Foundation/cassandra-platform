# Coverage ledger: `core/supabase/functions/api/controls.test.ts` → GET /control-results

Every `Deno.test` in the stubbed unit file, and where its behaviour is now proven against the deployed core. New steps live in `core/verifier/flows/reads.test.ts` (flow `reads: control-results …`); run with `scripts/flow.sh -f reads: --no-deploy`.

Disposition key: `flow` (an existing flow step covers it) · `added` (a step written in `reads.test.ts`) · `contract` (already in `core/verifier/contract/`) · `drop` (no user-observable surface).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | returns rows wrapped in data with a 200 | flow | `transfers.test.ts` → `transfers: book transfer …` → "GET /control-results agrees with the database and the inline results (§25)" |
| 2 | newest results come first, capped at the default limit | added | `reads: control-results …` → "the default page is newest-first and capped at 50" |
| 3 | every documented filter narrows the query | flow | `transfers.test.ts` → "GET /control-results agrees with the database and the inline results (§25)" (`event`; `control_id` + `decision` + `subject_ref` counted against the DB) and `transfers: structuring …` → "GET /control-results by event shows the same evidence as inline + DB (§25)" |
| 4 | an unknown decision value is refused, not silently empty | flow | `transfers.test.ts` → "GET /control-results agrees with the database and the inline results (§25)" (`decision=maybe` → 400) |
| 5 | limit is honored within bounds and refused outside them | added | `reads: control-results …` → "limit is honoured within bounds and refused outside them" |
| 6 | no matches is an empty data array, not an error | added | same flow → "a control that never fired is an empty data array, not an error" |

**Counts:** flow 3 · added 3 · contract 0 · drop 0 (total 6).
