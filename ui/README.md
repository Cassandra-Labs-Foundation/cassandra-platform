# ui/ — the staff console

A Next.js (Pages Router) console for credit-union staff — teller, member
services, accounting, compliance, approvals, the 5300 call report. It reads
**live core data** through a read-only server-side proxy; the mock layer
remains only where the core itself has nothing to serve (see
`src/lib/mock.js`, which documents why each mock survives).

There is one deliberate exception to banking read-only access: the compliance
event flag form uses a dedicated POST route (`pages/api/compliance/flag.js`)
through `lib/coreWrite.js` to route an escalation. Source describes its evidence
scope as demo/sim. This is not a general banking write proxy; the November 2026
UI review did not live-verify escalation persistence or authorization.

## The contract comes from the spec

This is the one rule that matters here, and it lives in the repo root's
`CLAUDE.md` ("UI-reachable surface"): the UI may only call operations marked
`x-ui-surface: true` in `core/core-api.yaml`. Two files enforce it and both
are **generated — never hand-edit them**:

| file | what it is |
|---|---|
| `src/lib/coreApi.allowlist.json` | the proxy's allowlist of spec paths |
| `src/lib/core-api-types.d.ts` | the wire types of those operations |

To reach a new endpoint from the UI: mark the operation `x-ui-surface: true`
(plus its query parameters) in the spec, then

```bash
python3 scripts/gen_ui_contract.py
```

CI (`.github/workflows/ui-ci.yml`) runs `gen_ui_contract.py --check`, lint,
and the build on any change to `ui/`, the spec, or the generator — so a spec
change that breaks a screen fails in the same PR instead of in production.

## How data flows

```
page/component
  └─ src/lib/useLiveCore.js        fetch hook (loading / error / data)
       └─ src/lib/coreApi.js       client for the proxy
            └─ src/pages/api/core/[...path].js    server-side, read-only:
                                   GET only, allowlist-checked, adds the
                                   core API key (never shipped to browser)
            └─ src/pages/api/blnk/[...path].js    same pattern, Blnk ledger
```

`src/components/live/Live.jsx` is the wrapper that renders live-vs-fallback
states consistently.

## Layout (actual)

```
src/
  pages/            flat .jsx routes: index, teller, member-services,
                    accounting, administrator, approvals, compliance,
                    call-report, reports; accounts/ and members/ for detail
                    pages; api/ for the two proxies
  components/       layout/, dashboard/, teller/, accounting/, live/
  lib/              coreApi.js, useLiveCore.js, blnkApi.js, gl.js,
                    ledgerTree.js, ncua5300.js (5300 mapping — reads its
                    sourcing rules in the header comment), mock.js
```

Stack: Next.js 15.5, React 19, Tailwind 4, lucide-react.

```bash
cd ui && npm install && npm run dev
```

## Product research

The vendor benchmark (CU*Answers / Sharetec / Fiserv) and the feature ideas
harvested from their demos moved to [product-research.md](product-research.md).
They are product context, not a description of this codebase.

## Design review

Core UI critique completed 2026-11-09, based on six deployed desktop screens and source inspection. Priorities: distinguish demo/local state from live reads and persistent actions; make Home and Approvals task-oriented; correct accessibility semantics and loading/error states. No application code changed. Implementation owner and delivery date are unassigned; mobile, contrast, and full keyboard validation remain open.
Session history: [discussion-log.md](discussion-log.md). Findings and proposed priorities: [design-critique-2026-11-09.md](design-critique-2026-11-09.md).

### Live bug hunt, 2026-11-09

[Chrome bug report](bug-hunt-2026-11-09.md): eight reproduced defects, led by filing-clear value resurrection and omitted trace decisions; includes narrow-screen clipping and accessible-name failures. [Evidence screenshots](review-evidence-2026-11-09/). All remain open, with owners/dates unassigned. Audit draft values were removed and the browser viewport restored. No application code changed.

### Gstack comparison, 2026-11-09

[Gstack design/product review and comparison](gstack-review-2026-11-09.md): official Gstack installed globally for Codex, then its design audit and CEO strategy frameworks applied in review-only mode. Six fresh desktop screens plus phone/tablet Reports evidence in [gstack-evidence-2026-11-09/](gstack-evidence-2026-11-09/). New coverage includes filter/filing label omissions, tablet clipping, and narrow search; native source review adds approval failure-state coupling and disclosure/reduced-motion concerns. A native product challenge corrected the overly broad read-only framing by identifying the existing dedicated escalation write. Findings remain open. No app changes or implementation approvals. External Claude review unavailable; same-model reviewers are not cross-model validation.

### Pre-push review, 2026-11-10

[Pre-push review](pre-push-review-2026-11-10.md) of the deployed console (67eb39e): **FAIL**, independently confirmed. Four Majors are open: Call Report clear resurrects values, unlabelled memory-only Teller drawer actions, capped Approvals counts shown as totals, and narrow-screen accessibility/clipping. Owners and dates are unassigned. [Evidence](pre-push-review-evidence-2026-11-10/).

### Beautification plan, 2026-11-10

[Impeccable-based design plan](design-plan-impeccable-2026-11-10.md): detector baseline (715 low-contrast hits, 11px text, Arial everywhere, Teller hydration error), a 20/40 critique, and a four-phase plan: tokens, a "core heartbeat" signature move, page layouts, harden/adapt. Impeccable was installed 2026-11-10 (skill 4.8.2; hooks local in `.claude/settings.local.json`; Codex copies in untracked `.agents/` and `.codex/`; telemetry off). PRODUCT.md written at the repo root 2026-11-10: equal staff and demo audiences, "policy = running system" positioning, and the console wears the Cassandra identity. Current look recorded 2026-11-10 in `/DESIGN.md` + `.impeccable/design.json` as the baseline ("The Default Back Office"; minimal on purpose, Mercury as the reference). Direction chosen 2026-11-10: **the category standard** (Stripe/Mercury-grade dashboard, played straight), first on Compliance Monitoring. Contract in `.impeccable/surfaces/ui-src-pages-compliance-dashboard-index-jsx.md`. Next: build Monitoring code-led, finish review, regenerate DESIGN.md. Still open: typeface, exact accent hue, dark mode.

### Cassandra look, 2026-11-10 (built locally, not deployed)

The new shell (navy grouped sidebar, demo-data badge, header heartbeat) and a rebuilt Compliance Monitoring overview are in the working tree, uncommitted. Impeccable finish review: fixes 1–7 resolved; DESIGN.md merge in progress. Pending: commit and push (needs Lorenzo's OK and the pre-push review), Vercel deploy, a live check, then migration of the policy/control pages and the other pages' panels to the new tokens. Direction contract: `.impeccable/surfaces/ui-src-pages-compliance-dashboard-index-jsx.md`. Review screenshots were local-only (Impeccable runtime folder, gitignored).
