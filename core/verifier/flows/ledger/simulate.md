# Coverage ledger: `core/supabase/functions/api/simulate.test.ts` → sandbox simulate flows

Every `Deno.test` in the stubbed unit file, and where its behaviour is now proven against the deployed core. New steps live in `core/verifier/flows/reads.test.ts` (flow `reads: sandbox simulate …`); run with `scripts/flow.sh -f reads: --no-deploy`.

Disposition key: `flow` (an existing flow step covers it) · `added` (a step written in `reads.test.ts`) · `contract` (already in `core/verifier/contract/`) · `drop` (no user-observable surface).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | an unsimulated path still returns the typed 501, and says what IS simulated | flow | `cards.test.ts` → `cards: sandbox simulate …` → "an unsimulated rail returns the typed 501 naming what IS simulated"; also contract `payments_and_sandbox.test.ts` "D17: an unsimulated rail 501s with a typed index of what IS simulated" |
| 2 | simulate/ach/{id}/return drives the REAL return path — voids the hold | flow | `ach.test.ts` → `ach: sandbox simulations run the real writer …` → "simulated settle, then an R10 after settlement" and "an ordinary R01 return raises no unauthorized alert" (real columns + reversal evidence written through the simulator) |
| 3 | simulate rejects a bogus return code exactly as the real endpoint does | flow | same flow → "a bogus return code R99 is refused and not stored" |
| 4 | simulate/ach runs the compliance gate — a blocked entry is blocked here too | added | `reads: sandbox simulate …` → "a simulated ACH the member cannot fund is blocked exactly like a real one" (CG-NSF-01 reject persisted, row rejected, no hold). The flagging half is `ach.test.ts` → "a simulated $15,000 ACH still runs the gate: CG-LGTXN-01 + CTR alert" |
| 5 | wire return/resolve is not shadowed by the bare return route | added | `reads: sandbox simulate …` → "wire return/resolve reaches the RESOLVE writer, not the bare return route" |
| 6 | every rail's terminal step is reachable through simulate | added | same flow → "every rail's lifecycle step is simulated — none answers 501" (all 15 paths; also asserts none 5xx) |

**Counts:** flow 3 · added 3 · contract 0 · drop 0 (total 6).
