# Coverage ledger: `core/supabase/functions/api/cda.test.ts` → CDA flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/cda.test.ts`. Run them with `scripts/flow.sh -f cda: --no-deploy`.

The CDA programme is an instance singleton: one Board adoption (`core.cda_policy`), one net worth (`core.capital_position`), one 5% cap summed over every open CDA. So the flows that need a live programme adopt a run-unique policy version and put back the adoption that was active before them. They also compute funding amounts from the live net worth and terminate and close every CDA they fund. The capital position is never written.

Disposition key:

- `flow`: covered by a step of a flow written for this area.
- `added`: a step written specifically to close this test's gap.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`. Not written here.
- `drop`: no user-observable surface, or only reachable by fault injection.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | CDA-01: an expired adoption blocks funding — the policy is a gate, not a report | flow | `cda: Board adoption gates the programme …` → "with the policy lapsed, a compliant funding is refused AND recorded; nothing is booked" (also "trades and distributions are blocked by the lapse too") |
| 2 | CDA-01: the expiry is anchored on ADOPTION, not on when the row was written | flow | same flow → "re-adoption eleven months ago: live for one more month, expiry anchored on ADOPTION" |
| 3 | CDA-01: an adoption BACKDATED past its own term is already expired | flow | same flow → "a BACKDATED adoption is already expired: its expiry runs from adoption, not from today" |
| 4 | CDA-01: NO adoption at all blocks too — absence is not permission | drop | Only reachable on a fresh instance. No API removes an adoption, and the demo instance has one, so `policy_not_adopted` can't be produced without deleting rows. The lapse path (#1) runs the same gate branch. |
| 5 | CDA-01: the sweep escalates a lapse without waiting for a transaction | flow | same flow → "the sweep escalates the lapse to the Board without waiting for a transaction" |
| 6 | CDA-01: a live adoption produces NO escalation — the sweep is not an echo | flow | same flow → "a live adoption produces NO escalation — the sweep is not an echo" |
| 7 | CDA-04: qualification is derived from the evidence, not asserted | added | `cda: trustee qualification is derived …` → "qualification is derived: only a recognised regulator + active registration + evidence qualifies" (all five cases go through `POST /cda/vendors`) |
| 8 | CDA-04: a caller cannot qualify a vendor by claiming it | flow | same flow → "a caller cannot qualify a vendor by claiming it" |
| 9 | CDA-04: a lapse found on review escalates to the Board with its 2-day clock | flow | same flow → "a lapse found on review escalates to the Board with its 2-day clock" |
| 10 | CDA-04: a review that changes nothing does NOT escalate | flow | same flow → "a review that changes nothing completes and does NOT escalate" |
| 11 | CDA-04: an unqualified trustee blocks funding — §721.3(b)(2)(ii) is in the conjunction | flow | same flow → "an unqualified trustee blocks funding …" |
| 12 | CDA-03: a label that does not DESIGNATE the account does not file the packet | flow | `cda: structure and agreement …` → "a label that does not DESIGNATE the account does not file the packet" |
| 13 | CDA-03: a designated label with no custodial statement is still incomplete | flow | same flow → "a designated label with no custodial statement is still incomplete" |
| 14 | CDA-05: a missing clause names ITSELF — the refusal is per-clause | flow | same flow → "a missing clause names ITSELF — the refusal is per-clause" |
| 15 | CDA-05: an unvalidated agreement blocks funding | flow | same flow → "an unvalidated agreement blocks funding" |
| 16 | CDA-05: an amendment with no Board resolution is refused | added | same flow → "an amendment with no Board resolution is refused — and does not take effect". This step also checks that the agreement row is unchanged afterwards. **DEFECT**: the handler writes the amended clauses before refusing, so this step is red. |
| 17 | CDA-06: the cap test is PROJECTED — the requested amount is inside the number tested | flow | `cda: the 5% cap …` → "a funding whose PROJECTED aggregate breaks 5% is refused, though today's aggregate is far under" |
| 18 | CDA-06: no capital position means the cap CANNOT be tested — not that it passed | drop | Needs an instance with no capital position. The demo instance has three, and they are shared, so they are never deleted. |
| 19 | CDA-06: the internal buffer refuses before the statutory cap does | flow | same flow → "over the 4% buffer but under the 5% cap: refused by the BUFFER, recorded, nothing booked" |
| 20 | CDA-06: a blocked funding is RECORDED — a gate that logs only what it permitted is unauditable | flow | same flow → buffer and cap steps (`cda_funding_request` rows with `decision=blocked`, book value unchanged); also the lapse step of the adoption flow |
| 21 | CDA-06: a breach is only CURED when the aggregate actually falls | added | same flow → "net worth falls (staged on THIS test's row): a cure PLAN alone does not clear the breach" + "distributing genuinely reduces book value, and only then does the cure land". The cure path runs live. The fall in net worth is staged on the flow's own cap-test row, because the real trigger, a new capital position, is shared instance state. So detecting the breach itself (`cap_breached`, `excess_cents`, the cure clock) is not exercised live. The detection half that can be reached, a buffer breach, is covered in "the cap test records utilisation …". |
| 22 | CDA-06: a cap test with no capital position is refused rather than reported clean | drop | Same reason as #18: it needs an empty `capital_position`. |
| 23 | CDA-07: with NO overlay configured a trade is unassessed and blocked, not permitted | flow | `cda: pre-trade overlays …` → "with NO overlay configured a trade is unassessed and blocked, not permitted" |
| 24 | CDA-07: concentration is measured AFTER the trade, so the first breach is refused | flow | same flow → "a 25% single-issuer overlay: a trade inside it executes, the first breach is refused" |
| 25 | CDA-07: an unapproved overlay limit is refused — the limits are Board-set | flow | same flow → "an overlay with no Board approval is refused — the limits are Board-set" |
| 26 | CDA-08: a donee with no EIN or IRS status is not a Qualified Charity | flow | `cda: giving …` → "a donee with no EIN or IRS status is not a Qualified Charity: blocked, nothing given" |
| 27 | CDA-08: an EIN with no IRS determination is still unvalidated | flow | same flow → "an EIN with no IRS determination is still unvalidated" |
| 28 | CDA-08: a window with no Total Return has NO coverage — 0/0 is not 100% | flow | same flow → "a window with no Total Return has NO coverage …" |
| 29 | CDA-08: a window short of 51% raises its shortfall alert with the amount | flow | same flow → "a window short of 51% raises its shortfall alert with the amount" |
| 30 | CDA-08: a window ABOVE 51% raises no alert | flow | same flow → "a window ABOVE 51% raises no alert" |
| 31 | CDA-11: a $5,000+ distribution self-approved by its proposer is refused | flow | same flow → "a $5,000 distribution self-approved by its proposer is refused; with NO approver too" |
| 32 | CDA-11: a sub-threshold distribution needs one approver and is still logged | flow | same flow → "a sub-threshold distribution needs one approver and is still logged as single approval" |
| 33 | CDA-11: a finding cannot be closed without evidence, and lateness is recorded | flow | `cda: programme audit …` → "a finding cannot be closed without evidence" + "closing with evidence after the due date records the lateness". The finding is logged already past due (`due_days: -1`), so nothing is staged. |
| 34 | CDA-11: a finding with no named owner is refused, not stored blank | added | same flow → "a finding with no named owner is refused, not stored blank — and no report is issued". **DEFECT**: the refused cycle still emits `cda.audit_report.issued`. |
| 35 | CDA-13: a fee to the credit union is blocked and escalated as a conflict | flow | `cda: affiliate fees …` → "a fee to the credit union is blocked and escalated on a 5-business-day clock" |
| 36 | CDA-13: the affiliate test is case- and whitespace-insensitive | flow | same flow → "the affiliate test is case- and whitespace-insensitive" |
| 37 | CDA-13: a third-party fee is permitted and raises NO conflict | flow | same flow → "a third-party fee is permitted and raises NO conflict" |
| 38 | CDA-12: an in-kind asset with no documented determination is liquidated, not received | flow | `cda: termination …` → "an in-kind asset with no documented determination is liquidated, not received" (termination approved through the API, not seeded) |
| 39 | CDA-12: a non-Part-703 asset class is blocked even with a determination | flow | same flow → "a non-Part-703 asset class is blocked even with a determination; the proposal is still recorded" |
| 40 | CDA-14: publication is blocked without BOTH approvals and the checklist | flow | `cda: member communications …` → "publication is blocked without BOTH approvals" |
| 41 | CDA-14: a failing WCAG checklist blocks even with both approvals | flow | same flow → "a failing WCAG checklist blocks even with both approvals" |
| 42 | CDA-14: publishing requires the artifact to be archived at publication | flow | same flow → "both approvals + checklist approve; publishing requires the archive reference" |
| 43 | CDA-02: the version is derived from the prior active term, never supplied | flow | `cda: glossary …` → "two changes to a term land as v1 then v2, whatever version the caller claims" |
| 44 | CDA-02: a definition with no citation is refused | flow | same flow → "a definition with no citation is refused and nothing is written" |
| 45 | the gate reports EVERY failed condition, not just the first | flow | `cda: Board adoption gates the programme …` → "the gate reports EVERY failed condition at once, not just the first". It checks `policy_expired`, `evidence_packet_not_filed`, `agreement_clauses_unvalidated` and `no_vendor_assigned`. `net_worth_unknown` is not checked, for the reason given in #18. |
| 46 | a fully compliant funding is permitted and books the money | flow | same flow → "a fully compliant funding is permitted and books the money" |
| 47 | no constraint violations across the whole exercised surface | drop | A self-check of the in-memory fake (`fake_db.violations`). Against the real database, a constraint violation surfaces as a 500, and every step already asserts the expected status and row. |

Also covered beyond the stub file: a partner gets 404 on the CDA surface and nothing is written; termination, a received in-kind asset, and a close that issues the report and escalates a short closing distribution; a cure attempt on a cap test with no breach; a $5,000+ distribution with no approver; a buffer breach raised by the cap test; an amendment that does carry a Board resolution.

Counts: flow 39, added 4, contract 0, drop 4.
