# Coverage ledger: `core/supabase/functions/api/happy_paths.test.ts` → submission flows

Every `Deno.test` in the stubbed unit file, and where its behaviour is now proven against the deployed core. New steps live in `core/verifier/flows/reads.test.ts` (flow `reads: submission edges …`); run with `scripts/flow.sh -f reads: --no-deploy`.

Disposition key: `flow` (an existing flow step covers it) · `added` (a step written in `reads.test.ts`) · `contract` (already in `core/verifier/contract/`) · `drop` (no user-observable surface, or needs fault injection).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | wire prepare holds funds and lands submitted | flow | `wires.test.ts` → `wires: $11k wire …` → "prepare an $11,000 wire: HELD (submitted), CG-LGTXN-01 on the response" + "the row records its originator and that dual control is REQUIRED" |
| 2 | wire prepare runs the gate BEFORE placing the hold | flow | `wires.test.ts` → `wires: a wire the member cannot fund …` → "evidence: CG-NSF-01 reject persisted; the row is rejected with no ledger hold" |
| 3 | wire prepare replays a completed claim without touching Blnk | added | `reads: submission edges …` → "a retried wire prepare replays the same wire — one row, one hold" |
| 4 | wire prepare 409s when the same key arrives with a different body | added | same flow → "the same key with a different body is 409 idempotency_key_reused — no second wire" (contract D6-T2 checks the mechanism on `/accounts` only) |
| 5 | wire prepare resumes an interrupted claim on the ORIGINAL id | drop | Needs a request killed between the idempotency claim and the response; the live API cannot be interrupted mid-handler |
| 6 | wire prepare 404s an unknown source account before any Blnk call | added | same flow → "a wire from an account that does not exist is a 404 and writes nothing" |
| 7 | wire prepare 409s an account with no Blnk balance provisioned | drop | Every account opened through the API is provisioned in Blnk at creation; an unprovisioned account cannot be produced without editing the row |
| 8 | ach submit holds funds toward the ACH network and lands submitted | flow | `ach.test.ts` → `ach: $11k debit …` → "submit a $11,000 ACH: held as submitted, CG-LGTXN-01 on the response" |
| 9 | ach submit defaults the settlement window when none is given | added | `reads: submission edges …` → "an ACH with no window settles next_day by default" |
| 10 | ach submit runs the gate BEFORE placing the hold | flow | `ach.test.ts` → `ach: malformed submissions refused; NSF blocks …` → "the refusal is evidenced: rejected row with no hold, CG-NSF-01 reject" |
| 11 | card authorize places a hold with nothing captured yet | flow | `cards.test.ts` → `cards: authorize → partial capture …` → "authorize $1,000 at Acme Coffee: a hold, nothing captured" |
| 12 | a gate-blocked authorization is recorded as declined with a reason | flow | `cards.test.ts` → `cards: NSF declines before any hold …` → "the decline is recorded: row declined, no hold placed, CG-NSF-01 reject" |
| 13 | card authorize requires a merchant | added | `reads: submission edges …` → "a card authorization without a merchant is refused by field and leaves no row" |

**Counts:** flow 6 · added 5 · contract 0 · drop 2 (total 13).
