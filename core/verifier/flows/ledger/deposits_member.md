# Coverage ledger: `core/supabase/functions/api/deposits_member.test.ts` → deposit flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/deposits.test.ts`. Run them with `scripts/flow.sh -f deposits: --no-deploy`.

Disposition key:

- `flow`: covered by a ported bash section. None here: the bash script never exercised `/deposits` or the membership routes.
- `added`: a flow step written to close a gap the bash script left.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`. Not written here.
- `drop`: no user-observable surface on the deployed core.

The two flows are referred to as **TIS** (`deposits: a member joins, is disclosed to, accrues interest and gets a statement …`) and **MP** (`deposits: an address hold blocks a card reissue, a restriction stops the money, exports need a purpose`).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | APY is DERIVED from the rate and the compounding | added | TIS → "TIS-06: the interest configuration DERIVES its APY — a supplied APY is ignored" (202 daily, 200 annual, daily > quarterly; a supplied `apy_bp: 999` is stored as 202) |
| 2 | E-SIGN: electronic delivery with no captured consent is REFUSED | added | TIS → "E-SIGN: electronic delivery with no captured consent is REFUSED, not recorded" (409 `esign_consent_missing`, no `disclosure_delivery` row) |
| 3 | a delivery SNAPSHOTS the terms it disclosed, not a pointer to them | added | TIS → "with consent the delivery lands and SNAPSHOTS …" and "the snapshot holds when the configuration later moves" |
| 4 | a detected disclosure error opens its own finding | added | TIS → "TIS-02/03: a change in terms gets 30 days, is classified, and a detected error is its own finding" (also: a flag with no detail is refused) |
| 5 | accruing interest with no configuration is refused | added | TIS → "interest cannot accrue with no configuration on file" (409 `no_interest_config`, no run row) |
| 6 | the accrual run carries the config it ran against | added | TIS → "the accrual run carries the configuration it ran against" (run keyed by a run-unique period, so it touches no other fixture) |
| 7 | TIS-08: the balance disclosed separates ledger from available | added | TIS → "TIS-08: a balance inquiry discloses available apart from ledger" (uses the account's real ledger balance) |
| 8 | the statement carries year-to-date fees, not just the period's | added | TIS → "the statement carries year-to-date fees, not just the period's" (statement keyed by this run's account) |
| 9 | an eligibility denial with no basis is refused | added | TIS → "an eligibility denial with no stated basis is refused and records nothing" |
| 10 | MP-01: determination and activation are separate events | added | TIS → "MP-01: the CU determines eligibility, then activates — two separate facts" |
| 11 | MP-05: a restriction lands on the ACCOUNT, not only the membership | added | MP → "MP-05: a freeze lands on the ACCOUNT …", followed by "and the money actually stops" (a transfer out of the frozen account gets 422 `account_locked`) |
| 12 | MP-08: a bulk member-record export with no stated purpose is refused | added | MP → "MP-08: a bulk member-record export with no stated purpose is refused" and the with-purpose counterpart |
| 13 | MP-02: a card reissue inside the address hold is recorded AND blocked | added | MP → "MP-02: an address change opens a 30-day hold …" then "MP-02: a card reissue inside the hold is recorded AND blocked" |
| 14 | MP-02: the same reissue with no open hold proceeds | added | MP → "MP-02: the same reissue for a member with no open hold proceeds". Uses a member with no address change. The API can't backdate a hold, so the unit test's expired-hold variant has no live equivalent. |
| 15 | FL-02: intake records the channel and product the rules turn on | drop | `/fair-lending/applications/{id}/intake` is deliberately unrouted (lending exclusion, `api/index.ts`) |
| 16 | FL-08: fewer than three options must say WHY | drop | `/fair-lending/applications/{id}/options` is unrouted (lending exclusion) |
| 17 | FL-08: three options meet the safe harbour and record no shortfall | drop | Unrouted (lending exclusion) |
| 18 | a partner token cannot reach the deposits routes at all | added | TIS → "the fintech cannot reach the CU's deposit routes …" (template, membership and balance inquiry each return 404 `not_found`, and no row is written) |
| 19 | GMI: a partial answer is INCOMPLETE and opens a finding | drop | `/fair-lending/applications/{id}/gmi` is unrouted (lending exclusion) |
| 20 | GMI: all three answers are complete and open no finding | drop | Unrouted (lending exclusion) |

**Counts:** flow 0 · added 15 · contract 0 · drop 5 (total 20).

## Flow steps beyond the unit file

- A change-in-terms notice is due 30 days out and is classified adverse with `notice_required` (TIS-03).
- An interest configuration with an unknown compounding is refused.
- A statement with no closing balance is refused.
- The address change notifies the old address as well as the new one (Red Flags).
- A restriction of an unknown kind is refused, and the account is left untouched.
- An export that states a purpose records the requesting actor's token.
- All evidence written by the test actors is labelled `demo`.

## Not exercised

- `/members/{id}/preferences` and `/members/{id}/service-requests` have no unit test in the stub file and no flow here.
- The balance inquiry, the statement and the interest run all take their balances from the caller rather than reading the ledger. The flows pass real ledger balances, but nothing checks the two agree.
