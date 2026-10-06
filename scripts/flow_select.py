#!/usr/bin/env python3
"""Pick the live flows a change touches, for `scripts/flow.sh --changed`.

Prints one flow file per line (core/verifier/flows/<name>.test.ts), or ALL.

A changed file maps to flows through three signals, unioned:
  1. the spec: an api handler module's x-handler paths -> flows that call
     those paths (static prefix before the first `{`);
  2. the ledgers: core/verifier/flows/ledger/<module>.md names the flows that
     replaced that module's stubs;
  3. the file itself: a changed flow file runs; helpers.ts runs everything.

Core-wide files (the payment gate, auth, routing, shared Blnk client, lib,
migrations, the spec) select ALL — guessing narrower there is how a
regression slips through.

  scripts/flow_select.py            # vs HEAD, plus untracked files
  scripts/flow_select.py origin/main
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FLOWS = ROOT / "core/verifier/flows"
API = "core/supabase/functions/api/"

CORE_WIDE = [
    "core/supabase/functions/_shared/",
    API + "transfers.ts",      # runGate: every rail goes through it
    API + "auth.ts",
    API + "lib.ts",
    API + "index.ts",
    API + "routes.gen.ts",
    API + "ownership.ts",
    API + "bsa.ts",            # provenanceFor / raiseAlert, used everywhere
    "core/supabase/migrations/",
    "core/core-api.yaml",
    "core/supabase/config.toml",
    "core/verifier/flows/helpers.ts",
]

# functions outside api/ that have no x-handler mapping
FUNCTION_FLOWS = {
    "core/supabase/functions/blnk-webhook/": ["ledger-integrity", "cards", "ach", "wires", "transfers", "accounts"],
    "core/supabase/functions/blnk-reconcile/": ["ledger-integrity", "cards"],
    "core/supabase/functions/aggregator/": ["aggregator", "origination", "platform"],
}


def changed_files(base: str | None) -> list[str]:
    def git(*args: str) -> list[str]:
        out = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout
        return [l for l in out.splitlines() if l]
    files = set(git("diff", "--name-only", base or "HEAD"))
    files |= set(git("ls-files", "--others", "--exclude-standard"))
    return sorted(files)


def all_flows() -> list[str]:
    return sorted(p.stem.removesuffix(".test") for p in FLOWS.glob("*.test.ts"))


def flows_calling(patterns: list[re.Pattern[str]], flows: list[str]) -> set[str]:
    hit = set()
    for f in flows:
        text = (FLOWS / f"{f}.test.ts").read_text()
        if any(p.search(text) for p in patterns):
            hit.add(f)
    return hit


def module_paths(module: str) -> list[re.Pattern[str]]:
    """One regex per spec path whose x-handler lives in `module`.

    The WHOLE path is matched, with `{param}` as a wildcard segment, so
    /entities/{id}/verifications selects the flows that verify, not every
    flow that touches /entities. Flows write paths as string or template
    literals, so a segment wildcard also matches `${expr}`.
    """
    import yaml  # local import: only --changed needs it
    spec = yaml.safe_load((ROOT / "core/core-api.yaml").read_text())
    out = []
    for path, ops in (spec.get("paths") or {}).items():
        for op in (ops or {}).values():
            if isinstance(op, dict) and str(op.get("x-handler", "")).split(".")[0] == module:
                parts = re.split(r"\{[^}]+\}", path)
                rx = r"[^/\s\"'`]+".join(re.escape(x) for x in parts)
                out.append(re.compile(r"[\"'`]" + rx + r"(?=[\"'`?])"))
    return out


def ledger_flows(module: str, flows: list[str]) -> set[str]:
    ledger = FLOWS / "ledger" / f"{module}.md"
    if not ledger.exists():
        return set()
    named = set(re.findall(r"([a-z_-]+)\.test\.ts", ledger.read_text()))
    return {n for n in named if n in flows}


def select(files: list[str]) -> set[str] | None:
    flows = all_flows()
    picked: set[str] = set()
    for f in files:
        if any(f == w or f.startswith(w) for w in CORE_WIDE):
            return None  # ALL
        if f.startswith("core/verifier/flows/") and f.endswith(".test.ts"):
            picked.add(Path(f).name.removesuffix(".test.ts"))
            continue
        for prefix, names in FUNCTION_FLOWS.items():
            if f.startswith(prefix):
                picked |= set(names)
        if f.startswith(API) and f.endswith(".ts") and not f.endswith(".test.ts"):
            module = Path(f).stem
            picked |= flows_calling(module_paths(module), flows)
            picked |= ledger_flows(module, flows)
    return picked & set(flows)


if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 else None
    chosen = select(changed_files(base))
    if chosen is None:
        print("ALL")
    else:
        for name in sorted(chosen):
            print(f"core/verifier/flows/{name}.test.ts")
