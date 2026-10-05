# Coverage ledger: `core/supabase/functions/api/cash_ops.test.ts` → cash-operations flows

This ledger lists every `Deno.test` in the stubbed unit file and says where the deployed core now proves that behaviour. The flows live in
`core/verifier/flows/cash_ops.test.ts`. Run them with `scripts/flow.sh -f cash_ops: --no-deploy`.

Disposition key:

- `flow`: covered by a step in one of the cash-ops journeys.
- `added`: a flow step written to close a gap the unit file left (listed after the table).
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`. None here.
- `drop`: no user-observable surface, or not producible through the API. None here.

Flow short names used below:

- **vault**: `cash_ops: vault registered → limit schedule governs loads …`
- **overshort**: `cash_ops: a teller's repeated shorts accumulate per custodian …`
- **shipments**: `cash_ops: courier shipments arrive …`
- **count**: `cash_ops: an auditor's surprise count …`
- **deviation**: `cash_ops: a holiday limit deviation …`
- **custody**: `cash_ops: key custody granted to an active employee …`
- **enterprise**: `cash_ops: treasury posts month-end enterprise cash positions …`
- **governance**: `cash_ops: governance cycle …`

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | CP-01: the policy expiry is anchored on ADOPTION, not on the write | flow | governance → "the Board adopts a policy version: expiry anchored on the ADOPTION date …" |
| 2 | CP-04: a FUTURE-dated schedule does not govern today | flow | vault → "the supervisor schedules limits …" + "a permitted load moves the cash against the limit IN FORCE …" (the load row's `limit_cents` is the current 750k, not next year's 2M) |
| 3 | CP-04: a BACKDATED correction wins on effective date, not on being typed second | flow | same two steps (the backdated $100 limit does not govern) |
| 4 | CP-04: an EXPIRED deviation stops governing | flow | same two steps (the lapsed 9M deviation does not govern) |
| 5 | CP-04: the limit is tested against the PROJECTED balance | flow | vault → "the limit is tested against the PROJECTED balance …" |
| 6 | CP-04: NO limit in force blocks | flow | vault → "with NO limit in force a load is blocked …" |
| 7 | CP-04: one person cannot be both counter and custodian | flow | vault → "one person cannot be both counter and custodian; a missing custodian is refused too" |
| 8 | CP-04: a permitted load moves the cash and records dual control | flow | vault → "a permitted load moves the cash …" |
| 9 | CP-03: an unset Board limit reports UNASSESSED | flow | enterprise → "with no Board limit the position is UNASSESSED …" |
| 10 | CP-03: the warning band fires below the limit and does NOT report a breach | flow | enterprise → "240bp against a 300bp limit / 200bp warning band …" |
| 11 | CP-03: a breach notifies treasury and starts the remediation clock | flow | enterprise → "400bp: BREACH …" |
| 12 | CP-03: a remediation is refused while the position is still over the limit | flow | enterprise → "a remediation that is still over the limit (or only a plan) is refused …" |
| 13 | CP-06: a variance parks in GL suspense with an aging clock | flow | vault → "a $50 short day parks in GL suspense with a five-day aging clock …" |
| 14 | CP-06: a balanced day posts NO suspense item | flow | vault → "day-end reconciliation that balances posts NO suspense item" |
| 15 | CP-06: the sweep escalates an aged item and touches every row it examines | flow | vault → "five days pass on the first item only; the sweep escalates it …" (the clock is simulated by backdating this run's own row's `escalate_at`, because the API cannot move time) |
| 16 | CP-06: clearing suspense requires the correcting entry | flow | vault → "clearing suspense requires the correcting GL entry" |
| 17 | CP-07: the CUMULATIVE total crosses the threshold, not any single event | flow | overshort → "two shorts …" + "a third short ($90) takes the CUMULATIVE over the threshold …" |
| 18 | CP-07: the cumulative is PER CUSTODIAN | flow | overshort → "three DIFFERENT tellers at $90 each never aggregate …" |
| 19 | CP-07: an unset threshold reports unassessed | flow | overshort → "with no institutional threshold set the verdict is UNASSESSED …" |
| 20 | CP-08: a seal mismatch declares an INCIDENT and refuses verification | flow | shipments → "a seal that does not match declares a sev2 INCIDENT …" |
| 21 | CP-08: a matching seal verifies and declares no incident | flow | shipments → "a matching seal, counted by two different people, verifies …" |
| 22 | CP-08: verification needs two different people | flow | same step (one person verifying → 400, not verified) |
| 23 | CP-08: CMIR attaches only to a border crossing above $10,000 | flow | shipments → "CMIR attaches only to a border crossing above $10,000" |
| 24 | CP-08: a shipment with no EXPECTED seal is refused at dispatch | flow | shipments → "a shipment with no EXPECTED seal is refused at dispatch" |
| 25 | CP-08: night drop retrieval needs two people | flow | shipments → "night drop retrieval: one person is refused, two people verify the bags" |
| 26 | CP-09: a count with no counter is refused | flow | count → "a completion with no counter is refused …" |
| 27 | CP-09: a count variance opens the same investigation an over/short does | flow | count → "the count comes up $100 short …" |
| 28 | CP-10: an approved deviation needs the Board AND the bond | flow | deviation → "approval without the bond, or without the Board, is refused …" + "a different officer approves with Board + bond …" |
| 29 | CP-10: a deviation-backed limit with no sunset is refused | flow | vault → "the supervisor schedules limits …" (unsunset deviation → 400); deviation → "the branch requests a deviation; one with no sunset is refused" |
| 30 | CP-01/CP-12: the KRI pack is COMPUTED from the registers, not supplied | flow | governance → "the KRI pack is COMPUTED from the whole registers …" (**red: DEFECT, 1000-row cap**) |
| 31 | CP-01: an exception with no rationale or risk acceptance is refused | flow | governance → "an exception with no rationale or risk acceptance is refused …" |
| 32 | CP-09/CP-12: an export with no declared scope is refused; the item count is counted | flow | governance → "an examiner export needs a declared scope …" (**red: DEFECT, 1000-row cap**) |

Counts: 32 `flow`, 0 `contract`, 0 `drop`.

## Added steps (behaviour the unit file never exercised)

- Partner refusal: vault → "a partner cannot register a vault" (404); custody → "a partner cannot touch the custody registry" (403, `x-actors`); governance → "a partner is refused on the governance endpoints" (404).
- CP-05 custody and keybox, the whole of the custody flow: grant clocks of 180 and 90 days, attestation, keybox dual control (no second person, self as second, no reason), the logged access, and separation revoking custody with attest, keybox and re-grant then refused. Two of its steps are red DEFECTs: an unknown `kind` and an unknown second person both return 500.
- CP-07 over/short resolution: research notes are required, an unknown item gets 404, and `resolved_late` is false inside the window. The BSA alert is checked for custodian, open status and triage clock.
- CP-10 maker-checker: the requester decides its own deviation (**red: DEFECT**); a denied deviation writes no schedule; an approved whitelisted deviation lets the previously blocked load through.
- CP-03: remediating a warning (non-breached) position → 409; a plan with no cash figure → 400; `within_deadline` is true.
- CP-09: a count that matches the book opens no investigation.
- CP-01 Board summary is assembled from the registers: exception count, total cash on hand and the latest enterprise position.
- 404 on unknown asset, shipment, surprise count, deviation, over/short and enterprise position.
