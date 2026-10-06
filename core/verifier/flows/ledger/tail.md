# Coverage ledger: `core/supabase/functions/api/tail.test.ts` → internal-control and EPS flows

Every `Deno.test` in the stubbed unit file, and where its behaviour is now proven against the deployed core. The IC/IS/CP/DF half lives in `core/verifier/flows/internal_controls.test.ts` (`scripts/flow.sh -f internal_controls: --no-deploy`); the EPS half in `core/verifier/flows/eps_controls.test.ts` (`-f eps_controls:`).

Disposition key: `flow` (an existing flow step covers it) · `added` (a step written for this port) · `contract` (already in `core/verifier/contract/`) · `drop` (no user-observable surface, or unproducible on the shared instance).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | IC-02: the conflicting grant is BLOCKED at grant time, not reviewed later | added | `internal_controls: IC-02 …` → "IC-02: granting Alice payment APPROVAL is blocked at grant time — 409, stored blocked, never granted" |
| 2 | IC-02: the SAME role is clear for a DIFFERENT subject — it is the pair | added | same flow → "the SAME approver role is clear for Bob, who holds no initiator role" |
| 3 | IC-02: a BLOCKED role does not count as held for the next check | added | same flow → "a BLOCKED role does not count as held …" |
| 4 | IC-02: an unavoidable conflict is accepted only WITH a compensating control | added | same flow → "an unavoidable conflict is accepted WITH an approved compensating control — and the acceptance expires in 90 days" |
| 5 | IC-02: a compensating control with no approver does not unblock | added | same flow → "a compensating control with no approver does not unblock: 409, still blocked" |
| 6 | IC-04: age is the control — a fresh variance does not escalate | added | `internal_controls: IC-04 …` → "a one-day-old $12.50 variance is booked but NOT escalated" |
| 7 | IC-04: at the threshold it escalates, and must carry the research | added | same flow → "at 30 days with nothing researched the escalation is refused", "with the research it escalates …" |
| 8 | IS-03: an asset with no named owner is refused | added | `internal_controls: IS-03 …` → "an asset with no named owner, or no valid classification, is refused" |
| 9 | IS-03: an attestation needs the name of whoever made it | added | same flow → "an attestation with no attester is refused", "the owner attests by name …" |
| 10 | IS-10: a case whose required step-up never completed cannot be disposed | added | `internal_controls: IS-10 …` → "disposing a case whose required step-up never completed is refused — 409, no case row" |
| 11 | IS-10: dispositions feed the next ruleset | added | same flow → "the next ruleset version is built from the case register …" (run-unique red-flag type, so `by_type` is exact) |
| 12 | CP-09: executing ahead of the regulator is refused | added | `internal_controls: CP-08/CP-09 …` → "CP-09: executing subordinated debt on a PENDING preapproval is refused" |
| 13 | CP-09: a distribution while distributions are restricted is refused | added | same flow → "CP-09: a distribution while distributions are restricted is refused" (caller-declared restriction); plus "CP-09: the restriction is a FACT of the position …" — **red: DEFECT** |
| 14 | CP-08: the contingency events now carry the action they are about | added | same flow → "CP-08: with preapproval granted and a Board resolution it executes …" |
| 15 | CP-09: an executed action needs the board resolution behind it | added | same flow → "CP-09: an executed action needs the Board resolution behind it" |
| 16 | DF-06: funding over the affiliate limit is refused | added | `internal_controls: DF-06 …` → "funding $200k against $1M capital (2000bp) is over the limit" |
| 17 | DF-06: unscreened is not screened-and-clean | added | same flow → "unscreened is not screened-and-clean …" |
| 18 | DF-06: a limit expressed against capital cannot be checked without capital | added | same flow → "a transaction with an unlisted affiliate is 404; without capital the limit cannot be checked — 400" |
| 19 | DF-06: a within-limit screened transaction funds and archives | added | same flow → "a screened, collateralized $50k credit (500bp) funds, and the file is archived"; plus "a SECOND $60k credit …" — **red: DEFECT** |
| 20 | EPS-01: activation before ERM approval is refused | added | `eps_controls: EPS-01 …` → "activation before ERM approval is refused"; and "a rejected service still cannot activate" |
| 21 | EPS-01: the inherent score lands in the enterprise risk register | added | same flow → "the proposal with an inherent score of 7 is submitted …" |
| 22 | EPS-03: a found deficiency with no rating cannot be prioritised | added | `eps_controls: EPS-03 …` → "a found deficiency with no rating cannot be prioritised" |
| 23 | EPS-03: a found deficiency opens remediation in the same write | added | same flow → "a high deficiency opens remediation due in 30 days …" |
| 24 | EPS-10: no rollback plan, no deployment | added | `eps_controls: EPS-10 …` → "a partner cannot deploy; with no rollback plan there is no deployment" |
| 25 | EPS-10: the emergency path needs MORE, not less | added | same flow → "the emergency path needs MORE …", "an approved emergency deployment records who owned the exception" |
| 26 | EPS-10: shipping with known defects requires a recorded acceptance | added | same flow → same refusal step, then "a planned deployment with an accepted defect …" |
| 27 | EPS-06: an unconfigured IP allowlist is UNKNOWN, and unknown is not permission | added | `eps_controls: EPS-06 …` → "an UNCONFIGURED allowlist is unknown …" |
| 28 | EPS-06: an allowlisted IP with PIN and second approval releases | added | same flow → "an IP off the allowlist is not released; PIN + allowlisted IP + a second approver releases" |
| 29 | EPS-06: an IP off the allowlist does not release | added | same step |
| 30 | EPS-06: a verdict with no individual check results is refused | added | same flow → "ACH control results: a verdict with no individual checks is refused …" |
| 31 | EPS-06: the pass verdict is DERIVED from the individual checks | added | same step (a caller-supplied `passed: true` is ignored) |
| 32 | EPS-06: a limit change approved by its own requester is refused | added | same flow → "a client limit change needs a justification and someone else's approval …" |
| 33 | EPS-06: a positive-pay item carries its decision deadline | added | same flow → "a positive-pay item is presented with a 24-hour decision deadline" |
| 34 | a partner token cannot reach the internal routes | added | the first step of every flow above (partner gets 404 from the self-gate; nothing written). `contract/cross_cutting.test.ts` D5-T2 is written but ignored |

**Counts:** flow 0 · added 34 · contract 0 · drop 0 (total 34).

## Flow steps beyond the unit file

- **DEFECT (CP-09):** `postCapitalAction` takes `distribution_restriction` from the request body and never reads the position. A distribution executed against a real undercapitalized position (whose row says `distribution_restricted: true`) is a 201. See "CP-09: the restriction is a FACT of the position …".
- **DEFECT (DF-06):** each affiliate transaction is checked alone, and rows are keyed `afftx_<affiliate>_<type>`. A second within-limit credit to the same affiliate funds and overwrites the first, so aggregate exposure (500 + 600bp) is never limited and the first funded credit disappears. See "a SECOND $60k credit …".
- **DEFECT (EPS-06):** a wire's originator can name themselves as `second_approval` and the wire releases. See "the originator cannot be their own second approver" (in `eps_controls.test.ts`).
- IC-02 also proves the matrix needs distinct roles and a rationale, the update is an `authority.matrix.updated` event with the version, and a once-blocked grant can later be accepted with a compensating control.
- IC-04: resolution stamps `resolved_at` and emits `recon.item.resolved`. IS-03: an invalid classification is refused. IS-10: a case with no type is refused; disposal emits `sar.filed`. CP-08: a proposal awaiting preapproval is stored, not executed. DF-06: an unlisted affiliate is 404.
- EPS-01: an ERM decision without a named reviewer is refused, and approval + activation records both.

## Judgement calls (not marked DEFECT)

- Several controls trust caller-supplied facts the core could check: IC-04's `age_days`, EPS-06's `ip_allowlist` and `pin_verified`, IC-02's `compensating_approved_by`, EPS-01's `erm_reviewed_by` (which may equal the sponsor), and a capital action's `position_id` (an unknown position is accepted).
- None of the tail routes is gated by duty role: any `cu_admin` or `pynthia_ops` token can execute capital actions, approve SoD exceptions or activate an EPS service. Only partners are refused.
