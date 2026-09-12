# TODO — what's missing, and what to work on next

> Hand-written backlog, compiled 2026-08-09 from a full docs + codebase audit.
> Live numbers belong to [STATE.md](STATE.md) — where a count appears here it is
> a snapshot from that date; trust the artifacts
> (`control-tests-live.json`, `crosswalk.json`, `core/verifier/worklist.md`)
> over this prose. This file is in `check_doc_claims.py`'s checked set, so a
> path or gated number that goes stale turns the doc gate red.

## 1. Quick wins (mechanical, do first) — DONE 2026-08-09

- [x] Commit the orphaned parquet sweep: `analytics/archive/` has one untracked
      file covering event sequences 1694520–1705198 (10,679 events). Git is the
      stated cold archive of record and is currently missing that range.
- [x] Fix the drill doc path: `drill/run.ts` still writes `DRILL.md` at the repo
      root, but the doc moved to [docs/drill.md](docs/drill.md) — every re-run
      leaves the real doc stale. Also add a `drill.json` step to
      `scripts/rebuild_artifacts.sh`; it is the only artifact outside the cascade.
- [x] `core/architecture-decisions.md` hygiene: mojibake (double-encoded UTF-8)
      throughout, the v1.1 row missing from its own revision table, and six
      Appendix-B documents that don't exist in this repo.
- [x] Add `doc-gate.yml` to the CI workflow table in
      [docs/architecture/containers.md](docs/architecture/containers.md).
- [x] Fix stale prose inside generated-artifact *inputs*: `crosswalk-mappings.json`
      OQ-07 ("BSA-21 is the only reachable control" — the generated tables now
      say otherwise) and OQ-10 ("there is no CTR filing" — `core.ctr_filing`
      exists); `control-scope.json`'s header count of judgment calls is six low.
- [x] Delete the root `supabase/` CLI scratch (untracked `.temp/` leftovers) so
      nobody runs the Supabase CLI at the wrong level.

## 2. Fake-vs-real defects — the live-tier backlog — DONE 2026-08-10

Cleared in full: the live tier stands at 225 green / 0 red in scope, zero
fake-vs-real defects (down from 46). The causes decomposed into six
mechanical classes — fixtures that never reached the real database,
recorder-copy mutations, wrong select lists, invented enum vocabulary,
uuid-vs-text id mismatches, and live-state accumulation on converged rows —
fixed across two commits (see git log 2026-08-09..10). The related schema
debt (the ten `todo()` columns) went with it: migration 20260809000100
renamed the dotted first-cut columns, and the coverage suite regenerates
with zero gaps. Refresh the baseline any time with
`gh workflow run live-control-tier.yml -f mode=refresh` — never run the
full tier from a laptop.

## 3. Decisions only a human can make — DECIDED 2026-08-11, **RE-REVIEW 2026-08-12**

All seven were put to Lorenzo on 2026-08-11 and decided in one sitting. Lorenzo
flagged on 2026-08-11 that one sitting was not enough evaluation, so the whole
section is reopened for review on 2026-08-12 alongside §6's FBO question.

The `[x]` boxes below stay checked on purpose: each decision was *executed*, and
unchecking would imply the code was reverted, which it was not. What re-review
changes is whether the decision stands — so the thing to know per item is what
reversing it now would cost. Ordered cheapest to dearest:

1. **Free — posture only, nothing built on them.** Lending stays parked; D5
   Phase-2 and D24 stay deferred; OQ-02's STUB reclassification (dashboard
   metadata; the verdict never moved). Reversing these costs a decision and no
   rework.
2. **Free today, expensive soon — chart of accounts.** `ACCOUNT_TYPE_MAP` was
   approved to unblock double-entry `bookkeeping_entry`, per-product
   `account_code_5300`, and a GL-backed trial balance — *none of which is built
   yet*. This is the one where re-review is genuinely time-sensitive: it is
   free to change until that engineering starts and awkward afterwards. Look
   at it first.
3. **Costly — the two id renames.** OQ-01 (CG-CTR-01 → CG-LGTXN-01) and OQ-11
   (CP-01…CP-12 → CA-01…CA-12) are executed across the corpus, and OQ-11 also
   moved `control-scope.json` uids and added a gating script. Reversing means
   another sweep plus a *third* generation of historical ids in
   `control_result`, since the old ids were deliberately preserved as evidence.
   The cost grows with every emission, so revisit now or not at all.
4. **Shipped API contract — OQ-12.** `entity_id` required on `POST /accounts`
   touched spec, handler, and the idempotency hash. Relaxing the field again is
   backwards-compatible for callers, but the idempotency-hash change is real
   behaviour, and the 3 quarantined NULL rows encode the refusal to fabricate
   owners. Reversal is possible but is a migration-and-contract exercise, not
   an edit.

What each decision was, and where its execution stands:

- [x] Lending: **stays parked.** The narrow-bank exception in `api/index.ts`
      is the standing record; the §4 proposed paths and the verifier's 25
      `no_api_inducer` targets are parked-by-design, not blocked.
- [x] Chart of accounts: **`ACCOUNT_TYPE_MAP` approved as written**
      (`ui/src/lib/ncua5300.js`). The engineering it unblocks — double-entry
      `bookkeeping_entry`, per-product `account_code_5300` stamping, a GL
      trial balance feeding the 5300 — is now an ordinary backlog item (§7's
      successor work), no longer decision-gated.

      **Re-review 2026-08-16 — the vocabulary is now constrained, the mapping
      is still open.** The re-review turned up why the mapping was hard to
      sign: `account_type` was unconstrained free text and `api/accounts.ts`
      substitutes the literal `'checking'` when a caller names no product, so
      all 1,917 live accounts ($55,455,245) read `checking` with no way to
      tell a stated product from an unstated one. Approving `checking → 902`
      meant approving *a default value* as a filing position.

      Migration 20260816000100 closes the vocabulary (spec enum + CHECK +
      a 400 at the handler): `checking` (legacy), `share_draft`, `share`,
      `money_market`, `share_certificate`, `ira`, `keogh`. The `savings` and
      `certificate` aliases are deliberately excluded — two spellings of one
      NCUA line is the ambiguity being removed — which makes those two entries
      in `ACCOUNT_TYPE_MAP` unreachable; prune them when the map is signed off.
      Existing rows are untouched, so this decides nothing about them.

      **DECIDED 2026-08-21 — the vocabulary is charter-neutral, and question 1
      dissolved rather than being answered.** Lorenzo's call: `checking`
      generalises better than `share_draft`, because this core should be able
      to run a bank as well as a credit union. That reframes what the
      2026-08-16 constraint got wrong — `checking` and `share_draft` are not
      two spellings of one NCUA line, they are two CHARTERS' names for one
      product, and the line it files on depends on who is filing (a bank's
      transaction deposits go to FFIEC Call Report Schedule RC-E, which has no
      line 902 in it at all). Migration 20260719002700 had already refused the
      same mistake for the permissible-instrument list: that list is data, not
      code, because a differently chartered institution operates under a
      different one.

      Executed in migration 20260821000100 + spec + `api/accounts.ts`:

      - Six canonical products, charter-neutral: `checking`, `savings`,
        `money_market`, `certificate`, `ira`, `keogh`. The credit-union
        spellings `share_draft` / `share` / `share_certificate` are accepted on
        the wire and normalised on write, so an institution integrates in its
        own vocabulary while storage holds one spelling per product. IRA and
        Keogh have no alias — they are tax constructs, not charter constructs.
      - `account_type` is **required** on `POST /accounts` (question 2, the
        OQ-12 treatment). The default was the actual hole: a CHECK constraint
        cannot see an omission.
      - Question 1 needed no answer. With the default gone, `checking` is a
        product somebody chose rather than the residue of one nobody named, and
        `ACCOUNT_TYPE_MAP` prunes to one entry per product.
      - The rows this was agonised over were never real: **every** account,
        entity and bookkeeping entry in the live database belongs to
        `ptnr_demo` or `ptnr_drill`. This core has never opened a member
        account, so unlike OQ-12's 3 quarantined NULL `entity_id` rows there
        was no history to refuse to fabricate.

      Still open, and now the only thing left of this item:
      1. **The 5300 map is charter-blind and lives in the browser.**
         `ACCOUNT_TYPE_MAP` in `ui/src/lib/ncua5300.js` is one charter's
         answer; nothing server-side maps a product to a filing line at all.
         A second charter needs the map keyed by charter and moved into
         effective-dated data — a map in a UI bundle cannot be effective-dated,
         cannot vary by institution, and cannot be read by the reporter that
         runs nightly. Blocked on the institution-parameters sign-off, which
         does not yet say what charter this institution holds.
      2. Re-stamp the 1,628 historical `account_code_5300 = "018"` rows, or
         leave them as quarantined history the way OQ-12 left the 3 NULL
         `entity_id` rows? **Neither, until the stamp is fixed:**
         `api/transfers.ts` hardcodes `"018"` on every bookkeeping entry ever
         written, so there is no per-product logic to have got wrong and
         re-stamping history changes nothing about the next entry.

- [x] **The FBO position was on the wrong side of the balance sheet — FIXED
      2026-08-16.** Line 730B (Total Cash on Deposit, an ASSET) was sourced
      from `aggregator.fbo_position`, justified as "the standard treatment for
      an FBO/program-bank model" — which describes a *non-chartered* fintech
      pooling customer money at a real bank. Pynthia holds the charter, so a
      program's FBO balance is money we **owe**, never cash we hold elsewhere.

      Lorenzo's call was to treat it as a liability. Implementing that turned
      up why it cannot simply move to line 880: **the liability is already
      reported.** `core.partner.instance_id` ties each fintech program to its
      aggregator instance (`ptnr_demo` ↔ `inst_local`), and that program's
      end-user accounts are in `core.account` — 1,907 of them, $55,415,245 —
      already bucketed onto the share lines. The FBO position is the same
      deposits aggregated by a different consumer, so filing it anywhere would
      **double count**.

      So it is no longer a form line at all. 730B is unsourced (its `needs`
      names real settlement/correspondent balances, which the core has none
      of), and `buildFiling` returns the figure as `fboReconciliation` — a
      control total tying the program-level view against the share lines.
      Sourced lines went 8 → 7 of 33. Verified in the running UI: the banner
      reads −$198,650.00 against $55,455,245.00, a gap of −$55,653,895.00,
      which is the whole of the unmodelled inbound funding and disappears when
      an inbound rail emits.

- [x] **Partner program end users ARE members — ANSWERED 2026-08-16**, and
      their balances are tracked *through* the program's FBO account. Two
      consequences, both shipped:

      **Line 880 is zero, so line 018 computes.** Every `core.account` has a
      `partner_id` (NOT NULL) and every program's end users are members, so
      every deposit the core holds is a member share and non-member deposits
      are zero rather than unknown. That unblocks TOTAL SHARES AND DEPOSITS —
      the code every `bookkeeping_entry` is stamped with — which now derives
      at **$55,455,245.00** instead of rendering blank. Sourced lines 7 → 9
      of 33, verified in the running UI.

      The zero is **asserted, not evidenced**, and carries a `provisional`
      note saying so: `core.membership` holds 2 rows and joins to no account,
      so the core cannot corroborate it. The day a non-member deposit product
      exists this silently stops being true — nothing will go red.

      **The tie-out became an invariant.** "Tracked through the FBO account"
      means the position and that program's member shares are two views of one
      number, so `aggregator.member_share_cents(instance)` (migration
      20260816000200) supplies the other half and `GET /reports/5300` returns
      both together with their difference.

      This also fixed a real defect in the reconciliation shipped hours
      earlier: it summed the share lines *client-side*, but the browser sees
      whatever accounts its actor may list — for an ops actor, every partner.
      So one instance's position was being compared against every program's
      balances, folding `ptnr_drill`'s $40,000 into `inst_local`'s gap. The
      scoped figures are $55,415,245 of member shares against −$198,650,
      a gap of −$55,613,895 (not the −$55,653,895 first reported).

      **Deployed and verified 2026-08-16.** `GET /reports/5300` returns
      `member_share_cents` 5541524500 and
      `fbo_reconciliation_diff_cents` −5561389500, matching the database, and
      the UI banner renders the tie-out against the live core.
- [x] D5 Phase-2 delegated auth and the D24 admin console: **stay deferred.**
      `core/architecture-decisions.md` remains the record; this backlog stops
      carrying them.
- [x] OQ-01: **renamed.** CG-CTR-01 → CG-LGTXN-01 everywhere it is emitted or
      asserted; historical `control_result` rows keep the old id as evidence.
- [x] OQ-02: **CG-OFAC-01 reclassified as STUB** — dashboard row carries
      `stub: true` and a title saying the screen is a token match with no SDN
      list; verdict stays `related`. Real list integration remains §8.
- [x] OQ-11: **cash renumbers.** CP-01…CP-12 → CA-01…CA-12 in the corpus,
      `control-scope.json` uids updated, and
      `scripts/check_control_collisions.py` now gates the cascade so the next
      silent prefix drift goes red.
- [x] OQ-12: **entity_id required on POST /accounts** (spec + handler +
      idempotency hash). The 3 pre-decision NULL rows (of 1,944 accounts) stay
      NULL as quarantined history — fabricating owners was explicitly refused.
- [ ] Institution parameters (OQ-14/OQ-15 and the rest of the NULL set):
      **proposal drafted for Patrick** — see
      [docs/institution-parameters-proposal.md](docs/institution-parameters-proposal.md).
      Blocks until Patrick signs; then the values are UPDATEs, not code.
- [x] Crosswalk claims review: **DONE 2026-08-11** — all 10 mappings (14
      claims) confirmed as written via
      [docs/crosswalk-review-packet.md](docs/crosswalk-review-packet.md);
      every claim now carries `reviewed_by: lorenzo` and the coverage
      verdicts are load-bearing for the first time.

## 4. API surface not yet built — engineering half DONE 2026-08-10

What could move without a product decision, moved:

- [x] Card issuance routed: `POST /cards` and `POST /members/{id}/card-reissue`
      graduated from `x-proposed-paths` to routed, self-gated internal
      operations (the handlers already existed).
- [x] The proposed surface is documented:
      [docs/proposed-surface.md](docs/proposed-surface.md) is generated in the
      cascade from `x-proposed-paths` — operations by resource, with schema
      existence and the verifier's demand signals joined in.
- [x] The verifier's inducer mapping was measured, not guessed: of the old
      153 `no_api_inducer` entries, 108 were scoped-out obligations the
      enumerator never checked against `control-scope.json`, and 22 more were
      request-driven rules whose routed handler emits the whole reaction
      (the enumerator now derives the inducer from output provenance and
      cites it). `core/verifier/worklist.md` now carries 25 `no_api_inducer`
      targets — the credit-origination surface parked by the narrow-bank
      decision, plus IP-15 — instead of contradicting the drill.
- [x] Response-contract stubs are counted in [STATE.md](STATE.md)
      ("operations with stub response contracts") so the number can't drift
      in prose again. Verdict after assessment: do NOT machine-author them —
      nothing consumes response schemas today (the verifier's contract
      targets, the UI types and the SQL generator all read other things), and
      a generated contract nobody validates would be a second, subtly-wrong
      truth next to the honest "the handler is the contract" pointer. The
      channel, when the black-box tests in `core/verifier/TEST-CATALOG.md`
      start consuming contracts, is `core-api-loop/migrate/contracts-overlay.yaml`
      (request + response together, per reviewed slice). Note: `x-provisional`
      is unrelated — it is provenance metadata on event-derived schema fields
      and gates nothing.

What stays, and why — all product-gated, all decisions in section 3's court:
the remaining proposed paths (dominated by resources the verifier's
state-machine targets wait on: loans, cases, filings, findings, risks,
trades), the lending/collections/fair-lending routing itself, D5 Phase-2
delegated auth (`/auth/token`), and the D24 credit-union admin console.

## 5. Test debt — DONE 2026-08-10 (one deliberate remainder)

- [x] The black-box contract suite exists and runs: `core/verifier/contract/`
      — 30 of the catalogue's tests written and PASSING against the deployed
      core, 2 more written and `[~]` because they exposed real contract gaps
      (keyless mutation is accepted; the demo key is deliberately an internal
      actor). `contract-tests.yml` runs the suite weekly and on dispatch;
      `core/verifier/TEST-CATALOG.md` is the per-test ledger, including why
      each unwritten group waits (proposed endpoints, a partner-scoped
      credential, the aggregator layer, a webhook sink). Getting here also
      surfaced and fixed a production defect: the deployed function's Blnk
      key was stale, so account opening had been broken on the deployed API.
- [x] All six untested API modules have test files (53 tests; the full
      hermetic suite is 999). The writing surfaced four real defects in
      `eps_controls.ts`/`ops_security.ts` — flagged as a follow-up task, the
      worst being an auth-lockout counter that counts cumulative-ever
      failures instead of consecutive ones.
- [x] The drill's four documented blind spots (FKs, UNIQUEs, immutability
      triggers, NOT NULL partner_id) are now behaviorally tested:
      `core/supabase/tests/04_constraint_behavior.test.sql` (22 behavioral checks,
      executed against the full real migration chain) and a `pgtap` job in
      `core-ci.yml` — the first time ANY pgTAP runs in CI. Known remainder:
      the GENERATED pgTAP files (00–03) fail against the current schema
      (their seed rows predate NOT NULL partner_id and the uuid/text id
      changes) — flagged as a follow-up to fix `gen_tests.py` and widen the
      CI job beyond 04.
- [x] `/sandbox/simulate` has no missing rails: ACH, wire and card lifecycles
      are all simulated; book transfers settle synchronously by design; and
      the 501 for anything else is a typed index of what exists (now pinned
      by a contract test).
- [x] The 25 `spec_ahead` properties were re-assessed: five now have routed
      surfaces (`ACCTNUM-LUHN`, the four state machines) and moved to
      `ready` — three of them already have passing contract tests. The other
      20 genuinely wait on unbuilt surface (aggregator, rate limiting,
      `/events`, webhook sink) — see `core/verifier/worklist.md`.

## 6. Ledger / Blnk integration (orphaned live TODO)

`blnk-webhook/TODO.md` is referenced by no doc index and holds the cutover
work. **The switch-on is DONE 2026-08-11** — see that file's header for what
was actually true versus what this section long claimed. Still open there:
balance-mirror refresh on `transaction.applied`, pulling MATCHED
reconciliation results into `core.bookkeeping_entry`, the monitor→control-id
map for `control_result` rows, Blnk key scoping, secret rotation, a lag
metric, and cold-start backfill. The two blueprint flags that were never
closed are below — the direction model is now decided, with the live data
correction and the inbound code still open:

- [x] **The FBO position direction model — DECIDED and SHIPPED 2026-08-15.**
      Lorenzo adopted the balance model, negative reported position included.

      *What an FBO position is here.* Pynthia is a chartered narrow bank: the
      deposits are on our own balance sheet, not held at some upstream bank.
      The FBO accounts belong to the **fintechs integrating with us** — one per
      fintech, holding that program's end-user money. `aggregator.fbo_position`
      is already keyed that way (`instance_id` primary key, and `instance_id`
      is the verified JWT claim), so per-fintech was structural from the start.
      An earlier draft of this section described the pooled-account model of a
      *non*-chartered fintech; it was wrong about the whole direction of the
      relationship, and the numbers it quoted came from the wrong stream.

      *What was wrong in the code.* `fbo_read` computes `available = position −
      held reserves` and `accept_origination` does `position_cents −
      amount_cents`: both say position is a balance that spending reduces.
      `run_payment_hub` disagreed — `position_cents + amount_cents` for every
      money code, all four of which are outbound settlements. Sending money
      raised the balance. The live `inst_local` position of **+$1,927,341** is
      exactly that: a sum of outflows.

      *Why a sign flip alone was not the fix.* Re-measured against
      `aggregator.event` — the stream the hub actually reads, and **not** the
      one this section originally cited (those figures were `core.event`; the
      two streams have no bridge, `aggregator.event` is written only by
      `ingestEvents` from a fintech's own JWT):
      1. `transfer.settled` is an on-us book transfer (spec Decision 8) and
         nets to zero inside one fintech's FBO — a category error, not a sign
         error. Largest contributor at 313 events, $1,456,341.
      2. `ach_transfer.returned` and `wire_transfer.returned` carry
         `amount_cents` but had no FBO effect, hiding $273,000 of reversals.
      3. **There is still no inbound funding code** in `x-events`. Nothing
         credits an FBO, so the corrected position runs negative.

      *What shipped.* Direction is declared once in the spec (`x-fbo:
      outbound | inbound | internal` on the `x-events` entry) and mirrored into
      `aggregator.fbo_delta` (migration 20260815000100, applied live) and
      `agg_fbo_events` in [aggregator_views.sql](analytics/aggregator_views.sql);
      `scripts/check_money_codes.py` fails on drift between any of the three,
      and on any `x-money` code that declares no direction.

      Direction is a **second axis**, deliberately not folded into
      `is_money_code` — that allowlist is shared with `run_bsa_approver`, where
      it drives CTR and structuring detection. Dropping `transfer.settled` from
      it (as this section previously proposed) would have blinded CTR to on-us
      transfers, and adding the return codes would have minted CTR alerts for
      reversals. `x-money` keeps meaning "money moved, BSA cares"; `x-fbo`
      means "and this is how the position moves".

      **SUPERSEDED 2026-08-17 — the accumulator is gone.** The direction model
      was a correct fix to the wrong layer: a forward-only consumer applying a
      hand-maintained sign table can be made right, but it cannot be made
      *re-derivable*, which is why correcting it needed a parquet
      reconstruction rather than a replay. Migration 20260817000100 makes the
      position a roll-up of member balances instead, so `fbo_delta`,
      `run_payment_hub`, the payment_hub cursor, `agg_fbo_events`, the `x-fbo`
      spec axis and `05_fbo_direction.test.sql` are all removed. The history
      below stays because the failure mode is the lesson.

- [x] **Corrected positions applied 2026-08-15** — `inst_local`
      **+$1,927,341.23 → −$198,650.00**. The hub is forward-only and §7's
      pruning had already emptied `aggregator.event` (0 rows at cursor
      1705305), so the wrong positions could not be replayed away;
      a recompute script rebuilt them from the parquet archive instead. It was
      removed on 2026-08-17 along with the accumulator it existed to repair.

      It proves itself before writing. A position is not purely event-derived
      (`accept_origination` also debits it on capture), so the script computes
      `Σ(signed events) − Σ(captured reserves)` under BOTH models and labels
      each row: `new` (matches the corrected model), `old` (matches the
      pre-correction one — wrong but fully accounted for, safe to move), or
      `no` (matches neither; never written). `inst_local` reconciled to the
      cent. `inst_chaos_test` and `inst_saga_test` were fixture-seeded with
      non-event provenance and were tracked in a ratchet file; both now read 0
      through the roll-up, which is what they always should have been.

      *Consequence, deliberately accepted at the time:* a negative position
      meant `originate` refused every origination for that instance
      (`insufficient_available`) and the 5300's `fbo_position_cents` ran
      negative. **No longer true as of 2026-08-17** — under the roll-up the
      position is the sum of member balances, which for `inst_local` is
      **+$55,415,245.00**, and originations are admitted again. The unmodelled
      inbound hole did not close; it stopped being the position's problem,
      because the position no longer reconstructs balances from flows it may
      not have seen.

- [x] **The pruning gap is closed by a standing check, not by pruning less.**
      Pruning is not defective — the events are safe in git-committed parquet.
      What was missing is that nothing *noticed* when the hub's position
      diverged from what the archive says it should be, which is exactly how
      the sign error survived: it was wrong in the only copy anyone read.
      `fbo_recompute.sh --check` now runs daily in
      `aggregator-reporters.yml`, immediately after the prune (if it still
      reconciles once the hot rows are gone, the archive really is serving as
      the record) and goes red on any unbaselined divergence. It never
      writes — `--apply` stays a by-hand action.

- [x] **Inbound funding registered — ANSWERED 2026-08-15.** Lorenzo: a
      fintech's FBO is funded by the fintech itself and by ACH pulls against
      its end users' external accounts. Two codes, because BSA cares about
      exactly one of them (migration 20260815000200, applied live):

      - `ach_pull.settled` — an end-user ACH pull settles and credits the FBO.
        `x-money: true` **and** `x-fbo: inbound`: this is an end-user
        transaction and the BSA approver must see it for CTR and structuring.
        Until now the aggregator's transaction monitoring was outbound-only.
      - `fbo_funding.settled` — the fintech funds its own FBO from treasury.
        `x-fbo: inbound` only. **Judgment call worth confirming:** keeping it
        out of `x-money` keeps program-level top-ups out of the CTR branch,
        which would otherwise alert on every large funding and bury the real
        hits. It is a movement between institutions, not one by or for a
        member. Say so if you want it monitored anyway — it is a one-line
        change plus a migration. Rail-agnostic on purpose: wire vs ACH credit
        was not specified, and encoding a guess in a code name is how the
        naming debt in §10 started.

      Neither is emitted yet — no inbound rail is built — but registering
      ahead of emission is the direction the repo's rules run, and it means the
      first inbound event credits the right instance instead of being dropped
      by a consumer that never heard of it. The position stops being
      outflow-only by construction the moment a rail lands.

- [ ] **Two smaller things found while shipping the above:**
      - `transfer.settled` is `internal` only because a transfer between two
        *different* fintechs' FBOs is unrepresentable today: the payload
        carries `source_account_id`/`destination_account_id`, but the
        aggregator has no account → instance mapping and attributes an event
        to the single instance on its JWT. Correct for every transfer the
        model can currently express; wrong the moment cross-program transfers
        are real.
      - `aggregator.fbo_position`'s own comment claims it is "built ONLY from
        processed events", which `accept_origination` has always contradicted.
        Worth confirming an accepted origination does not ALSO settle into an
        outbound event later — that would debit the position twice. Immaterial
        today (one accepted origination, $50 on `inst_local`), not immaterial
        at volume.

## 7. Reporting & analytics — engineering half DONE 2026-08-11

- [x] The scheduled reporters DO run in CI — this item was stale on arrival:
      the `SUPABASE_DB_URL` secret was set 2026-08-06 (before this backlog was
      compiled) and `aggregator-reporters.yml` has run green daily since,
      archiving parquet and writing BSA-lookback + 5300 evidence rows.
- [x] The money-code allowlist is single-sourced behind a red gate: the four
      money codes are declared in the spec (`x-money: true` in `x-events`),
      and `scripts/check_money_codes.py` (in the rebuild cascade) fails when
      `aggregator.is_money_code` or the DuckDB spanning view drifts from that
      set — a new money rail now goes loudly red instead of silently
      invisible. §6's direction question was settled on 2026-08-15 by adding a
      SECOND declared axis (`x-fbo`) rather than by editing this set: `x-money`
      still means "money moved, BSA cares", and the same gate now also pins
      `aggregator.fbo_delta` and `agg_fbo_events` to the spec.
- [x] The BSA thresholds are single-sourced: `aggregator.parameter`
      (migration 20260811000100) holds `ctr_threshold_cents`,
      `structuring_hot_window_hours`, `structuring_lookback_days` — values
      unchanged — and both `run_bsa_approver` and `analytics/bsa_reporter.sh`
      read them, so the approver and the reporter cannot disagree. Changing
      one is now an UPDATE with §3 sign-off, not a code hunt.
- [x] Physical pruning exists: `aggregator.prune_archived` (same migration)
      deletes hot rows only when the git-committed parquet, the archive
      watermark, AND every consumer cursor have passed them, and never rows
      younger than 72h (the approver's structuring branch re-reads a 24h
      entity window). `analytics/prune.sh` bounds by CONTIGUOUS committed
      coverage — a missed parquet commit (it happened: f28afe7) stops the
      prune at the gap instead of eating it. Runs in the workflow strictly
      after the parquet push. UPDATE stays refused forever; the append-only
      trigger gained exactly one door and it only opens from inside
      `prune_archived`.

What stays, and why: the 5300 reporter's five columns are honest evidence of
a scheduled aggregation, but mapping them onto the nine-schedule form needs
the chart of accounts, and that is a §3 decision, not plumbing —
`ui/src/lib/ncua5300.js` is the worked statement of exactly which lines are
blocked on it, and blueprint §521 records the mapping as waiting on a person.
Same for `account_code_5300 = "018"`: every bookkeeping entry is stamped with
a COMPUTED NCUA total no filer can post to, and re-stamping by account type
would silently bake in the provisional `ACCOUNT_TYPE_MAP` that ncua5300.js
explicitly refuses to apply without sign-off. Both now live in §3's
chart-of-accounts item rather than masquerading as §7 engineering.

## 8. Stubs standing in for real integrations

- [ ] OFAC screening matches the literal token "SDN" (`api/bsa_program.ts`) and
      `sdn_list_version` is always NULL — no sanctions list, no
      re-verification, no 50%-rule derivation.
- [ ] KYC providers (Alloy/Socure/Middesk) are deterministic simulations
      behind the real adapter in `api/kyc.ts`.
- [ ] Roughly thirty red or scoped-out obligations wait on external feeds: an
      HR feed alone flips nine (handoff Group A), plus SIEM, backups, pentest,
      TLS scanning, and vendor attestations (Group B) — see
      [docs/history/2026-07-19-handoff.md](docs/history/2026-07-19-handoff.md).
- [ ] The dashboard data route is still public — the re-locking recipe sits
      unapplied in `api/dashboard.ts`, and `ALLOW_DEMO_KEY` defaults to enabled
      unless explicitly set to `"false"`.
- [ ] Retention clocks exist for two of nine record classes — a wire transfer
      starts no retention clock (OQ-10); CTR exemptions are stored but never
      evaluated (OQ-13).

## 9. UI

The proxy is GET-only, so every write is a disabled button: teller
deposit/withdrawal, member edit, and the entire MSR servicing list (cards,
checks, stop-pays, wires). Only the 14 `x-ui-surface` paths are
browser-reachable — no UI for cards, wire/ACH lists, BSA cases, filings, or
findings. The teller drawer is the last mock fixture in `ui/src/lib/mock.js`
because no core endpoint exists for it.

## 10. Compliance corpus & pipeline hygiene

- [ ] 257 "Assumptions & Gaps" bullets across the generated policies,
      aggregated nowhere — dominated by board parameters deferred to documents
      that don't exist (cash limits schedule, investment appendices, the SOD
      matrix, EDD thresholds).
- [ ] 494 over-listed provisional vocab codes (only 23 genuinely resolve
      nowhere) — regeneration debt with no automated check. Plus the standing
      backlogs: `vocab-nonconforming.txt` (111 entries),
      `vocab-nonconforming-timers.txt` (112), and `vocab-field-normalize.txt`
      (302 lines that nothing consumes).
- [ ] Shared-control propagation is enforced by convention only — regenerating
      any of SC-01's seven host policies re-diverges the wording; no
      byte-identity checker exists in `scripts/` or CI.
- [ ] `schema-parity-baseline.json`: 486 findings, none ever burned down (240
      columns missing from the spec, 201 unspecced tables).
- [ ] `charitable-donation-accounts` is disabled in the policies manifest yet
      ships a live catalogue and a monitoring page; the six `CG-*` runtime gate
      rows render with no evidence attached.
- [ ] [STATUS.md](STATUS.md) is the single worst doc: months stale, rows for
      three of the 27 policies, and excluded from the doc gate so nothing will
      ever catch it.
- [ ] `scripts/code_format.py` and `scripts/check_vocab_refs.py` run in no
      workflow — their backlogs can grow silently. The pre-push doc gate is
      opt-in per clone (`git config core.hooksPath .githooks`).

## 11. Core runtime & data-access debt — added 2026-08-11

From a scaling review of the TypeScript core, prompted by the question of
whether to migrate to Go. The answer was no: none of what follows is a
language problem, and a rewrite would reproduce the first two verbatim. All
three are prerequisites for any future runtime change rather than
alternatives to one — doing them makes a later port cheaper, not redundant.
Ordered by correctness-per-hour.

- [ ] **Turn on typed database access.** `createDb()` in `api/lib.ts` returns
      a bare `SupabaseClient` with no `Database` generic, and the repo has no
      generated types file at all — so every one of the ~918 `.from(...)`
      call sites resolves to `any`, guarded only by eight hand-written
      `*Row` interfaces across ~44.6k lines. A renamed column compiles clean
      and fails in production. `check_schema_parity.py` catches
      spec-vs-storage drift; nothing catches storage-vs-handler drift. Fix:
      generate the types, switch to `createClient<Database>()`, and add the
      generation step to `scripts/rebuild_artifacts.sh` so they cannot go
      stale — the same "an artifact is only canonical if something goes red
      when it lies" rule the rest of the cascade already follows. Expect real
      drift to light up on the first compile.

- [ ] **Give the money path real transaction boundaries.** There is no
      `BEGIN`/`COMMIT` anywhere under `api/`. `runGate` in `api/transfers.ts`
      issues its history query, its `control_result` inserts, the resource
      status update and its alerts as independent PostgREST round trips, and
      card capture calls Blnk over HTTP *before* updating the row — a failure
      in that window leaves Blnk and Postgres disagreeing, with correctness
      resting entirely on `blnk-reconcile/sweeps.ts` catching it after the
      fact. The drift rate scales with concurrency, so this gets worse with
      growth rather than staying flat. The fix pattern is already in-tree and
      unused by `api/`: the aggregator pushes atomic operations into Postgres
      functions (`rpc("originate", ...)` in `aggregator/handler.ts`). Decide
      per money operation whether it becomes a stored procedure or moves to a
      direct Postgres connection with a real transaction. Doing the latter
      also collapses the per-request round trips — supabase-js speaks
      PostgREST over HTTP, so every DB call is a network hop (`api/cda.ts`
      awaits 64, `api/cash_ops.ts` 56), and request latency is round-trip
      count × network latency regardless of runtime. Related, worth auditing
      in the same pass: only 11 handlers call `claimIdempotency` against 415
      mutating operations in the spec — establish how much of that gap is
      deliberate before Blnk's at-least-once webhook delivery makes it
      matter.

- [ ] **Move long-running work off Edge Functions.** Deno isolates are
      request/response shaped, but `blnk-reconcile/sweeps.ts` and the drill
      runner are batch jobs wearing a request costume. This is the runtime's
      first real wall — ahead of any throughput limit, since a narrow bank's
      API volume is well within V8's range — and the fix is a container, not
      a language. No action needed until the sweeps start timing out or the
      drill outgrows its window; flagged here so the trigger is recognized
      when it arrives rather than diagnosed as "TypeScript is too slow."
