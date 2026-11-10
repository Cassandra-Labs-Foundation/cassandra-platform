# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences carry equal weight (confirmed by Lorenzo, 2026-11-10). The console has to hold up as a real working tool and as the thing shown in a walkthrough.

- **Credit-union staff doing daily work.** Tellers (drawer, cash position, transaction journal), member services (find a member, see every account and transfer), accounting (financial statements), the BSA officer and compliance staff (monitoring, flags, escalations, approvals, the governance calendar), and whoever prepares the NCUA 5300 call report.
- **Demo audiences.** Regulators and examiners, partners and investors who are walked through a compliance-native core running on synthetic data and need to see controls working, not be told about them.

## Product Purpose

Cassandra is a banking core for a credit union in which the compliance policy and the running system are the same artifact. The staff console (`ui/`) is where people see and work that system: members, accounts, transfers, the ledger, the statements, and the evidence that every control fired, was silent, or never fired. Success: a staff member can do their job and an examiner can verify a control from the same screens, without a binder.

## Positioning

**Policy = running system.** Policy prose is authored once. Controls are extracted from it mechanically and become the database schema, the runtime gate, and the tests that prove the gate fires. A control that no code enforces shows up red on a dashboard instead of passing silently in a binder. No neighboring core can truthfully show its policies and its enforcement as one traceable thing.

## Operating Context

- **Institution:** Pynthia, an NCUA-chartered credit union run as a narrow bank. Deposits sit on its own balance sheet. Lending is deliberately unrouted. Each integrating fintech has one FBO account. Pynthia is the institution running on Cassandra.
- **Data:** the live core (Supabase edge API) holds synthetic demo data only. The console is public with no authentication for that reason, and gating is required before it ever points at real data (`ui/DEPLOY.md`).
- **Access:** the console reads through a read-only server-side proxy restricted to spec operations marked `x-ui-surface: true`. The one write is the compliance flag/escalation route, which writes to the demo/sim evidence scope. Approving payments happens through the core API, not the console.
- **Real artifacts the console reflects:** policy documents (`compliance/policies/`), the 339 catalogued controls and their event history, the governance obligations calendar, the NCUA 5300 call report (fillable draft, PDF export), and the pro-forma statement of financial condition.
- **Identity in the session** (e.g. "Sarah Thompson, Teller") is a local browser persona. It is not a directory user and grants nothing at the core.

## Capabilities and Constraints

- **Contract:** the OpenAPI spec `core/core-api.yaml` is canonical. UI-reachable surfaces and the proxy allowlist are generated from it, so a new screen needs its operation declared in the spec first (repo `CLAUDE.md`).
- **Honest blanks:** the core books no income, expense, equity or loans yet. Those lines are shown as blank with an explanation, never faked. This honesty is a product commitment.
- **Teller drawer** buy/sell/balance is a browser-local simulation today, not a core write.
- **Known open defects:** see `ui/pre-push-review-2026-11-10.md`. Call Report clear resurrects values; Approvals counts are capped samples; narrow-screen navigation and tables fail.
- **Undecided:** production auth model (who may flag, approve, or see what); whether the drawer becomes a real core write; dark mode.

## Brand Commitments

- The console wears the **Cassandra** identity, with Pynthia shown as the institution running on it (confirmed 2026-11-10). It currently reads "Pynthia Banking". That changes in the redesign.
- No logo, color palette or typeface exists yet. The repo ships only Next.js default SVGs. Any identity must be created, not assumed.
- **Standing preference: the category standard, at full craft** (Lorenzo, 2026-11-10). Lorenzo chose a conventional fintech dashboard over distinctive "world" directions. Peers that set the quality bar: **Mercury** (minimal) and **Stripe Dashboard** (dense financial data, tables, status vocabulary). It must not feel like a legacy core (dense grey screens, tiny type) or a compliance binder/government form.

## Evidence on Hand

- **Live synthetic data:** about 3,283 members, 4,388 accounts, 1,952 transfers, 698 held payments, 69 governance obligations. Live numbers are in `STATE.md`.
- **Real control evidence:** heartbeat, coverage (controls live / silent / never fired), per-control event history with payloads and traces.
- **Policy texts with citations:** 27 policy folders, shown on the Monitoring pages.
- **None of the following exist; do not fabricate them:** customers, testimonials, examiner endorsements, production metrics, pricing.

## Product Principles

1. **Show the proof, not the claim.** Every number and status traces to a control, an event, or a record the user can open.
2. **Honest about absence.** Silent controls, unbooked lines, simulated actions and capped lists are labeled as such. Nothing pretends to be live, complete or persisted when it isn't.
3. **One screen, two readers.** Staff finishing a task and an examiner verifying a control should both succeed on the same view.
4. **The spec is the contract.** The console only shows what the core declares.
