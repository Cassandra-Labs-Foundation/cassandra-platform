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
| 3 | RS-04: a garnishment blocks debits and PERMITS credits | added | freezes → "a garnishment blocks debits but PERMITS credits …". The follow-on step "the credit the core says it POSTED actually lands …" is **DEFECT, red**. |
| 4 | RS-04: an OFAC block stops credits too | added | freezes → "an OFAC block stops credits too: the credit is NOT posted, and says why" |
| 5 | RS-04: precedence is explicit and court process outranks the rest | added | freezes → "legal applies a court order …" (precedence 10 stored) and "a fraud hold on top … the court order GOVERNS …" |
| 6 | RS-04: a legal-process freeze with no reference is refused | added | freezes → "an unknown authority is refused, and a garnishment that names no legal process is refused (400)" |
| 7 | RS-04: a release with no reference is refused | added | freezes → "a release that names no authority is refused (400) …" |
| 8 | RS-05: activation with no evidence is refused | added | institution → "an order with no reference is refused; ACTIVATION with no evidence … is refused (400)" |
| 9 | RS-05: activation records evidence, notice and regulator confirmation | added | institution → "activated with evidence, the member notice published and the regulator's confirmation recorded" |
| 10 | RS-06: read-only access with no dated snapshot is refused | added | portal → "a partner cannot change the portal (404), and read-only access with no dated snapshot is refused (400) …" |
| 11 | RS-06: access serves the snapshot and is logged as evidence | added | portal → "a member reads their balance: served the SNAPSHOT, and the access is logged …" |
| 12 | RS-02: an indicator with no configured threshold yields NO verdict | added | ewi → "RS-02: 999,999 against NO threshold is no verdict …" |
| 13 | RS-02: an already-breached indicator does not re-alert | added | ewi → "the second consecutive breached interval: WATCH … the breach is NOT re-alerted". This step also checks for separate observation rows and the prior-breach state. |
| 14 | RS-02: the posture is a standing state and moves with the breach count | added | ewi → "the second consecutive breached interval …", "re-observing the same breached state changes nothing …" and "three indicators breached for two intervals: HEIGHTENED …". "ONE breached interval does not move the posture" is **DEFECT, red**: the unit test encodes the single-sweep behaviour that RS-02 forbids. |
| 15 | RS-08: a package whose checksum chain does not match FAILS | added | records → "a chain whose root does not match FAILS …" checks the response and events. The row check is in "every build is RECORDED …", which is **DEFECT, red**. |
| 16 | RS-08: a package with NO chain at all fails rather than completing | added | records → "a package with NO checksum chain FAILS rather than completing" (row check: the same red step) |
| 17 | RS-08: a matching chain completes | added | records → "a matching chain completes …" (row check: the same red step) |
| 18 | a partner token cannot reach the resolution routes | added | Every flow's first step checks that a partner gets 404 on freezes, the institution freeze, the portal, EWI indicators and records packages. |

**Counts:** flow 0 · added 18 · contract 0 · drop 0 (total 18).

## Flow steps beyond the unit file (policy checks)

These steps are written to the policy text in `compliance/policies/resolution/resolution.md`. Each one is red against the deployed core:

- **DEFECT (RS-04):** a court-ordered freeze does not stop a debit, because `POST /transfers` settles out of the frozen account. Nothing outside `resolution.ts` reads `account.debits_blocked`, `credits_blocked` or `core.account_freeze`.
- **DEFECT (RS-04):** `POST /resolution/accounts/{id}/credit` answers `posted: true` and emits `account_freeze.credit.posted`, but no money moves.
- **DEFECT (RS-04):** a second garnishment under a different legal process overwrites the first, because the freeze id is `frz_<account>_<authority>`.
- **DEFECT (RS-05):** an activated institution freeze halts nothing, so a transfer settles while it is active. The flow deletes its own freeze row in a `finally`. The core already holds a leftover drill row, `instfrz_NCUA-ORD-1`, which has been "active" since 2026-07-21 and gates nothing.
- **DEFECT (RS-06):** only the instance's first read-only activation is ever evidenced, because the event id is the constant `ev_portal_ro`.
- **DEFECT (RS-06):** any internal credential can switch read-only mode off. The policy says this needs CCO authorization.
- **DEFECT (RS-08):** no package is ever stored. `core.records_package` is shared with cash-ops exam exports, which made `purpose` NOT NULL, and `postRecordsPackage` neither sets `purpose` nor checks the upsert error. The API still answers `verified: true` and logs `records_package.completed`.
- **DEFECT (RS-08):** a sealed (completed) manifest can be resubmitted. The core answers 200 and logs `records_package.verification.failed` against a package it already completed.
- Once rows persist, a failed package rebuilt with a good chain should complete. Instead it will hit `ck_package_not_both`, and that error is ignored. The step is red today on the missing-row defect.

Shared-state handling:

- The portal row is saved and restored exactly.
- The posture rows the EWI flow causes are deleted, so the instance's latest posture is unchanged. Its indicators and observations are deleted too.
- The flow's freezes are released, and its institution freeze row is deleted.

## §46 of `compliance_e2e.sh`

There was nothing new to port. RS-03 (safe mode cap, durable processor confirmation, refused over-cap transfer with decision evidence, dual-authorized deactivation) is covered in `member_protection.test.ts`. Its refusal-only parts are also in `isolation.test.ts`. MP-07, MP-06, PR-03/04, PR-15 and CP-05 are in `isolation.test.ts`. DF-05 needs the lending routes, which are deliberately unrouted.
