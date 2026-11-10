# Pre-push review — cassandra-platform staff console (deployed)

Run: 2026-11-10T02:2xZ, Claude Code (claude-opus-5-5), coordinator.
Scope chosen by Lorenzo: "Review deployed UI" (whole staff console as deployed), because local main has no outgoing commits (0 ahead / 15 behind origin/main).

## Identity
- Repo: Cassandra-Labs-Foundation/cassandra-platform. Candidate: origin/main 67eb39e (UI tree unchanged since 2645080).
- Deployment: GitHub deployment 7668844061, creator vercel[bot], env Production, sha 67eb39e, state success, target https://cassandra-platform-26flxu8k0-cassandra-labs.vercel.app, created 2026-11-09T23:21:50Z.
- Alias reviewed: https://cassandra-platform.vercel.app (response age ~10733s at 02:20:43Z => served since ~23:22Z, consistent with that deploy).
- Dirty local files (excluded): compliance policy md edits, regenerated manifests incl. ui/public/compliance-manifest.json, ui/README.md, untracked review docs.
- Gstack 1.98.0.0 at ~/.local/share/gstack (no git rev available). qa-only method read (SKILL.md, sections/exploratory.md, qa/sections/qa-patterns.md).
- Adaptation: guarded browser (Claude in Chrome, Cassandra profile 1454543b verified by tab-group probe). Gstack `aside repl` / deadline / evidence tools NOT used; native mechanical conformance not assessed. Per-probe exploration JSON replaced by this log.

## Charters (written before probing)
| ID | Contract (expected) | Source | Entry | Isolation |
|---|---|---|---|---|
| J1 | Home loads live core data; every sidebar link reaches a working page without error states | UI nav promise | / | read-only |
| J2 | Find a member, open member, open an account; balances/transactions shown consistently | Member Services UI | /member-services | read-only |
| J3 | Teller shows drawer + transactions; date filter and detail work | Teller UI | /teller | read-only |
| J4 | Accounting statements load; drilldown opens matching rows | Accounting UI | /accounting | read-only |
| J5 | Approvals queue items link to compliance dashboard and back | commits f718158/30ebfa7 | /approvals | read-only |
| J6 | Compliance dashboard: policy page renders controls; monitoring trace consistent with Reports | 527fcfe/2645080 | /compliance/dashboard | read-only (flag write: see log) |
| J7 | Call report: enter draft value, clear it, value stays cleared after blur/reload | Call Report UI "Clear" | /call-report | owned draft value, removed after |
| J8 | Reports filter -> Clear -> reload keeps filters cleared | Reports UI | /reports | URL only |
| J9 | 390px viewport: nav usable, Reports table readable | ordinary expectation | /reports | viewport restored after |

## Log
- 02:23Z J1 / : Accounts + Recent Transactions show "Loading…" at 3s, populated by ~8s. 12 checking cards incl. 3 "D6 Idempotency Fixture" (test fixtures on staff home). Export CSV / New Transaction rendered disabled. No console errors.
- 02:24Z J3 /teller: drawer $5000.00 "Last balanced 5/14/2025". Journal "Loading transactions… Showing 0 of the 0" at 6s; rows (Elena Marsh $666.66 …) present at 10s. New Transaction labelled "— read-only" (tooltip: core proxy is read-only).
- 02:27Z J3 Buy Cash 100 -> Confirm: balance shows $5100.00, no notice. Reload -> $5000.00. Replayed twice (same result). Source: components/teller/TellerDrawer.jsx updates SessionContext only (no persistence, no core call). localStorage key callReport.values.v1.inst_local.2026-Q4 = {} (empty, pre-existing).
- 02:30Z J2 /members/ent_2a61…(Elena Marsh): 2 accounts $666.66 + $333.34, one transfer +$666.66 from acct_6515…; /accounts/acct_6515… shows $333.34 and -$666.66 to Elena Marsh: consistent (PASS). Both pages offer only "Back to Teller" even when reached from Member Services.
- 02:31Z J4 /accounting: statements load; liabilities lines sum to $96,645,912.00 = total; footer explains $1,111,000 asset/deposit scope gap. Two separate rows both labelled "IRA / KEOGH · 14 accts · $0.00" (accounting.jsx maps ira and keogh to the same label). Income statement all "—" with explanation.
- 02:32Z J5 /approvals: gate flags 100 = 36+35+20+5+4 (consistent). Held for dual control 698 (200 listed); every held row "wire_transfer id — not resolvable from this UI"; no approve/deny control; footer: approvals are recorded through the core API, not from here. Never assessed 839 (ACH capped at 200).
- 02:33Z /compliance (calendar): 69 obligations, all due Jan 1 2026, all "overdue", owner "—", last completed "never"; Unscheduled 0. UI renders core data faithfully (anchor_date 2026-01-01 never advanced) — data/product state, not a UI bug.
- 02:34Z J6 /compliance/dashboard: coverage 189+123+27=339 consistent. /compliance/dashboard/bsa: policy "next review 2026-07-01" shown without overdue marker. Deployed eCFR link part-748#p-748.2 returns 200.
- 02:26:52Z J6 write: BSA-06 newest event (sar.decision_no_file) -> flag, route "PPR test - ignore", routine, labelled note -> POST /api/compliance/flag 200; UI: "Flagged. Escalation esc_6afe7995-4f6b-4e90-b341-5c42ca3611d0 routed … acknowledgement due 11/14/2026 6:26:51 PM … demo/sim scope". Readback GET /api/core/compliance/dashboard/events?codes=escalation.routed: event present, provenance simulated, src sim, delivered_at null (PERSISTED). After reload: no flagged marker on the event row, escalation not shown anywhere on the page; Notifications bell "Nothing to report". TEST DATA LEFT: esc_6afe7995… (sim scope; no delete route in UI).
- 02:40Z J7 /call-report Financial Condition: 58 inputs have no accessible name (no id/label/aria). Delete-key clearing of AS0004 persists correctly through reload (PASS). "1 keyed · clear" path: AS0004=123.45 -> Tab -> click "1 keyed · clear": keyed count disappears but the field still shows 123.45; click field + Tab (no edit) -> "1 keyed · clear" returns; reload -> AS0004=123.45 (FAIL, replayed from fresh entry). Cleanup: field emptied by delete, reload shows 0 non-empty inputs, no keyed count.
- 02:45Z J5/J8 cross-check: /reports?control_id=RS-05 lists 7 RS-05 block decisions ("7 loaded"); /approvals shows "RS-05 · 5 flagged". Approvals fetches 50 per decision (approvals.jsx FLAG_CAP=50; block 50 + reject 50) and shows "Flagged by the gate 100" as a KPI — the KPI and per-control counts are truncated samples, disclosed only by a general "may be more" note.
- 02:46Z J8 /reports?control_id=RS-05 -> Clear: control input empty, 50 rows, URL still ?control_id=RS-05; reload -> RS-05 restored, 7 rows (FAIL).
- 02:47Z /administrator: Members 3283 / Accounts 4388 / Transfers 1952 / Pending approvals 698 agree with Accounting and Approvals (PASS). 8 proxy endpoints ok (324–1036 ms). Says "every path the read-only proxy allows" although a flag write route exists.
- 02:48Z J9: resize_window had no effect (window stays 1460px). Adapted: same-origin 390px iframe of /reports?control_id=RS-05 (inner width 386): table scrollWidth 540 inside 257px container with overflow-x hidden, so Subject/Score/Recorded columns clipped and unreachable; sidebar collapses to icons and the first 6 links have no accessible name (FAIL). Iframe removed. Emulation, not a real device.

## Coordinator ledger (candidate 67eb39e, prod alias)
| ID | Result | Evidence |
|---|---|---|
| J1 Home + nav | PASS (slow: ~5–8s to data) | log 02:23Z, all 11 routes visited |
| J2 Member→account | PASS (back link always "Back to Teller") | log 02:30Z |
| J3 Teller drawer | FAIL | Buy Cash $5100 then reload $5000, no simulated label |
| J4 Accounting | PASS with Minor (duplicate "IRA / KEOGH" label) | log 02:31Z |
| J5 Approvals counts | FAIL | RS-05 5 vs Reports 7; KPI 100 = 50/decision cap |
| J6 Monitoring + flag | PARTIAL→FAIL on promise | escalation persisted in core, but nothing in UI shows it; bell empty |
| J7 Call Report clear | FAIL | cleared value shown, resurrected on blur, persists on reload |
| J8 Reports clear/reload | FAIL | URL keeps control_id, reload re-filters |
| J9 Narrow screen | FAIL (iframe emulation) | table clipped, icon nav unnamed |

## Coordinator findings (all pre-existing on the deployed build; no outgoing commits)
- F1 Major — Call Report "keyed · clear" leaves values in fields; focus/blur re-saves; persists. Data integrity of a regulatory draft.
- F2 Major — Teller drawer Buy/Sell/Balance look real, are browser-memory only, lost on reload; sits beside a "read-only" banner.
- F3 Major — Approvals KPI/per-control flag counts are truncated samples (50 per decision) shown as totals; contradict Reports.
- F4 Major — "Flag & notify" persists an escalation but nothing in the console shows it afterwards (row, bell, any page); nobody is notified (delivered_at null). Route-to is free text.
- F5 Minor — Reports Clear doesn't update the URL; reload restores old filter.
- F6 Minor — Narrow screens: Reports columns clipped/unreachable; icon-only nav has no accessible names; 58 filing inputs unlabeled.
- F7 Minor — Approvals "Payment Approvals" queue has no actions; 698 rows each "not resolvable from this UI".
- F8 Minor — Accounting shows two rows labelled "IRA / KEOGH"; member/account pages always "Back to Teller"; D6 Idempotency Fixture test members appear on Home; Admin says proxy is read-only.
- Data/product (not UI defects): all 69 governance obligations due 2026-01-01, overdue, unowned; BSA policy past next-review 2026-07-01 without marker.
