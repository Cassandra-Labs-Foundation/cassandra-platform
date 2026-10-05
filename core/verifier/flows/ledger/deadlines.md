# Coverage ledger: `core/supabase/functions/api/deadlines.test.ts` → deadline flows

`deadlines.ts` has no routes. The unit file pins clocks owned by other modules: incidents, capital, investment, records_admin, cash, retention and lending. The flows in `core/verifier/flows/deadlines.test.ts` exercise each clock through the endpoint that starts it and the sweep or filing that enforces it. Wherever the API allows, the anchor is set far in the past, so a clock anchored on `now` would produce a visibly different date. Run them with `scripts/flow.sh -f deadlines: --no-deploy`.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | ECOA: the notice clock is anchored on COMPLETION of the application | drop | Lending is deliberately unrouted (narrow-bank product decision, see CLAUDE.md), so no API surface reaches `ecoaNoticeDueAt` |
| 2 | CTR: the filing clock is anchored on the BUSINESS DATE of the currency | flow | `deadlines: $12k cash in on an old business date …` → "… due date is pinned to the business date, absolutely" (2019 date, exact ISO), plus "sweep flags it overdue" and "filed: … lateness recorded" |
| 3 | retention: expiry is anchored on the record's own anchor date | flow | same flow → "the CTR's retention clock runs 5 years from its anchor" (`rec_<ctr>_ctr`: expires = anchor + 5 years). The anchor is the report date, which is now, so this step is not an old-date pin |
| 4 | NCUA: the 72h clock runs from the REPORTABILITY DETERMINATION | flow | `deadlines: incident sat since 2020 …` → "Compliance determines reportable: due = determination + 72h, NOT declaration + 72h" (declaration backdated to 2020 on the flow's own row) |
| 5 | NCUA: a NON-reportable determination sets no clock at all | flow | `deadlines: a NON-reportable incident …` → "Legal determines NOT reportable …" + "notifying NCUA now … 409 not_reportable" |
| 6 | NWRP: the 45-day clock runs from the CLASSIFICATION, not the quarter end | flow | `deadlines: an old quarter classified undercapitalized …` → "5% net worth for quarter … plan due 45 days from NOW"; **added** restatement step (DEFECT) |
| 7 | NWRP: a well-capitalized position starts no clock | flow | same flow → "a well-capitalized quarter (10%) starts no clock …" (+ 409 `nwrp_not_required`) |
| 8 | credit file: re-analysis is due a year from APPROVAL | flow | `deadlines: issuer credit file approved …` → "approve the file: re-analysis due exactly 365 days from approval" + re-analysis restarts it |
| 9 | CDD: the refresh clock is anchored on the LAST REFRESH, not on the write | flow | `deadlines: CDD profile last refreshed in 2020 …` → "high risk … due 2021-01-01" (absolute), low = 60 months, refresh → +12 months |

**Counts:** flow 8 · added 0 · contract 0 · drop 1 (total 9).

## Flow steps beyond the unit file

- **Incidents:**
  - Declaring an incident sets a 24h internal determination deadline but starts no NCUA clock.
  - The sweep reports the incident as UNDETERMINED.
  - Ops without a Compliance or Legal role gets 403 `insufficient_role`.
  - A determination without a rationale gets 400.
  - A determination made before the assessment must be a 4xx. **DEFECT:** it returns 500.
  - Re-determining replays and does not re-anchor the clock.
  - An on-time NCUA notice is `late: false`, and the sweep never flags it overdue.
  - Notifying before any determination gets 409 `not_determined`.
- **NWRP:** re-posting the same quarter must not push the deadline out (**DEFECT**). The plan needs a filer, and it is filed before the due date.
- **CTR:** a filing needs a FinCEN reference. A late filing is recorded as late, and once filed the CTR leaves the overdue sweep.
- **Partners:** a partner is refused the incident sweep (403) and the capital positions route (404).
