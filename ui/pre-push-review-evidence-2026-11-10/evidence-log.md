# PPR independent verifier evidence log (Pynthia staff console)
Started 2026-11-10T02:33:53Z

## Identity
- origin/main = 67eb39e7a1f866ca745443b7e55489c0b18c7830
- GitHub deployment 7668844061 vercel[bot] Production sha 67eb39e7..., status success 2026-11-09T23:21:50Z, env url cassandra-platform-26flxu8k0-cassandra-labs.vercel.app
- curl: production alias and deployment URL both serve Next buildId umKURIvdc_og-UgmxnW0J (same build)

## Browser profile check
- Selected Claude in Chrome 1454543b. Windows: 826 (button "lorenzo (Valyria)", unchanged after probe), 564 (profile picker), 853 (500px wide, profile button hidden in overflow).
- tabs_create_mcp -> tab 639749400. Temporarily resized 853's window to 1100 wide: button reads "Cassandra Labs (Cassandra)" and the window shows a "New Tab" next to other agents' groups ("Gstack UI review", "Core UI pre-push"). Restored 500x844.
- Shared-window caveat: window also shows "ChatGPT started debugging this browser" banner; other agents active on same origin => shared localStorage for call report drafts.

## J1 Home + routes (02:34Z)
- Home loaded in ~4s: 12 account cards (incl. 3x "D6 Idempotency Fixture"), 5 recent transfers. Buttons Export CSV / New Transaction.
- Sidebar at 500px: <a> links contain only SVG + label span with class "hidden md:block" (MainLayout.jsx:344) -> macOS AX tree of window 853 shows AXLink [0,224 63x40] with no title. No title/aria-label. 
- /teller loaded ~7.5s. /member-services first read showed "Members 0 shown / No members returned." then 25 members after ~6s (misleading empty state while loading).

## J2 Member Services (02:35Z)
- Search "Elena Marsh" -> "Search results 114" all named Elena Marsh (synthetic duplicates).
- /members/ent_2a61b9e3-...: 2 accounts acct_d11a20d4 $666.66, acct_65154726 $333.34. "Recent transfers 1": counterparty acct_65154726 +$666.66 "Sign is from this member's side" (transfer is between her own two accounts).
- /accounts/acct_d11a20d4: balance $666.66, transfer +$666.66 from Elena Marsh. /accounts/acct_65154726: $333.34, transfer -$666.66. Balances agree member<->account.
- Back link on member and account pages is static "Back to Teller" -> /teller (members/[id].jsx:150-157), regardless of arrival from Member Services.

## J3 Teller (02:35-02:37Z)
- Drawer $5000.00, last balanced 5/14/2025. Buy Cash $10 -> $5010.00; Balance Drawer -> last balanced 11/9/2026 6:36:14 PM. No toast/status.
- Reload at 02:36:23Z -> $5000.00, last balanced 5/14/2025. No "simulated/local/demo" wording on page (regex false). Source: SessionContext useState(initialTellerDrawer), no persistence.
- Buy modal amount input accessible name is its placeholder "0.00" (label "Amount" not associated).
- Journal filter: Yesterday -> 3 rows all "Yesterday"; Today -> 0 rows.

## J4 Accounting (02:37-02:39Z)
- Liabilities: "IRA / KEOGH · 14 accts · 0.0% $0.00" appears TWICE (source accounting.jsx:41-42 maps both `ira` and `keogh` to 'IRA / KEOGH'). Row accounts 4246+71+29+14+14+14 = 4388 = header total; liabilities 96,638,112+7,800 = 96,645,912 = total L&E (reconciles).
- Assets 95,534,912 vs L&E 96,645,912; page explains $1,111,000 gap as accounts outside this instance.
- Income statement all "—" with explanation.
- Member growth drilldown opens a side panel ("Membership growth" table). Escape: panel stays open (screenshot after Escape). No Escape/keydown handler or role=dialog in accounting.jsx / components/accounting (git grep empty). Close X has no accessible name (find: `button` with empty name) but works by click.

## J5 Approvals (02:39-02:42Z)
- Tiles: Held for dual control 698 (EPS-06), Flagged by the gate 100, Never assessed 839. No <button> elements in main.
- Flag groups: CG-VEL-01 "36 flagged", CG-NSF-01 35, CG-OFAC-01 20, RS-05 5, RS-04 4 (sum 100 = tile). Caveat text: "Showing the most recent 50 per decision. There may be more flags than are listed here." (approvals.jsx FLAG_CAP=50)
- Cross-check: /reports?control_id=CG-VEL-01, clicked Load more until exhausted -> 358 rows, all decision=block ("358 loaded").  => Approvals "36 flagged" and tile "100" are capped sample sizes, not counts.
- Held list: 200 rows shown of "698 pending"; resources "wire_transfer id — not resolvable from this UI"; Requested by tok_demo_bootstrap. No approve/release/reject control and no statement of where/how a held payment is acted on (no 'read-only'/'approve' wording found).

## J6 Monitoring + flag (02:38-02:41Z)
- /compliance/dashboard loaded (9,544 events/7d, 189/339 controls with evidence). /compliance/dashboard/bsa: policy header "next review 2026-07-01" (past due vs today 2026-11-09; no overdue marker).
- Baseline GET /api/core/compliance/dashboard/events?codes=escalation.routed (200) already contained another reviewer's test flag esc_6afe7995 ("PPR test - ignore", BSA-06) -> exposure to other reviewer test data disclosed.
- BSA-08 event history: 50 rows each with trace/flag. Flag form fields labelled (Route to / Severity / Note).
- Submitted ONE flag on ctr.filed ctr_filing:ctr_ent_1_2029-06-03: routed_to "PPR verifier test - ignore", routine, note "Pre-push review verifier test 2026-11-10, synthetic". 02:39:33Z UI: "Flagged. Escalation esc_f19fae3d-3a5a-47cb-b83c-a63917788ebc routed to PPR verifier test - ignore, acknowledgement due 11/14/2026, 6:39:33 PM. escalation.routed emitted · demo/sim scope".
- After reload: proxy readback finds ev_esc_f19fae3d-..._routed, provenance simulated, src sim, control_uid bsa:BSA-08, delivered_at null.
- Visible after reload in BSA-14 (Escalation Pathway) event history (text contains esc_f19fae3d). NOT visible on the flagged BSA-08 row; Notifications bell: "Nothing to report." No UI code other than the confirmation references escalations (git grep).
- BSA-14 text says ack deadline "1 business day of escalation creation"; this routine flag got ack due +5 days (hypothesis: severity-dependent; not verified).

## J7 Call Report (02:40-02:42Z)
- Baseline localStorage callReport.values.v1.inst_local.2026-Q4 = "{}".
- 02:40:48Z typed 123.45 into AS0004 Coin and Currency, Tab -> field 123.45, button "1 keyed · clear", storage {"AS0004":"123.45"}. (730A Total Cash on Hand stayed "—".)
- 02:40:57Z clicked "1 keyed · clear" -> storage {}, keyed button gone, BUT field still displays 123.45.
- 02:41:04Z clicked field, Tab -> storage {"AS0004":"123.45"}, "1 keyed · clear" back.
- 02:41:11Z reload -> field 123.45, "1 keyed · clear", storage has AS0004. => cleared value resurrected and persisted.
- Root cause (source, call-report.jsx:510-518): AmountInput is uncontrolled (defaultValue) + onBlur setValue; clearAll only resets state/storage, DOM keeps old text, next blur re-saves it.
- Inputs have no label/aria-label (inp.labels.length 0).
- Cleanup 02:41:31Z: selected+deleted text, Tab, reload -> field "", storage {}, no keyed button, 0 inputs with values.

## J8 Reports (02:41-02:42Z)
- /reports?control_id=RS-05 -> control input "RS-05", 7 rows all RS-05.
- 02:41:58Z clicked Clear -> input "", 50 rows mixed controls, URL still ?control_id=RS-05.
- 02:42:04Z reload (same URL) -> filter RS-05 re-applied, 7 rows. Source reports.jsx Clear handler only setFilters/load, no router.replace.

## J9 Narrow (02:42-02:43Z)
- Window 500px: sidebar links render icon-only; label span "hidden md:block"; Chrome AX tree (computer-use) shows AXLink with no title; no aria-label/title.
- Same-origin fixed iframe 390x844 of /reports (disclosed emulation): all nav anchor names "" ; table scrollWidth 583 inside DIV.overflow-hidden clientWidth 261; MAIN scrollWidth==clientWidth 311 (no horizontal scroll); header right edges: Event 413, Subject 491, Score 560, Recorded 672 vs viewport 390 -> Subject/Score/Recorded unreachable. Screenshot j9-reports-390-iframe.jpg. Iframe removed afterwards.
- Also clipped at the real 500px window width.

## Other routes (02:43-02:44Z)
- /compliance: 69 obligations, all "Jan 1, 2026 overdue", owner "—", last completed "never", titled "drill: ...".
- /administrator: all 8 proxy endpoints ok; session identity local; pending approvals 698.
- Home: Export CSV and New Transaction disabled ("core proxy is read-only") — contrasts with Teller Buy/Sell which appear to succeed.
- No console errors on Home after tracking began.
- Closed own tab 639749400. Did not touch tab 639749397 or other groups.
## End identity recheck 2026-11-10T02:43:25Z
- origin/main 67eb39e, latest deployment 7668844061 sha 67eb39e, buildId umKURIvdc_og-UgmxnW0J unchanged at 02:43:25Z
