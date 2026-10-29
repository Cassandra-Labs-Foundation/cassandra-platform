# Expected answers

For grading only. The blind reader never sees this file. Each answer is taken from the explorer's own sources (`model.json` for the traced control, `system.json` for the inventory); when those change, update the answer here in the same commit. **Correct** needs every point in the answer; **partial** gets the main point but misses or blurs a detail; anything else is **wrong**.

| # | Expected answer | Where the explorer shows it |
|---|---|---|
| 1 | It is blocked: the daily outflow cap (over $25,000 across the four rails, this movement included) stops it, and the large-movement rule is never reached. | Large-movement detection; Payment execution & controls |
| 2 | It passes the daily cap, and because it is over $10,000 it opens an alert for review with a triage deadline. The alert does not stop the transfer. | Large-movement detection |
| 3 | Nothing from this rule: only amounts strictly greater than $10,000 open an alert. Other payment checks still run. | Large-movement detection; the "Movement greater than $10,000?" implementation |
| 4 | Only someone with the BSA Officer role. A decider who opened the case (opened_by matches the deciding token) is refused, even holding both roles. | SAR decision & record |
| 5 | 30 days, or 60 days when the request says there is no suspect; the clock starts when the alert was created. | Alert triage & investigation |
| 6 | core.account, core.bookkeeping_entry, core.control_result, core.event, core.transfer, core.ofac_screen, core.account_freeze and core.institution_freeze. Naming the ones on the diagram and noting there are more counts as correct. | Module transfers.ts |
| 7 | CG-LGTXN-01, CG-STR-01, CG-STR-02, CG-VEL-01 and CG-NSF-01. CG-VEL-01 blocks; CG-NSF-01 rejects a movement the balance cannot cover. | Module transfers.ts |
| 8 | Through a read-only proxy whose allowlist is generated from the spec's UI-surface operations. | Overview; Staff console |
| 9 | In the Blnk ledger. The Blnk webhook and the reconciler mirror changes back into the core. | Overview; Blnk ledger |
| 10 | Yes: green in both the hermetic tier (fake database) and the live tier (the real core). | Control BSA-06 |
| 11 | No. The generated inventory states declared facts and static references; the traced path is a human-reviewed interpretation at one revision. Neither is a compliance verdict. | Overview inspector; "How this map is made" |
| 12 | Any sequence of boxes that the pages show linking each to the next and that ends at "Movement greater than $10,000?". The shortest is Policies & controls → the BSA policy → BSA-06 → Large-movement detection → the rule; going through the Core API, the Payments domain and `transfers.ts` to BSA-06 is equally correct. | Breadcrumbs on the traced views; the module and control diagrams |
