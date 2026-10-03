#!/usr/bin/env bash
# The E2E TDD loop: deploy what changed, run the flows against the real core,
# print only what matters.
#
#   scripts/flow.sh                    deploy changed functions, run every flow once
#   scripts/flow.sh -f triage          only flows/steps whose name matches "triage"
#   scripts/flow.sh -n 5               run 5 times (flakiness check — a race passes 2/3)
#   scripts/flow.sh --no-deploy        skip the deploy check
#
# Deploys only functions whose source changed since this script last deployed
# them (hashes in .cache/flow-deploy/, gitignored). A change under _shared/
# redeploys every function. The target is the live core in .env.local
# (DEMO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN).
set -euo pipefail
cd "$(dirname "$0")/.."

FILTER=""; RUNS=1; DEPLOY=1
while [ $# -gt 0 ]; do
  case "$1" in
    -f) FILTER="$2"; shift 2 ;;
    -n) RUNS="$2"; shift 2 ;;
    --no-deploy) DEPLOY=0; shift ;;
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

args=(--allow-net --allow-env core/verifier/flows/)
[ -n "$FILTER" ] && args=(--filter "$FILTER" "${args[@]}")

pass=0
for i in $(seq 1 "$RUNS"); do
  out=$(NO_COLOR=1 deno test "${args[@]}" 2>&1) && ok=1 || ok=0
  summary=$(grep -E '^(ok|FAILED) \|' <<<"$out" | tail -1)
  if [ "$ok" = 1 ]; then
    pass=$((pass + 1)); echo "run $i: $summary"
  else
    echo "run $i: ${summary:-crashed}"
    # the failing step and its assertion message, nothing else
    grep -E '^\S.* \.\.\. .* => |^error: ' <<<"$out" | grep -B1 '^error: Error' | grep -v '^--$' | sed 's/^/  /'
    [ -z "$summary" ] && tail -15 <<<"$out"
  fi
done
[ "$RUNS" -gt 1 ] && echo "$pass/$RUNS runs green"
[ "$pass" = "$RUNS" ]
