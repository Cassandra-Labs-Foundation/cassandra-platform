#!/usr/bin/env python3
"""Generate the architecture explorer's full inventory from the canonical sources.

docs/architecture/model.json is a hand-traced slice (one BSA-06 path) whose
claims a human re-reads before restamping. This script produces its companion,
docs/architecture/system.json: the whole system, derived — never interpreted —
from artifacts that already go red when they lie:

  core/core-api.yaml            every operation, its handler module, audience,
                                tier and actors; state machines
  api/*.ts                      module purpose (header comment), imports,
                                handler line numbers
  crosswalk-emitted-events.json which module emits each event code
  controls.json / control-scope.json / control-tests*.json / crosswalk.json
                                every policy and control, its scope verdict,
                                hermetic + live status and reachability
  core/verifier/flows/*.test.ts which live flows call each operation (static
                                path match — a reference, not a test run)

Because the inventory is derived, it is complete by construction; the one
hand-authored input is DOMAINS (how modules group for a reader). A module
missing from it lands in "unclassified", which check_architecture.py fails.

  python3 scripts/gen_architecture.py           # write system.json
  python3 scripts/gen_architecture.py --check   # exit 1 if stale
"""
import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import spec_io  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
API = "core/supabase/functions/api/"
FLOWS = ROOT / "core/verifier/flows"
OUT = ROOT / "docs/architecture/system.json"
METHODS = ("get", "post", "put", "patch", "delete")

# How modules group for a reader. Domains are a documentation boundary, not a
# deployment one: every module here ships inside the single `api` edge function.
DOMAINS = [
    ("members", "Members & deposit products", "Who the members are, what they hold, and the protections owed to them",
     ["entities", "kyc", "accounts", "numbers", "deposits_member", "cda", "member_protection", "complaints", "privacy"]),
    ("payments", "Payments", "Every rail that moves money, and the gate they share",
     ["transfers", "ach", "wires", "cards", "cash", "eps", "eps_controls", "ecommerce"]),
    ("bsa", "BSA / AML", "Monitoring alerts, investigations, SAR decisions and the wider BSA program",
     ["bsa", "bsa_program"]),
    ("treasury", "Treasury & capital", "Liquidity, capital adequacy, investments and the institution's own cash",
     ["liquidity", "capital", "basel", "investment", "cash_ops"]),
    ("risk", "Risk, security & resilience", "Security operations, incidents, exceptions and recovery planning",
     ["ops_security", "incidents", "risk_exceptions", "resolution", "tail"]),
    ("governance", "Governance & records", "Board and audit oversight, people, records and the control record itself",
     ["governance", "audit", "hr", "records_admin", "retention", "controls", "dashboard"]),
    ("platform", "Platform & request path", "Routing, authentication, ownership, the event outbox and shared helpers",
     ["index", "auth", "ownership", "lib", "events", "primitives", "platform", "sandbox", "simulate", "test_helpers"]),
    ("lending", "Lending (deliberately unrouted)", "Credit origination kept out of the router: Pynthia is a narrow bank",
     ["lending", "lending_underwriting", "collections"]),
]

# Deployables beside the Core API. Descriptions come from each entrypoint's header.
FUNCTIONS = [
    ("aggregator", "Aggregator", "core/supabase/functions/aggregator/index.ts"),
    ("blnk-webhook", "Blnk webhook", "core/supabase/functions/blnk-webhook/index.ts"),
    ("blnk-reconcile", "Blnk reconciler", "core/supabase/functions/blnk-reconcile/index.ts"),
    ("drill", "Control drill", "core/supabase/functions/drill/run.ts"),
]


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def header(text):
    """The file's leading // comment block, joined into prose."""
    lines = []
    for line in text.splitlines():
        if line.startswith("//"):
            lines.append(line[2:].strip())
        elif lines or line.strip():
            break
    paras = " ".join(l if l else "\n" for l in lines).split("\n")
    return " ".join(p.strip() for p in paras if p.strip())[:600]


def line_of(text, pattern):
    m = re.search(pattern, text, re.MULTILINE)
    return text.count("\n", 0, m.start()) + 1 if m else 1


def flow_matchers(path):
    # same whole-path match as flow_select.py: {param} is a wildcard segment
    parts = re.split(r"\{[^}]+\}", path)
    rx = r"[^/\s\"'`]+".join(re.escape(x) for x in parts)
    return re.compile(r"[\"'`]" + rx + r"(?=[\"'`?])")


def build():
    spec = spec_io.load_spec(ROOT / "core/core-api.yaml")
    spec_text = read("core/core-api.yaml")
    flows = {p.stem.removesuffix(".test"): p.read_text() for p in sorted(FLOWS.glob("*.test.ts"))}

    module_files = sorted(p.stem for p in (ROOT / API).glob("*.ts")
                          if not p.name.endswith(".test.ts") and not p.name.endswith(".gen.ts"))
    sources = {m: read(API + m + ".ts") for m in module_files}
    modules = {}
    for m in module_files:
        text = sources[m]
        imports = sorted({i for i in re.findall(r'from\s+"\./([a-z_]+)\.ts"', text) if i != m})
        exports = re.findall(r"^export\s+(?:async\s+)?function\s+(\w+)", text, re.MULTILINE)
        modules[m] = {"file": API + m + ".ts", "lines": text.count("\n") + 1, "about": header(text), "exports": exports,
                      "imports": imports, "importedBy": [], "ops": [], "events": [], "controls": [], "gate": [], "flows": []}
    for m, mod in modules.items():
        for i in mod["imports"]:
            if i in modules:
                modules[i]["importedBy"].append(m)

    ops = {}
    for path, item in spec["paths"].items():
        path_line = line_of(spec_text, r"^  " + re.escape(path) + r":\s*$")
        for method, op in item.items():
            if method not in METHODS or not isinstance(op, dict):
                continue
            handler = str(op.get("x-handler", ""))
            module, _, fn = handler.partition(".")
            module = module if module in modules else "index"
            op_id = f"{method.upper()} {path}"  # operationIds are not unique (post_payment_approval)
            rx = flow_matchers(path)
            hit = sorted(f for f, text in flows.items() if rx.search(text))
            ops[op_id] = {
                "method": method.upper(), "path": path, "summary": op.get("summary", ""),
                "operationId": op.get("operationId"),
                "module": module, "handler": handler, "audience": op.get("x-audience"),
                "tier": op.get("x-tier"), "actors": op.get("x-actors") or [],
                "route": op.get("x-route", "generated"), "ui": bool(op.get("x-ui-surface")),
                "specLine": path_line,
                "handlerLine": line_of(sources[module], r"export\s+(async\s+)?function\s+" + re.escape(fn) + r"\b") if fn else 1,
                "flows": hit,
            }
            modules[module]["ops"].append(op_id)
            modules[module]["flows"] = sorted(set(modules[module]["flows"]) | set(hit))

    emitted = json.loads(read("crosswalk-emitted-events.json"))
    emitters = {}
    for row in emitted["literal"] + emitted["templated"]:
        # "file:line", or a bare file when the code is emitted from many sites
        src, ln = re.match(r"(.+?)(?::(\d+))?$", row["source"]).groups()
        if src.startswith(API):
            for code in row.get("expands_to") or [row["code"]]:
                emitters.setdefault(code, []).append([pathlib.Path(src).stem, int(ln or 1)])
    for code, sites in emitters.items():
        for m, _ in sites:
            if m in modules and code not in modules[m]["events"]:
                modules[m]["events"].append(code)

    catalogue = json.loads(read("controls.json"))["controls"]
    scope = json.loads(read("control-scope.json"))["scope"]
    hermetic = {r["uid"]: r for r in json.loads(read("control-tests.json"))["results"]}
    live = {r["uid"]: r for r in json.loads(read("control-tests-live.json"))["results"]}
    reach = {(r["policy"], r["control_id"]): r for r in json.loads(read("crosswalk.json"))["reachability"]}
    traced = json.loads(read("docs/architecture/model.json")).get("control")

    policies, controls = {}, {}
    for c in catalogue:
        pid = c["policy"]
        if pid not in policies:
            text = read(c["source_file"])
            t = re.search(r"^title:\s*(.+)$", text, re.MULTILINE)
            policies[pid] = {"title": t.group(1).strip() if t else pid, "file": c["source_file"], "controls": []}
        policies[pid]["controls"].append(c["uid"])
        rules = c.get("control_rules") or []
        triggers = sorted({r["trigger_event"] for r in rules if r.get("trigger_event")})
        produced = sorted({e for r in rules for e in r.get("produced_events") or []})
        codes = sorted(set(triggers) | set(produced) | set(c["api_references"].get("events") or []))
        touched = sorted({m for code in codes for m, _ in emitters.get(code, []) if m in modules})
        for m in touched:
            modules[m]["controls"].append(c["uid"])
        h, lv, rc = hermetic.get(c["uid"], {}), live.get(c["uid"], {}), reach.get((pid, c["control_id"]), {})
        controls[c["uid"]] = {
            "id": c["control_id"], "title": c["title"], "policy": pid,
            "policyLine": line_of(read(c["source_file"]), r"^#+\s+" + re.escape(c["control_id"]) + r"\b"),
            "citations": [x["text"] for x in c.get("regulatory_citations") or []],
            "behavior": re.sub(r"\s+", " ", c.get("system_behavior") or "")[:700],
            "scope": scope.get(c["uid"], {}).get("verdict", "unknown"),
            "scopeWhy": scope.get(c["uid"], {}).get("why", ""),
            "hermetic": h.get("status"), "live": lv.get("status"), "blockedOn": h.get("blocked_on"),
            "reachability": rc.get("reachability"),
            "triggers": [[code, sorted({m for m, _ in emitters.get(code, [])})] for code in triggers],
            "produced": [[code, sorted({m for m, _ in emitters.get(code, [])})] for code in produced],
            "modules": touched,
            "traced": c["uid"] == traced,
        }

    # The crosswalk's reviewed claims: which gate (CG-*) controls each module
    # implements and which catalogue controls they discharge. Hand-authored
    # upstream, so the explorer labels them as claims, not derivations.
    by_id = {}
    for uid in controls:
        by_id.setdefault(uid.split(":", 1)[1], []).append(uid)
    for row in json.loads(read("crosswalk.json"))["mappings"]["mappings"]:
        m = pathlib.Path(row["implementation"]["source"]).stem
        if m not in modules:
            continue
        claims = []
        for c in row["claims"]:
            ref = c.get("catalogue_control")
            uid = ref if ref in controls else (by_id.get(ref) or [None])[0] if ref and len(by_id.get(ref, [])) == 1 else None
            claims.append([uid, c["verdict"]])
            if uid:
                controls[uid].setdefault("gate", []).append([row["cg_control"], m, c["verdict"]])
        modules[m]["gate"].append({"id": row["cg_control"], "behaviour": row["implementation"]["behaviour"], "claims": claims})
    for c in controls.values():
        c.setdefault("gate", [])

    domain_of = {m: d[0] for d in DOMAINS for m in d[3]}
    domains = [{"id": d, "title": t, "about": a, "modules": [m for m in ms if m in modules]} for d, t, a, ms in DOMAINS]
    stray = [m for m in modules if m not in domain_of]
    if stray:
        domains.append({"id": "unclassified", "title": "Unclassified", "about": "Add these modules to DOMAINS in scripts/gen_architecture.py", "modules": stray})
    for m in modules.values():
        m["events"].sort()

    machines = {name: states for name, states in spec["x-state-machines"].items()}
    pages = sorted(str(p.relative_to(ROOT / "ui/src/pages")) for p in (ROOT / "ui/src/pages").rglob("*.jsx")
                   if not p.name.startswith("_"))
    containers = [
        {"id": "api", "title": "Core API", "kind": "Supabase edge function · Deno",
         "about": f"{len(ops)} operations across {len(modules)} modules", "href": "#/api"},
        *[{"id": fid, "title": t, "kind": "Supabase edge function · Deno", "about": header(read(f)), "file": f,
           "href": "#/container/" + fid} for fid, t, f in FUNCTIONS],
        {"id": "postgres", "title": "Postgres", "kind": "Supabase Postgres · core schema",
         "about": f"{len(list((ROOT / 'core/supabase/migrations').glob('*.sql')))} migrations · {len(machines)} declared state machines",
         "href": "#/container/postgres"},
        {"id": "blnk", "title": "Blnk ledger", "kind": "External ledger service",
         "about": "Source of truth for balances; the Core API posts to it and the webhook + reconciler mirror it back",
         "href": "#/container/blnk"},
        {"id": "ui", "title": "Staff console", "kind": "Next.js on Vercel",
         "about": f"{len(pages)} pages · reads {sum(o['ui'] for o in ops.values())} UI-surface operations through a read-only proxy",
         "href": "#/container/ui"},
        {"id": "policy", "title": "Policies & controls", "kind": "Compliance catalogue",
         "about": f"{len(policies)} policies · {len(controls)} controls", "href": "#/policy"},
        {"id": "pipeline", "title": "Specification & evidence", "kind": "Repository toolchain",
         "about": "The ordered rebuild that derives every artifact, this map included", "href": "#/pipeline"},
    ]
    return {
        "_comment": "GENERATED by scripts/gen_architecture.py from the spec, controls and source. Do not edit.",
        "counts": {"operations": len(ops), "modules": len(modules), "policies": len(policies), "controls": len(controls),
                   "events": len(emitters), "flows": len(flows)},
        "containers": containers, "domains": domains, "modules": modules, "operations": ops,
        "policies": policies, "controls": controls, "machines": machines, "pages": pages,
    }


def render(doc):
    return json.dumps(doc, indent=1, sort_keys=False, ensure_ascii=False) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="exit 1 if system.json is stale")
    args = ap.parse_args()
    text = render(build())
    if args.check:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print("docs/architecture/system.json is stale; run python3 scripts/gen_architecture.py")
            return 1
        print("docs/architecture/system.json is current.")
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
