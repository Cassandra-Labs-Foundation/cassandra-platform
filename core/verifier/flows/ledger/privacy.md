# Coverage ledger: `core/supabase/functions/api/privacy.test.ts` → privacy flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/privacy.test.ts`. Run them with `scripts/flow.sh -f privacy: --no-deploy`.

Disposition key:

- `flow`: covered by a step of a flow that walks the whole journey.
- `added`: a step written to close a gap the stub covered and no journey step did.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`. Not written here.
- `drop`: an implementation detail with no user-observable surface.

Two stubs mutated a fake row's deadline to make a sweep fire. The flows do the same to their **own** fixture row with a service-role update of the deadline column, which is the clock the sweep reads. This is a time fixture, not fault injection.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | PR-11: E-SIGN delivery with NO consent is refused | flow | `privacy: GLBA notice published → …` → "E-SIGN delivery with NO consent is refused and leaves no delivery row" |
| 2 | PR-11: consent that did not DEMONSTRATE access is not consent | flow | same flow → "a checkbox that did not DEMONSTRATE access is not consent: delivery still refused" |
| 3 | PR-11: demonstrated consent permits electronic delivery | flow | same flow → "demonstrated consent permits electronic delivery of a requested copy, due in 30 days" |
| 4 | PR-02: an opt-out is a STANDING STATE with a propagation deadline | flow | `privacy: member opts out of sharing → …` → "opt out of non-affiliate sharing: a standing state with a 30-day propagation deadline" |
| 5 | PR-02: CLEARING an opt-out is recorded as its own state change | flow | same flow → "CLEARING an opt-out is recorded as its own state change" |
| 6 | PR-02: Nevada is its own regime, not folded into the GLBA opt-out | flow | same flow → first step (no `nv_optout_enforced` for GLBA) + "a Nevada sale opt-out is its own regime" |
| 7 | PR-02: propagation naming NO systems is refused | flow | same flow → "propagation naming NO systems is refused and propagates nothing" |
| 8 | PR-02: propagation records lateness | flow | same flow → "a sweep after the deadline propagates it and records that it was LATE" (deadline aged on the fixture row) |
| 9 | PR-12: fulfilling an UNVERIFIED request is refused — that IS the disclosure | flow | `privacy: state rights — …` → "fulfilling an UNVERIFIED request is refused — that IS the disclosure" |
| 10 | PR-12: an OPT-OUT right sets the standing state, not just a ticket | flow | same flow → "an OPT-OUT right sets the standing state, not just a ticket" |
| 11 | PR-12: the universal floor uses the STRICTEST deadline | flow | same flow → "a CA access request is logged with the strictest (45-day) deadline" |
| 12 | PR-12: a denial must state its basis | flow | same flow → "a delete request denied without a basis is refused; with a basis it is recorded" |
| 13 | PR-14: a GPC signal OVERRIDES the banner | flow | `privacy: web tracking — …` → "a GPC signal OVERRIDES the banner: nothing optional fires" |
| 14 | PR-14: tags are gated by BOTH approval and consent | flow | same flow → "consent to everything: only the approved tag may fire" |
| 15 | PR-14: a decided tag needs a named reviewer | flow | same flow → "a decided tag needs a named reviewer; reviews are recorded with their decision" |
| 16 | PR-13: a dataset over the re-identification threshold is NOT released | flow | `privacy: analytics release — …` → "a dataset over the re-identification threshold is NOT released" |
| 17 | PR-13: k-anonymity with no k is refused | flow | same flow → "k-anonymity with no k is refused" |
| 18 | PR-13: a RAW dataset is never auto-approved | flow | same flow → "a RAW dataset is never auto-approved, even at negligible risk" |
| 19 | PR-16: capturing biometrics with NO consent is refused outright | flow | `privacy: biometric KYC — …` → "capturing biometrics with NO consent is refused outright" |
| 20 | PR-16: biometric data is PURGED when its purpose ends | flow | same flow → "a purge sweep before the deadline leaves it; after the deadline it is purged" (deadline aged on the fixture row) |
| 21 | PR-17: the age gate blocks; detection AFTER collection is a different failure | flow | `privacy: children's data — …` → both steps |
| 22 | PR-05: a correction applied but NOT propagated is not propagated | flow | `privacy: FCRA furnishing dispute — …` → "a correction applied but NOT propagated is not propagated (the deadline is set)" |
| 23 | PR-05: an NCOA mismatch raises a RED FLAG, not only a data-quality item | flow | same flow → "an address dispute with an NCOA mismatch: red flag, address row, dispute register entry" |
| 24 | PR-05: a furnishing dispute is a DISPUTE, with a basis and no amount | flow | same flow → same step (`core.dispute` kind `data_accuracy`, no amount, no Reg E clock) |

Totals: flow 24, added 0, contract 0, drop 0.

## Beyond the stubs

The stub file never drove the PR-03, PR-04 and PR-15 gates, or the disposal and incident-decision routes. These flows cover them:

- `privacy: sharing member data — …` (PR-03). A partner gets 403. A disclosure with no basis, or with an unrecognised one, is blocked and recorded. A vendor without a GLBA addendum is blocked. Consent-based sharing, and sharing with an addended vendor, proceed and record their basis.
- `privacy: who may see a member's data — …` (PR-04). The member is granted. A POA with no artifact, and legal process with no instrument, are refused. A stranger is refused, all three refusals are recorded, and the refusal body carries no PII.
- `privacy: disposal certificate recorded; …` (PR-08/PR-18).
- `privacy: third-party connection — …` (PR-15). The token stores only its sha256, is confined to its scope and is read-only. An out-of-scope request must revoke it. **DEFECT:** the router never calls `recordConnectionScopeViolation`. An ops-recorded violation does revoke, after which the token gets 401.
- Partner refusals: 404 on the self-gated routes (`privacy: GLBA notice …`, first step) and 403 on the `x-actors` routes (disclosures, access requests, scope-violation).
