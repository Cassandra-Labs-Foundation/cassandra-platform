# Coverage ledger: `core/supabase/functions/api/ops_security.test.ts` → people and internal-control flows

Every `Deno.test` in the stubbed unit file, and where its behaviour is now proven against the deployed core. Access-lifecycle steps live in `core/verifier/flows/people.test.ts` (`scripts/flow.sh -f people: --no-deploy`); backups, vulnerabilities, AI governance and SIEM live in `core/verifier/flows/internal_controls.test.ts` (`-f internal_controls:`).

Disposition key: `flow` (an existing flow step covers it) · `added` (a step written for this port) · `contract` (already in `core/verifier/contract/`) · `drop` (no user-observable surface, or unproducible on the shared instance).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | IS-06: access cannot be granted to a separated employee | added | `people: HR hires a teller …` → "IS-06: no new access for the separated teller — 409, no grant written"; the 404 half → "IS-06: access for someone HR never declared is 404" |
| 2 | EC-02: a grant carries its quarterly review clock; breakglass is loudly visible | added | same flow → "EC-02: the teller gets console access and a breakglass DB grant …" |
| 3 | EC-02: an attestation over NOTHING attests nothing, and is refused | drop | Needs zero live grants instance-wide. The shared instance holds ~300 (the live tier never deprovisions its grants), and a flow must not deprovision them. The 409 `nothing_to_review` guarantee stays unproven live |
| 4 | EC-02: the review attests every live grant and reviews unreviewed breakglass | added | `people: EC-02 …` → "the review attests every live grant — ours included, the deprovisioned one not — and reviews the breakglass exactly once" |
| 5 | BC-07: a restore test against a FAILED backup tests nothing, and is refused | added | `internal_controls: BC-07 …` → "a restore test against the failed backup is refused …", "a restore test from the completed backup …" |
| 6 | BC-07: a failed backup is remediable only with a stated action | added | same flow → "remediation: a non-failed job has nothing to remediate; a failed one needs a stated action …" |
| 7 | IS-05: remediation before triage is refused — the queue is the control | added | `internal_controls: IS-05 …` → "remediation before triage is refused", "triage needs an outcome; then triaged fix-now and remediated" |
| 8 | IS-13: an unapproved AI tool cannot launch; approval publishes the disclosure | added | `internal_controls: IS-13 …` → "launching before approval is refused …", "the approved tool launches and the member disclosure ships in the same act" |
| 9 | IS-13: a REJECTED tool stays unlaunchable | added | same flow → "a REJECTED tool stays unlaunchable" |
| 10 | IS-14: an alert with no severity is refused — an empty body is not a critical | added | `internal_controls: IS-14 …` → "an alert with no severity, or a typo severity, is refused" |
| 11 | IS-14: a typo severity is refused, not recorded | added | same step |
| 12 | IS-14: only a stated critical raises the critical event | added | same flow → "a low alert is stored with no critical event; a stated critical raises siem.alert_critical" |

**Counts:** flow 0 · added 11 · contract 0 · drop 1 (total 12).

## Flow steps beyond the unit file

- Access deprovisioning on its own (`POST /security/access-grants/{id}/deprovision`): the reason is carried, a second call replays without re-stamping, an unknown grant is 404, and a deprovisioned grant is not attested by the next review.
- A partner is refused (403) on every ops-security route exercised. An unknown backup is 404, a nameless AI tool or a bad decision is 400, and a SIEM disposition needs substance.

## Shared-state note and performance observation

`POST /security/access-reviews` attests every live grant on the instance, by design. The flow's review stamps `reviewed_at` on other flows' and the live tier's grants just as a real quarterly review would, and there is no scoped variant. The handler updates one row per grant, and the live population only grows. With ~300 live grants the call took ~33s, past the shared 30s client timeout in `contract/helpers.ts`. So the flow calls it with a local 120s timeout and logs the duration. This is a judgement call, not a DEFECT: the review completes, but a growing grant population will eventually push it past the edge-function limit, partway through.
