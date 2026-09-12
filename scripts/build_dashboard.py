#!/usr/bin/env python3
"""Generate the compliance catalogue manifest from controls.json.

The banking UI's compliance monitoring pages (ui/src/pages/compliance/
dashboard/) render policy -> controls in place, reading this manifest as a
static asset. It is generated from the same controls.json the crosswalk builds
from — so the rendered catalogue can never drift from the source without CI
noticing.

  python3 scripts/build_dashboard.py           # regenerate the manifest
  python3 scripts/build_dashboard.py --check   # fail if it is stale

Output:
  ui/public/compliance-manifest.json   policy -> controls (id, title, watch
                                       codes, citations, test verdicts, prose)

Until 2026-09 this also generated a standalone GitHub-Pages dashboard under
compliance/dashboard/ (a shared app + one HTML stub per policy). That was
retired when the dashboard became native in the UI; only the manifest survives,
and the UI is the one renderer of it now.
"""
import functools
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTROLS = ROOT / "controls.json"
POLICIES = ROOT / "compliance" / "policies"

TITLES = {
    "audit": "Audit",
    "basel-ii-standardized-approach-framework": "Basel II Standardized Approach",
    "bsa": "BSA / AML",
    "business-continuity-plan": "Business Continuity",
    "capitalization": "Capitalization",
    "cash": "Cash Operations",
    "charitable-donation-accounts": "Charitable Donation Accounts",
    "collections": "Collections",
    "compliance": "Compliance Program",
    "director-fiduciary-duties": "Director Fiduciary Duties",
    "e-commerce": "E-Commerce",
    "electronic-payment-systems": "Electronic Payment Systems",
    "enterprise-risk-management": "Enterprise Risk Management",
    "fair-lending": "Fair Lending",
    "information-security": "Information Security",
    "internal-controls": "Internal Controls",
    "investment": "Investments",
    "lending": "Lending",
    "liquidity": "Liquidity",
    "member": "Membership",
    "privacy": "Privacy",
    "record-retention": "Record Retention",
    "reimbursement-insurance-indemnification": "Reimbursement & Indemnification",
    "resolution": "Resolution",
    "shared-controls": "Shared Controls",
    "third-party-risk": "Third-Party Risk",
    "truth-in-savings": "Truth in Savings",
}

REPO_BLOB = (
    "https://github.com/Cassandra-Labs-Foundation/cassandra-platform/blob/main/"
)

def title_for(slug: str, policy_title: str | None) -> str:
    # the hand-kept map wins: source-doc titles leak internal working names
    # ("... Policy (Table-First, Design-Overlay v2)")
    if slug in TITLES:
        return TITLES[slug]
    if policy_title:
        return policy_title
    return slug.replace("-", " ").title()


# Feature: the dashboard renders the policy in place (its General Policy
# Statement + who owns it), instead of bouncing the reader to GitHub. The
# authoritative text is the policy markdown, so we lift it straight from
# compliance/policies/<slug>/<slug>.md — never a second copy that could drift.
_FRONT_KEYS = ("title", "owner", "version", "effective", "next_review")


def _frontmatter(text: str) -> dict[str, str]:
    """Parse the leading frontmatter block. Two shapes exist in the corpus: a
    ```yaml fenced block (most files) and a bare `---` block (charitable-
    donation-accounts). Handle both; we only need a handful of scalar keys."""
    lines = text.splitlines()
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i >= len(lines):
        return {}
    opener = lines[i].strip()
    if opener in ("```yaml", "```yml"):
        close, i = "```", i + 1
    elif opener == "---":
        close, i = "---", i + 1
    else:
        return {}
    out: dict[str, str] = {}
    while i < len(lines) and lines[i].strip() != close:
        m = re.match(r"([a-z_]+):\s*(.*)$", lines[i])
        if m and m.group(1) in _FRONT_KEYS and m.group(2).strip():
            out[m.group(1)] = m.group(2).strip()
        i += 1
    return out


def _general_statement(text: str) -> str:
    """The prose under `## General Policy Statement`, up to the next h2 or the
    `---` rule that closes the section. Returned as raw markdown; the dashboard
    renders it."""
    lines = text.splitlines()
    body: list[str] = []
    capturing = False
    for ln in lines:
        if re.match(r"^##\s+General Policy Statement", ln):
            capturing = True
            continue
        if capturing:
            if re.match(r"^##\s", ln) or re.match(r"^---\s*$", ln):
                break
            body.append(ln)
    return "\n".join(body).strip()


@functools.cache
def policy_source(slug: str) -> dict:
    """Owner/version/dates + the General Policy Statement for one policy, from
    its markdown. Synthetic policies (money-movement-gate) and aggregates with
    no single source doc (shared-controls) simply have none — the dashboard
    falls back gracefully."""
    md = POLICIES / slug / f"{slug}.md"
    if not md.exists():
        return {}
    text = md.read_text()
    fm = _frontmatter(text)
    out: dict[str, str] = {}
    for k in ("owner", "version", "effective", "next_review"):
        if fm.get(k):
            out[k] = fm[k]
    stmt = _general_statement(text)
    if stmt:
        out["statement"] = stmt
    return out


# The six gate controls are the RUNTIME layer — born in the banking core
# before the catalogue existed, enforced on every money movement, and the
# bulk of live evidence. They get their own page rather than being invisible.
GATE_POLICY = {
    "slug": "money-movement-gate",
    "title": "Money-Movement Gate (runtime)",
    "controls": [
        {"id": "CG-VEL-01", "title": "Cross-rail daily velocity cap ($25k/day, blocks)"},
        # Renamed from CG-CTR-01 (OQ-01, 2026-08-11): fires on electronic
        # movements only, none CTR-reportable — the old name asserted a filing
        # regime it never touched. Historical control_result rows keep the old id.
        {"id": "CG-LGTXN-01", "title": "Large electronic transaction monitor (> $10k, alert-only)"},
        {"id": "CG-STR-01", "title": "Inbound structuring — aggregate past $10k into one account"},
        {"id": "CG-STR-02", "title": "Outbound structuring — aggregate past $10k out of one account"},
        {"id": "CG-NSF-01", "title": "Insufficient funds (rejects before any hold)"},
        # STUB designation (OQ-02, 2026-08-11): the gate mechanism is real and
        # unbypassable, but the screen underneath is a literal /\bSDN\b/ token
        # match — no sanctions list, no list version, no payment-time screening.
        # The title must say so until a real SDN feed lands (TODO §8).
        {"id": "CG-OFAC-01", "title": "OFAC floor — unbypassable gate, STUB screen (no SDN list wired)", "stub": True},
    ],
}


def load_verdicts() -> dict[str, dict]:
    """Per-uid test verdicts from the two baselines the drill maintains.

    hermetic = control-tests.json (fake DB, frozen clock); live =
    control-tests-live.json (same spec against the real database). The
    dashboard shows both so an examiner sees the CLAIM (hermetic green), the
    PROOF (live green) and the gap between them (the fake-vs-real backlog).
    """
    out: dict[str, dict] = {}
    for tier, fname in (("hermetic", "control-tests.json"), ("live", "control-tests-live.json")):
        path = ROOT / fname
        if not path.exists():
            continue
        for r in json.loads(path.read_text())["results"]:
            v = out.setdefault(r["uid"], {
                "scoped_out": bool(r.get("scoped_out")),
                "scope_reason": r.get("scope_reason"),
            })
            v[tier] = r["status"]
    return out


def build_manifest() -> dict:
    data = json.loads(CONTROLS.read_text())
    verdicts = load_verdicts()
    policies: dict[str, dict] = {}
    for c in data["controls"]:
        slug = c["policy"]
        p = policies.setdefault(slug, {
            "slug": slug,
            "title": title_for(slug, c.get("policy_title")),
            **policy_source(slug),
            "controls": [],
        })
        # the monitoring spec: what the heartbeat watches for this control —
        # trigger + produced event codes from the control's own rules, the
        # same codes the per-control tests fire and grade against
        rules = []
        watch: set[str] = set()
        for r in c.get("control_rules", []):
            trig = r.get("trigger_event")
            produced = r.get("produced_events", [])
            if trig:
                watch.add(trig)
            watch.update(produced)
            rules.append({
                "trigger": trig,
                "produced": produced,
                "inputs": r.get("required_inputs", []),
                "timer": r.get("deadline_timer"),
                "deadline_text": r.get("deadline_text"),
            })
        p["controls"].append({
            "id": c["control_id"],
            "uid": c["uid"],
            "title": c["title"],
            "doc": REPO_BLOB + c["source_file"] + "#" + c["anchor"],
            # the control's own words, lifted from controls.json (itself
            # extracted from the policy markdown) so the dashboard can explain
            # WHY a control exists and HOW the system honours it, in place —
            # no round-trip to GitHub to read the policy.
            "why": c.get("why_text") or "",
            "system_behavior": c.get("system_behavior") or "",
            "citations": [
                {"text": r["text"], "url": r.get("url")}
                for r in c.get("regulatory_citations", [])
            ],
            "watch": sorted(watch),
            "rules": rules,
            "tests": verdicts.get(c["uid"], {}),
        })
    gate = {
        "slug": GATE_POLICY["slug"],
        "title": GATE_POLICY["title"],
        "controls": [
            {
                "id": c["id"],
                "uid": "money-movement-gate:" + c["id"],
                "title": c["title"],
                "stub": c.get("stub", False),
                "doc": REPO_BLOB + "core/supabase/functions/api/transfers.ts",
                "citations": [],
                # the gate's evidence is core.control_result, not produced
                # events — its heartbeat rides gate_heartbeat by control id
                "watch": [],
                "rules": [],
                "tests": {},
            }
            for c in GATE_POLICY["controls"]
        ],
    }
    ordered = sorted([*policies.values(), gate], key=lambda p: p["title"].lower())
    return {
        "generated_from": "controls.json + the runtime gate (build_dashboard.py)",
        "policy_count": len(ordered),
        "control_count": sum(len(p["controls"]) for p in ordered),
        "policies": ordered,
    }


def desired_files(manifest: dict) -> dict[pathlib.Path, str]:
    # The banking UI's compliance monitoring pages read this manifest as a
    # static asset (ui/public/compliance-manifest.json). Generated from the same
    # controls.json the crosswalk builds from, and gated by --check below so the
    # rendered catalogue can never drift from the source of truth.
    manifest_json = json.dumps(manifest, indent=1) + "\n"
    return {ROOT / "ui" / "public" / "compliance-manifest.json": manifest_json}


def main() -> int:
    check = "--check" in sys.argv
    manifest = build_manifest()
    files = desired_files(manifest)

    stale = []
    for path, content in files.items():
        current = path.read_text() if path.exists() else None
        if current != content:
            stale.append(str(path.relative_to(ROOT)))
            if not check:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)

    if check:
        if stale:
            print("dashboard build STALE — run scripts/build_dashboard.py:")
            for s in stale:
                print(f"  - {s}")
            return 1
        print(
            f"dashboard OK — {manifest['policy_count']} policies, "
            f"{manifest['control_count']} controls"
        )
        return 0

    print(
        f"wrote ui/public/compliance-manifest.json — "
        f"{manifest['policy_count']} policies, {manifest['control_count']} controls"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
