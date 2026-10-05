# Coverage ledger: `core/supabase/functions/api/bsa_program.test.ts` → BSA programme flows

Every `Deno.test` in the stubbed unit file is listed below, along with where its behaviour is now proven against the deployed core. Flows live in
`core/verifier/flows/bsa_program.test.ts`. Run them with `scripts/flow.sh -f bsa_program: --no-deploy`.

Disposition key:

- `flow`: covered by a step in a whole-journey flow.
- `added`: (none here; every unit test mapped onto a journey step).
- `contract`: an HTTP shape check that belongs in `core/verifier/contract/`. None apply.
- `drop`: no user-observable behaviour.

| # | Unit test | Disposition | Where |
|---|---|---|---|
| 1 | BSA-05: the screen is a STUB and every row says so — list_version is null | flow | `bsa_program: a member is re-screened and hits …` → "a clean re-screen leaves evidence …" (row and `ofac.cleared` payload both carry a null list_version); also the CIP flow's "CIP's OFAC screen ran …" step and the annual report step. The `ofacMatch` regex is exercised by every SDN fixture. |
| 2 | BSA-05: a CLEAN screen leaves evidence — screened-and-clear is not never-screened | flow | same step: `ofac.screened` + `ofac.cleared`, `hold_placed_at` null |
| 3 | BSA-05: a match places a HOLD and refuses; a hold is a block, not a note | flow | `bsa_program: a member is re-screened and hits …` → "a list update makes the member a potential match: 409, HOLD placed, escalated, alert opened", and "while held, the member's money does not move" (DEFECT: the hold does not block anything) |
| 4 | BSA-05: releasing a hold needs a named releaser AND a determination | flow | `bsa_program: an applicant hits OFAC at CIP …` → "a release with no determination is refused and the hold stays" and "the officer releases with a documented false-positive determination". The same flow adds partner 404, role-less staff 403 (DEFECT) and unknown-screen 404. |
| 5 | BSA-03: CIP missing ONE of four elements is DENIED, not partially complete | flow | `bsa_program: CIP — …` → "missing ONE of the four elements is DENIED …" (event names the missing element; no verification row, no CDD) |
| 6 | BSA-03: a complete CIP opens the CDD profile in the same act | flow | same flow → "a complete CIP verifies, stores the elements on the member, and opens CDD in the same act" |
| 7 | BSA-03: an OFAC hit at CIP denies the verification | flow | `bsa_program: an applicant hits OFAC at CIP …` → "CIP with all four elements is still DENIED by the OFAC hit …", then "the hit is escalated …" (DEFECT: no alert) |
| 8 | BSA-17: a senior-approval category cannot be completed without sign-off | flow | `bsa_program: EDD for high-risk relationships …` → "a correspondent EDD needs senior sign-off …"; the PEP flow's "the analyst cannot close a PEP EDD without senior sign-off" and "the analyst cannot supply the sign-off by typing a name" (DEFECT) |
| 9 | BSA-17: an ordinary category needs no sign-off | flow | `bsa_program: EDD for high-risk relationships …` → "the analyst opens EDD on the MSB …" and "the analyst completes the MSB EDD on findings alone" |
| 10 | BSA-17: EDD completed with no findings is refused | flow | `bsa_program: a PEP hit opens senior-approval EDD …` → "completing with no findings is refused" |
| 11 | BSA-18: a PEP hit OPENS the EDD in the same act; a clean screen does not | flow | same flow → "a clean PEP screen is evidenced and opens no EDD" and "a foreign-official hit opens the EDD — 30-day clock, senior approval required" |
| 12 | BSA-09: the log band is $3,000 to $10,000 — below and above are different | flow | `bsa_program: a teller sells cashier's checks …` → "a $500 money order …" and "a $10,000 bank draft goes to the CTR band instead of the log" |
| 13 | BSA-09: in the band with no identification is REFUSED | flow | same flow → "$5,000 with no identification is REFUSED and leaves no instrument" |
| 14 | BSA-09: in the band WITH identification logs and screens the purchaser | flow | same flow → "$5,000 with identification is logged centrally and the purchaser is screened"; plus "an in-band purchaser who hits OFAC does not walk out with the instrument" (DEFECT) |
| 15 | BSA-10: a wire at the threshold with NO originator record is refused | flow | `bsa_program: a $5,000 wire carries its Travel Rule record …` → "a record with no originator is refused and the gap is logged" (against a real prepared wire) |
| 16 | BSA-10: below the threshold nothing attaches | flow | same flow → "below $3,000 the rule does not attach; no wire_ref is 400"; and "the threshold is the WIRE's amount …" (DEFECT) |
| 17 | BSA-10: a complete record is RETAINED AS A ROW, not just an event | flow | same flow → "the complete record is RETAINED AS A ROW tied to the wire" |
| 18 | BSA-13: the threshold is on the AGGREGATE, not on any single account | flow | `bsa_program: FBAR — …` → "the determination is on the AGGREGATE: $13,000 is reportable, due April 15 next year" |
| 19 | BSA-13: a NIL year records the determination | flow | same flow → "a year with no foreign accounts records a NIL determination, not silence" |
| 20 | BSA-13: filing without an E-Filing reference is refused | flow | same flow → "filing without the BSA E-Filing reference is refused; with it, filed" |
| 21 | BSA-11: a 314(a) response requires a match count INCLUDING zero | flow | `bsa_program: a 314(a) request …` → "a response with no match count is refused …" and "searched, zero matches, answered on time" |
| 22 | BSA-11: a late 314(a) response is recorded as late | flow | same flow → "a request received 20 days ago and answered today is recorded LATE" |
| 23 | BSA-19: an assessed change creates a RETENTION RECORD of the assessment | flow | `bsa_program: a GTO is assessed not-applicable …` → "a FinCEN GTO is logged and assessed in one act: retention record + implemented" |
| 24 | BSA-19: an UNASSESSED change is identified but not implemented | flow | same flow → "an advisory with no assessment is identified, on a 30-day clock, NOT implemented", then assessed later |
| 25 | BSA-14: severity sets the acknowledgement window | flow | `bsa_program: an OFAC alert is escalated urgent …` → "operations routes it … URGENT (1 day) … ROUTINE (3 days)" |
| 26 | BSA-14: closing publishes an ACTION PLAN, not just a disposition | flow | same flow → "the officer acknowledges the urgent one and closes it with an ACTION PLAN" |
| 27 | BSA-07: a disclosure request is DECLINED and the refusal is the evidence | flow | `bsa_program: an OFAC alert becomes a case …` → "the subject's attorney asks whether a SAR exists: logged and DECLINED" (on a real case opened by triage) |
| 28 | BSA-07: a continuing SAR filing needs its FinCEN reference | flow | same flow → "a continuing-activity filing needs its FinCEN reference"; plus "SAR lifecycle on a case that does not exist is 404" (DEFECT) |

**Counts:** flow 28 · added 0 · contract 0 · drop 0 (total 28).

## Flow steps beyond the unit file

These handlers or behaviours had no unit test:

- **CMIR (BSA-12):** a cross-border inbound shipment over $10,000 identifies a `cmir_filing` on receipt (`POST /cash-ops/shipments`). Filing it needs a FinCEN reference; it is then filed on time with `cmir.filing.timer` and `cmir.filed`. The partner gets 404 and an unknown CMIR gets 404.
- **CTR exemption annual review (BSA-08):** `ctr.exemption.reviewed` is recorded on the member with the decision, the reviewer and the eligibility re-verification. A missing reviewer is a 400.
- **OFAC annual report (BSA-05):** `filed_by` is required, and the report records a null `list_version`. Its counts must be scoped to the reporting year (DEFECT).
- **SAR timers (BSA-07):** the 30-day filing timer and 120-day continuing timer run on a real case.
- **Actor gating:** every flow checks that a partner token gets 404 on the internal `/bsa/*` route it exercises. OFAC release and senior EDD sign-off must refuse staff without the officer role (DEFECT).
- **CIP data integrity:** a denied CIP must not null the member's existing DOB (DEFECT).
- **Validation 400s and unknown-id 404s** for every handler that has them.


Retired 2026-10-05 (rows 15, 16, 17, 27, 28): the stub cases passed fabricated wire/case ids, which the handler now correctly refuses with 404. Their behaviour is covered by the flow steps named above, against real wires and cases.
