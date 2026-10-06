# auth.test.ts → coverage ledger

Source: `core/supabase/functions/api/auth.test.ts` (25 tests). Contract: `core/verifier/contract/auth.test.ts` (black-box over HTTP; tokens with a specific actor, scope, expiry or partner are provisioned as run-unique `cass_test` rows with the service role and revoked in a `finally`) plus `core/verifier/contract/cross_cutting.test.ts` (D5-T1/T3). Flow: `core/verifier/flows/platform.test.ts`.

| test | disposition | where |
|---|---|---|
| endpoint matching: exact, global wildcard, prefix wildcard | contract | D5-A08 (exact grant covers only its endpoint), D5-A10 (`*` reads), D5-A09 (`GET /accounts/*` covers `/accounts/{id}` and `/accounts/{id}/numbers`) |
| a prefix wildcard stops at the segment boundary | contract | D5-A09: `POST /eps/pospay/*` reaches `/eps/pospay/{id}/decide` but is 403 on the sibling `/eps/pospay-items`; `GET /accounts/*` is 403 on bare `GET /accounts` |
| endpoint and tier are BOTH required — neither alone suffices | contract | D5-A10: right endpoint + wrong tier is 403; D5-A08: right tier + wrong endpoint is 403. Flow: `platform: a scoped token can do exactly what it was granted…` |
| a wildcard endpoint list still cannot escape the tier list | contract | D5-A10 (`*` + read reads, cannot POST). Flow: platform → "a read-tier token over every endpoint still cannot write" |
| a valid token authenticates and yields its partner context | contract | D5-A01 (minted partner token authenticates); the partner context is observed through its effects: D5-A17 (partner tokens share the partner's idempotency namespace). Flow: platform → "a partner is confined to its own rows" |
| a missing token is a 401 | contract | already there: D5-T3 (missing X-Api-Key); D5-A02 (empty Bearer) |
| the legacy X-Api-Key header is still read | contract | D5-A01 (same token via `Authorization: Bearer` and via `X-Api-Key`; demo key via Bearer) |
| an unknown token is a 401 | contract | already there: D5-T3; D5-A02 (unknown Bearer token) |
| a revoked token is a 401 — status is filtered in the query | contract | D5-A03 (200 before revoke, 401 after). Flow: platform → "once revoked, the token authenticates as nothing: 401" |
| an expired token is a 401 | contract | D5-A04 (past `expires_at` → 401; future `expires_at` → 200) |
| a database error during auth fails CLOSED, as 503 not 401 | drop | needs the database made unreachable under the deployed function: an infra fault for the chaos tier (PRINCIPLES P3/P14), not producible over HTTP on the shared core |
| a database error is 503 for an UNKNOWN token too — no probe surface | drop | same: chaos-tier fault injection, no HTTP way to induce it |
| an out-of-scope endpoint is 403, not 401 — the token IS valid | contract | D5-A08 (403 `insufficient_scope`, detail "not scoped for"). Flow: platform → "outside its endpoint list: a transfer is refused as insufficient_scope" |
| a read-only token cannot reach a write endpoint | contract | D5-A10. Flow: platform → "a read-tier token over every endpoint still cannot write" |
| a partner cannot reach an ops-only endpoint even with '*' scope | contract | D5-A11: partner with `*` on every tier → 403 on ops-only `POST /sandbox/event-sink`, detail names `pynthia_ops` (and on CU-only `GET /governance/obligations`, detail names `cu_admin`) |
| an ops token reaches the ops-only endpoint | contract | D5-A12 (minted `pynthia_ops` → 200). Its partner-less, per-token idempotency namespace: D5-A16 (two ops tokens, same key, two resources) |
| card 51: a token for ANOTHER instance is rejected here | contract | D5-A05 (token bound to the drill instance's partner → 401) |
| card 51: a foreign token is INDISTINGUISHABLE from an unknown one | contract | D5-A05 (401 bodies byte-identical apart from `request_id`, same content-type) |
| card 51: a token whose PARTNER belongs elsewhere is rejected | contract | D5-A06 (token bound here naming the drill instance's partner → 401) |
| a suspended partner's tokens stop working without being revoked | contract | D5-A07 (run-unique suspended partner on this instance, its active token → 401; partner left `offboarded`) |
| the demo key works when enabled and is refused when disabled | contract | D5-A13 (enabled half: the demo key is an operations actor that reaches the ops-only route); also D5-T1. The disabled half needs a redeploy with `ALLOW_DEMO_KEY=false`, which a contract run may not do: not covered |
| the demo key runs the SAME scope checks, not a bypass | drop | not observable on the deployed core: every actor-restricted route's `x-actors` includes `pynthia_ops` (the demo key's class) and its scope is `*`/all tiers, so no route can refuse it on scope |
| a minted token never stores its own plaintext | drop | `mintToken` has no HTTP surface (only `scripts/issue-token.ts` calls it) and the property is about the stored row: storage internals, PRINCIPLES P2 |
| two mints never collide | drop | same: library-level issuance with no HTTP surface |
| two partners get distinct idempotency namespaces | contract | D5-A16: two callers (two ops tokens) using one key get two resources, neither replays the other's, and the first still replays its own afterwards. One instance hosts one partner (D18), so two partners can't both authenticate here; flow platform → "idempotency keys are per caller" covers partner vs ops |

Added beyond the stub (auth.ts `TEST_TOKEN_PREFIX` provenance labelling, not in the stub file): D5-A14 (cash deposit under a `cass_test` cu_admin token and under the demo key echoes `provenance: demo`), D5-A15 (KYC verification read-back: **DEFECT**, lands `unknown`), and D5-T2 run with a minted partner token (the ignored copy in cross_cutting.test.ts lacked a partner credential).

Counts: contract 20 · flow 0 · drop 5
