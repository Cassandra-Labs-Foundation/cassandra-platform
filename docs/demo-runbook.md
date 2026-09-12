# Running the demo

Everything below runs against the live stack. Nothing is mocked, and no step
is a slideshow — `demo.sh` asserts every claim it narrates and exits non-zero
if any of them stops being true.

## The 60-second version

```bash
./core/supabase/tests/e2e/demo.sh    # from the repo root
```

Then open the dashboard it prints at the end.

## The full runbook

### The day before

1. **Confirm the stack is green.** ~12 minutes, and it is the only thing that
   actually tells you the demo will work:
   ```bash
   ./core/supabase/tests/e2e/compliance_e2e.sh    # ~397 live assertions, run from the repo root
   ```
   Section 48 runs `demo.sh` itself, so a green harness means a green demo.

2. **Decide about the debris.** Months of test runs leave real state behind —
   stranded dual-control wires, alerts past their triage clock. That state is
   *honest* (it is what an unattended sandbox looks like), but it invites
   "why are 80 payments stuck?" mid-demo. To start from a clean slate:
   ```bash
   curl -sS -X POST "$API/sandbox/reset" -H "X-Api-Key: $DEMO_API_KEY" \
     -H 'content-type: application/json' -d '{"confirm":"RESET"}'
   ```
   This is **destructive**: it wipes instance tables and releases every open
   hold first, so no member funds strand. Blnk ledger history survives — Blnk
   Cloud has no wipe API — which is why fresh runs mint fresh accounts.
   Then run `demo.sh` once to lay down clean, coherent evidence.

3. **Warm the dashboard** in a browser tab. First load after a deploy is slow
   (cold edge function); every load after is instant.

### In the room

Run `./core/supabase/tests/e2e/demo.sh` with the default pacing — it narrates
itself, one beat at a time:

| Beat | What it proves |
|---|---|
| 1 | Every entity is screened; the OFAC floor refuses a sanctioned name **even with a full-trust partner attestation** |
| 2 | Money moves, and every movement books double-entry evidence |
| 3 | A $11k transfer **settles and alerts** — reportable is not forbidden |
| 4 | Three legal $4k transfers assemble into a structuring pattern the system sees |
| 5 | An investigator escalates; a **different** officer decides; both barriers (wrong-duty 403, own-case 409) are shown |
| 6 | The ledger still balances |
| 7 | An officer sees all of it without asking an engineer |

Then switch to the dashboard and drill: overview → **BSA / AML** → the alert
that beat 4 just raised, with its triage clock. Or → **Money-Movement Gate**
to show the runtime controls and their live fire counts.

### If something breaks live

- **A step 500s.** `demo.sh` prints the failing check and keeps going, so the
  narrative survives one bad beat. Say what happened — the audience for a
  compliance system respects a visible failure more than a smooth lie.
- **The dashboard says "cannot reach the API".** Cold start; reload once.
- **Everything 500s.** Almost certainly an env/secret problem on the function
  rather than logic — check `INSTANCE_ID` is set (see
  `core/supabase/functions/api/README.md`).

## What to say, and what not to

Be precise about two things, because both are visible and someone will ask:

- **OFAC screening is a mechanism, not a list.** The enforcement machinery is
  real — always-on, unbypassable, evidence on every run, and it survives a
  full-trust attestation. But the comparison set is a sandbox stub matching
  the literal token `SDN`. Say "here is the enforcement a real list plugs
  into," never "we screen for sanctions."
- **KYC providers are simulations behind a real adapter.** The seam is
  production-shaped; Alloy/Socure/Middesk are deterministic sims.

The **red controls** are a feature of the story, not a hole in it. The
hermetic tier is fully green for everything in scope; what stays red is
either on the live tier (fake-vs-real divergence still being worked) or out
of scope because it needs organizational facts (an HR feed, ALCO limits, a
member vote) or feeds from systems this one does not run (SIEM, backups,
pentests). `red_by_reason` in `control-tests.json` says why, per control.
They are visibly red rather than quietly fabricated, which is the whole
posture.

## URLs

| | |
|---|---|
| Dashboard | https://cassandra-platform.vercel.app/compliance/dashboard |
| Same, via the API | `{API}/compliance/dashboard` (302s to the above) |
| API base | https://jynsipdvrgqdkeqrlzcv.functions.supabase.co/api |

Both the console and the core's data route load with **no credential** — a
deliberate demo posture (synthetic data). The core data route's re-locking
recipe is in `core/supabase/functions/api/dashboard.ts`; the console's own
access can be gated at the host (see `ui/DEPLOY.md`).
