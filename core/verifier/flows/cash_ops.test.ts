// flow-runner: lane kri — shares instance state only with its lane (see scripts/flow.sh)
// Cash-operations flows (CP-01..CP-12): the institution's own currency
// inventory — vaults, teller drawers, ATMs, night drops — as vault tellers,
// their supervisors, treasury and the Board actually run it. Replaces the
// stubbed unit file core/supabase/functions/api/cash_ops.test.ts (see
// ledger/cash_ops.md).
//
// Shared-state rules. The demo institution is live and shared:
//   * every asset, shipment, employee, deviation, policy version, KRI period
//     and Board quarter is run-unique, and assertions are on THOSE rows;
//   * enterprise positions are keyed by as_of_date, so this suite posts them
//     on a free date in the 1900s — never a recent date another reader (the
//     Board summary takes the LATEST position) would pick up;
//   * the policy adopted here is a historical (already-expired) run-unique
//     version, so it never displaces the live cash policy;
//   * suspense items this suite opens are cleared before the flow ends.
// No institution-wide setting is changed, so nothing needs restoring.
import { actor, type Any, api, assert, assertEq, core, flow } from "./helpers.ts";

const RUN = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
let seq = 0;
/** a run-unique id with a readable prefix */
const rid = (p: string) => `${p}_flow_${RUN}_${++seq}`;

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const DAY = 24 * 60 * 60 * 1000;
const ms = (s: unknown) => Date.parse(String(s));

async function rowById(table: string, id: string) {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data as Any;
}

async function rowsWhere(table: string, col: string, val: string, orderBy = "created_at") {
  const r = await core().from(table).select("*").eq(col, val).order(orderBy, { ascending: true });
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return (r.data ?? []) as Any[];
}

/** event codes the core wrote about one resource (`<type>:<id>`) */
async function codesFor(resourceType: string, id: string): Promise<string[]> {
  const r = await core().from("event").select("code").eq("resource_id", `${resourceType}:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  return (r.data ?? []).map((e: Any) => String(e.code));
}

async function exactCount(table: string, filter?: (q: Any) => Any): Promise<number> {
  let q: Any = core().from(table).select("id", { count: "exact", head: true });
  if (filter) q = filter(q);
  const r = await q;
  assert(!r.error, `${table} count: ${r.error?.message}`);
  return r.count ?? 0;
}

/** every row of a table, paged past PostgREST's 1000-row cap */
async function allRows(table: string, cols: string): Promise<Any[]> {
  const out: Any[] = [];
  for (let from = 0;; from += 1000) {
    const r = await core().from(table).select(cols).order("id").range(from, from + 999);
    assert(!r.error, `${table} page: ${r.error?.message}`);
    out.push(...(r.data ?? []));
    if ((r.data ?? []).length < 1000) return out;
  }
}

async function registerAsset(key: string, type: string, balance: number, custodian = rid("cust")) {
  const id = rid(`casset_${type}`);
  const r = await api("PUT", `/cash-ops/assets/${id}`, {
    asset_type: type, location_id: `branch_flow_${RUN}`, balance_cents: balance, custodian_user_id: custodian,
  }, { key });
  assertEq(r.status, 200, `register ${type} (${body(r)})`);
  return id;
}

async function setLimit(key: string, assetId: string, limit: number, extra: Record<string, unknown> = {}) {
  const r = await api("POST", "/cash-ops/limits", { asset_id: assetId, limit_cents: limit, ...extra }, { key });
  assertEq(r.status, 201, `limit schedule (${body(r)})`);
  return r.body.data as Any;
}

const load = (key: string, assetId: string, amount: number, counter: string | null, custodian: string | null) =>
  api("POST", `/cash-ops/assets/${assetId}/loads`, {
    amount_cents: amount, counter_user_id: counter, custodian_user_id: custodian,
  }, { key });

async function balanceOf(assetId: string): Promise<number> {
  return Number((await rowById("cash_asset", assetId)).balance_cents);
}

const fields = (r: { body: Any }): string[] => (r.body.errors ?? []).map((e: Any) => String(e.field));

// ------------------------------------------------------- CP-04 + CP-06 vault

flow("cash_ops: vault registered → limit schedule governs loads under dual control → day-end recon variance parks in suspense → sweep escalates the aged item → cleared with the correcting entry", async (t) => {
  const teller = await actor("pynthia_ops");
  const partner = await actor("partner");
  const VAULT_BAL = 500_000_00;
  const LIMIT = 750_000_00;
  let vault = "";
  const suspense: string[] = [];

  try {
    await t.step("a partner cannot register a vault: the cash-ops surface does not exist for it", async () => {
      const id = rid("casset_partner");
      const r = await api("PUT", `/cash-ops/assets/${id}`, { asset_type: "vault", balance_cents: 1 }, { key: partner });
      assertEq(r.status, 404, `partner register (${body(r)})`);
      assertEq(await rowById("cash_asset", id), null, "no asset row written");
    });

    await t.step("register a vault: an unknown asset type is refused; the vault row is written as demo evidence", async () => {
      const bad = await api("PUT", `/cash-ops/assets/${rid("casset_bad")}`, { asset_type: "piggy_bank" }, { key: teller });
      assertEq(bad.status, 400, `bad asset_type (${body(bad)})`);
      assert(fields(bad).includes("asset_type"), "the refusal names asset_type");
      vault = await registerAsset(teller, "vault", VAULT_BAL, "cust_vault_flow");
      const row = await rowById("cash_asset", vault);
      assertEq(row.asset_type, "vault", "asset type");
      assertEq(Number(row.balance_cents), VAULT_BAL, "opening balance");
      assertEq(row.provenance, "demo", "test-actor evidence is labelled demo");
    });

    await t.step("with NO limit in force a load is blocked — unknown is not permission", async () => {
      const r = await load(teller, vault, 100, "teller_a", "teller_b");
      assertEq(r.status, 409, `load without limit (${body(r)})`);
      assertEq(r.body.type, "cash_load_blocked", "typed refusal");
      const loads = await rowsWhere("cash_load", "asset_id", vault);
      assertEq(loads.length, 1, "the blocked attempt is recorded");
      assertEq(loads[0].decision, "blocked", "decision");
      assertEq(loads[0].blocked_reason, "no_limit_in_force", "reason");
      assertEq(await balanceOf(vault), VAULT_BAL, "no cash moved");
      assert((await codesFor("cash_asset", vault)).includes("cash.limit_block.alerted"), "limit-block alert emitted");
    });

    await t.step("the supervisor schedules limits: current, future-dated, backdated, an expired deviation; an unsunset deviation is refused", async () => {
      const now = Date.now();
      await setLimit(teller, vault, LIMIT, { effective_at: new Date(now - 30 * DAY).toISOString(), board_resolution_id: "board-flow" });
      // a planned increase for next year must not govern today
      await setLimit(teller, vault, 2_000_000_00, { effective_at: new Date(now + 365 * DAY).toISOString() });
      // typed second but effective EARLIER — must lose on effective date
      await setLimit(teller, vault, 100_00, { effective_at: new Date(now - 300 * DAY).toISOString() });
      // a seasonal deviation that already lapsed
      await setLimit(teller, vault, 9_000_000_00, {
        effective_at: new Date(now - 60 * DAY).toISOString(),
        deviation_id: rid("dev_lapsed"), sunset_at: new Date(now - 40 * DAY).toISOString(),
      });
      const noSunset = await api("POST", "/cash-ops/limits", {
        asset_id: vault, limit_cents: 1, effective_at: new Date(now - 10 * DAY).toISOString(), deviation_id: rid("dev_forever"),
      }, { key: teller });
      assertEq(noSunset.status, 400, `deviation with no sunset (${body(noSunset)})`);
      assert(fields(noSunset).includes("sunset_at"), "the refusal names sunset_at");
      const sched = await rowsWhere("cash_limits_schedule", "asset_id", vault);
      assertEq(sched.length, 4, "four schedule rows, the unsunset deviation was not written");
      assert((await codesFor("cash_asset", vault)).includes("cash.limits_schedule.updated"), "schedule events emitted");
    });

    await t.step("a permitted load moves the cash against the limit IN FORCE and records dual control", async () => {
      const r = await load(teller, vault, 100_000_00, "teller_a", "teller_b");
      assertEq(r.status, 201, `permitted load (${body(r)})`);
      assertEq(r.body.data.decision, "permitted", "decision");
      assertEq(r.body.data.balance_cents, VAULT_BAL + 100_000_00, "new balance on response");
      assertEq(await balanceOf(vault), VAULT_BAL + 100_000_00, "vault balance moved");
      const row = await rowById("cash_load", r.body.data.id);
      assertEq(Number(row.limit_cents), LIMIT, "the current schedule governed — not the future, backdated or lapsed rows");
      assertEq(row.counter_user_id, "teller_a", "counter recorded");
      assertEq(row.custodian_user_id, "teller_b", "custodian recorded");
      const dual = await rowById("event", `ev_${r.body.data.id}_dual`);
      assertEq(dual?.code, "cash.dual_control.completed", "dual control evidence");
    });

    await t.step("one person cannot be both counter and custodian; a missing custodian is refused too", async () => {
      const self = await load(teller, vault, 100, "teller_a", "teller_a");
      assertEq(self.status, 409, `self dual control (${body(self)})`);
      const missing = await load(teller, vault, 100, "teller_a", null);
      assertEq(missing.status, 409, `missing custodian (${body(missing)})`);
      const blocked = (await rowsWhere("cash_load", "asset_id", vault)).filter((l) => l.decision === "blocked");
      const reasons = blocked.map((l) => l.blocked_reason);
      assert(reasons.includes("dual_control_self"), `dual_control_self recorded (got ${reasons})`);
      assert(reasons.includes("dual_control_missing"), `dual_control_missing recorded (got ${reasons})`);
      for (const l of blocked) {
        assertEq(await rowById("event", `ev_${l.id}_dual`), null, `no dual-control completion for blocked ${l.blocked_reason}`);
      }
      assertEq(await balanceOf(vault), VAULT_BAL + 100_000_00, "no cash moved");
    });

    await t.step("the limit is tested against the PROJECTED balance: 600k + 200k over a 750k limit is blocked", async () => {
      const r = await load(teller, vault, 200_000_00, "teller_a", "teller_b");
      assertEq(r.status, 409, `over-limit load (${body(r)})`);
      assert(String(r.body.detail).includes(String(LIMIT)), "the refusal names the limit");
      const last = (await rowsWhere("cash_load", "asset_id", vault)).at(-1)!;
      assertEq(last.blocked_reason, "limit_exceeded", "reason");
      assertEq(Number(last.projected_balance_cents), VAULT_BAL + 300_000_00, "projection recorded");
      assertEq(await balanceOf(vault), VAULT_BAL + 100_000_00, "no cash moved");
      const zero = await load(teller, vault, 0, "teller_a", "teller_b");
      assertEq(zero.status, 400, `zero load (${body(zero)})`);
      const ghost = await load(teller, rid("casset_ghost"), 100, "teller_a", "teller_b");
      assertEq(ghost.status, 404, `unknown asset (${body(ghost)})`);
    });

    await t.step("day-end reconciliation that balances posts NO suspense item", async () => {
      const r = await api("POST", `/cash-ops/assets/${vault}/reconciliations`, {
        business_date: "2026-07-15", counted_cents: 600_000_00, gl_balance_cents: 600_000_00,
      }, { key: teller });
      assertEq(r.status, 201, `balanced recon (${body(r)})`);
      assertEq(r.body.data.balanced, true, "balanced");
      const rec = await rowById("cash_reconciliation", r.body.data.id);
      assertEq(rec.variance_cents, 0, "zero variance");
      assertEq(await rowById("gl_cash_suspense", `glsus_${r.body.data.id}`), null, "no suspense item");
      assertEq((await rowById("event", `ev_${r.body.data.id}_rec`))?.code, "cash.recon.completed", "recon completed event");
      const bad = await api("POST", `/cash-ops/assets/${vault}/reconciliations`, { business_date: "2026-07-15" }, { key: teller });
      assertEq(bad.status, 400, `recon without figures (${body(bad)})`);
    });

    await t.step("a $50 short day parks in GL suspense with a five-day aging clock; a second variance day parks another", async () => {
      for (const [date, counted] of [["2026-07-16", 599_950_00], ["2026-07-17", 599_900_00]] as const) {
        const r = await api("POST", `/cash-ops/assets/${vault}/reconciliations`, {
          business_date: date, counted_cents: counted, gl_balance_cents: 600_000_00, research_notes: "flow: short",
        }, { key: teller });
        assertEq(r.status, 201, `variance recon (${body(r)})`);
        assertEq(r.body.data.balanced, false, "unbalanced");
        const sid = `glsus_${r.body.data.id}`;
        const sus = await rowById("gl_cash_suspense", sid);
        assert(sus, "suspense item posted");
        assertEq(Number(sus.amount_cents), counted - 600_000_00, "suspense carries the variance");
        const clock = ms(sus.escalate_at) - ms(sus.opened_at);
        assert(Math.abs(clock - 5 * DAY) < 60_000, `escalates five days after opening (got ${clock / DAY}d)`);
        assertEq((await rowById("event", `ev_${sid}_post`))?.code, "gl.cash_suspense.posted", "suspense posted event");
        assertEq((await rowById("event", `ev_${r.body.data.id}_var`))?.code, "cash.recon.variance_found", "variance event");
        suspense.push(sid);
      }
    });

    await t.step("five days pass on the first item only; the sweep escalates it and touches every row it examines", async () => {
      // Simulated clock: the API cannot move time, so the first item's aging
      // deadline is backdated on the row — exactly what five days would do.
      // Both rows get a sentinel updated_at so "was it examined" is decidable.
      const SENTINEL = "1999-01-01T00:00:00.000Z";
      const aged = await core().from("gl_cash_suspense").update({ escalate_at: new Date(Date.now() - DAY).toISOString() }).eq("id", suspense[0]);
      assert(!aged.error, `age item: ${aged.error?.message}`);
      const stamp = await core().from("gl_cash_suspense").update({ updated_at: SENTINEL }).in("id", suspense);
      assert(!stamp.error, `stamp: ${stamp.error?.message}`);

      const r = await api("POST", "/cash-ops/suspense/sweep", {}, { key: teller });
      assertEq(r.status, 200, `sweep (${body(r)})`);
      assert(r.body.data.examined >= 2, `examined both open items (got ${r.body.data.examined})`);
      const first = await rowById("gl_cash_suspense", suspense[0]);
      const second = await rowById("gl_cash_suspense", suspense[1]);
      assert(first.escalated_at, "aged item escalated");
      assertEq(second.escalated_at, null, "fresh item not escalated");
      assert(ms(first.updated_at) > ms(SENTINEL), "escalated row touched");
      assert(ms(second.updated_at) > ms(SENTINEL), "the NON-escalated row was touched too, so the sweep window advances");
      assertEq((await rowById("event", `ev_${suspense[0]}_esc`))?.code, "gl.cash_suspense.escalated", "escalation event");
      assertEq(await rowById("event", `ev_${suspense[1]}_esc`), null, "no escalation event for the fresh item");

      const again = await api("POST", "/cash-ops/suspense/sweep", {}, { key: teller });
      assertEq(again.status, 200, "re-sweep");
      assertEq((await rowById("gl_cash_suspense", suspense[0])).escalated_at, first.escalated_at, "re-sweep does not re-escalate");
    });

    await t.step("clearing suspense requires the correcting GL entry", async () => {
      const bare = await api("POST", `/cash-ops/suspense/${suspense[0]}/clear`, {}, { key: teller });
      assertEq(bare.status, 400, `bare clear (${body(bare)})`);
      assert(fields(bare).includes("correction_txn_id"), "the refusal names correction_txn_id");
      assertEq((await rowById("gl_cash_suspense", suspense[0])).cleared_at, null, "still open");
      const ok = await api("POST", `/cash-ops/suspense/${suspense[0]}/clear`, { correction_txn_id: "gl_flow_corr_1" }, { key: teller });
      assertEq(ok.status, 200, `clear (${body(ok)})`);
      const row = await rowById("gl_cash_suspense", suspense[0]);
      assert(row.cleared_at, "cleared");
      assertEq(row.correction_txn_id, "gl_flow_corr_1", "correcting entry recorded");
      assertEq((await rowById("event", `ev_${suspense[0]}_clr`))?.code, "gl.cash_suspense.cleared", "cleared event");
    });
  } finally {
    // leave no open suspense behind: the sweep is instance-wide
    for (const sid of suspense) {
      await api("POST", `/cash-ops/suspense/${sid}/clear`, { correction_txn_id: "gl_flow_cleanup" }, { key: teller })
        .catch(() => {});
    }
  }
});

// ------------------------------------------------------------ CP-07 over/short

flow("cash_ops: a teller's repeated shorts accumulate per custodian → threshold crossed → BSA alert → investigated and resolved", async (t) => {
  const supervisor = await actor("pynthia_ops");
  const drawer = await registerAsset(supervisor, "teller_drawer", 20_000_00);
  const repeat = rid("teller_repeat");
  const posted: string[] = [];

  const overshort = (custodian: string, amount: number, threshold?: number) =>
    api("POST", `/cash-ops/assets/${drawer}/overshort`, {
      custodian_user_id: custodian, business_date: "2026-07-10", amount_cents: amount,
      ...(threshold === undefined ? {} : { threshold_cents: threshold }),
    }, { key: supervisor });

  await t.step("an over/short with no amount or custodian is refused", async () => {
    const r = await overshort(repeat, 0, 10_000);
    assertEq(r.status, 400, `zero amount (${body(r)})`);
    const r2 = await api("POST", `/cash-ops/assets/${drawer}/overshort`, { amount_cents: -100 }, { key: supervisor });
    assertEq(r2.status, 400, `no custodian (${body(r2)})`);
    assertEq((await rowsWhere("cash_overshort", "asset_id", drawer)).length, 0, "nothing recorded");
  });

  await t.step("two shorts ($20, $18) stay under a $100 threshold; each opens a three-day investigation", async () => {
    for (const amt of [-2_000, -1_800]) {
      const r = await overshort(repeat, amt, 10_000);
      assertEq(r.status, 201, `post over/short (${body(r)})`);
      posted.push(r.body.data.id);
      const row = await rowById("cash_overshort", r.body.data.id);
      const window = ms(row.investigation_due_at) - ms(row.investigation_opened_at);
      assert(Math.abs(window - 3 * DAY) < 60_000, `three-day investigation window (got ${window / DAY}d)`);
      assertEq((await rowById("event", `ev_${r.body.data.id}_inv`))?.code, "cash.overshort_investigation.opened", "investigation opened");
      assertEq(await rowById("event", `ev_${r.body.data.id}_thr`), null, "no threshold crossing yet");
    }
    assertEq((await rowById("cash_overshort", posted[1])).cumulative_cents, 3_800, "cumulative running total");
  });

  await t.step("a third short ($90) takes the CUMULATIVE over the threshold: crossing event + structuring BSA alert", async () => {
    const r = await overshort(repeat, -9_000, 10_000);
    assertEq(r.status, 201, `third over/short (${body(r)})`);
    assertEq(r.body.data.cumulative_cents, 12_800, "cumulative on response");
    posted.push(r.body.data.id);
    const thr = await rowById("event", `ev_${r.body.data.id}_thr`);
    assertEq(thr?.code, "cash.overshort.threshold_crossed", "threshold crossed");
    assertEq(thr.payload["cash.overshort.pattern"], "3 events", "the pattern is named");
    const alert = await rowById("bsa_alert", `alert_${r.body.data.id}_structuring`);
    assert(alert, "BSA alert raised through the shared alert writer");
    assertEq(alert.entity_hash, repeat, "alert names the custodian");
    assertEq(alert.status, "open", "alert open for triage");
    assert(alert.triage_due_at, "BSA-06 triage clock started");
  });

  await t.step("three DIFFERENT tellers at $90 each never aggregate into one pattern", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await overshort(rid("teller_once"), -9_000, 10_000);
      assertEq(r.status, 201, `single short (${body(r)})`);
      assertEq(r.body.data.cumulative_cents, 9_000, "cumulative is per custodian");
      assertEq(await rowById("event", `ev_${r.body.data.id}_thr`), null, "no crossing");
      assertEq(await rowById("bsa_alert", `alert_${r.body.data.id}_structuring`), null, "no alert");
    }
  });

  await t.step("with no institutional threshold set the verdict is UNASSESSED, never 'not crossed'", async () => {
    const r = await overshort(rid("teller_big"), -99_999_00);
    assertEq(r.status, 201, `unthresholded short (${body(r)})`);
    const ev = await rowById("event", `ev_${r.body.data.id}_unassessed`);
    assertEq(ev?.code, "cash.overshort.thresholds", "threshold verdict event");
    assertEq(ev.payload.verdict, "unassessed", "unassessed");
    assertEq(await rowById("event", `ev_${r.body.data.id}_thr`), null, "no crossing claimed");
  });

  await t.step("the supervisor resolves the investigation: research notes required, unknown item 404, resolution recorded on time", async () => {
    const bare = await api("POST", `/cash-ops/overshort/${posted[2]}/resolve`, {}, { key: supervisor });
    assertEq(bare.status, 400, `resolve without notes (${body(bare)})`);
    assert(fields(bare).includes("research_notes"), "the refusal names research_notes");
    const ghost = await api("POST", `/cash-ops/overshort/${rid("cashos_ghost")}/resolve`, { research_notes: "x" }, { key: supervisor });
    assertEq(ghost.status, 404, `unknown over/short (${body(ghost)})`);
    const ok = await api("POST", `/cash-ops/overshort/${posted[2]}/resolve`, {
      research_notes: "flow: miscount on strap, coached teller",
    }, { key: supervisor });
    assertEq(ok.status, 200, `resolve (${body(ok)})`);
    const row = await rowById("cash_overshort", posted[2]);
    assert(row.resolved_at, "resolved");
    assertEq(row.research_notes, "flow: miscount on strap, coached teller", "research recorded");
    const ev = await rowById("event", `ev_${posted[2]}_res`);
    assertEq(ev?.code, "cash.overshort.resolved", "resolved event");
    assertEq(ev.payload.resolved_late, false, "resolved inside the investigation window");
  });
});

// --------------------------------------------------- CP-08 shipments, night drop

flow("cash_ops: courier shipments arrive — seal verified under dual control, a mismatch declares an incident, CMIR only for border crossings over $10k; night drop needs two people", async (t) => {
  const vaultTeller = await actor("pynthia_ops");
  const ship = (id: string, extra: Record<string, unknown>) =>
    api("POST", "/cash-ops/shipments", { id, direction: "inbound", amount_cents: 100_00, ...extra }, { key: vaultTeller });
  const verify = (id: string, seal: string, counter: string, custodian: string) =>
    api("POST", `/cash-ops/shipments/${id}/verify`, { seal_found: seal, counter_user_id: counter, custodian_user_id: custodian }, { key: vaultTeller });

  await t.step("a shipment with no EXPECTED seal is refused at dispatch", async () => {
    const id = rid("cashship_noseal");
    const r = await ship(id, {});
    assertEq(r.status, 400, `no seal (${body(r)})`);
    assert(fields(r).includes("seal_expected"), "the refusal names seal_expected");
    assertEq(await rowById("cash_shipment", id), null, "nothing written");
  });

  await t.step("a matching seal, counted by two different people, verifies the shipment with no incident", async () => {
    const id = rid("cashship_ok");
    const s = await ship(id, { seal_expected: "SEAL-A", courier_receipt_id: "brinks-123" });
    assertEq(s.status, 201, `dispatch (${body(s)})`);
    const row0 = await rowById("cash_shipment", id);
    const due = ms(row0.verification_due_at) - ms(row0.created_at);
    assert(Math.abs(due - DAY) < 60_000, `same-day verification clock (got ${due / DAY}d)`);
    assertEq((await rowById("event", `ev_${id}_recv`))?.code, "cash.shipment.received", "received event");

    const same = await verify(id, "SEAL-A", "teller_x", "teller_x");
    assertEq(same.status, 400, `one person verifying (${body(same)})`);
    assertEq((await rowById("cash_shipment", id)).verified_at, null, "not verified by one person");

    const ok = await verify(id, "SEAL-A", "teller_x", "teller_y");
    assertEq(ok.status, 200, `verify (${body(ok)})`);
    const row = await rowById("cash_shipment", id);
    assert(row.verified_at, "verification recorded");
    assertEq(row.seal_matched, true, "seal matched");
    assertEq(row.incident_id, null, "no incident");
    const codes = await codesFor("cash_shipment", id);
    assert(codes.includes("cash.shipment.verified"), "verified event");
    assert(codes.includes("cash.dual_control.completed"), "dual control evidence");
    assert(!codes.includes("cash.seal.mismatch"), "no mismatch");
    assertEq(await rowById("incident", `inc_seal_${id}`), null, "no incident declared");
  });

  await t.step("a seal that does not match declares a sev2 INCIDENT and the shipment stays unverified", async () => {
    const id = rid("cashship_bad");
    assertEq((await ship(id, { seal_expected: "SEAL-B" })).status, 201, "dispatch");
    const r = await verify(id, "SEAL-Z", "teller_x", "teller_y");
    assertEq(r.status, 409, `mismatch (${body(r)})`);
    assertEq(r.body.type, "cash_seal_mismatch", "typed refusal");
    const row = await rowById("cash_shipment", id);
    assertEq(row.seal_matched, false, "seal recorded as mismatched");
    assertEq(row.seal_found, "SEAL-Z", "found seal recorded");
    assertEq(row.verified_at, null, "NOT verified");
    assertEq(row.incident_id, `inc_seal_${id}`, "shipment points at its incident");
    const inc = await rowById("incident", `inc_seal_${id}`);
    assert(inc, "incident row declared");
    assertEq(inc.severity, "sev2", "severity");
    assertEq(inc.status, "declared", "status");
    assertEq(inc.source, "cash_operations", "source");
    assert((await codesFor("cash_shipment", id)).includes("cash.seal.mismatch"), "seal mismatch event");
    assert((await codesFor("incident", `inc_seal_${id}`)).includes("incident.created"), "incident.created event");
    const ghost = await verify(rid("cashship_ghost"), "S", "a", "b");
    assertEq(ghost.status, 404, `unknown shipment (${body(ghost)})`);
  });

  await t.step("CMIR attaches only to a border crossing above $10,000", async () => {
    const dom = rid("cashship_dom");
    assertEq((await ship(dom, { direction: "outbound", amount_cents: 45_000_00, seal_expected: "D" })).status, 201, "domestic");
    const small = rid("cashship_small");
    assertEq((await ship(small, { direction: "outbound", amount_cents: 500_00, seal_expected: "S", crosses_border: true })).status, 201, "small border");
    const intl = rid("cashship_intl");
    assertEq((await ship(intl, { direction: "outbound", amount_cents: 45_000_00, seal_expected: "I", crosses_border: true })).status, 201, "big border");
    assertEq(await rowById("cmir_filing", `cmir_${dom}`), null, "domestic over $10k: no CMIR");
    assertEq(await rowById("cmir_filing", `cmir_${small}`), null, "border under $10k: no CMIR");
    const cmir = await rowById("cmir_filing", `cmir_${intl}`);
    assert(cmir, "CMIR identified on receipt");
    assertEq(Number(cmir.amount_cents), 45_000_00, "CMIR amount");
    assertEq(cmir.filed_at, null, "identified, not yet filed");
    assertEq((await rowById("event", `ev_cmir_${intl}_id`))?.code, "cmir.reportable.identified", "reportable event");
  });

  await t.step("night drop retrieval: one person is refused, two people verify the bags", async () => {
    const drop = await registerAsset(vaultTeller, "night_drop", 0);
    const one = await api("POST", `/cash-ops/nightdrop/${drop}/retrieve`, { counter_user_id: "teller_x", custodian_user_id: "teller_x" }, { key: vaultTeller });
    assertEq(one.status, 400, `single custody (${body(one)})`);
    assertEq((await codesFor("cash_asset", drop)).length, 0, "nothing recorded for the refused retrieval");
    const two = await api("POST", `/cash-ops/nightdrop/${drop}/retrieve`, { counter_user_id: "teller_x", custodian_user_id: "teller_y", bag_count: 3 }, { key: vaultTeller });
    assertEq(two.status, 201, `retrieval (${body(two)})`);
    const nd = await rowById("event", `ev_${two.body.data.id}_nd`);
    assertEq(nd?.code, "cash.nightdrop.verified", "night drop verified");
    assertEq(nd.payload.bag_count, 3, "bag count recorded");
    assertEq((await rowById("event", `ev_${two.body.data.id}_dual`))?.code, "cash.dual_control.completed", "dual control evidence");
  });
});

// --------------------------------------------------------- CP-09 surprise count

flow("cash_ops: an auditor's surprise count is scheduled, an uncounted completion is refused, a variance opens the over/short investigation", async (t) => {
  const auditor = await actor("pynthia_ops");
  const vault = await registerAsset(auditor, "vault", 500_000_00, "cust_count_flow");
  const atm = await registerAsset(auditor, "atm", 40_000_00);
  let countId = "";

  await t.step("schedule a surprise count: due by end of the scheduled day", async () => {
    const bad = await api("POST", "/cash-ops/surprise-counts", { asset_id: vault }, { key: auditor });
    assertEq(bad.status, 400, `no date (${body(bad)})`);
    const r = await api("POST", "/cash-ops/surprise-counts", { asset_id: vault, scheduled_for: "2026-07-18" }, { key: auditor });
    assertEq(r.status, 201, `schedule (${body(r)})`);
    countId = r.body.data.id;
    const row = await rowById("cash_surprise_count", countId);
    assertEq(ms(row.due_at), ms("2026-07-18T23:59:59.000Z"), "due end of day");
    assertEq(row.completed_at, null, "not yet counted");
    assertEq((await rowById("event", `ev_${countId}_due`))?.code, "cash.surprise_count.due", "due event");
  });

  await t.step("a completion with no counter is refused — an uncounted count is a schedule entry", async () => {
    const r = await api("POST", `/cash-ops/surprise-counts/${countId}/complete`, { counted_cents: 1 }, { key: auditor });
    assertEq(r.status, 400, `no counter (${body(r)})`);
    assert(fields(r).includes("counted_by"), "the refusal names counted_by");
    assertEq((await rowById("cash_surprise_count", countId)).completed_at, null, "still not completed");
    const ghost = await api("POST", `/cash-ops/surprise-counts/${rid("cashsc_ghost")}/complete`, { counted_cents: 1, counted_by: "a" }, { key: auditor });
    assertEq(ghost.status, 404, `unknown count (${body(ghost)})`);
  });

  await t.step("the count comes up $100 short: variance recorded against book and the over/short investigation opens", async () => {
    const r = await api("POST", `/cash-ops/surprise-counts/${countId}/complete`, { counted_cents: 499_900_00, counted_by: "auditor_flow" }, { key: auditor });
    assertEq(r.status, 200, `complete (${body(r)})`);
    assertEq(r.body.data.variance_cents, -100_00, "variance on response");
    const row = await rowById("cash_surprise_count", countId);
    assert(row.completed_at, "completed");
    assertEq(Number(row.book_cents), 500_000_00, "book balance captured");
    assertEq(Number(row.counted_cents), 499_900_00, "counted figure");
    assertEq(row.counted_by, "auditor_flow", "counter recorded");
    const inv = await rowById("event", `ev_${countId}_inv`);
    assertEq(inv?.code, "cash.overshort_investigation.opened", "investigation opened");
    assertEq(inv.payload["cash.custodian.user_id"], "cust_count_flow", "investigation names the custodian");
  });

  await t.step("a count that matches the book opens no investigation", async () => {
    const s = await api("POST", "/cash-ops/surprise-counts", { asset_id: atm, scheduled_for: "2026-07-19" }, { key: auditor });
    assertEq(s.status, 201, "schedule ATM count");
    const r = await api("POST", `/cash-ops/surprise-counts/${s.body.data.id}/complete`, { counted_cents: 40_000_00, counted_by: "auditor_flow" }, { key: auditor });
    assertEq(r.status, 200, `complete (${body(r)})`);
    assertEq(r.body.data.variance_cents, 0, "no variance");
    assertEq((await rowById("event", `ev_${s.body.data.id}_done`))?.code, "cash.surprise_count.completed", "completed event");
    assertEq(await rowById("event", `ev_${s.body.data.id}_inv`), null, "no investigation");
  });
});

// ------------------------------------------------------------ CP-10 deviations

flow("cash_ops: a holiday limit deviation requested by the branch is decided by a different officer with Board resolution AND bond → a whitelisted schedule that sunsets", async (t) => {
  const branch = await actor("pynthia_ops");
  const officer = await actor("cu_admin");
  const vault = await registerAsset(branch, "vault", 500_000_00);
  await setLimit(branch, vault, 750_000_00, { effective_at: new Date(Date.now() - DAY).toISOString() });
  const sunset = new Date(Date.now() + 30 * DAY).toISOString();
  let devId = "";

  const request = () => api("POST", "/cash-ops/deviations", {
    asset_id: vault, requested_limit_cents: 9_000_000_00, period_reason: "holiday", sunset_at: sunset,
  }, { key: branch });

  await t.step("before any deviation a $300k holiday load is over the limit", async () => {
    const r = await load(branch, vault, 300_000_00, "teller_a", "teller_b");
    assertEq(r.status, 409, `over limit (${body(r)})`);
  });

  await t.step("the branch requests a deviation; one with no sunset is refused", async () => {
    const bad = await api("POST", "/cash-ops/deviations", { asset_id: vault, requested_limit_cents: 1, period_reason: "x" }, { key: branch });
    assertEq(bad.status, 400, `no sunset (${body(bad)})`);
    const r = await request();
    assertEq(r.status, 201, `request (${body(r)})`);
    devId = r.body.data.id;
    const row = await rowById("cash_deviation", devId);
    assertEq(row.decision, "requested", "awaiting decision");
    assertEq((await rowById("event", `ev_${devId}_req`))?.code, "cash.deviation.requested", "requested event");
  });

  // PENDING A PRODUCT DECISION (2026-10-04): policy CA-10 makes the BOARD the
  // independent approver (a resolution id + bond adjustment are required and
  // enforced); it does not say the requester may not RECORD the Board's
  // decision. Whether the API should also refuse requester == recorder is the
  // product owner's call. Un-ignore once decided.
  await t.step({ name: "the requester cannot decide their own deviation (maker-checker)", ignore: true, fn: async () => {
    const own = await request();
    assertEq(own.status, 201, "a second request to self-decide");
    const r = await api("POST", `/cash-ops/deviations/${own.body.data.id}/decide`, {
      decision: "approved", board_resolution_id: "board-flow", insurance_bond_adjustment: "rider-flow",
    }, { key: branch });
    assert(r.status >= 400 && r.status < 500, `self-decision refused (got ${r.status} ${body(r)})`);
    assertEq((await rowById("cash_deviation", own.body.data.id)).decision, "requested", "self-decision changed nothing");
  } });

  await t.step("approval without the bond, or without the Board, is refused; the deviation stays requested", async () => {
    const noBond = await api("POST", `/cash-ops/deviations/${devId}/decide`, { decision: "approved", board_resolution_id: "board-flow" }, { key: officer });
    assertEq(noBond.status, 400, `no bond (${body(noBond)})`);
    assert(fields(noBond).includes("insurance_bond_adjustment"), "names the bond");
    const noBoard = await api("POST", `/cash-ops/deviations/${devId}/decide`, { decision: "approved", insurance_bond_adjustment: "rider-flow" }, { key: officer });
    assertEq(noBoard.status, 400, `no board (${body(noBoard)})`);
    assert(fields(noBoard).includes("board_resolution_id"), "names the Board resolution");
    assertEq((await rowById("cash_deviation", devId)).decision, "requested", "still requested");
    assertEq((await rowsWhere("cash_limits_schedule", "deviation_id", devId)).length, 0, "no schedule written");
    const ghost = await api("POST", `/cash-ops/deviations/${rid("cashdev_ghost")}/decide`, { decision: "denied" }, { key: officer });
    assertEq(ghost.status, 404, `unknown deviation (${body(ghost)})`);
  });

  await t.step("a different officer approves with Board + bond: a whitelisted, sunsetting schedule row is written", async () => {
    const r = await api("POST", `/cash-ops/deviations/${devId}/decide`, {
      decision: "approved", board_resolution_id: "board-flow", insurance_bond_adjustment: "rider-flow",
    }, { key: officer });
    assertEq(r.status, 200, `approve (${body(r)})`);
    const row = await rowById("cash_deviation", devId);
    assertEq(row.decision, "approved", "approved");
    assert(row.decided_at, "decision time");
    assertEq(row.insurance_bond_adjustment, "rider-flow", "bond recorded");
    const sched = await rowsWhere("cash_limits_schedule", "deviation_id", devId);
    assertEq(sched.length, 1, "one deviation schedule");
    assertEq(Number(sched[0].limit_cents), 9_000_000_00, "the requested limit");
    assertEq(ms(sched[0].sunset_at), ms(sunset), "it sunsets when the deviation does");
    assertEq(sched[0].whitelisted, true, "whitelisted");
    const dec = await rowById("event", `ev_${devId}_dec`);
    assertEq(dec?.code, "cash.deviation_board.decided", "decision event");
    assertEq(dec.payload["insurance.bond.adjustment"], "rider-flow", "bond on the evidence");
    assert((await codesFor("cash_asset", vault)).includes("cash.limits_whitelist.activated"), "whitelist activated");
  });

  await t.step("under the deviation the same holiday load is permitted", async () => {
    const r = await load(branch, vault, 300_000_00, "teller_a", "teller_b");
    assertEq(r.status, 201, `holiday load (${body(r)})`);
    assertEq(await balanceOf(vault), 800_000_00, "vault carries the holiday cash");
  });

  await t.step("a denied deviation writes no schedule", async () => {
    const d = await request();
    const r = await api("POST", `/cash-ops/deviations/${d.body.data.id}/decide`, { decision: "denied" }, { key: officer });
    assertEq(r.status, 200, `deny (${body(r)})`);
    assertEq((await rowById("cash_deviation", d.body.data.id)).decision, "denied", "denied");
    assertEq((await rowsWhere("cash_limits_schedule", "deviation_id", d.body.data.id)).length, 0, "no schedule");
  });
});

// ------------------------------------------------- CP-05 custody and keybox

flow("cash_ops: key custody granted to an active employee, attested, keybox opened only with a different second person; separation revokes it", async (t) => {
  const admin = await actor("cu_admin");
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  const holder = rid("emp_holder");
  const second = rid("emp_second");
  let custodyId = "";

  try {
    await t.step("HR declares two employees (vault keyholder and a second person)", async () => {
      for (const id of [holder, second]) {
        const r = await api("POST", "/hr/employees", { id, name: `Flow ${id}`, role: "vault_teller" }, { key: admin });
        assertEq(r.status, 201, `hire (${body(r)})`);
        assertEq((await rowById("employee", id)).status, "active", "active");
      }
    });

    await t.step("a partner cannot touch the custody registry", async () => {
      const r = await api("POST", "/cash-ops/custody", { employee_id: holder, kind: "keybox" }, { key: partner });
      assertEq(r.status, 403, `partner custody (${body(r)})`);
      assertEq((await rowsWhere("cash_custody", "employee_id", holder, "granted_at")).length, 0, "nothing granted");
    });

    await t.step("malformed grants are refused: missing kind, unknown employee, unknown kind", async () => {
      const noKind = await api("POST", "/cash-ops/custody", { employee_id: holder }, { key: admin });
      assertEq(noKind.status, 400, `no kind (${body(noKind)})`);
      const ghost = await api("POST", "/cash-ops/custody", { employee_id: rid("emp_ghost"), kind: "key" }, { key: admin });
      assertEq(ghost.status, 404, `unknown employee (${body(ghost)})`);
      const badKind = await api("POST", "/cash-ops/custody", { employee_id: holder, kind: "badge" }, { key: admin });
      // DEFECT: postCashCustody does not validate kind; the DB check (key|combination|keybox) turns it into a 500.
      assertEq(badKind.status, 400, `unknown kind (${body(badKind)})`);
    });

    await t.step("the admin grants keybox custody: rotation in 180 days, attestation in 90", async () => {
      const r = await api("POST", "/cash-ops/custody", { employee_id: holder, kind: "keybox", asset_id: rid("casset_keybox") }, { key: admin });
      assertEq(r.status, 201, `grant (${body(r)})`);
      custodyId = r.body.data.id;
      const row = await rowById("cash_custody", custodyId);
      assertEq(row.employee_id, holder, "holder");
      assertEq(row.revoked_at, null, "live");
      assert(Math.abs(ms(row.rotation_due_at) - ms(row.granted_at) - 180 * DAY) < 60_000, "rotation clock 180d");
      assert(Math.abs(ms(row.attestation_due_at) - ms(row.granted_at) - 90 * DAY) < 60_000, "attestation clock 90d");
      const codes = await codesFor("cash_custody", custodyId);
      for (const c of ["cash.coverage.updated", "cash.custody.rotation_due_at", "cash.coverage.attestation.due_at", "cash.evidence.created"]) {
        assert(codes.includes(c), `${c} emitted`);
      }
    });

    await t.step("operations attests the custody: attested now, next attestation 90 days out", async () => {
      const r = await api("POST", `/cash-ops/custody/${custodyId}/attest`, { attested_by: "ops_flow" }, { key: ops });
      assertEq(r.status, 200, `attest (${body(r)})`);
      const row = await rowById("cash_custody", custodyId);
      assert(row.attested_at, "attested");
      assert(Math.abs(ms(row.attestation_due_at) - ms(row.attested_at) - 90 * DAY) < 60_000, "clock restarted from attestation");
      assert((await codesFor("cash_custody", custodyId)).includes("cash.coverage.attested"), "attested event");
    });

    await t.step("the keyholder alone cannot open the keybox: no second person, or themselves as second, is refused", async () => {
      const alone = await api("POST", `/cash-ops/custody/${custodyId}/keybox-open`, { reason: "replace ATM cassette" }, { key: ops });
      assertEq(alone.status, 422, `no second person (${body(alone)})`);
      assertEq(alone.body.type, "dual_control_required", "typed refusal");
      const twice = await api("POST", `/cash-ops/custody/${custodyId}/keybox-open`, { second_person_id: holder, reason: "replace ATM cassette" }, { key: ops });
      assertEq(twice.status, 422, `self as second (${body(twice)})`);
      assertEq(twice.body.type, "dual_control_required", "typed refusal");
      const noReason = await api("POST", `/cash-ops/custody/${custodyId}/keybox-open`, { second_person_id: second }, { key: ops });
      assertEq(noReason.status, 422, `no reason (${body(noReason)})`);
      assertEq((await rowsWhere("cash_keybox_access", "custody_id", custodyId, "opened_at")).length, 0, "no access logged");
    });

    await t.step("a second person who is not an employee is refused, not a server error", async () => {
      const r = await api("POST", `/cash-ops/custody/${custodyId}/keybox-open`, { second_person_id: rid("emp_nobody"), reason: "replace ATM cassette" }, { key: ops });
      // DEFECT: postCashKeyboxOpen does not look up second_person_id; the employee FK turns an unknown person into a 500.
      assert(r.status >= 400 && r.status < 500, `unknown second person refused (got ${r.status} ${body(r)})`);
    });

    await t.step("with a different second person and a reason the keybox opens and the access is logged", async () => {
      const r = await api("POST", `/cash-ops/custody/${custodyId}/keybox-open`, { second_person_id: second, reason: "replace ATM cassette" }, { key: ops });
      assertEq(r.status, 201, `open (${body(r)})`);
      const acc = await rowById("cash_keybox_access", r.body.data.id);
      assertEq(acc.custody_id, custodyId, "custody");
      assertEq(acc.second_person_id, second, "second person");
      assertEq(acc.reason, "replace ATM cassette", "reason");
      const codes = await codesFor("cash_keybox_access", r.body.data.id);
      assert(codes.includes("cash.keybox_access.logged"), "access logged event");
      assert(codes.includes("cash.dual_control.completed"), "dual control evidence");
    });

    await t.step("the keyholder separates: custody revoked at once; attest, keybox and new grants are refused", async () => {
      const sep = await api("POST", `/hr/employees/${holder}/separate`, { reason: "flow: resigned" }, { key: admin });
      assertEq(sep.status, 200, `separate (${body(sep)})`);
      const row = await rowById("cash_custody", custodyId);
      assert(row.revoked_at, "custody revoked");
      assertEq(row.revoke_reason, "employee_separated", "revoke reason");
      assert((await codesFor("cash_custody", custodyId)).includes("cash.custody.revoked"), "revoked event");
      const att = await api("POST", `/cash-ops/custody/${custodyId}/attest`, {}, { key: ops });
      assertEq(att.status, 409, `attest revoked (${body(att)})`);
      assertEq(att.body.type, "custody_revoked", "typed refusal");
      const open = await api("POST", `/cash-ops/custody/${custodyId}/keybox-open`, { second_person_id: second, reason: "after hours" }, { key: ops });
      assertEq(open.status, 409, `keybox revoked (${body(open)})`);
      assertEq((await rowsWhere("cash_keybox_access", "custody_id", custodyId, "opened_at")).length, 1, "only the earlier access logged");
      const regrant = await api("POST", "/cash-ops/custody", { employee_id: holder, kind: "key" }, { key: admin });
      assertEq(regrant.status, 409, `grant to separated (${body(regrant)})`);
      assertEq(regrant.body.type, "custody_to_separated_employee", "typed refusal");
      assertEq((await rowsWhere("cash_custody", "employee_id", holder, "granted_at")).length, 1, "no new custody");
    });
  } finally {
    // the second person was a fixture: separate it so no test employee stays active
    await api("POST", `/hr/employees/${second}/separate`, { reason: "flow: fixture cleanup" }, { key: admin }).catch(() => {});
  }
});

// ------------------------------------------------------- CP-03 enterprise cash

/** three free month-end as_of_dates in one 1900s year (positions are keyed by date) */
async function freeMonthEnds(): Promise<[string, string, string]> {
  for (let i = 0; i < 20; i++) {
    const y = 1901 + Math.floor(Math.random() * 98);
    const r = await core().from("cash_enterprise_position").select("id").like("id", `cashent_${y}%`);
    assert(!r.error, `position read: ${r.error?.message}`);
    if ((r.data ?? []).length === 0) return [`${y}-01-31`, `${y}-02-28`, `${y}-03-31`];
  }
  throw new Error("no free year for enterprise positions");
}

flow("cash_ops: treasury posts month-end enterprise cash positions — unassessed without a Board limit, warning band, breach → invest-excess notice → remediation refused until actually under", async (t) => {
  const treasury = await actor("pynthia_ops");
  const [d1, d2, d3] = await freeMonthEnds();
  const ASSETS = 50_000_000_00;
  const posId = (d: string) => `cashent_${d.replace(/-/g, "")}`;
  const post = (b: Record<string, unknown>) => api("POST", "/cash-ops/enterprise-positions", { gl_total_assets_cents: ASSETS, ...b }, { key: treasury });

  await t.step("a position with no total assets is refused", async () => {
    const r = await api("POST", "/cash-ops/enterprise-positions", { as_of_date: d1, cash_cents: 1 }, { key: treasury });
    assertEq(r.status, 400, `no total assets (${body(r)})`);
    assertEq(await rowById("cash_enterprise_position", posId(d1)), null, "nothing written");
  });

  await t.step("with no Board limit the position is UNASSESSED — never 'within limit'", async () => {
    const r = await post({ as_of_date: d1, cash_cents: 9_000_000_00 });
    assertEq(r.status, 201, `post (${body(r)})`);
    assertEq(r.body.data.verdict, "unassessed", "verdict");
    const row = await rowById("cash_enterprise_position", posId(d1));
    assertEq(row.verdict, "unassessed", "stored verdict");
    assertEq(row.headroom_cents, null, "no headroom claimed");
    const codes = await codesFor("cash_enterprise_position", posId(d1));
    assert(codes.includes("cash.enterprise_position.posted"), "posted");
    assert(!codes.includes("cash.enterprise_limit.warning") && !codes.includes("cash.enterprise_limit.breached"), "no verdict events");
  });

  await t.step("240bp against a 300bp limit / 200bp warning band: WARNING, not a breach", async () => {
    const r = await post({ as_of_date: d2, cash_cents: 1_200_000_00, limit_bp: 300, warning_bp: 200 });
    assertEq(r.status, 201, `post (${body(r)})`);
    assertEq(r.body.data.verdict, "warning", "verdict");
    assertEq(r.body.data.utilization_bp, 240, "utilization");
    const codes = await codesFor("cash_enterprise_position", posId(d2));
    assert(codes.includes("cash.enterprise_limit.warning"), "warning event");
    assert(!codes.includes("cash.enterprise_limit.breached"), "no breach");
    const rem = await api("POST", `/cash-ops/enterprise-positions/${posId(d2)}/remediate`, { action: "swept", cash_cents: 1 }, { key: treasury });
    assertEq(rem.status, 409, `remediate a warning (${body(rem)})`);
    assertEq(rem.body.type, "cash_enterprise_not_breached", "nothing to remediate");
  });

  await t.step("400bp: BREACH — excess computed, 30-day remediation clock, treasury told to invest the excess", async () => {
    const r = await post({ as_of_date: d3, cash_cents: 2_000_000_00, limit_bp: 300, warning_bp: 200 });
    assertEq(r.status, 201, `post (${body(r)})`);
    assertEq(r.body.data.verdict, "breached", "verdict");
    const row = await rowById("cash_enterprise_position", posId(d3));
    assertEq(Number(row.excess_cents), 2_000_000_00 - 1_500_000_00, "excess over the limit");
    const clock = ms(row.remediation_due_at) - ms(row.created_at);
    assert(Math.abs(clock - 30 * DAY) < 60_000, `30-day remediation clock (got ${clock / DAY}d)`);
    const codes = await codesFor("cash_enterprise_position", posId(d3));
    for (const c of ["cash.enterprise_limit.breached", "cash.enterprise_limit.remediation.due_at", "treasury.invest_excess.notified"]) {
      assert(codes.includes(c), `${c} emitted`);
    }
    assertEq((await rowById("event", `ev_${posId(d3)}_treas`)).payload["cash.enterprise_position.excess"], 500_000_00, "notice carries the excess");
  });

  await t.step("a remediation that is still over the limit (or only a plan) is refused; one under the limit clears it", async () => {
    const plan = await api("POST", `/cash-ops/enterprise-positions/${posId(d3)}/remediate`, { action: "plan" }, { key: treasury });
    assertEq(plan.status, 400, `plan only (${body(plan)})`);
    const still = await api("POST", `/cash-ops/enterprise-positions/${posId(d3)}/remediate`, { action: "swept", cash_cents: 1_900_000_00 }, { key: treasury });
    assertEq(still.status, 409, `still over (${body(still)})`);
    assertEq(still.body.type, "cash_enterprise_still_breached", "typed refusal");
    assertEq((await rowById("cash_enterprise_position", posId(d3))).remediated_at, null, "not remediated");
    assert(!(await codesFor("cash_enterprise_position", posId(d3))).includes("cash.enterprise_limit.remediated"), "no remediation event");
    const ok = await api("POST", `/cash-ops/enterprise-positions/${posId(d3)}/remediate`, { action: "swept", cash_cents: 1_400_000_00 }, { key: treasury });
    assertEq(ok.status, 200, `remediate (${body(ok)})`);
    assertEq(ok.body.data.utilization_bp, 280, "utilization after the sweep");
    assert((await rowById("cash_enterprise_position", posId(d3))).remediated_at, "remediated");
    const ev = await rowById("event", `ev_${posId(d3)}_rem`);
    assertEq(ev?.code, "cash.enterprise_limit.remediated", "remediated event");
    assertEq(ev.payload.within_deadline, true, "inside the 30-day window");
    const ghost = await api("POST", `/cash-ops/enterprise-positions/${rid("cashent_ghost")}/remediate`, { cash_cents: 1 }, { key: treasury });
    assertEq(ghost.status, 404, `unknown position (${body(ghost)})`);
  });
});

// ------------------------------------------- CP-01 / CP-09 / CP-12 governance

flow("cash_ops: governance cycle — Board adopts the cash policy, exceptions logged with risk acceptance, monthly KRI computed from the registers, examiner records package, quarterly Board summary", async (t) => {
  const cfo = await actor("cu_admin");
  const ops = await actor("pynthia_ops");
  const version = `flow-cash-${RUN}`;
  const period = `flow-${RUN}`;
  const quarter = `flowQ-${RUN}`;
  const drawer = await registerAsset(ops, "teller_drawer", 10_000_00);
  let excId = "";
  let kriId = "";

  await t.step("the Board adopts a policy version: expiry anchored on the ADOPTION date, not on the write", async () => {
    const bad = await api("POST", "/cash-ops/policy", { policy_document_version: version }, { key: cfo });
    assertEq(bad.status, 400, `no board resolution (${body(bad)})`);
    // a historical adoption, so it never displaces the live policy
    const r = await api("POST", "/cash-ops/policy", {
      policy_document_version: version, board_resolution_id: "board-flow", adopted_at: "2025-01-31T00:00:00.000Z",
    }, { key: cfo });
    assertEq(r.status, 201, `adopt (${body(r)})`);
    const row = await rowById("cash_policy", r.body.data.id);
    assertEq(ms(row.adopted_at), ms("2025-01-31T00:00:00.000Z"), "adoption date as declared");
    assertEq(ms(row.policy_expiry_at), ms("2026-01-31T00:00:00.000Z"), "expires twelve months after ADOPTION");
    const codes = await codesFor("cash_policy", r.body.data.id);
    assert(codes.includes("policy.board.approved") && codes.includes("policy.revision.published"), "approval + publication events");
  });

  await t.step("an exception with no rationale or risk acceptance is refused; a complete one is registered", async () => {
    const bad = await api("POST", "/cash-ops/exceptions", { kind: "override", rationale: "r" }, { key: ops });
    assertEq(bad.status, 400, `incomplete exception (${body(bad)})`);
    assert(fields(bad).includes("risk_acceptance") && fields(bad).includes("accepted_by"), `names the missing fields (${fields(bad)})`);
    const r = await api("POST", "/cash-ops/exceptions", {
      kind: "override", rationale: "flow: armored car late", risk_acceptance: "accepted", accepted_by: "cfo_flow", asset_id: drawer,
    }, { key: ops });
    assertEq(r.status, 201, `exception (${body(r)})`);
    excId = r.body.data.id;
    const row = await rowById("cash_exception", excId);
    assertEq(row.risk_acceptance, "accepted", "risk acceptance recorded");
    assertEq((await rowById("event", `ev_${excId}_exc`))?.code, "cash.exception.logged", "logged event");
  });

  await t.step("the month's activity lands in the registers: an over/short and an unreconciled day", async () => {
    const os = await api("POST", `/cash-ops/assets/${drawer}/overshort`, { custodian_user_id: rid("teller_kri"), amount_cents: -2_500 }, { key: ops });
    assertEq(os.status, 201, `over/short (${body(os)})`);
    const rec = await api("POST", `/cash-ops/assets/${drawer}/reconciliations`, {
      business_date: "2026-07-16", counted_cents: 9_950_00, gl_balance_cents: 10_000_00,
    }, { key: ops });
    assertEq(rec.status, 201, `recon (${body(rec)})`);
    const clr = await api("POST", `/cash-ops/suspense/glsus_${rec.body.data.id}/clear`, { correction_txn_id: "gl_flow_kri" }, { key: ops });
    assertEq(clr.status, 200, "suspense cleared by the correcting entry");
  });

  await t.step("the KRI pack is COMPUTED from the whole registers — a caller-supplied figure is ignored", async () => {
    const r = await api("POST", "/cash-ops/kri", { period, overshort_monthly_summary_cents: 0 }, { key: ops });
    assertEq(r.status, 201, `publish KRI (${body(r)})`);
    kriId = r.body.data.id;
    const kri = await rowById("cash_kri", kriId);
    const os = await allRows("cash_overshort", "id, amount_cents");
    const osTotal = os.reduce((n, x) => n + Math.abs(Number(x.amount_cents)), 0);
    assert(Number(kri.overshort_monthly_summary_cents) > 0, "the supplied 0 was ignored");
    assertEq(kri.recon_variance_count, await exactCount("cash_reconciliation", (q) => q.eq("balanced", false)), "recon variances counted");
    assertEq(kri.exception_count, await exactCount("cash_exception"), "exceptions counted");
    assertEq(kri.suspense_open_count, await exactCount("gl_cash_suspense", (q) => q.is("cleared_at", null)), "open suspense counted");
    // DEFECT: postCashKriPublish reads cash_overshort without paging; PostgREST caps it at 1000 rows, so the KRI silently undercounts once the register passes 1000.
    assertEq(kri.overshort_event_count, os.length, `every over/short counted (register holds ${os.length})`);
    assertEq(Number(kri.overshort_monthly_summary_cents), osTotal, "over/short total summed over the whole register");
  });

  await t.step("the KRI publication carries the exception register and the over/short report", async () => {
    const pub = await rowById("event", `ev_${kriId}_pub`);
    assertEq(pub?.code, "cash.kri.published", "published event");
    assertEq(pub.payload.period, period, "period");
    const reg = await rowById("event", `ev_${kriId}_excreg`);
    assert((reg.payload["cash.exception_register"] as Any[]).some((e) => e.id === excId), "this run's exception is in the register");
    assertEq((await rowById("event", `ev_${kriId}_osrep`))?.code, "cash.overshort_report.issued", "over/short report issued");
  });

  await t.step("an examiner export needs a declared scope; its item count is COUNTED, with a manifest and checksum", async () => {
    const noScope = await api("POST", "/cash-ops/records-packages", { purpose: "exam_export" }, { key: ops });
    assertEq(noScope.status, 400, `no scope (${body(noScope)})`);
    assert(fields(noScope).includes("scope"), "names scope");
    const badPurpose = await api("POST", "/cash-ops/records-packages", { purpose: "gossip", scope: { period } }, { key: ops });
    assertEq(badPurpose.status, 400, `bad purpose (${body(badPurpose)})`);
    const r = await api("POST", "/cash-ops/records-packages", { purpose: "exam_export", scope: { period }, delivered_to: "NCUA" }, { key: ops });
    assertEq(r.status, 201, `package (${body(r)})`);
    const pkg = await rowById("records_package", r.body.data.id);
    assertEq(pkg.scope?.period, period, "declared scope stored");
    assertEq(pkg.delivered_to, "NCUA", "delivered to");
    assert(pkg.delivered_at, "delivery time");
    assertEq(pkg.records_package_manifest_id, `manifest_${r.body.data.id}`, "manifest");
    assertEq(pkg.records_package_checksum_chain?.[0]?.items, pkg.item_count, "checksum chain binds the count");
    const codes = await codesFor("records_package", r.body.data.id);
    for (const c of ["records_package.completed", "exam.export.delivered", "supervisory.count_results.delivered"]) {
      assert(codes.includes(c), `${c} emitted`);
    }
    const expected = await exactCount("cash_reconciliation") + await exactCount("cash_surprise_count") + await exactCount("cash_overshort");
    // DEFECT: postCashRecordsPackage selects the three registers without paging; the 1000-row cap makes item_count short of what the package claims to cover.
    assertEq(pkg.item_count, expected, "item count = every reconciliation, surprise count and over/short");
  });

  await t.step("the quarterly Board summary is assembled from the registers and reflects this month's KRI", async () => {
    const r = await api("POST", "/cash-ops/board-summary", { quarter }, { key: cfo });
    assertEq(r.status, 201, `board summary (${body(r)})`);
    const ev = await rowById("event", `ev_cashboard_${quarter}`);
    assertEq(ev?.code, "board.cash_summary.delivered", "delivered event");
    assertEq(ev.provenance, "demo", "demo evidence");
    assertEq(ev.payload.quarter, quarter, "quarter");
    assertEq(ev.payload["cash.exception_register.summary"].count, await exactCount("cash_exception"), "every exception counted");
    const assets = await allRows("cash_asset", "id, balance_cents");
    assertEq(ev.payload["cash.asset.balance"], assets.reduce((n, a) => n + Number(a.balance_cents), 0), "cash on hand summed over every asset, ours included");
    const latest = await core().from("cash_enterprise_position").select("utilization_bp").order("as_of_date", { ascending: false }).limit(1);
    assertEq(ev.payload["cash.enterprise_position"], latest.data?.[0]?.utilization_bp ?? null, "latest enterprise position");
    const kri = await rowById("cash_kri", kriId);
    // Latent: postCashBoardSummary takes (kri ?? [])[0] from an unordered
    // select. Green today only because every KRI row is computed from the same
    // first 1000 over/shorts (see the KRI DEFECT); once that is paged, an
    // arbitrary older period would differ and this goes red.
    assertEq(ev.payload["cash.overshort.monthly_summary"], Number(kri.overshort_monthly_summary_cents), "the summary carries the KRI just published");
  });

  await t.step("a partner is refused on the governance endpoints", async () => {
    const partner = await actor("partner");
    const r = await api("POST", "/cash-ops/board-summary", { quarter: `${quarter}-p` }, { key: partner });
    assertEq(r.status, 404, `partner board summary (${body(r)})`);
    assertEq(await rowById("event", `ev_cashboard_${quarter}-p`), null, "nothing delivered");
  });
});
