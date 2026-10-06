# Ledger — core/supabase/functions/api/sandbox.test.ts

`POST /sandbox/reset` wipes the instance's mutable state. Every flow and the
contract suite share ONE live demo instance, so nothing may ever call reset
with the confirm phrase. Only the refusal is exercised live.

| # | test | disposition | where |
|---|---|---|---|
| 1 | reset without the confirm token is refused and touches nothing | contract | `core/verifier/contract/payments_and_sandbox.test.ts` → "D17-T1 (guard half): /sandbox/reset without the confirm phrase is refused" |
| 2 | reset voids outstanding holds BEFORE truncating | drop | needs a real reset, which would wipe the shared demo instance. **Unproven live**: that holds are voided before truncation. Proving it needs a dedicated, disposable instance. |
| 3 | a failing void is reported but does not block the reset | drop | same, plus a Blnk void failure that can't be injected live. **Unproven live.** |
