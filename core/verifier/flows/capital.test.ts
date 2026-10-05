// Capital flows: the CFO's quarter. A capital position is recorded, classified
// into the statutory PCA band, and every consequence of that band is applied in
// the same write — payout restriction, the 45-day net worth restoration plan
// (NWRP) clock, board escalation. The quarterly sweep then reports overdue
// plans and positions that were never assessed against an internal trigger.
// The CCO sets internal targets above the floor; the CFO prepares the capital
// plan, stress report and ICAAP report on a cycle. Replaces the stubbed unit
// tests in core/supabase/functions/api/capital.test.ts (see ledger/capital.md).
//
// SHARED-STATE DISCIPLINE. capital_position is keyed by as_of_date and the
// LATEST position is read institution-wide (CDA and investment caps take net
// worth from it, targets are tested against it). Every position here is dated
// in the 1900s so it can never become the latest, and is deleted at the end of
// its flow so the instance-wide sweep window (200 rows) never fills with
// fixtures. Events are evidence and are left in place.
import { actor, type Any, api, assert, assertEq, core, flow } from "./helpers.ts";

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);
const DAY = 86_400_000;

/** a 1900s date no capital_position row already holds (as_of_date is unique) */
async function freshPositionDate(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const y = 1900 + Math.floor(Math.random() * 100);
    const m = 1 + Math.floor(Math.random() * 12);
    const d = 1 + Math.floor(Math.random() * 28);
    const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const r = await core().from("capital_position").select("id").eq("as_of_date", date).maybeSingle();
    assert(!r.error, `capital_position read: ${r.error?.message}`);
    if (!r.data) return date;
  }
  throw new Error("no free 1900s as_of_date after 20 tries");
}

const posId = (date: string) => `cap_${date.replace(/-/g, "")}`;

async function positionRow(id: string) {
  const r = await core().from("capital_position").select("*").eq("id", id).maybeSingle();
  assert(!r.error, `capital_position read: ${r.error?.message}`);
  return r.data as Any;
}

/** event codes written against a capital resource, keyed by code */
async function capitalEvents(rid: string): Promise<Map<string, Any[]>> {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("resource_id", `capital:${rid}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  const m = new Map<string, Any[]>();
  for (const e of r.data ?? []) m.set(e.code, [...(m.get(e.code) ?? []), e]);
  return m;
}

function postPosition(key: string, o: Record<string, unknown>) {
  return api("POST", "/capital/positions", { total_assets_cents: 10_000_000_000, ...o }, { key });
}

/** within `slackMs` of `expectedMs` */
function near(iso: string | null, expectedMs: number, msg: string, slackMs = 120_000) {
  assert(iso, `${msg}: no timestamp`);
  const delta = Math.abs(new Date(iso!).getTime() - expectedMs);
  assert(delta < slackMs, `${msg}: ${iso} is ${Math.round(delta / 1000)}s from expected`);
}

async function deletePositions(ids: string[]) {
  if (!ids.length) return;
  const r = await core().from("capital_position").delete().in("id", ids);
  if (r.error) console.error(`cleanup capital_position ${ids.join(",")}: ${r.error.message}`);
}

// ------------------------------------------------- PCA bands, CP-03/04, NWRP

flow("capital: CFO records the quarter → PCA band applied → undercapitalized restricts payouts and starts the 45-day NWRP clock → plan filed", async (t) => {
  const cfo = await actor("pynthia_ops");
  const partner = await actor("partner");
  const created: string[] = [];
  try {
    let well = "";
    let buffer = "";
    let under = "";

    await t.step("a partner cannot reach the capital routes (404), and writes nothing", async () => {
      const date = await freshPositionDate();
      const r = await postPosition(partner, { as_of_date: date, net_worth_cents: 1_500_000_000 });
      assertEq(r.status, 404, `partner position (${body(r)})`);
      assertEq(await positionRow(posId(date)), null, "no position row");
    });

    await t.step("a malformed position is refused with every bad field named", async () => {
      const r = await api("POST", "/capital/positions", { net_worth_cents: 1, total_assets_cents: 0 }, { key: cfo });
      assertEq(r.status, 400, `malformed (${body(r)})`);
      const fields = JSON.stringify(r.body);
      assert(fields.includes("as_of_date"), "as_of_date named");
      assert(fields.includes("total_assets_cents"), "total_assets_cents named");
    });

    await t.step("15% net worth: well capitalized, unrestricted, ratio derived from the components", async () => {
      const date = await freshPositionDate();
      well = posId(date);
      created.push(well);
      const r = await postPosition(cfo, { as_of_date: date, net_worth_cents: 1_500_000_000 });
      assertEq(r.status, 201, `post position (${body(r)})`);
      const p = await positionRow(well);
      assertEq(p.net_worth_ratio_bp, 1500, "ratio stored from components");
      assertEq(p.pca_category, "well_capitalized", "band");
      assertEq(p.distribution_restricted, false, "no payout restriction");
      assertEq(p.nwrp_due_at, null, "no restoration plan owed");
      assertEq(p.provenance, "demo", "test-actor evidence labelled demo");
      const ev = await capitalEvents(well);
      assert(ev.has("capital.ratios.verified"), "capital.ratios.verified");
      assert(ev.has("capital.pca_classification.recorded"), "classification recorded");
      assert(!ev.has("capital.pca_threshold.breached"), "no PCA breach");
      assert(!ev.has("capital.buffer.breached"), "no buffer breach above 700bp");
    });

    await t.step("CP-03: with no Board trigger configured the verdict is NULL, not 'not breached'", async () => {
      const p = await positionRow(well);
      assertEq(p.internal_trigger_bp, null, "no trigger");
      assertEq(p.internal_trigger_breached, null, "no verdict either way");
      assert(!(await capitalEvents(well)).has("capital.internal_trigger.breached"), "no trigger event");
    });

    await t.step("a healthy institution cannot file an NWRP: 409 nwrp_not_required, nothing stamped", async () => {
      const r = await api("POST", `/capital/positions/${well}/nwrp`, { filed_by: "cfo_flow" }, { key: cfo });
      assertEq(r.status, 409, `nwrp on healthy (${body(r)})`);
      assertEq(r.body.type, "nwrp_not_required", "typed refusal");
      assertEq((await positionRow(well)).nwrp_filed_at, null, "no filing stamped");
    });

    await t.step("CP-03/CP-08: the Board sets a 16% trigger — the re-assessed position breaches it and escalates under both alias codes", async () => {
      const p0 = await positionRow(well);
      const r = await postPosition(cfo, { as_of_date: p0.as_of_date, net_worth_cents: 1_500_000_000, internal_trigger_bp: 1600 });
      assertEq(r.status, 201, `re-post with trigger (${body(r)})`);
      const p = await positionRow(well);
      assertEq(p.internal_trigger_bp, 1600, "trigger recorded");
      assertEq(p.internal_trigger_breached, true, "1500 < 1600 is a breach");
      assertEq(p.pca_category, "well_capitalized", "still well capitalized — the trigger sits above the floor");
      const ev = await capitalEvents(well);
      assert(ev.has("capital.internal_trigger.breached"), "internal_trigger.breached");
      assert(ev.has("capital.board_escalation"), "capital.board_escalation");
      assert(ev.has("capital.board_escalation.issued"), "capital.board_escalation.issued");
      assertEq(ev.get("capital.board_escalation")![0].payload?.reason, "internal_trigger", "escalation names its cause");
    });

    await t.step("CP-04: 6.99999% FLOORS to 699bp — adequately capitalized, unrestricted, but through the buffer", async () => {
      const date = await freshPositionDate();
      buffer = posId(date);
      created.push(buffer);
      const r = await postPosition(cfo, { as_of_date: date, net_worth_cents: 699_999_999 });
      assertEq(r.status, 201, `post position (${body(r)})`);
      const p = await positionRow(buffer);
      assertEq(p.net_worth_ratio_bp, 699, "floored, never rounded up into a better band");
      assertEq(p.pca_category, "adequately_capitalized", "band");
      assertEq(p.distribution_restricted, false, "no PCA restriction");
      assertEq(p.nwrp_due_at, null, "no NWRP owed");
      const ev = await capitalEvents(buffer);
      assert(ev.has("capital.buffer.breached"), "buffer breach is its own event");
      assert(!ev.has("capital.pca_threshold.breached"), "not a PCA breach");
    });

    await t.step("5.99999% floors to 599bp: undercapitalized — payouts restricted, NWRP due 45 days from the CLASSIFICATION", async () => {
      const date = await freshPositionDate();
      under = posId(date);
      created.push(under);
      const at = Date.now();
      const r = await postPosition(cfo, { as_of_date: date, net_worth_cents: 599_999_999 });
      assertEq(r.status, 201, `post position (${body(r)})`);
      const p = await positionRow(under);
      assertEq(p.net_worth_ratio_bp, 599, "floored");
      assertEq(p.pca_category, "undercapitalized", "band");
      assertEq(p.distribution_restricted, true, "payouts restricted in the same write");
      // the as_of_date is in the 1900s: a clock anchored on the quarter-end
      // would already be decades overdue
      near(p.nwrp_due_at, at + 45 * DAY, "NWRP due 45 days from classification");
      assertEq(p.nwrp_filed_at, null, "not filed yet");
      const ev = await capitalEvents(under);
      for (const c of [
        "capital.pca_threshold.breached", "capital.pca_mandatory_actions",
        "capital.distribution_restriction.applied", "capital.payout_restricted",
        "capital.board_escalation", "capital.board_escalation.issued", "capital.buffer.breached",
      ]) assert(ev.has(c), `${c} emitted`);
      assertEq(new Date(ev.get("capital.pca_mandatory_actions")![0].payload?.nwrp_due_at).getTime(), new Date(p.nwrp_due_at).getTime(), "mandatory-actions event carries the deadline");
    });

    await t.step("the deeper bands: 3.99999% → significantly, 1.99999% → critically undercapitalized", async () => {
      for (const [nw, bp, band] of [[399_999_999, 399, "significantly_undercapitalized"], [199_999_999, 199, "critically_undercapitalized"]] as const) {
        const date = await freshPositionDate();
        created.push(posId(date));
        const r = await postPosition(cfo, { as_of_date: date, net_worth_cents: nw });
        assertEq(r.status, 201, `post ${bp}bp (${body(r)})`);
        const p = await positionRow(posId(date));
        assertEq(p.net_worth_ratio_bp, bp, "floored");
        assertEq(p.pca_category, band, "band");
        assertEq(p.distribution_restricted, true, "restricted");
        assert(p.nwrp_due_at, "NWRP clock started");
      }
    });

    await t.step("an insolvent quarter (negative net worth) is still recorded — critically undercapitalized", async () => {
      // DEFECT: capital.ts floors the ratio (-2.47bp → -3) but the DB check
      // ck_capital_ratio_matches_components uses integer division, which
      // truncates toward zero (-2): every non-exact negative net worth is a 500.
      const date = await freshPositionDate();
      created.push(posId(date));
      const r = await postPosition(cfo, { as_of_date: date, net_worth_cents: -2_469_135, total_assets_cents: 10_000_000_000 });
      assertEq(r.status, 201, `post insolvent position (${body(r)})`);
      const p = await positionRow(posId(date));
      assertEq(p?.pca_category, "critically_undercapitalized", "band");
      assertEq(p?.distribution_restricted, true, "restricted");
    });

    await t.step("filing the NWRP: filed_by required, unknown position 404, then filed because one is due", async () => {
      const miss = await api("POST", `/capital/positions/${under}/nwrp`, {}, { key: cfo });
      assertEq(miss.status, 400, `no filed_by (${body(miss)})`);
      const unk = await api("POST", `/capital/positions/cap_00010101/nwrp`, { filed_by: "cfo_flow" }, { key: cfo });
      assertEq(unk.status, 404, `unknown position (${body(unk)})`);
      assertEq((await positionRow(under)).nwrp_filed_at, null, "refusals stamp nothing");

      const r = await api("POST", `/capital/positions/${under}/nwrp`, { filed_by: "cfo_flow" }, { key: cfo });
      assertEq(r.status, 200, `file NWRP (${body(r)})`);
      const p = await positionRow(under);
      assert(p.nwrp_filed_at, "filed_at stamped");
      assertEq(p.nwrp_filed_by, "cfo_flow", "filer recorded");
      const ev = await capitalEvents(under);
      assertEq(ev.get("capital.restoration_plan.filed")?.[0]?.payload?.filed_by, "cfo_flow", "restoration_plan.filed names the filer");
      assert(ev.has("capital.action_board.decided"), "board action decided");
    });
  } finally {
    await deletePositions(created);
  }
});

// ---------------------------------------------------------------- sweep

flow("capital: quarterly sweep escalates an overdue NWRP and reports unassessed triggers separately; a late filing and a Board trigger clear them", async (t) => {
  const admin = await actor("cu_admin");
  const ops = await actor("pynthia_ops");
  const partner = await actor("partner");
  const created: string[] = [];
  try {
    let id = "";
    let date = "";

    await t.step("an undercapitalized quarter with no Board trigger; its 45-day clock runs out", async () => {
      date = await freshPositionDate();
      id = posId(date);
      created.push(id);
      const r = await postPosition(ops, { as_of_date: date, net_worth_cents: 500_000_000 });
      assertEq(r.status, 201, `post position (${body(r)})`);
      assertEq((await positionRow(id)).pca_category, "undercapitalized", "band");
      // Clock simulation on OUR row only: the deadline is 45 days out and the
      // API offers no way to move time. Backdate it a day.
      const u = await core().from("capital_position")
        .update({ nwrp_due_at: new Date(Date.now() - DAY).toISOString() }).eq("id", id);
      assert(!u.error, `backdate: ${u.error?.message}`);
    });

    await t.step("a partner cannot run the sweep", async () => {
      const r = await api("POST", "/capital/sweep", {}, { key: partner });
      assert([403, 404].includes(r.status), `partner sweep refused (${r.status} ${body(r)})`);
    });

    await t.step("the sweep (cu_admin) names the overdue plan, escalates it, and reports the unassessed position SEPARATELY", async () => {
      const latest = await core().from("capital_position").select("id")
        .order("as_of_date", { ascending: false }).limit(1).single();
      assert(!latest.error, `latest read: ${latest.error?.message}`);
      const r = await api("POST", "/capital/sweep", {}, { key: admin });
      assertEq(r.status, 200, `sweep (${body(r)})`);
      const d = r.body.data;
      assert(d.nwrp_overdue_ids.includes(id), "our overdue NWRP is named");
      assert(d.unassessed_internal_trigger_ids.includes(id), "our position is reported as unassessed");
      assert(d.unassessed_internal_trigger >= 1 && d.note, "a note says a zero overdue count would not cover them");
      const ev = await capitalEvents(id);
      const over = (code: string) => (ev.get(code) ?? []).find((e) => e.payload?.reason === "nwrp_overdue");
      assertEq(over("capital.board_escalation")?.id, `ev_${id}_nwrpover_0`, "board escalation for the overdue plan");
      assertEq(over("capital.board_escalation.issued")?.id, `ev_${id}_nwrpover_1`, "both escalation aliases");
      // the quarterly report is issued on the LATEST position (never ours)
      const q = await capitalEvents(latest.data!.id);
      assert(q.has("capital.quarterly_report.issued"), "quarterly report on the latest position");
      assert(q.has("capital.quarterly_report_id"), "report id recorded");
    });

    await t.step("the CFO files late; the next sweep no longer lists the plan as overdue", async () => {
      const f = await api("POST", `/capital/positions/${id}/nwrp`, { filed_by: "cfo_late" }, { key: ops });
      assertEq(f.status, 200, `late filing (${body(f)})`);
      const r = await api("POST", "/capital/sweep", {}, { key: ops });
      assertEq(r.status, 200, `sweep (${body(r)})`);
      assert(!r.body.data.nwrp_overdue_ids.includes(id), "filed plan is not overdue");
      assert(r.body.data.unassessed_internal_trigger_ids.includes(id), "still unassessed until a trigger is set");
    });

    await t.step("the Board configures a trigger; the re-assessed position leaves the unassessed list", async () => {
      const r = await postPosition(ops, { as_of_date: date, net_worth_cents: 500_000_000, internal_trigger_bp: 800 });
      assertEq(r.status, 201, `re-post with trigger (${body(r)})`);
      assertEq((await positionRow(id)).internal_trigger_breached, true, "500 < 800 breached");
      const s = await api("POST", "/capital/sweep", {}, { key: ops });
      assertEq(s.status, 200, `sweep (${body(s)})`);
      assert(!s.body.data.unassessed_internal_trigger_ids.includes(id), "assessed now");
    });
  } finally {
    await deletePositions(created);
  }
});

// ------------------------------------------------------------ CP-01 targets

/** a 1900s effective date no capital_target already uses */
async function freshTargetDate(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const y = 1900 + Math.floor(Math.random() * 100);
    const date = `${y}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`;
    const r = await core().from("capital_target").select("id").eq("id", `captgt_${date.replace(/-/g, "")}`).maybeSingle();
    if (!r.data) return date;
  }
  throw new Error("no free target date");
}

flow("capital: the CCO sets an internal target — CCO only, above the floor, four eyes — and a target above the latest ratio is breached on arrival", async (t) => {
  const partner = await actor("partner");
  const opsNoRole = await actor("pynthia_ops");
  // The CCO role exists in auth.ts but may not be issuable (see the step
  // below); fall back to bsa_compliance, which the handler also accepts.
  let ccoMint = "";
  const cco = await actor("pynthia_ops", ["cco" as Any]).catch((e) => {
    ccoMint = String(e);
    return actor("pynthia_ops", ["bsa_compliance"]);
  });
  // CP-03 four eyes binds to the CREDENTIAL: the approver must be a different
  // token from the proposer, not just a different name in the body.
  const board = await actor("pynthia_ops", [ccoMint ? "bsa_compliance" : "cco" as Any]);
  const date = await freshTargetDate();
  const tid = `captgt_${date.replace(/-/g, "")}`;
  const target = (key: string, o: Record<string, unknown>) =>
    api("POST", "/capital/targets", { effective_date: date, target_bp: 900, proposed_by: "cco_flow", ...o }, { key });
  const targetRow = async () => (await core().from("capital_target").select("*").eq("id", tid).maybeSingle()).data as Any;

  await t.step("CP-03: a CCO token can be issued at all", () => {
    // DEFECT: auth.ts added the `cco` role for CP-03, but the DB constraint
    // ck_api_token_roles (20260719001000_bsa_roles_and_four_eyes.sql) still
    // allows only the four BSA roles, so no token can carry `cco`.
    assertEq(ccoMint, "", "minting a cco token");
  });

  await t.step("a partner gets 404; operations without the CCO role gets 403; nothing stored", async () => {
    const p = await target(partner, { approved_by: "board_flow" });
    assertEq(p.status, 404, `partner (${body(p)})`);
    const o = await target(opsNoRole, { approved_by: "board_flow" });
    assertEq(o.status, 403, `ops without cco (${body(o)})`);
    assertEq(await targetRow(), null, "no target row");
  });

  await t.step("CP-01: a target below the 700bp floor is a plan to be undercapitalized — 409, not stored", async () => {
    const r = await target(cco, { target_bp: 650, approved_by: "board_flow" });
    assertEq(r.status, 409, `650bp (${body(r)})`);
    assertEq(r.body.type, "target_below_regulatory_floor", "typed refusal");
    assertEq(await targetRow(), null, "no target row");
  });

  await t.step("CP-03: the proposer cannot approve their own target — 409 four_eyes_required", async () => {
    const r = await target(cco, { approved_by: "cco_flow" });
    assertEq(r.status, 409, `self-approval (${body(r)})`);
    assertEq(r.body.type, "four_eyes_required", "typed refusal");
    assertEq(await targetRow(), null, "no target row");
  });

  await t.step("proposed but not yet approved: stored unapproved, no approval event", async () => {
    const r = await target(cco, {});
    assertEq(r.status, 201, `proposal (${body(r)})`);
    const row = await targetRow();
    assertEq(row.approved_by, null, "unapproved");
    assertEq(row.approved_at, null, "no approval time");
    assert(!(await capitalEvents(tid)).has("capital.targets.approved"), "no approval event yet");
  });

  await t.step("the Board approves; measured against the latest position the target is breached and escalated", async () => {
    const latest = await core().from("capital_position").select("id, net_worth_ratio_bp")
      .order("as_of_date", { ascending: false }).limit(1).maybeSingle();
    const self = await target(cco, { approved_by: "board_flow" });
    assertEq(self.status, 409, `the proposing token approving under another name (${body(self)})`);
    assertEq(self.body.type, "four_eyes_required", "typed refusal");
    const r = await target(board, { approved_by: "board_flow" });
    assertEq(r.status, 201, `approval by a second token (${body(r)})`);
    const row = await targetRow();
    assertEq(row.target_bp, 900, "target");
    assertEq(row.proposed_by, "cco_flow", "proposer");
    assertEq(row.approved_by, "board_flow", "approver");
    assert(row.approved_at, "approval time");
    assert(row.proposed_by_token && row.approved_by_token && row.proposed_by_token !== row.approved_by_token,
      `two different credentials recorded (${row.proposed_by_token} / ${row.approved_by_token})`);
    const ev = await capitalEvents(tid);
    assertEq(ev.get("capital.targets.approved")?.[0]?.payload?.approved_by, "board_flow", "targets.approved");
    const ratio = latest.data?.net_worth_ratio_bp;
    if (typeof ratio === "number" && ratio < 900) {
      assertEq(ev.get("capital.target.breached")?.[0]?.payload?.net_worth_ratio_bp, ratio, "breach names the latest ratio");
      assert((ev.get("capital.board_escalation") ?? []).some((e) => e.payload?.reason === "internal_target"), "escalated");
    } else {
      assert(!ev.has("capital.target.breached"), "latest position meets the target: no breach");
    }
  });
});

// ---------------------------------------------------- CP-05/06, BA-07 docs

flow("capital: the CFO's quarterly cycle — capital plan, stress report, ICAAP report: prepared → presented → reviewed", async (t) => {
  const partner = await actor("partner");
  let cfoMint = "";
  const cfo = await actor("pynthia_ops", ["cfo" as Any]).catch((e) => {
    cfoMint = String(e);
    return actor("pynthia_ops");
  });
  const notCfo = await actor("pynthia_ops");
  const cycle = `flow${Date.now().toString(36)}`;
  const doc = (key: string, o: Record<string, unknown>) =>
    api("POST", "/capital/documents", { cycle, prepared_by: "cfo_flow", ...o }, { key });
  const docRow = async (id: string) => (await core().from("capital_document").select("*").eq("id", id).maybeSingle()).data as Any;
  const planId = `capdoc_capital_plan_${cycle}`;

  await t.step("a partner gets 404; an unknown kind is refused 400", async () => {
    const p = await doc(partner, { kind: "capital_plan" });
    assertEq(p.status, 404, `partner (${body(p)})`);
    const bad = await doc(cfo, { kind: "budget" });
    assertEq(bad.status, 400, `bad kind (${body(bad)})`);
    assertEq(await docRow(planId), null, "nothing stored");
  });

  await t.step("CP-05: a CFO token can be issued at all", () => {
    // DEFECT: same constraint as the cco role — ck_api_token_roles omits `cfo`.
    assertEq(cfoMint, "", "minting a cfo token");
  });

  await t.step("CP-05: only the CFO prepares the capital plan — a token without the cfo role is refused", async () => {
    // DEFECT: auth.ts says "CP-05 restricts the capital plan to the CFO" and
    // added the `cfo` role for it, but postCapitalDocument checks no role.
    const r = await doc(notCfo, { kind: "capital_plan" });
    assertEq(r.status, 403, `non-CFO plan (${body(r)})`);
    assertEq(await docRow(planId), null, "no plan stored");
  });

  await t.step("a review before presentation is refused — 409, nothing stored", async () => {
    const r = await doc(cfo, { kind: "capital_plan", reviewed_by: "board_flow" });
    assertEq(r.status, 409, `review first (${body(r)})`);
    assertEq(r.body.type, "review_before_presentation", "typed refusal");
    const row = await docRow(planId);
    assert(row === null || row.reviewed_at === null, "no review recorded");
  });

  await t.step("the CFO prepares the plan: stored prepared-only, plan id and update events", async () => {
    const r = await doc(cfo, { kind: "capital_plan" });
    assertEq(r.status, 201, `prepare (${body(r)})`);
    const row = await docRow(planId);
    assert(row.prepared_at, "prepared");
    assertEq(row.presented_at, null, "not presented");
    assertEq(row.reviewed_at, null, "not reviewed");
    const ev = await capitalEvents(planId);
    assertEq(ev.get("capital.plan_id")?.[0]?.payload?.capital_plan_id, planId, "plan id event");
    assert(ev.has("capital.plan.updated"), "plan.updated");
    assert(!ev.has("capital.plan.presented"), "not presented yet");
  });

  await t.step("presented to the ALM committee and reviewed by the Board — the same cycle converges", async () => {
    const r = await doc(cfo, { kind: "capital_plan", presented_to: "alm_committee", reviewed_by: "board_flow" });
    assertEq(r.status, 201, `present+review (${body(r)})`);
    const row = await docRow(planId);
    assertEq(row.presented_to, "alm_committee", "presented to");
    assertEq(row.reviewed_by, "board_flow", "reviewed by");
    assert(new Date(row.reviewed_at) >= new Date(row.presented_at), "review not before presentation");
    const ev = await capitalEvents(planId);
    assertEq(ev.get("capital.plan.presented")?.[0]?.payload?.presented_to, "alm_committee", "plan.presented");
    assertEq(ev.get("capital.plan.reviewed")?.[0]?.payload?.reviewed_by, "board_flow", "plan.reviewed");
  });

  await t.step("CP-06: the stress report is issued and the stress test recorded complete", async () => {
    const id = `capdoc_stress_report_${cycle}`;
    const r = await doc(cfo, { kind: "stress_report", presented_to: "alm_committee" });
    assertEq(r.status, 201, `stress (${body(r)})`);
    const ev = await capitalEvents(id);
    for (const c of ["capital.stress_report_id", "capital.stress_report.issued", "stress_test.completed", "capital.stress_report.presented"]) {
      assert(ev.has(c), `${c}`);
    }
  });

  await t.step("BA-07: the ICAAP cycle opens and its report is issued, linked to the prior plan", async () => {
    const id = `capdoc_icaap_report_${cycle}`;
    const r = await doc(cfo, { kind: "icaap_report", prior_document_id: planId });
    assertEq(r.status, 201, `icaap (${body(r)})`);
    assertEq((await docRow(id)).prior_document_id, planId, "prior version retained by link");
    const ev = await capitalEvents(id);
    assert(ev.has("capital.icaap_cycle.opened") && ev.has("capital.icaap_report.issued"), "ICAAP events");
  });
});
