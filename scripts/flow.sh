#!/usr/bin/env bash
# The E2E TDD loop: deploy what changed, run the flows against the real core,
# print only what matters.
#
#   scripts/flow.sh                    deploy changed functions, run every flow once
#   scripts/flow.sh -f triage          only flows/steps whose name matches "triage"
#   scripts/flow.sh -n 5               run 5 times (flakiness check — a race passes 2/3)
#   scripts/flow.sh --no-deploy        skip the deploy check
#   scripts/flow.sh --changed          only the flows your uncommitted change touches
#   scripts/flow.sh --changed origin/main   ...the change since a ref
#   scripts/flow.sh --serial           no parallelism (debugging an interaction)
#
# Flow FILES run in parallel (deno test --parallel; FLOW_JOBS workers, default
# 10; full suite ~10 min). Two markers take a file out of that pool:
#   // flow-runner: lane <name>  shares instance state only with its lane (the
#      cash KRI people publishes and cash_ops reads; the shared partner's ACH
#      limit eps sets): files in one lane run in sequence, and every lane runs
#      ALONGSIDE the parallel pool.
#   // flow-runner: serial       blocks or reads everything (an institution
#      freeze or safe mode refuses every rail; exact dashboard deltas): these
#      run last, alone, one after another.
# A new flow that touches shared state must carry one of them. --changed asks scripts/flow_select.py which flows a change
# reaches (spec paths of the edited handler module, its ledger, or ALL for
# core-wide files like the payment gate).
#
# Deploys only functions whose source changed since this script last deployed
# them (hashes in .cache/flow-deploy/, gitignored). A change under _shared/
# redeploys every function. The target is the live core in .env.local
# (DEMO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN).
set -euo pipefail
cd "$(dirname "$0")/.."

FILTER=""; RUNS=1; DEPLOY=1; CHANGED=0; BASE=""; SERIAL_ALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    -f) FILTER="$2"; shift 2 ;;
    -n) RUNS="$2"; shift 2 ;;
    --no-deploy) DEPLOY=0; shift ;;
    --serial) SERIAL_ALL=1; shift ;;
    --changed)
      CHANGED=1; shift
      if [ $# -gt 0 ] && [[ "$1" != -* ]]; then BASE="$1"; shift; fi ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

set -a; source .env.local; set +a
PROJECT_REF="jynsipdvrgqdkeqrlzcv"
FN_DIR="core/supabase/functions"
STAMPS=".cache/flow-deploy"; mkdir -p "$STAMPS"

hash_dir() { find "$1" -type f -not -name '*.test.ts' -not -path '*/node_modules/*' -print0 | sort -z | xargs -0 shasum | shasum | cut -c1-40; }

if [ "$DEPLOY" = 1 ]; then
  shared=$(hash_dir "$FN_DIR/_shared")
  todo=()
  for d in "$FN_DIR"/*/; do
    fn=$(basename "$d"); [[ "$fn" == _* ]] && continue
    [ -f "$d/index.ts" ] || continue
    h="$(hash_dir "$d")-$shared"
    [ "$(cat "$STAMPS/$fn" 2>/dev/null)" = "$h" ] || todo+=("$fn")
  done
  if [ ${#todo[@]} -gt 0 ]; then
    echo "deploying: ${todo[*]}"
    t0=$SECONDS
    supabase functions deploy "${todo[@]}" --project-ref "$PROJECT_REF" --workdir core --use-api \
      >/tmp/flow-deploy.log 2>&1 || { tail -20 /tmp/flow-deploy.log; exit 1; }
    for fn in "${todo[@]}"; do echo "$(hash_dir "$FN_DIR/$fn")-$shared" > "$STAMPS/$fn"; done
    echo "deployed in $((SECONDS - t0))s"
  else
    echo "deployed core is current"
  fi
fi

# Type-check separately and only WARN: deno test type-checks every file in the
# directory, so one half-written flow (someone else's, mid-edit) would crash
# every run. A real error in the flow you're running still fails at runtime.
if ! tc=$(deno check core/verifier/flows/*.ts 2>&1); then
  echo "warning: type errors (not blocking):"
  grep -E 'ERROR|    at ' <<<"$tc" | head -6 | sed 's/^/  /'
fi

# which flow files, split into the parallel and the serial group
if [ "$CHANGED" = 1 ]; then
  sel=$(python3 scripts/flow_select.py ${BASE:+"$BASE"})
  if [ -z "$sel" ]; then echo "no flow touches this change"; exit 0; fi
  if [ "$sel" = "ALL" ]; then
    echo "core-wide change: every flow"
    files=(core/verifier/flows/*.test.ts)
  else
    files=($sel); echo "affected flows: $(for f in "${files[@]}"; do basename "$f" .test.ts; done | tr '\n' ' ')"
  fi
else
  files=(core/verifier/flows/*.test.ts)
fi
par=(); ser=(); lanes=()
for f in "${files[@]}"; do
  lane=$(grep -m1 -oE "flow-runner: lane [a-z0-9_-]+" "$f" | awk '{print $3}' || true)
  if [ "$SERIAL_ALL" = 1 ] || grep -q "flow-runner: serial" "$f"; then ser+=("$f")
  elif [ -n "$lane" ]; then lanes+=("$lane:$f")
  else par+=("$f"); fi
done
lane_names=$(for l in "${lanes[@]}"; do echo "${l%%:*}"; done | sort -u)

base_args=(--no-check --allow-net --allow-env)
[ -n "$FILTER" ] && base_args=(--filter "$FILTER" "${base_args[@]}")

# run one group; prints its summary and failing steps, returns non-zero on red
run_group() {
  local label="$1"; shift
  local out ok summary
  out=$(NO_COLOR=1 DENO_JOBS="${FLOW_JOBS:-10}" deno test "$@" 2>&1) && ok=1 || ok=0
  # `|| true`: no summary line (a type error, a crash) must reach the
  # fallback below, not kill the script silently under pipefail
  summary=$(grep -E '^(ok|FAILED) \|' <<<"$out" | tail -1 || true)
  echo "  $label: ${summary:-crashed}"
  if [ "$ok" != 1 ]; then
    # the failing step and its assertion message, nothing else
    { grep -E '^\S.* \.\.\. .* => |^error: ' <<<"$out" | grep -B1 '^error: Error' | grep -v '^--$' | sed 's/^/    /'; } || true
    [ -z "$summary" ] && tail -15 <<<"$out"
  fi
  [ "$ok" = 1 ]
}

LOGDIR=$(mktemp -d)
pass=0
for i in $(seq 1 "$RUNS"); do
  t0=$SECONDS; green=1
  echo "run $i:"
  # the parallel pool and every lane, concurrently; each reports when all finish
  pids=()
  if [ ${#par[@]} -gt 0 ]; then
    ( run_group "parallel (${#par[@]} files)" --parallel "${base_args[@]}" "${par[@]}" ) > "$LOGDIR/par" 2>&1 & pids+=($!)
  fi
  for ln in $lane_names; do
    lf=(); for l in "${lanes[@]}"; do [ "${l%%:*}" = "$ln" ] && lf+=("${l#*:}"); done
    ( run_group "lane $ln (${#lf[@]} files)" "${base_args[@]}" "${lf[@]}" ) > "$LOGDIR/lane_$ln" 2>&1 & pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || green=0; done
  cat "$LOGDIR"/par "$LOGDIR"/lane_* 2>/dev/null || true
  rm -f "$LOGDIR"/par "$LOGDIR"/lane_*
  if [ ${#ser[@]} -gt 0 ]; then run_group "serial (${#ser[@]} files)" "${base_args[@]}" "${ser[@]}" || green=0; fi
  echo "  $([ "$green" = 1 ] && echo ok || echo FAILED) in $((SECONDS - t0))s"
  [ "$green" = 1 ] && pass=$((pass + 1))
done
rm -rf "$LOGDIR"
[ "$RUNS" -gt 1 ] && echo "$pass/$RUNS runs green"
[ "$pass" = "$RUNS" ]
