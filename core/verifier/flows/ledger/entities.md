# entities.test.ts → coverage ledger

Source: `core/supabase/functions/api/entities.test.ts` (15 tests). Flows: `core/verifier/flows/onboarding.test.ts`, `core/verifier/flows/platform.test.ts`.

| test | disposition | where |
|---|---|---|
| a person is created and starts PENDING | flow | `onboarding: a partner onboards a member and a business with its beneficial owner` → "create a person: 201, starts PENDING, owned by the partner, entity.created logged" |
| business, trust and joint all create with their required fields | flow | `onboarding: a partner onboards a member and a business with its beneficial owner` → "business, trust and joint all create with their required fields" |
| per-type required fields are enforced | added | `onboarding: a partner onboards a member and a business with its beneficial owner` → "each type's identifying minimum is enforced: missing fields are 400 by field" |
| the unified list returns mixed types and filters by type | flow | `onboarding: a partner onboards a member and a business with its beneficial owner` → "the unified list filters by type and refuses an unknown type" |
| an ops actor lists across partners — D23 gives it full access | added | `platform: a scoped token can do exactly what it was granted, and nothing once revoked` → "a partner is confined to its own rows: another partner's account is a 404" (ops reads the foreign row; same `scopeToPartner` predicate) |
| an unknown type filter is refused | added | `onboarding: a partner onboards a member and a business with its beneficial owner` → "the unified list filters by type and refuses an unknown type" |
| a legal transition updates status and emits an event | flow | `onboarding: a partner onboards a member and a business with its beneficial owner` → "activate the person: pending -> active, entity.activated logged" |
| an illegal transition is a 409 and emits nothing | flow | `onboarding: a partner onboards a member and a business with its beneficial owner` → "an illegal transition (active -> pending) is a 409 and leaves no event" |
| the machine walks pending -> active -> disabled -> archived | flow | `onboarding: a partner onboards a member and a business with its beneficial owner` → "the lifecycle walks active -> disabled -> active -> archived; archived is terminal" (HTTP half also contract D7-E1/E2) |
| a business records a 25% beneficial owner | flow | `onboarding: a partner onboards a member and a business with its beneficial owner` → "the business records the person as a 25% beneficial owner" |
| a person cannot have beneficial owners | added | `onboarding: a partner onboards a member and a business with its beneficial owner` → "a person cannot have beneficial owners: 409" |
| ownership percent is bounded 0-100 | added | `onboarding: a partner onboards a member and a business with its beneficial owner` → "ownership percent is bounded (0, 100] with at most 2 decimals" |
| a compliance lock leaves account state intact and is logged | flow | `onboarding: an account is locked for review, unlocked, numbered, and its numbers retired` → "a compliance lock leaves the account open and is logged with its reason" |
| unlock restores none and is logged too | added | `onboarding: an account is locked for review, unlocked, numbered, and its numbers retired` → "unlock restores none and is logged too" |
| account machine: open <-> frozen, both -> closed, closed terminal | added | `onboarding: an account is locked for review, unlocked, numbered, and its numbers retired` → "the account machine: frozen and back, then closed for good — each step logged" (HTTP half also contract D7-A1) |

Counts: flow 7 · added 8 · contract 0 · drop 0
