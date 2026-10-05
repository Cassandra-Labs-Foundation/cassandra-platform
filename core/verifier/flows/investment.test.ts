// Investment flows (IP-02..IP-17): the investment officer runs the securities
// book, a second approver confirms, a third actor settles, and the ALCO/board
// reporting chain reads what is left. Replaces the stubbed unit file
// core/supabase/functions/api/investment.test.ts (see ledger/investment.md).
//
// Every flow builds its own run-unique book: an instrument class, a pair of
// broker-dealers, an issuer limit, securities and registered users. Nothing
// institution-wide is changed except the contingency-funding level, which the
// CFP step reads first and restores in a `finally`.
//
// The security master has NO API (no route creates a core.security row — the
// drill seeds them directly), so the securities a flow trades are seeded with
// the service-role client, labelled `demo`. Everything after that is HTTP.
import { actor, type Any, api, assert, assertEq, core, flow, uid } from "./helpers.ts";

const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);

/** the api_token id helpers.actor() derives from the plaintext it returns */
function tokenIdOf(plaintext: string, actorType: string): string {
  return `tok_test_${actorType}_${plaintext.slice("cass_test_".length, "cass_test_".length + 12)}`;
}

async function rowById(table: string, id: string) {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data as Any;
}

async function rowsWhere(table: string, col: string, val: string) {
  const r = await core().from(table).select("*").eq(col, val);
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return (r.data ?? []) as Any[];
}

/** every event code written against `<type>:<id>` */
async function codesOn(resourceType: string, id: string): Promise<string[]> {
  const rows = await rowsWhere("event", "resource_id", `${resourceType}:${id}`);
  return rows.map((e) => String(e.code));
}

async function eventsOn(resourceType: string, id: string): Promise<Any[]> {
  return await rowsWhere("event", "resource_id", `${resourceType}:${id}`);
}

/** the newest trade booked against a (run-unique) security */
async function lastTrade(securityId: string): Promise<Any> {
  const r = await core().from("trade").select("*").eq("security_id", securityId)
    .order("created_at", { ascending: false }).limit(1);
  assert(!r.error, `trade read: ${r.error?.message}`);
  return (r.data ?? [])[0];
}

async function tradeCount(securityId: string): Promise<number> {
  const r = await core().from("trade").select("id", { count: "exact", head: true }).eq("security_id", securityId);
  assert(!r.error, `trade count: ${r.error?.message}`);
  return r.count ?? 0;
}

async function positionPar(securityId: string): Promise<number> {
  const p = await rowById("position", `pos_${securityId}`);
  return p ? Number(p.par_cents) : 0;
}

/** the net worth the gate measures concentration against (latest capital_position) */
async function netWorth(): Promise<number> {
  const r = await core().from("capital_position").select("net_worth_cents")
    .order("as_of_date", { ascending: false }).limit(1);
  assert(!r.error && (r.data ?? []).length > 0, `capital_position read: ${r.error?.message}`);
  const nw = Number(r.data![0].net_worth_cents);
  assert(nw > 0, "institution has a positive net worth to measure limits against");
  return nw;
}

/** par that takes an issuer holding `held` to `targetBp` of current net worth */
async function parToReach(targetBp: number, held: number): Promise<number> {
  const nw = await netWorth();
  return Math.ceil((targetBp * nw) / 10000) - held;
}

const intermIdOf = (name: string) => `interm_${name.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

interface Book {
  run: string;
  cls: string; // permissible, max maturity 120 months
  clsProhibited: string;
  clsUnlisted: string;
  issuer: string; // has a 50% limit, 40% warning
  issuerNoLimit: string;
  broker: string; // approved (FINRA, active)
  badBroker: string; // unregulated: not approved
  secA: string; // issuer, cls
  secProhibited: string; // issuer, clsProhibited
  secUnlisted: string; // issuer, clsUnlisted
  secNoLimit: string; // issuerNoLimit, cls
  trader: string; // user ids = the api_token ids of the actors that act
  confirmer: string;
  settler: string;
}

/** The book the officer builds before any trade: list, brokers, limit, securities, roles. */
async function buildBook(
  officer: string, approver: string, settler: string,
  step?: (name: string, fn: () => Promise<void>) => Promise<void>,
): Promise<Book> {
  const run = uid().replace(/[^a-z0-9]/g, "");
  const b: Book = {
    run,
    cls: `ust_${run}`, clsProhibited: `cmo_${run}`, clsUnlisted: `crypto_${run}`,
    issuer: `iss_${run}`, issuerNoLimit: `iss_nolimit_${run}`,
    broker: intermIdOf(`Northgate ${run}`), badBroker: intermIdOf(`Backstreet ${run}`),
    secA: `sec_${run}_a`, secProhibited: `sec_${run}_cmo`, secUnlisted: `sec_${run}_x`,
    secNoLimit: `sec_${run}_nl`,
    trader: tokenIdOf(officer, "pynthia_ops"), confirmer: tokenIdOf(approver, "cu_admin"),
    settler: tokenIdOf(settler, "pynthia_ops"),
  };
  const run_ = step ?? (async (_n: string, fn: () => Promise<void>) => await fn());

  await run_("register the three trade roles: trader (execution), approver (confirmation), settler (settlement)", async () => {
    for (const [id, role, key] of [[b.trader, "execution", officer], [b.confirmer, "confirmation", officer], [b.settler, "settlement", officer]]) {
      const r = await api("PUT", `/investment/users/${id}`, { role }, { key });
      assertEq(r.status, 200, `register ${role} (${body(r)})`);
      assertEq(r.body.data.role, role, "role echoed");
      const u = await rowById("user", id);
      assertEq(u?.role, role, `core.user records ${id} as ${role}`);
      assertEq(u?.provenance, "demo", "test actor's write is labelled demo");
    }
  });

  await run_("the permitted-instrument list: one class permitted to 120 months, one explicitly prohibited", async () => {
    const p = await api("POST", "/investment/instrument-list", {
      instrument_class: b.cls, permissible: true, citation: "12 CFR 703.14(a)", max_maturity_months: 120,
    }, { key: officer });
    assertEq(p.status, 201, `list permitted class (${body(p)})`);
    assertEq(p.body.data.id, `instr_${b.cls}_v1`, "first version of the class");
    const x = await api("POST", "/investment/instrument-list", {
      instrument_class: b.clsProhibited, permissible: false, citation: "12 CFR 703.16",
    }, { key: officer });
    assertEq(x.status, 201, `list prohibited class (${body(x)})`);
    const row = await rowById("instrument_list", `instr_${b.cls}_v1`);
    assertEq(row?.permissible, true, "row permissible");
    assertEq(row?.max_maturity_months, 120, "maturity cap stored");
    const codes = await codesOn("instrument_list", `instr_${b.cls}_v1`);
    assert(codes.includes("instrument_list.review.completed"), `review event (got ${codes})`);
    assert(codes.includes("regulatory.change_analysis.logged"), "a list change IS the regulatory-change analysis");
  });

  await run_("broker-dealer approval is derived: FINRA+active is approved, an unregulated broker is not", async () => {
    const g = await api("POST", "/investment/intermediaries", {
      name: `Northgate ${run}`, kind: "both", regulator: "finra", registration_status: "active",
      approved: false, // a supplied flag is ignored — approval is derived
    }, { key: officer });
    assertEq(g.status, 201, `approve broker (${body(g)})`);
    assertEq(g.body.data.id, b.broker, "id derived from the name");
    assertEq(g.body.data.approved, true, "regulated + active → approved");
    const bad = await api("POST", "/investment/intermediaries", {
      name: `Backstreet ${run}`, kind: "broker_dealer", regulator: "none", registration_status: "active",
      approved: true, // asserting approval does not make it so
    }, { key: officer });
    assertEq(bad.status, 201, `review unregulated broker (${body(bad)})`);
    assertEq(bad.body.data.approved, false, "unregulated → not approved, whatever the caller claims");
    const row = await rowById("intermediary", b.badBroker);
    assertEq(row?.approved, false, "row not approved");
    assertEq(row?.disqualified_reason, "regulator_not_recognised", "the reason is recorded");
    assert(row?.review_due_at, "an annual re-review is scheduled");
    const ev = await rowById("event", `ev_${b.badBroker}_rev`);
    assertEq(ev?.code, "intermediary.review.completed", "review event");
    assertEq(ev?.payload?.approved, false, "event carries the verdict");
  });

  await run_("the board's issuer limit: 50% of net worth, warning at 40%", async () => {
    const r = await api("PUT", "/investment/limits", {
      scope_kind: "issuer", scope_ref: b.issuer, limit_bp_of_capital: 5000, warning_bp_of_capital: 4000,
      approved_by: "board-resolution-flow",
    }, { key: officer });
    assertEq(r.status, 200, `set limit (${body(r)})`);
    const row = await rowById("limit_set", r.body.data.id);
    assertEq(row?.limit_bp_of_capital, 5000, "limit stored");
    assertEq(row?.warning_bp_of_capital, 4000, "warning stored");
    assertEq(row?.approved_by, "board-resolution-flow", "approver recorded");
    assertEq((await rowById("event", `ev_${r.body.data.id}_rev`))?.code, "limit_set.review.completed", "limit review event");
  });

  // No route creates a security; the custodian feed is simulated here.
  const ins = await core().from("security").insert([
    { id: b.secA, issuer_ref: b.issuer, instrument_class: b.cls, external_rating: "AA", provenance: "demo" },
    { id: b.secProhibited, issuer_ref: b.issuer, instrument_class: b.clsProhibited, external_rating: "A", provenance: "demo" },
    { id: b.secUnlisted, issuer_ref: b.issuer, instrument_class: b.clsUnlisted, provenance: "demo" },
    { id: b.secNoLimit, issuer_ref: b.issuerNoLimit, instrument_class: b.cls, external_rating: "AAA", provenance: "demo" },
  ]);
  assert(!ins.error, `seed security master: ${ins.error?.message}`);
  return b;
}

/** a clean buy ticket against the book; override any field */
function ticket(b: Book, o: Record<string, unknown> = {}) {
  return {
    security_id: b.secA, instrument_class: b.cls, issuer_ref: b.issuer, intermediary_id: b.broker,
    side: "buy", par_cents: 1_000_000, price_bp: 9950, executed_by: b.trader, maturity_months: 60,
    checklist_completed: true, ...o,
  };
}

/** a refused trade: 409 trade_blocked, the blocked row carries `reason`, nothing booked */
async function assertBlocked(
  r: { status: number; body: Any }, securityId: string, reason: string, parBefore: number,
): Promise<Any> {
  assertEq(r.status, 409, `refused (${body(r)})`);
  assertEq(r.body.type, "trade_blocked", "typed refusal");
  assert(String(r.body.detail).includes(reason), `refusal names ${reason} (got ${r.body.detail})`);
  const t = await lastTrade(securityId);
  assert(t, "the refused trade is recorded, not silently dropped");
  assertEq(t.decision, "blocked", "row decision");
  assert((t.blocked_reasons as string[]).includes(reason), `row reasons include ${reason} (got ${t.blocked_reasons})`);
  const codes = await codesOn("trade", t.id);
  assert(codes.includes("trade.limit.blocked"), `trade.limit.blocked emitted (got ${codes})`);
  assert(!codes.includes("position.booked") && !codes.includes("document.required_set"), "nothing booked, no document set");
  assertEq((await rowsWhere("document", "subject_ref", t.id)).length, 0, "no required-document rows for a blocked trade");
  assertEq(await positionPar(securityId), parBefore, "position unchanged");
  return t;
}

// =========================================================================
// 1. The whole trade lifecycle
// =========================================================================

flow("investment: officer builds the book → trades within, at warning, past the limit → three-role confirm/settle → waiver → safekeeping → board report", async (t) => {
  const officer = await actor("pynthia_ops");
  const approver = await actor("cu_admin");
  const settlerKey = await actor("pynthia_ops");
  const partner = await actor("partner");
  const period = `flow_${uid()}`;
  let b!: Book;
  let start: Any;
  let t1 = "", t2 = "", t3 = "";
  let held = 0;
  let par1 = 0, par2 = 0;

  await t.step("management report before trading (baseline; the book is instance-wide)", async () => {
    const r = await api("POST", "/investment/reports", { period: `${period}_start`, audience: "management" }, { key: officer });
    assertEq(r.status, 201, `report (${body(r)})`);
    start = r.body.data;
    const ev = await rowById("event", `ev_portrep_management_${period}_start`);
    assertEq(ev?.code, "portfolio.management_report.issued", "management report event");
  });

  b = await buildBook(officer, approver, settlerKey, async (n, fn) => {
    await t.step(n, fn);
  });

  await t.step("a partner cannot reach the investment desk (404, nothing written)", async () => {
    const r = await api("POST", "/investment/trades", ticket(b), { key: partner });
    assertEq(r.status, 404, `partner trade (${body(r)})`);
    assertEq(await tradeCount(b.secA), 0, "no trade row");
    const l = await api("PUT", "/investment/limits", {
      scope_kind: "issuer", scope_ref: `${b.issuer}_partner`, limit_bp_of_capital: 9000, approved_by: "x",
    }, { key: partner });
    assertEq(l.status, 404, `partner limit (${body(l)})`);
    assertEq((await rowsWhere("limit_set", "scope_ref", `${b.issuer}_partner`)).length, 0, "no limit row");
  });

  await t.step("trade 1 within the limit executes: position booked, document set declared with its clock", async () => {
    par1 = await parToReach(2000, held);
    const r = await api("POST", "/investment/trades", ticket(b, { par_cents: par1 }), { key: officer });
    assertEq(r.status, 201, `trade (${body(r)})`);
    assertEq(r.body.data.decision, "executed", "executed");
    t1 = r.body.data.id;
    const row = await rowById("trade", t1);
    assertEq(row.permissibility_verdict, "permissible", "permissibility");
    assertEq(row.limit_verdict, "within", "limit verdict");
    assertEq(row.executed_by, b.trader, "executing trader recorded");
    assert(row.checklist_completed_at, "pre-purchase checklist time recorded");
    assertEq(row.provenance, "demo", "demo provenance");
    held += par1;
    assertEq(await positionPar(b.secA), held, "position booked at par");
    const docs = await rowsWhere("document", "subject_ref", t1);
    assertEq(docs.map((d) => d.doc_type).sort().join(","),
      "confirmation,pre_purchase_analysis,safekeeping_receipt,trade_ticket", "IP-15 required set");
    assert(docs.every((d) => d.attachment_due_at), "each document has an attachment deadline");
    const codes = await codesOn("trade", t1);
    for (const c of ["trade.permissibility.checked", "trade.checklist.completed", "trade.step.recorded",
      "trade.approval.requested", "document.required_set"]) {
      assert(codes.includes(c), `${c} emitted (got ${codes})`);
    }
    assertEq((await rowById("event", `ev_pos_${b.secA}_booked`))?.code, "position.booked", "position.booked event");
  });

  await t.step("trade 2 crosses the WARNING on the projected position — it still executes, and warns", async () => {
    par2 = await parToReach(4500, held);
    const r = await api("POST", "/investment/trades", ticket(b, { par_cents: par2 }), { key: officer });
    assertEq(r.status, 201, `trade (${body(r)})`);
    t2 = r.body.data.id;
    assertEq((await rowById("trade", t2)).limit_verdict, "warning", "limit verdict warning");
    const codes = await codesOn("trade", t2);
    assert(codes.includes("trade.limit_warning.issued"), `warning issued (got ${codes})`);
    assert(!codes.includes("trade.limit.blocked"), "a warning does not block");
    held += par2;
    assertEq(await positionPar(b.secA), held, "position grew");
  });

  await t.step("trade 3 would breach on the PROJECTED position — refused, nothing booked, a waiver case opened", async () => {
    const par3 = await parToReach(5500, held);
    const r = await api("POST", "/investment/trades", ticket(b, { par_cents: par3 }), { key: officer });
    const row = await assertBlocked(r, b.secA, "issuer_limit_breached", held);
    t3 = row.id;
    assertEq(row.limit_verdict, "breached", "limit verdict");
    const codes = await codesOn("trade", t3);
    assert(codes.includes("concentration.limit_exceeded"), `concentration.limit_exceeded (got ${codes})`);
    assert(codes.includes("concentration.waiver.opened"), "waiver opened for the board");
  });

  await t.step("the breach waiver: the trader cannot approve their own exception; the approver can", async () => {
    const self = await api("POST", "/investment/trade-exceptions", {
      trade_id: t3, kind: "concentration_waiver", detail: { trade: t3 }, raised_by: b.trader, approved_by: b.trader,
    }, { key: officer });
    assertEq(self.status, 409, `self-approval (${body(self)})`);
    assertEq(self.body.type, "trade_exception_self_approved", "typed refusal");
    assertEq((await rowsWhere("trade_exception", "trade_id", t3)).length, 0, "no exception row written");
    const ok = await api("POST", "/investment/trade-exceptions", {
      trade_id: t3, kind: "concentration_waiver", detail: { trade: t3 }, raised_by: b.trader, approved_by: b.confirmer,
    }, { key: approver });
    assertEq(ok.status, 201, `exception (${body(ok)})`);
    const ex = await rowById("trade_exception", ok.body.data.id);
    assertEq(ex.trade_id, t3, "exception names the blocked trade");
    assertEq(ex.approved_by, b.confirmer, "approver recorded");
    assert(ex.approved_at, "approval time recorded");
    const codes = await codesOn("trade_exception", ok.body.data.id);
    assert(codes.includes("trade.exception.logged") && codes.includes("trade.exception.approved"), `exception events (got ${codes})`);
  });

  await t.step("SoD: the trader cannot confirm their own trade (409, sod_violation + events, trade unconfirmed)", async () => {
    const r = await api("POST", `/investment/trades/${t1}/confirm`, {
      confirmed_by: b.trader, confirmation_ref: "cf-self", counterparty_par_cents: par1,
    }, { key: officer });
    assertEq(r.status, 409, `self-confirm (${body(r)})`);
    assertEq(r.body.type, "trade_sod_violation", "typed refusal");
    const v = await rowById("sod_violation", `sodv_${t1}_confirm`);
    assertEq(v?.actor_ref, b.trader, "violation names the actor");
    assertEq(`${v?.role_a}/${v?.role_b}`, "execution/confirmation", "the incompatible pair");
    const ev = await rowById("event", `ev_sodv_${t1}_confirm`);
    assertEq(ev?.code, "sod.violation.logged", "violation event");
    assertEq(ev?.payload?.["user.role"], "execution", "the actor's registered role is on the evidence");
    assertEq(ev?.payload?.["sod.matrix_version"], "sod-v1", "the matrix version in force");
    assert((await codesOn("trade", t1)).includes("trade.sod.blocked"), "trade.sod.blocked emitted");
    assertEq((await rowById("trade", t1)).confirmed_by, null, "trade left unconfirmed");
  });

  await t.step("the second approver confirms trade 1 against the counterparty's figures: matched", async () => {
    const r = await api("POST", `/investment/trades/${t1}/confirm`, {
      confirmed_by: b.confirmer, confirmation_ref: `cf-${b.run}-1`, counterparty_par_cents: par1,
    }, { key: approver });
    assertEq(r.status, 200, `confirm (${body(r)})`);
    assertEq(r.body.data.matched, true, "matched");
    const row = await rowById("trade", t1);
    assertEq(row.confirmed_by, b.confirmer, "confirmer recorded");
    assertEq(String(row.confirmation_matched), "true", "match recorded (type checked in its own step)");
    assertEq(row.confirmation_ref, `cf-${b.run}-1`, "confirmation reference kept");
    const codes = await codesOn("trade", t1);
    assert(codes.includes("trade.confirmation.received") && codes.includes("trade.confirmation_matched"), `confirm events (got ${codes})`);
    assert(!codes.includes("trade.confirmation_discrepancy.flagged"), "no discrepancy");
  });

  await t.step("a confirmation that disagrees with the counterparty is flagged, not matched", async () => {
    const r = await api("POST", `/investment/trades/${t2}/confirm`, {
      confirmed_by: b.confirmer, confirmation_ref: `cf-${b.run}-2`, counterparty_par_cents: par2 - 100_000,
    }, { key: approver });
    assertEq(r.status, 200, `confirm (${body(r)})`);
    assertEq(r.body.data.matched, false, "not matched");
    assertEq(String((await rowById("trade", t2)).confirmation_matched), "false", "row records the mismatch");
    const disc = await rowById("event", `ev_${t2}_disc`);
    assertEq(disc?.code, "trade.confirmation_discrepancy.flagged", "discrepancy flagged");
    assertEq(Number(disc?.payload?.ours) - Number(disc?.payload?.theirs), 100_000, "both figures on the evidence");
    assert(!(await codesOn("trade", t2)).includes("trade.confirmation_matched"), "no match event");
  });

  await t.step("SoD: the trader cannot settle their own trade either; a third actor reconciles it", async () => {
    const self = await api("POST", `/investment/trades/${t1}/reconcile`, { settled_by: b.trader }, { key: officer });
    assertEq(self.status, 409, `self-settle (${body(self)})`);
    assertEq(self.body.type, "trade_sod_violation", "typed refusal");
    assertEq((await rowById("sod_violation", `sodv_${t1}_settle`))?.role_b, "settlement", "violation recorded");
    assertEq((await rowById("trade", t1)).reconciled_at, null, "not reconciled");
    const missing = await api("POST", `/investment/trades/${t1}/reconcile`, {}, { key: settlerKey });
    assertEq(missing.status, 400, `no settled_by (${body(missing)})`);
    const unknown = await api("POST", `/investment/trades/trade_nope_${b.run}/reconcile`, { settled_by: b.settler }, { key: settlerKey });
    assertEq(unknown.status, 404, `unknown trade (${body(unknown)})`);

    const r = await api("POST", `/investment/trades/${t1}/reconcile`, { settled_by: b.settler }, { key: settlerKey });
    assertEq(r.status, 200, `reconcile (${body(r)})`);
    const row = await rowById("trade", t1);
    assertEq(row.settled_by, b.settler, "settler recorded");
    assert(row.reconciled_at, "reconciled");
    const ev = await rowById("event", `ev_${t1}_recon`);
    assertEq(ev?.code, "trade.reconciliation.completed", "reconciliation event");
    assertEq(String(ev?.payload?.confirmation_matched), "true", "reconciliation carries the confirmation match");
    assert(new Set([row.executed_by, row.confirmed_by, row.settled_by]).size === 3, "three distinct actors on one trade");
  });

  await t.step("the confirmation match is a boolean on the trade and on the reconciliation evidence", async () => {
    // DEFECT: core.trade.confirmation_matched is TEXT (codegen-era column; 20260719002700 declared boolean but `add column if not exists` was a no-op), so the row and the trade.reconciliation.completed payload carry "true"/"false" strings.
    assertEq((await rowById("trade", t1)).confirmation_matched, true, "matched is boolean true");
    assertEq((await rowById("trade", t2)).confirmation_matched, false, "mismatch is boolean false");
    assertEq((await rowById("event", `ev_${t1}_recon`))?.payload?.confirmation_matched, true, "evidence payload is boolean");
  });

  await t.step("safekeeping: the custodian's statement is compared to OUR book — a short holding is one break", async () => {
    const all = await core().from("position").select("security_id, par_cents");
    assert(!all.error, `position read: ${all.error?.message}`);
    const mirror: Record<string, number> = {};
    for (const p of all.data ?? []) mirror[String(p.security_id)] = Number(p.par_cents);
    assertEq(mirror[b.secA], held, "our book holds the traded par");

    const clean = await api("POST", "/investment/safekeeping/reconcile", { intermediary_id: b.broker, holdings: mirror }, { key: settlerKey });
    assertEq(clean.status, 200, `reconcile (${body(clean)})`);
    const short = await api("POST", "/investment/safekeeping/reconcile", {
      intermediary_id: b.broker, holdings: { ...mirror, [b.secA]: held - 1_000_000 },
    }, { key: settlerKey });
    assertEq(short.status, 200, `reconcile (${body(short)})`);
    assertEq(short.body.data.breaks - clean.body.data.breaks, 1, "the short custodian figure is exactly one more break");
    const evs = (await eventsOn("intermediary", b.broker)).filter((e) => e.code === "safekeeping.reconciliation.completed");
    assertEq(evs.length, 2, "each reconciliation leaves evidence against the custodian");
    assert(evs.some((e) => e.payload.breaks === short.body.data.breaks && e.payload.positions_compared > 0),
      "the evidence records the break count the response reported");
  });

  await t.step("safekeeping is scoped to the custodian: a statement matching what we hold THERE reconciles clean", async () => {
    // DEFECT: postSafekeepingReconciliation compares the custodian's statement against EVERY position in the book (no custodian filter), so any other custodian's holdings show up as breaks.
    const r = await api("POST", "/investment/safekeeping/reconcile", {
      intermediary_id: b.broker, holdings: { [b.secA]: held },
    }, { key: settlerKey });
    assertEq(r.status, 200, `reconcile (${body(r)})`);
    assertEq(r.body.data.breaks, 0, "no breaks for holdings this custodian actually keeps");
  });

  await t.step("board report reflects the run: our position, the blocked trade and the waiver are counted", async () => {
    const r = await api("POST", "/investment/reports", { period: `${period}_end`, audience: "board" }, { key: approver });
    assertEq(r.status, 201, `board report (${body(r)})`);
    const end = r.body.data;
    assert(end.positions - start.positions >= 1, `our new position is counted (${start.positions} → ${end.positions})`);
    assert(end.par_cents - start.par_cents >= held, `our par is in the total (Δ ${end.par_cents - start.par_cents} ≥ ${held})`);
    // DEFECT: postPortfolioReport reads core.trade unpaginated; PostgREST caps the select at 1000 rows, so with >1000 trades trades_blocked is a count over an arbitrary subset.
    assert(end.trades_blocked - start.trades_blocked >= 1, `our blocked trade is counted (${start.trades_blocked} → ${end.trades_blocked})`);
    assert(end.exceptions - start.exceptions >= 1, `our waiver is counted (${start.exceptions} → ${end.exceptions})`);
    const ev = await rowById("event", `ev_portrep_board_${period}_end`);
    assertEq(ev?.code, "portfolio.board_report.issued", "board report event");
    assertEq(ev?.payload?.par_cents, end.par_cents, "the event carries what the board saw");
  });
});

// =========================================================================
// 2. The trade gate's refusals
// =========================================================================

flow("investment: the trade gate refuses unlisted, prohibited and over-maturity instruments, unapproved/absent brokers, a skipped checklist and an issuer with no limit — with evidence", async (t) => {
  const officer = await actor("pynthia_ops");
  const approver = await actor("cu_admin");
  const settler = await actor("pynthia_ops");
  let b!: Book;

  await t.step("set up the book", async () => {
    b = await buildBook(officer, approver, settler);
  });

  await t.step("malformed tickets are refused with the fields named; no row written", async () => {
    const r = await api("POST", "/investment/trades", { side: "hold", par_cents: 0 }, { key: officer });
    assertEq(r.status, 400, `malformed (${body(r)})`);
    const fields = (r.body.errors ?? []).map((e: Any) => e.field);
    for (const f of ["security_id", "instrument_class", "issuer_ref", "executed_by", "par_cents", "side"]) {
      assert(fields.includes(f), `${f} named (got ${fields})`);
    }
  });

  await t.step("an instrument class NOT on the list is refused — absence means no (unassessed)", async () => {
    const r = await api("POST", "/investment/trades",
      ticket(b, { security_id: b.secUnlisted, instrument_class: b.clsUnlisted }), { key: officer });
    const row = await assertBlocked(r, b.secUnlisted, "instrument_class_not_on_list", 0);
    assertEq(row.permissibility_verdict, "unassessed", "unknown is not permissible");
    assert((await codesOn("trade", row.id)).includes("trade.blocked_prohibited"), "trade.blocked_prohibited emitted");
  });

  await t.step("an explicitly prohibited class is refused (prohibited)", async () => {
    const r = await api("POST", "/investment/trades",
      ticket(b, { security_id: b.secProhibited, instrument_class: b.clsProhibited }), { key: officer });
    const row = await assertBlocked(r, b.secProhibited, "instrument_prohibited", 0);
    assertEq(row.permissibility_verdict, "prohibited", "verdict");
    const ev = await rowById("event", `ev_${row.id}_prohib`);
    assertEq(ev?.payload?.verdict, "prohibited", "the prohibition event carries the verdict");
  });

  await t.step("a maturity beyond the list's cap is prohibited", async () => {
    const r = await api("POST", "/investment/trades", ticket(b, { maturity_months: 240 }), { key: officer });
    const row = await assertBlocked(r, b.secA, "maturity_exceeds_list_limit", 0);
    assertEq(row.permissibility_verdict, "prohibited", "verdict");
  });

  await t.step("an unregulated broker blocks the trade (trade.intermediary.blocked)", async () => {
    const r = await api("POST", "/investment/trades", ticket(b, { intermediary_id: b.badBroker }), { key: officer });
    const row = await assertBlocked(r, b.secA, "intermediary_not_approved", 0);
    assertEq(row.intermediary_id, b.badBroker, "the broker is on the refused trade");
    assert((await codesOn("trade", row.id)).includes("trade.intermediary.blocked"), "trade.intermediary.blocked emitted");
  });

  await t.step("a trade with NO broker is refused", async () => {
    const r = await api("POST", "/investment/trades", ticket(b, { intermediary_id: undefined }), { key: officer });
    const row = await assertBlocked(r, b.secA, "no_intermediary", 0);
    assert((await codesOn("trade", row.id)).includes("trade.intermediary.blocked"), "trade.intermediary.blocked emitted");
  });

  await t.step("a broker the institution never reviewed is refused as unapproved, with evidence", async () => {
    const r = await api("POST", "/investment/trades", ticket(b, { intermediary_id: `interm_never_${b.run}` }), { key: officer });
    await assertBlocked(r, b.secA, "intermediary_not_approved", 0);
  });

  await t.step("no pre-purchase checklist blocks the trade (trade.checklist_exception_raised)", async () => {
    const r = await api("POST", "/investment/trades", ticket(b, { checklist_completed: false }), { key: officer });
    const row = await assertBlocked(r, b.secA, "pre_purchase_checklist_incomplete", 0);
    assertEq(row.checklist_completed_at, null, "no checklist time");
    assert((await codesOn("trade", row.id)).includes("trade.checklist_exception_raised"), "checklist exception emitted");
  });

  await t.step("an issuer with NO limit is unassessed, and unassessed blocks", async () => {
    const r = await api("POST", "/investment/trades",
      ticket(b, { security_id: b.secNoLimit, issuer_ref: b.issuerNoLimit }), { key: officer });
    const row = await assertBlocked(r, b.secNoLimit, "no_issuer_limit_set", 0);
    assertEq(row.limit_verdict, "unassessed", "unknown concentration is not within-limit");
  });

  await t.step("the list is effective-dated: a FUTURE prohibition supersedes from its date, not today", async () => {
    const r = await api("POST", "/investment/instrument-list", {
      instrument_class: b.cls, permissible: false, citation: "future rule", effective_at: "2099-01-01T00:00:00.000Z",
    }, { key: officer });
    assertEq(r.status, 201, `future entry (${body(r)})`);
    assertEq(r.body.data.version, 2, "a new version");
    const v1 = await rowById("instrument_list", `instr_${b.cls}_v1`);
    assert(String(v1.superseded_at).startsWith("2099-01-01"), `v1 superseded from 2099 (got ${v1.superseded_at})`);
    const ev = await rowById("event", `ev_instr_${b.cls}_v2_reg`);
    assertEq(ev?.payload?.prior_version, 1, "the change analysis names the version it replaces");
    const tr = await api("POST", "/investment/trades", ticket(b), { key: officer });
    assertEq(tr.status, 201, `today the class is still permitted (${body(tr)})`);
  });

  await t.step("the gate classifies by the SECURITY MASTER, not the ticket: a prohibited security relabelled as permitted is refused", async () => {
    // DEFECT: evaluateTradeGate takes instrument_class (and issuer_ref) from the request body and never reads core.security, so a ticket that mislabels a prohibited security executes.
    const before = await positionPar(b.secProhibited);
    const r = await api("POST", "/investment/trades",
      ticket(b, { security_id: b.secProhibited, instrument_class: b.cls }), { key: officer });
    assertEq(r.status, 409, `relabelled prohibited security (${body(r)})`);
    assertEq(await positionPar(b.secProhibited), before, "no position booked in a prohibited security");
  });

  await t.step("limit definitions: a warning at/above the limit, or no approver, is refused", async () => {
    const eq = await api("PUT", "/investment/limits", {
      scope_kind: "issuer", scope_ref: `${b.issuer}_bad`, limit_bp_of_capital: 1000, warning_bp_of_capital: 1000, approved_by: "board",
    }, { key: officer });
    assertEq(eq.status, 400, `warning == limit (${body(eq)})`);
    assertEq(eq.body.errors?.[0]?.field, "warning_bp_of_capital", "field named");
    const noAppr = await api("PUT", "/investment/limits", {
      scope_kind: "issuer", scope_ref: `${b.issuer}_bad`, limit_bp_of_capital: 1000,
    }, { key: officer });
    assertEq(noAppr.status, 400, `no approver (${body(noAppr)})`);
    assertEq((await rowsWhere("limit_set", "scope_ref", `${b.issuer}_bad`)).length, 0, "no limit row");
  });

  await t.step("roles: an unknown role is refused; a partner cannot register traders", async () => {
    const bad = await api("PUT", `/investment/users/u_${b.run}`, { role: "superuser" }, { key: officer });
    assertEq(bad.status, 400, `bad role (${body(bad)})`);
    const p = await api("PUT", `/investment/users/u_${b.run}`, { role: "execution" }, { key: await actor("partner") });
    assertEq(p.status, 404, `partner (${body(p)})`);
    assertEq(await rowById("user", `u_${b.run}`), null, "nobody registered");
  });
});

// =========================================================================
// 3. Duties are bound to who is actually calling
// =========================================================================

flow("investment: duties bind to the authenticated actor — an unregistered trader cannot execute, a trader cannot confirm under another name", async (t) => {
  const officer = await actor("pynthia_ops");
  const approver = await actor("cu_admin");
  const settler = await actor("pynthia_ops");
  let b!: Book;
  let tid = "";

  await t.step("set up the book", async () => {
    b = await buildBook(officer, approver, settler);
  });

  await t.step("an actor not registered for execution cannot execute a trade", async () => {
    // DEFECT: postTrade never consults core.user (PUT /investment/users), so any executed_by string — registered or not — executes.
    const r = await api("POST", "/investment/trades", ticket(b, { executed_by: `nobody_${b.run}` }), { key: officer });
    assertEq(r.status, 409, `unregistered trader (${body(r)})`);
    assertEq(await positionPar(b.secA), 0, "nothing booked");
  });

  await t.step("the registered trader executes", async () => {
    const r = await api("POST", "/investment/trades", ticket(b, { par_cents: 2_000_000 }), { key: officer });
    assertEq(r.status, 201, `trade (${body(r)})`);
    tid = r.body.data.id;
  });

  await t.step("the trader's own credential cannot confirm by naming the approver", async () => {
    // DEFECT: postTradeConfirmation compares the body's confirmed_by with executed_by and ignores ctx.tokenId, so the executing trader confirms their own trade by typing someone else's id.
    const r = await api("POST", `/investment/trades/${tid}/confirm`, {
      confirmed_by: b.confirmer, confirmation_ref: "cf-impersonated", counterparty_par_cents: 2_000_000,
    }, { key: officer });
    assertEq(r.status, 409, `confirm under another name (${body(r)})`);
    assertEq((await rowById("trade", tid)).confirmed_by, null, "trade left unconfirmed");
  });
});

// =========================================================================
// 4. Credit, downgrade, fair value
// =========================================================================

flow("investment: credit file analysed → security downgraded (unreviewed, then reviewed to the board) → re-analysis → fair value and impairment", async (t) => {
  const officer = await actor("pynthia_ops");
  const approver = await actor("cu_admin");
  const settler = await actor("pynthia_ops");
  let b!: Book;
  const cfile = () => `cfile_${b.issuer}`;

  await t.step("set up the book and hold a position", async () => {
    b = await buildBook(officer, approver, settler);
    const r = await api("POST", "/investment/trades", ticket(b, { par_cents: 3_000_000 }), { key: officer });
    assertEq(r.status, 201, `trade (${body(r)})`);
  });

  await t.step("a credit file with only an external rating is refused — the CU's own analysis is required", async () => {
    const r = await api("POST", "/investment/credit-files", { issuer_ref: b.issuer, external_rating: "A" }, { key: officer });
    assertEq(r.status, 400, `no analysis (${body(r)})`);
    const fields = (r.body.errors ?? []).map((e: Any) => e.field);
    for (const f of ["internal_rating", "analysis_ref", "approved_by"]) assert(fields.includes(f), `${f} named (got ${fields})`);
    assertEq(await rowById("credit_file", cfile()), null, "no file written");
  });

  await t.step("the issuer's credit file: internal rating, analysis, approver, re-analysis due in a year", async () => {
    const r = await api("POST", "/investment/credit-files", {
      issuer_ref: b.issuer, internal_rating: "2", external_rating: "AA", analysis_ref: `memo-${b.run}`, approved_by: b.confirmer,
    }, { key: officer });
    assertEq(r.status, 201, `credit file (${body(r)})`);
    const f = await rowById("credit_file", cfile());
    assertEq(f.internal_rating, "2", "internal rating");
    assertEq(f.analysis_ref, `memo-${b.run}`, "analysis kept");
    const days = (Date.parse(f.reanalysis_due_at) - Date.parse(f.approved_at)) / 86_400_000;
    assert(Math.abs(days - 365) < 1, `re-analysis due in 365 days (got ${days})`);
    const codes = await codesOn("credit_file", cfile());
    for (const c of ["credit_file.approved", "credit_file.internal_rating", "credit_file.reanalysis_due_at"]) {
      assert(codes.includes(c), `${c} (got ${codes})`);
    }
  });

  await t.step("a downgrade nobody reviewed is recorded and stays visibly unreviewed", async () => {
    const unknown = await api("POST", `/investment/securities/sec_nope_${b.run}/downgrade`, { new_rating: "BB" }, { key: officer });
    assertEq(unknown.status, 404, `unknown security (${body(unknown)})`);
    const r = await api("POST", `/investment/securities/${b.secA}/downgrade`, { new_rating: "BB" }, { key: officer });
    assertEq(r.status, 200, `downgrade (${body(r)})`);
    assertEq(r.body.data.reviewed, false, "not reviewed");
    const s = await rowById("security", b.secA);
    assertEq(s.external_rating, "BB", "rating changed");
    assert(s.downgraded_at, "downgrade time");
    assertEq(s.downgrade_reviewed_at, null, "review absent and visible");
    const dg = await rowById("event", `ev_${b.secA}_dg`);
    assertEq(dg?.code, "security.downgraded", "downgrade event");
    assertEq(`${dg?.payload?.from}→${dg?.payload?.to}`, "AA→BB", "from/to on the evidence");
    const codes = await codesOn("security", b.secA);
    assert(!codes.includes("security.downgrade.reviewed") && !codes.includes("board.notification.sent"), `no review, no board (got ${codes})`);
  });

  await t.step("the review of a sub-investment-grade downgrade goes to the board", async () => {
    const r = await api("POST", `/investment/securities/${b.secA}/downgrade`, { new_rating: "BB", reviewed_by: b.confirmer }, { key: approver });
    assertEq(r.status, 200, `review (${body(r)})`);
    assertEq(r.body.data.reviewed, true, "reviewed");
    const s = await rowById("security", b.secA);
    assertEq(s.downgrade_reviewed_by, b.confirmer, "reviewer recorded");
    const codes = await codesOn("security", b.secA);
    assert(codes.includes("security.downgrade.reviewed"), "review event");
    const board = await rowById("event", `ev_${b.secA}_board`);
    assertEq(board?.code, "board.notification.sent", "board notified");
    assertEq(board?.payload?.reason, "credit_downgrade", "reason on the notification");
  });

  await t.step("a reviewed downgrade that stays investment grade does NOT go to the board", async () => {
    const r = await api("POST", `/investment/securities/${b.secNoLimit}/downgrade`, { new_rating: "A", reviewed_by: b.confirmer }, { key: approver });
    assertEq(r.status, 200, `review (${body(r)})`);
    const codes = await codesOn("security", b.secNoLimit);
    assert(codes.includes("security.downgrade.reviewed"), "reviewed");
    assert(!codes.includes("board.notification.sent"), `no board notification (got ${codes})`);
  });

  await t.step("the downgrade forces re-analysis: refused without the analysis, recorded with it", async () => {
    const none = await api("POST", `/investment/credit-files/${cfile()}/reanalyse`, { internal_rating: "4" }, { key: officer });
    assertEq(none.status, 400, `no analysis (${body(none)})`);
    assertEq((await rowById("credit_file", cfile())).internal_rating, "2", "rating unchanged");
    const unknown = await api("POST", `/investment/credit-files/cfile_nope_${b.run}/reanalyse`, { analysis_ref: "x" }, { key: officer });
    assertEq(unknown.status, 404, `unknown file (${body(unknown)})`);
    const r = await api("POST", `/investment/credit-files/${cfile()}/reanalyse`, {
      internal_rating: "4", analysis_ref: `memo-${b.run}-downgrade`,
    }, { key: officer });
    assertEq(r.status, 200, `reanalyse (${body(r)})`);
    const f = await rowById("credit_file", cfile());
    assertEq(f.internal_rating, "4", "new internal rating");
    assert(f.reanalysed_at, "re-analysis time");
    const ev = await rowById("event", `ev_${cfile()}_re`);
    assertEq(ev?.code, "credit_file.reanalysis.completed", "re-analysis event");
    assertEq(`${ev?.payload?.prior_rating}→${ev?.payload?.internal_rating}`, "2→4", "prior and new rating");
    assertEq(ev?.payload?.completed_late, false, "done inside the window");
  });

  await t.step("fair value: a value with no source is refused", async () => {
    const r = await api("POST", `/investment/securities/${b.secA}/fair-value`, { fair_value_cents: 1 }, { key: officer });
    assertEq(r.status, 400, `no source (${body(r)})`);
    assertEq((await rowById("security", b.secA)).fair_value_cents, null, "nothing recorded");
  });

  await t.step("fair value below cost recognises the impairment and re-marks the position", async () => {
    const r = await api("POST", `/investment/securities/${b.secA}/fair-value`, {
      fair_value_cents: 2_800_000, source: "level_2", amortized_cost_cents: 3_000_000,
    }, { key: officer });
    assertEq(r.status, 200, `fair value (${body(r)})`);
    const s = await rowById("security", b.secA);
    assertEq(s.fair_value_source, "level_2", "source kept");
    assertEq(s.otti_recognised_cents, 200_000, "impairment recognised");
    assertEq((await rowById("position", `pos_${b.secA}`)).market_value_cents, 2_800_000, "position re-marked");
    const otti = await rowById("event", `ev_${b.secA}_otti`);
    assertEq(otti?.payload?.impairment_cents, 200_000, "OTTI analysis evidence");
    assertEq((await rowById("event", `ev_${b.secA}_posan`))?.code, "position.analytics.updated", "analytics event");
  });

  await t.step("fair value above cost concludes no impairment", async () => {
    const r = await api("POST", `/investment/securities/${b.secNoLimit}/fair-value`, {
      fair_value_cents: 3_100_000, source: "level_1", amortized_cost_cents: 3_000_000,
    }, { key: officer });
    assertEq(r.status, 200, `fair value (${body(r)})`);
    const ok = await rowById("event", `ev_${b.secNoLimit}_ottiok`);
    assertEq(ok?.payload?.conclusion, "no_impairment", "no impairment");
    assertEq((await rowById("security", b.secNoLimit)).otti_recognised_cents, null, "nothing recognised");
  });

  await t.step("a fair value for a security that does not exist is refused, as a downgrade is", async () => {
    // DEFECT: postFairValue updates core.security with no existence check, so an unknown id answers 200 and emits fair-value/OTTI events for a security nobody holds.
    const id = `sec_nope_${b.run}`;
    const r = await api("POST", `/investment/securities/${id}/fair-value`, { fair_value_cents: 1, source: "level_3" }, { key: officer });
    assertEq(r.status, 404, `unknown security (${body(r)})`);
    assertEq((await codesOn("security", id)).length, 0, "no evidence about a security that does not exist");
  });
});

// =========================================================================
// 5. Liquidity, contingency funding, ALM, performance
// =========================================================================

flow("investment: liquidity classified → report computed from the book → CFP activated with its plan (restored) → ALM simulation escalates → performance against benchmark", async (t) => {
  const officer = await actor("pynthia_ops");
  const approver = await actor("cu_admin");
  const settler = await actor("pynthia_ops");
  let b!: Book;
  let before: Any;
  const PAR = 4_000_000;
  const p = `flow_${uid()}`;

  await t.step("set up the book, report liquidity, then buy a position (unclassified = level 3)", async () => {
    b = await buildBook(officer, approver, settler);
    const r0 = await api("POST", "/investment/liquidity/report", { period: `${p}_0` }, { key: officer });
    assertEq(r0.status, 201, `baseline report (${body(r0)})`);
    before = await rowById("liquidity_report", `liqrep_${p}_0`);
    const tr = await api("POST", "/investment/trades", ticket(b, { par_cents: PAR }), { key: officer });
    assertEq(tr.status, 201, `trade (${body(tr)})`);
  });

  await t.step("classification needs a valid class; level_1 is recorded with evidence", async () => {
    const bad = await api("POST", "/investment/liquidity/classify", { security_id: b.secA, liquidity_class: "level_9" }, { key: officer });
    assertEq(bad.status, 400, `bad class (${body(bad)})`);
    const r = await api("POST", "/investment/liquidity/classify", { security_id: b.secA, liquidity_class: "level_1" }, { key: officer });
    assertEq(r.status, 200, `classify (${body(r)})`);
    assertEq((await rowById("security", b.secA)).liquidity_class, "level_1", "class on the security");
    assertEq((await rowById("event", `ev_${b.secA}_liq`))?.code, "position.liquidity.classified", "classification event");
  });

  await t.step("the report is computed from the book — supplied figures are ignored — and our position moved into level 1", async () => {
    const r = await api("POST", "/investment/liquidity/report", { period: `${p}_1`, level_1_cents: 999 }, { key: officer });
    assertEq(r.status, 201, `report (${body(r)})`);
    const after = await rowById("liquidity_report", `liqrep_${p}_1`);
    assertEq(Number(after.level_1_cents) - Number(before.level_1_cents), PAR, "level 1 grew by our position");
    assertEq(Number(after.level_3_cents), Number(before.level_3_cents), "level 3 unchanged (the new position went straight to level 1)");
    assertEq(after.min_marketable_bp, null, "no minimum set");
    assertEq(after.breached, null, "no minimum → no verdict, not a pass");
    const ev = await rowById("event", `ev_liqrep_${p}_1_pub`);
    assertEq(ev?.code, "liquidity.report.published", "published");
  });

  await t.step("against a minimum the book cannot meet, the report says breached", async () => {
    const r = await api("POST", "/investment/liquidity/report", { period: `${p}_2`, min_marketable_bp: 10001 }, { key: officer });
    assertEq(r.status, 201, `report (${body(r)})`);
    assertEq(r.body.data.breached, true, "breached");
    const row = await rowById("liquidity_report", `liqrep_${p}_2`);
    assertEq(row.breached, true, "row breached");
    assertEq(row.min_marketable_bp, 10001, "minimum recorded");
  });

  await t.step("CFP: a contingency level without its execution plan is refused; with it, activated and tested — then restored", async () => {
    const prior = await core().from("cfp_state").select("level, execution_plan_ref")
      .order("changed_at", { ascending: false }).limit(1);
    assert(!prior.error, `cfp read: ${prior.error?.message}`);
    const restore = (prior.data ?? [])[0] ?? { level: "normal", execution_plan_ref: null };
    try {
      const none = await api("POST", "/investment/cfp", { level: "stress", changed_by: b.trader }, { key: officer });
      assertEq(none.status, 400, `no plan (${body(none)})`);
      assertEq(none.body.errors?.[0]?.field, "execution_plan_ref", "field named");
      const r = await api("POST", "/investment/cfp", {
        level: "heightened", changed_by: b.trader, execution_plan_ref: `cfp-plan-${b.run}`,
        trigger_detail: { flow: b.run }, investment_test_completed: true,
      }, { key: officer });
      assertEq(r.status, 201, `activate (${body(r)})`);
      const row = await rowById("cfp_state", r.body.data.id);
      assertEq(row.execution_plan_ref, `cfp-plan-${b.run}`, "plan recorded");
      assert(row.investment_test_completed_at, "investment test recorded");
      const codes = await codesOn("cfp_state", r.body.data.id);
      for (const c of ["cfp.level.changed", "liquidity.cfp.activated", "cfp.execution_plan.documented",
        "liquidity.stress.declared", "cfp.investment_test.completed", "finding.opened", "finding.remediation.reported"]) {
        assert(codes.includes(c), `${c} (got ${codes})`);
      }
      const finding = (await eventsOn("cfp_state", r.body.data.id)).find((e) => e.code === "finding.opened");
      assertEq(finding?.payload?.severity, "none", "a clean test still leaves a finding row saying so");
    } finally {
      const back = await api("POST", "/investment/cfp", {
        level: restore.level, changed_by: "flow-restore", execution_plan_ref: restore.execution_plan_ref ?? undefined,
      }, { key: officer });
      assertEq(back.status, 201, `restore CFP level ${restore.level} (${body(back)})`);
      const now = await core().from("cfp_state").select("level").order("changed_at", { ascending: false }).limit(1);
      assertEq(now.data?.[0]?.level, restore.level, "institution's CFP level restored");
    }
  });

  await t.step("ALM simulation: a breach of the minimum escalates; a pass does not; no minimum is no verdict", async () => {
    const bad = await api("POST", "/investment/simulations", { kind: "bogus", scenario: "x", result_bp: 1 }, { key: officer });
    assertEq(bad.status, 400, `bad kind (${body(bad)})`);
    const br = await api("POST", "/investment/simulations", { kind: "irr", period: p, scenario: "+300bp", result_bp: 400, minimum_bp: 600 }, { key: officer });
    assertEq(br.status, 201, `sim (${body(br)})`);
    assertEq(br.body.data.breached, true, "breached");
    const brId = `alm_irr_${p}_+300bp`;
    assert((await rowById("alm_simulation", brId)).escalated_at, "escalation time recorded");
    const codes = await codesOn("alm_simulation", brId);
    for (const c of ["alm.irr_simulation.completed", "stress_test.minimum.breached", "stress_test.remediation.escalated"]) {
      assert(codes.includes(c), `${c} (got ${codes})`);
    }
    const ok = await api("POST", "/investment/simulations", { kind: "portfolio_stress", period: p, scenario: "shock", result_bp: 800, minimum_bp: 600 }, { key: officer });
    assertEq(ok.body.data.breached, false, "within");
    const okCodes = await codesOn("alm_simulation", `alm_portfolio_stress_${p}_shock`);
    assert(okCodes.includes("portfolio.stress_test.completed") && !okCodes.includes("stress_test.minimum.breached"), `no breach (got ${okCodes})`);
    const nomin = await api("POST", "/investment/simulations", { kind: "stress", period: p, scenario: "base", result_bp: 800 }, { key: officer });
    assertEq(nomin.body.data.breached, null, "no minimum → no verdict");
  });

  await t.step("performance: a return without a benchmark is refused; with one, the excess is recorded", async () => {
    const none = await api("POST", "/investment/performance", { period: p, portfolio_return_bp: 420 }, { key: officer });
    assertEq(none.status, 400, `no benchmark (${body(none)})`);
    assertEq(await rowById("performance_measurement", `perf_${p}`), null, "no row");
    const r = await api("POST", "/investment/performance", {
      period: p, portfolio_return_bp: 420, benchmark_ref: "ICE BofA 1-5y UST", benchmark_return_bp: 380,
    }, { key: approver });
    assertEq(r.status, 201, `performance (${body(r)})`);
    assertEq(r.body.data.excess_bp, 40, "excess over benchmark");
    const row = await rowById("performance_measurement", `perf_${p}`);
    assertEq(row.benchmark_ref, "ICE BofA 1-5y UST", "benchmark kept");
    const codes = await codesOn("performance_measurement", `perf_${p}`);
    assert(codes.includes("performance.attribution.completed") && codes.includes("performance.target_risk.reviewed"), `events (got ${codes})`);
  });
});

// =========================================================================
// 6. Repos
// =========================================================================

flow("investment: repos — approved counterparty books, a margin shortfall issues a call, adequate margin does not, unapproved or absent counterparty refused", async (t) => {
  const officer = await actor("pynthia_ops");
  const approver = await actor("cu_admin");
  const settler = await actor("pynthia_ops");
  let b!: Book;
  const principal = 10_000_000 + Math.floor(Math.random() * 10_000) * 100;

  await t.step("set up the book", async () => {
    b = await buildBook(officer, approver, settler);
  });

  await t.step("a reverse repo short of margin books AND issues a margin call", async () => {
    const r = await api("POST", "/investment/repos", {
      intermediary_id: b.broker, direction: "reverse_repo", principal_cents: principal,
      collateral_value_cents: principal + principal / 100, required_margin_bp: 200,
    }, { key: officer });
    assertEq(r.status, 201, `repo (${body(r)})`);
    assertEq(r.body.data.actual_margin_bp, 100, "1% actual margin");
    assertEq(r.body.data.shortfall, true, "shortfall");
    const row = await rowById("repo_agreement", r.body.data.id);
    assertEq(row.decision, "booked", "booked");
    assert(row.margin_call_issued_at, "call issued time");
    assert(row.revaluation_due_at, "daily revaluation scheduled");
    const call = await rowById("event", `ev_${r.body.data.id}_call`);
    assertEq(call?.code, "repo.margin_call.issued", "the call, not just a measurement");
    assertEq(call?.payload?.shortfall_bp, 100, "shortfall size");
    assertEq(call?.payload?.additional_collateral_cents, Math.ceil(principal / 100), "collateral demanded");
    const codes = await codesOn("repo_agreement", r.body.data.id);
    for (const c of ["repo.booked", "repo.collateral_marked", "repo.collateral_revaluation_due_at", "repo.margin_shortfall.detected"]) {
      assert(codes.includes(c), `${c} (got ${codes})`);
    }
  });

  await t.step("adequate margin books with no call", async () => {
    const r = await api("POST", "/investment/repos", {
      intermediary_id: b.broker, direction: "repo", principal_cents: principal,
      collateral_value_cents: principal + principal / 20, required_margin_bp: 200,
    }, { key: officer });
    assertEq(r.status, 201, `repo (${body(r)})`);
    assertEq(r.body.data.shortfall, false, "no shortfall");
    assertEq((await rowById("repo_agreement", r.body.data.id)).margin_call_issued_at, null, "no call");
    assert(!(await codesOn("repo_agreement", r.body.data.id)).includes("repo.margin_call.issued"), "no call event");
  });

  await t.step("an unapproved counterparty is refused, and so is none at all — each recorded as blocked", async () => {
    const bad = await api("POST", "/investment/repos", {
      intermediary_id: b.badBroker, direction: "repo", principal_cents: principal,
      collateral_value_cents: principal * 2, required_margin_bp: 200,
    }, { key: officer });
    assertEq(bad.status, 409, `unapproved (${body(bad)})`);
    assertEq(bad.body.type, "repo_blocked", "typed refusal");
    const rows = await rowsWhere("repo_agreement", "intermediary_id", b.badBroker);
    assertEq(rows.length, 1, "blocked repo recorded");
    assertEq(rows[0].decision, "blocked", "decision");
    assertEq(rows[0].blocked_reason, "intermediary_not_approved", "reason");
    assertEq((await rowById("event", `ev_${rows[0].id}_blk`))?.code, "repo.blocked_rule_violation", "violation event");

    const none = await api("POST", "/investment/repos", {
      direction: "repo", principal_cents: principal + 1, collateral_value_cents: principal * 2, required_margin_bp: 200,
    }, { key: officer });
    assertEq(none.status, 409, `no counterparty (${body(none)})`);
    assertEq(none.body.detail, "no_intermediary", "reason");
    const missing = await api("POST", "/investment/repos", { intermediary_id: b.broker, direction: "repo" }, { key: officer });
    assertEq(missing.status, 400, `malformed (${body(missing)})`);
  });
});
