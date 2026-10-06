# Coverage ledger: aggregator/auth.test.ts → aggregator and origination flows

Source: `core/supabase/functions/aggregator/auth.test.ts` (18 tests). Flows: `core/verifier/flows/aggregator.test.ts` (run with `scripts/flow.sh -f aggregator: --no-deploy`) and `core/verifier/flows/origination.test.ts` (rows already mapped in `ledger/origination.md` point there).

Disposition key: `flow` = covered by a ported bash §40 check; `added` = a flow step written to close a gap the bash script left; `origination` = already proven by an origination flow (see `ledger/origination.md` for the row); `partial` = proven through a different surface than the stub names; `drop` = not observable live (reason given).

Flows: **P** = `aggregator: a partner key is refused at the aggregator by credential class, and a foreign instance's token is refused at the api`; **I** = `aggregator: an instance ingests its events — attributed from the token, deduped, PII refused, append-only`; **OA** = `origination: an instance exchanges its client secret for a 300s token; …`.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | a signed instance JWT round-trips | origination | `ledger/origination.md` row 8 (OA). Every step in I also rides a live-issued JWT. |
| 2 | alg:"none" is refused — the token cannot vouch for itself | origination | `ledger/origination.md` row 9 (OA → "forged and expired tokens are refused at the door") |
| 3 | a token signed with the wrong secret is refused | origination | `ledger/origination.md` row 10 |
| 4 | tampering with the payload invalidates the signature | origination | `ledger/origination.md` row 11 |
| 5 | an expired token is refused | origination | `ledger/origination.md` row 12 |
| 6 | a token with no expiry is refused, not treated as eternal | origination | `ledger/origination.md` row 13 |
| 7 | D19 caps instance tokens at one hour | origination | `ledger/origination.md` row 14 |
| 8 | an iat far in the future is refused | origination | `ledger/origination.md` row 15 |
| 9 | malformed tokens are refused without throwing | origination | `ledger/origination.md` row 16 (`a.b` → 401) |
| 10 | partner tokens are recognisable by prefix | partial | P → "a partner token as Bearer is a 403 that names itself, and nothing is ingested". The `cass_pt_` prefix is what earns the named 403. The "a JWT is not a partner token" half is implied by every live-issued JWT in I being accepted. |
| 11 | card 51: a partner key is REJECTED at the aggregator | flow | P → "a partner token as Bearer is a 403 that names itself, and nothing is ingested" (type, detail and request id checked, plus no `aggregator.event` row). Added: P → "the live demo partner key gets nothing at the aggregator either" |
| 12 | card 51: a partner key is refused even when the aggregator is misconfigured | drop | It needs `AGGREGATOR_JWT_SECRET` unset on the deployed function, which would take the live aggregator down for every instance. The class check runs before the secret check (`aggregator/handler.ts`, before `if (!deps.jwtSecret)`). |
| 13 | card 51: the X-Api-Key header does not work at the aggregator either | added | P → "the same partner token in X-Api-Key is refused the same way" |
| 14 | no credential at all is a 401 | added | P → "no credential at all is a 401" (also OA, row 16 of `ledger/origination.md`) |
| 15 | a valid instance JWT reaches ingest | added | I → "a batch lands: instance_id from the TOKEN (never the body), schema_version defaulted or kept" (a run-unique instance's `/auth/token` JWT; rows checked in `aggregator.event`) |
| 16 | instance_id comes from the TOKEN, never from the body | added | same step: the body says `instance_id: "inst_local"`, and the stored row carries the run-unique instance |
| 17 | ingest requires a non-empty events array | added | I → "malformed batches are refused 400 and store nothing" (`{}`, `events: []`, `events: "nope"`, non-JSON) |
| 18 | an event with no id is refused — dedup depends on it | added | same step |

Counts: 18 rows. 9 `origination`, 1 `flow`, 6 `added`, 1 `partial`, 1 `drop`.

Also added from bash §40 card 51 (the second half): P → "a valid api token bound to ANOTHER instance is a 401 at the api, indistinguishable from unknown".
