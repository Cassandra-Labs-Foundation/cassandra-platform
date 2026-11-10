# Making the staff console beautiful: an Impeccable-based plan (2026-11-10)

⚠️ DEGRADED: single-context. Impeccable's critique wants two isolated sub-agents (a design review and a detector pass). Here one session ran both, and that session had already reviewed the console for bugs the night before.

## How Impeccable was used
- **Playbooks.** I read Impeccable's own skill and playbooks (critique, Operate mode, craft floor, typeset, layout, colorize, quieter) from `github.com/pbakaus/impeccable` at commit `ec229b4` (skill v4.8.2, Apache-2.0).
- **Detector.** I ran its detector, `npx impeccable@4.8.0 detect` (a release about two weeks old, with `DO_NOT_TRACK=1`), from a scratch folder. It covered `ui/src` plus eight live pages at 1280px and two at 390px.
- **Nothing installed into the repo.** No hooks, no PRODUCT.md or DESIGN.md, and the project has no `.impeccable/` folder. That is decision 1 below.
- **Mode.** The console is an **Operate** surface. In Impeccable's terms, ambition here shows as precision and restraint, and a category-fluent user should trust the screen at a glance. Its colors, type, density and **one signature move** should still be its own, not the category default.

## What the detector found (deterministic)

| Finding | Count | Where it comes from |
|---|---|---|
| Low-contrast text | 715 | 637 are Tailwind `slate-400` (#90a1b9) on white, 2.6:1. Mostly secondary lines and IDs; 604 on Approvals alone. Placeholders ("—" at 1.4–1.5:1, search at 3.0:1) and `slate-500` on `slate-100` (4.3:1). |
| Tiny text | 22 (Accounting) | `text-[11px]` is used 58 times and `text-[10px]` 4 times in source. |
| Overused or default font | every page | `globals.css` forces `Arial, Helvetica`. The theme points `--font-sans` at a Geist variable that is never loaded. |
| Hydration error | Teller | React #418: the server and client render differ, most likely the locale-formatted "Last balanced" date. A real bug. |
| Em-dash overuse | 404 on Approvals | Mostly "— not resolvable from this UI" repeated on every row. |
| Indigo heading (AI palette tell), line length 92ch, two stragglers, one unbalanced heading | 1 each | Minor. |

The source scan found only the Arial rule. Tailwind utility classes are mostly invisible to it, so the live-page scans are the real signal.

## Critique (Impeccable format)

**Design specificity verdict: category-interchangeable.** Every token is a framework default: Tailwind slate neutrals, one blue accent, Arial, lucide icons, `rounded-md/lg/xl/2xl/full` mixed freely, and a "Dashboard · Welcome back. Here's what's happening today." header over four equal icon tiles. Nothing on screen says *credit union*, *narrow bank*, or *compliance-native core*. That is the most interesting thing about this product, and it is visually silent. The compliance pages are the exception: the heartbeat charts and the control-coverage panel are the closest thing to a point of view the console has.

**Design health score (Nielsen, 0–4)**

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | Data sits behind a centered spinner for 5–8 s. Teller drawer "succeeds" without persisting. A sync/seq indicator exists, but only on some pages. |
| 2 | Match to the real world | 2 | Raw UUIDs (`acct_…`, `tr_…`, `ent_…`) lead rows where names, amounts and dates should. |
| 3 | User control and freedom | 2 | Drilldowns ignore Escape. "Back to Teller" is hard-coded. Clear doesn't clear. |
| 4 | Consistency and standards | 2 | Two visual languages: the banking pages versus the ported compliance dashboard (its own markdown CSS, hex colors). Five radii, three shadow styles. |
| 5 | Error prevention | 1 | A filing draft resurrects cleared values. Simulated cash actions look real. |
| 6 | Recognition over recall | 2 | ID-heavy tables force cross-referencing. Icon-only nav below 768px has no labels. |
| 7 | Flexibility and efficiency | 2 | Global search is good. No keyboard shortcuts and no saved views. |
| 8 | Aesthetic and minimalist design | 2 | Generic tiles, uniform card boxes, walls of low-contrast gray. |
| 9 | Error recovery | 2 | Errors are mostly honest prose, but recovery paths are rare. |
| 10 | Help and documentation | 3 | Inline explanations of why a number is blank or scoped are a real strength. |
| | **Total** | **20/40** | **Acceptable (bottom of the band)** |

**What's working**
- Honest data provenance copy. "Shown, not faked" footers on Accounting, and "the core books no income yet."
- The Compliance Monitoring heartbeat and coverage panel.
- The Accounting statement structure.

**Priority issues**
1. **[P1] No typographic system.** Arial at 11–14px with one weight step, and no tabular numerals for money. → `/impeccable typeset`
2. **[P1] Contrast and gray fatigue.** `slate-400` carries primary information (IDs, dates, subtitles) at 2.6:1 across 700+ instances. → `/impeccable colorize`, then `/impeccable audit`
3. **[P1] Home and Approvals are layout-by-default.** Home shows navigation tiles plus fixture accounts. Approvals shows 698 identical UUID rows with no action. Neither answers "what needs me today?" → `/impeccable layout` + `/impeccable distill`
4. **[P1] Narrow screens break.** Reports columns are clipped, and the icon nav has no accessible names. → `/impeccable adapt`
5. **[P2] States.** Spinners instead of skeletons, a false "No members returned" while loading, a hydration error, and simulated actions with no label. → `/impeccable harden`

**Persona red flags**
- **Jordan (first-timer):** lands on "Welcome back" with four tiles and twelve `$0.00 checking` cards, three of them named "D6 Idempotency Fixture". Can't tell what's real or what to do first.
- **Alex (power user):** must read 36-character IDs to tell rows apart. No shortcuts, no row density control, and Approvals offers no action.
- **Sam (accessibility):** 2.6:1 secondary text, unlabeled filing inputs, an unnamed icon nav, and drilldowns that trap keyboard users.

## The plan

### Phase 0: set up Impeccable properly (½ day, needs your yes)
1. Install it into the repo (`npx impeccable install` or the Claude Code plugin). Turn telemetry off and the design hook on, so the detector runs after every UI edit.
2. `/impeccable init`: write **PRODUCT.md**. Users are credit-union staff (teller, member services, BSA officer, examiner). The product is Pynthia, an NCUA-chartered narrow bank whose core is compliance-native, running on synthetic demo data. The job is to see what needs attention and prove controls work.
3. `/impeccable document`: capture today's system in **DESIGN.md**, then decide refinement versus replacement (decision 2).

### Phase 1: foundation tokens (1–2 days; one change, every page benefits)
- **Type.** Load one product sans through `next/font`; candidates to compare are IBM Plex Sans, Source Sans 3 or Public Sans, which suit an institutional, government-adjacent register. Delete the Arial override and the dead Geist variable. Fixed rem scale at a 1.125–1.2 ratio: 12 / 13 / 14 / 16 / 18 / 22 / 28. **Tabular numerals** on every amount and count. Nothing below 12px. Monospace only for IDs and codes, never as decoration.
- **Color.** Build a token set in `@theme`:
  - a tinted neutral ramp (not pure slate);
  - a second neutral layer for the shell;
  - one committed brand hue for the shell and primary actions;
  - a standardized state vocabulary (critical / warning / ok / info / simulated) used only where it carries meaning.

  Secondary text moves to ≥4.5:1 and placeholders to ≥4.5:1. Retire `indigo`/`purple`/`violet` one-offs.
- **Shape and depth.** Two radii (6px controls, 10px panels), one shadow, one border weight. Fold the compliance dashboard's hex colors and `.dash-md` styles into the same tokens.
- **Dark mode.** Either remove the unused `prefers-color-scheme` variables or do it properly. They currently flip `body` without the components following.

### Phase 2: the signature move (1 day)
Operate mode allows one signature move, and this product already owns it: **the core's heartbeat**. The event sequence, "last event 14h ago", and the per-control pulse charts appear today on only a few pages, in different styles. Make it one shell-level element on every screen: a slim live strip under the header with sequence number, freshness and a tiny event pulse, which turns amber when stale. Reuse the same pulse glyph wherever a control or account shows activity. It makes the console unmistakably *this* product: a bank whose controls you can watch beating.

### Phase 3: page layouts (3–4 days, highest-traffic first)
- **Home → "Needs attention".** Replace the nav tiles and fixture account cards with a ranked work queue:
  - held approvals,
  - gate flags in the last 24h,
  - overdue governance obligations,
  - open escalations (including flags raised from Monitoring),
  - ledger drift.

  Each item links to its page. Keep a compact recent-activity table. Hide fixture or test entities behind a filter. (`layout`, `distill`)
- **Approvals.** Group by control and rail. Lead each row with amount, counterparty and age, and collapse UUIDs into a copyable chip. Counts state their basis ("latest 50 of N"). Make "approve in the core API" an explicit, styled call-out, not a footnote. (`layout`, `clarify`)
- **Tables everywhere** (Reports, Teller journal, member and account pages): one table component with sortable headers, density toggle, sticky header, row hover, horizontal scroll on narrow screens, and skeleton rows. (`extract`, `adapt`)
- **Teller.** Visibly mark the drawer as a local simulation (state color "simulated" plus a label), or remove it until it's real. (`clarify`, `harden`)
- **Compliance pages.** Bring them onto the shared tokens. Keep their charts as the visual anchor of the product.

### Phase 4: harden, adapt, polish (2 days)
- `/impeccable harden`: skeletons, empty states that teach, error states with recovery, the hydration fix, and focus rings themed from the palette.
- `/impeccable adapt`: sidebar becomes a labeled drawer below 768px, tables become horizontal scroll or stacked rows, 44px touch targets.
- `/impeccable clarify`: cut the repeated "— not resolvable from this UI" (404 em-dashes), and give controls verb labels.
- `/impeccable polish`, then `/impeccable audit`.

### How we'll know it worked
- Detector on the same eight pages at 1280px and 390px: low-contrast from 715 to 0, tiny-text from 22 to 0, overused-font from 9 to 0, no script errors.
- `/impeccable critique` score from 20/40 to ≥30/40, run dual-agent this time.
- Live check on the deployed preview at desktop and phone widths, plus an independent verifier, per the pre-push rule.
- Fix the four functional Majors from [pre-push-review-2026-11-10.md](pre-push-review-2026-11-10.md) alongside. Two of them, the Teller simulation label and narrow-screen accessibility, are part of this plan anyway.

## Decisions for Lorenzo
1. **Install Impeccable into the repo?** It adds PRODUCT.md, DESIGN.md and `.impeccable/` config, plus a design hook that runs after UI edits. Telemetry can be off, but starting new-world work still fetches visual directions from impeccable.style.
2. **Refinement or new visual world?** Refinement keeps today's layout and only fixes tokens and type. A new world adds a committed brand palette and the heartbeat signature move. Recommended: the new world, since nothing current is worth preserving except structure and copy.
3. **Brand.** Does Pynthia or Cassandra have a logo, colors or a typeface I should use? If not, I'll propose 2–3 directions as `/impeccable generate` variants for you to choose from.
4. **Dark mode:** in scope or removed?

Raw detector output was kept in the session scratchpad (not committed). Rerun it with `npx impeccable@4.8.0 detect --json <url>`.
