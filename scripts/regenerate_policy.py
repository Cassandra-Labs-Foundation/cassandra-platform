#!/usr/bin/env python3
"""Regenerate ONE policy via the raw Anthropic API (no Claude Code agent loop).

Why raw API: policy-prep already assembles a self-contained composite prompt,
so generation is a pure completion, not an agent task. Calling the API directly
is faster (no CLI/agent-loop overhead) and cheaper (prompt caching on the shared
meta-prompt). Output is not deterministic: current models sample only with the
default settings, so every regeneration lands as a pull request for review.

Document-reading optimization is preserved by REUSING policy-prep's functions
in-process — the same durable, content-hashed reference conversions and parallel
extraction the scheduled task uses. We do not re-implement any of it here.

Per slug this script:
  1. Parses prompt.md, resolves the Section-5 directive, extracts references
     (all via policy-prep) -> structured `inputs` + `reference_policy`.
  2. Structured policy:  system = meta-prompt.md (cached) ; user = INPUTS block.
     -> writes {slug}/{slug}.md
  3. Stamps this policy's row in STATUS.md (its row only — never the shared
     header — so parallel per-policy PRs don't collide).

Usage:
  ANTHROPIC_API_KEY=... python3 scripts/regenerate_policy.py <slug> \
      [--model claude-opus-5-5] [--effort high] [--max-tokens 64000]
      [--project-root DIR]
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import anthropic

# Reuse policy-prep verbatim — this is the document-reading optimization.
PREP_DIR = Path(__file__).resolve().parent.parent / ".skills" / "policy-prep" / "scripts"
sys.path.insert(0, str(PREP_DIR))
import prepare_policy as pp  # noqa: E402  (path injected above)


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def generate(client: anthropic.Anthropic, *, model: str, max_tokens: int,
             effort: str, system_text: str, user_text: str) -> tuple[str, str]:
    """One cached completion. system_text is the stable, cache-marked prefix.

    Returns (policy_text, served_by_model).

    No temperature/top_p/top_k: current SDKs and API versions reject them, and
    current models sample only with the defaults. Thinking is always on for
    Claude Opus 5.5; `effort` is the quality/cost control (its default there is
    "medium", so it is set explicitly).

    `fallbacks: "default"` lets the API re-run a request that a safety
    classifier declines on Anthropic's recommended fallback model, inside the
    same call. On a mid-stream fallback the partial text is kept and the
    fallback model continues from it, so joining every text block in order
    yields the whole document; thinking/fallback blocks are skipped.
    """
    with client.beta.messages.stream(
        model=model,
        max_tokens=max_tokens,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": effort},
        system=[{
            "type": "text",
            "text": system_text,
            "cache_control": {"type": "ephemeral"},  # shared across policies -> cache hit
        }],
        messages=[{"role": "user", "content": user_text}],
    ) as stream:
        final = stream.get_final_message()
    u = final.usage
    log(f"    usage: in={u.input_tokens} out={u.output_tokens} "
        f"cache_write={getattr(u, 'cache_creation_input_tokens', 0)} "
        f"cache_read={getattr(u, 'cache_read_input_tokens', 0)}")
    for block in final.content:
        if block.type == "fallback":
            log(f"    fallback: {block.from_.model} declined; {block.to.model} continued")
    if final.stop_reason == "refusal":
        details = getattr(final, "stop_details", None)
        raise RuntimeError(
            f"the model (and its fallbacks) declined to write this policy: "
            f"category={getattr(details, 'category', None)} "
            f"explanation={getattr(details, 'explanation', None)}")
    if final.stop_reason == "max_tokens":
        raise RuntimeError(
            f"output hit max_tokens ({max_tokens}) — policy was truncated. "
            f"Raise --max-tokens and re-run.")
    if final.stop_reason != "end_turn":
        # e.g. model_context_window_exceeded: anything but a normal finish may
        # be a cut-off policy, which must never be written.
        raise RuntimeError(f"generation did not finish normally (stop_reason={final.stop_reason})")
    text = "".join(b.text for b in final.content if b.type == "text")
    if not text.strip():
        raise RuntimeError(f"empty response (stop_reason={final.stop_reason})")
    return text, final.model


def inputs_block(meta_prompt: str, inputs, reference_policy: str) -> str:
    """The INPUTS block exactly as policy-prep emits it (no drift): take the
    assembled composite and strip the meta-prompt prefix back off."""
    composite = pp.assemble_composite_prompt(meta_prompt, inputs, reference_policy)
    tail = composite[len(meta_prompt.rstrip()):]
    return tail.lstrip("\n")


def write_status(status_path: Path, *, policy_name: str, slug: str, model: str,
                 design_notes_source: str, skipped: str, ref_stats: dict,
                 ts: str) -> None:
    """Write this policy's own status file (<slug>/<slug>.status.md). Per-policy
    so parallel per-policy PRs never share a file and cannot conflict."""
    status_path.write_text(
        f"# {policy_name or slug} — Regeneration Status\n\n"
        f"- **Slug:** {slug}\n"
        f"- **Status:** ✅ regenerated\n"
        f"- **Last regenerated:** {ts}\n"
        f"- **Model:** {model}\n"
        f"- **DESIGN_NOTES source:** {design_notes_source}\n"
        f"- **References:** {ref_stats['extracted']} extracted "
        f"({ref_stats['cache_hits']} cached, {ref_stats['converted']} converted)\n"
        f"- **Skipped references:** {skipped or '—'}\n"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("slug")
    ap.add_argument("--model", default="claude-opus-5-5")
    ap.add_argument("--effort", default="high",
                    choices=["low", "medium", "high", "xhigh", "max"])
    # Thinking counts toward max_tokens, so leave room beyond the policy itself.
    ap.add_argument("--max-tokens", type=int, default=64000)
    ap.add_argument("--project-root", type=Path, default=None)
    args = ap.parse_args()

    root = (args.project_root or Path.cwd()).resolve()
    slug = args.slug
    # Policies live under compliance/policies/ (see extract_controls.POLICY_ROOT_PARTS).
    folder = root / "compliance" / "policies" / slug
    prompt_path = folder / "prompt.md"
    meta_path = root / "meta-prompt.md"

    for p in (prompt_path, meta_path):
        if not p.exists():
            log(f"FATAL: missing {p}")
            return 1

    # --- 1. Prep (reuse policy-prep: optimized, cached document reading) -------
    log(f"[{slug}] parsing prompt.md + extracting references (policy-prep)…")
    prompt_text = prompt_path.read_text()
    inputs, missing = pp.parse_prompt_md(prompt_text)
    if missing:
        log(f"FATAL: prompt.md sections missing/placeholder: {missing}")
        return 1

    cache_root = root / ".cache"
    directive_cmd = pp.detect_directive(inputs.design_notes)
    if directive_cmd:
        resolved, source = pp.resolve_directive(
            directive_cmd, root, cache_root / "directives", {})
        inputs.design_notes = resolved
        inputs.design_notes_source = source
    else:
        inputs.design_notes_source = "literal Section 5"

    reference_policy, ref_stats = pp.extract_all_references(folder / "references", cache_root)
    log(f"[{slug}] references: extracted={ref_stats['extracted']} "
        f"cache_hits={ref_stats['cache_hits']} converted={ref_stats['converted']} "
        f"failed={len(ref_stats['failed'])} skipped={len(ref_stats['skipped'])}")

    meta_prompt = meta_path.read_text()

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY

    # --- 2. Structured policy --------------------------------------------------
    log(f"[{slug}] generating structured policy ({args.model})…")
    structured, served_by = generate(
        client, model=args.model, max_tokens=args.max_tokens,
        effort=args.effort,
        system_text=meta_prompt,                      # cached, shared across policies
        user_text=inputs_block(meta_prompt, inputs, reference_policy),
    )
    (folder / f"{slug}.md").write_text(structured.rstrip() + "\n")
    log(f"[{slug}] wrote {slug}/{slug}.md ({len(structured)} chars)")

    # --- 3. Per-policy status file --------------------------------------------
    skipped_parts = ref_stats["skipped"] + [f["file"] for f in ref_stats["failed"]]
    ts = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_status(
        folder / f"{slug}.status.md", policy_name=inputs.policy_name, slug=slug,
        model=served_by, design_notes_source=inputs.design_notes_source,
        skipped=", ".join(skipped_parts), ref_stats=ref_stats, ts=ts)
    log(f"[{slug}] wrote {slug}/{slug}.status.md")
    log(f"[{slug}] done.")

    print(json.dumps({
        "slug": slug,
        "policy_name": inputs.policy_name,
        "structured_chars": len(structured),
        "model": served_by,
        "design_notes_source": inputs.design_notes_source,
        "references": ref_stats,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
