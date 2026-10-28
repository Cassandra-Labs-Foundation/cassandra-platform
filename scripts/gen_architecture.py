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
  functions/<fn>/*.ts           the other edge functions' files and exports
  core/supabase/migrations/*.sql every table and its columns, replayed in order
  ui/src/pages/**/*.jsx         every console page and the operations it names
  scripts/rebuild_artifacts.sh  the pipeline's actual steps, in their order

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
# Not deployables, but code the deployables import or schedule.
SHARED = ("_shared", "Shared function code", "core/supabase/functions/_shared/blnk.ts")
ANALYTICS = "analytics"


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


def header_any(text):
    """Leading comment block of a TS (//), shell (#) or SQL (--) file."""
    lines = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("#!") and not lines:
            continue
        m = re.match(r"(//|--|#)\s?(.*)$", s)
        if m:
            lines.append(m.group(2).strip())
        elif lines or s:
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


def exports_of(text):
    return [[m.group(1), text.count("\n", 0, m.start()) + 1]
            for m in re.finditer(r"^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)", text, re.MULTILINE)]


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
    emitters, emit_sites = {}, {}
    for row in emitted["literal"] + emitted["templated"]:
        # "file:line", or a bare file when the code is emitted from many sites
        src, ln = re.match(r"(.+?)(?::(\d+))?$", row["source"]).groups()
        for code in row.get("expands_to") or [row["code"]]:
            site = [src, int(ln or 1)]
            if site not in emit_sites.setdefault(code, []):
                emit_sites[code].append(site)
            if src.startswith(API):
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

    # --- the other edge functions: every file, its header, exports and imports
    files, fn_texts = {}, {}
    for fid in [f[0] for f in FUNCTIONS] + [SHARED[0]]:
        for p in sorted((ROOT / "core/supabase/functions" / fid).glob("*.ts")):
            text = p.read_text(encoding="utf-8")
            rel = f"{fid}/{p.name}"
            fn_texts[rel] = text
            files[rel] = {"fn": fid, "file": f"core/supabase/functions/{rel}", "lines": text.count("\n") + 1,
                          "about": header(text), "exports": exports_of(text), "test": p.name.endswith(".test.ts"),
                          "imports": sorted({i for i in re.findall(r'from\s+"\./([\w.]+)\.ts"', text) if i + ".ts" != p.name}),
                          # imports that cross into another function directory: ../api/bsa.ts -> "api/bsa.ts"
                          "crossImports": sorted(set(re.findall(r'from\s+"\.\./([\w-]+/[\w.]+\.ts)"', text)))}
    for p in sorted([*(ROOT / ANALYTICS).glob("*.sh"), *(ROOT / ANALYTICS).glob("*.sql")]):
        text = p.read_text(encoding="utf-8")
        rel = f"{ANALYTICS}/{p.name}"
        fn_texts[rel] = text
        files[rel] = {"fn": ANALYTICS, "file": rel, "lines": text.count("\n") + 1, "about": header_any(text),
                      "exports": [], "test": False,
                      "imports": sorted({i for i in re.findall(r"analytics/([\w.]+\.(?:sh|sql))", text) if i != p.name}),
                      "crossImports": []}
    for m in modules:
        modules[m]["crossImports"] = sorted(set(re.findall(r'from\s+"\.\./([\w-]+/[\w.]+\.ts)"', sources[m])))

    # --- postgres: replay the migrations in order; creates define, alters add, drops remove
    tables = {}
    for p in sorted((ROOT / "core/supabase/migrations").glob("*.sql")):
        text = p.read_text(encoding="utf-8")
        rel = "core/supabase/migrations/" + p.name
        for m in re.finditer(r'create table (?:if not exists )?"?(\w+)"?\."?(\w+)"?\s*\(', text, re.IGNORECASE):
            end = text.find("\n);", m.end())
            body = text[m.end():end] if end > -1 else ""
            cols = [[c.group(1), c.group(2).strip().rstrip(",")]
                    for c in re.finditer(r'^\s*"(\w+)"\s+([^\n]+)', body, re.MULTILINE)]
            tables[f"{m.group(1)}.{m.group(2)}"] = {
                "schema": m.group(1), "name": m.group(2), "migration": rel,
                "line": text.count("\n", 0, m.start()) + 1, "columns": cols}
        for m in re.finditer(r'alter table (?:if exists )?"?(\w+)"?\."?(\w+)"?\s+add column (?:if not exists )?"?(\w+)"?\s+([^,;\n]+)',
                             text, re.IGNORECASE):
            t = tables.get(f"{m.group(1)}.{m.group(2)}")
            if t and m.group(3) not in [c[0] for c in t["columns"]]:
                t["columns"].append([m.group(3), m.group(4).strip()])
        for m in re.finditer(r'drop table (?:if exists )?"?(\w+)"?\."?(\w+)"?', text, re.IGNORECASE):
            tables.pop(f"{m.group(1)}.{m.group(2)}", None)
    fk_rx = re.compile(r'alter table "?(\w+)"?\."?(\w+)"? add constraint "?\w+"? foreign key \("?(\w+)"?\) '
                       r'references "?(\w+)"?\."?(\w+)"?', re.IGNORECASE)
    for p in sorted((ROOT / "core/supabase/migrations").glob("*.sql")):
        for m in fk_rx.finditer(p.read_text(encoding="utf-8")):
            src_t, dst = tables.get(f"{m.group(1)}.{m.group(2)}"), f"{m.group(4)}.{m.group(5)}"
            if src_t and dst in tables and [m.group(3), dst] not in src_t.setdefault("fks", []):
                src_t["fks"].append([m.group(3), dst])
    by_name = {}
    for key, t in tables.items():
        by_name.setdefault(t["name"], []).append(key)

    def table_refs(text):
        """Tables a source names, schema resolved from its call chain (static only)."""
        refs, chained = set(), set()
        # db.schema("core").from("account"), or a ternary that names several schemas
        for m in re.finditer(r'schema\(([^)]*)\)\s*\.from\(\s*["\'](\w+)["\']', text):
            chained.add(m.start(2))
            for sch in re.findall(r'["\'](\w+)["\']', m.group(1)):
                if f"{sch}.{m.group(2)}" in tables:
                    refs.add(f"{sch}.{m.group(2)}")
        # a bare .from("x") uses the client's schema: core when it exists there
        for m in re.finditer(r'\.from\(\s*["\'](\w+)["\']', text):
            if m.start(1) not in chained:
                keys = by_name.get(m.group(1), [])
                refs |= {f"core.{m.group(1)}"} if f"core.{m.group(1)}" in tables else set(keys)
        # SQL / shell: "schema"."name" or schema.name
        for m in re.finditer(r'"?\b(\w+)"?\."?(\w+)\b"?', text):
            if f"{m.group(1)}.{m.group(2)}" in tables:
                refs.add(f"{m.group(1)}.{m.group(2)}")
        return refs

    module_refs = {m: table_refs(s) for m, s in sources.items()}
    file_refs = {rel: table_refs(s) for rel, s in fn_texts.items()}
    for key, t in tables.items():
        t.setdefault("fks", [])
        t["referencedBy"] = sorted(k for k, o in tables.items() if any(d == key for _, d in o.get("fks", [])))
        t["modules"] = sorted(m for m, r in module_refs.items() if key in r)
        t["functionFiles"] = sorted(rel for rel, r in file_refs.items() if key in r)
    for m in modules.values():
        m["tables"] = []
    for key, t in tables.items():
        for m in t["modules"]:
            modules[m]["tables"].append(key)

    # --- staff console: every page and the operations its source names
    pages = {}
    for p in sorted((ROOT / "ui/src/pages").rglob("*.jsx")):
        if p.name.startswith("_"):
            continue
        rel = str(p.relative_to(ROOT / "ui/src/pages"))
        text = p.read_text(encoding="utf-8")
        named = sorted(k for k, o in ops.items()
                       if f"{o['method']} {o['path']}" in text or flow_matchers(o["path"]).search(text))
        pages[rel] = {"file": "ui/src/pages/" + rel, "lines": text.count("\n") + 1,
                      "about": header(text), "ops": named}

    # --- the pipeline's actual steps, read from the one ordered rebuild script
    steps = []
    for n, raw in enumerate(read("scripts/rebuild_artifacts.sh").splitlines(), 1):
        m = re.match(r"(?:python3|deno run --allow-all)\s+(\S+)", raw.strip())
        if not m:
            continue
        script = m.group(1)
        stext = read(script)
        if script.endswith(".py"):
            d = re.search(r'"""(.+?)(?:\n|""")', stext, re.DOTALL)
            about = d.group(1).strip() if d else ""
        else:
            about = header(stext)
        note = raw.split("#", 1)[1].strip() if "#" in raw else ""
        outs = re.match(r"->\s*(.+)", note)
        steps.append({"script": script, "shLine": n, "about": about[:300], "note": note,
                      "gate": note.startswith("GATE"),
                      "outputs": [o.strip() for o in re.split(r"\s\+\s", outs.group(1))] if outs else []})

    # --- CI: which workflow runs which script, on which triggers
    workflows = {}
    for p in sorted((ROOT / ".github/workflows").glob("*.yml")):
        text = p.read_text(encoding="utf-8")
        name = re.search(r"^name:\s*(.+)$", text, re.MULTILINE)
        doc = spec_io.yaml.safe_load(text) or {}
        on = doc.get(True, doc.get("on")) or {}
        workflows[p.name] = {
            "name": name.group(1).strip().strip("\"'") if name else p.stem, "file": ".github/workflows/" + p.name,
            "triggers": sorted(on) if isinstance(on, dict) else [on] if isinstance(on, str) else sorted(on),
            "runs": sorted(set(re.findall(r"((?:scripts|analytics|core/[\w/-]+)/[\w./-]+\.(?:py|sh|ts))", text)))}

    # --- every event code: its emit sites and the controls it serves
    events = {code: {"sites": s, "triggerOf": [], "producedBy": []} for code, s in emit_sites.items()}
    for uid, c in controls.items():
        for code, _ in c["triggers"]:
            events.setdefault(code, {"sites": [], "triggerOf": [], "producedBy": []})["triggerOf"].append(uid)
        for code, _ in c["produced"]:
            events.setdefault(code, {"sites": [], "triggerOf": [], "producedBy": []})["producedBy"].append(uid)

    # --- who talks to the external ledger (a static text reference, not a call proof)
    blnk = {"modules": sorted(m for m, s in sources.items() if re.search("blnk", s, re.IGNORECASE)),
            "files": sorted(rel for rel, s in fn_texts.items() if re.search("blnk", s, re.IGNORECASE))}

    domain_of = {m: d[0] for d in DOMAINS for m in d[3]}
    domains = [{"id": d, "title": t, "about": a, "modules": [m for m in ms if m in modules]} for d, t, a, ms in DOMAINS]
    stray = [m for m in modules if m not in domain_of]
    if stray:
        domains.append({"id": "unclassified", "title": "Unclassified", "about": "Add these modules to DOMAINS in scripts/gen_architecture.py", "modules": stray})
    for m in modules.values():
        m["events"].sort()

    sm_at = spec_text.find("x-state-machines:")
    machines = {}
    for name, states in spec["x-state-machines"].items():
        idx = spec_text.find(f"\n  {name}:", sm_at)
        machines[name] = {"states": states if isinstance(states, list) else list(states),
                          "specLine": spec_text.count("\n", 0, idx) + 2 if idx > -1 else 1,
                          "tables": sorted(k for k, t in tables.items()
                                           if re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower() == t["name"])}
    # Container-to-container edges, each from a static reference in source.
    def dir_of(rel):
        return rel.split("/", 1)[0]
    links = {}
    def link(a, b, kind, n=1):
        if a != b:
            links.setdefault((a, b, kind), 0)
            links[(a, b, kind)] += n
    for m, mod in modules.items():
        for x in mod["crossImports"]:
            link("api", dir_of(x), "imports")
    for rel, f in files.items():
        for x in f["crossImports"]:
            link(f["fn"], dir_of(x), "imports")
    for key, t in tables.items():
        # one count per distinct table a container references
        for rel in sorted({dir_of(r) for r in t["functionFiles"]} | ({"api"} if t["modules"] else set())):
            link(rel, "postgres", "tables")
    for rel, f in files.items():
        if f["fn"] == SHARED[0] and not f["test"] and re.search(r"BLNK_|fetch\(", fn_texts[rel]):
            link(SHARED[0], "blnk", "calls")
    if any(o["ui"] for o in ops.values()):
        link("ui", "api", "ui", sum(o["ui"] for o in ops.values()))
    for wf, w in workflows.items():
        for r in w["runs"]:
            d = "analytics" if r.startswith("analytics/") else r.split("/")[3] if r.startswith("core/supabase/functions/") else None
            if d:
                link("ci:" + wf, d, "runs")
    links = [{"from": a, "to": b, "kind": k, "count": n} for (a, b, k), n in sorted(links.items())]

    readme = read(ANALYTICS + "/README.md")
    para = re.search(r"\n\n(.+?)\n\n", readme, re.DOTALL)
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
        {"id": SHARED[0], "title": SHARED[1], "kind": "Imported by the edge functions",
         "about": header(read(SHARED[2])), "file": SHARED[2], "href": "#/container/" + SHARED[0]},
        {"id": ANALYTICS, "title": "Analytics", "kind": "DuckDB · scheduled jobs",
         "about": re.sub(r"\s+", " ", para.group(1)).replace("**", "") if para else "", "file": ANALYTICS + "/README.md",
         "href": "#/container/" + ANALYTICS},
        {"id": "policy", "title": "Policies & controls", "kind": "Compliance catalogue",
         "about": f"{len(policies)} policies · {len(controls)} controls", "href": "#/policy"},
        {"id": "pipeline", "title": "Specification & evidence", "kind": "Repository toolchain",
         "about": "The ordered rebuild that derives every artifact, this map included", "href": "#/pipeline"},
    ]
    return {
        "_comment": "GENERATED by scripts/gen_architecture.py from the spec, controls and source. Do not edit.",
        "counts": {"operations": len(ops), "modules": len(modules), "policies": len(policies), "controls": len(controls),
                   "events": len(emitters), "flows": len(flows), "tables": len(tables), "pages": len(pages),
                   "machines": len(machines), "files": len(files), "steps": len(steps), "workflows": len(workflows)},
        "containers": containers, "domains": domains, "modules": modules, "operations": ops,
        "policies": policies, "controls": controls, "machines": machines, "pages": pages,
        "files": files, "tables": tables, "events": events, "steps": steps, "blnk": blnk,
        "workflows": workflows, "links": links,
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
