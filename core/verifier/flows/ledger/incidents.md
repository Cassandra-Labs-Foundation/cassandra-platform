# Coverage ledger: `core/supabase/functions/api/incidents.test.ts` → incident flows

Every `Deno.test` in the stubbed unit file is listed below with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/incidents.test.ts`. Run them with `scripts/flow.sh -f incidents: --no-deploy`.

Other incident behaviour is already proven by existing flows and is not repeated: the BC-05 IC-assignment clock, comms on the primary/backup channel, media-needs-the-CEO, PIR and corrective actions in `basel.test.ts` ("bcp: sev1 incident → …"); determination → 72h NCUA clock → notification and the undetermined sweep in `deadlines.test.ts`.

Disposition key: `flow` (covered by a flow step), `added` (a step written to close a gap), `contract` (HTTP shape only), `drop` (no user-observable surface).

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | SC-03: declaration sets a recurring sitrep cadence, not just v1 | flow | `incidents: the IC declares a sev1 → …` → "SC-03: a sev1 declaration sets a RECURRING sitrep cadence of 60 minutes alongside the v1 timer" (row `sitrep_cadence_minutes`, the `sitrep.cadence_timer` payload, and `next_due_at` ≈ declaration + 60m) |
| 2 | SC-03: the cadence scales with severity | flow | same flow → "SC-03: the cadence scales with severity — sev1 < sev2 < sev3 < sev4". The unit test compared the exported constants; the flow declares one incident per severity and compares the stored cadences, with sev4 = 480 |
| 3 | EC-13: an assessment with no data scope is refused | flow | `incidents: sev1 data exposure → …` → "EC-13: an assessment with NO DATA SCOPE is refused" (also: `deadlines.test.ts` refuses an assessment with neither) |
| 4 | EC-13: an assessment with no member impact is refused | flow | same flow → "EC-13: an assessment with NO MEMBER IMPACT is refused" |
| 5 | EC-13: a complete assessment records scope, impact and both event names | flow | same flow → "EC-13: the complete assessment records scope, impact and facts, under both event names". `data_scope` and `facts` are TEXT columns on `core.incident`, so the flow parses the stored JSON |
| 6 | EC-13: external comms with no legal review is REFUSED | flow | same flow → "EC-13: external comms with NO legal review is refused (409) — nothing goes out, nothing recorded" |
| 7 | EC-13: external comms with no recorded statement is refused | flow | same flow → "reviewed comms with no recorded statement are refused (400)"; also asserts the refused request records no legal review |
| 8 | EC-13: reviewed comms are recorded with the statement and the reviewer | flow | same flow → "EC-13: reviewed comms go out with the statement verbatim, the reviewer and the plan" |

**Counts:** flow 8 · added 0 · contract 0 · drop 0 (total 8).

## Flow steps beyond the unit file

- A partner gets 403 (`x-actors` gate) on the assessment and external-comms routes, and nothing is recorded.
- Assessment and external comms for an incident nobody declared are 404 with no evidence written.
- An unknown severity (`sev9`) is refused at declaration.
- A follow-up statement after the review goes out without re-naming counsel, and keeps the original reviewer and review time.
- **Fixed 2026-10-06 (regression guard):** every statement that goes out gets its own `incident.external_comms.recorded` event, verbatim (unique id per statement; it used to be a fixed id with `ignoreDuplicates`). The row keeps the latest statement in `comms_holding_statement`. See "BOTH statements that went out are evidenced verbatim".
- Hygiene: the flows delete their incidents at the end, so the undetermined sweep's 200-row window is not filled with test declarations.
