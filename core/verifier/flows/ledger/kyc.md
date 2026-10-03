# kyc.test.ts → coverage ledger

Source: `core/supabase/functions/api/kyc.test.ts` (10 tests). Flow: `core/verifier/flows/onboarding.test.ts`.

| test | disposition | where |
|---|---|---|
| a KYC run returns a result through the adapter | flow | `onboarding: KYC through the adapter — sims, attestations, providers, and the OFAC floor` → "a default run goes through the adapter (alloy) and approves" |
| a partner attestation records its trust level | added | `onboarding: KYC through the adapter — sims, attestations, providers, and the OFAC floor` → "a partner attestation records its trust level" |
| an unknown trust level is refused | added | `onboarding: KYC through the adapter — sims, attestations, providers, and the OFAC floor` → "bad inputs are refused, never silently defaulted — and leave no record" |
| simulations force approve and deny | flow | `onboarding: KYC through the adapter — sims, attestations, providers, and the OFAC floor` → "simulations force the outcome: deny denies, approve approves" |
| every run leaves OFAC evidence — including clean passes | flow | `onboarding: KYC through the adapter — sims, attestations, providers, and the OFAC floor` → "a clean pass still leaves CG-OFAC-01 evidence" (+ "the OFAC evidence a test token writes is labelled demo" — DEFECT, red) |
| an OFAC hit denies and raises the alert | flow | `onboarding: KYC through the adapter — sims, attestations, providers, and the OFAC floor` → "an SDN-listed applicant is denied on a plain run, with the hit evidenced" + "each OFAC hit raised a BSA alert naming the applicant, labelled demo" |
| a FULL-TRUST attestation cannot bypass the OFAC floor | flow | `onboarding: KYC through the adapter — sims, attestations, providers, and the OFAC floor` → "neither a full-trust attestation nor a forced approve gets past the floor" |
| a forced approve cannot bypass the OFAC floor either | added | `onboarding: KYC through the adapter — sims, attestations, providers, and the OFAC floor` → "neither a full-trust attestation nor a forced approve gets past the floor" |
| alloy, socure and middesk all work through the one adapter | flow | `onboarding: KYC through the adapter — sims, attestations, providers, and the OFAC floor` → "alloy, socure and middesk all work through the one adapter" |
| an unknown provider is refused, not silently defaulted | added | `onboarding: KYC through the adapter — sims, attestations, providers, and the OFAC floor` → "bad inputs are refused, never silently defaulted — and leave no record" |

Counts: flow 6 · added 4 · contract 0 · drop 0
