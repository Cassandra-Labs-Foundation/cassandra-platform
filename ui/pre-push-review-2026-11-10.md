# Pre-push review: deployed staff console, 2026-11-10

**Verdict: FAIL** for candidate `67eb39e` (origin/main) as deployed. Coordinator and an independent fresh-context verifier each found the same four Major issues, independently and on the live site.

## What was reviewed and why
- Lorenzo asked for a pre-push review of the core UI. Local `main` had no outgoing commits (0 ahead, 15 behind `origin/main`), so he chose "review the deployed UI": the whole staff console as it runs now.
- Candidate: `67eb39e7a1f8`. The `ui/` tree has not changed since `2645080`.
- Deployment: GitHub deployment 7668844061 (vercel[bot], Production, sha 67eb39e, success 2026-11-09T23:21:50Z). The verifier confirmed that `cassandra-platform.vercel.app` and the deployment URL serve the same Next build id `umKURIvdc_og-UgmxnW0J`.
- Excluded: uncommitted local edits (policy markdown, regenerated manifests, review docs).
- Method: Gstack 1.98.0.0 `qa-only` method read and adapted to the guarded Claude in Chrome browser (Cassandra profile, verified by tab-group probe). Gstack's own browser, deadline and evidence tools were not used. Coordinator and verifier are both Claude Opus 5.5 (same model family).

## Journey ledger (coordinator / verifier)
| Journey | Coordinator | Verifier |
|---|---|---|
| J1 Home and every sidebar route load | PASS (slow, 5–8 s to data) | PASS |
| J2 Member → account agree; back link sensible | PASS, back link always "Back to Teller" | FAIL (Minor) on back link |
| J3 Teller action persists or is labelled simulated | FAIL | FAIL |
| J4 Accounting totals, labels, drilldown dismiss | PASS w/ Minor | FAIL (Escape doesn't close drilldown) |
| J5 Approvals counts agree with records | FAIL | FAIL |
| J6 Flag persists and is visible | persisted; not visible to users | PASS w/ gap |
| J7 Call Report clear stays cleared | FAIL | FAIL |
| J8 Reports Clear survives reload | FAIL | FAIL |
| J9 ~390 px usable and accessible | FAIL (iframe emulation) | FAIL (iframe emulation) |

## Findings (all present in the deployed build before this review; none introduced by an outgoing commit)
1. **Major: Call Report "N keyed · clear" doesn't clear.** The saved draft empties and the counter disappears, but the field still shows the value. Clicking into it and tabbing out saves it again, and it survives reload. Cause: uncontrolled `AmountInput` (`defaultValue` + save on blur, `src/pages/call-report.jsx` ~510–518) plus a `clearAll` that resets only storage/state.
2. **Major: Teller drawer actions look real but are page memory only.** Buy Cash $100 → $5100.00, reload → $5000.00, with no "simulated" label. It sits right beside "New Transaction — read-only". Source: `components/teller/TellerDrawer.jsx` → `SessionContext`.
3. **Major: Approvals counts are capped samples shown as totals.** "Flagged by the gate 100" is 50 per decision × 2. CG-VEL-01 shows "36 flagged" where Reports has ≥358, and RS-05 shows 5 where Reports has 7. The 698 held payments offer no action and say "not resolvable from this UI".
4. **Major: narrow screens and accessibility.** Below 768 px the sidebar is icon-only with no accessible names (`MainLayout.jsx` `hidden md:block` labels). The Reports table is clipped inside an `overflow-hidden` box (~540–583 px table in ~260 px), so Subject/Score/Recorded can't be reached. The 58 Call Report inputs have no label.
5. **Minor-to-Major: "Flag & notify" notifies nobody visibly.** The escalation is written (sim scope, `delivered_at` null) and appears only in BSA-14's event history. The flagged row shows no marker after reload, and the bell says "Nothing to report". Route-to is free text.
6. **Minor: Reports Clear doesn't update the URL.** Reload or a shared link brings the old filter back.
7. **Minor: Accounting.** Two rows are labelled "IRA / KEOGH" (`accounting.jsx:41–42` map `ira` and `keogh` to one label). The drilldown can't be closed with Escape, and its close button is unnamed.
8. **Minor:**
   - Member and account pages always offer "Back to Teller".
   - Member Services briefly shows a false "No members returned" while loading.
   - Admin calls the proxy read-only although a write route exists.
   - "D6 Idempotency Fixture" test members appear on Home.

**Data/product state, not UI defects:**
- All 69 governance obligations are due 2026-01-01, overdue, with no owner.
- The BSA policy is past its 2026-07-01 review date with no overdue marker.
- 114 members share the name "Elena Marsh".

## Test data left behind
Two synthetic escalations in the demo/sim scope, both labelled as tests. The UI has no delete route:
- `esc_6afe7995-4f6b-4e90-b341-5c42ca3611d0` (coordinator, on BSA-06)
- `esc_f19fae3d-3a5a-47cb-b83c-a63917788ebc` (verifier, on BSA-08)

Call Report draft values were removed and confirmed empty after reload. Teller changes reset themselves.

## Limits
- Desktop layout was checked by the coordinator only. The verifier ran at 500 px, and both used an iframe for 390 px rather than a real device.
- Call Report PDF export was not exercised.
- Accounting drilldowns other than Member growth were not opened.

## Evidence
[pre-push-review-evidence-2026-11-10/](pre-push-review-evidence-2026-11-10/) holds the coordinator log, the verifier log and two screenshots.

## What would change the verdict
Fix F1–F4, deploy, then have a fresh verifier replay J3, J5, J7 and J9 plus the adjacent paths. Owners and dates are not assigned yet.
