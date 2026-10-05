# Coverage ledger: aggregator origination stubs → origination flows

This ledger lists the stubbed `Deno.test`s that concern origination: the `/auth/token` exchange and the instance JWT it issues (card 64), FBO reads (card 65), and the reserve saga (cards 66–67). Each row says where that behaviour is now proven against the deployed core. Flows live in `core/verifier/flows/origination.test.ts`. Run them with `scripts/flow.sh -f origination: --no-deploy`.

These routes are served by the `aggregator` edge function, not `api`. They have no `x-handler` in `core/core-api.yaml`: `/auth/token` and `/fbo/{instance_id}/…` appear only under `x-proposed-paths`, in a shape that differs from what is live (`grant_type`/`client_id` there, `instance_id`/`client_secret` live). No `api/*.test.ts` stub covers these handlers. Keyword hits in `api/` (`originator` in wires/EPS) concern something else.

Out of scope and not listed: the card 51 partner-key rows and the ingest rows in `aggregator/auth.test.ts`, the ingest, PII, health, admin overview and search rows in `aggregator/handler.test.ts`, and the consumers/run row.

Disposition key:

- `flow`: covered by a ported bash §42 check.
- `added`: a flow step written to close a gap the bash script left.
- `partial`: the behaviour is proven, but not through the exact surface the stub names (the reason is given in the row).
- `drop`: an implementation detail with no user-observable surface.

Flows: **A** = `origination: an instance exchanges its client secret for a 300s token; …`, **B** = `origination: the live program's FBO read …`, **C** = `origination: reserve, accept and reject on a dedicated program; …`.

| # | Stub file | Unit test | Disposition | Where |
|---|---|---|---|---|
| 1 | `aggregator/handler.test.ts` | /auth/token exchanges a valid client secret for a 300s JWT | flow | A → "a valid client secret buys a Bearer token that expires in 300s" (also checks the signed claims: instance, `exp - iat = 300`, role), B → first step on the live `inst_local` credential |
| 2 | `aggregator/handler.test.ts` | /auth/token: wrong secret and unknown instance are the SAME 401 | flow | A → "a wrong secret and an unknown instance are the SAME 401; a missing field is a 400" (the 400 half is added); A → "once the credential is removed, its secret buys nothing" (added: a removed credential gets the same 401) |
| 3 | `aggregator/handler.test.ts` | cu_admin writes are refused wholesale — read-only by credential class (card 52) | added | A → "the cu_admin credential mints a read-only token: it cannot originate" (only the `/originations` leg; ingest and consumers legs belong to other areas) |
| 4 | `aggregator/handler.test.ts` | GET /fbo reads the TOKEN's instance — no path parameter to read another's | flow + added | A → "the token reads its own instance's FBO"; B → "FBO read carries …; available = position - reserved" (flow), "there is no way to name another instance" (added: query param ignored, `/fbo/{id}` 404) |
| 5 | `aggregator/handler.test.ts` | a clean origination returns 201 pending (card 66) | flow | C → "a clean origination reserves and returns pending — origination and hold land together" (checks the `origination` and `reserve` rows), "the reserve is held, not spent" |
| 6 | `aggregator/handler.test.ts` | a stale payment hub is a 503 WITH Retry-After (card 66) | partial | C → "the staleness gate refuses to reserve against an unmaintained mirror". The gate now watches blnk-reconcile, not payment_hub (retired). Reaching the HTTP 503 would mean ageing the shared `core.blnk_sync_state` row, so the step drives the SQL gate (`aggregator.originate`) with a tight window. It asserts `consumer_stale`, `retry_after_secs` and that no row is written. The HTTP 503 → `Retry-After` header mapping is not exercised live. |
| 7 | `aggregator/handler.test.ts` | saga exits route to accept/reject; resolved twice is a 409 (card 67) | flow + added | C → "accept captures the hold; …", "a resolved origination cannot be resolved again, either way" (flow), "reject nets to zero …" (flow), "exactly the available amount can be reserved …" (added), unknown origination 404 (added), and "another instance cannot resolve this program's origination" (added, **red: DEFECT**, see below) |
| 8 | `aggregator/auth.test.ts` | a signed instance JWT round-trips | flow | A → issued token is accepted at `/fbo` and carries the instance in its claims |
| 9 | `aggregator/auth.test.ts` | alg:"none" is refused — the token cannot vouch for itself | added | A → "forged and expired tokens are refused at the door" |
| 10 | `aggregator/auth.test.ts` | a token signed with the wrong secret is refused | added | same step |
| 11 | `aggregator/auth.test.ts` | tampering with the payload invalidates the signature | added | same step (the real issued token with `instance_id` swapped to `inst_local`) |
| 12 | `aggregator/auth.test.ts` | an expired token is refused | added | same step (validly signed, exp an hour ago). The issued token's own 300s expiry is asserted from its claims; the flow does not wait it out. |
| 13 | `aggregator/auth.test.ts` | a token with no expiry is refused, not treated as eternal | added | same step |
| 14 | `aggregator/auth.test.ts` | D19 caps instance tokens at one hour | added | same step (24h lifetime) |
| 15 | `aggregator/auth.test.ts` | an iat far in the future is refused | added | same step |
| 16 | `aggregator/auth.test.ts` | malformed tokens are refused without throwing | added | same step (`a.b`), plus no credential at all → 401 |

Counts: 16 rows. 6 `flow` (rows 4 and 7 are `flow + added`), 9 `added`, 1 `partial`, 0 `drop`.

## Defect found (fixed 2026-10-03)

- **Any instance can resolve another program's origination.** C → "another instance cannot resolve this program's origination" expects 404 and gets 200: an `inst_local` JWT accepts a pending origination that belongs to a different instance. `aggregator/handler.ts:296-299` passes only the path id (`rpc(fn, { p_id })`). `accept_origination` (`migrations/20260817000100_fbo_position_rollup.sql:150-158`) and `reject_origination` (`migrations/20260720000600_origination_auth.sql:157-163`) select by `o.id = p_id` and never compare the origination's `instance_id` against the caller's. This is the cross-fintech contamination D23 forbids. **Fixed** by migration `20261003000100_origination_instance_scope.sql` (both functions now take `p_instance` and match on it; the one-argument versions are dropped) and the handler passing the verified claims' `instance_id`. The step is green 3/3 live and stays as a regression guard.

## Corrections against bash §42

- Accept no longer moves the position. Since migration 20260817000100 the position is a roll-up of member balances, so `position_before == position_after`, and the captured reserve keeps `available` down instead.
- `seed_position` uses `account_type 'share'`, which fails the account-type vocabulary. On the live core, `inst_saga_test` reads position 0. The flow builds its own run-unique program (instance, credential, partner, member, checking account). Teardown rejects anything pending, closes the account, offboards the partner and deletes the credential.
- Instance JWTs are stateless. One that has already been issued stays valid until its `exp` (≤300s) even after its credential is deleted. That is by design (card 64); the flow asserts only that the secret stops buying new tokens.
