# ownership.test.ts → coverage ledger

Source: `core/supabase/functions/api/ownership.test.ts` (15 tests). Flows: `core/verifier/flows/platform.test.ts`, `core/verifier/flows/onboarding.test.ts`.

| test | disposition | where |
|---|---|---|
| only partner actors are confined; D23 roles see across fintechs | drop | internal predicate (`isConfined`); its observable effect is asserted in `platform: a scoped token can do exactly what it was granted, and nothing once revoked` → "a partner is confined to its own rows: another partner's account is a 404" |
| scopeToPartner adds the predicate for a partner and not for ops | drop | query-builder detail; observable effect covered by the same `platform: a scoped token can do exactly what it was granted, and nothing once revoked` step |
| ownsRow rejects another partner's row and tolerates ops | drop | helper detail; observable effect covered by the same `platform: a scoped token can do exactly what it was granted, and nothing once revoked` step |
| withOwner stamps ownerPartnerId, not partnerId | added | `onboarding: a partner onboards a member and a business with its beneficial owner` → "create a person: 201, starts PENDING, owned by the partner…" (entity.partner_id = the creating partner) |
| the owner stamp is never null for any actor type | drop | enforced by the NOT NULL column; every ops-created fixture in the flows (e.g. `platform: a scoped token can do exactly what it was granted, and nothing once revoked` idempotency step) would 500 if it regressed |
| a partner cannot read another partner's account | added | `platform: a scoped token can do exactly what it was granted, and nothing once revoked` → "a partner is confined to its own rows: another partner's account is a 404" |
| a partner reads its own account normally | added | `platform: a scoped token can do exactly what it was granted, and nothing once revoked` → same step |
| an ops actor reads any partner's account | added | `platform: a scoped token can do exactly what it was granted, and nothing once revoked` → same step |
| a partner cannot settle another partner's ACH entry | drop (here) | user-observable and important, but ACH is owned by the ACH flow file (parallel agent); NOT covered in onboarding/platform — flag for the ACH ledger |
| a partner settles its own ACH entry | drop (here) | as above — belongs to the ACH flows |
| the instance-scoped table list covers the compliance record | drop | a constant list; no request shape exposes it |
| idempotency is namespaced by CALLER, ownership by OWNER — not the same key | added | `platform: a scoped token can do exactly what it was granted, and nothing once revoked` → "idempotency keys are per caller: ops reusing the partner's key is not a replay" |
| evidence written under the bootstrap credential is stamped demo | added | `onboarding: KYC through the adapter — sims, attestations, providers, and the OFAC floor` → "the OFAC evidence a test token writes is labelled demo, not production" (DEFECT, red) + "each OFAC hit raised a BSA alert … labelled demo" |
| the same request under a real token is stamped production | drop | needs a non-`cass_test` token; minting one would write unlabelled production evidence to the shared core, which the flow suite forbids |
| sim scope outranks the credential — simulated is simulated | drop | pure function (`provenanceFor`); sim-scope rows belong to the sandbox/simulate flows |

Counts: flow 0 · added 7 · contract 0 · drop 8 (2 of them deferred to the ACH flows, not truly dropped)
