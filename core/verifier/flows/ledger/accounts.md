# Coverage ledger: `core/supabase/functions/api/accounts.test.ts` → account flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/accounts.test.ts`. Run them with `scripts/flow.sh -f accounts: --no-deploy`.

Disposition key:

- `flow`: covered by a ported bash section or an earlier flow.
- `added`: a flow step written to close a gap. The bash script never exercised account opening or the lifecycle on its own.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`. Not written here.
- `drop`: an implementation detail with no user-observable surface.

All steps below are in **lifecycle** = `accounts: lifecycle — refuse bad opens, open once, find, lock, freeze, close`.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | opening deposit must be a positive integer | added | "bad opens are refused naming every field at once, and write nothing" (0, −100, 12.5) |
| 2 | a funded open REQUIRES an Idempotency-Key | added | same step |
| 3 | a non-numeric opening deposit is rejected rather than coerced | added | same step (`"10000"`) |
| 4 | validation reports the deposit and the missing key together | added | same step (all four fields in one 400) |
| 5 | an unfunded open does NOT require an Idempotency-Key | added | "an unfunded open needs no Idempotency-Key" |
| 6 | GET returns the account with its mirrored balance | flow | `onboard_transfer_large_txn.test.ts` "open and fund"; also "a funded open lands ONCE …" |
| 7 | GET on an unknown account is a 404 | added | "bad list parameters are refused in ONE 400; the limit is bounded" |
| 8 | an account can be opened owned by an entity | added | "an unfunded open needs no Idempotency-Key" (`entity_id` read back from the row) |
| 9 | an account opened without an entity is refused (OQ-12) | added | "bad opens are refused …" |
| 10 | an unknown entity_id is a 400 naming the field, not an FK 500 | added | same step |
| 11 | an account_type outside the vocabulary is a 400 naming the field | added | same step (`brokerage`) |
| 12 | credit-union spellings are accepted and stored canonical | added | "every product, and the credit-union spellings, open and are stored canonical" (the row is read back) |
| 13 | account_type is required | added | "bad opens are refused …" (`missing_field`) |
| 14 | the 400 names both vocabularies | added | same step |
| 15 | every vocabulary member is accepted | added | "every product, and the credit-union spellings …" |
| 16 | a non-string entity_id is refused rather than coerced | added | "bad opens are refused …" (7, "", {}, []) |
| 17 | the account list is confined to one partner, before any filter | drop | Not observable here: the demo instance hosts one fintech (D18), so there is no second partner on `inst_local` to be confined from. |
| 18 | entity_id is the member -> accounts walk, and stays inside the partner | added | "the partner walks member → accounts, page by page …". The walk is proven; the cross-partner half is not observable, as in row 17. |
| 19 | an ops actor lists accounts across partners — D23 | added | "operations (D23) finds the partner's member accounts too" |
| 20 | an unknown account status is refused | added | "bad list parameters are refused in ONE 400 …" |
| 21 | a bad cursor and a bad filter come back in ONE 400 | added | same step |
| 22 | the page over-fetches by one, and that row becomes the cursor | added | "the partner walks member → accounts …" (full page, cursor = last served row, no duplicates, nothing missed) |
| 23 | a short page reports no more, and no cursor to follow | added | same step (last page) |
| 24 | the limit is bounded | added | "bad list parameters …" (201, −1, 1.5, all refused; 200 allowed) |
| 25 | the list envelope is the one core-api.yaml specifies | added | "the partner walks member → accounts …" (`data` + `pagination{has_more,limit,next_after}`) |
| 26 | NULLS FIRST under DESC — dateless rows LEAD the page | drop | Checks that a test double reproduces Postgres null ordering. Rows written through the API always carry `created_at`. |
| 27 | a page cannot advertise more with a cursor the caller cannot use | drop | Only reachable with dateless legacy rows, and no API call can create one. The guard is a throw inside the handler. |
| 28 | the normal case still advertises a cursor the caller CAN use | added | "the partner walks member → accounts …" (the cursor is followed to the end) |

Counts: flow 1, added 24, contract 0, drop 3.

## Lifecycle behaviour with no stub

These behaviours had no unit test and are now `added` in **lifecycle**:

| Behaviour | Step |
|---|---|
| funded open is idempotent: a retry returns the same account, deposits once, and a changed body is a 409 | "a funded open lands ONCE even when the partner retries it" |
| lock: an unknown `lock_type` is a 400; a fraud lock lands on the row, leaves `status` alone, and emits `account.locked` with `previous_lock` / `status_untouched` / `reason` | "a fraud lock stops money in BOTH directions without touching status" |
| a locked account refuses both a debit and a credit (`account_locked`) | same step |
| unlock (`none`) clears the row, emits `account.unlocked`, and transfers work again | "unlocking restores the rail" |
| freeze emits `account.frozen` {from, to}; `?status=frozen` finds it; a frozen account cannot pay (`account_not_open`); unfreeze emits `account.opened` | "freeze: the account is findable as frozen and refuses money; unfreeze reopens it" |
| close: an unknown `to` is a 400; close emits `account.closed` and starts BSA-21 retention clocks (`core.record`); closed → open/frozen is a 409 `invalid_state`; no money can go into a closed account; `?status=closed` finds it | "close: closed is forever, refuses money, and starts the retention clock" |
