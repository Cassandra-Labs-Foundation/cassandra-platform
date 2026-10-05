# Coverage ledger: `core/supabase/functions/api/member_protection.test.ts` → member-protection flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/member_protection.test.ts`. Run them with `scripts/flow.sh -f member_protection: --no-deploy`.

Disposition key:

- `flow`: covered by a step that already existed.
- `added`: a flow step written to cover it.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`.
- `drop`: no user-observable surface, or reachable only by fault injection.

The three flows are: **estate** (`member_protection: death reported from a certificate …`), **expulsion** (`member_protection: expulsion needs a deliverable contact …`) and
**safe mode** (`member_protection: safe mode activated …`).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | MP-07: a death is flagged from a DOCUMENT, not a rumor | added | estate → "a death is flagged from a DOCUMENT, not a rumor: no certificate → 400, nothing locked" |
| 2 | MP-07: a death report locks EVERY account, one event per account | added | estate → "staff report the death with the certificate: EVERY account locked deceased, one event per account"; enforcement in "the lock ENFORCES: a transfer out of the deceased member's account is refused …" |
| 3 | MP-07: a payout to an UNVERIFIED claimant is refused | added | estate → "document the estate claim: … PENDING claimant verification" and "THE GATE: payout to an UNVERIFIED claimant is refused (409) …" |
| 4 | MP-07: an approved claimant is paid the balance net of amounts owed — once | added | estate → "the verified claimant is paid the LEDGER balance net of amounts owed; the mirror is refreshed" (the fixture's mirror is poisoned first) and "an estate is not paid twice (409)" |
| 5 | MP-07: a payout FAILS CLOSED when the ledger cannot be read | drop | Needs a Blnk read failure. It cannot be provoked against the live ledger without fault injection. |
| 6 | MP-06: an expulsion cannot be NOTICED to a member with no deliverable contact | added | expulsion → "a member who cannot be told cannot be noticed: 422 no_deliverable_contact, nothing recorded" |
| 7 | MP-06: closing nets amounts owed and locks the accounts 'expelled' | added | expulsion → "close: board report filed, payout = ledger balance net of owed, accounts locked expelled", "the lock ENFORCES …" and "a closed expulsion cannot be closed again (409)" |
| 8 | RS-03: safe mode decides every transaction and leaves evidence EITHER WAY | added | safe mode → "a $100 transfer under the cap is ALLOWED — and the decision is recorded" and "a $22,000.01 transfer over the cap is REFUSED (423) …". The restricted-type case is in "RS-03 covers every outbound channel: a wire (a restricted type) is refused …" (DEFECT, red). |
| 9 | RS-03: deactivation takes TWO different authorizers | added | safe mode → "deactivation on ONE person's judgment is refused (422) …", "two DIFFERENT authorizers deactivate it …" and "with safe mode off the gate restricts nothing …" |

**Counts:** flow 0 · added 8 · contract 0 · drop 1 (total 9).

## Flow steps beyond the unit file

- **Access:** a partner token gets 403 on death report, estate payout, expulsion, expulsion close and safe-mode activation. These routes declare `x-actors: [cu_admin, pynthia_ops]`.
- **Not found:** a death report for an unknown member returns 404.
- **Validation:** an incomplete estate claim gets 400. An incomplete expulsion gets 400. An unknown hearing `kind` gets 400.
- **Hearing:** a requested hearing moves the expulsion to `hearing`, and a held hearing is stamped.
- **Safe mode:**
  - A second activation gets 409 (`safe_mode_already_active`).
  - Processor confirmation is recorded.
  - A second deactivation gets 409.
- **No approval API:** no routed API approves an `estate_claimant` verification, because `POST /verifications/{id}/transition` is in `x-proposed-paths`. The estate flow writes that approval through the service role, standing in for the out-of-band identity check.
- **Payouts (DEFECT, red):** an estate payout and an expulsion payout must each leave the member's accounts. Today both only record the payout and emit an event, and the ledger balance does not change.
- **Shared instance:** safe mode is core-wide. The flow uses a $22,000 cap, above anything the other flows send. It restricts only the `wire` type, which wires currently ignore. It retires only a stale `flow:` activation, and it deactivates in a `finally` block.
