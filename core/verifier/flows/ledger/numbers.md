# numbers.test.ts → coverage ledger

Source: `core/supabase/functions/api/numbers.test.ts` (7 tests). Flow: `core/verifier/flows/onboarding.test.ts`.

| test | disposition | where |
|---|---|---|
| minted numbers are 12 digits: 3-digit prefix + 8 body + Luhn digit | flow | `onboarding: an account is locked for review, unlocked, numbered, and its numbers retired` → "mint a partner number: 12 digits, Luhn-valid, not under 000, ABA routing" (12-digit/Luhn shape also contract D2-T1/D20) |
| prefix 000 is reserved for CU-direct minting | flow | `onboarding: an account is locked for review, unlocked, numbered, and its numbers retired` → "a CU-direct number mints under the reserved 000 prefix" |
| the routing number carries a valid ABA checksum | added | `onboarding: an account is locked for review, unlocked, numbered, and its numbers retired` → "mint a partner number: 12 digits, Luhn-valid, not under 000, ABA routing" |
| minting stores an active number bound to the account | added | `onboarding: an account is locked for review, unlocked, numbered, and its numbers retired` → "mint a partner number…" (DB row: account_id, status active) + "one account carries many distinct pairs, listed on the account" |
| a mint collision retries with a fresh number instead of failing | drop | a collision cannot be forced against the live core; the user-observable guarantee it protects (a pair is never reissued) is asserted in `onboarding: an account is locked for review, unlocked, numbered, and its numbers retired` → "canceled is forever: no reactivation, and the pair is never reissued" |
| minting on an unknown account is a 404 | added | `onboarding: an account is locked for review, unlocked, numbered, and its numbers retired` → "minting on an unknown account is a 404" |
| number machine: active <-> disabled, both -> canceled, canceled terminal | flow | `onboarding: an account is locked for review, unlocked, numbered, and its numbers retired` → "a number walks active -> disabled -> active -> canceled, each step logged" + "canceled is forever…" |

Counts: flow 3 · added 3 · contract 0 · drop 1
