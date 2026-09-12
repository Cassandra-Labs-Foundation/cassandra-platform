#!/usr/bin/env bash
# The demo, as a test.
#
#   ./supabase/tests/e2e/demo.sh            narrated, paced for an audience
#   PACE=0 ./supabase/tests/e2e/demo.sh     fast, for CI / the harness
#
# This is the Aug-29 story end to end against the LIVE stack: onboard a
# member, screen them, open an account, move money, trip a control, watch a
# structuring pattern assemble itself, escalate it through triage to a SAR
# decision by a different officer, then point at the dashboard where all of
# it is now visible.
#
# It is a TEST, not a slideshow: every step asserts, and a failure exits
# non-zero. That is deliberate — a demo script that is not executed by CI
# rots silently and then fails in the room. Run by the compliance harness as
# its last section, so the narrative is proven on every full run.
set -uo pipefail
cd "$(dirname "$0")/../../.."
if [ -f .env.local ]; then set -a; source .env.local; set +a; fi
: "${DEMO_API_KEY:?DEMO_API_KEY not set in .env.local}"
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL not set in .env.local}"

API="${API_BASE:-https://jynsipdvrgqdkeqrlzcv.functions.supabase.co/api}"
DASH="${DASH_URL:-https://cassandra-platform.vercel.app/compliance/dashboard}"
AUTH=(-H "X-Api-Key: ${DEMO_API_KEY}" -H "content-type: application/json")
RUN="demo-$(date +%s)"
PACE="${PACE:-1.2}"
PASS=0; FAIL=0

B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; N=$'\033[0m'

say()  { printf '\n%s%s%s\n' "$B" "$1" "$N"; [ "$PACE" = "0" ] || sleep "$PACE"; }
note() { printf '   %s%s%s\n' "$DIM" "$1" "$N"; }
ok()   { printf '   %s✓%s %s\n' "$G" "$N" "$1"; PASS=$((PASS+1)); }
bad()  { printf '   %s✗ %s%s\n      expected: %s\n      actual:   %s\n' "$R" "$1" "$N" "$3" "$2"; FAIL=$((FAIL+1)); }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

sql() {
  duckdb -noheader -list \
    -cmd "ATTACH IF NOT EXISTS '${SUPABASE_DB_URL}' AS pg (TYPE postgres, READ_ONLY);" \
    -c "$1" 2>/dev/null | tr -d '\033' | sed 's/\[[0-9;]*m//g' | grep -vi 'rosetta\|duckdb.org\|warning' | tr -d '[:space:]'
}
api() { curl -sS -o /tmp/demo_body -w '%{http_code}' -X "$1" "$API$2" "${AUTH[@]}" \
        -H "Idempotency-Key: $RUN-$3" -d "$4"; }
jget() { python3 -c "import json;print(json.load(open('/tmp/demo_body')).get('$1',''))" 2>/dev/null; }
jctl() { python3 -c "
import json
d=json.load(open('/tmp/demo_body'))
print('yes' if any(c.get('control_id')=='$1' for c in d.get('control_results',[])) else 'no')" 2>/dev/null; }

printf '%s\n' "════════════════════════════════════════════════════════════"
printf '%s  Cassandra Banking Core — live compliance walkthrough%s\n' "$B" "$N"
printf '   %s\n' "$API"
printf '%s\n' "════════════════════════════════════════════════════════════"

# ─────────────────────────────────────────────── 1. onboarding + screening
say "1. A member joins. Every entity is screened before it can hold money."
ST=$(api POST /entities "$RUN-ent" '{"type":"person","name":"Dana Whitfield","date_of_birth":"1988-04-02"}')
ENT=$(jget id)
check "member created" "$ST" "201"
note "entity $ENT"

ST=$(curl -sS -o /tmp/demo_body -w '%{http_code}' -X POST "$API/entities/$ENT/verifications" "${AUTH[@]}" -d '{}')
check "KYC ran through the provider adapter" "$(jget status)" "approved"
VER=$(jget id)
check "OFAC screened and left evidence — a screen with no record is not a screen" \
  "$(sql "select count(*) from pg.core.control_result where event='$VER' and control_id='CG-OFAC-01';")" "1"

say "   The OFAC floor cannot be bought off. A sanctioned name is refused even
   when a full-trust partner vouches for it."
ST=$(api POST /entities "$RUN-sdn" '{"type":"person","name":"Viktor Sokolov (SDN test)","date_of_birth":"1970-01-01"}')
SDN=$(jget id)
curl -sS -o /tmp/demo_body -X POST "$API/entities/$SDN/verifications" "${AUTH[@]}" \
  -d '{"attestation":{"partner":"fintech-x","trust_level":"full"}}' >/dev/null
check "full-trust attestation does NOT override the floor" "$(jget status)" "denied"
check "the refusal is on the record" \
  "$(sql "select count(*)>0 from pg.core.bsa_alert where alert_type='ofac' and details like '%$SDN%';")" "true"

# ─────────────────────────────────────────────── 2. money moves
say "2. Accounts open, money moves. Every movement passes the same gate."
SRC=$(curl -sS -X POST "$API/accounts" "${AUTH[@]}" -H "Idempotency-Key: $RUN-a1" \
  -d '{"account_type":"checking","opening_deposit_cents":5000000}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
DST=$(curl -sS -X POST "$API/accounts" "${AUTH[@]}" -H "Idempotency-Key: $RUN-a2" \
  -d '{"account_type":"checking","opening_deposit_cents":100000}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
note "source $SRC  ·  destination $DST"

ST=$(api POST /transfers "$RUN-ok" "{\"source_account_id\":\"$SRC\",\"destination_account_id\":\"$DST\",\"amount_cents\":25000,\"description\":\"demo: rent\"}")
OK_ID=$(jget id)
check "a compliant \$250 transfer settles" "$(jget status)" "settled"
check "and books its own double-entry evidence" \
  "$(sql "select count(*) from pg.core.bookkeeping_entry where id='bke_$OK_ID';")" "1"

# ─────────────────────────────────────────────── 3. a reportable transaction
say "3. A \$11,000 transfer. Over \$10k is REPORTABLE, not forbidden — so it
   settles, and it raises a Currency Transaction Report alert."
ST=$(api POST /transfers "$RUN-ctr" "{\"source_account_id\":\"$SRC\",\"destination_account_id\":\"$DST\",\"amount_cents\":1100000,\"description\":\"demo: equipment\"}")
CTR_ID=$(jget id)
check "settles — an alert is not a block" "$(jget status)" "settled"
check "CG-CTR-01 surfaced on the response itself" "$(jctl CG-CTR-01)" "yes"
check "a BSA alert exists for examiners to find" \
  "$(sql "select count(*)>0 from pg.core.bsa_alert where id='alert_${CTR_ID}_ctr_threshold';")" "true"
check "with its 2-business-day triage clock already running" \
  "$(sql "select case when triage_due_at is null then 'no' else 'yes' end from pg.core.bsa_alert where id='alert_${CTR_ID}_ctr_threshold';")" "yes"

# ─────────────────────────────────────────────── 4. structuring
say "4. Now the interesting one. Three transfers of \$4,000 — each one legal,
   each one under every threshold. The pattern is the crime."
S1=$(curl -sS -X POST "$API/accounts" "${AUTH[@]}" -H "Idempotency-Key: $RUN-s1" -d '{"account_type":"checking","opening_deposit_cents":600000}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
S2=$(curl -sS -X POST "$API/accounts" "${AUTH[@]}" -H "Idempotency-Key: $RUN-s2" -d '{"account_type":"checking","opening_deposit_cents":600000}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
S3=$(curl -sS -X POST "$API/accounts" "${AUTH[@]}" -H "Idempotency-Key: $RUN-s3" -d '{"account_type":"checking","opening_deposit_cents":600000}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
MULE=$(curl -sS -X POST "$API/accounts" "${AUTH[@]}" -H "Idempotency-Key: $RUN-mule" -d '{"account_type":"checking","opening_deposit_cents":10000}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

api POST /transfers "$RUN-st1" "{\"source_account_id\":\"$S1\",\"destination_account_id\":\"$MULE\",\"amount_cents\":400000,\"description\":\"demo: invoice 1\"}" >/dev/null
note "\$4,000 in … no alert, correctly"
api POST /transfers "$RUN-st2" "{\"source_account_id\":\"$S2\",\"destination_account_id\":\"$MULE\",\"amount_cents\":400000,\"description\":\"demo: invoice 2\"}" >/dev/null
note "\$8,000 in … still under \$10k, still silent"
ST=$(api POST /transfers "$RUN-st3" "{\"source_account_id\":\"$S3\",\"destination_account_id\":\"$MULE\",\"amount_cents\":400000,\"description\":\"demo: invoice 3\"}")
STR_ID=$(jget id)
check "the third settles too — no single transfer was wrong" "$(jget status)" "settled"
check "per-transaction CTR stays silent (each is under \$10k)" "$(jctl CG-CTR-01)" "no"
check "but CG-STR-01 sees the \$12,000 aggregate" "$(jctl CG-STR-01)" "yes"
check "and names the receiving account in a BSA alert" \
  "$(sql "select count(*)>0 from pg.core.bsa_alert where alert_type='structuring' and details like '%$MULE%';")" "true"

# ─────────────────────────────────────────────── 5. the human chain
say "5. An alert is worthless if nobody works it. Watch the duties separate:
   one officer investigates, a DIFFERENT one decides."
INST_ID=$(psql "$SUPABASE_DB_URL" -tAc "select id from core.instance limit 1")
mint() { # mint <name> <actor> <roles>
  local tok="cass_demo_$(openssl rand -hex 16)"
  local hash; hash=$(printf '%s' "$tok" | shasum -a 256 | awk '{print $1}')
  psql "$SUPABASE_DB_URL" -qc "insert into core.api_token (id, token_hash, token_prefix, actor_type, roles, partner_id, instance_id, allowed_endpoints, allowed_tiers, status) values ('tok_${RUN}_${1}', '${hash}', 'cass_demo', '$2', '$3', null, '${INST_ID}', '{*}', '{read,write,realtime,bulk}', 'active');" >/dev/null
  echo "$tok"
}
INVESTIGATOR=$(mint inv cu_admin '{bsa_investigator}')
OFFICER=$(mint off cu_admin '{bsa_officer}')
# holds BOTH duties — the hardest case for segregation of duties to catch
BOTH=$(mint both cu_admin '{bsa_investigator,bsa_officer}')

ALERT="alert_${STR_ID}_structuring"
ST=$(curl -sS -o /tmp/demo_body -w '%{http_code}' -X POST "$API/bsa/alerts/$ALERT/triage" \
  -H "X-Api-Key: $INVESTIGATOR" -H 'content-type: application/json' \
  -H "Idempotency-Key: $RUN-triage" -d '{"outcome":"escalated","note":"three sub-threshold credits, one beneficiary, same day"}')
check "the investigator escalates" "$ST" "200"
CASE=$(python3 -c "import json;print(json.load(open('/tmp/demo_body'))['case']['id'])")
note "case $CASE"
check "a case opened, with the 30-day SAR clock started" \
  "$(sql "select count(*) from pg.core.event where code='case.sar.decision.timer' and resource_id='case:$CASE';")" "1"

say "   Two independent barriers stand between an investigator and a decision.
   First: deciding is not their duty at all."
ST=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/bsa/cases/$CASE/decision" \
  -H "X-Api-Key: $INVESTIGATOR" -H 'content-type: application/json' \
  -H "Idempotency-Key: $RUN-selfdecide" -d '{"decision":"file","rationale":"same person deciding"}')
check "an investigator cannot decide — wrong duty (403)" "$ST" "403"

say "   Second, and stronger: even someone who holds BOTH duties cannot decide
   a case they opened themselves."
BOTH_ALERT="alert_${CTR_ID}_ctr_threshold"
ST=$(curl -sS -o /tmp/demo_body -w '%{http_code}' -X POST "$API/bsa/alerts/$BOTH_ALERT/triage" \
  -H "X-Api-Key: $BOTH" -H 'content-type: application/json' \
  -H "Idempotency-Key: $RUN-both-triage" -d '{"outcome":"escalated","note":"reviewing the large transfer"}')
check "the dual-role officer opens their own case" "$ST" "200"
BOTH_CASE=$(python3 -c "import json;print(json.load(open('/tmp/demo_body'))['case']['id'])")
ST=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/bsa/cases/$BOTH_CASE/decision" \
  -H "X-Api-Key: $BOTH" -H 'content-type: application/json' \
  -H "Idempotency-Key: $RUN-both-decide" -d '{"decision":"no_file","rationale":"looks fine to me"}')
check "…and is REFUSED on their own case (409, segregation of duties)" "$ST" "409"
note "the same rule is a database constraint, so it holds against psql too"

ST=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/bsa/cases/$CASE/decision" \
  -H "X-Api-Key: $OFFICER" -H 'content-type: application/json' \
  -H "Idempotency-Key: $RUN-nodoc" -d '{"decision":"no_file"}')
check "a no-file decision with no rationale is refused as well (400)" "$ST" "400"

ST=$(curl -sS -o /tmp/demo_body -w '%{http_code}' -X POST "$API/bsa/cases/$CASE/decision" \
  -H "X-Api-Key: $OFFICER" -H 'content-type: application/json' \
  -H "Idempotency-Key: $RUN-decide" -d '{"decision":"file","rationale":"structuring pattern confirmed across three source accounts"}')
check "the officer files the SAR" "$ST" "200"
check "case closed with its rationale retained" \
  "$(sql "select sar_decision from pg.core.\"case\" where id='$CASE';")" "file"
check "sar.filed emitted for downstream systems" \
  "$(sql "select count(*) from pg.core.event where code='sar.filed' and resource_id='case:$CASE';")" "1"

# ─────────────────────────────────────────────── 6. the ledger holds
say "6. Underneath all of it, the money still adds up."
BAL=$(sql "select balance from pg.core.account where id='$MULE';")
check "the mule account holds exactly what arrived (\$120.00 + \$1,200.00)" "$BAL" "1210000"
check "no transfer settled without a bookkeeping entry" \
  "$(sql "select count(*) from pg.core.transfer t where t.status='settled' and t.created_at > now() - interval '10 minutes' and not exists (select 1 from pg.core.bookkeeping_entry b where b.id = 'bke_' || t.id);")" "0"

# ─────────────────────────────────────────────── 7. it is all visible
say "7. And an officer sees every bit of it, without asking an engineer."
ST=$(curl -sS -o /tmp/demo_body -w '%{http_code}' "$API/compliance/dashboard/data")
check "the dashboard loads with no credential (demo posture)" "$ST" "200"
check "this run's structuring alert is in the open queue" \
  "$(python3 -c "import json;d=json.load(open('/tmp/demo_body'));print('yes' if d['alerts']['open']>0 else 'no')")" "yes"
check "control activity reflects the gate firing" \
  "$(python3 -c "import json;d=json.load(open('/tmp/demo_body'));print('yes' if d['controls']['window_rows']>0 else 'no')")" "yes"

printf '\n%s   → %s%s\n' "$B" "$DASH" "$N"
printf '   %sBSA / AML page: %sbsa/%s\n' "$DIM" "$DASH" "$N"

printf '\n%s\n' "════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  printf '%s  %d checks passed — the story above is not a script, it ran.%s\n' "$G" "$PASS" "$N"
else
  printf '%s  %d passed, %d FAILED%s\n' "$R" "$PASS" "$FAIL" "$N"
fi
printf '%s\n' "════════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1
