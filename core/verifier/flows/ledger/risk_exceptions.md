# Coverage ledger: `core/supabase/functions/api/risk_exceptions.test.ts` → risk flows

Each `Deno.test` in the stubbed unit file is listed below with the place where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/risk.test.ts`. Run them with `scripts/flow.sh -f risk: --no-deploy`.

Disposition key: `flow` (an existing step covers it), `added` (a step written to close the gap), `contract` (HTTP shape only), `drop` (no user-observable surface).

There are three flows:

- **breaches** is `risk: a KRI is measured against Board appetite …`.
- **acceptance** is `risk: the owner asks to carry a breached risk …`.
- **overrides** is `risk: control overrides are recorded with a rationale …`.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | ERM-06: a risk with no OWNER is refused | added | breaches → "ERM-06: a risk with no OWNER is refused (400 owner_id) …" |
| 2 | ERM-06: a KRI INSIDE appetite records that the check ran and opens nothing | added | breaches → "ERM-06: 180bp is INSIDE appetite — no breach, but the check is recorded …" |
| 3 | ERM-06: direction matters — 'below' tolerance breaches on a LOW value | added | breaches → "ERM-06: direction matters …" |
| 4 | ERM-06: severity comes from the SIZE of the excursion | added | breaches → "310bp is a LOW excursion" (low), "700bp is CRITICAL" (critical), and the below appetite at 50/100 (high). The `moderate` band is not exercised live. |
| 5 | ERM-06: only a high or critical excursion notifies the CRO | added | breaches → the low step asserts no `risk_breach.cro.notified`, and the critical step asserts it fires with the reason |
| 6 | ERM-06: a breach presented with no remediation plan is refused | added | breaches → "a breach presented with no remediation plan is a status report — refused (400), nothing stamped" |
| 7 | ERM-06: late presentation is recorded as late | added | breaches → "a breach whose 30-day committee deadline has passed is recorded as presented LATE". The flow moves its own breach's clock through the service role. |
| 8 | ERM-07: an acceptance with NO EXPIRY is refused | added | acceptance → "ERM-07: an acceptance with NO expiry is refused (400 expiry_date) …" |
| 9 | ERM-07: an expiry too soon to be revisited is refused | added | acceptance → "ERM-07: an expiry inside the 30-day warning window … refused (409)" |
| 10 | ERM-07: the owner cannot grant their own acceptance | added | acceptance → "the owner cannot grant their own acceptance (409) …" and "the CCO accepts it on time …" |
| 11 | ERM-07: the sweep WARNS before expiry, then EXPIRES and re-opens the breach | added | acceptance → "20 days from expiry (clock moved): the sweep sends the 30-day alert once …" and "the expiry date passes (clock moved): the sweep expires it and the risk is back in breach". The second step is a regression guard (fixed 2026-10-06): the lapse now creates one `risk_breach` row for the risk, keyed on the acceptance. |
| 12 | ERM-07: the sweep touches every row it examines | added | acceptance → "ERM-07 sweep, 200 days out: no alert yet, but the row is touched …". The flow asserts this on its own row only. Starvation across 200+ rows is not reproduced on the shared instance. |
| 13 | IC-06: an override with no rationale is refused | added | overrides → "IC-06: an override with no rationale … refused (400 rationale)" |
| 14 | IC-06: an override registers its actor as a system principal | added | overrides → "an operator overrides the velocity control three times … the actor registered as a system principal" |
| 15 | IC-06: an exception cannot be self-approved and must be time-boxed | added | overrides → "IC-06: an exception cannot be self-approved (409) and must be time-boxed (400 expires_at) …" |
| 16 | IC-06: an expired exception REVERTS — the control comes back on | added | overrides → "IC-06: once its expiry passes (clock moved) the exception REVERTS …" |
| 17 | IC-06: an exception inside the warning window is flagged as expiring | added | overrides → "the sweep leaves the 100-day exception alone and flags the 10-day one as EXPIRING …" |
| 18 | IC-06: the analytics NAME the repeatedly-overridden control | added | overrides → "IC-06: the analytics NAME the repeatedly-overridden control …" |

**Counts:** flow 0 · added 18 · contract 0 · drop 0 (total 18).

## Flow steps beyond the unit file (policy checks)

These steps are written to the policy text in `compliance/policies/enterprise-risk-management` and `internal-controls`. Each was red against the core deployed before 2026-10-06; all five are fixed in code and stay red until that fix is deployed:

- **Fixed 2026-10-06 (ERM-07):** `decision_due_at` is now 30 calendar days after the request (was 10). Regression guard: "ERM-07: the decision is due 30 calendar days from the request".
- **Fixed 2026-10-06 (ERM-07):** deciding an acceptance needs the `cco` role (403 `insufficient_role` otherwise). By user decision the CCO decides at every risk level; there is no CRO tier. The decider is recorded from the credential, the typed `decided_by` is kept as `decided_by_label`, and the requesting credential cannot decide its own acceptance. Regression guard: "ERM-07: a staff credential without the CCO role cannot decide an acceptance (403)".
- **Fixed 2026-10-06 (ERM-07):** the 7-day `risk_acceptance.expiry.warning` (and its CCO escalation) fires at 7 days before expiry, stamped once in `expiry_warned_at`, separately from the 30-day alert. Regression guard: "ERM-07: the 7-day expiry warning has NOT fired 20 days out".
- **Fixed 2026-10-06 (ERM-07):** an expired acceptance creates a `risk_breach` row (`risk_acceptance_id`, at most one per acceptance) as well as `risk_breach.opened`. Regression guard: "the expiry date passes …".
- **Fixed 2026-10-06 (IC-06):** a standing exception needs `risk_acceptance_id` (400 if missing, 404 if unknown). Regression guard: "IC-06: a standing exception with no risk acceptance behind it is refused".

These steps pass:

- A partner gets 404 on the register and on overrides.
- An appetite with no `document_ref` or `approved_by` returns 400.
- An observation against an unknown appetite returns 404.
- An invalid decision value returns 400.
- An expired acceptance is not swept again.
- The analytics event carries the frequency by control and by actor.
- Exception registration evidence names its risk acceptance.

Fixture discipline: all ids are run-unique. Clocks are moved only on the flow's own rows. Every risk, appetite, breach, acceptance, override, exception and `core.user` row the flow creates is deleted at flow end, and events stay.

## §46 of `compliance_e2e.sh`

Nothing from §46 belongs here. RS-03, MP-06/07, PR-03/04/15 and CP-05 are already covered in `member_protection.test.ts` and `isolation.test.ts`. DF-05 is lending, which is unrouted.
