---
name: Cassandra staff console
description: The category-standard fintech console, at Mercury and Stripe Dashboard craft, for the people who run and examine Pynthia Credit Union
colors:
  accent: "#1f5eff"
  accent-deep: "#1749d6"
  ink: "#0b1f3a"
  ink-muted: "#4a5870"
  ink-soft: "#56637a"
  canvas: "#edf1f6"
  surface: "#ffffff"
  line: "#e6ebf2"
  search-well: "#f1f4f8"
  rail: "#0d2342"
  rail-deep: "#0a1c36"
  rail-text: "#c9d5e6"
  rail-muted: "#8ea2c0"
  rail-subtext: "#a9b8cf"
  live: "#12b76a"
  silent: "#f79009"
  never: "#b8c2d1"
  sim: "#8a96ab"
  ok-wash: "#dcfae6"
  ok-ink: "#067647"
  warn-wash: "#fef0c7"
  warn-ink: "#93370d"
  attention-wash: "#fff8ec"
  attention-line: "#f6dfb4"
  bad-wash: "#fee4e2"
  bad-ink: "#b42318"
  error-wash: "#fef3f2"
  error-ink: "#912018"
  alert-dot: "#d92d20"
  demo-text: "#fcd9a6"
typography:
  display:
    fontFamily: "Source Sans 3, ui-sans-serif, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.025em"
    fontFeature: "tnum"
  headline:
    fontFamily: "Source Sans 3, ui-sans-serif, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Source Sans 3, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.375
  body:
    fontFamily: "Source Sans 3, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.43
    fontFeature: "tnum"
  body-small:
    fontFamily: "Source Sans 3, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  label:
    fontFamily: "Source Sans 3, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.45
  caption:
    fontFamily: "Source Sans 3, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.33
  code:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.45
rounded:
  xs: "2px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  gutter: "28px"
components:
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "16px"
  button-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "6px 12px"
  button-chip-accent:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.accent}"
    rounded: "{rounded.xl}"
    padding: "10px 16px"
  input-search:
    backgroundColor: "{colors.search-well}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "8px 16px 8px 40px"
    typography: "{typography.body}"
  nav-item:
    textColor: "{colors.rail-text}"
    rounded: "{rounded.lg}"
    padding: "7px 10px"
    typography: "{typography.body}"
  nav-item-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "7px 10px"
  pill-ok:
    backgroundColor: "{colors.ok-wash}"
    textColor: "{colors.ok-ink}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
    typography: "{typography.caption}"
  pill-warn:
    backgroundColor: "{colors.warn-wash}"
    textColor: "{colors.warn-ink}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
    typography: "{typography.caption}"
  pill-bad:
    backgroundColor: "{colors.bad-wash}"
    textColor: "{colors.bad-ink}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
    typography: "{typography.caption}"
  pill-neutral:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
    typography: "{typography.caption}"
  live-badge:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.full}"
    padding: "4px 12px"
    typography: "{typography.caption}"
  attention-banner:
    backgroundColor: "{colors.attention-wash}"
    textColor: "{colors.warn-ink}"
    rounded: "{rounded.xl}"
    padding: "12px 16px"
    typography: "{typography.body}"
  demo-badge:
    textColor: "{colors.demo-text}"
    rounded: "{rounded.lg}"
    padding: "8px 10px"
    typography: "{typography.caption}"
---

<!-- Recorded 2026-11-10 in scan mode from the shipped build (ui/src/styles/globals.css, _app.jsx, MainLayout.jsx, compliance/dashboard/index.jsx, live/Live.jsx, compliance/atoms.jsx) and the review rasters in .impeccable/review/. Merged over the 2026-11-10 baseline record at the user's choice; the old look is summarized under "Previous baseline" in the Overview. -->

# Design System: Cassandra staff console

## Overview

**Creative North Star: "The Category Standard, at Full Craft"**

The console is a conventional fintech dashboard executed carefully: a deep navy rail on the left, a cool grey-blue canvas, and white cards that float on soft, navy-tinted shadows instead of sitting inside borders. One saturated blue means "act here", "you are here" and "this is production evidence". Green, amber and grey mean live, silent and never fired, and they mean nothing else. The quality bar is Mercury for restraint and Stripe Dashboard for dense financial data and status vocabulary. It must never read as a legacy core (dense grey screens, tiny type) or as a compliance binder.

Density is medium. Figures lead, set large and bold with tabular numerals; every figure carries a plain-language line underneath that says what it counts and where it came from. Honesty is part of the look: simulated drills are drawn in their own grey and counted separately, the demo core is badged in the rail on every page, and a heartbeat that has stopped says "idle" instead of pulsing.

**Scope of this record.** The system is implemented on the application shell (rail, header, search, bell, page title; every page inherits it) and on the Compliance Monitoring overview (`/compliance/dashboard`). The policy and control detail pages, the shared compliance atoms (`Panel`, badges, tables) and the inner panels of the other pages still carry the previous slate styling and are pending migration. New work follows this document, not those panels.

**Previous baseline ("The Default Back Office", recorded earlier on 2026-11-10).** Before this build the console was stock Tailwind v4: Arial forced in globals.css, slate neutrals (canvas #f8fafc, ink #1d293d, a #90a1b9 grey that failed contrast), a white sidebar with "Ledger Blue" (#155dfc) active text on a pale wash, flat white panels separated by 1px #e2e8f0 hairlines, radii drifting between 6, 8, 12 and 16px, and 10–11px uppercase labels in about 60 places. What changed: Source Sans 3 and JetBrains Mono replace Arial and the system mono; a navy rail with grouped navigation and a raised white active chip replaces the white sidebar; shadow elevation replaces hairline borders as the container edge; the accent moves to #1f5eff; the neutral ramp becomes navy-tinted and every reading grey passes AA; the live/silent/never palette and the production/drill split become first-class tokens; the dark-mode variables that flipped the body without the components were removed (light only).

**Key Characteristics:**
- Navy rail, cool canvas, white cards: three planes, always in that order.
- Containers are lifted by layered navy-tinted shadows, never outlined.
- One accent hue for action, selection, links and production evidence.
- Live / silent / never in green / amber / grey; simulated drills in their own grey.
- Source Sans 3 with tabular figures; JetBrains Mono only for event codes and IDs.
- Nothing below 12px; secondary text at 13px, not smaller.
- Demo data, drills and stale feeds are labeled where they appear.

## Colors

A navy-tinted neutral family with one saturated blue, plus a fixed evidence vocabulary of green, amber and two greys; state colors only appear as pale wash plus dark ink pairs.

### Primary
- **Signal Blue** (#1f5eff): links and text actions ("Open control", "Show all", "Clear all"), the active nav icon, focus outlines, the caret, the text selection tint (at 18%), and production evidence in charts and event dots.
- **Signal Blue Deep** (#1749d6): pressed/hover depth for blue fills and inline code text in rendered policy markdown.

### Neutral
- **Harbor Navy Ink** (#0b1f3a): all primary text and headings; the base of every shadow tint.
- **Slate Navy** (#4a5870): secondary text, KPI captions, card metadata (7.0:1 on white).
- **Soft Slate Navy** (#56637a): tertiary text, timestamps, legends, footnotes, search icon and placeholder (5.9:1 on white).
- **Cool Canvas** (#edf1f6): the page ground behind cards, track fill for bars, the neutral pill, skeleton blocks.
- **Paper White** (#ffffff): cards, popovers, the header (at 85%), the active nav chip.
- **Frost Line** (#e6ebf2): dividers inside cards and lists, and the header's bottom edge. Never a container outline.
- **Search Well** (#f1f4f8): the header search field, with an inset shadow.
- **Night Rail** (#0d2342) fading to **Rail Deep** (#0a1c36): the shell rail, a top-to-bottom gradient.
- **Rail Text** (#c9d5e6), **Rail Muted** (#8ea2c0), **Rail Subtext** (#a9b8cf): nav labels, nav group headings and inactive icons, and second lines on the institution and user cards.

### Evidence
- **Live Green** (#12b76a): controls with evidence in the window; the pulsing heartbeat dot.
- **Silent Amber** (#f79009): controls with history but nothing this window; the demo badge dot and tint.
- **Never Grey** (#b8c2d1): controls that have never fired; the idle heartbeat dot; scrollbar thumb.
- **Drill Grey** (#8a96ab): simulated-drill evidence in charts and event dots.

### State
- **OK** (wash #dcfae6, ink #067647): "Healthy" pills and live heartbeat text.
- **Warning** (wash #fef0c7, ink #93370d): "Gaps" pills, the busiest-moment marker, undelivered-event and read-cap notes.
- **Attention** (wash #fff8ec, ring #f6dfb4, text in the warning ink family): the attention banner.
- **Bad** (wash #fee4e2, ink #b42318): "No evidence" and "Mostly silent" pills, inline load errors.
- **Error** (wash #fef3f2, ink #912018): full-width "could not load" alerts.
- **Alert Dot** (#d92d20): the unread dot on the bell, shown only when something is unread.
- **Demo Text** (#fcd9a6): the demo-core badge text on the rail.

### Named Rules
**The One Accent Rule.** Signal Blue is the only hue that means act here, you are here, or production. Evidence and state colors never decorate.

**The Drill Is Grey Rule.** Simulated-drill evidence is always Drill Grey and always counted separately from production ("9,543 production · 2 simulated drills"). A drill is never drawn in the accent and never folded silently into a total.

**The Readable Grey Rule.** Text a user must read is Soft Slate Navy (#56637a) or darker on light grounds. Never Grey and Drill Grey are for marks, bars and dots, not words.

## Typography

**Display / Body Font:** Source Sans 3 (self-hosted by next/font; falls back to ui-sans-serif, system-ui)
**Mono Font:** JetBrains Mono (falls back to ui-monospace, SFMono-Regular, Menlo)

**Character:** a sturdy humanist sans that stays legible at 12–13px and holds bold figures well, paired with a mono that is reserved for machine strings. Hierarchy comes from size and weight steps (400 / 600 / 700), never from uppercase tracking.

### Hierarchy
- **Display** (700, 30px, 1.25, -0.025em): the headline figure on a KPI card.
- **Headline** (700, 26px, 1.25, -0.025em): the page title in the shell, one per page.
- **Title** (600, 15px, 1.375): card and panel headings (policy names, "Latest events"). The brand wordmark is a one-off at 17px bold.
- **Body** (400, 14px, 1.43): search, banners, notifications, page subtitles.
- **Body Small** (400, 13px): the secondary line under every figure, card metadata, legends with counts.
- **Label** (600, 13px): KPI card labels in sentence case ("Events in window"), chip buttons at 14px.
- **Caption** (400–600, 12px): pills, timestamps, footnotes, nav group headings, the heartbeat. This is the floor.
- **Code** (500, 13px mono; 12px in secondary positions): event codes such as `escalation.routed`, control and member IDs.

### Named Rules
**The Twelve-Pixel Floor Rule.** No text below 12px. Secondary information steps down to 13px or 12px, never to 10 or 11.

**The Tabular Figures Rule.** `font-variant-numeric: tabular-nums` is set on the body, so every count, amount and percentage aligns in columns without per-element opt-in.

**The Mono Means Machine Rule.** JetBrains Mono is used only for strings a machine emitted (event codes, IDs). Names, labels and numbers stay in Source Sans 3.

## Layout

A fixed shell. The rail is 248px wide at 768px and up, with a Cassandra mark, an institution card, navigation grouped as Operations / Compliance / Reporting, the demo badge, Admin, and the user footer; below 768px it becomes a 64px icon rail with dividers between groups and a compact "Demo" badge. The header is 56px tall, white at 85% with a 1px Frost Line bottom edge, holding the member search (max 448px), the page's heartbeat pill and the bell. The main area scrolls on Cool Canvas with 28px side gutters and 24px top padding (16px and 20px on mobile). Each page opens with the headline and a one-line subtitle, actions aligned right.

The Monitoring overview uses a main column plus a 360px right column (latest events) from 1280px, the right column sticky at 16px from the top; below 1280px the columns stack. KPI cards sit in a 1.35 : 1 : 1 row from 768px. Policy cards run 1 column, 2 from 640px, 3 from 1280px; below 1280px only the first six show, with a full-width "Show all" button. Between 1024px and 1280px the header heartbeat switches to its compact form.

Spacing runs on the 4px step: 16px card padding and card gaps, 20px between the main and right columns and under the title block, 12px between rows inside cards, 8–10px between a figure and its supporting line. Text blocks in banners cap at 75ch.

## Elevation & Depth

Depth is the container edge. Three planes stack in a fixed order: the navy rail (lifted off the page by a soft shadow to its right), the cool canvas, and white cards above it. Cards have no borders; a 1px navy ring at 5% opacity is built into the shadow so the edge holds on the pale canvas. Hover lifts a card from e1 to e2. Inside cards, 1px Frost Line dividers separate rows; that is the only place lines appear.

### Shadow Vocabulary
- **e1, resting card** (`box-shadow: 0 0 0 1px rgb(11 31 58 / 0.05), 0 1px 2px rgb(11 31 58 / 0.06), 0 4px 12px -2px rgb(11 31 58 / 0.08)`): every card, chip button, heartbeat pill and the events column.
- **e2, raised** (`box-shadow: 0 0 0 1px rgb(11 31 58 / 0.05), 0 2px 4px rgb(11 31 58 / 0.06), 0 14px 28px -8px rgb(11 31 58 / 0.22)`): hovered cards and chip buttons, the search results and notifications popovers.
- **chip, active nav** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.3), 0 6px 14px -4px rgb(0 0 0 / 0.5)`): the white active nav item sitting on the dark rail.
- **Wells and tracks** (inset `0 1px 2px` at 8–15% navy): the search field and the coverage bar track are pressed in, not raised.
- **Tinted rings for state surfaces**: the attention banner and error alert use a 1px ring in their own wash family instead of e1.

### Named Rules
**The Shadow Is the Edge Rule.** A container is separated from the canvas by e1, never by a border. Hairlines live only inside a container, between its rows.

**The Navy Shadow Rule.** Shadows on light grounds are tinted with Harbor Navy Ink (rgb 11 31 58), not black. Only the active nav chip, which sits on the dark rail, uses a black shadow.

## Shapes

Generously rounded rectangles with one dominant radius. Cards, chip buttons, banners, alerts and the notifications popover use 12px. Nav items, the search field, the search results popover and the demo badge use 8px. The institution mark uses 6px. Pills, the heartbeat pill, coverage bars, status dots and the avatar are fully round. Legend swatches are 2px squares; skeleton bars and inline code use 4px. There is no decorative geometry; the only custom mark is the Cassandra logo, a ring with one accent quarter on a white tile.

## Components

### Buttons
Tactile and quiet: the new system has no filled buttons yet, because the Monitoring surface has no write action.
- **Chip button:** a white card-styled link or button (e1, 12px radius, 6px × 12px, 14px semibold Harbor Navy Ink) for page-level actions such as "Obligations" and "Control results". Hover raises it to e2 with a shadow transition.
- **Accent chip button:** the same body with Signal Blue text, full width, for "Show all N policies".
- **Text action:** 12px semibold Signal Blue, underline on hover ("Open control", "Clear all").
- **Focus:** a global 2px Signal Blue outline at 2px offset on every focusable element.
- A filled primary button is not yet established in this system; the slate-era pages still use the old #155dfc fill.

### Status pills
- **Style:** fully round, 12px semibold, 2px × 8px, wash plus ink of one hue: Healthy (OK), Gaps (Warning), No evidence / Mostly silent (Bad), No controls (Canvas with Slate Navy).
- **State:** static labels computed from data; not interactive.

### Cards / Containers
- **Corner Style:** 12px.
- **Background:** Paper White on Cool Canvas.
- **Shadow Strategy:** e1 at rest, e2 on hover for linked cards (with a 2px lift where motion is allowed, 200ms).
- **Border:** none; Frost Line dividers only between internal rows.
- **Internal Padding:** 16px; list panels run rows edge to edge at 16px × 12px.

### KPI card (signature)
A 13px semibold Slate Navy label, a 30px bold figure, a 13px line that says what the figure is made of, then one visual: a stacked area of production (Signal Blue line, 16% fill) under drills (Drill Grey, 28% fill) with a dashed amber marker and label at the busiest moment; or a 10px live / silent / never bar on a pressed Canvas track; or a short list of reconciliation codes. Legends sit below in 12px.

### Policy card
Title (15px semibold, two lines max) with a status pill top right, a 6px live / silent / never bar, a 13px count line ("2 live · 12 silent · 1 never · 15 controls"), and a divided footer with the window's event count right-aligned in bold. Sorted attention-first.

### Inputs / Fields
- **Search:** Search Well fill, inset shadow, 8px radius, 40px left padding for an 18px search icon, 14px text, Soft Slate Navy placeholder. Runs on Enter, not per keystroke.
- **Focus:** a 2px Signal Blue ring.
- **Results:** a white e2 popover, rows with a semibold name and a 12px mono ID, Canvas on hover.

### Navigation
- **Style:** the navy rail. Group headings are 12px semibold Rail Muted in sentence case. Items are 18px line icons (stroke 1.8) plus 14px medium Rail Text labels, 7px × 10px padding, 8px radius.
- **States:** hover adds a 6% white fill and white text; active is a raised white chip (chip shadow) with Harbor Navy Ink semibold text and a Signal Blue icon, marked `aria-current="page"`.
- **Mobile:** icons only at 64px wide, each item keeping its accessible name and tooltip.

### Live heartbeat pill
A white e1 pill in the header carrying three honest states: live (pulsing Live Green dot, OK ink text, "ledger moved 3m ago"), idle (still Never Grey dot, Slate Navy text, "ledger last moved 14h ago"), and no beat (Silent Amber dot, "heartbeat failing, showing last known figures"). It also reports when it last checked and the ledger sequence number. The compact form shows only "live" / "idle" / "no beat" with the rest in its accessible label. The ping animation runs only under `prefers-reduced-motion: no-preference`.

### Demo badge
An amber-tinted plate on the rail (Silent Amber at 12% with a 28% ring, Demo Text, amber dot) reading "Demo core · synthetic data", present on every page; "Demo" on the icon rail.

### Attention banner
Attention wash with its tinted ring and soft shadow, a 28px amber icon tile, and one sentence that names the policies needing attention, each linked, capped at three names plus "and N more below".

## Do's and Don'ts

### Do:
- **Do** keep the three planes in order: navy rail, Cool Canvas (#edf1f6), white cards.
- **Do** lift containers with e1 and raise them with e2 on hover; use Frost Line (#e6ebf2) only between rows inside a container.
- **Do** reserve Signal Blue (#1f5eff) for action, selection, links, focus and production evidence.
- **Do** use Live Green, Silent Amber and Never Grey only for live / silent / never, and Drill Grey (#8a96ab) only for simulated drills.
- **Do** break drills out of every total that includes them, and label demo data and stale feeds where they appear.
- **Do** put a plain-language line under every headline figure saying what it counts.
- **Do** keep all text at 12px or larger, readable text at #56637a or darker, and figures tabular.
- **Do** gate decorative motion (lift on hover, heartbeat ping) behind reduced-motion preferences.

### Don't:
- **Don't** outline cards or panels with borders, or reintroduce the slate-era `border-slate-200` panels.
- **Don't** use black shadows on light grounds; tint them navy.
- **Don't** set labels in small uppercase with letter-spacing; label in sentence case at 12–13px semibold.
- **Don't** use JetBrains Mono for names or numbers.
- **Don't** add new hues for decoration or new radii beyond the 12 / 8 / 6px set and full rounds.
- **Don't** show a pulsing "live" mark when the source has not moved; use the idle state.
- **Don't** use `text-[10px]` or `text-[11px]`.
