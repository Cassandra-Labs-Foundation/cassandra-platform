# Coverage ledger: `core/supabase/functions/api/resolution.test.ts` → resolution flows

Each `Deno.test` in the stubbed unit file is listed below with the place where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/resolution.test.ts`. Run them with `scripts/flow.sh -f resolution: --no-deploy`. RS-03 safe mode is in `member_protection.test.ts`.

Disposition key: `flow` (an existing step covers it), `added` (a step written to close the gap), `contract` (HTTP shape only), `drop` (no user-observable surface).

There are five flows:

- **freezes** is `resolution: legal process freezes a member's account …`.
- **institution** is `resolution: an NCUA order freezes the institution …`.
- **portal** is `resolution: with the core down the member portal goes read-only …`.
- **ewi** is `resolution: early-warning indicators are swept …`.
- **records** is `resolution: the records package is built against a manifest …`.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | RS-04: releasing ONE of two freezes leaves the other standing | added | freezes → "THE BUG THIS EXISTS TO PREVENT: releasing the fraud hold leaves the court order standing" |
| 2 | RS-04: releasing the LAST freeze does clear the account | added | freezes → "releasing the LAST freeze clears the account — derived, not set" |
| 3 | RS-04: a garnishment blocks debits and PERMITS credits | added | freezes → "a garnishment blocks debits but PERMITS credits …". The follow-on step "the credit the core says it POSTED actually lands …" is a regression guard (fixed 2026-10-06). |
| 4 | RS-04: an OFAC block stops credits too | added | freezes → "an OFAC block stops credits too: the credit is NOT posted, and says why" |
| 5 | RS-04: precedence is explicit and court process outranks the rest | added | freezes → "legal applies a court order …" (precedence 10 stored) and "a fraud hold on top … the court order GOVERNS …" |
| 6 | RS-04: a legal-process freeze with no reference is refused | added | freezes → "an unknown authority is refused, and a garnishment that names no legal process is refused (400)" |
| 7 | RS-04: a release with no reference is refused | added | freezes → "a release that names no authority is refused (400) …" |
| 8 | RS-05: activation with no evidence is refused | added | institution → "an order with no reference is refused; ACTIVATION with no evidence … is refused (400)" |
| 9 | RS-05: activation records evidence, notice and regulator confirmation | added | institution → "activated with evidence, the member notice published and the regulator's confirmation recorded" |
| 10 | RS-06: read-only access with no dated snapshot is refused | added | portal → "a partner cannot change the portal (404), and read-only access with no dated snapshot is refused (400) …" |
| 11 | RS-06: access serves the snapshot and is logged as evidence | added | portal → "a member reads their balance: served the SNAPSHOT, and the access is logged …" |
| 12 | RS-02: an indicator with no configured threshold yields NO verdict | added | ewi → "RS-02: 999,999 against NO threshold is no verdict …" |
| 13 | RS-02: an already-breached indicator does not re-alert | added | ewi → "the next interval still breached: still WATCH, no new posture, and the breach is NOT re-alerted". This step also checks for separate observation rows and the prior-breach state. |
| 14 | RS-02: the posture is a standing state and moves with the breach count | added | ewi → "ONE breached interval moves the posture to WATCH …", "re-observing the same breached state changes nothing …", "three indicators breached in ONE interval: HEIGHTENED at once …" and "ONE clean interval steps the posture straight back down to NORMAL …". Single-sweep posture changes (no two-interval damping) are the user's decision of 2026-10-06. |
| 15 | RS-08: a package whose checksum chain does not match FAILS | added | records → "a chain whose root does not match FAILS …" checks the response and events. The row check is in "every build is RECORDED …" (a regression guard, fixed 2026-10-06). |
| 16 | RS-08: a package with NO chain at all fails rather than completing | added | records → "a package with NO checksum chain FAILS rather than completing" (row check: the same red step) |
| 17 | RS-08: a matching chain completes | added | records → "a matching chain completes …" (row check: the same red step) |
| 18 | a partner token cannot reach the resolution routes | added | Every flow's first step checks that a partner gets 404 on freezes, the institution freeze, the portal, EWI indicators and records packages. |

**Counts:** flow 0 · added 18 · contract 0 · drop 0 (total 18).

## Flow steps beyond the unit file (policy checks)

These steps are written to the policy text in `compliance/policies/resolution/resolution.md`. Each was red against the deployed core and is now a regression guard (fixed 2026-10-06):

- **RS-04:** a court-ordered freeze did not stop a debit. `runGate` in `transfers.ts` now reads `core.account_freeze`: a live freeze that blocks debits refuses every rail out of the account, and one that blocks credits refuses a book transfer into it (423 `account_frozen`, with an `RS-04` control result).
- **RS-04:** `POST /resolution/accounts/{id}/credit` answered `posted: true` with no ledger entry. It now posts `@ResolutionCredits` to the account's Blnk balance first, under an idempotent reference.
- **RS-04:** a second garnishment under a different legal process overwrote the first. The freeze id now carries the legal process (or order) reference: `frz_<account>_<authority>_<reference>`. A freeze on an account that does not exist is a 404.
- **RS-05:** an activated institution freeze halted nothing. `runGate` now refuses every movement on every rail while an activated, unreleased `core.institution_freeze` row exists (423 `institution_frozen`, with an `RS-05` control result); enforcement was the user's decision of 2026-10-06. Account opening is not behind `runGate`. The flow deletes its own freeze row in a `finally`, and while that row is active every rail on the instance is halted.
- **RS-06:** only the instance's first read-only activation was evidenced. Each activation and deactivation now gets its own event id (deactivation emits `member_portal.readonly.disabled`).
- **RS-06:** any internal credential could switch read-only mode off. Deactivation now needs the `cco` role (403 otherwise).
- **RS-08:** no package was ever stored, because `postRecordsPackage` neither set `purpose` (NOT NULL on the table shared with cash-ops exam exports) nor checked the upsert error. It now sets `purpose = 'resolution'` (migration `20261006001100_records_package_resolution.sql` admits it) and answers 500 on any write error.
- **RS-08:** a sealed (completed) manifest could be resubmitted. It is now refused with 409. A failed package rebuilt with a good chain completes, and the failure stamp is cleared in the same write so `ck_package_not_both` holds; the failure stays on record as its event.

Shared-state handling:

- The portal row is saved and restored exactly.
- The posture rows the EWI flow causes are deleted, so the instance's latest posture is unchanged. Its indicators and observations are deleted too.
- The flow's freezes are released, and its institution freeze row is deleted.

## §46 of `compliance_e2e.sh`

There was nothing new to port. RS-03 (safe mode cap, durable processor confirmation, refused over-cap transfer with decision evidence, dual-authorized deactivation) is covered in `member_protection.test.ts`. Its refusal-only parts are also in `isolation.test.ts`. MP-07, MP-06, PR-03/04, PR-15 and CP-05 are in `isolation.test.ts`. DF-05 needs the lending routes, which are deliberately unrouted.
