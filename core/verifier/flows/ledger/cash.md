# Coverage ledger: `core/supabase/functions/api/cash.test.ts` → cash flows

Each `Deno.test` in the stubbed unit file is listed below, along with where the deployed core now proves its behaviour. The flows are in
`core/verifier/flows/cash.test.ts`. Run them with `scripts/flow.sh -f cash: --no-deploy`.

Disposition key:

- `flow`: covered by the port of bash §37 ("Cash + CTR (BSA-08)").
- `added`: a flow step written to close a gap that §37 left.
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`. None here.
- `drop`: no user-observable behaviour, or the test cannot be reached through the API.

Flow names below are shortened:
**aggregation** = `cash: one person's currency aggregates across accounts → …`,
**unattributable** = `cash: currency nobody can be attributed to …`,
**overdue** = `cash: a CTR nobody filed is surfaced by the sweep; …`,
**input** = `cash: the teller's input is checked, and a partner cannot reach cash at all`.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | cash-in and cash-out are aggregated SEPARATELY, never summed | flow | aggregation → "cash in and cash out are never summed: Ana's $6k in + $6k out is not $12k" |
| 2 | the threshold is ABOVE $10,000, not at it | added | aggregation → "the line is ABOVE $10,000: Ben at exactly $10,000.00 owes nothing; one cent more does". The cash-out-alone half is covered by "cash out alone can owe one …" |
| 3 | the filing deadline is 15 calendar days from the BUSINESS date | added | aggregation → "… crosses $10k for the person → CTR opened" (today + 15); overdue → first step (a back-dated business day + 15) |
| 4 | unattributable currency is COUNTED, not dropped from the aggregate | flow | unattributable → "aggregation: day INCOMPLETE, residue surfaced, …" (exact $42k residue alongside Carla's $4k) |
| 5 | unattributable rows are NOT each bucketed as their own person | added | unattributable → "three more $9k deposits are NOT each bucketed …" + aggregation step (`people` holds only Carla) |
| 6 | recording currency against an unlinked account warns and raises an alert | flow | unattributable → "$15,000 cash in to it is RECORDED, …" + "evidence: … an unattributable_cash BSA alert names it" |
| 7 | the transaction is still RECORDED even though it cannot be attributed | flow | unattributable → "evidence: the row exists with a NULL entity, …" |
| 8 | a day containing unattributable currency is reported INCOMPLETE | flow | unattributable → "aggregation: day INCOMPLETE, …" (`complete=false`, "lower bound" warning) |
| 9 | a fully attributed day reports complete, with no warning | added | overdue → "a fully attributed day reports COMPLETE with no warning" |
| 10 | crossing the threshold opens a CTR with a 15-day clock | flow | aggregation → "… CTR opened" + "evidence: … BSA-08 trigger + 15-day timer, a BSA alert, the retention clock" |
| 11 | an aggregate that stays under the threshold opens no CTR | flow | aggregation → "$6,000 cash in to Marcus's first account: …" and "the same $6k + $6k split across two DIFFERENT people owes nothing" (no `ctr_filing` row) |
| 12 | the CTR id is deterministic per person per day — a second crossing amends | added | aggregation → "a later deposit the same day AMENDS Marcus's CTR, never duplicates it" (one row, total amended, one trigger event) |
| 13 | filing without a FinCEN reference is refused | flow | aggregation → "filing needs evidence of transmission: …" (400 names `fincen_ref`; the row stays unfiled) |
| 14 | a LATE filing succeeds but is recorded as late | added | overdue → "the officer files it late: …" (`filed_late`, `ctr.filed` payload `late=true`) |
| 15 | re-filing replays rather than filing twice | added | aggregation → "re-filing replays: same filed_at, no second ctr.filed" |
| 16 | the sweep surfaces a CTR that was owed and nobody filed | flow | overdue → "the sweep surfaces the owed-and-unfiled CTR as ctr.filing.overdue". It uses a back-dated business day instead of §37's direct SQL insert |
| 17 | the sweep also reports unattributable currency as a standing gap | flow | unattributable → "the CTR sweep reports unattributable currency as a standing gap" |
| 18 | breach event ids are deterministic — repeated sweeps do not pile up | added | overdue → "a second sweep does not pile up a second breach event" (+ id `evt_<ctr>_overdue`) |
| 19 | business_date is required and must be a date, not a timestamp | added | input → "business_date is required and must be a date, not a timestamp" (all four bad values; nothing recorded) |
| 20 | currency with neither an account nor an entity is refused | added | input → "currency with neither an account nor a person is refused" |
| 21 | a partner cannot reach cash at all | added | input → "a partner is refused on every cash route by the actor gate, …". Live, this is **403 insufficient_scope** from the route's `x-actors` gate (auth.ts), not the handler's 404, because the router refuses before `requireCashActor` runs. Nothing is written |
| 22 | multi-day structuring history lives in sim — it cannot be waited out | drop | No API route calls the cash handlers with `scope="sim"`. Only the drill harness does (`drill/cases.ts`, `drill/firers.ts`) |
| 23 | the core path never writes into sim | added | input → "the teller's valid deposit lands as demo evidence in core — no simulated cash in core" (row in `core`, provenance `demo`, zero `simulated` rows) |

**Counts:** flow 10 · added 12 · contract 0 · drop 1 (total 23).

## Flow steps beyond the unit file

- **Per-person aggregation across accounts:** $6k + $6k into two different accounts held by the same person owes a CTR. The same amounts held by two different people do not.
- **Explicit `entity_id` with no account** attributes the cash directly to that person.
- **Cash-out alone can cross the threshold.** A CTR opens with `cash_out_total` while `cash_in_total` is carried separately.
- **Evidence written when a CTR opens:**
  - a `ctr_currency_threshold` `bsa_alert`
  - the 5-year `record` retention clock (`rec_<ctr>_ctr`)
  - `ctr_filing.provenance = demo` for test actors
- **Filing:**
  - Filing an unknown CTR returns 404.
  - A re-file keeps the original `fincen_ref`.
  - A filed CTR drops out of the overdue sweep.
- **Validation:** a bad `direction`, a zero, negative or fractional amount, an unknown account (404) and an aggregation with no date are each refused.
- **DEFECT (red):** cash recorded against an unknown `entity_id` returns 500. Expected: 404 or 400. See input → "an unknown person is refused as a client error, not a 500".
- **No `control_result` is asserted.** The cash path writes none: `CG-CTR-01` was renamed `CG-LGTXN-01` (OQ-01) and names the electronic monitor. The crosswalk calls the cash control `CG-CASH-01`, and its evidence is the `ctr_filing` row, the events and the alert.
