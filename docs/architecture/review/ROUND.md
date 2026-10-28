# Design round: the prompt

Paste this into a Claude Code session at the repository root to run one improvement round on the explorer's diagrams, hierarchy and documentation structure. Running the same prompt each time is what makes rounds comparable.

```text
Run one design round on the architecture explorer. Use the visual-control-architecture skill.

1. Baseline. Run `cd docs/architecture/e2e && npm run shots -- <scratch>/before` and read every screenshot and scores.md. Read the latest rows of docs/architecture/review/history.md for the comprehension score and the questions it missed.
2. Rank. Pick the three worst views. Weigh, in this order: questions the blind reader missed that depend on the view; a fake level (a page that only repeats its parent's box); text said twice on one page; a resting picture with parallel wires, row-skipping arrows or labels on frames; page height far above the others.
3. Question, delete, simplify. For each view, first ask whether the part should exist at all, then delete, then simplify what is left. Fix the cause in gen_architecture.py, inventory.mjs, explorer.mjs or diagram.mjs; never hand-place a box or edit a generated file.
4. Lock it in. For each problem fixed, add or tighten a check in docs/architecture/e2e/explorer.e2e.mjs so it cannot come back. Record any new design rule in .skills/visual-control-architecture/SKILL.md.
5. Compare. Run the sweep again into <scratch>/after. Build one before/after page for the three views with both score tables, publish it, and send me the link. Keep a change only if its target improved and no other view got worse.
6. After I approve: run the gates (gen_architecture --check, check_architecture, navigation tests, check_doc_claims, gen_state --check) and the E2E suite, commit and push to main, then rerun the E2E suite against the live Pages URL and report.
```

The weekly review (`.github/workflows/architecture-review.yml`) supplies the comprehension score this prompt starts from; a round can also be run right after a review whose score dropped.
